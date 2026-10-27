// Shell autenticado: sidebar + topbar + breadcrumb + area de conteúdo.
import { icons, iconSpan } from './icons.js';
import { logout, getProfile } from './auth.js';
import { APP_NAME } from './config.js';
import { navigate, currentPath } from './router.js';
import { esc, confirmDialog } from './ui.js';
import { supabase } from './supabase.js';
import { canInstall, install, onInstallStateChange } from './pwa.js';

const APP_ICON = 'assets/icons/icon-192.png';

/** Tablet e celular (≤ 1024px): sem sidebar; abas fixas no rodapé e página Início. */
export const MOBILE_MAX = 1024;
export const isMobile = () => window.matchMedia(`(max-width: ${MOBILE_MAX}px)`).matches;

// Catálogo de páginas — único lugar onde definir nav + permissões + breadcrumb
export const NAV = [
  { path: '/dashboard',      label: 'Dashboard',        icon: 'dashboard',  roles: ['admin','usuario'] },
  { group: 'Cadastros' },
  { path: '/entidade',       label: 'Entidade',         icon: 'shield',     roles: ['admin','usuario'] },
  { path: '/usuarios',       label: 'Usuários',         icon: 'users',      roles: ['admin'] },
  { path: '/secretarias',    label: 'Secretarias',      icon: 'briefcase',  roles: ['admin'] },
  { path: '/veiculos',       label: 'Veículos',         icon: 'car',        roles: ['admin','usuario'] },
  { path: '/motoristas',     label: 'Motoristas',       icon: 'idCard',     roles: ['admin','usuario'] },
  { path: '/fornecedores',   label: 'Fornecedores',     icon: 'store',      roles: ['admin','usuario'] },
  { group: 'Operação' },
  { path: '/autorizacoes',   label: 'Autorizações',     icon: 'clipboard',  roles: ['admin','usuario','fornecedor'] },
  { path: '/abastecimentos', label: 'Abastecimentos',   icon: 'droplet',    roles: ['admin','usuario'] },
  { path: '/manutencoes',    label: 'Manutenções',      icon: 'wrench',     roles: ['admin','usuario'] },
  { path: '/faturamento',    label: 'Faturamento',      icon: 'receipt',    roles: ['admin','usuario','fornecedor','faturamento'] },
  { group: 'Análise' },
  { path: '/relatorios',     label: 'Relatórios',       icon: 'barChart',   roles: ['admin','usuario'] },
  { path: '/exportacao',     label: 'Exportação TCE',   icon: 'download',   roles: ['admin','usuario'] },
];

// Abas fixas do aplicativo (tablet e celular), iguais para todos os perfis.
// Cada aba é uma página de blocos; a aba só aparece se tiver algum bloco para o perfil.
export const TABS = [
  { path: '/inicio',    label: 'Início',    icon: 'home' },
  { path: '/cadastros', label: 'Cadastros', icon: 'folder' },
  { path: '/analise',   label: 'Análise',   icon: 'barChart' },
  { path: '/perfil',    label: 'Perfil',    icon: 'user' },
];
export const ROLE_LABEL = { admin: 'Administrador', usuario: 'Usuário', fornecedor: 'Fornecedor', faturamento: 'Faturamento' };

/** Itens de um grupo do menu (o Dashboard, fora de grupo, conta como Análise). */
function groupPages(group) {
  const out = [];
  let cur = null;
  NAV.forEach(i => {
    if (i.group) { cur = i.group; return; }
    const g = cur || 'Análise';
    if (g === group) out.push(i);
  });
  return out;
}
const TAB_GROUP = { '/inicio': 'Operação', '/cadastros': 'Cadastros', '/analise': 'Análise' };

/** Páginas que o perfil pode abrir (sem o Início). */
export function pagesForRole(role) {
  return NAV.filter(i => i.path && i.roles.includes(role));
}
/** Blocos de uma aba para o perfil (Início → Operação; Análise inclui o Dashboard). */
export function tabPages(tab, role) {
  const g = TAB_GROUP[tab];
  return g ? groupPages(g).filter(i => i.roles.includes(role)) : [];
}
/** Aba ativa para uma rota: páginas de Operação ficam no Início. */
export function activeTab(path) {
  if (TABS.some(t => t.path === path)) return path;
  for (const tab of Object.keys(TAB_GROUP)) {
    if (groupPages(TAB_GROUP[tab]).some(i => i.path === path)) return tab;
  }
  return '/inicio';
}
/** O perfil pode abrir esta rota? */
export function canAccess(path, role) {
  if (path === '/inicio' || path === '/perfil') return true;
  if (path === '/cadastros' || path === '/analise') return tabPages(path, role).length > 0;
  return NAV.some(i => i.path === path && i.roles.includes(role));
}
/** Rota de entrada: celular → Início; computador → Dashboard (faturamento → Faturamento). */
export function defaultPath(role) {
  if (isMobile()) return '/inicio';
  return canAccess('/dashboard', role) ? '/dashboard' : (pagesForRole(role)[0]?.path || '/inicio');
}

// Breadcrumb por rota
const BREADCRUMB = {
  '/inicio':         [{ label: 'Início' }],
  '/cadastros':      [{ label: 'Cadastros' }],
  '/analise':        [{ label: 'Análise' }],
  '/perfil':         [{ label: 'Perfil' }],
  '/dashboard':      [{ label: 'Dashboard' }],
  '/entidade':       [{ label: 'Cadastros' }, { label: 'Entidade' }],
  '/usuarios':       [{ label: 'Cadastros' }, { label: 'Usuários' }],
  '/secretarias':    [{ label: 'Cadastros' }, { label: 'Secretarias' }],
  '/veiculos':       [{ label: 'Cadastros' }, { label: 'Veículos' }],
  '/motoristas':     [{ label: 'Cadastros' }, { label: 'Motoristas' }],
  '/fornecedores':   [{ label: 'Cadastros' }, { label: 'Fornecedores' }],
  '/autorizacoes':   [{ label: 'Operação' }, { label: 'Autorizações' }],
  '/abastecimentos': [{ label: 'Operação' }, { label: 'Abastecimentos' }],
  '/manutencoes':    [{ label: 'Operação' }, { label: 'Manutenções' }],
  '/faturamento':    [{ label: 'Operação' }, { label: 'Faturamento' }],
  '/relatorios':     [{ label: 'Análise' }, { label: 'Relatórios' }],
  '/exportacao':     [{ label: 'Análise' }, { label: 'Exportação TCE' }],
};

let _entityCache = null;

export async function getEntity() {
  if (_entityCache) return _entityCache;
  // Query com a coluna nova. Se o SQL ainda não foi aplicado no banco
  // (coluna use_logo_in_reports inexistente), o Supabase retorna 400.
  // Fallback pra query sem essa coluna → app continua funcionando; a flag
  // fica implícita como true (default do schema).
  const withNew = await supabase
    .from('entity')
    .select('id, entity_type, ibge_code, organ_name, coat_of_arms_url, default_ref_month, use_logo_in_reports')
    .maybeSingle();
  if (!withNew.error) {
    _entityCache = withNew.data;
    return withNew.data;
  }
  const legacy = await supabase
    .from('entity')
    .select('id, entity_type, ibge_code, organ_name, coat_of_arms_url, default_ref_month')
    .maybeSingle();
  _entityCache = legacy.data ? { ...legacy.data, use_logo_in_reports: true } : null;
  return _entityCache;
}

/** Força reload da entidade (usar após update de flag/logo). */
export function invalidateEntityCache() { _entityCache = null; }

/** Retorna a URL de logo pra usar nos relatórios PDF.
 *  Se a entidade tem brasão e a flag "usar logo da instituição" está ativa,
 *  usa o brasão. Caso contrário, cai pra logo do Gerir Frota (local).
 */
export function reportLogoUrl(entity) {
  const fallback = new URL('logo.png', location.href).href;
  const useCoat = entity?.use_logo_in_reports !== false; // default true
  if (useCoat && entity?.coat_of_arms_url) return entity.coat_of_arms_url;
  return fallback;
}

export function userInitials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] || '') + (parts[parts.length - 1]?.[0] || '')).toUpperCase();
}

export async function renderShell() {
  const root = document.getElementById('app-root');
  const profile = getProfile();
  const entity = await getEntity();

  const userName = profile?.full_name || 'Usuário';
  const userRole = profile?.role || '';
  const allowedRoles = profile?.role || 'admin';

  const navItems = NAV.map((item, idx) => {
    if (item.group) {
      // só renderiza o grupo se houver pelo menos 1 item visível pra esse perfil abaixo dele
      const next = NAV.slice(idx + 1);
      const end = next.findIndex(i => i.group);
      const inGroup = end === -1 ? next : next.slice(0, end);
      if (!inGroup.some(i => i.roles.includes(allowedRoles))) return '';
      return `<div class="nav-group-label">${esc(item.group)}</div>`;
    }
    if (!item.roles.includes(allowedRoles)) return '';
    return `
      <a href="#${item.path}" class="nav-item" data-path="${item.path}">
        ${iconSpan(item.icon)}
        <span>${esc(item.label)}</span>
      </a>`;
  }).join('');

  // Em tamanho pequeno entra o símbolo (ícone do app); a logo completa fica no login e nos impressos
  const logoHTML = `<img src="${APP_ICON}" alt="${esc(APP_NAME)}">`;

  // Abas fixas (tablet e celular): só as que têm bloco para o perfil
  const bottomNavHTML = `
    <nav class="bottom-nav" id="bottom-nav" aria-label="Navegação">
      ${TABS.filter(t => canAccess(t.path, allowedRoles)).map(t => `
        <a href="#${t.path}" class="bn-item" data-tab="${t.path}">
          ${iconSpan(t.icon, 'bn-icon')}<span>${esc(t.label)}</span>
        </a>`).join('')}
    </nav>`;

  root.innerHTML = `
    <div class="app" id="app-shell">
      <aside class="sidebar" id="sidebar">
        <div class="sidebar-header">
          <div class="sidebar-logo">${logoHTML}</div>
          <div style="min-width:0">
            <div class="sidebar-title">${esc(APP_NAME)}</div>
            ${entity ? `<div class="sidebar-subtitle">${esc(entity.organ_name)}</div>` : ''}
          </div>
        </div>
        <nav class="sidebar-nav" id="sidebar-nav">${navItems}</nav>
        <div class="sidebar-footer">
          <div class="sidebar-user">
            <div class="user-avatar">${esc(userInitials(userName))}</div>
            <div class="user-info">
              <div class="user-name">${esc(userName)}</div>
              <div class="user-role">${esc(userRole)}</div>
            </div>
          </div>
          <button class="logout-btn" id="logout-btn" title="Sair">${icons.logout}</button>
        </div>
      </aside>
      <div class="sidebar-overlay" id="sidebar-overlay"></div>
      <div class="main">
        <header class="topbar">
          <button class="topbar-toggle" id="topbar-toggle" aria-label="Menu">${icons.menu}</button>
          <a href="#/inicio" class="topbar-brand" aria-label="Início">
            <img src="${APP_ICON}" alt="">
            <span>${esc(APP_NAME)}</span>
          </a>
          <div class="breadcrumb" id="breadcrumb"></div>
          <button class="topbar-install" id="topbar-install" hidden aria-label="Instalar aplicativo">
            ${icons.download}
            <span>Instalar app</span>
          </button>
          <img class="topbar-logo" src="${APP_ICON}" alt="${esc(APP_NAME)}">
        </header>
        <main class="page" id="page-content">
          <div class="card">
            <div class="skeleton skeleton-line w-40"></div>
            <div class="skeleton skeleton-line w-60" style="margin-top:8px"></div>
            <div class="skeleton skeleton-line w-80" style="margin-top:8px"></div>
          </div>
        </main>
        ${bottomNavHTML}
      </div>
    </div>
  `;

  setupShellEvents();
  updateBreadcrumb(currentPath());
  updateActiveNav(currentPath());
}

function setupShellEvents() {
  const shell = document.getElementById('app-shell');
  const toggle = document.getElementById('topbar-toggle');
  const overlay = document.getElementById('sidebar-overlay');
  const logoutBtn = document.getElementById('logout-btn');
  const installBtn = document.getElementById('topbar-install');

  // Botão Instalar: aparece quando PWA é elegível, dispara prompt nativo
  // (Chrome/Edge/Android) ou instruções iOS Safari.
  if (installBtn) {
    installBtn.addEventListener('click', () => install());
    onInstallStateChange((ok) => {
      installBtn.hidden = !ok;
    });
  }

  toggle?.addEventListener('click', () => {
    // Mobile: abre/fecha drawer. Desktop: colapsa/expande.
    if (window.innerWidth <= MOBILE_MAX) {
      shell.classList.toggle('sidebar-open');
    } else {
      shell.classList.toggle('sidebar-collapsed');
    }
  });

  overlay?.addEventListener('click', () => shell.classList.remove('sidebar-open'));

  // fecha drawer ao navegar no mobile
  document.getElementById('sidebar-nav')?.addEventListener('click', () => {
    if (window.innerWidth <= MOBILE_MAX) shell.classList.remove('sidebar-open');
  });

  logoutBtn?.addEventListener('click', logoutFlow);
}

/** Confirma e encerra a sessão (menu lateral e aba Perfil). */
export async function logoutFlow() {
  const ok = await confirmDialog({
    title: 'Sair do sistema',
    message: 'Deseja realmente encerrar sua sessão?',
    confirmText: 'Sair',
  });
  if (!ok) return;
  try { await logout(); } catch (e) { console.warn('logout', e); }
  // limpeza paranoica de qualquer storage residual do Supabase
  try {
    Object.keys(localStorage).forEach(k => {
      if (k.startsWith('sb-') || k.includes('supabase')) localStorage.removeItem(k);
    });
  } catch {}
  // remove hash sem disparar router, recarrega limpo → boot vê sessão nula
  history.replaceState(null, '', window.location.pathname + window.location.search);
  window.location.reload();
}

export function updateActiveNav(path) {
  document.querySelectorAll('#sidebar-nav .nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.path === path);
  });
  // Abas fixas: a página de Operação aberta a partir do Início mantém o Início ativo
  const tab = activeTab(path);
  document.querySelectorAll('#bottom-nav .bn-item').forEach(el => {
    el.classList.toggle('active', el.dataset.tab === tab);
  });
}

export function updateBreadcrumb(path) {
  const el = document.getElementById('breadcrumb');
  if (!el) return;
  const crumbs = BREADCRUMB[path];
  if (!crumbs) { el.innerHTML = ''; return; }
  const parts = [
    `<a href="#/dashboard">${esc(APP_NAME)}</a>`,
    ...crumbs.map((c, i) => {
      const sep = `<span class="crumb-sep">${icons.chevronRight}</span>`;
      const isLast = i === crumbs.length - 1;
      const text = isLast
        ? `<span class="crumb-current">${esc(c.label)}</span>`
        : `<span>${esc(c.label)}</span>`;
      return sep + text;
    }),
  ];
  el.innerHTML = parts.join('');
}

export function pageRoot() {
  return document.getElementById('page-content');
}

/** Renderiza um cabeçalho de página padrão (título + ações opcionais) */
export function pageHeader({ title, subtitle, actionsHtml = '' }) {
  return `
    <div class="page-header">
      <div>
        <h1 class="page-title">${esc(title)}</h1>
        ${subtitle ? `<p class="page-subtitle">${esc(subtitle)}</p>` : ''}
      </div>
      ${actionsHtml ? `<div class="page-actions">${actionsHtml}</div>` : ''}
    </div>
  `;
}
