// Hash router: #/raids/12?tab=loot → { path: '/raids/12', query: { tab: 'loot' } }.
// Routes come from pages/index.js ({ path: '/raids/:id', ... }); main.js registers them with setRoutes().
//
//   navigate('/raids/12');               navigate('/welcome', { replace: true });
//   const { path, params, query, route } = useRoute();
//   html`<${Link} href="/roster">Roster<//>`
import { html } from './html.js';
import { gc } from './gc.js';
import { createStore, useStore } from './store.js';

// ---------- pure helpers (no DOM) ----------

export function normalizePath(p) {
  let path = String(p || '/').trim();
  if (!path.startsWith('/')) path = `/${path}`;
  path = path.replace(/\/{2,}/g, '/');
  if (path.length > 1) path = path.replace(/\/+$/, '');
  return path;
}

// "/raids/12?tab=loot" → { path: '/raids/12', query: { tab: 'loot' }, href: '/raids/12?tab=loot' }
export function parseHref(href) {
  const raw = String(href || '').replace(/^#/, '') || '/';
  const qi = raw.indexOf('?');
  const path = normalizePath(qi >= 0 ? raw.slice(0, qi) : raw);
  const search = qi >= 0 ? raw.slice(qi + 1) : '';
  const query = {};
  for (const [k, v] of new URLSearchParams(search)) query[k] = v;
  return { path, query, href: path + (search ? `?${search}` : '') };
}

const compiled = new Map();
function compile(pattern) {
  let c = compiled.get(pattern);
  if (!c) {
    const names = [];
    const re = normalizePath(pattern).split('/').map((seg) => {
      if (seg === '*') { names.push('rest'); return '(.*)'; }
      if (seg.startsWith(':')) { names.push(seg.slice(1)); return '([^/]+)'; }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }).join('/');
    c = { re: new RegExp(`^${re}$`), names };
    compiled.set(pattern, c);
  }
  return c;
}

// matchPath('/raids/:id', '/raids/12') → { id: '12' } | null
export function matchPath(pattern, path) {
  const { re, names } = compile(pattern);
  const m = re.exec(normalizePath(path));
  if (!m) return null;
  const params = {};
  names.forEach((n, i) => {
    try { params[n] = decodeURIComponent(m[i + 1]); } catch { params[n] = m[i + 1]; }
  });
  return params;
}

// First matching route wins; static routes should be listed before param routes that could shadow them.
export function findRoute(routes, path) {
  for (const route of routes) {
    const params = matchPath(route.path, path);
    if (params) return { route, params };
  }
  return null;
}

// buildPath('/raids/:id', { id: 12 }, { tab: 'loot' }) → "/raids/12?tab=loot"
export function buildPath(pattern, params = {}, query) {
  const path = normalizePath(pattern).replace(/:([A-Za-z_]\w*)/g, (_, n) => encodeURIComponent(params[n] ?? ''));
  return path + toSearch(query);
}

export function toSearch(query) {
  if (!query) return '';
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : '';
}

// Is `href` the current page (for nav highlighting)? '/' only matches exactly; '/raids' also matches '/raids/12'.
export function isActivePath(current, href, exact = false) {
  const target = parseHref(href).path;
  if (exact || target === '/') return current === target;
  return current === target || current.startsWith(`${target}/`);
}

// ---------- live location ----------

const hasWindow = typeof window !== 'undefined';
export const locationStore = createStore(hasWindow ? parseHref(window.location.hash) : parseHref('/'));
let routeTable = [];

export function setRoutes(routes) { routeTable = routes || []; }
export function getRoutes() { return routeTable; }

function sync() { locationStore.set((prev) => { const next = parseHref(window.location.hash); return next.href === prev.href ? prev : next; }); }
if (hasWindow) window.addEventListener('hashchange', sync);

export function currentLocation() { return locationStore.get(); }

export function navigate(to, { replace = false } = {}) {
  const { href } = parseHref(to);
  if (!hasWindow) return;
  if (replace) {
    window.history.replaceState(window.history.state, '', `#${href}`);
    sync();
  } else if (`#${href}` !== window.location.hash) {
    window.location.hash = href; // fires hashchange → sync()
  }
}

// Changes some query parameters of the current page (default: without adding a history entry).
export function setQuery(patch, { replace = true } = {}) {
  const loc = locationStore.get();
  const query = { ...loc.query, ...patch };
  navigate(loc.path + toSearch(query), { replace });
}

export function back(fallback = '/') {
  if (hasWindow && window.history.length > 1) window.history.back();
  else navigate(fallback);
}

// The main process asks for a route (notification clicks, guildcamp:// links).
gc.on('navigate', (route) => {
  if (typeof route === 'string') navigate(route);
  else if (route && typeof route.route === 'string') navigate(route.route);
});

export function useLocation() { return useStore(locationStore); }

export function useRoute() {
  const loc = useLocation();
  const found = findRoute(routeTable, loc.path);
  return { ...loc, params: found ? found.params : {}, route: found ? found.route : null };
}

// ---------- Link ----------

const EXTERNAL = /^(?:https?:|mailto:)/i;

export function Link({ href = '/', class: cls, className, activeClass = 'is-active', exact = false, children, ...rest }) {
  const loc = useLocation();
  if (EXTERNAL.test(href)) {
    // Opened in the system browser by the main process (setWindowOpenHandler).
    return html`<a href=${href} target="_blank" rel="noopener noreferrer" class=${[cls, className].filter(Boolean).join(' ') || undefined} ...${rest}>${children}</a>`;
  }
  const active = isActivePath(loc.path, href, exact);
  const classes = [cls, className, active && activeClass].filter(Boolean).join(' ') || undefined;
  return html`<a href=${`#${parseHref(href).href}`} class=${classes} aria-current=${active ? 'page' : undefined} ...${rest}>${children}</a>`;
}
