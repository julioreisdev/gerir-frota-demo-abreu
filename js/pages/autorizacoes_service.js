// =============================================================================
// AUTORIZAÇÕES › ORDENS DE SERVIÇO (manutenção)
// A autorização de manutenção é a Ordem de Serviço: nº NNN/AAAA geral do
// município, valores de serviços e peças, km de entrada, empenho, orçamento e
// OS complementar. O código AAAAMMDD-MAN-NNN continua em `number` e no QR.
// Autorização anterior à OS (sem os_number) segue o fluxo antigo.
// Banco em versão anterior (sem as colunas da OS): a tela volta ao modo antigo.
// =============================================================================
import { getEntity } from '../shell.js';
import { supabase } from '../supabase.js';
import { esc, fmtDate, fmtMoney, toast, openModal, closeModal, confirmDialog, formValues, formatPlate, supplierOptionLabel, supplierCellHTML, isMissingColumn } from '../ui.js';
import { icons } from '../icons.js';
import { getProfile, isAdmin } from '../auth.js';
import QRCode from 'https://esm.sh/qrcode@1.5.3';
import { openPrintTab, openThermalPDF, hasChosenThermalWidth, askThermalWidth } from '../thermal.js';
import { localToday, billingError, withTimeout, fmtAmount, nfMatches } from '../billing.js';
import { loadDriversForPick, driverFieldHTML, mountDriverField } from '../drivers.js';
import { printServiceOrder, printServiceReceiptTerm, SERVICE_KIND_LABEL } from '../service_docs.js';
import { openServiceTermModal, openCancelServiceTermModal, openServiceTermHistoryModal, loadServiceTerms, loadServiceTermInvoices, activeServiceTerm, canceledServiceTerms } from './servico_termo.js';

// Na manutenção, "utilizada" é mostrada como Concluída (o enum é o mesmo do abastecimento)
const STATUS_LABEL = { emitida: 'Emitida', utilizada: 'Concluída', cancelada: 'Cancelada' };
const STATUS_BADGE = { emitida: 'badge badge-warning', utilizada: 'badge badge-success', cancelada: 'badge badge-danger' };
const KIND_LABEL = SERVICE_KIND_LABEL;
const KIND_BADGE = { preventiva: 'badge badge-success', corretiva: 'badge badge-warning', sinistro: 'badge badge-danger', revisao: 'badge', outros: 'badge badge-neutral' };
const KM_MACHINE = 99999999;

let _items = [];
let _vehicles = [];
let _suppliers = [];
let _filter = { search: '', status: '', month: '', kind: '', driver: '' };
// Motoristas para escolha. _hasDrivers = false: banco ainda sem o cadastro, a tela segue sem o campo.
let _drivers = [];
let _hasDrivers = false;
// false quando o banco ainda não tem as colunas da Ordem de Serviço (Parte 1 não aplicada)
let _hasOS = true;
// 'auto' (só automática) ou 'opcional' (aceita nº informado), da entidade
let _numbering = 'auto';
// Termos de serviço por OS (Parte 3). _hasTerms = false: banco sem a tabela, a OS é concluída pelo registro antigo.
let _terms = new Map();
let _invoices = new Map();
let _hasTerms = false;

const isFornecedor = () => getProfile()?.role === 'fornecedor';
const canWrite = () => ['admin', 'usuario'].includes(getProfile()?.role);
const isOS = (a) => !!a?.os_number;
const ico = (name, size = 16) => `<span style="width:${size}px;height:${size}px;display:inline-flex">${icons[name]}</span>`;

export async function renderServiceTab(container) {
  container.innerHTML = `
    <div class="page-header" style="margin-bottom:var(--s-4)">
      <div>
        <p class="page-subtitle" style="margin-top:0">${isFornecedor()
          ? 'Consulte as ordens de serviço emitidas para você.'
          : 'Autorize serviços em mecânicas: ordem de serviço com QR Code e impressão.'}</p>
      </div>
      <div class="page-actions">
        <button class="btn btn-outline btn-sm" id="btn-thermal-cfg-srv" title="Tamanho da bobina térmica (58mm / 80mm)">⚙️ Bobina</button>
        ${isFornecedor() ? '' : `
        <button class="btn btn-primary" id="btn-new-srv">
          ${ico('plus')}
          Emitir ordem de serviço
        </button>`}
      </div>
    </div>
    <div class="card">
      <div class="table-toolbar">
        <div class="search ${_filter.search ? 'has-value' : ''}" id="srv-search-box">
          ${icons.search}
          <input id="srv-search" type="search"
                 placeholder="Buscar por nº da OS, placa, mecânica, responsável, serviço, empenho…"
                 autocomplete="off" value="${esc(_filter.search)}">
          <button class="clear" id="srv-search-clear" aria-label="Limpar busca">${icons.close}</button>
        </div>
        <div class="count" id="srv-count"></div>
      </div>
      <div class="filter-chips">
        <select class="select chip" id="ffs-status">
          <option value="">Todas situações</option>
          <option value="emitida">Emitida</option>
          <option value="pendente">Empenho pendente</option>
          <option value="utilizada">Concluída</option>
          <option value="cancelada">Cancelada</option>
        </select>
        <select class="select chip" id="ffs-kind">
          <option value="">Todas categorias</option>
          ${Object.entries(KIND_LABEL).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}
        </select>
        <input class="input chip" type="month" id="ffs-month" value="${esc(_filter.month)}">
        <select class="select chip" id="ffs-driver" aria-label="Motorista" hidden></select>
        <button class="btn btn-ghost btn-sm" id="ffs-clear" hidden>Limpar filtros</button>
      </div>
      <div id="srv-tablebox">
        <div class="skeleton skeleton-line w-40"></div>
        <div class="skeleton skeleton-line w-80" style="margin-top:12px"></div>
        <div class="skeleton skeleton-line w-60" style="margin-top:8px"></div>
      </div>
    </div>
  `;
  const btnCfgSrv = document.getElementById('btn-thermal-cfg-srv');
  if (btnCfgSrv) btnCfgSrv.addEventListener('click', () => askThermalWidth());
  const btnNewSrv = document.getElementById('btn-new-srv');
  if (btnNewSrv) btnNewSrv.addEventListener('click', () => openSrvModal());
  const sBox = document.getElementById('srv-search-box');
  const sIn = document.getElementById('srv-search');
  document.getElementById('srv-search-clear').addEventListener('click', () => {
    _filter.search = ''; sIn.value = ''; sBox.classList.remove('has-value'); renderTable();
  });
  sIn.addEventListener('input', (e) => {
    _filter.search = e.target.value || '';
    sBox.classList.toggle('has-value', !!_filter.search);
    renderTable();
  });
  document.getElementById('ffs-status').addEventListener('change', (e) => { _filter.status = e.target.value; updateClear(); renderTable(); });
  document.getElementById('ffs-kind').addEventListener('change',   (e) => { _filter.kind   = e.target.value; updateClear(); renderTable(); });
  document.getElementById('ffs-month').addEventListener('change',  (e) => { _filter.month  = e.target.value; updateClear(); renderTable(); });
  document.getElementById('ffs-driver').addEventListener('change', (e) => { _filter.driver = e.target.value; updateClear(); renderTable(); });
  document.getElementById('ffs-clear').addEventListener('click', () => {
    _filter = { search: _filter.search, status: '', month: '', kind: '', driver: '' };
    document.getElementById('ffs-status').value = '';
    document.getElementById('ffs-kind').value = '';
    document.getElementById('ffs-month').value = '';
    updateClear(); renderTable();
  });
  await loadAll();
  if (_filter.status) document.getElementById('ffs-status').value = _filter.status;
  if (_filter.kind)   document.getElementById('ffs-kind').value   = _filter.kind;
  updateClear();
  renderTable();
}

function updateClear() {
  const any = _filter.status || _filter.month || _filter.kind || _filter.driver;
  document.getElementById('ffs-clear').hidden = !any;
}

/** Filtro de motorista: só aparece quando alguma ordem tem motorista. */
function fillDriverFilter() {
  const sel = document.getElementById('ffs-driver');
  if (!sel) return;
  const names = [...new Set(_items.map(a => a.driver_name_snapshot).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  if (_filter.driver && _filter.driver !== 'none' && !names.includes(_filter.driver)) _filter.driver = '';
  sel.hidden = !names.length;
  sel.innerHTML = '<option value="">Todos motoristas</option><option value="none">Sem motorista</option>' +
    names.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
  sel.value = _filter.driver;
}

// =============================================================================
// CARGA
// =============================================================================
const DRIVER_COLS = ', driver_id, driver_name_snapshot';
const OS_COLS = `, os_year, os_seq, os_number, os_external, parent_id, commitment_number, km_in, budget_ref,
      value_services, value_parts, department_name_snapshot, contract_number_snapshot, supplier_cnpj_snapshot,
      issuer_name_snapshot, issuer_role_snapshot, cancel_reason, canceled_at`;

async function loadAll() {
  const srvQuery = (extra) => supabase.from('service_authorization').select(`
      id, number, date, status, vehicle_id, supplier_id, service_kind,
      description, estimated_value, responsible_name, notes,
      vehicle_plate_snapshot, vehicle_model_snapshot,
      department_acronym_snapshot, supplier_trade_name_snapshot,
      qr_payload, created_at${extra}
    `).is('deleted_at', null).order('date', { ascending: false }).order('number', { ascending: false });
  let [a, v, s, drv, e, t, inv] = await Promise.all([
    srvQuery(DRIVER_COLS + OS_COLS),
    supabase.from('vehicle').select(`
      id, plate, model, brand, current_km, vehicle_type_code,
      department_id, department:department_id(acronym, name)
    `).is('deleted_at', null).order('plate'),
    supabase.from('supplier').select(`
      id, kind, legal_name, trade_name, cnpj, responsible_name, phone,
      department_id, contract_number,
      department:department_id(acronym, name)
    `).in('kind', ['mecanica', 'ambos']).order('legal_name'),
    isFornecedor() ? Promise.resolve({ drivers: [], available: false }) : loadDriversForPick(),
    supabase.from('entity').select('service_order_numbering').maybeSingle(),
    isFornecedor() ? Promise.resolve({ byOrder: new Map(), available: false }) : loadServiceTerms(),
    isFornecedor() ? Promise.resolve(new Map()) : loadServiceTermInvoices(),
  ]);
  _terms = t.byOrder; _invoices = inv;
  // Banco em versão anterior: sem as colunas da OS; depois, sem as do motorista
  _hasOS = true;
  let hasDriverCols = true;
  if (a.error && isMissingColumn(a.error)) { _hasOS = false; a = await srvQuery(DRIVER_COLS); }
  if (a.error && isMissingColumn(a.error)) { hasDriverCols = false; a = await srvQuery(''); }
  _drivers = drv.drivers;
  _hasDrivers = drv.available && hasDriverCols;
  _numbering = (!e.error && e.data?.service_order_numbering) || 'auto';
  _hasTerms = t.available && _hasOS;
  if (a.error) { toast('Falha ao carregar ordens de serviço: ' + a.error.message, 'error'); _items = []; }
  else _items = a.data || [];
  _vehicles = v.data || [];
  _suppliers = s.data || [];
}

// =============================================================================
// LISTA
// =============================================================================
function applyFilters() {
  const t = (_filter.search || '').toLowerCase();
  const tNum = t.replace(/[^0-9a-z]/g, '');
  return _items.filter(a => {
    if (_filter.status === 'pendente') {
      if (!(a.status === 'emitida' && isOS(a) && !a.commitment_number)) return false;
    } else if (_filter.status && a.status !== _filter.status) return false;
    if (_filter.kind && a.service_kind !== _filter.kind) return false;
    if (_filter.month && String(a.date).slice(0, 7) !== _filter.month) return false;
    if (_filter.driver === 'none' && a.driver_name_snapshot) return false;
    if (_filter.driver && _filter.driver !== 'none' && a.driver_name_snapshot !== _filter.driver) return false;
    if (!t) return true;
    // nº da nota fiscal do termo: só dígitos, sem zeros à esquerda
    if ((_terms.get(a.id) || []).some(x => (_invoices.get(x.id) || []).some(i => nfMatches(i.invoice_number, _filter.search)))) return true;
    // nº da OS com ou sem a barra (001/2026 ou 0012026); código MAN com ou sem hífens
    const osNo = String(a.os_number || '').toLowerCase();
    if (osNo && (osNo.includes(t) || (tNum && osNo.replace(/[^0-9a-z]/g, '').includes(tNum)))) return true;
    const code = String(a.number || '').toLowerCase();
    if (code.includes(t) || (tNum.length >= 4 && code.replace(/[^0-9a-z]/g, '').includes(tNum))) return true;
    return [a.vehicle_plate_snapshot, a.supplier_trade_name_snapshot, a.responsible_name,
            a.driver_name_snapshot, a.description, a.commitment_number, a.contract_number_snapshot]
      .some(v => String(v || '').toLowerCase().includes(t));
  });
}

function renderTable() {
  const box = document.getElementById('srv-tablebox');
  const countEl = document.getElementById('srv-count');
  fillDriverFilter();
  if (!_items.length) {
    if (countEl) countEl.textContent = '';
    box.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">${icons.wrench}</div>
        <div class="empty-state-title">Nenhuma ordem de serviço</div>
        <p class="empty-state-text">${isFornecedor() ? 'Quando a prefeitura emitir uma ordem para você, ela aparece aqui.' : 'Clique em "Emitir ordem de serviço" para criar a primeira.'}</p>
      </div>`;
    return;
  }
  const filtered = applyFilters();
  if (countEl) {
    const any = _filter.search || _filter.status || _filter.month || _filter.kind || _filter.driver;
    countEl.textContent = any
      ? `${filtered.length} de ${_items.length} ordem(ns)`
      : `${_items.length} ordem(ns)`;
  }
  if (!filtered.length) {
    box.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">${icons.search}</div>
        <div class="empty-state-title">Nenhum resultado</div>
        <p class="empty-state-text">Nada encontrado com os filtros atuais.</p>
      </div>`;
    return;
  }
  box.innerHTML = `
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>Ordem</th>
            <th>Veículo</th>
            <th>Categoria</th>
            <th>Serviço</th>
            <th>Valor est.</th>
            <th>Mecânica</th>
            ${_hasOS && !isFornecedor() ? '<th>Empenho</th>' : ''}
            <th>Responsável</th>
            <th>Situação</th>
            ${showTerms() ? '<th>Termo</th>' : ''}
            <th class="actions-col">Ações</th>
          </tr>
        </thead>
        <tbody>${filtered.map(srvRow).join('')}</tbody>
      </table>
    </div>
  `;
  box.querySelectorAll('[data-act="conclude"]').forEach(b => b.addEventListener('click', () => concludeService(b.dataset.id)));
  box.querySelectorAll('[data-act="edit"]').forEach(b => b.addEventListener('click', () => openSrvModal(b.dataset.id)));
  box.querySelectorAll('[data-act="qr"]').forEach(b => b.addEventListener('click', () => openQRModal(b.dataset.id)));
  box.querySelectorAll('[data-act="print-a4"]').forEach(b => b.addEventListener('click', () => printSrvA4(b.dataset.id)));
  box.querySelectorAll('[data-act="print-thermal"]').forEach(b => b.addEventListener('click', () => printSrvThermal(b.dataset.id)));
  box.querySelectorAll('[data-act="cancel"]').forEach(b => b.addEventListener('click', () => cancelSrv(b.dataset.id)));
  box.querySelectorAll('[data-act="delete"]').forEach(b => b.addEventListener('click', () => deleteSrv(b.dataset.id)));
  box.querySelectorAll('[data-act="empenho"]').forEach(b => b.addEventListener('click', () => openCommitmentModal(b.dataset.id)));
  box.querySelectorAll('[data-act="term"]').forEach(b => b.addEventListener('click', () => {
    const a = _items.find(x => x.id === b.dataset.id); if (a) openServiceTermModal(a, reload);
  }));
  box.querySelectorAll('[data-act="term-pdf"]').forEach(b => b.addEventListener('click', async () => {
    const term = activeServiceTerm(_terms.get(b.dataset.id)); if (!term) return;
    b.disabled = true; try { await printServiceReceiptTerm(term.id); } finally { b.disabled = false; }
  }));
  box.querySelectorAll('[data-act="term-cancel"]').forEach(b => b.addEventListener('click', () => {
    const a = _items.find(x => x.id === b.dataset.id); const term = activeServiceTerm(_terms.get(b.dataset.id));
    if (a && term) openCancelServiceTermModal(a, term, reload);
  }));
  box.querySelectorAll('[data-act="term-history"]').forEach(b => b.addEventListener('click', () => {
    const a = _items.find(x => x.id === b.dataset.id); if (a) openServiceTermHistoryModal(a, _terms.get(a.id) || []);
  }));
}

const showTerms = () => _hasTerms && !isFornecedor();
async function reload() { await loadAll(); renderTable(); }

function parentNumberOf(a) {
  if (!a.parent_id) return '';
  const p = _items.find(x => x.id === a.parent_id);
  return p ? (p.os_number || p.number) : '';
}

function srvRow(a) {
  const emitida = a.status === 'emitida';
  const os = isOS(a);
  const parentNo = parentNumberOf(a);
  const ordem = os ? `
    <div class="cell-stack">
      <strong class="of-mono">${esc(a.os_number)}</strong>
      <span class="of-sub of-nowrap">${esc(fmtDate(a.date))} · <span style="font-family:ui-monospace,monospace">${esc(a.number)}</span></span>
      ${a.os_external ? '<span class="of-sub" title="Ordem emitida em outro sistema; o número foi informado">nº informado</span>' : ''}
      ${parentNo ? `<span class="of-sub">Complementar à OS nº ${esc(parentNo)}</span>` : ''}
    </div>` : `
    <div class="cell-stack">
      <strong style="font-family:ui-monospace,monospace;color:var(--primary);font-size:12px">${esc(a.number)}</strong>
      <span style="color:var(--text-muted);font-size:12px">${esc(fmtDate(a.date))}</span>
    </div>`;
  const valor = os ? `
    <div class="cell-stack">
      <strong style="color:var(--success);white-space:nowrap">${fmtMoney(a.estimated_value)}</strong>
      <span class="of-sub of-nowrap">Serv. ${fmtAmount(a.value_services)} · Peças ${fmtAmount(a.value_parts)}</span>
    </div>` : `<span style="white-space:nowrap;color:var(--success);font-weight:500">${fmtMoney(a.estimated_value)}</span>`;
  const empenho = !os ? '<span class="of-sub">—</span>' : `
    <div class="of-empenho">
      ${a.commitment_number
        ? `<span class="of-mono">${esc(a.commitment_number)}</span>`
        : (emitida ? '<span class="badge badge-warning">Pendente</span>' : '<span>—</span>')}
      ${emitida && canWrite() ? `<button class="btn btn-ghost btn-icon btn-sm" data-act="empenho" data-id="${a.id}"
          title="${a.commitment_number ? 'Alterar empenho' : 'Informar empenho'}">${icons.edit}</button>` : ''}
    </div>`;
  const terms = _terms.get(a.id) || [];
  const term = activeServiceTerm(terms), oldTerms = canceledServiceTerms(terms);
  // OS numerada com o termo no banco: conclui pelo termo; autorização antiga (ou banco antigo): registro de manutenção
  const viaTerm = os && _hasTerms;
  const termCell = !showTerms() ? '' : `<td data-label="Termo">${
    term ? `<div class="cell-stack">
        <span class="of-nowrap"><strong class="of-mono">${esc(term.number)}</strong> · ${esc(fmtDate(term.issue_date))}</span>
        <span class="of-sub of-amount">${fmtMoney(term.total_amount)}</span>
      </div>`
    : (emitida && os && canWrite()) ? `<button class="btn btn-outline btn-sm of-act" data-act="term" data-id="${a.id}"
        title="Gerar o Termo de Recebimento de Serviço desta ordem">${icons.fileCheck}<span>Gerar termo</span></button>`
    : '<span class="of-sub">—</span>'}</td>`;
  return `
    <tr ${a.status === 'cancelada' ? 'class="is-canceled"' : ''}>
      <td data-label="Ordem">${ordem}</td>
      <td data-label="Veículo">
        <div class="cell-stack">
          <strong>${esc(formatPlate(a.vehicle_plate_snapshot))}</strong>
          <span style="color:var(--text-muted);font-size:12px">${esc(a.vehicle_model_snapshot || '')}</span>
        </div>
      </td>
      <td data-label="Categoria"><span class="${KIND_BADGE[a.service_kind] || 'badge'}">${esc(KIND_LABEL[a.service_kind] || a.service_kind)}</span></td>
      <td data-label="Serviço" style="font-size:12.5px;max-width:300px"><div class="cell-stack"><span style="white-space:normal">${esc(a.description)}</span></div></td>
      <td data-label="Valor est.">${valor}</td>
      <td data-label="Mecânica">${supplierCellHTML(a.supplier_trade_name_snapshot, _suppliers.find(s => s.id === a.supplier_id))}</td>
      ${_hasOS && !isFornecedor() ? `<td data-label="Empenho">${empenho}</td>` : ''}
      <td data-label="Responsável" style="font-size:12.5px">${a.driver_name_snapshot
        ? `<div class="cell-stack"><span>${esc(a.responsible_name)}</span><span class="of-sub">Motorista: ${esc(a.driver_name_snapshot)}</span></div>`
        : esc(a.responsible_name)}</td>
      <td data-label="Situação">
        <div class="cell-stack">
          <span class="${STATUS_BADGE[a.status]}">${esc(STATUS_LABEL[a.status])}</span>
          ${a.status === 'cancelada' && a.cancel_reason ? `<span class="of-sub of-reason">${esc(a.cancel_reason)}</span>` : ''}
        </div>
      </td>
      ${termCell}
      <td class="actions-col">
        <div class="actions-row">
          ${viaTerm ? `
          ${term && showTerms() ? `<button class="btn btn-ghost btn-icon btn-sm" data-act="term-pdf" data-id="${a.id}" title="Abrir o Termo de Recebimento em PDF">${icons.fileCheck}</button>` : ''}
          ${oldTerms.length && showTerms() ? `<button class="btn btn-ghost btn-icon btn-sm" data-act="term-history" data-id="${a.id}" title="${oldTerms.length} termo(s) cancelado(s) desta ordem">${icons.history}</button>` : ''}`
          : `<button class="btn btn-ghost btn-icon btn-sm" data-act="conclude" data-id="${a.id}" title="Concluir (registrar manutenção)" ${emitida && !isFornecedor() ? '' : 'disabled'} style="color:var(--success)">${icons.check}</button>`}
          <button class="btn btn-ghost btn-icon btn-sm" data-act="qr"            data-id="${a.id}" title="Ver QR Code">${icons.qrcode}</button>
          <button class="btn btn-ghost btn-icon btn-sm" data-act="print-a4"      data-id="${a.id}" title="Imprimir A4">${icons.printer}</button>
          <button class="btn btn-ghost btn-icon btn-sm" data-act="print-thermal" data-id="${a.id}" title="Imprimir térmica (PDF 58/80mm)">${icons.receipt}</button>
          ${isFornecedor() ? '' : `
          <button class="btn btn-ghost btn-icon btn-sm" data-act="edit"          data-id="${a.id}" title="Editar" ${emitida ? '' : 'disabled'}>${icons.edit}</button>
          <button class="btn btn-ghost btn-icon btn-sm" data-act="cancel"        data-id="${a.id}" title="Cancelar" ${emitida ? '' : 'disabled'} style="color:var(--warning)">${icons.ban}</button>
          ${term && canWrite() ? `<button class="btn btn-ghost btn-icon btn-sm" data-act="term-cancel" data-id="${a.id}" title="Cancelar o termo de recebimento" style="color:var(--danger)">${icons.ban}</button>` : ''}
          ${isAdmin() ? `<button class="btn btn-ghost btn-icon btn-sm" data-act="delete"        data-id="${a.id}" title="Excluir" style="color:var(--danger)">${icons.trash}</button>` : ''}`}
        </div>
      </td>
    </tr>`;
}

// =============================================================================
// MODAL: EMISSÃO / EDIÇÃO
// =============================================================================
function openSrvModal(id) {
  const a = id ? _items.find(x => x.id === id) : null;
  if (a && a.status !== 'emitida') {
    toast('Apenas ordens emitidas podem ser editadas.', 'warning'); return;
  }
  // Banco antigo ou autorização anterior à OS: formulário de sempre
  if (!_hasOS || (a && !isOS(a))) { openLegacyModal(id); return; }
  openOrderModal(a);
}

/** Mecânicas com contrato na secretaria do veículo (ou sem secretaria, cadastros antigos). */
function supplierPool(vehSel) {
  const veh = _vehicles.find(x => x.id === vehSel.value);
  const vehDept = veh?.department_id || null;
  return vehDept ? _suppliers.filter(s => !s.department_id || s.department_id === vehDept) : _suppliers;
}
function rebuildSupplierOptions(vehSel, supSel, preserveId = '') {
  const veh = _vehicles.find(x => x.id === vehSel.value);
  const pool = supplierPool(vehSel);
  const currentSel = preserveId || supSel.value;
  const keep = pool.find(s => s.id === currentSel) ? currentSel : '';
  const placeholder = veh?.department_id
    ? '<option value="">— Selecione —</option>'
    : '<option value="">— Selecione o veículo primeiro —</option>';
  supSel.innerHTML = placeholder + pool
    .map(s => `<option value="${s.id}" ${s.id === keep ? 'selected' : ''}>${esc(supplierOptionLabel(s))}</option>`)
    .join('');
  if (!pool.length && veh?.department_id) {
    supSel.innerHTML = '<option value="">Nenhuma mecânica cadastrada nesta secretaria</option>';
  }
}

/** Último nº informado no exercício (para a dica do campo). */
function lastInformed(year) {
  return _items
    .filter(x => x.os_external && Number(x.os_year) === year && x.status !== 'cancelada')
    .sort((x, y) => String(y.created_at).localeCompare(String(x.created_at)))[0] || null;
}

function openOrderModal(a) {
  const editing = !!a;
  const me = getProfile();
  const today = localToday();
  const defaultResp = me?.full_name || '';
  const informed = _numbering === 'opcional';

  const vehOptions = '<option value="">— Selecione —</option>' +
    _vehicles.map(v => `<option value="${v.id}" ${a?.vehicle_id === v.id ? 'selected' : ''}>${esc(formatPlate(v.plate))} — ${esc(v.model)} (${esc(v.department?.acronym || '—')})</option>`).join('');
  const kindOptions = Object.entries(KIND_LABEL).map(([k, l]) =>
    `<option value="${k}" ${(a?.service_kind || 'corretiva') === k ? 'selected' : ''}>${esc(l)}</option>`).join('');

  const body = `
    <form id="srv-form" autocomplete="off">
      ${editing ? `
        <div class="alert" style="background:var(--primary-tint);border-left:3px solid var(--primary);padding:var(--s-3) var(--s-4);border-radius:var(--r-md);margin-bottom:var(--s-4);font-size:13px">
          <strong>Ordem de Serviço nº ${esc(a.os_number)}</strong> · ${esc(a.number)}${a.commitment_number ? ` · empenho ${esc(a.commitment_number)}` : ''}
          ${parentNumberOf(a) ? `<br><span style="color:var(--text-muted);font-size:12px">Complementar à OS nº ${esc(parentNumberOf(a))}</span>` : ''}
        </div>` : ''}
      <div class="form-grid">
        <div class="field">
          <label class="field-label">Data <span class="req">*</span></label>
          <input class="input" name="date" type="date" required value="${a?.date || today}" ${editing ? 'readonly' : `max="${today}"`}>
        </div>
        <div class="field">
          <label class="field-label">Responsável <span class="req">*</span></label>
          <input class="input" name="responsible_name" required value="${esc(a?.responsible_name || defaultResp)}" ${editing ? 'readonly' : ''}>
        </div>
        <div class="field col-full">
          <label class="field-label">Veículo <span class="req">*</span></label>
          <select class="select" name="vehicle_id" id="srv-vehicle" required ${editing ? 'disabled' : ''}>${vehOptions}</select>
          <div id="srv-vehicle-info" class="field-help" style="margin-top:4px"></div>
        </div>
        ${_hasDrivers ? driverFieldHTML() : ''}
        <div class="field col-full">
          <label class="field-label">Mecânica (contrato) <span class="req">*</span></label>
          <select class="select" name="supplier_id" id="srv-supplier" required ${editing ? 'disabled' : ''}></select>
          <span class="field-help">Mecânicas com contrato na secretaria do veículo. A OS grava o nº do contrato e o fiscal vem do cadastro da mecânica.</span>
        </div>
        <div class="field">
          <label class="field-label">Categoria <span class="req">*</span></label>
          <select class="select" name="service_kind" required>${kindOptions}</select>
        </div>
        <div class="field">
          <label class="field-label">Km na entrada na oficina <span class="req">*</span></label>
          <input class="input" name="km_in" id="srv-km" type="number" min="0" max="99999998" value="${a?.km_in ?? ''}">
          <span class="field-help" id="srv-km-help">Não pode ser menor que o último km registrado do veículo.</span>
        </div>
        <div class="field">
          <label class="field-label">Serviços, mão de obra (R$) <span class="req">*</span></label>
          <input class="input" name="value_services" id="srv-vs" type="number" step="0.01" min="0" value="${a?.value_services ?? ''}" placeholder="0,00">
        </div>
        <div class="field">
          <label class="field-label">Peças e materiais (R$) <span class="req">*</span></label>
          <input class="input" name="value_parts" id="srv-vp" type="number" step="0.01" min="0" value="${a?.value_parts ?? ''}" placeholder="0,00">
          <span class="field-help">Total estimado: <b id="srv-total">—</b>. Sem cadastro de peças: as peças entram como valor estimado e, no termo, pela nota fiscal.</span>
        </div>
        ${editing ? '' : `
        <div class="field">
          <label class="field-label">Empenho <span class="nof-opt">(opcional)</span></label>
          <input class="input" name="commitment" maxlength="30" placeholder="ex: 2026/000123">
          <span class="field-help">Pode ser informado depois, até o termo.</span>
        </div>
        ${informed ? `
        <div class="field">
          <label class="field-label">Nº da OS <span class="nof-opt">(opcional)</span></label>
          <input class="input" name="os_number" id="srv-number" maxlength="30" autocomplete="off" placeholder="em branco = automático">
          <span class="field-help" id="srv-number-hint"></span>
        </div>` : ''}`}
        <div class="field ${editing ? '' : (informed ? 'col-full' : '')}">
          <label class="field-label">Orçamento da mecânica <span class="nof-opt">(opcional)</span></label>
          <input class="input" name="budget_ref" maxlength="60" value="${esc(a?.budget_ref || '')}" placeholder="ex: nº 318, de 27/10/2026">
        </div>
        ${editing ? '' : `
        <div class="field col-full">
          <label class="field-label">OS complementar <span class="nof-opt">(opcional)</span></label>
          <select class="select" name="parent_id" id="srv-parent"><option value="">— Não é complementar —</option></select>
          <span class="field-help">Use quando a mecânica encontrou outro defeito: a nova OS fica ligada à original, que não muda.</span>
        </div>`}
        <div class="field col-full">
          <label class="field-label">Descrição do serviço <span class="req">*</span></label>
          <textarea class="textarea" name="description" rows="3" required minlength="3" maxlength="500"
                    placeholder="Ex.: Troca de óleo, filtros e revisão de freios">${esc(a?.description || '')}</textarea>
        </div>
        <div class="field col-full">
          <label class="field-label">Observações</label>
          <textarea class="textarea" name="notes" rows="2">${esc(a?.notes || '')}</textarea>
        </div>
      </div>
      <div id="srv-errors" class="login-error" style="display:none;margin-top:12px"></div>
    </form>
  `;
  const footer = `
    <button class="btn btn-outline" data-cancel>Cancelar</button>
    <button class="btn btn-primary" id="srv-save-btn">${editing ? 'Salvar alterações' : 'Emitir ordem de serviço'}</button>
  `;
  const m = openModal({ title: editing ? `Editar Ordem de Serviço ${a.os_number}` : 'Nova ordem de serviço', body, footer, size: 'lg' });

  const vehSel = m.querySelector('#srv-vehicle');
  const supSel = m.querySelector('#srv-supplier');
  const kmIn = m.querySelector('#srv-km');
  const kmHelp = m.querySelector('#srv-km-help');
  const vsIn = m.querySelector('#srv-vs');
  const vpIn = m.querySelector('#srv-vp');
  const totalEl = m.querySelector('#srv-total');
  const vehInfo = m.querySelector('#srv-vehicle-info');
  const parentSel = m.querySelector('#srv-parent');
  const numIn = m.querySelector('#srv-number');
  const dateIn = m.querySelector('[name="date"]');

  const vehicle = () => _vehicles.find(x => x.id === vehSel.value);

  function refreshVehicle() {
    const v = vehicle();
    if (!v) { vehInfo.textContent = ''; return; }
    const machine = Number(v.vehicle_type_code) === 99;
    vehInfo.innerHTML = `Secretaria: <b>${esc(v.department?.acronym || '—')}</b> · KM atual: <b>${Number(v.current_km || 0).toLocaleString('pt-BR')}</b>`;
    if (machine) {
      kmIn.value = KM_MACHINE; kmIn.readOnly = true;
      kmHelp.textContent = 'Máquina (tipo Outros): usa o km padrão 99999999 do TCE.';
    } else {
      kmIn.readOnly = false;
      if (!editing && (kmIn.value === '' || Number(kmIn.value) === KM_MACHINE)) kmIn.value = v.current_km || '';
      kmHelp.textContent = Number(v.current_km) > 0
        ? `Não pode ser menor que o último km registrado (${Number(v.current_km).toLocaleString('pt-BR')}).`
        : 'Veículo sem km registrado: o valor informado passa a ser a referência.';
    }
  }
  function refreshTotal() {
    const s = Number(vsIn.value || 0), p = Number(vpIn.value || 0);
    totalEl.textContent = (s > 0 || p > 0) ? fmtMoney(s + p) : '—';
  }
  function refreshParents() {
    if (!parentSel) return;
    const v = vehicle();
    const opts = v ? _items.filter(x => isOS(x) && x.vehicle_id === v.id && x.status !== 'cancelada') : [];
    const cur = parentSel.value;
    parentSel.innerHTML = '<option value="">— Não é complementar —</option>' + opts.map(x =>
      `<option value="${x.id}" ${x.id === cur ? 'selected' : ''}>OS ${esc(x.os_number)} · ${esc(fmtDate(x.date))} · ${esc(STATUS_LABEL[x.status])} · ${esc(x.description.slice(0, 50))}</option>`).join('');
  }
  function refreshNumberHint() {
    if (!numIn) return;
    const hint = m.querySelector('#srv-number-hint');
    const year = Number(String(dateIn.value || today).slice(0, 4));
    const n = numIn.value.trim();
    const dup = n && _items.some(x => isOS(x) && Number(x.os_year) === year && x.status !== 'cancelada'
      && String(x.os_number).trim().toUpperCase() === n.toUpperCase());
    numIn.classList.toggle('is-invalid', dup);
    if (dup) { hint.textContent = `Já existe uma ordem de serviço nº ${n} em ${year}.`; hint.style.color = 'var(--danger)'; return; }
    hint.style.color = '';
    const last = lastInformed(year);
    hint.textContent = last
      ? `Último nº informado em ${year}: ${last.os_number}. Em branco, o sistema numera.`
      : `Nenhum nº informado em ${year}. Em branco, o sistema numera.`;
  }

  const driverField = mountDriverField(m, {
    drivers: _drivers,
    getVehicle: vehicle,
    selectedId: a?.driver_id || '',
  });
  vehSel.addEventListener('change', () => { refreshVehicle(); rebuildSupplierOptions(vehSel, supSel); driverField.refresh(); refreshParents(); });
  vsIn.addEventListener('input', refreshTotal);
  vpIn.addEventListener('input', refreshTotal);
  numIn?.addEventListener('input', refreshNumberHint);
  dateIn.addEventListener('change', refreshNumberHint);

  refreshVehicle();
  rebuildSupplierOptions(vehSel, supSel, a?.supplier_id || '');
  refreshTotal();
  refreshParents();
  refreshNumberHint();

  m.querySelector('[data-cancel]').addEventListener('click', closeModal);
  m.querySelector('#srv-save-btn').addEventListener('click', () => saveOrder(a));
}

async function saveOrder(a) {
  const editing = !!a;
  const form = document.getElementById('srv-form');
  const errBox = document.getElementById('srv-errors');
  const showErr = (msg) => { errBox.innerHTML = '⚠️ ' + esc(msg); errBox.style.display = 'block'; };
  if (errBox) errBox.style.display = 'none';
  if (!form || !form.checkValidity()) { form?.reportValidity(); return; }
  const v = formValues(form);
  const vehicleId = a?.vehicle_id || v.vehicle_id;
  const supplierId = a?.supplier_id || v.supplier_id;
  const veh = _vehicles.find(x => x.id === vehicleId);
  const machine = Number(veh?.vehicle_type_code) === 99;
  const services = Number(v.value_services || 0), parts = Number(v.value_parts || 0);
  const km = machine ? KM_MACHINE : (v.km_in === '' ? null : Number(v.km_in));

  if (!editing && v.date > localToday()) return showErr('A data da ordem de serviço não pode ser posterior a hoje.');
  if (!vehicleId || !supplierId) return showErr('Selecione o veículo e a mecânica.');
  if (services < 0 || parts < 0) return showErr('Os valores não podem ser negativos.');
  if (services + parts <= 0) return showErr('Informe o valor estimado de serviços ou de peças.');
  if (!machine) {
    if (km == null || !Number.isInteger(km) || km < 0) return showErr('Informe o km do veículo na entrada na oficina.');
    const ref = Number(veh?.current_km || 0);
    const unchanged = editing && km === Number(a.km_in);
    if (ref > 0 && km < ref && !unchanged) return showErr(`O km na entrada (${km.toLocaleString('pt-BR')}) é menor que o último km registrado do veículo (${ref.toLocaleString('pt-BR')}).`);
  }
  const number = (v.os_number || '').trim();
  if (number && _numbering !== 'opcional') return showErr('Esta cidade numera as ordens de serviço automaticamente. Deixe o número em branco.');
  if (number.length > 30) return showErr('O número da ordem tem no máximo 30 caracteres.');

  // Aviso de duplicata na mesma data + veículo (não bloqueia). confirmDialog fecha o modal.
  let formGone = false;
  if (!editing) {
    const dup = _items.filter(x => x.vehicle_id === vehicleId && x.date === v.date && (x.status === 'emitida' || x.status === 'utilizada'));
    if (dup.length > 0) {
      const ok = await confirmDialog({
        title: 'Veículo já tem ordem de serviço nesta data',
        message: `${dup.length} ordem(ns) já existe(m) para ${formatPlate(veh?.plate || '')} em ${fmtDate(v.date)} (${dup.map(d => d.os_number || d.number).join(', ')}). Emitir mesmo assim?`,
        confirmText: 'Emitir mesmo assim',
        cancelText: 'Cancelar',
      });
      if (!ok) return;
      formGone = true;
    }
  }
  const btn = formGone ? null : document.getElementById('srv-save-btn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Salvando...'; }

  try {
    if (editing) {
      const r = await withTimeout(supabase.rpc('update_service_order', {
        p_auth_id: a.id,
        p_service_kind: v.service_kind,
        p_description: v.description,
        p_value_services: services,
        p_value_parts: parts,
        p_km_in: km,
        p_budget_ref: v.budget_ref || null,
        p_notes: v.notes || null,
      }));
      if (r.error) throw r.error;
      const before = a.driver_id || '';
      if (_hasDrivers && (v.driver_id || '') !== before) {
        const d = await supabase.rpc('set_service_authorization_driver', { p_auth_id: a.id, p_driver_id: v.driver_id || null });
        if (d.error) throw d.error;
      }
      toast('Ordem de serviço atualizada.', 'success');
      closeModal();
      await loadAll(); renderTable();
    } else {
      const { data, error } = await withTimeout(supabase.rpc('emit_service_order', {
        p_date: v.date,
        p_vehicle_id: vehicleId,
        p_supplier_id: supplierId,
        p_service_kind: v.service_kind,
        p_description: v.description,
        p_value_services: services,
        p_value_parts: parts,
        p_km_in: machine ? null : km,
        p_responsible_name: v.responsible_name,
        p_notes: v.notes || null,
        p_driver_id: (_hasDrivers && v.driver_id) ? v.driver_id : null,
        p_commitment: (v.commitment || '').trim() || null,
        p_budget_ref: (v.budget_ref || '').trim() || null,
        p_parent_id: v.parent_id || null,
        p_number: number || null,
      }), 30000);
      if (error) throw error;
      toast('Ordem de serviço emitida.', 'success');
      await loadAll(); renderTable();
      closeModal();
      setTimeout(() => openQRModal(data), 200);
    }
  } catch (err) {
    const msg = billingError(err);
    if (errBox && document.body.contains(errBox)) showErr(msg);
    else toast(msg, 'error', 7000);
    if (btn && document.body.contains(btn)) {
      btn.disabled = false;
      btn.textContent = editing ? 'Salvar alterações' : 'Emitir ordem de serviço';
    }
  }
}

// =============================================================================
// MODAL ANTIGO (banco sem a OS, ou autorização anterior à OS)
// =============================================================================
function openLegacyModal(id) {
  const editing = !!id;
  const a = editing ? _items.find(x => x.id === id) : null;
  const me = getProfile();
  const today = localToday();
  const defaultResp = me?.full_name || '';

  const vehOptions = '<option value="">— Selecione —</option>' +
    _vehicles.map(v => `<option value="${v.id}" ${a?.vehicle_id === v.id ? 'selected' : ''}>${esc(formatPlate(v.plate))} — ${esc(v.model)} (${esc(v.department?.acronym || '—')})</option>`).join('');
  const kindOptions = Object.entries(KIND_LABEL).map(([k, l]) =>
    `<option value="${k}" ${(a?.service_kind || 'corretiva') === k ? 'selected' : ''}>${esc(l)}</option>`).join('');

  const body = `
    <form id="srv-form" autocomplete="off">
      ${editing ? `<p class="field-help" style="margin-bottom:var(--s-3)">Autorização anterior às ordens de serviço numeradas (${esc(a.number)}).</p>` : ''}
      <div class="form-grid">
        <div class="field">
          <label class="field-label">Data <span class="req">*</span></label>
          <input class="input" name="date" type="date" required value="${a?.date || today}" ${editing ? 'readonly' : `max="${today}"`}>
        </div>
        <div class="field">
          <label class="field-label">Responsável <span class="req">*</span></label>
          <input class="input" name="responsible_name" required value="${esc(a?.responsible_name || defaultResp)}" ${editing ? 'readonly' : ''}>
        </div>
        <div class="field col-full">
          <label class="field-label">Veículo <span class="req">*</span></label>
          <select class="select" name="vehicle_id" id="srv-vehicle" required ${editing ? 'disabled' : ''}>${vehOptions}</select>
        </div>
        ${_hasDrivers ? driverFieldHTML() : ''}
        <div class="field col-full">
          <label class="field-label">Mecânica <span class="req">*</span></label>
          <select class="select" name="supplier_id" id="srv-supplier" required ${editing ? 'disabled' : ''}></select>
          <span class="field-help">Aparecem aqui apenas fornecedores marcados como Mecânica ou Posto + Mecânica, e vinculados à secretaria do veículo.</span>
        </div>
        <div class="field">
          <label class="field-label">Categoria <span class="req">*</span></label>
          <select class="select" name="service_kind" required>${kindOptions}</select>
        </div>
        <div class="field">
          <label class="field-label">Valor estimado (R$) <span class="req">*</span></label>
          <input class="input" name="estimated_value" type="number" step="0.01" min="0.01" required value="${a?.estimated_value ?? ''}" placeholder="0,00">
        </div>
        <div class="field col-full">
          <label class="field-label">Descrição do serviço <span class="req">*</span></label>
          <textarea class="textarea" name="description" rows="3" required minlength="3" maxlength="500"
                    placeholder="Ex.: Troca de óleo, filtros e revisão de freios">${esc(a?.description || '')}</textarea>
        </div>
        <div class="field col-full">
          <label class="field-label">Observações</label>
          <textarea class="textarea" name="notes" rows="2">${esc(a?.notes || '')}</textarea>
        </div>
      </div>
      <div id="srv-errors" class="login-error" style="display:none;margin-top:12px"></div>
    </form>
  `;
  const footer = `
    <button class="btn btn-outline" data-cancel>Cancelar</button>
    <button class="btn btn-primary" id="srv-save-btn">${editing ? 'Salvar alterações' : 'Emitir autorização'}</button>
  `;
  const m = openModal({ title: editing ? `Editar Autorização ${a.number}` : 'Nova autorização de manutenção', body, footer, size: 'lg' });

  const vehSel = m.querySelector('#srv-vehicle');
  const supSel = m.querySelector('#srv-supplier');
  const driverField = mountDriverField(m, {
    drivers: _drivers,
    getVehicle: () => _vehicles.find(x => x.id === vehSel.value),
    selectedId: a?.driver_id || '',
  });
  vehSel.addEventListener('change', () => { rebuildSupplierOptions(vehSel, supSel); driverField.refresh(); });
  rebuildSupplierOptions(vehSel, supSel, a?.supplier_id || '');

  m.querySelector('[data-cancel]').addEventListener('click', closeModal);
  m.querySelector('#srv-save-btn').addEventListener('click', () => saveLegacy(editing ? id : null));
}

async function saveLegacy(id) {
  const form = document.getElementById('srv-form');
  const errBox = document.getElementById('srv-errors');
  if (errBox) errBox.style.display = 'none';
  if (!form || !form.checkValidity()) { form?.reportValidity(); return; }
  const v = formValues(form);
  if (!id && v.date > localToday()) {
    errBox.innerHTML = '⚠️ A data da ordem de serviço não pode ser posterior a hoje.';
    errBox.style.display = 'block'; return;
  }

  let formGone = false;
  if (!id) {
    const dup = _items.filter(a =>
      a.vehicle_id === v.vehicle_id
      && a.date === v.date
      && (a.status === 'emitida' || a.status === 'utilizada'));
    if (dup.length > 0) {
      const veh = _vehicles.find(x => x.id === v.vehicle_id);
      const ok = await confirmDialog({
        title: 'Veículo já tem autorização nesta data',
        message: `${dup.length} autorização(ões) de manutenção já existe(m) para ${formatPlate(veh?.plate || '')} em ${fmtDate(v.date)} (${dup.map(d => d.os_number || d.number).join(', ')}). Emitir mesmo assim?`,
        confirmText: 'Emitir mesmo assim',
        cancelText: 'Cancelar',
      });
      if (!ok) return;
      formGone = true;
    }
  }

  const btn = formGone ? null : document.getElementById('srv-save-btn');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Salvando...';
  }
  try {
    if (id) {
      const { error } = await supabase.rpc('update_service_authorization', {
        p_auth_id: id,
        p_service_kind: v.service_kind,
        p_description: v.description,
        p_estimated_value: Number(v.estimated_value),
        p_notes: v.notes || null,
      });
      if (error) throw error;
      const before = _items.find(x => x.id === id)?.driver_id || '';
      if (_hasDrivers && (v.driver_id || '') !== before) {
        const r = await supabase.rpc('set_service_authorization_driver', { p_auth_id: id, p_driver_id: v.driver_id || null });
        if (r.error) throw r.error;
      }
      toast('Autorização atualizada.', 'success');
      closeModal();
      await loadAll(); renderTable();
    } else {
      const args = {
        p_date: v.date,
        p_vehicle_id: v.vehicle_id,
        p_supplier_id: v.supplier_id,
        p_service_kind: v.service_kind,
        p_description: v.description,
        p_estimated_value: Number(v.estimated_value),
        p_responsible_name: v.responsible_name,
        p_notes: v.notes || null,
      };
      const { data, error } = (_hasDrivers && v.driver_id)
        ? await supabase.rpc('emit_service_authorization_with_driver', { ...args, p_driver_id: v.driver_id })
        : await supabase.rpc('emit_service_authorization', args);
      if (error) throw error;
      toast('Autorização emitida.', 'success');
      await loadAll(); renderTable();
      closeModal();
      setTimeout(() => openQRModal(data), 200);
    }
  } catch (err) {
    const msg = err.message || 'Erro ao salvar.';
    if (errBox && document.body.contains(errBox)) {
      errBox.innerHTML = '⚠️ ' + esc(msg);
      errBox.style.display = 'block';
    } else {
      toast(msg, 'error');
    }
    if (btn && document.body.contains(btn)) {
      btn.disabled = false;
      btn.textContent = id ? 'Salvar alterações' : 'Emitir autorização';
    }
  }
}

// =============================================================================
// EMPENHO (OS emitida)
// =============================================================================
function openCommitmentModal(id) {
  const a = _items.find(x => x.id === id);
  if (!a) return;
  const m = openModal({
    title: a.commitment_number ? 'Alterar empenho' : 'Informar empenho',
    body: `
      <div class="of-summary">
        <div><span>Ordem de serviço</span><strong class="of-mono">${esc(a.os_number)}</strong></div>
        <div><span>Veículo</span><strong>${esc(formatPlate(a.vehicle_plate_snapshot))}</strong></div>
        <div><span>Mecânica</span><strong>${esc(a.supplier_trade_name_snapshot)}</strong></div>
        <div><span>Valor estimado</span><strong>${fmtMoney(a.estimated_value)}</strong></div>
      </div>
      <form id="srv-emp-form" autocomplete="off">
        <div class="field">
          <label class="field-label" for="srv-emp-input">Nota de empenho nº</label>
          <input class="input" id="srv-emp-input" maxlength="30" value="${esc(a.commitment_number || '')}" placeholder="ex: 2026/000123">
          <span class="field-help">Deixe em branco para voltar a "Pendente". O empenho é obrigatório para gerar o Termo de Recebimento de Serviço.</span>
        </div>
        <div id="srv-emp-error" class="login-error" style="display:none;margin-top:12px"></div>
      </form>`,
    footer: `<button class="btn btn-outline" data-cancel>Cancelar</button>
             <button class="btn btn-primary" id="srv-emp-save">Salvar</button>`,
  });
  const input = m.querySelector('#srv-emp-input');
  const save = async () => {
    const btn = m.querySelector('#srv-emp-save'), errBox = m.querySelector('#srv-emp-error');
    errBox.style.display = 'none';
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Salvando';
    let error = null;
    try {
      ({ error } = await withTimeout(supabase.rpc('set_service_order_commitment', { p_auth_id: a.id, p_commitment: input.value.trim() })));
    } catch (e) { error = e; }
    if (error) {
      errBox.textContent = billingError(error); errBox.style.display = 'block';
      btn.disabled = false; btn.textContent = 'Salvar';
      return;
    }
    closeModal();
    toast(input.value.trim() ? 'Empenho informado.' : 'Empenho removido.', 'success');
    await loadAll(); renderTable();
  };
  m.querySelector('[data-cancel]').addEventListener('click', closeModal);
  m.querySelector('#srv-emp-save').addEventListener('click', save);
  m.querySelector('#srv-emp-form').addEventListener('submit', (e) => { e.preventDefault(); save(); });
}

// =============================================================================
// QR CODE
// =============================================================================
async function openQRModal(id) {
  const a = _items.find(x => x.id === id);
  if (!a) return;
  const sup = _suppliers.find(s => s.id === a.supplier_id);
  const os = isOS(a);
  const body = `
    <div style="text-align:center">
      <div id="qr-canvas-wrap" style="display:flex;justify-content:center;margin-bottom:var(--s-4);min-height:280px;align-items:center">
        <div class="spinner" style="color:var(--primary)"></div>
      </div>
      <div style="background:var(--surface-alt);border-radius:var(--r-md);padding:var(--s-4);font-size:13px;line-height:1.7;text-align:left">
        <div style="font-family:ui-monospace,monospace;font-size:16px;font-weight:700;color:var(--primary);text-align:center;margin-bottom:var(--s-3)">${os ? 'OS nº ' + esc(a.os_number) : esc(a.number)}</div>
        ${os ? `<div style="text-align:center;font-family:ui-monospace,monospace;font-size:12px;color:var(--text-muted);margin-top:-8px;margin-bottom:var(--s-3)">${esc(a.number)}</div>` : ''}
        <div><strong>Data:</strong> ${esc(fmtDate(a.date))} · <span class="${STATUS_BADGE[a.status]}">${esc(STATUS_LABEL[a.status])}</span></div>
        <div><strong>Veículo:</strong> ${esc(formatPlate(a.vehicle_plate_snapshot))} — ${esc(a.vehicle_model_snapshot)}</div>
        <div><strong>Categoria:</strong> <span class="${KIND_BADGE[a.service_kind] || 'badge'}">${esc(KIND_LABEL[a.service_kind])}</span></div>
        ${os && a.km_in != null ? `<div><strong>Km na entrada:</strong> ${Number(a.km_in) === KM_MACHINE ? '—' : Number(a.km_in).toLocaleString('pt-BR')}</div>` : ''}
        <div style="margin-top:var(--s-2);padding-top:var(--s-2);border-top:1px dashed var(--border)"><strong>Serviço:</strong><br>${esc(a.description)}</div>
        ${os ? `<div><strong>Serviços:</strong> ${fmtMoney(a.value_services)} · <strong>Peças:</strong> ${fmtMoney(a.value_parts)}</div>` : ''}
        <div><strong>Valor estimado:</strong> ${fmtMoney(a.estimated_value)}</div>
        <div><strong>Mecânica:</strong> ${esc(sup?.trade_name || sup?.legal_name || a.supplier_trade_name_snapshot)}</div>
        ${sup?.cnpj ? `<div><strong>CNPJ:</strong> ${esc(sup.cnpj)}</div>` : ''}
        ${os && a.contract_number_snapshot ? `<div><strong>Contrato:</strong> ${esc(a.contract_number_snapshot)}</div>` : ''}
        ${os ? `<div><strong>Empenho:</strong> ${esc(a.commitment_number || 'a informar')}</div>` : ''}
        <div><strong>Responsável:</strong> ${esc(a.responsible_name)}</div>
        ${a.driver_name_snapshot ? `<div><strong>Motorista:</strong> ${esc(a.driver_name_snapshot)}</div>` : ''}
        ${a.notes ? `<div style="margin-top:var(--s-2);padding-top:var(--s-2);border-top:1px dashed var(--border)"><strong>Obs:</strong> ${esc(a.notes)}</div>` : ''}
      </div>
    </div>
  `;
  const footer = `
    <button class="btn btn-outline" data-cancel>Fechar</button>
    <button class="btn btn-outline" id="qr-print-thermal">
      ${ico('receipt')} Térmica
    </button>
    <button class="btn btn-primary" id="qr-print-a4">
      ${ico('printer')} Imprimir A4
    </button>
  `;
  const m = openModal({ title: os ? 'QR Code da ordem de serviço' : 'QR Code da autorização', body, footer });
  m.querySelector('[data-cancel]').addEventListener('click', closeModal);
  m.querySelector('#qr-print-a4').addEventListener('click', () => printSrvA4(a.id));
  m.querySelector('#qr-print-thermal').addEventListener('click', () => printSrvThermal(a.id));
  try {
    const canvas = document.createElement('canvas');
    await QRCode.toCanvas(canvas, a.qr_payload, { width: 280, margin: 1, errorCorrectionLevel: 'M' });
    const wrap = m.querySelector('#qr-canvas-wrap');
    wrap.innerHTML = '';
    wrap.appendChild(canvas);
  } catch (e) {
    m.querySelector('#qr-canvas-wrap').innerHTML = `<p style="color:var(--danger)">Erro ao gerar QR: ${esc(e.message)}</p>`;
  }
}

// =============================================================================
// CONCLUIR (registro de manutenção; a OS numerada ganha o termo na Parte 4)
// =============================================================================
function concludeService(id) {
  const a = _items.find(x => x.id === id);
  if (!a || a.status !== 'emitida') return;
  const veh = _vehicles.find(v => v.id === a.vehicle_id);
  // Datas padrão = data da autorização (editáveis). Cliente pediu pra
  // confirmação ser vinculada à autorização e não à data de hoje.
  const defaultDate = a.date || localToday();
  const label = isOS(a) ? `OS nº ${a.os_number}` : a.number;
  const body = `
    <p style="font-size:13px;color:var(--text-soft);margin-bottom:var(--s-3)">
      Registrando manutenção para <strong style="font-family:ui-monospace,monospace;color:var(--primary)">${esc(label)}</strong>
      — ${esc(formatPlate(a.vehicle_plate_snapshot))} ${esc(a.vehicle_model_snapshot)} ·
      <span class="${KIND_BADGE[a.service_kind]}">${esc(KIND_LABEL[a.service_kind])}</span>
    </p>
    <form id="conc-srv-form" autocomplete="off">
      <div class="form-grid">
        <div class="field">
          <label class="field-label">Data abertura <span class="req">*</span></label>
          <input class="input" name="open_date" type="date" required value="${defaultDate}">
        </div>
        <div class="field">
          <label class="field-label">Data conclusão</label>
          <input class="input" name="close_date" type="date" value="${defaultDate}">
        </div>
        <div class="field">
          <label class="field-label">Valor real (R$)</label>
          <input class="input" name="total_value" type="number" step="0.01" min="0" value="${Number(a.estimated_value).toFixed(2)}">
          <span class="field-help">Estimado na ordem: ${fmtMoney(a.estimated_value)}</span>
        </div>
        <div class="field">
          <label class="field-label">KM no serviço</label>
          <input class="input" name="km_at_service" type="number" min="0" value="${isOS(a) && a.km_in != null ? a.km_in : (veh?.current_km ?? '')}">
        </div>
        <div class="field col-full">
          <label class="field-label">Descrição executada <span class="req">*</span></label>
          <textarea class="textarea" name="description" rows="3" required>${esc(a.description)}</textarea>
        </div>
        <div class="field col-full">
          <label class="field-label">Observações</label>
          <textarea class="textarea" name="notes" rows="2"></textarea>
        </div>
      </div>
      <div id="conc-srv-errors" class="login-error" style="display:none;margin-top:12px"></div>
    </form>
  `;
  const footer = `
    <button class="btn btn-outline" data-cancel>Cancelar</button>
    <button class="btn btn-primary" id="conc-srv-save-btn">${icons.check} Concluir e registrar</button>
  `;
  const m = openModal({ title: 'Concluir manutenção', body, footer });
  m.querySelector('[data-cancel]').addEventListener('click', closeModal);
  m.querySelector('#conc-srv-save-btn').addEventListener('click', async () => {
    const form = document.getElementById('conc-srv-form');
    const errBox = document.getElementById('conc-srv-errors');
    errBox.style.display = 'none';
    if (!form.checkValidity()) { form.reportValidity(); return; }
    const v = formValues(form);
    const btn = document.getElementById('conc-srv-save-btn');
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Salvando...';
    try {
      const { error } = await supabase.from('maintenance').insert({
        authorization_id: a.id,
        vehicle_id: a.vehicle_id,
        supplier_id: a.supplier_id,
        kind: a.service_kind,
        status: 'concluida',
        open_date: v.open_date,
        close_date: v.close_date || null,
        km_at_service: v.km_at_service ? Number(v.km_at_service) : null,
        description: v.description,
        total_value: v.total_value ? Number(v.total_value) : null,
        responsible_name: a.responsible_name,
        notes: v.notes || null,
      });
      if (error) throw error;
      toast('Manutenção registrada. Ordem marcada como concluída.', 'success');
      closeModal();
      await loadAll(); renderTable();
    } catch (err) {
      errBox.innerHTML = '⚠️ ' + esc(err.message || 'Erro ao registrar.');
      errBox.style.display = 'block';
      btn.disabled = false; btn.innerHTML = `${icons.check} Concluir e registrar`;
    }
  });
}

// =============================================================================
// CANCELAR / EXCLUIR
// =============================================================================
async function cancelSrv(id) {
  const a = _items.find(x => x.id === id);
  if (!a) return;
  if (!isOS(a)) {
    const ok = await confirmDialog({
      title: 'Cancelar autorização',
      message: `Cancelar a autorização ${a.number}?`,
      confirmText: 'Cancelar autorização',
      danger: true,
    });
    if (!ok) return;
    const { error } = await supabase.rpc('cancel_service_authorization', { p_auth_id: id });
    if (error) { toast(error.message, 'error'); return; }
    toast('Autorização cancelada.', 'success');
    await loadAll(); renderTable();
    return;
  }
  const m = openModal({
    title: 'Cancelar Ordem de Serviço',
    body: `
      <div class="of-summary">
        <div><span>Ordem de serviço</span><strong class="of-mono">${esc(a.os_number)}</strong></div>
        <div><span>Veículo</span><strong>${esc(formatPlate(a.vehicle_plate_snapshot))}</strong></div>
        <div><span>Mecânica</span><strong>${esc(a.supplier_trade_name_snapshot)}</strong></div>
        <div><span>Valor estimado</span><strong>${fmtMoney(a.estimated_value)}</strong></div>
      </div>
      <p class="of-modal-text">${a.os_external
        ? `O número <strong>${esc(a.os_number)}</strong> foi informado e poderá ser registrado de novo.`
        : `O número <strong>${esc(a.os_number)}</strong> não será reaproveitado.`}</p>
      <div class="field">
        <label class="field-label" for="srv-cancel-reason">Justificativa <span class="req">*</span></label>
        <textarea class="textarea" id="srv-cancel-reason" rows="3" maxlength="300"
                  placeholder="ex: serviço não será executado"></textarea>
      </div>
      <div id="srv-cancel-error" class="login-error" style="display:none;margin-top:12px"></div>`,
    footer: `<button class="btn btn-outline" data-cancel>Voltar</button>
             <button class="btn btn-danger" id="srv-cancel-ok">Cancelar a ordem</button>`,
  });
  m.querySelector('[data-cancel]').addEventListener('click', closeModal);
  m.querySelector('#srv-cancel-ok').addEventListener('click', async () => {
    const btn = m.querySelector('#srv-cancel-ok'), errBox = m.querySelector('#srv-cancel-error');
    const reason = m.querySelector('#srv-cancel-reason').value.trim();
    errBox.style.display = 'none';
    if (reason.length < 5) {
      errBox.textContent = 'Informe a justificativa do cancelamento.'; errBox.style.display = 'block';
      m.querySelector('#srv-cancel-reason').focus();
      return;
    }
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Cancelando';
    let error = null;
    try {
      ({ error } = await withTimeout(supabase.rpc('cancel_service_order', { p_auth_id: a.id, p_reason: reason })));
    } catch (e) { error = e; }
    if (error) {
      errBox.textContent = billingError(error); errBox.style.display = 'block';
      btn.disabled = false; btn.textContent = 'Cancelar a ordem';
      return;
    }
    closeModal();
    toast(`Ordem de serviço ${a.os_number} cancelada.`, 'success');
    await loadAll(); renderTable();
  });
}

async function deleteSrv(id) {
  const a = _items.find(x => x.id === id);
  if (!a) return;
  const ok = await confirmDialog({
    title: isOS(a) ? 'Excluir ordem de serviço' : 'Excluir autorização',
    message: `Excluir definitivamente ${isOS(a) ? 'a ordem de serviço ' + a.os_number : 'a autorização ' + a.number}?`,
    confirmText: 'Excluir',
    danger: true,
  });
  if (!ok) return;
  const { error } = await supabase.rpc('delete_service_authorization', { p_auth_id: id });
  if (error) { toast(error.message, 'error', 6000); return; }
  toast(isOS(a) ? 'Ordem de serviço excluída.' : 'Autorização excluída.', 'success');
  await loadAll(); renderTable();
}

// =============================================================================
// IMPRESSÃO A4
// =============================================================================
async function printSrvA4(id) {
  const a = _items.find(x => x.id === id);
  if (!a) return;
  if (isOS(a)) { await printServiceOrder(a.id); return; }
  await printLegacyA4(a);
}

async function printLegacyA4(a) {
  const entity = await getEntity();
  const sup = _suppliers.find(s => s.id === a.supplier_id);
  const orgao = entity?.organ_name || 'Prefeitura Municipal';
  const logo = new URL('logo.png', location.href).href;
  const ibge = entity?.ibge_code || '';
  const qrDataUrl = await QRCode.toDataURL(a.qr_payload, { width: 200, margin: 1, errorCorrectionLevel: 'M' });
  const cancel = a.status === 'cancelada';
  const used = a.status === 'utilizada';
  const html = `<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="UTF-8"><title>Autorização ${esc(a.number)}</title>
<style>
  @page { size: A4 portrait; margin: 14mm; }
  *, *::before, *::after { box-sizing: border-box; }
  body { font-family: 'Helvetica Neue', Arial, sans-serif; color:#1A2A3A; margin:0; font-size:11px; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
  .hdr { display:flex; align-items:center; gap:14px; padding:12px 0; border-bottom:2px solid #D97706; margin-bottom:18px; }
  .hdr img { width:64px; height:64px; object-fit:contain; }
  .hdr .org { font-size:12px; color:#475569; font-weight:600; text-transform:uppercase; letter-spacing:.04em; }
  .hdr .title { font-size:20px; font-weight:700; color:#0F172A; margin-top:2px; }
  .num-box { background:linear-gradient(135deg,#D97706,#B45309); color:#fff; padding:18px 20px; border-radius:10px; text-align:center; margin-bottom:18px; }
  .num-box .lbl { font-size:11px; opacity:.85; letter-spacing:.1em; text-transform:uppercase; }
  .num-box .val { font-family:ui-monospace,'SF Mono',Menlo,monospace; font-size:30px; font-weight:700; margin-top:4px; letter-spacing:.04em; }
  .num-box .meta { font-size:11px; opacity:.9; margin-top:4px; }
  .cancel-stamp { text-align:center; background:#FDECEC; border:3px solid #C0392B; color:#C0392B; font-size:24px; font-weight:900; padding:14px; margin-bottom:18px; border-radius:10px; letter-spacing:6px; }
  .used-stamp { text-align:center; background:#E8F6EE; border:3px solid #16A34A; color:#16A34A; font-size:18px; font-weight:800; padding:10px; margin-bottom:18px; border-radius:10px; letter-spacing:4px; }
  .grid { display:grid; grid-template-columns:1.5fr 1fr; gap:20px; }
  table.data { width:100%; border-collapse:collapse; margin-bottom:14px; }
  table.data td { padding:9px 12px; border:1px solid #E5E9F0; font-size:11.5px; vertical-align:top; }
  table.data .lbl { background:#F6F8FB; font-weight:600; color:#475569; width:35%; }
  table.data .big { font-size:14px; font-weight:700; color:#0F172A; }
  .service-box { background:#FEF3DC; border-left:4px solid #D97706; padding:14px; border-radius:6px; margin:14px 0; }
  .service-box .lbl { font-size:10px; font-weight:600; color:#92400E; text-transform:uppercase; letter-spacing:.05em; margin-bottom:6px; }
  .service-box .desc { font-size:13px; line-height:1.5; color:#1A2A3A; }
  .qr-box { text-align:center; padding:14px; border:1px solid #E5E9F0; border-radius:8px; }
  .qr-box img { width:100%; max-width:200px; }
  .qr-box .qr-label { font-size:10px; color:#64748B; margin-top:8px; }
  .sign-box { margin-top:50px; display:grid; grid-template-columns:1fr 1fr; gap:30px; }
  .sign-line { border-top:1px solid #1A2A3A; padding-top:8px; text-align:center; font-size:10px; color:#475569; }
  .footer { margin-top:30px; padding-top:8px; border-top:1px solid #E5E9F0; text-align:center; font-size:9px; color:#94A3B8; }
</style></head><body>
  <div class="hdr">
    ${logo ? `<img src="${esc(logo)}" alt="">` : ''}
    <div>
      <div class="org">${esc(entity?.entity_type || '')}</div>
      <div class="title">${esc(orgao)}</div>
      ${ibge ? `<div style="font-size:10px;color:#94A3B8;margin-top:2px">IBGE ${esc(ibge)}</div>` : ''}
    </div>
  </div>
  ${cancel ? `<div class="cancel-stamp">⚠️ CANCELADA ⚠️</div>` : ''}
  ${used ? `<div class="used-stamp">✓ CONCLUÍDA</div>` : ''}
  <div class="num-box">
    <div class="lbl">Autorização de Manutenção</div>
    <div class="val">${esc(a.number)}</div>
    <div class="meta">Emitida em ${esc(fmtDate(a.date))}</div>
  </div>
  <div class="grid">
    <div>
      <table class="data">
        <tr><td class="lbl">Veículo</td><td class="big">${esc(formatPlate(a.vehicle_plate_snapshot))}</td></tr>
        <tr><td class="lbl">Modelo</td><td>${esc(a.vehicle_model_snapshot)}</td></tr>
        <tr><td class="lbl">Secretaria</td><td>${esc(a.department_acronym_snapshot || '—')}</td></tr>
        <tr><td class="lbl">Categoria</td><td class="big">${esc(KIND_LABEL[a.service_kind])}</td></tr>
        <tr><td class="lbl">Valor estimado</td><td class="big" style="color:#16A34A">${fmtMoney(a.estimated_value)}</td></tr>
        <tr><td class="lbl">Mecânica</td><td>${esc(a.supplier_trade_name_snapshot)}${sup?.cnpj ? '<br><small>CNPJ ' + esc(sup.cnpj) + '</small>' : ''}</td></tr>
        <tr><td class="lbl">Responsável</td><td>${esc(a.responsible_name)}</td></tr>
        ${a.driver_name_snapshot ? `<tr><td class="lbl">Motorista</td><td>${esc(a.driver_name_snapshot)}</td></tr>` : ''}
      </table>
      <div class="service-box">
        <div class="lbl">📋 Serviço a ser realizado</div>
        <div class="desc">${esc(a.description)}</div>
      </div>
      ${a.notes ? `<div style="background:#F6F8FB;border-radius:6px;padding:10px 14px;font-size:11px;margin-top:8px"><b>Observações:</b> ${esc(a.notes)}</div>` : ''}
    </div>
    <div class="qr-box">
      <img src="${qrDataUrl}" alt="QR">
      <div class="qr-label">Escaneie para verificar</div>
    </div>
  </div>
  ${!cancel && !used ? `
  <div class="sign-box">
    <div class="sign-line">Motorista / Solicitante</div>
    <div class="sign-line">Mecânica / Atendente</div>
  </div>` : ''}
  <div class="footer">Gerir Frota · ${esc(new Date().toLocaleString('pt-BR'))}</div>
</body></html>`;
  openPrintTab(html, { title: `Autorização ${a.number}` });
}

// =============================================================================
// IMPRESSÃO TÉRMICA
// =============================================================================
async function printSrvThermal(id) {
  const a = _items.find(x => x.id === id);
  if (!a) return;
  if (!hasChosenThermalWidth()) {
    const picked = await askThermalWidth();
    if (!picked) return;
  }
  const entity = await getEntity();
  const os = isOS(a);
  const compactPayload = [
    os ? `OS ${a.os_number}` : `AUT ${a.number}`,
    ...(os ? [a.number] : []),
    `${fmtDate(a.date)}`,
    `${formatPlate(a.vehicle_plate_snapshot)} - ${a.vehicle_model_snapshot}`,
    `${KIND_LABEL[a.service_kind]}`,
    `${a.description}`,
    ...(os ? [`Servicos: ${fmtMoney(a.value_services)}`, `Pecas: ${fmtMoney(a.value_parts)}`] : []),
    `Valor: ${fmtMoney(a.estimated_value)}`,
    `Mecânica: ${a.supplier_trade_name_snapshot}`,
    `Resp: ${a.responsible_name}`,
    ...(a.driver_name_snapshot ? [`Mot: ${a.driver_name_snapshot}`] : []),
  ].join('\n');
  const qrDataUrl = await QRCode.toDataURL(compactPayload, { width: 400, margin: 2, errorCorrectionLevel: 'L' });
  const orgao = entity?.organ_name || 'Prefeitura Municipal';
  const cancel = a.status === 'cancelada';

  const bodyHTML = `
    <div class="center bold head-title">${esc(orgao)}</div>
    <div class="center head-sub">${os ? 'ORDEM DE SERVIÇO' : 'AUTORIZAÇÃO DE MANUTENÇÃO'}</div>
    <div class="sep"></div>
    ${cancel ? `<div class="cancel">CANCELADA</div>` : ''}
    ${os ? `<div class="center num">Nº ${esc(a.os_number)}</div><div class="center date-line">${esc(a.number)}</div>` : `<div class="center num">${esc(a.number)}</div>`}
    <div class="center date-line">${esc(fmtDate(a.date))} · ${esc(STATUS_LABEL[a.status].toUpperCase())}</div>
    <div class="sep"></div>
    <div class="row"><span class="lbl">Veículo:</span><span class="val">${esc(formatPlate(a.vehicle_plate_snapshot))}</span><span class="val-md">${esc(a.vehicle_model_snapshot)}</span></div>
    <div class="row"><span class="lbl">Secretaria:</span><span class="val-md">${esc(a.department_acronym_snapshot || '—')}</span></div>
    ${os && a.km_in != null && Number(a.km_in) !== KM_MACHINE ? `<div class="row"><span class="lbl">Km na entrada:</span><span class="val-md">${Number(a.km_in).toLocaleString('pt-BR')}</span></div>` : ''}
    <div class="sep"></div>
    <div class="service">${esc(KIND_LABEL[a.service_kind].toUpperCase())}</div>
    <div class="val-md">${esc(a.description)}</div>
    <div class="sep"></div>
    ${os ? `
    <div class="grid2">
      <div><span class="lbl">Serviços:</span><span class="val-md">${fmtMoney(a.value_services)}</span></div>
      <div><span class="lbl">Peças:</span><span class="val-md">${fmtMoney(a.value_parts)}</span></div>
    </div>` : ''}
    <div class="row"><span class="lbl">Valor estimado:</span><span class="val">${fmtMoney(a.estimated_value)}</span></div>
    ${os ? `<div class="row"><span class="lbl">Empenho:</span><span class="val-md">${esc(a.commitment_number || 'a informar')}</span></div>` : ''}
    <div class="sep"></div>
    <div class="row"><span class="lbl">Mecânica:</span><span class="val-md">${esc(a.supplier_trade_name_snapshot)}</span></div>
    ${os && a.contract_number_snapshot ? `<div class="row"><span class="lbl">Contrato:</span><span class="val-md">${esc(a.contract_number_snapshot)}</span></div>` : ''}
    <div class="sep"></div>
    <div class="row"><span class="lbl">Responsável:</span><span class="val-md">${esc(a.responsible_name)}</span></div>
    ${a.driver_name_snapshot ? `<div class="row"><span class="lbl">Motorista:</span><span class="val-md">${esc(a.driver_name_snapshot)}</span></div>` : ''}
    <div class="rubrica">Rubrica do responsável</div>
    ${a.notes ? `<div class="sep"></div><div><span class="lbl">Obs:</span><span class="val-md">${esc(a.notes)}</span></div>` : ''}
    <div class="sep"></div>
    <img class="qr" src="${qrDataUrl}" alt="QR">
    <div class="qr-hint">Escaneie para verificar</div>
    ${!cancel ? `<div class="sign-block">Motorista</div><div class="sign-block">Mecânica</div>` : ''}
    <div class="footer">Gerir Frota</div>
  `;
  await openThermalPDF(bodyHTML, { title: os ? `OS ${a.os_number}` : `Aut ${a.number}` });
}
