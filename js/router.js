// Hash router simples. Rotas registradas via register(path, fn).
// path = '/dashboard'. Hash final = '#/dashboard'.

const routes = new Map();
let _current = null;
let _onChange = null;

export function register(path, handler, meta = {}) {
  routes.set(path, { handler, meta });
}

export function setOnChange(fn) { _onChange = fn; }

export function currentPath() {
  const h = location.hash || '#/';
  const p = h.startsWith('#') ? h.slice(1) : h;
  return p.split('?')[0];
}

/** Parâmetros depois de "?" no hash (ex.: #/autorizacoes?tab=service → { tab: 'service' }). */
export function currentQuery() {
  const h = location.hash || '';
  const i = h.indexOf('?');
  return i === -1 ? {} : Object.fromEntries(new URLSearchParams(h.slice(i + 1)));
}

export function navigate(path, replace = false) {
  const h = '#' + (path.startsWith('/') ? path : '/' + path);
  if (replace) location.replace(h);
  else location.hash = h;
}

let _started = false;
export function start() {
  if (!_started) {
    window.addEventListener('hashchange', resolve);
    _started = true;
  }
  resolve();
}

async function resolve() {
  const path = currentPath();
  const route = routes.get(path) || routes.get('*');
  if (!route) return;
  _current = { path, ...route };
  _onChange && _onChange(_current);
  try {
    await route.handler({ path, meta: route.meta });
  } catch (e) {
    console.error('Route handler error', e);
  }
}

export function getCurrent() { return _current; }
