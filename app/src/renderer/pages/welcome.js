// First run. The first screen offers "Sign in with Battle.net" (when this copy of Guild Camp has it) and
// "Continue without Battle.net". Then an automatic checklist runs by itself: find the game folders, install the
// addon, pick up your guild (the local guild data fills it after the first sync with the addon: GET /api/me),
// and offer to start with Windows. The camp opens by itself once everything is ready; "Done" opens it at any
// time (settings.onboarded), even before the guild is known: guild pages then say they are waiting for it.
// ?step=start shows the first screen again.
import { html, cx, useState, useEffect, useRef, useCallback } from '../lib/html.js';
import { gc } from '../lib/gc.js';
import { useSession, setSession, refreshSession, splitBattleTag } from '../lib/session.js';
import { navigate } from '../lib/router.js';
import { useAddonStatus, addonStatus as addonLive, settingsStatus as settingsLive } from '../lib/status.js';
import { plural } from '../lib/format.js';
import { Card, Button, Checkbox, Notice, Spinner, Icon, Campfire, toast } from '../components/index.js';
import { RESTART_LINE } from './addon.js';

// How long "all set" stays on screen before the camp opens by itself.
export const AUTO_CONTINUE_MS = 2600;
// While no guild is known yet, look again this often (the core also says so on 'server-event').
export const GUILD_CHECK_MS = 10000;
// Remembers "Continue without Battle.net" on this PC, so the first screen isn't shown every time.
const WITHOUT_BNET_KEY = 'guildcamp.welcome.withoutBnet';

// ---------- helpers (exported for tests) ----------

// ['WoW Forever', 'Retail', 'Classic Era'] → "WoW Forever, Retail and Classic Era" (duplicates and blanks dropped).
export function listLabels(items) {
  const list = [...new Set((items || []).map((s) => String(s ?? '').trim()).filter(Boolean))];
  if (list.length <= 1) return list[0] || '';
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

// Which screen to open: the first screen (sign in or continue without), or the setup checklist.
export function firstStep({ bnetSignedIn = false, withoutBnet = false, onboarded = false, step } = {}) {
  if (step === 'start') return 'start';
  return bnetSignedIn || withoutBnet || onboarded ? 'setup' : 'start';
}

// What to say when gc.auth.signIn() fails. Nothing when the person cancelled it themselves.
export function signInMessage(err) {
  if (!err || err.code === 'cancelled') return '';
  return err.message || "Battle.net sign-in didn't work. Try again in a minute.";
}

// The "Battle.net" line of the checklist. null when this copy of Guild Camp has no Battle.net sign-in.
export function bnetView(bnet) {
  const b = bnet || {};
  if (b.signedIn) {
    const n = Array.isArray(b.characters) ? b.characters.length : 0;
    return {
      state: 'done',
      title: `Signed in as ${b.battletag || 'you'}`,
      detail: n ? `Battle.net shows ${plural(n, 'character')} on your account.` : 'Battle.net shows no World of Warcraft characters on your account yet.',
    };
  }
  if (!b.available) return null;
  if (b.signingIn) return { state: 'working', title: 'Signing in to Battle.net…', detail: 'Finish signing in in your web browser.' };
  return { state: 'pending', title: 'Battle.net (optional)', detail: 'Sign in to show your BattleTag and list your characters. Everything works without it.' };
}

// The "Game folders" line, from gc.wow.installs().
export function gamesView(installs, error = '') {
  if (error) return { state: 'attention', title: "We couldn't look for the game", detail: error };
  if (!Array.isArray(installs)) return { state: 'working', title: 'Looking for World of Warcraft…', detail: '' };
  if (!installs.length) {
    return { state: 'attention', title: "We couldn't find World of Warcraft", detail: 'Choose your World of Warcraft folder: the one with _forever_ or _retail_ inside.' };
  }
  return { state: 'done', title: 'Found World of Warcraft', detail: listLabels(installs.map((i) => i.label || i.flavor)) };
}

// The "Addon" line, from the installs and gc.addon.status(). `missing` lists the installs that still need it.
export function addonView({ installs, addon, autoInstall = true } = {}) {
  if (!Array.isArray(installs) || !installs.length) {
    return { state: 'pending', title: 'Guild Camp addon', detail: 'Installs itself once Guild Camp finds the game.', missing: [] };
  }
  if (!addon || !Array.isArray(addon.installs)) return { state: 'working', title: 'Checking the addon…', detail: '', missing: [] };
  const rows = installs.map((inst) => {
    const st = addon.installs.find((x) => x.dir === inst.dir) || null;
    return {
      dir: inst.dir, label: inst.label || inst.flavor || inst.dir, state: st ? st.state : 'missing', busy: !!(st && st.busy),
      version: st && st.installed ? st.installed.version : null, waitingForGame: !!(st && st.waitingForGame),
    };
  });
  const have = rows.filter((r) => r.state !== 'missing');
  const missing = rows.filter((r) => r.state === 'missing');
  const busy = rows.filter((r) => r.busy);
  if (busy.length || (addon.checking && missing.length && autoInstall)) {
    return { state: 'working', title: 'Installing the addon…', detail: `Into ${listLabels((busy.length ? busy : missing).map((r) => r.label))}.`, missing: [] };
  }
  if (have.length) {
    const version = have.find((r) => r.version)?.version;
    const where = listLabels(have.map((r) => r.label));
    return {
      state: 'done',
      title: 'Addon installed',
      detail: missing.length
        ? `In ${where}. Not in ${listLabels(missing.map((r) => r.label))} yet.`
        : `Guild Camp addon${version ? ` ${version}` : ''} in ${where}.`,
      missing,
    };
  }
  // The automatic install waits while the game runs: the game finds a new addon folder only when it starts.
  const waiting = autoInstall && missing.length > 0 && missing.every((r) => r.waitingForGame);
  return {
    state: 'attention',
    title: "The addon isn't installed yet",
    detail: waiting ? 'Guild Camp installs it once World of Warcraft is closed. You can also install it now with one click.'
      : autoInstall ? 'Install it with one click. Guild Camp keeps it up to date after that.' : 'Automatic install is off in Settings. Install it here with one click.',
    missing,
  };
}

// The "Your guild" line, from GET /api/me (guild + role). The guild comes from the game, so until the first sync
// there is nothing to do but play.
export function guildView({ guild = null, role = null } = {}) {
  if (guild && guild.name) {
    const where = [guild.realm, guild.faction].filter(Boolean).join(', ');
    let detail = 'Your characters and guild news stay in sync while you play.';
    if (role === 'owner') detail = "You're the Guild Master, so you can change the guild settings here.";
    else if (role === 'officer') detail = 'Your guild rank makes you an officer here.';
    return { state: 'done', title: `You're in ${guild.name}${where ? ` (${where})` : ''}`, detail };
  }
  return {
    state: 'waiting',
    title: 'Waiting for your guild',
    detail: 'Log in to World of Warcraft once with the addon. Guild Camp picks up your guild by itself.',
  };
}

// The camp opens by itself once everything on the checklist is done.
export function allSet({ inGuild, games, addon } = {}) {
  return !!inGuild && games?.state === 'done' && addon?.state === 'done';
}

// The line under the setup heading, from the checklist's states ('done' | 'working' | 'attention' | 'waiting' | 'pending').
export function setupLede(states = []) {
  const list = states.filter(Boolean);
  if (list.length && list.every((s) => s === 'done')) return 'Everything is ready.';
  if (list.includes('working')) return 'Guild Camp is setting things up. This takes a few seconds.';
  const needs = list.filter((s) => s === 'attention').length;
  if (needs === 1) return 'Almost done. One thing needs you.';
  if (needs > 1) return 'Almost done. A few things need you.';
  if (list.includes('waiting')) return 'Almost done. Guild Camp is waiting for your guild.';
  return 'Almost done.';
}

// What to call the person in the heading: the BattleTag's name, else the name Guild Camp knows them by.
export function welcomeName(session) {
  const s = session || {};
  const fromBnet = splitBattleTag(s.battletag).name;
  if (fromBnet) return fromBnet;
  const known = splitBattleTag(s.user && s.user.battletag).name;
  return known && known !== 'You' ? known : '';
}

function readWithoutBnet() {
  try { return window.localStorage.getItem(WITHOUT_BNET_KEY) === '1'; } catch { return false; }
}

function writeWithoutBnet(on) {
  try {
    if (on) window.localStorage.setItem(WITHOUT_BNET_KEY, '1');
    else window.localStorage.removeItem(WITHOUT_BNET_KEY);
  } catch { /* the first screen just shows again next time */ }
}

// gc.on throws for a channel the preload doesn't know (an older main process); a page must not break on that.
function useChannel(channel, cb) {
  const ref = useRef(cb);
  ref.current = cb;
  useEffect(() => {
    try { return gc.on(channel, (payload) => ref.current && ref.current(payload)); } catch { return undefined; }
  }, [channel]);
}

// Battle.net sign-in for a button: busy while the browser is open, the last attempt wins.
function useBnetSignIn({ onSignedIn } = {}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const seq = useRef(0);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const signIn = useCallback(async () => {
    const id = ++seq.current;
    setError('');
    setBusy(true);
    try {
      const s = await gc.auth.signIn();
      setSession({ bnet: s });
      if (s?.signedIn) {
        writeWithoutBnet(false);
        if (mounted.current && id === seq.current) onSignedIn?.(s);
      }
    } catch (err) {
      if (mounted.current && id === seq.current) setError(signInMessage(err));
    } finally {
      if (mounted.current && id === seq.current) setBusy(false);
    }
  }, [onSignedIn]);

  // Signing out stops a sign-in that is still waiting for the browser.
  const cancel = useCallback(async () => {
    seq.current += 1;
    setBusy(false);
    try { setSession({ bnet: await gc.auth.signOut() }); } catch { /* nothing was waiting */ }
  }, []);

  return { signIn, cancel, busy, error, setError };
}

// ---------- page ----------

export default function WelcomePage({ query = {} }) {
  const session = useSession();
  const [step, setStep] = useState(null); // null while working out where to start
  const [settings, setSettings] = useState(null);
  const [appVersion, setAppVersion] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [s, info] = await Promise.all([
        gc.settings.get().catch(() => ({})),
        gc.app.info().catch(() => null),
      ]);
      if (cancelled) return;
      setSettings(s || {});
      if (info?.version) setAppVersion(info.version);
      const now = await refreshSession();
      if (cancelled) return;
      setStep(firstStep({ bnetSignedIn: now.bnet.signedIn, withoutBnet: readWithoutBnet(), onboarded: s?.onboarded === true, step: query.step }));
    })();
    return () => { cancelled = true; };
  }, []);

  // /welcome?step=start while the page is already open.
  useEffect(() => { if (query.step === 'start' && step !== null) setStep('start'); }, [query.step]);
  useEffect(() => { document.title = 'Welcome · Guild Camp'; }, []);
  useChannel('settings', (s) => { if (s && typeof s === 'object') setSettings(s); });

  // Signed in to Battle.net somewhere else (Settings, a second click) while the first screen is open: go on.
  useEffect(() => {
    if (step === 'start' && session.bnet.signedIn) setStep('setup');
  }, [step, session.bnet.signedIn]);

  return html`<div class="welcome">
    ${step === null ? html`<div class="welcome-loading"><${Campfire} /><div class="loading"><${Spinner} label="" /> Getting things ready…</div></div>` : null}

    ${step === 'start' ? html`<${StartScreen} bnet=${session.bnet}
        onSignedIn=${() => setStep('setup')}
        onWithout=${() => { writeWithoutBnet(true); setStep('setup'); }} />` : null}

    ${step === 'setup' ? html`<${SetupScreen} session=${session} settings=${settings} onSettings=${setSettings} />` : null}

    ${step ? html`<p class="welcome-foot"><span>Guild Camp${appVersion ? ` ${appVersion}` : ''}</span></p>` : null}
  </div>`;
}

// ---------- first screen ----------

function StartScreen({ bnet, onSignedIn, onWithout }) {
  const { signIn, cancel, busy, error } = useBnetSignIn({ onSignedIn });
  const waiting = busy || bnet.signingIn;
  const available = !!bnet.available;

  const without = async () => {
    if (waiting) await cancel();
    onWithout();
  };

  return html`<div class="welcome-main">
    <header class="welcome-hero">
      <${Campfire} />
      <h1>Guild Camp</h1>
      <p class="welcome-lede">Your guild, your addon and your characters in one place. Guild Camp sets everything up by itself.</p>
    </header>

    <${Card} class="welcome-card">
      ${error ? html`<${Notice} kind="alarm">${error}<//>` : null}

      ${available ? html`
        ${waiting
          ? html`<${Notice} kind="info" icon="battlenet" title="Finish signing in in your web browser.">
              Guild Camp waits here. Didn't see Battle.net open? <button type="button" class="link-btn" onClick=${signIn}>Open it again</button> or <button type="button" class="link-btn" onClick=${cancel}>cancel</button>.
            <//>`
          : html`<${Button} variant="primary" size="lg" icon="battlenet" block class="welcome-bnet" onClick=${signIn}>Sign in with Battle.net<//>
            <p class="welcome-promise">Your web browser opens Battle.net. Guild Camp only sees your BattleTag and your World of Warcraft characters, never your password.</p>`}
        <div class="or-line">or</div>` : null}

      <${Button} variant=${available ? 'secondary' : 'primary'} size="lg" block iconRight="forward" onClick=${without}>Continue without Battle.net<//>
      <p class="welcome-promise">${available
        ? 'Everything works without it. You can sign in later in Settings.'
        : "Battle.net sign-in isn't part of this copy of Guild Camp. Everything works without it."}</p>
    <//>
  </div>`;
}

// ---------- the automatic setup checklist ----------

const STATE_TEXT = { done: 'Done', working: 'In progress', attention: 'Needs you', waiting: 'Waiting', pending: 'Not started yet' };

function SetupItem({ state, title, detail, aside, children }) {
  const mark = state === 'done' ? html`<${Icon} name="check" />`
    : state === 'working' ? html`<span class="spinner spinner--sm"></span>`
      : state === 'attention' ? html`<span class="setup-bang">!</span>`
        : state === 'waiting' ? html`<${Icon} name="sync" />`
          : html`<span class="setup-dot"></span>`;
  return html`<li class=${cx('setup-item', `is-${state}`)}>
    <span class="setup-mark" aria-hidden="true">${mark}</span>
    <div class="setup-body">
      <div class="setup-head">
        <span class="setup-title"><span class="sr">${STATE_TEXT[state] || ''}: </span>${title}</span>
        ${aside ? html`<span class="setup-aside">${aside}</span>` : null}
      </div>
      ${detail ? html`<p class="setup-detail">${detail}</p>` : null}
      ${children || null}
    </div>
  </li>`;
}

function SetupScreen({ session, settings, onSettings }) {
  const addon = useAddonStatus();
  const [installs, setInstalls] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [adding, setAdding] = useState(false);
  const [busyDir, setBusyDir] = useState('');
  const [checking, setChecking] = useState(false);
  const [info, setInfo] = useState(null);
  const [auto, setAuto] = useState('on'); // 'on' | 'stopped': opening the camp by itself once all is set
  const [finishing, setFinishing] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const kicked = useRef(false);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  const bnetSignIn = useBnetSignIn();

  // ---- game folders ----
  const loadInstalls = useCallback(async () => {
    try {
      setLoadError('');
      const list = await gc.wow.installs();
      if (mounted.current) setInstalls(Array.isArray(list) ? list : []);
    } catch (err) {
      if (mounted.current) { setLoadError(err?.message || "Guild Camp couldn't look for the game."); setInstalls([]); }
    }
  }, []);

  useEffect(() => {
    loadInstalls();
    gc.app.info().then((i) => mounted.current && setInfo(i || {}), () => mounted.current && setInfo({}));
  }, []);

  // Once the game is found, ask the addon manager to check: with "install automatically" on, it installs
  // the addon wherever it is missing, and its progress arrives on the 'addon' channel.
  useEffect(() => {
    if (!installs || !installs.length || kicked.current) return;
    kicked.current = true;
    gc.addon.check().catch(() => {}).finally(() => addonLive.refresh());
  }, [installs]);

  const addFolder = async () => {
    setAdding(true);
    setAuto('stopped');
    try {
      const dir = await gc.app.pickFolder({ title: 'Choose your World of Warcraft folder' });
      if (dir) {
        await gc.wow.addFolder(dir);
        kicked.current = false;
        await loadInstalls();
      }
    } catch (err) {
      toast(err?.message || "Guild Camp couldn't add that folder.", 'alarm');
    } finally {
      if (mounted.current) setAdding(false);
    }
  };

  const installOne = async (dir) => {
    setBusyDir(dir);
    try {
      const s = await gc.addon.install(dir);
      await addonLive.refresh();
      // A new addon folder loads when the game starts; a running game needs a restart (s.restartNeeded).
      toast(`Addon installed. ${s?.restartNeeded ? RESTART_LINE : 'Start the game to load it.'}`, 'ok');
    } catch (err) {
      toast(err?.message || "Guild Camp couldn't install the addon.", 'alarm');
    } finally {
      if (mounted.current) setBusyDir('');
    }
  };

  // ---- the guild ----
  const inGuild = !!session.guild;

  // Until the guild is known, look again now and then, and whenever a sync finishes.
  useEffect(() => {
    if (inGuild) return undefined;
    const t = setInterval(() => { refreshSession(); }, GUILD_CHECK_MS);
    return () => clearInterval(t);
  }, [inGuild]);
  const lastSync = useRef(null);
  useChannel('sync', (status) => {
    const at = status && status.lastSyncAt;
    if (at && at !== lastSync.current) {
      lastSync.current = at;
      if (!inGuild) refreshSession();
    }
  });

  const checkNow = async () => {
    setChecking(true);
    try {
      await gc.sync.now().catch(() => {});
      await refreshSession();
    } finally {
      if (mounted.current) setChecking(false);
    }
  };

  const bnetLine = bnetView({ ...session.bnet, signingIn: session.bnet.signingIn || bnetSignIn.busy });
  const games = gamesView(installs, loadError);
  const addonLine = addonView({ installs, addon, autoInstall: settings?.addonAutoInstall !== false });
  const guildLine = guildView({ guild: session.guild, role: session.role });
  const ready = allSet({ inGuild, games, addon: addonLine });
  const counting = ready && auto === 'on' && !finishing;

  // Setup is done: the app's gate (main.js) reads settings.onboarded from the settings store, so put the saved
  // settings there before opening the camp, or the gate would send us straight back here. A guild isn't needed:
  // guild pages say they are waiting for it.
  const finish = async () => {
    setFinishing(true);
    let next = null;
    try { next = await gc.settings.set({ onboarded: true }); } catch { /* not fatal: setup shows again next time */ }
    const done = { ...(settingsLive.get() || settings || {}), ...(next && typeof next === 'object' ? next : {}), onboarded: true };
    settingsLive.store.set(done);
    onSettings(done);
    navigate('/', { replace: true });
  };

  useEffect(() => {
    if (!counting) return undefined;
    const t = setTimeout(finish, AUTO_CONTINUE_MS);
    return () => clearTimeout(t);
  }, [counting]);

  const setStartup = async (on) => {
    setAuto('stopped');
    try { onSettings(await gc.settings.set({ startWithWindows: on })); } catch (err) { toast(err?.message || "Guild Camp couldn't change that setting.", 'alarm'); }
  };

  const bnetSignOut = async () => {
    setSigningOut(true);
    try {
      setSession({ bnet: await gc.auth.signOut() });
      toast('Signed out of Battle.net. Guild Camp forgot your BattleTag and characters.', 'ok');
    } catch (err) {
      toast(err?.message || "Guild Camp couldn't sign out of Battle.net.", 'alarm');
    } finally {
      if (mounted.current) setSigningOut(false);
    }
  };

  const startupSupported = info ? info.startWithWindowsSupported !== false : true;
  const name = welcomeName(session);

  return html`<div class="welcome-main welcome-main--setup">
    <header class="welcome-hero welcome-hero--small">
      <${Campfire} />
      <h1>${inGuild ? `Welcome to ${session.guild.name}` : name ? `Welcome, ${name}` : 'Welcome'}</h1>
      <p class="welcome-lede">${setupLede([games.state, addonLine.state, guildLine.state])}</p>
    </header>

    <${Card} class="welcome-card">
      <ul class="setup-list" aria-label="Setup" aria-live="polite">
        ${bnetLine ? html`<${SetupItem} state=${bnetLine.state} title=${bnetLine.title} detail=${bnetLine.detail}
            aside=${session.bnet.signedIn
              ? html`<button type="button" class="link-btn" disabled=${signingOut} onClick=${bnetSignOut}>Not you? Sign out</button>`
              : null}>
          ${!session.bnet.signedIn ? html`<div class="setup-actions">
            ${bnetLine.state === 'working'
              ? html`<button type="button" class="link-btn" onClick=${bnetSignIn.signIn}>Open Battle.net again</button>
                <button type="button" class="link-btn" onClick=${bnetSignIn.cancel}>Cancel</button>`
              : html`<${Button} size="sm" icon="battlenet" onClick=${() => { setAuto('stopped'); bnetSignIn.signIn(); }}>Sign in with Battle.net<//>`}
          </div>` : null}
          ${bnetSignIn.error ? html`<${Notice} kind="alarm">${bnetSignIn.error}<//>` : null}
          ${session.bnet.signedIn && session.bnet.error ? html`<p class="hint mb-0">${session.bnet.error}</p>` : null}
        <//>` : null}

        <${SetupItem} state=${games.state} title=${games.title}
          detail=${games.state === 'attention' && !loadError
            ? html`Choose your World of Warcraft folder: the one with <code>_forever_</code> or <code>_retail_</code> inside.`
            : games.detail}
          aside=${games.state === 'done' ? html`<button type="button" class="link-btn" disabled=${adding} onClick=${addFolder}>Add a folder</button>` : null}>
          ${games.state === 'attention' ? html`<div class="setup-actions">
            <${Button} variant="primary" size="sm" icon="folder" busy=${adding} onClick=${addFolder}>Add a game folder<//>
            <span class="hint">You can also do this later on Addon & sync.</span>
          </div>` : null}
        <//>

        <${SetupItem} state=${addonLine.state} title=${addonLine.title} detail=${addonLine.detail}>
          ${addonLine.missing.length ? html`<div class="setup-actions">
            ${addonLine.missing.map((m) => html`<${Button} key=${m.dir} size="sm" variant=${addonLine.state === 'attention' ? 'primary' : 'secondary'}
                busy=${busyDir === m.dir} disabled=${!!busyDir && busyDir !== m.dir} onClick=${() => { setAuto('stopped'); installOne(m.dir); }}>
              ${addonLine.missing.length === 1 && addonLine.state === 'attention' ? 'Install the addon' : `Install in ${m.label}`}<//>`)}
          </div>` : null}
        <//>

        <${SetupItem} state=${guildLine.state} title=${guildLine.title} detail=${guildLine.detail}>
          ${!inGuild ? html`<p class="setup-waiting">
            ${checking ? html`<span class="spinner spinner--xs" aria-hidden="true"></span>` : html`<span class="setup-pulse" aria-hidden="true"></span>`}
            <span>${checking ? 'Checking now…' : 'Guild Camp checks again each time the game saves (after /reload or logging out).'}</span>
            ${checking ? null : html`<button type="button" class="link-btn" onClick=${checkNow}>Check now</button>`}
          </p>` : null}
        <//>
      </ul>

      <div class="setup-finish">
        <${Checkbox} label="Start Guild Camp with Windows" checked=${!!settings?.startWithWindows} disabled=${!settings || !startupSupported}
          onValue=${setStartup}
          hint=${startupSupported ? 'It starts quietly in the tray and keeps your guild in sync.' : 'Only the installed app can start with Windows.'} />
        <div class="form-actions setup-done">
          <${Button} variant="primary" size="lg" iconRight="forward" busy=${finishing} onClick=${finish}>Done<//>
          ${counting
            ? html`<span class="hint setup-countdown"><span class="setup-countdown-bar" aria-hidden="true"></span>Opening your camp…
                <button type="button" class="link-btn" onClick=${() => setAuto('stopped')}>Stay here</button></span>`
            : !inGuild ? html`<span class="hint">Your guild shows up by itself after you play. Guild Camp keeps running in the tray.</span>` : null}
        </div>
      </div>
    <//>
  </div>`;
}
