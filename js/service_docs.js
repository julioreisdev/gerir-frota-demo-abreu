// Documentos da manutenção em PDF (A4 retrato): Ordem de Serviço, conforme o
// modelo do cliente (modelos/ordem_servico.html.twig, pedido de 27/10/2026).
// Montado só com as cópias gravadas na emissão: reimprimir dá o mesmo documento.
import { supabase } from './supabase.js';
import { esc, fmtDate, fmtCNPJ, formatPlate, toast } from './ui.js';
import { getEntity, reportLogoUrl } from './shell.js';
import { openPrintTab } from './thermal.js';
import { fmtAmount, billingError } from './billing.js';
import { DOC_CSS } from './billing_docs.js';
import QRCode from 'https://esm.sh/qrcode@1.5.3';

export const SERVICE_KIND_LABEL = { preventiva: 'Preventiva', corretiva: 'Corretiva', sinistro: 'Sinistro', revisao: 'Revisão', outros: 'Outros' };

const dash = (v) => (v == null || v === '' ? '—' : v);
const kmText = (n) => (n == null || Number(n) === 99999999 ? '—' : Number(n).toLocaleString('pt-BR'));

async function municipalityName(entity) {
  if (!entity?.ibge_code) return '';
  const { data } = await supabase.from('ibge_municipality').select('name').eq('code', entity.ibge_code).maybeSingle();
  return data?.name || '';
}

/** HTML completo da Ordem de Serviço. Exportado para os testes.
 *  order: linha de service_authorization com as colunas da OS; parentNumber: nº da OS de origem. */
export function serviceOrderHTML({ entity, city, order, qrDataUrl, parentNumber }) {
  const logo = reportLogoUrl(entity);
  const fallback = new URL('logo.png', location.href).href;
  const kind = SERVICE_KIND_LABEL[order.service_kind] || order.service_kind || '';
  const empenho = (order.commitment_number || '').trim();
  const mec = order.supplier_trade_name_snapshot || '';
  const contratante = `${esc(order.department_name_snapshot || order.department_acronym_snapshot || '—')} · CNPJ ${esc(order.department_cnpj_snapshot ? fmtCNPJ(order.department_cnpj_snapshot) : '—')}`;
  const contratada = `${esc(mec)} · CNPJ ${esc(order.supplier_cnpj_snapshot ? fmtCNPJ(order.supplier_cnpj_snapshot) : '—')}`;
  const services = Number(order.value_services || 0), parts = Number(order.value_parts || 0);
  const total = Number(order.estimated_value || services + parts);
  const canceled = order.status === 'cancelada';
  const concluded = order.status === 'utilizada';

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>Ordem de Serviço ${esc(order.os_number)} - ${esc(order.department_acronym_snapshot || '')}</title>
<style>${DOC_CSS}
body { font-size: 9pt; }
.titulo { margin: 10px 0 8px; }
h2 { margin: 10px 0 4px; }
table.dados td { padding: 3px 6px; }
table.lista td { padding: 3px 6px; }
.texto { margin: 6px 0; line-height: 1.5; }
.assinaturas { margin-top: 34px; }
.qr { float: right; width: 78px; text-align: center; font-size: 6.5pt; color: #5A6676; margin: -4px 0 0 8px; }
.qr img { width: 74px; height: 74px; display: block; margin: 0 auto 2px; }
.faixa { border: 2px solid #1C4A85; color: #1C4A85; text-align: center; font-weight: bold; letter-spacing: .12em; padding: 6px; margin: 0 0 10px; font-size: 11pt; }
</style>
</head>
<body>
<div class="cab">
  <img src="${esc(logo)}" alt="" onerror="if (this.dataset.fb) { this.style.display = 'none'; } else { this.dataset.fb = '1'; this.src = '${esc(fallback)}'; }">
  <div>
    <div class="l1">Estado do Piauí · ${esc(entity?.organ_name || '')}</div>
    <div class="l2">${esc(order.department_name_snapshot || order.department_acronym_snapshot || '')}</div>
  </div>
</div>

<div class="titulo">
  ${qrDataUrl ? `<div class="qr"><img src="${qrDataUrl}" alt="QR Code">${esc(order.number)}</div>` : ''}
  <h1>ORDEM DE SERVIÇO</h1>
  <div class="num">Nº ${esc(order.os_number)}${order.os_external ? ' (nº informado)' : ''} · Manutenção ${esc(kind.toLowerCase())} · emitida em ${esc(fmtDate(order.date))}</div>
  ${parentNumber ? `<div class="num">Complementar à Ordem de Serviço nº ${esc(parentNumber)}</div>` : ''}
</div>
${canceled ? `<div class="cancelada">ORDEM DE SERVIÇO CANCELADA<small>${esc(order.cancel_reason || '')}${order.canceled_at ? ' · ' + esc(fmtDate(String(order.canceled_at).slice(0, 10))) : ''}</small></div>` : ''}
${concluded ? `<div class="faixa">SERVIÇO CONCLUÍDO</div>` : ''}

<h2>1. Dados do contrato</h2>
<table class="dados">
  <tr><td><span class="k">Contratante</span>${contratante}</td>
      <td><span class="k">Contratada (mecânica)</span>${contratada}</td></tr>
  <tr><td><span class="k">Contrato nº</span>${esc(dash(order.contract_number_snapshot))}</td>
      <td><span class="k">Nota de empenho nº</span>${esc(empenho || 'a informar')}</td></tr>
</table>

<h2>2. Veículo e serviço</h2>
<table class="dados">
  <tr><td><span class="k">Veículo</span>${esc(formatPlate(order.vehicle_plate_snapshot))} · ${esc(order.vehicle_model_snapshot || '')}</td>
      <td><span class="k">Secretaria</span>${esc(order.department_acronym_snapshot || '—')}</td></tr>
  <tr><td><span class="k">Km na entrada na oficina</span>${esc(kmText(order.km_in))}</td>
      <td><span class="k">Motorista / solicitante</span>${esc(dash(order.driver_name_snapshot))}</td></tr>
  <tr><td colspan="2"><span class="k">Serviço autorizado</span>${esc(order.description || '')}</td></tr>
  ${order.budget_ref ? `<tr><td colspan="2"><span class="k">Orçamento da mecânica</span>${esc(order.budget_ref)}</td></tr>` : ''}
  ${order.notes ? `<tr><td colspan="2"><span class="k">Observações</span>${esc(order.notes)}</td></tr>` : ''}
</table>

<h2>3. Valor estimado</h2>
<table class="lista">
  <thead><tr><th>Descrição</th><th class="n">Valor estimado (R$)</th></tr></thead>
  <tbody>
    <tr><td>Serviços (mão de obra)</td><td class="n">${fmtAmount(services)}</td></tr>
    <tr><td>Peças e materiais</td><td class="n">${fmtAmount(parts)}</td></tr>
    <tr class="tot"><td>Total estimado</td><td class="n">${fmtAmount(total)}</td></tr>
  </tbody>
</table>

<p class="texto">
  Fica autorizada a empresa <b>${esc(mec)}</b> a executar no veículo <b>${esc(formatPlate(order.vehicle_plate_snapshot))}</b> o serviço descrito acima,
  até o valor estimado de <b>R$ ${fmtAmount(total)}</b>. Serviço ou peça além do descrito depende de nova ordem de serviço
  antes da execução. As peças substituídas devem ser entregues junto com o veículo, para conferência. A nota fiscal deve informar
  o nº desta ordem de serviço e do contrato${empenho ? ` e o empenho nº ${esc(empenho)}` : ''}.
</p>
<p class="local">${esc(city || '')} (PI), ${esc(fmtDate(order.date))}.</p>

<div class="assinaturas">
  <div><b>${esc(order.issuer_name_snapshot || order.responsible_name || '')}</b>${order.issuer_role_snapshot ? esc(order.issuer_role_snapshot) + '<br>' : ''}Responsável pela autorização</div>
</div>

</body>
</html>`;
}

/** Busca a OS e abre o PDF em nova aba. Devolve true se abriu. */
export async function printServiceOrder(id) {
  const [o, entity] = await Promise.all([
    supabase.from('service_authorization').select('*').eq('id', id).maybeSingle(),
    getEntity(),
  ]);
  if (o.error) { toast(billingError(o.error), 'error'); return false; }
  if (!o.data || !o.data.os_number) { toast('Ordem de serviço não encontrada.', 'error'); return false; }
  let parentNumber = '';
  if (o.data.parent_id) {
    const p = await supabase.from('service_authorization').select('os_number, number').eq('id', o.data.parent_id).maybeSingle();
    parentNumber = p.data?.os_number || p.data?.number || '';
  }
  const city = await municipalityName(entity);
  let qrDataUrl = '';
  try { qrDataUrl = await QRCode.toDataURL(o.data.qr_payload, { width: 220, margin: 1, errorCorrectionLevel: 'M' }); } catch {}
  const html = serviceOrderHTML({ entity, city, order: o.data, qrDataUrl, parentNumber });
  const win = openPrintTab(html, { title: `Ordem de Serviço ${o.data.os_number}` });
  if (!win) toast('O navegador bloqueou a nova aba. Permita pop-ups para este site e tente de novo.', 'warning', 7000);
  return !!win;
}
