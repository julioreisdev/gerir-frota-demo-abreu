// Páginas do aplicativo (tablet e celular): Início, Cadastros, Análise e Perfil,
// uma por aba fixa do rodapé. Cada uma mostra blocos para as páginas que o
// perfil pode abrir. No computador as rotas também abrem (grade de blocos),
// mas a entrada é o Dashboard.
import { pageRoot, NAV, TABS, getEntity, tabPages, canAccess, logoutFlow, userInitials, ROLE_LABEL } from '../shell.js';
import { getProfile } from '../auth.js';
import { icons } from '../icons.js';
import { esc } from '../ui.js';
import { supabase } from '../supabase.js';
import { localToday, monthRange, fmtInt } from '../billing.js';
import { install, onInstallStateChange } from '../pwa.js';

const SUBTITLE = {
  '/dashboard': 'Indicadores e alertas',
  '/entidade': 'Dados da instituição',
  '/usuarios': 'Acessos e perfis',
  '/secretarias': 'Unidades gestoras',
  '/veiculos': 'Frota cadastrada',
  '/motoristas': 'CNH e cursos',
  '/fornecedores': 'Postos e mecânicas',
  '/autorizacoes': 'Emitir e consultar',
  '/abastecimentos': 'Registrar consumo',
  '/manutencoes': 'Serviços e oficinas',
  '/faturamento': 'Ordens e termos',
  '/relatorios': 'Análises e totais',
  '/exportacao': 'Arquivos do TCE-PI',
};
const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
}

function tilesHTML(items) {
  if (!items.length) return '';
  return `
    <div class="home-tiles">
      ${items.map(i => `
        <a href="#${i.path}" class="home-tile">
          <span class="home-tile-icon">${icons[i.icon] || ''}</span>
          <span class="home-tile-label">${esc(i.label)}</span>
          <span class="home-tile-sub">${esc(SUBTITLE[i.path] || '')}</span>
        </a>`).join('')}
    </div>`;
}

/** Página de blocos de uma aba (Cadastros, Análise). */
function renderTabPage(tab) {
  const role = getProfile()?.role || 'usuario';
  const t = TABS.find(x => x.path === tab);
  pageRoot().innerHTML = `
    <div class="home">
      <header class="home-head">
        <div class="home-greeting">${esc(t?.label || '')}</div>
      </header>
      ${tilesHTML(tabPages(tab, role))}
    </div>`;
}
export async function renderCadastros() { renderTabPage('/cadastros'); }
export async function renderAnalise() { renderTabPage('/analise'); }

// =============================================================================
// INÍCIO: Operação + números do mês
// =============================================================================
export async function renderInicio() {
  const profile = getProfile();
  const role = profile?.role || 'usuario';
  const firstName = (profile?.full_name || '').trim().split(/\s+/)[0] || 'Olá';
  const entity = await getEntity().catch(() => null);
  const operation = tabPages('/inicio', role);
  const showStats = canAccess('/abastecimentos', role);
  const now = new Date();
  const monthLabel = `${MONTHS[now.getMonth()]} de ${now.getFullYear()}`;

  pageRoot().innerHTML = `
    <div class="home">
      <header class="home-head home-head-user">
        <div style="min-width:0">
          <div class="home-greeting">${esc(greeting())}, ${esc(firstName)}</div>
          ${entity ? `<div class="home-entity">${esc(entity.organ_name)}</div>` : ''}
        </div>
        <a href="#/perfil" class="user-avatar home-avatar" aria-label="Perfil">${esc(userInitials(profile?.full_name))}</a>
      </header>
      <h2 class="home-group">Operação</h2>
      ${tilesHTML(operation)}
      ${showStats ? `
      <h2 class="home-group">${esc(monthLabel)}</h2>
      <div class="home-stats" id="home-stats">
        <div class="home-stat"><span>Veículos cadastrados</span><strong>…</strong></div>
        <div class="home-stat"><span>Ativos no mês</span><strong>…</strong></div>
        <div class="home-stat"><span>Abastecimentos no mês</span><strong>…</strong></div>
      </div>
      ${canAccess('/dashboard', role) ? `<a href="#/dashboard" class="home-link">Ver dashboard ${icons.chevronRight}</a>` : ''}` : ''}
    </div>`;

  if (showStats) loadStats();
}

/** Três números do mês (decisão C4), com tolerância a erro: número vira "—". */
async function loadStats() {
  const { start, end } = monthRange(localToday());
  const [v, f, m] = await Promise.all([
    supabase.from('vehicle').select('id', { count: 'exact', head: true }).is('deleted_at', null),
    supabase.from('fueling').select('vehicle_id').is('deleted_at', null).gte('date', start).lte('date', end),
    supabase.from('maintenance').select('vehicle_id').is('deleted_at', null).gte('open_date', start).lte('open_date', end),
  ]);
  const box = document.getElementById('home-stats');
  if (!box) return;
  const vehicles = v.error ? null : v.count;
  const fuelings = f.error ? null : (f.data || []).length;
  const active = (f.error && m.error) ? null
    : new Set([...(f.data || []), ...(m.data || [])].map(r => r.vehicle_id).filter(Boolean)).size;
  const show = (n) => (n == null ? '—' : fmtInt(n));
  const cells = box.querySelectorAll('strong');
  cells[0].textContent = show(vehicles);
  cells[1].textContent = show(active);
  cells[2].textContent = show(fuelings);
}

// =============================================================================
// PERFIL: usuário, Instalar e Sair
// =============================================================================
export async function renderPerfil() {
  const profile = getProfile();
  const entity = await getEntity().catch(() => null);
  const name = profile?.full_name || 'Usuário';
  pageRoot().innerHTML = `
    <div class="home">
      <header class="home-head"><div class="home-greeting">Perfil</div></header>
      <div class="card profile-card">
        <div class="user-avatar profile-avatar">${esc(userInitials(name))}</div>
        <div class="profile-name">${esc(name)}</div>
        <div class="profile-meta">
          <span>${esc(ROLE_LABEL[profile?.role] || profile?.role || '')}</span>
          ${profile?.username ? `<span>· ${esc(profile.username)}</span>` : ''}
        </div>
        ${entity ? `<div class="profile-entity">${esc(entity.organ_name)}</div>` : ''}
        <div class="profile-actions">
          <button type="button" class="btn btn-outline" id="profile-install" hidden>${icons.download}<span>Instalar aplicativo</span></button>
          <button type="button" class="btn btn-outline profile-logout" id="profile-logout">${icons.logout}<span>Sair</span></button>
        </div>
      </div>
    </div>`;
  const installBtn = document.getElementById('profile-install');
  const off = onInstallStateChange((ok) => {
    if (!installBtn.isConnected) { off(); return; }
    installBtn.hidden = !ok;
  });
  installBtn.addEventListener('click', () => install());
  document.getElementById('profile-logout').addEventListener('click', logoutFlow);
}
