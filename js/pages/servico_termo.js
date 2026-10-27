// =============================================================================
// TERMO DE RECEBIMENTO DEFINITIVO DE SERVIÇO (manutenção)
// Gerado a partir de uma Ordem de Serviço emitida, quando as notas fiscais
// chegam. A tela calcula só para mostrar; quem valida, calcula e grava é o
// banco (emit_service_receipt_term). Usado pela aba Ordens de Serviço e por
// Manutenções.
// =============================================================================
import { supabase } from '../supabase.js';
import {
  esc, toast, fmtDate, fmtMoney, openModal, closeModal, formatPlate,
  fmtCPF, maskCPF, isValidCPF, onlyDigits, fmtCNPJ, maskCNPJ, isValidCNPJ, supplierOptionLabel,
} from '../ui.js';
import { icons } from '../icons.js';
import { localToday, billingError, withTimeout, toCenti, fmtCents, fmtAmount, normOrdinance } from '../billing.js';
import { printServiceReceiptTerm } from '../service_docs.js';

const ico = (name, size = 16) => `<span style="width:${size}px;height:${size}px;display:inline-flex">${icons[name]}</span>`;
const KM_MACHINE = 99999999;
export const SERVICE_TERM_STATUS = {
  emitido:   { label: 'Emitido',   badge: 'badge badge-success' },
  cancelado: { label: 'Cancelado', badge: 'badge badge-danger' },
};
const KIND_LABEL = { servico: 'Serviço', pecas: 'Peças' };

function orderSummaryHTML(o) {
  return `
    <div class="of-summary trm-summary">
      <div><span>Ordem de serviço</span><strong class="of-mono">${esc(o.os_number)}</strong></div>
      <div><span>Veículo</span><strong>${esc(formatPlate(o.vehicle_plate_snapshot))} · ${esc(o.vehicle_model_snapshot || '')}</strong></div>
      <div><span>Mecânica</span><strong>${esc(o.supplier_trade_name_snapshot)}</strong></div>
      <div><span>Contrato</span><strong>${esc(o.contract_number_snapshot || '—')}</strong></div>
      <div><span>Estimado</span><strong>${fmtMoney(o.estimated_value)} <span class="of-sub">(serv. ${fmtAmount(o.value_services)} · peças ${fmtAmount(o.value_parts)})</span></strong></div>
      <div><span>Km na entrada</span><strong>${o.km_in == null || Number(o.km_in) === KM_MACHINE ? '—' : Number(o.km_in).toLocaleString('pt-BR')}</strong></div>
    </div>`;
}

/** Dados que o modal precisa além da OS: fiscal do contrato, fornecedores e tipo do veículo. */
async function loadContext(order) {
  const [s, fd, all, v] = await withTimeout(Promise.all([
    supabase.from('supplier').select('id, legal_name, trade_name, cnpj, fiscal_name, fiscal_registration, fiscal_ordinance, fiscal_ordinance_date')
      .eq('id', order.supplier_id).maybeSingle(),
    supabase.from('supplier_fiscal_doc').select('cpf').eq('supplier_id', order.supplier_id).maybeSingle(),
    supabase.from('supplier').select('id, kind, legal_name, trade_name, cnpj, contract_number, department:department_id(acronym)').order('legal_name'),
    supabase.from('vehicle').select('id, vehicle_type_code, current_km').eq('id', order.vehicle_id).maybeSingle(),
  ]));
  if (s.error) throw s.error;
  if (all.error) throw all.error;
  return {
    mechanic: s.data || {},
    fiscalCpf: fd.error ? '' : (fd.data?.cpf || ''),
    suppliers: all.data || [],
    machine: Number(v.data?.vehicle_type_code) === 99,
  };
}

// =============================================================================
// GERAR TERMO
// =============================================================================
/** order: linha de service_authorization (OS numerada, emitida). onDone(): recarrega a lista. */
export async function openServiceTermModal(order, onDone) {
  const m = openModal({
    title: 'Gerar Termo de Recebimento de Serviço',
    size: 'lg',
    body: `
      ${orderSummaryHTML(order)}
      <div id="st-body">
        <div class="skeleton skeleton-line w-40"></div>
        <div class="skeleton skeleton-line w-80" style="margin-top:12px"></div>
        <div class="skeleton skeleton-line w-60" style="margin-top:8px"></div>
      </div>`,
    footer: `<button class="btn btn-outline" data-cancel>Cancelar</button>
             <button class="btn btn-primary" id="st-emit" disabled>Emitir termo</button>`,
  });
  m.querySelector('[data-cancel]').addEventListener('click', closeModal);
  const body = m.querySelector('#st-body');

  let ctx;
  try { ctx = await loadContext(order); }
  catch (e) {
    if (!body.isConnected) return;
    body.innerHTML = `<div class="nof-notice is-block"><span class="nof-notice-icon">${icons.alert}</span>
      <div class="nof-notice-body"><strong>Não foi possível carregar a ordem</strong><span>${esc(billingError(e))}</span></div></div>`;
    return;
  }
  if (!body.isConnected) return;

  const today = localToday();
  const mec = ctx.mechanic;
  const kmIn = order.km_in == null ? '' : Number(order.km_in);
  const estimatedCents = toCenti(order.estimated_value) || 0;

  // Notas: começa com a da mecânica (serviço)
  const invoices = [{ kind: 'servico', supplier_id: order.supplier_id, supplier_name: '', supplier_cnpj: '', invoice_number: '', invoice_series: '', invoice_date: '', amount: '' }];

  const supplierOptions = (sel) => '<option value="">— Outro (digitar) —</option>' +
    ctx.suppliers.map(s => `<option value="${s.id}" ${s.id === sel ? 'selected' : ''}>${esc(supplierOptionLabel(s))}</option>`).join('');

  const invoiceRowHTML = (inv, i) => `
    <div class="inv-row" data-inv="${i}">
      <div class="field inv-kind">
        <label class="field-label">Tipo</label>
        <select class="select" data-k="kind">
          <option value="servico" ${inv.kind === 'servico' ? 'selected' : ''}>Serviço</option>
          <option value="pecas" ${inv.kind === 'pecas' ? 'selected' : ''}>Peças</option>
        </select>
      </div>
      <div class="field inv-supplier">
        <label class="field-label">Fornecedor</label>
        <select class="select" data-k="supplier_id">${supplierOptions(inv.supplier_id)}</select>
      </div>
      <div class="field inv-other inv-name" ${inv.supplier_id ? 'hidden' : ''}>
        <label class="field-label">Nome do fornecedor</label>
        <input class="input" data-k="supplier_name" maxlength="120" value="${esc(inv.supplier_name)}" placeholder="Razão social">
      </div>
      <div class="field inv-other inv-cnpj" ${inv.supplier_id ? 'hidden' : ''}>
        <label class="field-label">CNPJ</label>
        <input class="input" data-k="supplier_cnpj" inputmode="numeric" maxlength="18" value="${esc(inv.supplier_cnpj)}" placeholder="00.000.000/0000-00">
      </div>
      <div class="field inv-number">
        <label class="field-label">Nota nº</label>
        <input class="input" data-k="invoice_number" maxlength="30" value="${esc(inv.invoice_number)}" placeholder="ex: 512">
      </div>
      <div class="field inv-series">
        <label class="field-label">Série</label>
        <input class="input" data-k="invoice_series" maxlength="10" value="${esc(inv.invoice_series)}" placeholder="opcional">
      </div>
      <div class="field inv-date">
        <label class="field-label">Data</label>
        <input class="input" type="date" data-k="invoice_date" min="${esc(order.date)}" max="${today}" value="${esc(inv.invoice_date)}">
      </div>
      <div class="field inv-amount">
        <label class="field-label">Valor (R$)</label>
        <input class="input" type="number" inputmode="decimal" step="0.01" min="0.01" data-k="amount" value="${esc(inv.amount)}" placeholder="0,00">
      </div>
      <div class="inv-remove">
        <button type="button" class="btn btn-ghost btn-icon btn-sm" data-inv-remove="${i}" title="Remover nota" ${invoices.length === 1 ? 'disabled' : ''} style="color:var(--danger)">${icons.trash}</button>
      </div>
    </div>`;

  body.innerHTML = `
    <form id="st-form" autocomplete="off" novalidate>
      <div class="trm-section">Serviço e entrega</div>
      <div class="trm-fields">
        <div class="field trm-col-3">
          <label class="field-label" for="st-done">Serviço executado <span class="req">*</span></label>
          <textarea class="textarea" id="st-done" rows="2" maxlength="1000">${esc(order.description || '')}</textarea>
          <span class="field-help">Vem da ordem de serviço; complemente se for o caso.</span>
        </div>
        <div class="field">
          <label class="field-label" for="st-delivery">Data de entrega do veículo <span class="req">*</span></label>
          <input class="input" type="date" id="st-delivery" value="${today}" min="${esc(order.date)}" max="${today}">
          <span class="field-error" id="st-delivery-err" hidden></span>
        </div>
        <div class="field">
          <label class="field-label" for="st-km">Km na entrega <span class="req">*</span></label>
          <input class="input" type="number" id="st-km" min="0" max="99999998" value="${ctx.machine ? KM_MACHINE : esc(kmIn)}" ${ctx.machine ? 'readonly' : ''}>
          <span class="field-help">${ctx.machine ? 'Máquina (tipo Outros): km padrão do TCE.' : `Não pode ser menor que o km na entrada${kmIn !== '' ? ` (${Number(kmIn).toLocaleString('pt-BR')})` : ''}.`}</span>
          <span class="field-error" id="st-km-err" hidden></span>
        </div>
        <div class="field">
          <label class="field-label" for="st-commitment">Nota de empenho nº <span class="req">*</span></label>
          <input class="input" id="st-commitment" maxlength="30" value="${esc(order.commitment_number || '')}" placeholder="ex: 2026/000123">
        </div>
      </div>

      <div class="trm-section">Notas fiscais recebidas</div>
      <p class="trm-hint">Uma linha por nota: a do serviço é da mecânica; as de peças podem ser de outro fornecedor, do cadastro ou digitado. O total não pode passar do estimado na OS (${fmtMoney(order.estimated_value)}).</p>
      <div id="st-invoices"></div>
      <div class="st-inv-foot">
        <button type="button" class="btn btn-outline btn-sm" id="st-add-inv">${ico('plus', 14)} Adicionar nota</button>
        <div class="st-total">Total recebido: <strong id="st-total">—</strong> <span id="st-total-note" class="of-sub"></span></div>
      </div>
      <div id="st-over"></div>

      <div class="trm-section">Conferência na entrega</div>
      <div class="trm-fields">
        <label class="pref-row trm-col-3" style="padding:10px 12px;border-radius:var(--r-md);background:var(--surface-alt);border:1px solid var(--border);cursor:pointer">
          <input type="checkbox" id="st-tested">
          <div class="pref-text"><div class="pref-title" style="font-size:13px">Veículo testado e serviço em funcionamento <span class="req">*</span></div></div>
        </label>
        <label class="pref-row trm-col-3" style="padding:10px 12px;border-radius:var(--r-md);background:var(--surface-alt);border:1px solid var(--border);cursor:pointer">
          <input type="checkbox" id="st-parts">
          <div class="pref-text"><div class="pref-title" style="font-size:13px">Peças substituídas entregues para conferência <span class="req">*</span></div></div>
        </label>
        <div class="field">
          <label class="field-label" for="st-warranty">Garantia <span class="nof-opt">(opcional)</span></label>
          <input class="input" id="st-warranty" maxlength="60" placeholder="ex: 90 dias">
        </div>
        <div class="field trm-col-2">
          <label class="field-label" for="st-notes">Observação <span class="nof-opt">(opcional)</span></label>
          <input class="input" id="st-notes" maxlength="300">
        </div>
      </div>

      <div class="trm-section">Fiscal do contrato</div>
      <div class="trm-fields">
        <div class="field trm-col-2">
          <label class="field-label" for="st-fiscal">Nome <span class="req">*</span></label>
          <input class="input" id="st-fiscal" maxlength="150" value="${esc(mec.fiscal_name || '')}">
        </div>
        <div class="field">
          <label class="field-label" for="st-fiscal-reg">Matrícula</label>
          <input class="input" id="st-fiscal-reg" maxlength="30" value="${esc(mec.fiscal_registration || '')}">
        </div>
        <div class="field">
          <label class="field-label" for="st-fiscal-cpf">CPF <span class="req">*</span></label>
          <input class="input" id="st-fiscal-cpf" inputmode="numeric" maxlength="14" autocomplete="off" value="${esc(fmtCPF(ctx.fiscalCpf || ''))}" placeholder="000.000.000-00">
          <span class="field-error" id="st-fiscal-cpf-err" hidden></span>
        </div>
        <div class="field">
          <label class="field-label" for="st-fiscal-ord">Portaria nº <span class="req">*</span></label>
          <input class="input" id="st-fiscal-ord" maxlength="60" value="${esc(normOrdinance(mec.fiscal_ordinance))}" placeholder="ex: 045/2026">
        </div>
        <div class="field">
          <label class="field-label" for="st-fiscal-orddate">Data da portaria <span class="req">*</span></label>
          <input class="input" type="date" id="st-fiscal-orddate" max="${today}" value="${esc(mec.fiscal_ordinance_date || '')}">
          <span class="field-error" id="st-fiscal-orddate-err" hidden></span>
        </div>
        <div class="field trm-col-3">
          <span class="field-help">No termo sai a matrícula; sem matrícula, o CPF com parte dos números oculta. ${mec.fiscal_name && ctx.fiscalCpf ? '' : 'Para vir preenchido nos próximos termos, cadastre o fiscal no contrato da mecânica (Fornecedores ou Faturamento › Configuração).'}</span>
        </div>
      </div>

      <div class="trm-section">Termo</div>
      <div class="trm-fields">
        <div class="field">
          <label class="field-label" for="st-issue">Data do termo <span class="req">*</span></label>
          <input class="input" type="date" id="st-issue" value="${today}" min="${esc(order.date)}" max="${today}">
          <span class="field-error" id="st-issue-err" hidden></span>
        </div>
      </div>

      <div class="trm-missing" id="st-missing"></div>
      <div id="st-error" class="login-error" style="display:none;margin-top:12px"></div>
    </form>`;

  const $ = (id) => m.querySelector('#' + id);
  const emitBtn = $('st-emit');
  const val = (id) => $(id).value.trim();
  const invBox = $('st-invoices');

  const setFieldError = (id, msg) => {
    const e = $(id + '-err');
    if (!e) return;
    e.textContent = msg || ''; e.hidden = !msg;
    $(id).classList.toggle('is-invalid', !!msg);
  };

  function renderInvoices() {
    invBox.innerHTML = invoices.map(invoiceRowHTML).join('');
  }
  function readInvoices() {
    invBox.querySelectorAll('.inv-row').forEach(row => {
      const i = Number(row.dataset.inv);
      row.querySelectorAll('[data-k]').forEach(el => { invoices[i][el.dataset.k] = el.value; });
    });
  }

  function refresh() {
    readInvoices();
    const missing = [];
    const errs = [];
    if (!val('st-done')) missing.push('serviço executado');

    const delivery = val('st-delivery'), issue = val('st-issue');
    let dErr = '', iErr = '', kErr = '';
    if (!delivery) missing.push('data de entrega');
    else if (delivery < order.date) dErr = `Não pode ser anterior à ordem de serviço (${fmtDate(order.date)}).`;
    else if (delivery > today) dErr = 'Não pode ser futura.';
    if (!issue) missing.push('data do termo');
    else if (issue > today) iErr = 'Não pode ser futura.';
    else if (issue < order.date) iErr = `Não pode ser anterior à ordem de serviço (${fmtDate(order.date)}).`;
    else if (delivery && !dErr && issue < delivery) iErr = 'Não pode ser anterior à data de entrega.';
    const kmRaw = val('st-km');
    if (!ctx.machine) {
      if (kmRaw === '') missing.push('km na entrega');
      else if (kmIn !== '' && Number(kmRaw) < Number(kmIn)) kErr = `Menor que o km na entrada (${Number(kmIn).toLocaleString('pt-BR')}).`;
    }
    setFieldError('st-delivery', dErr); setFieldError('st-issue', iErr); setFieldError('st-km', kErr);
    if (dErr || iErr || kErr) errs.push('datas ou km');

    if (!val('st-commitment')) missing.push('empenho');

    // Notas
    let total = 0, hasService = false, invOk = true;
    invoices.forEach((inv, i) => {
      const n = i + 1;
      const row = invBox.querySelector(`.inv-row[data-inv="${i}"]`);
      const other = !inv.supplier_id;
      row.querySelectorAll('.inv-other').forEach(el => { el.hidden = !other; });
      if (inv.kind === 'servico') hasService = true;
      if (other) {
        if (!inv.supplier_name.trim()) { missing.push(`fornecedor da nota ${n}`); invOk = false; }
        const d = onlyDigits(inv.supplier_cnpj);
        if (!d) { missing.push(`CNPJ da nota ${n}`); invOk = false; }
        else if (d.length !== 14 || !isValidCNPJ(d)) { errs.push(`CNPJ da nota ${n} inválido`); invOk = false; }
      }
      if (!inv.invoice_number.trim()) { missing.push(`nº da nota ${n}`); invOk = false; }
      if (!inv.invoice_date) { missing.push(`data da nota ${n}`); invOk = false; }
      else if (inv.invoice_date < order.date) { errs.push(`nota ${n} anterior à OS`); invOk = false; }
      else if (inv.invoice_date > today) { errs.push(`nota ${n} com data futura`); invOk = false; }
      else if (issue && !iErr && inv.invoice_date > issue) { errs.push(`nota ${n} posterior à data do termo`); invOk = false; }
      const c = toCenti(inv.amount);
      if (!c || c <= 0) { missing.push(`valor da nota ${n}`); invOk = false; }
      else total += c;
    });
    if (!hasService) errs.push('falta a nota do serviço (da mecânica)');
    const over = invOk && total > estimatedCents;
    $('st-total').textContent = total > 0 ? fmtMoney(total / 100) : '—';
    $('st-total-note').textContent = total > 0 ? `de ${fmtMoney(order.estimated_value)} estimados` : '';
    $('st-total').style.color = over ? 'var(--danger)' : (total > 0 ? 'var(--success)' : '');
    $('st-over').innerHTML = over ? `
      <div class="nof-warn">
        <span class="nof-warn-icon">${icons.alert}</span>
        <div>O total das notas (<strong>${fmtMoney(total / 100)}</strong>) passa do estimado na OS (<strong>${fmtMoney(order.estimated_value)}</strong>).
        Emita uma OS complementar para a diferença antes de gerar o termo.</div>
      </div>` : '';

    if (!$('st-tested').checked) missing.push('vistoria: veículo testado');
    if (!$('st-parts').checked) missing.push('vistoria: peças entregues');

    // Fiscal
    if (!val('st-fiscal')) missing.push('nome do fiscal');
    const cpf = onlyDigits(val('st-fiscal-cpf')), ordDate = val('st-fiscal-orddate');
    let cpfErr = '', ordErr = '';
    if (!cpf) missing.push('CPF do fiscal');
    else if (cpf.length !== 11) missing.push('CPF do fiscal');
    else if (!isValidCPF(cpf)) cpfErr = 'CPF inválido. Confira os números.';
    if (!normOrdinance(val('st-fiscal-ord'))) missing.push('nº da portaria');
    if (!ordDate) missing.push('data da portaria');
    else if (ordDate > today) ordErr = 'Não pode ser futura.';
    setFieldError('st-fiscal-cpf', cpfErr); setFieldError('st-fiscal-orddate', ordErr);
    if (cpfErr || ordErr) errs.push('dados do fiscal');

    const blocked = missing.length || errs.length || over;
    emitBtn.disabled = !!blocked;
    const box = $('st-missing');
    if (missing.length) box.textContent = 'Falta informar: ' + missing.join(', ') + '.';
    else if (errs.length) box.textContent = 'Corrija: ' + errs.join('; ') + '.';
    else if (over) box.textContent = 'O total das notas passa do estimado na OS.';
    else box.textContent = '';
    return { total };
  }

  const form = $('st-form');
  form.addEventListener('input', (e) => {
    const el = e.target;
    if (el.id === 'st-fiscal-cpf') el.value = maskCPF(el.value);
    if (el.dataset?.k === 'supplier_cnpj') el.value = maskCNPJ(el.value);
    refresh();
  });
  form.addEventListener('change', (e) => {
    const el = e.target;
    if (el.dataset?.k === 'supplier_id') {
      readInvoices();
      const i = Number(el.closest('.inv-row').dataset.inv);
      if (el.value) { invoices[i].supplier_name = ''; invoices[i].supplier_cnpj = ''; }
    }
    refresh();
  });
  form.addEventListener('click', (e) => {
    const rm = e.target.closest('[data-inv-remove]');
    if (rm) {
      readInvoices();
      invoices.splice(Number(rm.dataset.invRemove), 1);
      renderInvoices(); refresh();
      return;
    }
    if (e.target.closest('#st-add-inv')) {
      readInvoices();
      invoices.push({ kind: 'pecas', supplier_id: '', supplier_name: '', supplier_cnpj: '', invoice_number: '', invoice_series: '', invoice_date: '', amount: '' });
      renderInvoices(); refresh();
      invBox.querySelector(`.inv-row[data-inv="${invoices.length - 1}"] [data-k="supplier_id"]`)?.focus();
    }
  });
  form.addEventListener('submit', (e) => { e.preventDefault(); if (!emitBtn.disabled) emit(); });
  emitBtn.addEventListener('click', emit);
  renderInvoices();
  refresh();

  async function emit() {
    const { total } = refresh();
    if (emitBtn.disabled) return;
    const errBox = $('st-error');
    errBox.style.display = 'none';
    emitBtn.disabled = true; emitBtn.innerHTML = '<span class="spinner"></span> Emitindo';
    const payload = invoices.map(inv => ({
      kind: inv.kind,
      supplier_id: inv.supplier_id || null,
      supplier_name: inv.supplier_id ? null : inv.supplier_name.trim(),
      supplier_cnpj: inv.supplier_id ? null : onlyDigits(inv.supplier_cnpj),
      invoice_number: inv.invoice_number.trim(),
      invoice_series: inv.invoice_series.trim() || null,
      invoice_date: inv.invoice_date,
      amount: (toCenti(inv.amount) / 100).toFixed(2),
    }));
    let res;
    try {
      res = await withTimeout(supabase.rpc('emit_service_receipt_term', {
        p_auth_id: order.id,
        p_delivery_date: val('st-delivery'),
        p_km_out: ctx.machine ? null : Number(val('st-km')),
        p_service_done: val('st-done'),
        p_tested_ok: $('st-tested').checked,
        p_parts_returned: $('st-parts').checked,
        p_invoices: payload,
        p_fiscal_name: val('st-fiscal'),
        p_fiscal_cpf: onlyDigits(val('st-fiscal-cpf')),
        p_fiscal_ordinance: val('st-fiscal-ord'),
        p_fiscal_ordinance_date: val('st-fiscal-orddate'),
        p_warranty: val('st-warranty') || null,
        p_notes: val('st-notes') || null,
        p_commitment: val('st-commitment'),
        p_issue_date: val('st-issue'),
        p_fiscal_registration: val('st-fiscal-reg') || null,
      }), 30000);
    } catch (e) { res = { error: e }; }
    if (!m.isConnected) { if (!res.error) onDone?.(); return; }
    if (res.error) {
      errBox.textContent = billingError(res.error); errBox.style.display = 'block';
      emitBtn.textContent = 'Emitir termo';
      refresh();
      errBox.scrollIntoView({ block: 'nearest' });
      return;
    }
    const termId = res.data;
    m.querySelector('.modal-title').textContent = 'Termo de Recebimento de Serviço emitido';
    m.querySelector('.modal-body').innerHTML = `
      <div class="nof-notice is-ok">
        <span class="nof-notice-icon">${icons.check}</span>
        <div class="nof-notice-body">
          <strong>Termo nº ${esc(order.os_number)} emitido</strong>
          <span>Total recebido ${fmtCents(total)}. A ordem de serviço passou a Concluída e a manutenção foi registrada com esse valor.</span>
        </div>
      </div>
      <p class="of-modal-text" style="margin-top:var(--s-4)">
        Abra o PDF para imprimir e colher as assinaturas do fiscal e do gestor. O termo fica disponível na lista de Ordens de Serviço e em Manutenções.
      </p>`;
    m.querySelector('.modal-footer').innerHTML = `
      <button class="btn btn-outline" data-cancel>Fechar</button>
      <button class="btn btn-primary" id="st-open-pdf">${ico('printer')} Abrir PDF do termo</button>`;
    m.querySelector('[data-cancel]').addEventListener('click', closeModal);
    const pdfBtn = m.querySelector('#st-open-pdf');
    pdfBtn.addEventListener('click', async () => {
      pdfBtn.disabled = true;
      try { await printServiceReceiptTerm(termId); } finally { pdfBtn.disabled = false; }
    });
    toast(`Termo de serviço ${order.os_number} emitido.`, 'success');
    onDone?.();
  }
}

// =============================================================================
// CANCELAR TERMO
// =============================================================================
export function openCancelServiceTermModal(order, term, onDone) {
  const m = openModal({
    title: 'Cancelar Termo de Recebimento de Serviço',
    body: `
      <div class="of-summary">
        <div><span>Termo</span><strong class="of-mono">${esc(term.number)}</strong></div>
        <div><span>Veículo</span><strong>${esc(formatPlate(order.vehicle_plate_snapshot))}</strong></div>
        <div><span>Mecânica</span><strong>${esc(order.supplier_trade_name_snapshot)}</strong></div>
        <div><span>Total recebido</span><strong>${fmtMoney(term.total_amount)}</strong></div>
      </div>
      <p class="of-modal-text">
        A ordem de serviço <strong>${esc(order.os_number)}</strong> volta a Emitida e a manutenção registrada por este termo sai da lista.
        O km do veículo não volta. Depois, um novo termo pode ser gerado, por exemplo quando a nota fiscal é substituída.
      </p>
      <div class="field">
        <label class="field-label" for="st-cancel-reason">Justificativa <span class="req">*</span></label>
        <textarea class="textarea" id="st-cancel-reason" rows="3" maxlength="300" placeholder="ex: nota fiscal substituída pela mecânica"></textarea>
      </div>
      <div id="st-cancel-error" class="login-error" style="display:none;margin-top:12px"></div>`,
    footer: `<button class="btn btn-outline" data-cancel>Voltar</button>
             <button class="btn btn-danger" id="st-cancel-ok">Cancelar o termo</button>`,
  });
  m.querySelector('[data-cancel]').addEventListener('click', closeModal);
  m.querySelector('#st-cancel-ok').addEventListener('click', async () => {
    const btn = m.querySelector('#st-cancel-ok'), errBox = m.querySelector('#st-cancel-error');
    const reason = m.querySelector('#st-cancel-reason').value.trim();
    errBox.style.display = 'none';
    if (reason.length < 5) {
      errBox.textContent = 'Informe a justificativa do cancelamento.'; errBox.style.display = 'block';
      m.querySelector('#st-cancel-reason').focus();
      return;
    }
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Cancelando';
    let error = null;
    try {
      ({ error } = await withTimeout(supabase.rpc('cancel_service_receipt_term', { p_term: term.id, p_reason: reason })));
    } catch (e) { error = e; }
    if (error) {
      errBox.textContent = billingError(error); errBox.style.display = 'block';
      btn.disabled = false; btn.textContent = 'Cancelar o termo';
      return;
    }
    closeModal();
    toast(`Termo ${term.number} cancelado. A ordem de serviço voltou a Emitida.`, 'success');
    onDone?.();
  });
}

// =============================================================================
// TERMOS DA OS (inclui os cancelados, para consulta e PDF)
// =============================================================================
export function openServiceTermHistoryModal(order, terms) {
  const list = [...terms].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const m = openModal({
    title: `Termos da ordem de serviço ${order.os_number}`,
    body: `
      <p class="of-modal-text">Todos os termos já gerados para esta ordem. Os cancelados continuam disponíveis para consulta.</p>
      <div class="trm-history">
        ${list.map(t => {
          const st = SERVICE_TERM_STATUS[t.status] || SERVICE_TERM_STATUS.emitido;
          return `
          <div class="trm-history-row">
            <div class="trm-history-main">
              <div class="trm-history-top">
                <span class="${st.badge}">${st.label}</span>
                <strong>Termo ${esc(t.number)}</strong>
                <span class="of-sub">${esc(fmtDate(t.issue_date))}</span>
              </div>
              <div class="of-sub">${fmtMoney(t.total_amount)} · entrega em ${esc(fmtDate(t.delivery_date))}${t.fiscal_name ? ' · fiscal ' + esc(t.fiscal_name) : ''}</div>
              ${t.status === 'cancelado' && t.cancel_reason ? `<div class="of-sub">Motivo: ${esc(t.cancel_reason)}</div>` : ''}
            </div>
            <button class="btn btn-outline btn-sm" data-term-pdf="${t.id}">${ico('printer', 14)} PDF</button>
          </div>`;
        }).join('')}
      </div>`,
    footer: `<button class="btn btn-outline" data-cancel>Fechar</button>`,
  });
  m.querySelector('[data-cancel]').addEventListener('click', closeModal);
  m.querySelectorAll('[data-term-pdf]').forEach(b => b.addEventListener('click', async () => {
    b.disabled = true;
    try { await printServiceReceiptTerm(b.dataset.termPdf); } finally { b.disabled = false; }
  }));
}

/** Termos de serviço por OS: { byOrder: Map(os_id → [termos]), available }.
 *  available = false quando o banco ainda não tem a tabela (Parte 3 não aplicada). */
export async function loadServiceTerms() {
  try {
    const r = await supabase.from('service_receipt_term')
      .select('id, service_authorization_id, number, status, issue_date, delivery_date, km_out, total_amount, commitment_number, fiscal_name, cancel_reason, canceled_at, created_at')
      .order('created_at', { ascending: false });
    if (r.error) return { byOrder: new Map(), available: false };
    const byOrder = new Map();
    (r.data || []).forEach(t => {
      if (!byOrder.has(t.service_authorization_id)) byOrder.set(t.service_authorization_id, []);
      byOrder.get(t.service_authorization_id).push(t);
    });
    return { byOrder, available: true };
  } catch { return { byOrder: new Map(), available: false }; }
}

/** Notas de todos os termos (para busca por nº de nota): Map(term_id → [{invoice_number, invoice_digits, supplier_name, kind}]). */
export async function loadServiceTermInvoices() {
  try {
    const r = await supabase.from('service_receipt_term_invoice')
      .select('term_id, kind, supplier_name, invoice_number, invoice_digits, amount');
    if (r.error) return new Map();
    const map = new Map();
    (r.data || []).forEach(i => {
      if (!map.has(i.term_id)) map.set(i.term_id, []);
      map.get(i.term_id).push(i);
    });
    return map;
  } catch { return new Map(); }
}

export const activeServiceTerm = (terms) => (terms || []).find(t => t.status === 'emitido') || null;
export const canceledServiceTerms = (terms) => (terms || []).filter(t => t.status === 'cancelado');
export const invoiceKindLabel = (k) => KIND_LABEL[k] || k;
