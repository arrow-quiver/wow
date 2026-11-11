// Renderer entry: applies the theme, reads who I am and the app settings, picks the first page and renders the
// app shell. The gate (lib/session.js pageGate): the welcome flow until setup is done (settings.onboarded), then
// every page; pages that need guild data show "Waiting for your guild" with a link to Addon & sync until the game
// has shown Guild Camp a guild.
import { html, render, Component, useEffect, useReducer, useRef, useState } from './lib/html.js';
import { gc } from './lib/gc.js';
import routes, { NAV_SECTIONS, staticPaths } from './pages/index.js';
import { setRoutes, useLocation, findRoute, navigate, currentLocation } from './lib/router.js';
import { useSession, refreshSession, setSession, sessionStore, pageGate, isOnboarded } from './lib/session.js';
import { applyTheme } from './lib/theme.js';
import { watchTooltips } from './lib/wowhead.js';
import { syncStatus, updaterStatus, addonStatus, settingsStatus, useSettings } from './lib/status.js';
import { Sidebar, TopBar } from './components/Shell.js';
import { OverlayBar, AlertsFeed } from './components/OverlayBar.js';
import { OVERLAY } from './lib/overlay.js';
import { Splash, shouldShowSplash, whenVisible } from './components/Splash.js';
import { Page, Toasts, ErrorBox, Empty, Loading, Button } from './components/index.js';
import { NoGuild } from './components/NoGuild.js';

setRoutes(routes);

const NOT_FOUND = { path: '*', title: 'Not found' };

// ---------- smoke-test signal ----------

// Tells the main process the first page is on screen, with every static route so a smoke test can visit them.
let readySent = false;
function signalReady() {
  if (readySent) return;
  readySent = true;
  // A timer, not requestAnimationFrame: animation frames do not run while the window is hidden.
  setTimeout(() => {
    gc.invoke('app.rendererReady', { routes: staticPaths }).catch(() => { /* older main process: not needed */ });
  }, 0);
}

function Rendered({ children }) {
  useEffect(signalReady, []);
  return children;
}

// ---------- lazy pages ----------

const modules = new Map(); // route.path → { status: 'loading'|'ready'|'error', Comp, error, promise }

function loadPage(route) {
  let entry = modules.get(route.path);
  if (!entry) {
    entry = { status: 'loading' };
    entry.promise = Promise.resolve()
      .then(() => route.load())
      .then((mod) => {
        if (typeof mod.default !== 'function') throw new Error(`The page module for ${route.path} has no default export.`);
        entry.Comp = mod.default;
        entry.status = 'ready';
      })
      .catch((error) => {
        console.error(error);
        entry.error = error;
        entry.status = 'error';
      });
    modules.set(route.path, entry);
  }
  return entry;
}

function PageHost({ route, params, query }) {
  const [, force] = useReducer((n) => n + 1, 0);
  const [attempt, setAttempt] = useState(0);
  const entry = loadPage(route);
  useEffect(() => {
    // Re-render once the import settles. The promise may already be settled by the time this effect runs,
    // so always attach (then() still fires) instead of checking the status first.
    let live = true;
    entry.promise.then(() => { if (live && entry.status !== 'loading') force(); });
    return () => { live = false; };
  }, [entry]);

  if (entry.status === 'loading') {
    return html`<div class="page-loading"><${Loading} label=${`Opening ${route.title || 'the page'}…`} /></div>`;
  }
  if (entry.status === 'error') {
    const retry = () => {
      // A failed module import is cached by the browser, so after one retry offer a full reload instead.
      if (attempt >= 1) { window.location.reload(); return; }
      modules.delete(route.path);
      setAttempt(attempt + 1);
    };
    return html`<${Rendered}><${Page} title=${route.title}>
      <${ErrorBox} title="This page could not be opened." error=${entry.error} onRetry=${retry}
        retryLabel=${attempt >= 1 ? 'Reload Guild Camp' : 'Try again'} />
    <//><//>`;
  }
  const Comp = entry.Comp;
  return html`<${Rendered}><${Comp} params=${params} query=${query} /><//>`;
}

// Catches render errors inside a page so the rest of the app keeps working.
class PageBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) { return { error }; }

  componentDidCatch(error) { console.error(error); }

  render({ children, title }, { error }) {
    if (!error) return children;
    return html`<${Rendered}><${Page} title=${title}>
      <${ErrorBox} title="This page ran into a problem." error=${error} onRetry=${() => this.setState({ error: null })} />
    <//><//>`;
  }
}

function NotFound() {
  return html`<${Rendered}><${Page} title="Not found">
    <${Empty} title="This page does not exist." icon="info" action=${html`<${Button} href="/" variant="primary">Go to Camp<//>`} />
  <//><//>`;
}

// A guild page before the game has shown Guild Camp a guild: the core's sentence, not an error.
function NoGuildPage({ route }) {
  return html`<${Rendered}><${Page} title=${route.title}>
    <${NoGuild} />
  <//><//>`;
}

// The local guild data didn't answer (GET /api/me failed).
function Unavailable({ route, error }) {
  const [busy, setBusy] = useState(false);
  const retry = async () => {
    setBusy(true);
    try { await refreshSession(); } finally { setBusy(false); }
  };
  return html`<${Rendered}><${Page} title=${route.title}>
    <${ErrorBox} title="Guild Camp couldn't read your guild data." error=${error || 'Restart Guild Camp if this keeps happening.'}
      onRetry=${busy ? undefined : retry} />
  <//><//>`;
}

function NotAllowed({ route }) {
  return html`<${Rendered}><${Page} title=${route.title}>
    <${Empty} icon="shield" title=${route.owner ? 'Only the guild owner can open this page.' : 'Only officers can open this page.'}
      action=${html`<${Button} href="/">Back to Camp<//>`} />
  <//><//>`;
}

// ---------- app ----------

function App({ initialSplash, smoke = false }) {
  const loc = useLocation();
  const session = useSession();
  const settings = useSettings();
  const [splash, setSplash] = useState(OVERLAY ? false : initialSplash);
  const contentRef = useRef(null);
  const firstPath = useRef(true);

  const found = findRoute(routes, loc.path);
  const route = found ? found.route : NOT_FOUND;
  const params = found ? found.params : {};
  const gate = pageGate({ route, session, onboarded: isOnboarded(settings), smoke });

  // Setup isn't done yet (first run): the welcome flow. Its "Done" marks setup done before it opens the camp.
  useEffect(() => {
    if (gate === 'welcome') navigate('/welcome', { replace: true });
  }, [gate]);

  // New page: start at the top and move keyboard focus to the content (not on the very first page).
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    el.scrollTop = 0;
    if (firstPath.current) { firstPath.current = false; return; }
    if (!route.bare) el.focus({ preventScroll: true });
  }, [loc.path]);

  // Started while the window was still hidden: decide about the splash once it is shown.
  useEffect(() => {
    if (OVERLAY || initialSplash || !document.hidden) return undefined;
    return whenVisible(() => { const show = shouldShowSplash(); if (show) setSplash(show); });
  }, []);

  // Wowhead tooltips for links that pages add.
  useEffect(() => watchTooltips(contentRef.current), [!!route.bare]);

  const splashEl = splash
    ? html`<${Splash} guildName=${session.guild?.name} faction=${session.guild?.faction} hold=${splash === 'hold'} onDone=${() => setSplash(false)} />`
    : null;

  if (route.bare) {
    return html`
      <div class="bare">
        <div class="bare-drag" aria-hidden="true"></div>
        <main id="content" ref=${contentRef}>
          <${PageBoundary} key=${loc.path} title=${route.title}>
            <${PageHost} route=${route} params=${params} query=${loc.query} />
          <//>
        </main>
      </div>
      ${splashEl}
      <${Toasts} />`;
  }

  let body;
  if (gate === 'loading' || gate === 'welcome') body = html`<div class="page-loading"><${Loading} label="Opening Guild Camp…" /></div>`;
  else if (route === NOT_FOUND) body = html`<${NotFound} />`;
  else if (gate === 'unavailable') body = html`<${Unavailable} route=${route} error=${session.error} />`;
  else if (gate === 'no-guild') body = html`<${NoGuildPage} route=${route} />`;
  else if ((route.officer && !session.isOfficer) || (route.owner && !session.isOwner)) body = html`<${NotAllowed} route=${route} />`;
  else {
    body = html`<${PageBoundary} key=${loc.path} title=${route.title}>
      <${PageHost} route=${route} params=${params} query=${loc.query} />
    <//>`;
  }

  // The overlay window (Ctrl+Shift+G): the whole app as the war table, with its own bar and live alerts.
  if (OVERLAY) {
    return html`
      <div class="app app--overlay">
        <${OverlayBar} />
        <${Sidebar} routes=${routes} sections=${NAV_SECTIONS} overlay />
        <${TopBar} route=${route} path=${loc.path} />
        <main class="content" id="content" tabIndex="-1" ref=${contentRef} aria-label=${route.title}>${body}</main>
      </div>
      <${AlertsFeed} />
      <${Toasts} />`;
  }

  return html`
    <div class="app">
      <${Sidebar} routes=${routes} sections=${NAV_SECTIONS} />
      <${TopBar} route=${route} path=${loc.path} />
      <main class="content" id="content" tabIndex="-1" ref=${contentRef} aria-label=${route.title}>${body}</main>
    </div>
    ${splashEl}
    <${Toasts} />`;
}

// ---------- boot ----------

async function boot() {
  const root = document.getElementById('app');

  let settings = null;
  try {
    settings = await gc.settings.get();
    applyTheme(settings?.theme);
    // The gate reads the settings from this store; it follows the 'settings' channel from here on.
    if (settings && typeof settings === 'object') settingsStatus.store.set(settings);
  } catch (err) {
    console.warn('Could not read settings:', err?.message);
  }
  gc.on('settings', (s) => { if (s && typeof s === 'object' && 'theme' in s) applyTheme(s.theme); });

  // A smoke run visits every page itself, so it never stops at the welcome flow.
  let smoke = false;
  try { smoke = Boolean((await gc.app.info())?.smoke); } catch { /* not a smoke run */ }

  try {
    await refreshSession();
  } catch (err) {
    console.warn('Could not read the sign-in state:', err?.message);
    setSession(null);
  }

  // First run (setup not done yet): start with the welcome flow. A guild isn't needed: pages wait for it.
  if (!smoke && !isOnboarded(settings) && currentLocation().path !== '/welcome') navigate('/welcome', { replace: true });

  // Start following live statuses now so the sidebar has them on first paint, and ask again whenever someone
  // signs in or out (the sync engine's state depends on it).
  settingsStatus.start();
  syncStatus.start();
  updaterStatus.start();
  addonStatus.start();
  let wasSignedIn = sessionStore.get().signedIn;
  sessionStore.subscribe((s) => {
    if (s.signedIn === wasSignedIn) return;
    wasSignedIn = s.signedIn;
    syncStatus.refresh();
    addonStatus.refresh();
  });

  render(html`<${App} initialSplash=${shouldShowSplash()} smoke=${smoke} />`, root);
}

boot().catch((err) => {
  console.error(err);
  const root = document.getElementById('app');
  render(html`<div class="bare"><div class="bare-drag"></div><div class="page page--narrow" style="padding-top: 80px">
    <${ErrorBox} title="Guild Camp could not start." error=${err} onRetry=${() => window.location.reload()} retryLabel="Reload" />
  </div></div>`, root);
});
