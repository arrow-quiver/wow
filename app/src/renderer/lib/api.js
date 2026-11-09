// Server calls. The renderer never talks to the server itself: every call goes through IPC (api.request) and
// the main process adds the device token. Errors reject with { message, status }.
//
//   const raids = useApi('/api/raids', { refreshOn: ['raid'] });
//   if (raids.loading) ...; if (raids.error) ...; raids.data
//   await api.post('/api/raids', { title });
import { gc } from './gc.js';
import { useState, useEffect, useRef, useCallback } from './html.js';
import { toast } from './toast.js';
import { refreshSession } from './session.js';

// A 403 can mean an officer lost (or gained) a rank since the app loaded its profile. Reload the profile
// once so the nav and the officer pages catch up; the failed call itself is not retried. At most one
// reload per ROLE_CHECK_GAP_MS, however many calls fail together.
export const ROLE_CHECK_GAP_MS = 10000;
let lastRoleCheck = -Infinity;
export function recheckRoleAfter(err, now = Date.now()) {
  if (!err || err.status !== 403) return false;
  if (now - lastRoleCheck < ROLE_CHECK_GAP_MS) return false;
  lastRoleCheck = now;
  refreshSession({ fromServer: true }).catch(() => { /* the session stays as it was */ });
  return true;
}

function call(method, path, body) {
  return gc.api.request(method, path, body).catch((err) => {
    recheckRoleAfter(err);
    throw err;
  });
}

export const api = {
  request: (method, path, body) => call(method, path, body),
  get: (path) => call('GET', path),
  post: (path, body) => call('POST', path, body ?? {}),
  put: (path, body) => call('PUT', path, body ?? {}),
  del: (path, body) => call('DELETE', path, body),
};

// Builds a query string, skipping empty values: qs({ q: 'ore', page: 2, x: '' }) → "?q=ore&page=2".
export function qs(params) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === '' || v === false) continue;
    sp.set(k, v === true ? '1' : String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

const FOCUS_GAP_MS = 15000; // refetch on window focus at most this often

/**
 * Loads `path` (GET) and keeps it fresh.
 * - `refreshOn`: server-event kinds ('raid', 'bank', ...) that trigger a quiet reload.
 * - `focus`: reload quietly when the window regains focus (default true).
 * - `interval`: optional polling in ms.
 * Pass `null` as the path to skip loading (e.g. until an id is known).
 * Returns { data, error, loading, refreshing, reload, setData }. Quiet reloads keep the old data on screen; a quiet
 * reload that fails keeps the data and reports `refreshError` instead of `error`.
 */
export function useApi(path, { refreshOn = [], focus = true, interval = 0, initial } = {}) {
  const [state, setState] = useState(() => ({ data: initial, error: null, refreshError: null, loading: !!path, refreshing: false, path }));
  const seq = useRef(0);
  const pathRef = useRef(path);
  pathRef.current = path;
  const hasData = useRef(false);

  const load = useCallback(async ({ quiet = false } = {}) => {
    const p = pathRef.current;
    if (!p) return undefined;
    const id = ++seq.current;
    setState((s) => (quiet ? { ...s, refreshing: true } : { ...s, loading: true, error: null }));
    try {
      const data = await api.get(p);
      if (id === seq.current && p === pathRef.current) {
        hasData.current = true;
        setState({ data, error: null, refreshError: null, loading: false, refreshing: false, path: p });
      }
      return data;
    } catch (error) {
      if (id === seq.current && p === pathRef.current) {
        setState((s) => (quiet && hasData.current
          ? { ...s, refreshing: false, refreshError: error }
          : { ...s, data: initial, error, loading: false, refreshing: false }));
      }
      return undefined;
    }
  }, []);

  // (Re)load when the path changes.
  useEffect(() => {
    hasData.current = false;
    if (!path) {
      seq.current++;
      setState({ data: initial, error: null, refreshError: null, loading: false, refreshing: false, path });
      return;
    }
    setState((s) => (s.path === path && s.loading && !s.error
      ? s
      : { data: initial, error: null, refreshError: null, loading: true, refreshing: false, path }));
    load();
  }, [path]);

  // Server events of the listed kinds.
  const kinds = [].concat(refreshOn || []).join(',');
  useEffect(() => {
    if (!kinds) return undefined;
    const wanted = new Set(kinds.split(','));
    return gc.on('server-event', (ev) => { if (ev && wanted.has(ev.kind)) load({ quiet: true }); });
  }, [kinds, load]);

  // Window focus.
  useEffect(() => {
    if (!focus) return undefined;
    let last = Date.now();
    const onFocus = () => {
      if (Date.now() - last < FOCUS_GAP_MS) return;
      last = Date.now();
      load({ quiet: true });
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [focus, load]);

  // Optional polling.
  useEffect(() => {
    if (!interval) return undefined;
    const t = setInterval(() => { if (!document.hidden) load({ quiet: true }); }, interval);
    return () => clearInterval(t);
  }, [interval, load]);

  const reload = useCallback(() => load({ quiet: hasData.current }), [load]);
  const setData = useCallback((d) => setState((s) => ({ ...s, data: typeof d === 'function' ? d(s.data) : d })), []);

  return {
    data: state.data, error: state.error, refreshError: state.refreshError,
    loading: state.loading, refreshing: state.refreshing, reload, setData,
  };
}

/**
 * Wraps an async action for buttons and forms: tracks `busy`, shows a toast when it fails (and optionally when it
 * works). `run(...args)` resolves to { ok: true, value } or { ok: false, error }; it never throws.
 *   const save = useAction((body) => api.put('/api/guild/settings', body), { success: 'Saved.' });
 *   <Button busy=${save.busy} onClick=${async () => { if ((await save.run(form)).ok) reload(); }}>Save</Button>
 */
export function useAction(fn, { success, failure, quiet = false } = {}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const run = useCallback(async (...args) => {
    setBusy(true);
    setError(null);
    try {
      const value = await fnRef.current(...args);
      if (success) toast(typeof success === 'function' ? success(value) : success, 'ok');
      return { ok: true, value };
    } catch (err) {
      const message = (err && err.message) || failure || 'Something went wrong. Please try again.';
      if (mounted.current) setError(err);
      if (!quiet) toast(failure && !err?.message ? failure : message, 'alarm');
      return { ok: false, error: err };
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, []);

  return { run, busy, error };
}
