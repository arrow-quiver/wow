// First run in one click: "Sign in with Battle.net", then an automatic setup checklist that finds the game,
// installs the addon, matches the person to their guild (guild.autoJoin + the 'membership' channel, see
// docs/api/core.md "POST /api/guild/auto-join") and offers to start with Windows. Invite links stay as a fallback.
// Also reached with ?step=server (change the server) or ?join=CODE (guildcamp://join/CODE links).
import { html, cx, useState, useEffect, useRef, useCallback } from '../lib/html.js';
import { gc } from '../lib/gc.js';
import { api } from '../lib/api.js';
import { useSession, setSession, refreshSession, getSession } from '../lib/session.js';
import { navigate } from '../lib/router.js';
import { useAddonStatus, addonStatus as addonLive } from '../lib/status.js';
import { plural } from '../lib/format.js';
import {
  Card, Button, Input, Select, Checkbox, Notice, Spinner, Icon, Campfire, TimeAgo, toast,
} from '../components/index.js';

// How long "all set" stays on screen before the camp opens by itself.
export const AUTO_CONTINUE_MS = 2600;

// ---------- helpers (exported for tests) ----------

// "wow.example.com" → "https://wow.example.com"; "localhost:3000" → "http://localhost:3000". Returns { url } or { error }.
export function normalizeServerUrl(input) {
  let s = String(input ?? '').trim();
  if (!s) return { error: 'Enter the server address.' };
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    const local = /^(localhost|127\.0\.0\.1|\[::1\]|[\w-]+\.(localhost|test))(:\d+)?(\/|$)/i.test(s);
    s = `${local ? 'http' : 'https'}://${s}`;
  }
  let u;
  try { u = new URL(s); } catch { return { error: 'That does not look like a web address. It should look like https://wow.example.com' }; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { error: 'The address should start with https://' };
  if (!u.hostname) return { error: 'Enter the server address.' };
  return { url: `${u.origin}${u.pathname}`.replace(/\/+$/, '') };
}

// Accepts "https://wow.example.com/join/AbC123", "guildcamp://join/AbC123", "join/AbC123" or a bare "AbC123".
// Invite codes are case-sensitive. Returns '' when no code can be found.
export function parseInviteCode(input) {
  let s = String(input ?? '').trim();
  if (!s) return '';
  const m = s.match(/(?:^|\/)join\/([^/?#\s]+)/i);
  if (m) s = m[1];
  else if (/^[a-z][a-z0-9+.-]*:/i.test(s) || s.includes('/')) return ''; // a link, but not an invite link
  try { s = decodeURIComponent(s); } catch { /* keep as typed */ }
  s = s.trim();
  return /^[A-Za-z0-9_-]{4,64}$/.test(s) ? s : '';
}

// BattleTag rule from the old dev login: "Name#1234", at most 40 characters.
export function validBattleTag(tag) {
  const t = String(tag ?? '').trim();
  return t.length <= 40 && /^[^#\s][^#]*#\d+$/.test(t);
}

export function hostOf(url) {
  try { return new URL(url).host; } catch { return url || ''; }
}

// ['WoW Forever', 'Retail', 'Classic Era'] → "WoW Forever, Retail and Classic Era" (duplicates and blanks dropped).
export function listLabels(items) {
  const list = [...new Set((items || []).map((s) => String(s ?? '').trim()).filter(Boolean))];
  if (list.length <= 1) return list[0] || '';
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

// Which screen to open: the server address (?step=server), the sign-in screen, or the setup checklist.
export function firstStep({ signedIn, step } = {}) {
  if (step === 'server') return 'server';
  return signedIn ? 'setup' : 'signin';
}

const MATCHED = new Set(['joined', 'already']);
const STATUSES = new Set(['joined', 'already', 'no-guild-on-server', 'no-match', 'disabled']);

// Keeps the newest guild.autoJoin result. The app and this page may both ask right after sign-in, so an
// 'already' that follows a 'joined' keeps the matched character from the first answer.
export function mergeMembership(prev, next) {
  if (!next || typeof next !== 'object' || !STATUSES.has(next.status)) return prev || null;
  if (prev && prev.status === 'joined' && next.status === 'already') {
    return { ...next, status: 'joined', via: next.via || prev.via, character: next.character || prev.character, role: next.role || prev.role, guild: next.guild || prev.guild };
  }
  return next;
}

// POST /api/guild body for "Set up <guild> on this server", from the guild found on the person's characters.
export function createGuildBody(detected) {
  const d = detected || {};
  const name = String(d.guild ?? '').trim();
  const body = { name: name.slice(0, 40), faction: d.faction === 'Alliance' ? 'Alliance' : 'Horde' };
  const realm = String(d.realm ?? '').trim();
  if (realm) body.realm = realm.slice(0, 60);
  if (name) body.game_guild = name.slice(0, 60);
  return body;
}

/**
 * What the "Your guild" line says, from the last guild.autoJoin result and the signed-in state.
 * state: 'done' | 'working' | 'setup' (a guild was found on the characters but not on the server) |
 *        'create' (nothing found: name it) | 'waiting' (no match yet, keeps checking) | 'error'.
 */
export function guildView({ result = null, guild = null, role = null, checking = false, error = '', serverGuild = null } = {}) {
  const r = result && typeof result === 'object' && STATUSES.has(result.status) ? result : null;
  const matched = !!(r && MATCHED.has(r.status));
  if (guild || matched) {
    const g = guild || r.guild || {};
    const who = matched && r.character ? ` (matched ${r.character})` : '';
    const myRole = role || (matched ? r.role : null);
    let detail = 'Your characters sync with the guild while you play.';
    if (myRole === 'owner') detail = 'You are the guild owner in Guild Camp.';
    else if (myRole === 'officer') detail = matched && r.via ? 'You are an officer here, because of your rank in game.' : 'You are an officer here.';
    return { state: 'done', title: `You're in ${g.name || 'the guild'}${who}`, detail };
  }
  if (r && r.status === 'no-guild-on-server') {
    const d = r.detected && r.detected.guild ? r.detected : null;
    if (d) {
      const where = [d.realm, d.faction].filter(Boolean).join(', ');
      return {
        state: 'setup',
        title: `Set up ${d.guild} on this server`,
        detail: `Your characters are in ${d.guild}${where ? ` (${where})` : ''}, but nobody has set it up on this server yet.`,
        detected: d,
      };
    }
    return { state: 'create', title: 'Start your guild camp', detail: r.reason || 'Nobody has set up a guild on this server yet.' };
  }
  const name = (r && r.guild && r.guild.name) || (serverGuild && serverGuild.name) || 'your guild';
  if (r && r.status === 'disabled') {
    return { state: 'waiting', title: `${name} adds new members by invite link`, detail: r.reason || 'Ask an officer for an invite link.' };
  }
  if (r && r.status === 'no-match') {
    return { state: 'waiting', title: `We haven't matched you to ${name} yet`, detail: r.reason || 'Guild Camp could not find your character in the guild roster yet.' };
  }
  if (error && !checking) {
    return { state: 'error', title: "We couldn't check your guild", detail: `${String(error).replace(/\s*$/, '')} Guild Camp tries again in a minute.` };
  }
  return { state: 'working', title: 'Looking for your guild…', detail: 'Checking your characters against the guild roster.' };
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
    return { dir: inst.dir, label: inst.label || inst.flavor || inst.dir, state: st ? st.state : 'missing', busy: !!(st && st.busy), version: st && st.installed ? st.installed.version : null };
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
  return {
    state: 'attention',
    title: "The addon isn't installed yet",
    detail: autoInstall ? 'Install it with one click. Guild Camp keeps it up to date after that.' : 'Automatic install is off in Settings. Install it here with one click.',
    missing,
  };
}

// The camp opens by itself once everything on the checklist is done.
export function allSet({ inGuild, games, addon } = {}) {
  return !!inGuild && games?.state === 'done' && addon?.state === 'done';
}

// The checklist mark for a "Your guild" state: setting up or naming the guild needs the person.
export function guildMark(state) {
  return state === 'done' || state === 'working' || state === 'waiting' ? state : 'attention';
}

// The line under the setup heading, from the checklist's states ('done' | 'working' | 'attention' | 'waiting' | 'pending').
export function setupLede(states = []) {
  const list = states.filter(Boolean);
  if (list.length && list.every((s) => s === 'done')) return 'Everything is ready.';
  if (list.includes('working')) return 'Guild Camp is setting things up. This takes a few seconds.';
  const needs = list.filter((s) => s === 'attention').length;
  if (needs === 1) return 'Almost done. One thing needs you.';
  if (needs > 1) return 'Almost done. A few things need you.';
  if (list.includes('waiting')) return 'Almost done. Guild Camp is waiting to match you to your guild.';
  return 'Almost done.';
}

// gc.on throws for a channel the preload doesn't know (an older main process); a page must not break on that.
function useChannel(channel, cb) {
  const ref = useRef(cb);
  ref.current = cb;
  useEffect(() => {
    try { return gc.on(channel, (payload) => ref.current && ref.current(payload)); } catch { return undefined; }
  }, [channel]);
}

// ---------- page ----------

export default function WelcomePage({ query = {} }) {
  const session = useSession();
  const [step, setStep] = useState(null); // null while working out where to start
  const [settings, setSettings] = useState(null);
  const [meta, setMeta] = useState(null);
  const [metaError, setMetaError] = useState('');
  const [appVersion, setAppVersion] = useState('');
  const joinCode = parseInviteCode(query.join);

  const loadMeta = useCallback(async () => {
    try {
      const m = await api.get('/api/meta');
      setMeta(m);
      setMetaError('');
      return m;
    } catch (err) {
      setMetaError(err?.message || 'The server did not answer.');
      return null;
    }
  }, []);

  // Work out the first screen from what we already know.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [s, info] = await Promise.all([
        gc.settings.get().catch(() => ({})),
        gc.app.info().catch(() => null),
      ]);
      if (cancelled) return;
      setSettings(s);
      if (info?.version) setAppVersion(info.version);
      const auth = await refreshSession().catch(() => setSession(null));
      if (cancelled) return;
      const first = firstStep({ signedIn: auth.signedIn, step: query.step });
      if (first !== 'server') await loadMeta();
      if (cancelled) return;
      if (first === 'setup' && joinCode && auth.guild) {
        toast(`You are already in ${auth.guild.name}. Invite links are for people who have not joined yet.`, 'info');
      }
      setStep(first);
    })();
    return () => { cancelled = true; };
  }, []);

  // /welcome?step=server while the page is already open (Settings → Change server, or the smoke run).
  useEffect(() => { if (query.step === 'server' && step !== null) setStep('server'); }, [query.step]);

  useEffect(() => { document.title = 'Welcome · Guild Camp'; }, []);
  useChannel('settings', (s) => { if (s && typeof s === 'object') setSettings(s); });

  // Signed in or out somewhere else (a revoked device, the tray, the smoke run's dev sign-in): follow it.
  useEffect(() => {
    if (!session.loaded) return;
    if (step === 'setup' && !session.signedIn) setStep('signin');
    else if (step === 'signin' && session.signedIn) setStep('setup');
  }, [step, session.loaded, session.signedIn]);

  const server = settings?.serverUrl || session.server || '';

  return html`<div class="welcome">
    ${step === null ? html`<div class="welcome-loading"><${Campfire} /><div class="loading"><${Spinner} label="" /> Getting things ready…</div></div>` : null}

    ${step === 'signin' ? html`<${SignInScreen} meta=${meta} metaError=${metaError} server=${server} joinCode=${joinCode}
        onRetry=${loadMeta} onDone=${(state) => { setSession(state); setStep('setup'); }} />` : null}

    ${step === 'server' ? html`<${ServerStep} settings=${settings} session=${session} onSettings=${setSettings}
        onBack=${settings?.serverUrl ? () => { if (!meta) loadMeta(); setStep(session.signedIn ? 'setup' : 'signin'); } : null}
        onDone=${(m, signedInHere) => { setMeta(m); setMetaError(''); setStep(signedInHere ? 'setup' : 'signin'); }} />` : null}

    ${step === 'setup' ? html`<${SetupScreen} session=${session} meta=${meta} settings=${settings} onSettings=${setSettings}
        joinCode=${joinCode}
        onSignedOut=${() => { setSession({ signedIn: false, server }); setStep('signin'); }} />` : null}

    ${step ? html`<p class="welcome-foot">
      ${server && step !== 'server'
        ? html`<span>Guild server: ${hostOf(server)} · <button type="button" class="link-btn" onClick=${() => setStep('server')}>Change</button></span>`
        : null}
      <span>Guild Camp${appVersion ? ` ${appVersion}` : ''}</span>
    </p>` : null}
  </div>`;
}

// ---------- first screen: sign in ----------

function SignInScreen({ meta, metaError, server, joinCode, onRetry, onDone }) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [tag, setTag] = useState('');
  const [tagError, setTagError] = useState('');
  const guild = meta?.guild || null;

  const finish = (state) => {
    if (state?.signedIn) { onDone(state); return; }
    setError('Sign-in did not finish. Try again when you are ready.');
  };

  const bnet = async () => {
    setError('');
    setBusy('bnet');
    try { finish(await gc.auth.signIn()); } catch (err) { setError(err?.message || 'Battle.net sign-in did not work. Try again in a minute.'); } finally { setBusy(''); }
  };

  const dev = async (e) => {
    e.preventDefault();
    setError('');
    setTagError('');
    if (!validBattleTag(tag)) { setTagError('Use a BattleTag like Name#1234.'); return; }
    setBusy('dev');
    try { finish(await gc.auth.devSignIn(tag.trim())); } catch (err) { setError(err?.message || 'Sign-in did not work.'); } finally { setBusy(''); }
  };

  // If the server could not be asked, still offer Battle.net: the sign-in window shows what is wrong.
  const bnetReady = !meta || meta.bnet !== false;
  const nobody = meta && meta.bnet === false && !meta.devLogin;

  return html`<div class="welcome-main">
    <header class="welcome-hero">
      <${Campfire} />
      ${guild
        ? html`<p class="welcome-kicker">Guild Camp</p>
          <h1 class="welcome-guild">${guild.name}</h1>
          ${guild.faction ? html`<p class="welcome-faction">${guild.faction}</p>` : null}`
        : html`<h1>Guild Camp</h1>`}
      <p class="welcome-lede">${guild
        ? html`Sign in once. Guild Camp finds your game, installs the addon and adds you to ${guild.name}.`
        : 'Sign in once. Guild Camp finds your game, installs the addon and sets up your guild.'}</p>
    </header>

    <${Card} class="welcome-card">
      ${joinCode && guild ? html`<${Notice} kind="info" icon="banner">You have an invite to <strong>${guild.name}</strong>. Sign in to use it.<//>` : null}
      ${metaError ? html`<${Notice} kind="warn" title=${`We couldn't reach ${hostOf(server) || 'the guild server'}.`}>
        Check your internet connection, or change the server below. <button type="button" class="link-btn" onClick=${onRetry}>Try again</button><//>` : null}
      ${error ? html`<${Notice} kind="alarm">${error}<//>` : null}

      <${Button} variant="primary" size="lg" icon="battlenet" block class="welcome-bnet" busy=${busy === 'bnet'}
        disabled=${!bnetReady || (!!busy && busy !== 'bnet')} onClick=${bnet}>Sign in with Battle.net<//>
      <p class="welcome-promise">${bnetReady
        ? 'A Battle.net window opens. Guild Camp only sees your BattleTag and your World of Warcraft characters, never your password.'
        : nobody
          ? 'Sign-in is not set up on this server yet. Ask the server owner to add the Battle.net keys.'
          : 'Battle.net sign-in is not set up on this server yet.'}</p>

      ${meta?.devLogin ? html`
        <div class="or-line">or, for testing</div>
        <form class="form-row" onSubmit=${dev} novalidate>
          <${Input} label="BattleTag (developer sign-in)" value=${tag} onValue=${setTag} placeholder="Name#1234" maxLength="40"
            error=${tagError} spellcheck="false" autocomplete="off" />
          <${Button} type="submit" busy=${busy === 'dev'} disabled=${!!busy && busy !== 'dev'}>Sign in<//>
        </form>` : null}
    <//>
  </div>`;
}

// ---------- server address ----------

function ServerStep({ settings, session, onSettings, onBack, onDone }) {
  const [address, setAddress] = useState(settings?.serverUrl || '');
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);
  const [found, setFound] = useState(null); // { url, meta }

  useEffect(() => { if (settings?.serverUrl && !address) setAddress(settings.serverUrl); }, [settings]);

  const check = async (e) => {
    e?.preventDefault();
    setError('');
    setFound(null);
    const n = normalizeServerUrl(address);
    if (n.error) { setError(n.error); return; }
    setChecking(true);
    try {
      if (n.url !== settings?.serverUrl) {
        // A device token only works on the server that issued it.
        if (session.signedIn) await gc.auth.signOut().catch(() => {});
        onSettings(await gc.settings.set({ serverUrl: n.url }));
      }
      setAddress(n.url);
      const meta = await api.get('/api/meta');
      if (!meta || meta.server !== 'guild-camp') {
        setError('That address answered, but it is not a Guild Camp server. Check the address with your guild officers.');
        return;
      }
      setFound({ url: n.url, meta });
    } catch (err) {
      if (err?.status === 404) setError('That address answered, but it is not a Guild Camp server. Check the address with your guild officers.');
      else if (err?.status && err.status !== 503) setError(`The server answered with a problem: ${err.message}`);
      else setError('We could not reach that server. Check the address and your internet connection.');
    } finally {
      setChecking(false);
    }
  };

  const signedInHere = !!(session.signedIn && found && hostOf(session.server) === hostOf(found.url));
  const m = found?.meta;

  return html`<div class="welcome-main">
    <header class="welcome-hero welcome-hero--small">
      <${Campfire} />
      <h1>Guild server</h1>
    </header>
    <${Card} class="welcome-card">
      <div>
        <h2>Which server is your guild on?</h2>
        <p class="lede">Your guild officers can tell you the address. It is the same site you used before.</p>
      </div>
      <form class="stack" onSubmit=${check} novalidate>
        <div class="form-row">
          <${Input} label="Server address" value=${address} onValue=${(v) => { setAddress(v); setFound(null); }}
            placeholder="https://wow.example.com" error=${error} autoFocus spellcheck="false" autocomplete="url" />
          <${Button} type="submit" busy=${checking} variant=${found ? 'secondary' : 'primary'}>Check<//>
        </div>
      </form>

      ${m ? html`<div class="stack">
        <ul class="meta-list">
          <li class="is-ok"><${Icon} name="ok" /><span>Found a Guild Camp server${m.version ? html` <span class="muted">(version ${m.version})</span>` : null}.</span></li>
          <li class="is-ok"><${Icon} name=${m.guild ? 'banner' : 'info'} />
            <span>${m.guild ? html`Guild: <strong>${m.guild.name}</strong>${m.guild.faction ? ` (${m.guild.faction})` : ''}.` : 'No guild here yet. Guild Camp helps you set it up after you sign in.'}</span></li>
          <li class=${m.bnet ? 'is-ok' : 'is-off'}><${Icon} name=${m.bnet ? 'ok' : 'off'} />
            <span>${m.bnet ? 'Battle.net sign-in is ready.' : 'Battle.net sign-in is not set up on this server.'}</span></li>
          ${m.devLogin ? html`<li class="is-ok"><${Icon} name="key" /><span>Developer sign-in is on (for testing).</span></li>` : null}
        </ul>
        ${!m.bnet && !m.devLogin ? html`<${Notice} kind="warn">Nobody can sign in to this server yet. Ask the server owner to add the Battle.net keys.<//>` : null}
        <div class="form-actions">
          <${Button} variant="primary" size="lg" iconRight="forward" onClick=${() => onDone(m, signedInHere)}
            disabled=${!m.bnet && !m.devLogin && !signedInHere}>Continue<//>
        </div>
      </div>` : null}
      ${onBack && !m ? html`<div class="form-actions"><${Button} variant="ghost" icon="back" onClick=${onBack}>Back<//></div>` : null}
    <//>
  </div>`;
}

// ---------- after sign-in: the automatic setup checklist ----------

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

function SetupScreen({ session, meta, settings, onSettings, joinCode, onSignedOut }) {
  const addon = useAddonStatus();
  const [installs, setInstalls] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [adding, setAdding] = useState(false);
  const [busyDir, setBusyDir] = useState('');
  const [result, setResult] = useState(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState('');
  const [checkedAt, setCheckedAt] = useState(null);
  const [bnet, setBnet] = useState(null);
  const [info, setInfo] = useState(null);
  const [auto, setAuto] = useState('on'); // 'on' | 'stopped': opening the camp by itself once all is set
  const [finishing, setFinishing] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const kicked = useRef(false);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  // ---- game folders ----
  const loadInstalls = useCallback(async () => {
    try {
      setLoadError('');
      const list = await gc.wow.installs();
      if (mounted.current) setInstalls(Array.isArray(list) ? list : []);
    } catch (err) {
      if (mounted.current) { setLoadError(err?.message || 'Could not look for the game.'); setInstalls([]); }
    }
  }, []);

  useEffect(() => {
    loadInstalls();
    gc.app.info().then((i) => mounted.current && setInfo(i || {}), () => mounted.current && setInfo({}));
    api.get('/api/me').then((m) => mounted.current && setBnet(m?.bnet || null), () => {});
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
      toast(err?.message || 'Could not add that folder.', 'alarm');
    } finally {
      if (mounted.current) setAdding(false);
    }
  };

  const installOne = async (dir) => {
    setBusyDir(dir);
    try {
      await gc.addon.install(dir);
      await addonLive.refresh();
      toast('Addon installed. Start the game or type /reload to load it.', 'ok');
    } catch (err) {
      toast(err?.message || 'Could not install the addon.', 'alarm');
    } finally {
      if (mounted.current) setBusyDir('');
    }
  };

  // ---- the guild ----
  const accept = useCallback((r) => {
    if (!r || typeof r !== 'object' || !STATUSES.has(r.status)) return;
    if (!mounted.current) return;
    setResult((prev) => mergeMembership(prev, r));
    setCheckedAt(Date.now());
    setCheckError('');
    if (MATCHED.has(r.status) && !getSession().guild) refreshSession().catch(() => {});
  }, []);

  const runCheck = useCallback(async () => {
    setChecking(true);
    try {
      accept(await gc.invoke('guild.autoJoin'));
    } catch (err) {
      if (mounted.current) { setCheckError(err?.message || 'Guild Camp could not reach the server.'); setCheckedAt(Date.now()); }
    } finally {
      if (mounted.current) setChecking(false);
    }
  }, [accept]);

  useEffect(() => {
    let live = true;
    (async () => {
      const last = await gc.invoke('membership.status').catch(() => null);
      if (!live) return;
      if (last) accept(last);
      if (!getSession().guild) runCheck();
    })();
    return () => { live = false; };
  }, []);
  useChannel('membership', accept);

  const games = gamesView(installs, loadError);
  const addonLine = addonView({ installs, addon, autoInstall: settings?.addonAutoInstall !== false });
  const guildLine = guildView({ result, guild: session.guild, role: session.role, checking, error: checkError, serverGuild: meta?.guild });
  const inGuild = !!session.guild;
  const ready = allSet({ inGuild, games, addon: addonLine });
  const counting = ready && auto === 'on' && !finishing;

  const finish = async () => {
    setFinishing(true);
    try { onSettings(await gc.settings.set({ onboarded: true })); } catch { /* not fatal */ }
    navigate('/', { replace: true });
  };

  useEffect(() => {
    if (!counting) return undefined;
    const t = setTimeout(finish, AUTO_CONTINUE_MS);
    return () => clearTimeout(t);
  }, [counting]);

  const setStartup = async (on) => {
    setAuto('stopped');
    try { onSettings(await gc.settings.set({ startWithWindows: on })); } catch (err) { toast(err?.message || 'Could not change that setting.', 'alarm'); }
  };

  const signOut = async () => {
    setSigningOut(true);
    try { await gc.auth.signOut(); } catch { /* signed out locally anyway */ }
    onSignedOut();
  };

  const user = session.user || {};
  const startupSupported = info ? info.startWithWindowsSupported !== false : true;
  const firstName = String(user.battletag || '').split('#')[0];

  return html`<div class="welcome-main welcome-main--setup">
    <header class="welcome-hero welcome-hero--small">
      <${Campfire} />
      <h1>${inGuild ? `Welcome to ${session.guild.name}` : firstName ? `Welcome, ${firstName}` : 'Welcome'}</h1>
      <p class="welcome-lede">${setupLede([games.state, addonLine.state, guildMark(guildLine.state)])}</p>
    </header>

    <${Card} class="welcome-card">
      <ul class="setup-list" aria-label="Setup" aria-live="polite">
        <${SetupItem} state="done" title=${`Signed in as ${user.battletag || 'you'}`}
          detail=${bnet && Number(bnet.characters) > 0
            ? `Battle.net shows ${plural(bnet.characters, 'character')} on your account.`
            : 'With your Battle.net account.'}
          aside=${html`<button type="button" class="link-btn" disabled=${signingOut} onClick=${signOut}>Not you? Sign out</button>`} />

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

        <${GuildItem} view=${guildLine} result=${result} meta=${meta} joinCode=${joinCode} checking=${checking}
          checkedAt=${checkedAt} onCheck=${runCheck} onJoined=${(r) => accept(r)} />
      </ul>

      <div class="setup-finish">
        <${Checkbox} label="Start Guild Camp with Windows" checked=${!!settings?.startWithWindows} disabled=${!settings || !startupSupported}
          onValue=${setStartup}
          hint=${startupSupported ? 'It starts quietly in the tray and keeps your guild in sync.' : 'Only the installed app can start with Windows.'} />
        <div class="form-actions setup-done">
          ${inGuild
            ? html`<${Button} variant="primary" size="lg" iconRight="forward" busy=${finishing} onClick=${finish}>Done<//>
              ${counting ? html`<span class="hint setup-countdown"><span class="setup-countdown-bar" aria-hidden="true"></span>Opening your camp…
                <button type="button" class="link-btn" onClick=${() => setAuto('stopped')}>Stay here</button></span>` : null}`
            : html`<p class="hint mb-0">You can close this window. Guild Camp keeps checking in the background, from the tray.</p>`}
        </div>
      </div>
    <//>
  </div>`;
}

// ---------- the "Your guild" line ----------

function GuildItem({ view, result, meta, joinCode, checking, checkedAt, onCheck, onJoined }) {
  const [creating, setCreating] = useState(false);
  const [ownName, setOwnName] = useState(false);
  const serverGuild = meta?.guild || null;

  const createDetected = async () => {
    const body = createGuildBody(view.detected);
    setCreating(true);
    try {
      const r = await api.post('/api/guild', body);
      await refreshSession();
      toast(`${body.name} is ready. You are its owner.`, 'ok');
      onJoined({ status: 'joined', guild: { id: r?.guild?.id ?? null, name: body.name, faction: body.faction }, role: 'owner', via: null, character: null, reason: 'You set up the guild.', detected: null });
    } catch (err) {
      toast(err?.message || 'Could not set up the guild. Try again.', 'alarm');
    } finally {
      setCreating(false);
    }
  };

  let body = null;
  if (view.state === 'setup' && !ownName) {
    body = html`<div class="stack stack--tight">
      <div class="setup-actions">
        <${Button} variant="primary" icon="banner" busy=${creating} onClick=${createDetected}>Set up ${view.detected.guild} on this server<//>
        <button type="button" class="link-btn" onClick=${() => setOwnName(true)}>Use a different name</button>
      </div>
      <p class="hint mb-0">You become its owner in Guild Camp. Everyone else in ${view.detected.guild} joins by signing in.</p>
    </div>`;
  } else if (view.state === 'setup' || view.state === 'create' || (view.state === 'error' && !serverGuild)) {
    body = html`<${CreateForm} initial=${view.detected ? createGuildBody(view.detected) : null} onJoined=${onJoined} />`;
  } else if (view.state === 'waiting' || view.state === 'error') {
    body = html`<div class="stack stack--tight">
      <p class="setup-waiting">
        ${checking ? html`<span class="spinner spinner--xs" aria-hidden="true"></span>` : html`<span class="setup-pulse" aria-hidden="true"></span>`}
        <span>${checking ? 'Checking now…' : html`Guild Camp keeps checking${checkedAt ? html` (last check <${TimeAgo} t=${checkedAt} />)` : null}.`}</span>
        ${checking ? null : html`<button type="button" class="link-btn" onClick=${onCheck}>Check now</button>`}
      </p>
      ${serverGuild || result?.guild ? html`<details class="setup-invite" open=${!!joinCode || result?.status === 'disabled'}>
        <summary>Have an invite link?</summary>
        <${JoinForm} guild=${result?.guild || serverGuild} initialCode=${joinCode} onJoined=${onJoined} />
      </details>` : null}
    </div>`;
  }

  return html`<${SetupItem} state=${guildMark(view.state)} title=${view.title} detail=${view.detail}>${body}<//>`;
}

function JoinForm({ guild, initialCode, onJoined }) {
  const [text, setText] = useState(initialCode || '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(null); // { code, name, faction } | { code, error }
  const code = parseInviteCode(text);
  const current = preview && preview.code === code ? preview : null;
  const seq = useRef(0);

  // Show which guild the invite is for, a moment after typing stops.
  useEffect(() => {
    if (!code) { setPreview(null); return undefined; }
    const id = ++seq.current;
    const t = setTimeout(async () => {
      try {
        const g = await api.get(`/api/guild/invite/${encodeURIComponent(code)}`);
        if (id === seq.current) setPreview({ code, name: g?.name || g?.guild?.name, faction: g?.faction || g?.guild?.faction });
      } catch (err) {
        if (id === seq.current) setPreview({ code, error: err?.message || 'That invite code does not work.' });
      }
    }, 350);
    return () => clearTimeout(t);
  }, [code]);

  const join = async (e) => {
    e.preventDefault();
    setError('');
    if (!code) { setError(text.trim() ? 'That does not look like an invite link or code.' : 'Paste the invite link or code.'); return; }
    setBusy(true);
    try {
      const r = await api.post('/api/guild/join', { code });
      const s = await refreshSession();
      const name = s.guild?.name || r?.guild?.name || guild?.name || 'the guild';
      toast(`Welcome to ${name}!`, 'ok');
      onJoined({ status: 'joined', guild: s.guild || r?.guild || null, role: r?.role || s.role || 'member', via: null, character: null, reason: 'You joined with an invite link.', detected: null });
    } catch (err) {
      setError(err?.message || 'That invite did not work. Ask an officer for a fresh link.');
    } finally {
      setBusy(false);
    }
  };

  const name = guild?.name || 'the guild';
  return html`<form class="setup-form" onSubmit=${join} novalidate>
    <div class="form-row">
      <${Input} label="Invite link or code" value=${text} onValue=${(v) => { setText(v); setError(''); }}
        error=${error || (current && current.error) || ''} spellcheck="false" autocomplete="off"
        placeholder="https://wow.example.com/join/AbC123"
        hint=${current && !current.error
          ? `This invite is for ${current.name || name}${current.faction ? ` (${current.faction})` : ''}.`
          : error || current ? '' : 'Paste the whole link. Guild Camp only needs the code at the end.'} />
      <${Button} type="submit" variant="primary" busy=${busy}>Join ${name}<//>
    </div>
  </form>`;
}

function CreateForm({ initial, onJoined }) {
  const [name, setName] = useState(initial?.name || '');
  const [faction, setFaction] = useState(initial?.faction || 'Horde');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const create = async (e) => {
    e.preventDefault();
    setError('');
    const n = name.trim();
    if (!n) { setError('Give the guild a name.'); return; }
    if (n.length > 40) { setError('Guild names can be up to 40 characters.'); return; }
    setBusy(true);
    try {
      const body = { name: n, faction };
      if (initial?.realm) body.realm = initial.realm;
      if (initial?.game_guild) body.game_guild = initial.game_guild;
      const r = await api.post('/api/guild', body);
      await refreshSession();
      toast(`${n} is ready. You are its owner.`, 'ok');
      onJoined({ status: 'joined', guild: { id: r?.guild?.id ?? null, name: n, faction }, role: 'owner', via: null, character: null, reason: 'You set up the guild.', detected: null });
    } catch (err) {
      setError(err?.message || 'Could not create the guild. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return html`<form class="setup-form stack stack--tight" onSubmit=${create} novalidate>
    <div class="setup-create-row">
      <${Input} label="Guild name" value=${name} onValue=${setName} maxLength="40" required error=${error} />
      <${Select} label="Faction" value=${faction} onValue=${setFaction} options=${['Horde', 'Alliance']} />
    </div>
    <div class="setup-actions">
      <${Button} type="submit" variant="primary" busy=${busy}>Create the guild<//>
      <span class="hint">You become its owner. Everyone else joins by signing in, or with your invite link.</span>
    </div>
  </form>`;
}
