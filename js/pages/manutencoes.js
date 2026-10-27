import { pageRoot, pageHeader } from '../shell.js';
import { supabase } from '../supabase.js';
import { esc, fmtDate, fmtMoney, toast, openModal, closeModal, confirmDialog, formValues, formatPlate, supplierOptionLabel, supplierCellHTML, isMissingColumn } from '../ui.js';
import { icons } from '../icons.js';
import { getProfile, isAdmin } from '../auth.js';
import { localToday, nfMatches, billingError } from '../billing.js';
import { exportXLSX, timestampFilename } from '../export.js';
import { openServiceTermModal, loadServiceTerms, loadServiceTermInvoices } from './servico_termo.js';
import { printServiceReceiptTerm } from '../service_docs.js';

const KIND_LABEL = { preventiva: 'Preventiva', corretiva: 'Corretiva', sinistro: 'Sinistro', revisao: 'Revisão', outros: 'Outros' };
const KIND_BADGE = { preventiva: 'badge badge-success', corretiva: 'badge badge-warning', sinistro: 'badge badge-danger', revisao: 'badge', outros: 'badge badge-neutral' };
const STATUS_LABEL = { aberta: 'Aberta', em_andamento: 'Em andamento', concluida: 'Concluída', cancelada: 'Cancelada' };
const STATUS_BADGE = { aberta: 'badge badge-warning', em_andamento: 'badge', concluida: 'badge badge-success', cancelada: 'badge badge-danger' };
const MIN_REASON = 5;

let _items = [];
let _vehicles = [];
let _suppliers = [];
let _depts = [];
let _emittedAuths = [];
// Termos de serviço (Parte 3/4). _hasTerms = false: banco anterior, fluxo antigo
// ("Importar autorização", sem justificativa no manual, sem coluna Termo).
let _termById = new Map();   // term_id → termo
let _invoices = new Map();   // term_id → [notas]
let _hasTerms = false;
let _filter = { search: '', vehicle: '', dept: '', supplier: '', kind: '', status: '', origin: '', month: '' };

const FILTER_IDS = { 'ff-veh': 'vehicle', 'ff-dept': 'dept', 'ff-sup': 'supplier', 'ff-kind': 'kind', 'ff-status': 'status', 'ff-origin': 'origin', 'ff-month': 'month' };

export async function renderManutencoes() {
  pageRoot().innerHTML = `
    ${pageHeader({
      title: 'Manutenções',
      subtitle: 'Serviços executados — pelo termo da ordem de serviço ou registro avulso.',
      actionsHtml: `
        <button class="btn btn-outline" id="btn-export-man" title="Exportar lista filtrada (Excel)">
          <span style="width:16px;height:16px;display:inline-flex">${icons.download}</span>
          <span>Exportar Excel</span>
        </button>
        <button class="btn btn-outline" id="btn-import-aut">
          <span style="width:16px;height:16px;display:inline-flex">${icons.fileCheck}</span>
          <span id="btn-import-label">Importar autorização</span>
        </button>
        <button class="btn btn-primary" id="btn-new-man">
          <span style="width:16px;height:16px;display:inline-flex">${icons.plus}</span>
          Registrar manual
        </button>`,
    })}
    <div id="man-stats"></div>
    <div class="card">
      <div class="table-toolbar">
        <div class="search ${_filter.search ? 'has-value' : ''}" id="man-search-box">
          ${icons.search}
          <input id="man-search" type="search"
                 placeholder="Buscar por placa, mecânica, nº da OS, nota fiscal, descrição…"
                 autocomplete="off" value="${esc(_filter.search)}">
          <button class="clear" id="man-search-clear" aria-label="Limpar busca">${icons.close}</button>
        </div>
        <div class="count" id="man-count"></div>
      </div>
      <div class="filter-chips">
        <select class="select chip" id="ff-veh"><option value="">Todos veículos</option></select>
        <select class="select chip" id="ff-dept"><option value="">Todas secretarias</option></select>
        <select class="select chip" id="ff-sup"><option value="">Todas mecânicas</option></select>
        <select class="select chip" id="ff-kind">
          <option value="">Todas categorias</option>
          ${Object.entries(KIND_LABEL).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}
        </select>
        <select class="select chip" id="ff-status">
          <option value="">Todos status</option>
          ${Object.entries(STATUS_LABEL).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}
        </select>
        <select class="select chip" id="ff-origin">
          <option value="">Qualquer origem</option>
          <option value="os">Com ordem de serviço</option>
          <option value="manual">Registro manual</option>
        </select>
        <input class="input chip" type="month" id="ff-month" value="${esc(_filter.month)}">
        <button class="btn btn-ghost btn-sm" id="ff-clear" hidden>Limpar filtros</button>
      </div>
      <div id="man-tablebox">
        <div class="skeleton skeleton-line w-40"></div>
        <div class="skeleton skeleton-line w-80" style="margin-top:12px"></div>
        <div class="skeleton skeleton-line w-60" style="margin-top:8px"></div>
      </div>
    </div>
  `;

  document.getElementById('btn-new-man').addEventListener('click', () => openManModal());
  document.getElementById('btn-import-aut').addEventListener('click', () => openImportModal());
  document.getElementById('btn-export-man').addEventListener('click', exportExcel);

  const sBox = document.getElementById('man-search-box');
  const sIn = document.getElementById('man-search');
  document.getElementById('man-search-clear').addEventListener('click', () => {
    _filter.search = ''; sIn.value = ''; sBox.classList.remove('has-value'); renderTable();
  });
  sIn.addEventListener('input', e => {
    _filter.search = e.target.value || '';
    sBox.classList.toggle('has-value', !!_filter.search);
    renderTable();
  });
  Object.entries(FILTER_IDS).forEach(([id, key]) => {
    document.getElementById(id).addEventListener('change', e => {
      _filter[key] = e.target.value; updateClear(); renderTable(); renderStats();
    });
  });
  document.getElementById('ff-clear').addEventListener('click', () => {
    _filter = { search: _filter.search, vehicle: '', dept: '', supplier: '', kind: '', status: '', origin: '', month: '' };
    Object.keys(FILTER_IDS).forEach(id => document.getElementById(id).value = '');
    updateClear(); renderTable(); renderStats();
  });

  await loadAll();
  fillFilterSelects();
  renderStats();
  renderTable();
}

function updateClear() {
  const any = _filter.vehicle || _filter.dept || _filter.supplier || _filter.kind || _filter.status || _filter.origin || _filter.month;
  document.getElementById('ff-clear').hidden = !any;
}

// =============================================================================
// CARGA (tolerante ao banco na versão anterior)
// =============================================================================
const MAN_BASE = `
  id, authorization_id, vehicle_id, supplier_id, kind, status,
  open_date, close_date, km_at_service, description, total_value,
  responsible_name, notes, created_at`;
const manQuery = (extra, authCols) => supabase.from('maintenance')
  .select(`${MAN_BASE}${extra}, authorization:authorization_id(${authCols})`)
  .is('deleted_at', null).order('open_date', { ascending: false }).order('created_at', { ascending: false });

const EA_BASE = `
  id, number, date, vehicle_id, supplier_id, service_kind,
  description, estimated_value, responsible_name,
  vehicle_plate_snapshot, vehicle_model_snapshot, supplier_trade_name_snapshot`;
const EA_OS = `, os_number, contract_number_snapshot, value_services, value_parts, km_in, commitment_number`;
const eaQuery = (extra) => supabase.from('service_authorization').select(`${EA_BASE}${extra}`)
  .eq('status', 'emitida').is('deleted_at', null).order('date', { ascending: false });

async function loadAll() {
  let [m, v, s, d, ea, t, inv] = await Promise.all([
    manQuery(', service_term_id, manual_reason', 'number, os_number'),
    supabase.from('vehicle').select(`
      id, plate, model, brand, current_km,
      department_id, department:department_id(acronym, name)
    `).is('deleted_at', null).order('plate'),
    supabase.from('supplier').select(`
      id, kind, legal_name, trade_name, cnpj, department_id, contract_number,
      department:department_id(acronym, name)
    `).in('kind', ['mecanica', 'ambos']).order('legal_name'),
    supabase.from('department').select('id, acronym, name').order('acronym'),
    eaQuery(EA_OS),
    loadServiceTerms(),
    loadServiceTermInvoices(),
  ]);
  // Banco sem o termo (Parte 3): repete sem as colunas; depois, banco sem a OS (Parte 1)
  let hasTermCols = true, hasOS = true;
  if (m.error && isMissingColumn(m.error)) { hasTermCols = false; m = await manQuery('', 'number, os_number'); }
  if (m.error && isMissingColumn(m.error)) { hasOS = false; m = await manQuery('', 'number'); }
  if (ea.error && isMissingColumn(ea.error)) { hasOS = false; ea = await eaQuery(''); }
  _hasTerms = hasTermCols && hasOS && t.available;
  _termById = new Map();
  t.byOrder.forEach(list => list.forEach(x => _termById.set(x.id, x)));
  _invoices = inv;
  if (m.error) { toast('Falha ao carregar manutenções: ' + m.error.message, 'error'); _items = []; }
  else _items = m.data || [];
  _vehicles = v.data || [];
  _suppliers = s.data || [];
  _depts = d.data || [];
  _emittedAuths = ea.data || [];
  const lbl = document.getElementById('btn-import-label');
  if (lbl) lbl.textContent = _hasTerms ? 'Gerar termo da OS' : 'Importar autorização';
}

async function reload() { await loadAll(); renderStats(); renderTable(); }

/** Rótulo da autorização: nº da OS quando houver, senão o código AAAAMMDD-MAN-NNN. */
const authLabel = (a) => (a?.os_number ? `OS ${a.os_number}` : (a?.number || ''));
/** Termo ativo da manutenção (só a criada pelo termo tem service_term_id). */
const termOf = (a) => (a?.service_term_id && _termById.get(a.service_term_id)) || null;
const activeTermOf = (a) => { const t = termOf(a); return t && t.status === 'emitido' ? t : null; };
const isManual = (a) => !a.authorization_id;

function fillFilterSelects() {
  document.getElementById('ff-veh').innerHTML = '<option value="">Todos veículos</option>' +
    _vehicles.map(v => `<option value="${v.id}">${esc(formatPlate(v.plate))} — ${esc(v.model)}</option>`).join('');
  document.getElementById('ff-dept').innerHTML = '<option value="">Todas secretarias</option>' +
    _depts.map(d => `<option value="${d.id}">${esc(d.acronym)} — ${esc(d.name)}</option>`).join('');
  document.getElementById('ff-sup').innerHTML = '<option value="">Todas mecânicas</option>' +
    _suppliers.map(s => `<option value="${s.id}">${esc(supplierOptionLabel(s))}</option>`).join('');
  Object.entries(FILTER_IDS).forEach(([id, key]) => {
    if (key !== 'month' && _filter[key]) document.getElementById(id).value = _filter[key];
  });
  updateClear();
}

function applyFilters() {
  const t = (_filter.search || '').toLowerCase();
  return _items.filter(a => {
    if (_filter.vehicle && a.vehicle_id !== _filter.vehicle) return false;
    if (_filter.supplier && a.supplier_id !== _filter.supplier) return false;
    if (_filter.kind && a.kind !== _filter.kind) return false;
    if (_filter.status && a.status !== _filter.status) return false;
    if (_filter.origin === 'os' && isManual(a)) return false;
    if (_filter.origin === 'manual' && !isManual(a)) return false;
    if (_filter.month && String(a.open_date).slice(0, 7) !== _filter.month) return false;
    if (_filter.dept) {
      const veh = _vehicles.find(x => x.id === a.vehicle_id);
      if (veh?.department_id !== _filter.dept) return false;
    }
    if (!t) return true;
    const veh = _vehicles.find(x => x.id === a.vehicle_id);
    const sup = _suppliers.find(x => x.id === a.supplier_id);
    const term = termOf(a);
    return (veh?.plate || '').toLowerCase().includes(t)
        || (veh?.model || '').toLowerCase().includes(t)
        || (sup?.trade_name || sup?.legal_name || '').toLowerCase().includes(t)
        || (a.responsible_name || '').toLowerCase().includes(t)
        || (a.description || '').toLowerCase().includes(t)
        || (a.manual_reason || '').toLowerCase().includes(t)
        || (a.authorization?.os_number || '').toLowerCase().includes(t)
        || (a.authorization?.number || '').toLowerCase().includes(t)
        || (term?.number || '').toLowerCase().includes(t)
        || (!!term && (_invoices.get(term.id) || []).some(i => nfMatches(i.invoice_number, _filter.search)));
  });
}

function renderStats() {
  const filtered = applyFilters();
  const totalVal = filtered.reduce((s, a) => s + Number(a.total_value || 0), 0);
  const aberta = filtered.filter(x => x.status === 'aberta').length;
  const concluida = filtered.filter(x => x.status === 'concluida').length;
  const comTermo = filtered.filter(x => activeTermOf(x)).length;
  document.getElementById('man-stats').innerHTML = `
    <div class="stat-row" style="margin-bottom:var(--s-4)">
      <div class="stat"><label>Registros</label><strong>${filtered.length}</strong></div>
      <div class="stat"><label>Abertas</label><strong style="color:var(--warning)">${aberta}</strong></div>
      <div class="stat"><label>Concluídas</label><strong style="color:var(--success)">${concluida}</strong></div>
      ${_hasTerms ? `<div class="stat"><label>Com termo</label><strong>${comTermo}</strong></div>` : ''}
      <div class="stat"><label>Valor total</label><strong style="color:var(--success)">${fmtMoney(totalVal)}</strong></div>
    </div>
  `;
}

function anyFilter() {
  return _filter.search || _filter.vehicle || _filter.dept || _filter.supplier || _filter.kind || _filter.status || _filter.origin || _filter.month;
}

function renderTable() {
  const box = document.getElementById('man-tablebox');
  const countEl = document.getElementById('man-count');
  if (!_items.length) {
    if (countEl) countEl.textContent = '';
    box.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">${icons.wrench}</div>
        <div class="empty-state-title">Nenhuma manutenção</div>
        <p class="empty-state-text">${_hasTerms ? 'Gere o termo de uma ordem de serviço ou registre manualmente.' : 'Importe de uma autorização ou registre manualmente.'}</p>
      </div>`;
    return;
  }
  const filtered = applyFilters();
  if (countEl) {
    countEl.textContent = anyFilter() ? `${filtered.length} de ${_items.length} registro(s)` : `${_items.length} registro(s)`;
  }
  if (!filtered.length) {
    box.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">${icons.search}</div>
        <div class="empty-state-title">Nenhum resultado</div>
      </div>`;
    return;
  }
  box.innerHTML = `
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>Abertura</th>
            <th>Veículo</th>
            <th>Categoria</th>
            <th>Serviço</th>
            <th>Mecânica</th>
            <th>Valor</th>
            <th>Status</th>
            <th>Origem</th>
            ${_hasTerms ? '<th>Termo</th>' : ''}
            <th class="actions-col">Ações</th>
          </tr>
        </thead>
        <tbody>${filtered.map(manRow).join('')}</tbody>
      </table>
    </div>
  `;
  box.querySelectorAll('[data-act="edit"]').forEach(b => b.addEventListener('click', () => openManModal(b.dataset.id)));
  box.querySelectorAll('[data-act="delete"]').forEach(b => b.addEventListener('click', () => deleteMan(b.dataset.id)));
  box.querySelectorAll('[data-act="term-pdf"]').forEach(b => b.addEventListener('click', async () => {
    b.disabled = true;
    try { await printServiceReceiptTerm(b.dataset.term); } finally { b.disabled = false; }
  }));
}

function originCell(a) {
  const au = a.authorization;
  if (au?.os_number) return `<div class="cell-stack"><span class="badge of-mono" style="font-size:10.5px">OS ${esc(au.os_number)}</span><span class="of-sub">${esc(au.number || '')}</span></div>`;
  if (au?.number) return `<span class="badge of-mono" style="font-size:10.5px">${esc(au.number)}</span>`;
  const reason = a.manual_reason || '';
  return `<div class="cell-stack">
    <span class="badge badge-neutral" title="${esc(reason)}">Manual</span>
    ${reason ? `<span class="of-sub" style="white-space:normal;max-width:220px">${esc(reason)}</span>` : ''}
  </div>`;
}

function termCell(a) {
  const term = termOf(a);
  if (!term) return '<span class="of-sub">—</span>';
  const notes = (_invoices.get(term.id) || []).map(i => i.invoice_number).filter(Boolean);
  const canceled = term.status !== 'emitido';
  return `<div class="cell-stack">
    <span class="of-nowrap"><strong class="of-mono">${esc(term.number)}</strong> · ${esc(fmtDate(term.issue_date))}${canceled ? ' <span class="badge badge-danger">Cancelado</span>' : ''}</span>
    ${notes.length ? `<span class="of-sub">NF ${esc(notes.join(', '))}</span>` : ''}
    <span class="of-sub of-amount">${fmtMoney(term.total_amount)}</span>
  </div>`;
}

function manRow(a) {
  const veh = _vehicles.find(x => x.id === a.vehicle_id);
  const sup = _suppliers.find(x => x.id === a.supplier_id);
  const term = activeTermOf(a);
  const lockMsg = term ? `Esta manutenção tem Termo de Recebimento nº ${term.number}. Para alterar, cancele o termo na lista de Ordens de Serviço.` : '';
  return `
    <tr>
      <td data-label="Abertura" style="white-space:nowrap">
        <div class="cell-stack">
          <span>${esc(fmtDate(a.open_date))}</span>
          ${a.close_date ? `<span style="color:var(--text-muted);font-size:11px">→ ${esc(fmtDate(a.close_date))}</span>` : ''}
        </div>
      </td>
      <td data-label="Veículo">
        <div class="cell-stack">
          <strong>${esc(formatPlate(veh?.plate || ''))}</strong>
          <span style="color:var(--text-muted);font-size:12px">${esc(veh?.model || '')}</span>
        </div>
      </td>
      <td data-label="Categoria"><span class="${KIND_BADGE[a.kind] || 'badge'}">${esc(KIND_LABEL[a.kind] || a.kind)}</span></td>
      <td data-label="Serviço" style="font-size:12.5px;max-width:300px"><div class="cell-stack"><span style="white-space:normal">${esc(a.description)}</span></div></td>
      <td data-label="Mecânica">${supplierCellHTML(a.supplier_trade_name_snapshot || sup?.trade_name || sup?.legal_name, sup)}</td>
      <td data-label="Valor" style="white-space:nowrap;color:var(--success);font-weight:500">${a.total_value != null ? fmtMoney(a.total_value) : '—'}</td>
      <td data-label="Status"><span class="${STATUS_BADGE[a.status]}">${esc(STATUS_LABEL[a.status])}</span></td>
      <td data-label="Origem">${originCell(a)}</td>
      ${_hasTerms ? `<td data-label="Termo">${termCell(a)}</td>` : ''}
      <td class="actions-col">
        <div class="actions-row">
          ${term ? `<button class="btn btn-ghost btn-icon btn-sm" data-act="term-pdf" data-term="${term.id}" title="Abrir o Termo de Recebimento em PDF">${icons.fileCheck}</button>` : ''}
          <button class="btn btn-ghost btn-icon btn-sm" data-act="edit" data-id="${a.id}" title="${term ? esc(lockMsg) : 'Editar'}" ${term ? 'disabled' : ''}>${icons.edit}</button>
          ${isAdmin() ? `<button class="btn btn-ghost btn-icon btn-sm" data-act="delete" data-id="${a.id}" title="${term ? esc(lockMsg) : 'Excluir'}" ${term ? 'disabled' : ''} style="color:var(--danger)">${icons.trash}</button>` : ''}
        </div>
      </td>
    </tr>`;
}

// =============================================================================
// GERAR TERMO DA OS / IMPORTAR AUTORIZAÇÃO
// OS numerada (com o termo no banco) → modal do termo; autorização antiga →
// registro de manutenção de sempre.
// =============================================================================
function openImportModal() {
  if (!_emittedAuths.length) {
    toast(_hasTerms ? 'Nenhuma ordem de serviço emitida aguardando termo.' : 'Nenhuma autorização de manutenção emitida disponível.', 'info');
    return;
  }
  const body = `
    <p style="font-size:13px;color:var(--text-soft);margin-bottom:var(--s-4)">
      ${_hasTerms
        ? 'Selecione a ordem de serviço emitida. Ordens numeradas geram o Termo de Recebimento de Serviço; autorizações antigas (sem nº de OS) são concluídas pelo registro de manutenção.'
        : 'Selecione uma autorização emitida.'}
    </p>
    <div class="table-toolbar" style="margin-bottom:var(--s-3)">
      <div class="search has-value" style="max-width:none">
        ${icons.search}
        <input id="imp-search" type="search" placeholder="Buscar por nº, placa, mecânica…" autocomplete="off">
      </div>
    </div>
    <div id="imp-list" style="max-height:400px;overflow-y:auto;border:1px solid var(--border);border-radius:var(--r-md)"></div>
  `;
  const footer = `<button class="btn btn-outline" data-cancel>Cancelar</button>`;
  const m = openModal({ title: _hasTerms ? 'Gerar termo da ordem de serviço' : 'Importar de autorização', body, footer, size: 'lg' });
  m.querySelector('[data-cancel]').addEventListener('click', closeModal);

  const listEl = m.querySelector('#imp-list');
  const render = (term = '') => {
    const t = term.toLowerCase();
    const filtered = _emittedAuths.filter(a => !t ||
      (a.number || '').toLowerCase().includes(t) ||
      (a.os_number || '').toLowerCase().includes(t) ||
      (a.vehicle_plate_snapshot || '').toLowerCase().includes(t) ||
      (a.supplier_trade_name_snapshot || '').toLowerCase().includes(t));
    if (!filtered.length) {
      listEl.innerHTML = `<div style="padding:var(--s-5);text-align:center;color:var(--text-muted);font-size:13px">Nenhuma ordem encontrada.</div>`;
      return;
    }
    listEl.innerHTML = filtered.map(a => `
      <button type="button" class="imp-row" data-id="${a.id}" style="display:flex;justify-content:space-between;align-items:center;width:100%;padding:var(--s-3) var(--s-4);border-bottom:1px solid var(--border);background:var(--surface);text-align:left">
        <div>
          <div style="font-family:ui-monospace,monospace;font-weight:700;color:var(--primary);font-size:13px">${esc(authLabel(a))}${a.os_number ? ` <span style="font-weight:400;color:var(--text-muted);font-size:11px">${esc(a.number)}</span>` : ''}</div>
          <div style="font-size:12px;color:var(--text-soft);margin-top:2px">
            ${esc(formatPlate(a.vehicle_plate_snapshot))} — ${esc(a.vehicle_model_snapshot)} ·
            ${esc(KIND_LABEL[a.service_kind] || a.service_kind)} ·
            ${fmtMoney(a.estimated_value)}
          </div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:2px">
            ${esc(fmtDate(a.date))} · ${esc(a.supplier_trade_name_snapshot)} · ${esc(a.responsible_name)}
          </div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:4px;font-style:italic">${esc(a.description)}</div>
          ${_hasTerms && !a.os_number ? `<div style="font-size:11px;color:var(--warning);margin-top:4px">Autorização antiga, sem nº de OS: conclui pelo registro de manutenção.</div>` : ''}
        </div>
        <span style="color:var(--primary)">${icons.chevronRight}</span>
      </button>
    `).join('');
    listEl.querySelectorAll('.imp-row').forEach(btn => {
      btn.addEventListener('mouseenter', () => btn.style.background = 'var(--primary-tint)');
      btn.addEventListener('mouseleave', () => btn.style.background = 'var(--surface)');
      btn.addEventListener('click', () => {
        closeModal();
        const a = _emittedAuths.find(x => x.id === btn.dataset.id);
        if (_hasTerms && a.os_number) openServiceTermModal(a, reload);
        else openManModal(null, a);
      });
    });
  };
  m.querySelector('#imp-search').addEventListener('input', e => render(e.target.value));
  render();
}

// =============================================================================
// MODAL NOVO/EDITAR (registro manual ou conclusão de autorização antiga)
// =============================================================================
function openManModal(id, fromAuth = null) {
  const editing = !!id;
  const a = editing ? _items.find(x => x.id === id) : null;
  if (a && activeTermOf(a)) {
    toast(`Esta manutenção tem Termo de Recebimento nº ${activeTermOf(a).number}. Para alterar, cancele o termo na lista de Ordens de Serviço.`, 'warning', 7000);
    return;
  }
  const me = getProfile();
  const today = localToday();

  let initial;
  if (editing) {
    initial = { ...a, _authNumber: authLabel(a.authorization) };
  } else if (fromAuth) {
    const veh = _vehicles.find(v => v.id === fromAuth.vehicle_id);
    initial = {
      authorization_id: fromAuth.id,
      vehicle_id: fromAuth.vehicle_id,
      supplier_id: fromAuth.supplier_id,
      kind: fromAuth.service_kind,
      description: fromAuth.description,
      total_value: fromAuth.estimated_value,
      responsible_name: fromAuth.responsible_name,
      open_date: fromAuth.date || today,    // data da autorização (editável)
      close_date: fromAuth.date || today,
      km_at_service: veh?.current_km || null,
      notes: (fromAuth.os_number ? 'Importado da ordem de serviço ' : 'Importado da autorização ') + authLabel(fromAuth).replace(/^OS /, 'nº '),
      status: 'concluida',
      _authNumber: authLabel(fromAuth),
    };
  } else {
    initial = {
      authorization_id: null,
      vehicle_id: '', supplier_id: '',
      kind: 'corretiva', description: '', total_value: '',
      responsible_name: me?.full_name || '',
      open_date: today, close_date: null,
      km_at_service: null, manual_reason: '',
      notes: '', status: 'concluida', _authNumber: null,
    };
  }

  const isLinked = !!initial.authorization_id;
  // Justificativa: obrigatória no registro sem OS quando o banco já tem a coluna
  const needReason = _hasTerms && !isLinked;
  const vehOptions = '<option value="">— Selecione —</option>' +
    _vehicles.map(v => `<option value="${v.id}" ${initial.vehicle_id === v.id ? 'selected' : ''}>${esc(formatPlate(v.plate))} — ${esc(v.model)} (${esc(v.department?.acronym || '—')})</option>`).join('');
  // Fornecedor: linked → mostra só o item fixo; senão → placeholder que
  // vai ser preenchido pelo listener do veículo.
  const supOptions = isLinked
    ? (() => {
        const s = _suppliers.find(x => x.id === initial.supplier_id);
        return s ? `<option value="${s.id}" selected>${esc(supplierOptionLabel(s))}</option>` : '';
      })()
    : '<option value="">— Selecione o veículo primeiro —</option>';
  const kindOptions = Object.entries(KIND_LABEL).map(([k, l]) =>
    `<option value="${k}" ${initial.kind === k ? 'selected' : ''}>${esc(l)}</option>`).join('');
  const statusOptions = Object.entries(STATUS_LABEL).map(([k, l]) =>
    `<option value="${k}" ${initial.status === k ? 'selected' : ''}>${esc(l)}</option>`).join('');

  const body = `
    <form id="man-form" autocomplete="off">
      ${isLinked ? `
        <div class="alert" style="background:var(--primary-tint);border-left:3px solid var(--primary);padding:var(--s-3) var(--s-4);border-radius:var(--r-md);margin-bottom:var(--s-4);font-size:13px">
          <strong>Vinculado à autorização</strong>${initial._authNumber ? ` <span style="font-family:ui-monospace,monospace;color:var(--primary)">${esc(initial._authNumber)}</span>` : ''}
        </div>` : (needReason ? `
        <div class="alert" style="background:var(--warning-bg);border-left:3px solid var(--warning);padding:var(--s-3) var(--s-4);border-radius:var(--r-md);margin-bottom:var(--s-4);font-size:13px">
          <strong>Registro sem ordem de serviço.</strong> Não gera termo de recebimento. Informe a justificativa.
        </div>` : '')}
      <div class="form-grid">
        <div class="field">
          <label class="field-label">Data abertura <span class="req">*</span></label>
          <input class="input" name="open_date" type="date" required value="${initial.open_date}">
        </div>
        <div class="field">
          <label class="field-label">Data conclusão</label>
          <input class="input" name="close_date" type="date" value="${initial.close_date || ''}">
        </div>
        <div class="field col-full">
          <label class="field-label">Veículo <span class="req">*</span></label>
          <select class="select" name="vehicle_id" id="man-veh" required ${isLinked ? 'disabled' : ''}>${vehOptions}</select>
          <input type="hidden" name="vehicle_id_h" value="${initial.vehicle_id}">
        </div>
        <div class="field col-full">
          <label class="field-label">Mecânica <span class="req">*</span></label>
          <select class="select" name="supplier_id" id="man-sup" required ${isLinked ? 'disabled' : ''}>${supOptions}</select>
          <input type="hidden" name="supplier_id_h" value="${initial.supplier_id}">
        </div>
        <div class="field">
          <label class="field-label">Categoria <span class="req">*</span></label>
          <select class="select" name="kind" required>${kindOptions}</select>
        </div>
        <div class="field">
          <label class="field-label">Status <span class="req">*</span></label>
          <select class="select" name="status" required>${statusOptions}</select>
        </div>
        <div class="field">
          <label class="field-label">Valor total (R$)</label>
          <input class="input" name="total_value" type="number" step="0.01" min="0" value="${initial.total_value ?? ''}" placeholder="0,00">
        </div>
        <div class="field">
          <label class="field-label">KM no serviço</label>
          <input class="input" name="km_at_service" type="number" min="0" max="99999999" value="${initial.km_at_service ?? ''}">
        </div>
        <div class="field">
          <label class="field-label">Responsável <span class="req">*</span></label>
          <input class="input" name="responsible_name" required value="${esc(initial.responsible_name || '')}">
        </div>
        <div class="field col-full">
          <label class="field-label">Descrição do serviço <span class="req">*</span></label>
          <textarea class="textarea" name="description" rows="3" required minlength="3">${esc(initial.description || '')}</textarea>
        </div>
        ${needReason ? `
        <div class="field col-full">
          <label class="field-label">Justificativa do registro manual <span class="req">*</span></label>
          <textarea class="textarea" name="manual_reason" rows="2" required minlength="${MIN_REASON}" placeholder="Por que este serviço não teve ordem de serviço?">${esc(initial.manual_reason || '')}</textarea>
          <div class="field-help">Mostrada na lista e no Excel. Mínimo de ${MIN_REASON} caracteres.</div>
        </div>` : ''}
        <div class="field col-full">
          <label class="field-label">Observações</label>
          <textarea class="textarea" name="notes" rows="2">${esc(initial.notes || '')}</textarea>
        </div>
      </div>
      <div id="man-errors" class="login-error" style="display:none;margin-top:12px"></div>
    </form>
  `;
  const footer = `
    <button class="btn btn-outline" data-cancel>Cancelar</button>
    <button class="btn btn-primary" id="man-save-btn">${editing ? 'Salvar alterações' : (isLinked ? 'Concluir manutenção' : 'Registrar manutenção')}</button>
  `;
  const m = openModal({
    title: editing ? 'Editar manutenção' : (isLinked ? 'Concluir manutenção' : 'Registrar manutenção'),
    body, footer, size: 'lg',
  });
  // Filtro por secretaria do veículo (só quando não é linked à autorização)
  const vehSel = m.querySelector('#man-veh');
  const supSel = m.querySelector('#man-sup');
  function rebuildSupplierOptions(preserveId = '') {
    if (isLinked) return;
    const veh = _vehicles.find(x => x.id === vehSel.value);
    const vehDept = veh?.department_id || null;
    const pool = vehDept
      ? _suppliers.filter(s => !s.department_id || s.department_id === vehDept)
      : _suppliers;
    const currentSel = preserveId || supSel.value;
    const keep = pool.find(s => s.id === currentSel) ? currentSel : '';
    const placeholder = vehDept
      ? '<option value="">— Selecione —</option>'
      : '<option value="">— Selecione o veículo primeiro —</option>';
    supSel.innerHTML = placeholder + pool
      .map(s => `<option value="${s.id}" ${s.id === keep ? 'selected' : ''}>${esc(supplierOptionLabel(s))}</option>`)
      .join('');
    if (!pool.length && vehDept) {
      supSel.innerHTML = '<option value="">Nenhuma mecânica cadastrada nesta secretaria</option>';
    }
  }
  vehSel.addEventListener('change', () => rebuildSupplierOptions());
  rebuildSupplierOptions(initial.supplier_id || '');

  m.querySelector('[data-cancel]').addEventListener('click', closeModal);
  m.querySelector('#man-save-btn').addEventListener('click', () => saveMan(id, initial, needReason));
}

async function saveMan(id, initial, needReason) {
  const form = document.getElementById('man-form');
  const errBox = document.getElementById('man-errors');
  errBox.style.display = 'none';
  if (!form.checkValidity()) { form.reportValidity(); return; }
  const v = formValues(form);
  const vehicle_id = v.vehicle_id || v.vehicle_id_h || initial.vehicle_id;
  const supplier_id = v.supplier_id || v.supplier_id_h || initial.supplier_id;
  if (!vehicle_id || !supplier_id) {
    errBox.innerHTML = '⚠️ Selecione veículo e mecânica.'; errBox.style.display = 'block'; return;
  }
  const reason = (v.manual_reason || '').trim();
  if (needReason && reason.length < MIN_REASON) {
    errBox.innerHTML = `⚠️ Informe a justificativa do registro manual (mínimo de ${MIN_REASON} caracteres).`; errBox.style.display = 'block'; return;
  }
  const payload = {
    authorization_id: initial?.authorization_id || null,
    vehicle_id, supplier_id,
    kind: v.kind,
    status: v.status,
    open_date: v.open_date,
    close_date: v.close_date || null,
    km_at_service: v.km_at_service ? Number(v.km_at_service) : null,
    description: v.description,
    total_value: v.total_value ? Number(v.total_value) : null,
    responsible_name: v.responsible_name,
    notes: v.notes || null,
  };
  if (needReason) payload.manual_reason = reason;
  const btn = document.getElementById('man-save-btn');
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Salvando...';
  try {
    let error;
    if (id) ({ error } = await supabase.from('maintenance').update(payload).eq('id', id));
    else    ({ error } = await supabase.from('maintenance').insert(payload));
    if (error) throw error;
    toast(id ? 'Manutenção atualizada.' : 'Manutenção registrada.', 'success');
    closeModal();
    await reload();
  } catch (err) {
    errBox.innerHTML = '⚠️ ' + billingError(err);
    errBox.style.display = 'block';
    btn.disabled = false; btn.textContent = id ? 'Salvar alterações' : 'Registrar manutenção';
  }
}

async function deleteMan(id) {
  const a = _items.find(x => x.id === id);
  if (!a) return;
  const term = activeTermOf(a);
  if (term) {
    toast(`Esta manutenção tem Termo de Recebimento nº ${term.number}. Para alterar, cancele o termo na lista de Ordens de Serviço.`, 'warning', 7000);
    return;
  }
  const linked = a.authorization ? ` (vinculada à ${a.authorization.os_number ? 'OS nº ' + a.authorization.os_number : 'autorização ' + a.authorization.number})` : '';
  const ok = await confirmDialog({
    title: 'Excluir manutenção',
    message: `Excluir esta manutenção${linked}? Se for a única do vínculo, a ordem volta para "Emitida".`,
    confirmText: 'Excluir', danger: true,
  });
  if (!ok) return;
  const { error } = await supabase.from('maintenance').delete().eq('id', id);
  if (error) { toast(billingError(error), 'error'); return; }
  toast('Manutenção excluída.', 'success');
  await reload();
}

// =============================================================================
// EXCEL (respeita os filtros)
// =============================================================================
function exportExcel() {
  const list = applyFilters();
  if (!list.length) { toast('Nenhuma manutenção para exportar com os filtros atuais.', 'warning'); return; }
  const columns = [
    'Abertura', 'Conclusão', 'Placa', 'Modelo', 'Secretaria', 'Categoria', 'Status', 'Serviço',
    'Mecânica', 'CNPJ', 'Valor (R$)', 'KM', 'Responsável', 'Origem', 'Nº da OS', 'Código da autorização',
    'Justificativa (manual)', 'Termo nº', 'Data do termo', 'Notas fiscais', 'Valor das notas (R$)', 'Fiscal do contrato', 'Observações',
  ];
  const rows = list.map(a => {
    const veh = _vehicles.find(x => x.id === a.vehicle_id);
    const sup = _suppliers.find(x => x.id === a.supplier_id);
    const term = termOf(a);
    const inv = term ? (_invoices.get(term.id) || []) : [];
    return [
      a.open_date || '', a.close_date || '',
      formatPlate(veh?.plate || ''), veh?.model || '', veh?.department?.acronym || '',
      KIND_LABEL[a.kind] || a.kind, STATUS_LABEL[a.status] || a.status, a.description || '',
      sup?.trade_name || sup?.legal_name || '', sup?.cnpj || '',
      a.total_value != null ? Number(a.total_value) : '', a.km_at_service != null ? Number(a.km_at_service) : '',
      a.responsible_name || '',
      isManual(a) ? 'Manual' : (a.authorization?.os_number ? 'Ordem de serviço' : 'Autorização'),
      a.authorization?.os_number || '', a.authorization?.number || '',
      a.manual_reason || '',
      term ? term.number + (term.status !== 'emitido' ? ' (cancelado)' : '') : '', term?.issue_date || '',
      inv.map(i => `${i.invoice_number}${i.supplier_name ? ' (' + i.supplier_name + ')' : ''}`).join('; '),
      term ? Number(term.total_amount || 0) : '',
      term?.fiscal_name || '',
      a.notes || '',
    ];
  });
  try {
    exportXLSX({ filename: timestampFilename('manutencoes'), sheetName: 'Manutenções', columns, rows });
    toast(`${rows.length} manutenção(ões) exportada(s).`, 'success');
  } catch (e) {
    toast('Falha ao exportar: ' + (e.message || e), 'error');
  }
}
