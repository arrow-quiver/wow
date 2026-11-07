// Renderer entry: applies the theme, reads the sign-in state, picks the first page and renders the app shell.
import { html, render, Component, useEffect, useReducer, useRef, useState } from './lib/html.js';
import { gc } from './lib/gc.js';
import routes, { NAV_SECTIONS, staticPaths } from './pages/index.js';
import { setRoutes, useLocation, findRoute, navigate, currentLocation } from './lib/router.js';
import { useSession, refreshSession, setSession, sessionStore } from './lib/session.js';
import { applyTheme } from './lib/theme.js';
import { watchTooltips } from './lib/wowhead.js';
import { syncStatus, updaterStatus, addonStatus } from './lib/status.js';
import { Sidebar, TopBar } from './components/Shell.js';
import { Splash, shouldShowSplash, whenVisible } from './components/Splash.js';
import { Page, Toasts, ErrorBox, Empty, Loading, Button } from './components/index.js';

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

function NotAllowed({ route }) {
  return html`<${Rendered}><${Page} title=${route.title}>
    <${Empty} icon="shield" title=${route.owner ? 'Only the guild owner can open this page.' : 'Only officers can open this page.'}
      action=${html`<${Button} href="/">Back to Camp<//>`} />
  <//><//>`;
}

// ---------- app ----------

function App({ initialSplash }) {
  const loc = useLocation();
  const session = useSession();
  const [splash, setSplash] = useState(initialSplash);
  const contentRef = useRef(null);
  const firstPath = useRef(true);

  const found = findRoute(routes, loc.path);
  const route = found ? found.route : NOT_FOUND;
  const params = found ? found.params : {};
  const needsSession = !route.public;
  const allowed = session.signedIn && !!session.guild;

  // Signed out (or removed from the guild): back to the welcome flow.
  useEffect(() => {
    if (session.loaded && needsSession && !allowed) navigate('/welcome', { replace: true });
  }, [session.loaded, needsSession, allowed]);

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
    if (initialSplash || !document.hidden) return undefined;
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
  if (needsSession && !allowed) body = html`<div class="page-loading"><${Loading} label="Checking your sign-in…" /></div>`;
  else if (route === NOT_FOUND) body = html`<${NotFound} />`;
  else if ((route.officer && !session.isOfficer) || (route.owner && !session.isOwner)) body = html`<${NotAllowed} route=${route} />`;
  else {
    body = html`<${PageBoundary} key=${loc.path} title=${route.title}>
      <${PageHost} route=${route} params=${params} query=${loc.query} />
    <//>`;
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
  } catch (err) {
    console.warn('Could not read settings:', err?.message);
  }
  gc.on('settings', (s) => { if (s && typeof s === 'object' && 'theme' in s) applyTheme(s.theme); });

  let session;
  try {
    session = await refreshSession();
  } catch (err) {
    console.warn('Could not read the sign-in state:', err?.message);
    session = setSession(null);
  }

  // First run, signed out, not in a guild, or the game not set up yet: start with the welcome flow.
  const needsWelcome = !session.signedIn || !session.guild || settings?.onboarded === false;
  if (needsWelcome && currentLocation().path !== '/welcome') navigate('/welcome', { replace: true });

  // Start following live statuses now so the sidebar has them on first paint, and ask again whenever someone
  // signs in or out (the sync engine's state depends on it).
  syncStatus.start();
  updaterStatus.start();
  addonStatus.start();
  let wasSignedIn = session.signedIn;
  sessionStore.subscribe((s) => {
    if (s.signedIn === wasSignedIn) return;
    wasSignedIn = s.signedIn;
    syncStatus.refresh();
    addonStatus.refresh();
  });

  render(html`<${App} initialSplash=${shouldShowSplash()} />`, root);
}

boot().catch((err) => {
  console.error(err);
  const root = document.getElementById('app');
  render(html`<div class="bare"><div class="bare-drag"></div><div class="page page--narrow" style="padding-top: 80px">
    <${ErrorBox} title="Guild Camp could not start." error=${err} onRetry=${() => window.location.reload()} retryLabel="Reload" />
  </div></div>`, root);
});
