// Settings: Battle.net (sign in, region, BattleTag, characters), desktop notifications, the Discord webhook this
// app posts to (officers can share it with the other officers through the addon, and use one another officer
// shared: GET /api/share/status webhookOffer, POST /api/share/webhook/accept|dismiss|share), the Coach's AI key,
// exporting raids to a calendar, how the app behaves on this PC, and version/log details for getting help.
// App settings go through gc.settings.set and arrive back on the 'settings' channel. Notification choices per kind
// live in the local guild data (GET /api/me → notifyPrefs, PUT /api/me/notifications).
// ?section=battlenet (or notifications, discord, coach, calendar, app, about) scrolls straight to that card.
import { html, cx, useState, useEffect, useRef, useCallback } from '../lib/html.js';
import { gc, useGcEvent } from '../lib/gc.js';
import { api, useApi } from '../lib/api.js';
import { useSession, setSession, splitBattleTag, refreshSession } from '../lib/session.js';
import { Link } from '../lib/router.js';
import { applyTheme, THEMES } from '../lib/theme.js';
import { plural } from '../lib/format.js';
import { useShareStatus, shareStatus as shareLive, syncStatus, savedLine, savedReply } from '../lib/status.js';
import {
  Page, Card, Table, Button, ConfirmButton, Checkbox, Input, Select, Notice, Pill, Icon, ErrorBox, Loading,
  ClassName, TimeAgo, toast,
} from '../components/index.js';
import { ShareHint } from '../components/ShareHint.js';

// ---------- helpers (exported for tests) ----------

export const SECTIONS = [
  { id: 'guild', label: 'Your guild', icon: 'camp' },
  { id: 'battlenet', label: 'Battle.net', icon: 'battlenet' },
  { id: 'notifications', label: 'Notifications', icon: 'bell' },
  { id: 'discord', label: 'Discord', icon: 'link' },
  { id: 'coach', label: 'Coach AI', icon: 'coach' },
  { id: 'overlay', label: 'Overlay & live', icon: 'spark' },
  { id: 'calendar', label: 'Calendar', icon: 'raids' },
  { id: 'app', label: 'App', icon: 'settings' },
  { id: 'about', label: 'About & help', icon: 'info' },
];
// Older links (?section=account) still land somewhere sensible.
const SECTION_ALIASES = { account: 'battlenet' };
const sectionDomId = (id) => `settings-${id}`;

/** The section a ?section= value means, or null. */
export function sectionFor(value) {
  const id = SECTION_ALIASES[value] || value;
  return SECTIONS.some((s) => s.id === id) ? id : null;
}

const guildKeyOf = (name, realm) => `${String(name || '').trim().toLowerCase()}|${String(realm || '').trim().toLowerCase()}`;

/**
 * The guilds to choose from: the ones Guild Camp has set up (GET /api/guilds), then guilds only seen in the
 * game's saved data (wow.detectGuild characters), each with the characters seen in it, newest first.
 */
export function guildOptions(choices, detected) {
  const out = [];
  const byKey = new Map();
  const realmLess = new Map(); // a set-up guild with no realm yet matches any realm of the same name
  for (const g of (choices && choices.guilds) || []) {
    const row = { ...g, characters: [], known: true };
    out.push(row);
    byKey.set(guildKeyOf(g.name, g.realm), row);
    if (!g.realm) realmLess.set(guildKeyOf(g.name, ''), row);
  }
  for (const c of (detected && detected.characters) || []) {
    if (!c || !c.guild) continue;
    const key = guildKeyOf(c.guild, c.realm);
    let row = byKey.get(key) || realmLess.get(guildKeyOf(c.guild, ''));
    if (!row) {
      row = { id: null, name: c.guild, realm: c.realm || null, faction: c.faction || null, lastPlayedAt: c.updated || null, myCharacters: 0, characters: [], known: false };
      out.push(row);
      byKey.set(key, row);
    }
    if (!row.characters.includes(c.name)) row.characters.push(c.name);
  }
  return out;
}

// The notifyPrefs switches, in the order shown. `officer` ones only matter to officers.
export const NOTIFY_KINDS = [
  { key: 'cta', label: 'Calls to arms', hint: 'Someone needs help in a fight.' },
  { key: 'raids', label: 'Raids and reminders', hint: 'New raids and events, and a reminder before they start.' },
  { key: 'notices', label: 'Guild notices', hint: 'Announcements from officers.' },
  { key: 'requests', label: 'Crafting requests', hint: 'Someone needs something you can craft.' },
  { key: 'bank', label: 'Bank requests', hint: 'Members asking the guild bank for items.', officer: true },
  { key: 'coach', label: 'Coach', hint: 'Your build plan or answer is ready.' },
  { key: 'drives', label: 'Supply drives', hint: 'New drives, and drives that reach their goal.' },
];

// Battle.net regions (settings.bnetRegion). "us" also covers Latin America and Oceania.
export const REGIONS = [
  { value: 'eu', label: 'Europe' },
  { value: 'us', label: 'Americas and Oceania' },
  { value: 'kr', label: 'Korea' },
  { value: 'tw', label: 'Taiwan' },
];
export const regionLabel = (r) => (REGIONS.find((x) => x.value === r) || REGIONS[0]).label;

/** "profile-classic1x-eu" → "Classic Era", "profile-classic-eu" → "Classic", "profile-eu" → "Retail". */
export function gameLabel(namespace) {
  const ns = String(namespace || '').toLowerCase();
  if (ns.startsWith('profile-classic1x-')) return 'Classic Era';
  if (ns.startsWith('profile-classic-')) return 'Classic';
  if (/^profile-[a-z]{2}$/.test(ns)) return 'Retail';
  return 'World of Warcraft';
}

// Same rule as the main process (store.js): a Discord webhook address.
const WEBHOOK_RE = /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\/[\w/-]+$/;
export const isWebhookUrl = (v) => typeof v === 'string' && v.trim().length <= 300 && WEBHOOK_RE.test(v.trim());

/** Shows which webhook is set without showing the part that lets anyone post: ".../webhooks/1234…/••••". */
export function maskWebhook(url) {
  const m = /^https:\/\/((?:discord|discordapp)\.com)\/api\/webhooks\/(\d+)\//.exec(String(url || '').trim());
  if (!m) return url ? 'A webhook is set.' : '';
  const id = m[2].length > 6 ? `${m[2].slice(0, 6)}…` : m[2];
  return `${m[1]}/api/webhooks/${id}/••••`;
}

// What the page says when an Anthropic key can't be saved (the main process checks it again).
export function keyProblem(value) {
  const v = String(value ?? '').trim();
  if (!v) return 'Paste your key first.';
  if (/\s/.test(v)) return "A key has no spaces. Copy it again from console.anthropic.com.";
  if (v.length < 20 || v.length > 300) return "That doesn't look like an Anthropic API key. It starts with sk-ant-.";
  return '';
}

const PLATFORMS = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };
export const platformName = (p) => PLATFORMS[p] || (p ? String(p) : 'Unknown');

// App settings, kept fresh from the 'settings' channel. change(patch) saves optimistically and rolls back on error.
function useAppSettings() {
  const [settings, setSettings] = useState(null);
  const ref = useRef(null);
  ref.current = settings;
  useEffect(() => {
    let live = true;
    gc.settings.get().then((s) => { if (live) setSettings(s); }, () => { if (live) setSettings({}); });
    return () => { live = false; };
  }, []);
  useGcEvent('settings', (s) => { if (s && typeof s === 'object') setSettings(s); });

  const change = useCallback(async (patch, success) => {
    const before = ref.current;
    setSettings((s) => ({ ...(s || {}), ...patch }));
    try {
      const next = await gc.settings.set(patch);
      if (next && typeof next === 'object') setSettings(next);
      if (success) toast(success, 'ok');
      return true;
    } catch (err) {
      setSettings(before);
      if (err?.code !== 'cancelled') toast(err?.message || "Couldn't change that setting.", 'alarm');
      return false;
    }
  }, []);
  return [settings, change];
}

function useAppInfo() {
  const [info, setInfo] = useState(null);
  useEffect(() => {
    let live = true;
    gc.app.info().then((i) => { if (live) setInfo(i || {}); }, () => { if (live) setInfo({}); });
    return () => { live = false; };
  }, []);
  return info;
}

// Which section is on screen, for the side navigation: the last card whose top has reached the top of the
// scrolling area, or the last card once the page is scrolled to the bottom (short cards never reach the top).
function useActiveSection(anchorRef) {
  const [active, setActive] = useState(SECTIONS[0].id);
  useEffect(() => {
    const scroller = anchorRef.current && anchorRef.current.closest('.content');
    if (!scroller) return undefined;
    let frame = 0;
    const update = () => {
      frame = 0;
      const box = scroller.getBoundingClientRect();
      if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4) {
        setActive(SECTIONS[SECTIONS.length - 1].id);
        return;
      }
      let current = SECTIONS[0].id;
      for (const s of SECTIONS) {
        const el = document.getElementById(sectionDomId(s.id));
        if (el && el.getBoundingClientRect().top - box.top <= Math.min(96, box.height / 3)) current = s.id;
      }
      setActive(current);
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(update); };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      scroller.removeEventListener('scroll', onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);
  return [active, setActive];
}

function scrollToSection(id, smooth = true) {
  const el = document.getElementById(sectionDomId(id));
  if (el) el.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
}

// A method an older main process may not have yet: a plain message instead of a broken page.
function invokeOptional(method, ...args) {
  return gc.invoke(method, ...args).catch((err) => {
    if (err?.status === 404) throw Object.assign(new Error("This version of Guild Camp can't do that yet. Update the app."), { status: 404 });
    throw err;
  });
}

// ---------- small building blocks ----------

// An on/off switch (a checkbox with role="switch").
function Switch({ checked, onValue, disabled = false, label }) {
  return html`<label class=${cx('settings-switch', disabled && 'is-disabled')}>
    <input type="checkbox" role="switch" checked=${!!checked} disabled=${disabled} aria-label=${label}
      onChange=${(e) => onValue?.(e.currentTarget.checked)} />
    <span class="settings-switch-track" aria-hidden="true"><span class="settings-switch-thumb"></span></span>
  </label>`;
}

// One line of a settings card: title and explanation on the left, the control on the right.
function Row({ title, hint, children, class: cls }) {
  return html`<div class=${cx('settings-row', cls)}>
    <div class="settings-row-text">
      <span class="settings-row-title">${title}</span>
      ${hint ? html`<span class="settings-row-hint">${hint}</span>` : null}
    </div>
    <div class="settings-row-control">${children}</div>
  </div>`;
}

function ToggleRow({ title, hint, checked, onValue, disabled }) {
  return html`<${Row} title=${title} hint=${hint}>
    <${Switch} label=${title} checked=${checked} onValue=${onValue} disabled=${disabled} />
  <//>`;
}

// A path shown in full, selectable, with buttons beside it.
function PathBox({ value, children, label }) {
  return html`<div class="settings-path">
    <code class="settings-path-text" title=${value} aria-label=${label}>${value || '—'}</code>
    ${children ? html`<div class="settings-path-actions">${children}</div>` : null}
  </div>`;
}

// ---------- page ----------

export default function SettingsPage({ query = {} }) {
  const session = useSession();
  const [settings, change] = useAppSettings();
  const info = useAppInfo();
  const layoutRef = useRef(null);
  const [active, setActive] = useActiveSection(layoutRef);

  // ?section=discord: jump to that card once the page has laid out.
  useEffect(() => {
    const id = sectionFor(query.section);
    if (!id) return undefined;
    setActive(id);
    const t = setTimeout(() => scrollToSection(id, false), 60);
    return () => clearTimeout(t);
  }, [query.section]);

  const go = (id) => { setActive(id); scrollToSection(id); };

  return html`<${Page} title="Settings" width="normal" class="settings-page">
    <div class="settings" ref=${layoutRef}>
      <nav class="settings-nav" aria-label="Settings sections">
        ${SECTIONS.map((s) => html`<button key=${s.id} type="button" class=${cx('settings-nav-link', active === s.id && 'is-active')}
            aria-current=${active === s.id ? 'true' : undefined} onClick=${() => go(s.id)}>
          <${Icon} name=${s.icon} /><span>${s.label}</span>
        </button>`)}
      </nav>
      <div class="settings-main">
        <${GuildCard} />
        <${BattleNetCard} bnet=${session.bnet} settings=${settings} change=${change} />
        <${NotificationsCard} settings=${settings} change=${change} isOfficer=${session.isOfficer} />
        <${DiscordCard} settings=${settings} change=${change} isOfficer=${session.isOfficer} />
        <${CoachCard} />
        <${OverlayCard} settings=${settings} change=${change} />
        <${CalendarCard} />
        <${AppCard} settings=${settings} change=${change} info=${info} />
        <${AboutCard} info=${info} />
      </div>
    </div>
  <//>`;
}

// ---------- your guild ----------

function GuildCard() {
  const [choices, setChoices] = useState(null);
  const [detected, setDetected] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(null); // the option key being chosen

  const load = useCallback(async () => {
    try { setChoices(await api.get('/api/guilds')); setError(''); } catch (err) { setError(err?.message || "Couldn't read your guilds."); }
    try { setDetected(await gc.wow.detectGuild()); } catch { setDetected(null); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const choose = async (key, body, label) => {
    setBusy(key);
    try {
      setChoices(await api.put('/api/guilds/choice', body));
      await refreshSession();
      toast(body.auto ? 'Guild Camp picks your guild by itself again.' : `Guild Camp uses ${label} now.`, 'ok');
      try { await gc.sync.now(); } catch { /* the next /reload syncs it */ }
    } catch (err) {
      toast(err?.message || "Couldn't change your guild.", 'alarm');
    } finally { setBusy(null); }
  };

  const options = guildOptions(choices, detected);
  const pinned = choices?.pinnedId ?? null;
  const auto = choices && !pinned;
  const where = (g) => [g.realm, g.faction].filter(Boolean).join(' · ');
  const who = (g) => (g.characters.length ? g.characters.join(', ')
    : g.myCharacters ? plural(g.myCharacters, 'character') : 'No characters of yours seen yet');

  return html`<${Card} id=${sectionDomId('guild')} title="Your guild" class="settings-card"
      actions=${choices ? html`<${Pill} kind=${auto ? 'muted' : 'ok'} dot>${auto ? 'Automatic' : 'Chosen by you'}<//>` : null}>
    <div class="stack">
      <p class="mb-0">Guild Camp works with one guild at a time. By itself it follows the character you played last, which
        can pick the wrong guild when you play in more than one. Choose yours to keep it.</p>
      ${error ? html`<${Notice} kind="alarm">${error}<//>` : null}
      ${!choices && !error ? html`<${Loading} label="Looking for your guilds…" />` : null}
      ${choices ? html`<div>
        <${Row} title="Automatic" hint="The guild of the character you played last.">
          ${auto ? html`<${Pill} kind="ok">In use<//>`
            : html`<${Button} size="sm" busy=${busy === 'auto'} disabled=${!!busy} onClick=${() => choose('auto', { auto: true })}>Use automatic<//>`}
        <//>
        ${options.map((g) => {
          const key = g.id ? `id:${g.id}` : guildKeyOf(g.name, g.realm);
          const chosen = pinned != null && g.id === pinned;
          const current = g.id != null && g.id === choices.currentId;
          return html`<${Row} key=${key} title=${html`${g.name}${where(g) ? html` <span class="muted">${where(g)}</span>` : null}`}
              hint=${`${who(g)}${current && !chosen ? ' · in use now' : ''}`}>
            ${chosen ? html`<${Pill} kind="ok">Chosen<//>`
              : html`<${Button} size="sm" variant=${current ? 'secondary' : 'primary'} busy=${busy === key} disabled=${!!busy}
                  onClick=${() => choose(key, g.id ? { id: g.id } : { name: g.name, realm: g.realm, faction: g.faction }, g.name)}>Use this guild<//>`}
          <//>`;
        })}
        ${!options.length ? html`<p class="hint mb-0">No guild found yet. Log in to a character in your guild with the addon, then log out or type /reload.</p>` : null}
      </div>` : null}
      <p class="hint mb-0">Only game folders in use are searched: WoW Forever, and any other game you turned on under <${Link} href="/addon">Addon & sync<//>.</p>
    </div>
  <//>`;
}

// ---------- 1. Battle.net ----------

function BattleNetCard({ bnet, settings, change }) {
  const [busy, setBusy] = useState(''); // 'signin' | 'refresh' | ''
  const [error, setError] = useState('');
  const seq = useRef(0);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const region = settings?.bnetRegion || bnet.region || 'eu';
  const waiting = busy === 'signin' || bnet.signingIn;

  const signIn = async () => {
    const id = ++seq.current;
    setError('');
    setBusy('signin');
    try {
      const s = await gc.auth.signIn();
      setSession({ bnet: s });
      if (s?.signedIn) toast(`Signed in to Battle.net as ${s.battletag}.`, 'ok');
    } catch (err) {
      if (mounted.current && id === seq.current && err?.code !== 'cancelled') setError(err?.message || "Battle.net sign-in didn't work. Try again.");
    } finally {
      if (mounted.current && id === seq.current) setBusy('');
    }
  };

  // Also stops a sign-in that is still waiting for the browser.
  const signOut = async () => {
    seq.current += 1;
    setBusy('');
    setError('');
    const s = await gc.auth.signOut();
    setSession({ bnet: s });
    if (bnet.signedIn) toast('Signed out of Battle.net. Guild Camp forgot your BattleTag and characters.', 'ok');
  };

  const refresh = async () => {
    setError('');
    setBusy('refresh');
    try {
      const s = await gc.auth.state({ refresh: true });
      setSession({ bnet: s });
      if (!s?.signedIn) toast(s?.error || 'You are signed out of Battle.net.', 'warn');
      else if (s.error) toast(s.error, 'warn');
      else toast(`Characters updated: ${plural(s.characters?.length || 0, 'character')}.`, 'ok');
    } catch (err) {
      toast(err?.message || "Couldn't read your characters. Try again.", 'alarm');
    } finally {
      if (mounted.current) setBusy('');
    }
  };

  const setRegion = (value) => change({ bnetRegion: value }, `Battle.net region: ${regionLabel(value)}.`);

  if (!bnet.available) {
    return html`<${Card} id=${sectionDomId('battlenet')} title="Battle.net" class="settings-card">
      <${Notice} kind="info" title="Battle.net sign-in isn't part of this copy of Guild Camp.">
        Everything else works without it. Installed copies of Guild Camp can sign in to show your BattleTag and list your characters.
      <//>
    <//>`;
  }

  const regionRow = html`<${Row} title="Region" hint="Where your World of Warcraft account plays.">
    <${Select} label="" aria-label="Battle.net region" value=${region} options=${REGIONS} disabled=${!settings || waiting}
      onValue=${setRegion} />
  <//>`;

  if (!bnet.signedIn) {
    return html`<${Card} id=${sectionDomId('battlenet')} title="Battle.net" class="settings-card"
        actions=${html`<${Pill} kind="muted" dot>Not signed in<//>`}>
      <div class="stack">
        <p class="mb-0">Sign in to show your BattleTag and list your World of Warcraft characters. Your web browser opens
          Battle.net. Guild Camp never sees your password.</p>
        ${error ? html`<${Notice} kind="alarm">${error}<//>` : null}
        ${!error && bnet.error ? html`<${Notice} kind="warn">${bnet.error}<//>` : null}
        ${waiting
          ? html`<${Notice} kind="info" icon="battlenet" title="Finish signing in in your web browser.">
              Didn't see Battle.net open? <button type="button" class="link-btn" onClick=${signIn}>Open it again</button> or <button type="button" class="link-btn" onClick=${() => signOut().catch(() => {})}>cancel</button>.
            <//>`
          : html`<div class="actions-row"><${Button} variant="primary" icon="battlenet" onClick=${signIn}>Sign in with Battle.net<//></div>`}
        ${regionRow}
      </div>
    <//>`;
  }

  const { name, digits } = splitBattleTag(bnet.battletag);
  const otherRegion = region !== bnet.region;
  const columns = [
    { key: 'name', label: 'Character', sortable: true, render: (c) => html`<${ClassName} name=${c.name} cls=${c.class} link=${false} />` },
    { key: 'level', label: 'Level', sortable: true, num: true, width: '70px', render: (c) => (c.level ?? html`<span class="muted">—</span>`) },
    { key: 'realm', label: 'Realm', sortable: true },
    { key: 'namespace', label: 'Game', sortable: true, value: (c) => gameLabel(c.namespace), render: (c) => gameLabel(c.namespace) },
    { key: 'guild', label: 'Guild', sortable: true, render: (c) => c.guild || html`<span class="muted">—</span>` },
  ];

  return html`<${Card} id=${sectionDomId('battlenet')} title="Battle.net" class="settings-card"
      actions=${html`<${ConfirmButton} icon="signout" question="Sign out of Battle.net?" yes="Sign out" onConfirm=${signOut}>Sign out<//>`}>
    <div class="settings-who">
      <span class="settings-avatar" aria-hidden="true">${(name || '?').slice(0, 1).toUpperCase()}</span>
      <div class="settings-who-text">
        <span class="settings-who-tag">${name || 'Signed in'}${digits ? html`<span class="settings-who-digits">#${digits}</span>` : null}</span>
        <span class="muted">Battle.net · ${regionLabel(bnet.region)}</span>
        <span class="hint">To use another Battle.net account, sign out here and on battle.net in your browser, then sign in again.</span>
      </div>
    </div>

    ${error ? html`<${Notice} kind="alarm">${error}<//>` : null}
    ${bnet.error ? html`<${Notice} kind="warn">${bnet.error}<//>` : null}

    <div class="settings-sub">
      <div class="row row--between">
        <h3 class="settings-sub-title mb-0">Your characters</h3>
        ${bnet.canRefresh
          ? html`<${Button} size="sm" icon="refresh" busy=${busy === 'refresh'} onClick=${refresh}>Refresh<//>`
          : html`<${Button} size="sm" icon="battlenet" busy=${waiting} onClick=${signIn}>Sign in again to update<//>`}
      </div>
      <p class="hint">${bnet.profileAt
        ? html`From Battle.net, <${TimeAgo} t=${bnet.profileAt} />. Retail, Classic and Classic Era.`
        : 'Retail, Classic and Classic Era characters on your account.'}
        ${!bnet.canRefresh ? ' Battle.net sign-ins last about a day, so updating the list needs a new sign-in.' : ''}</p>
      ${otherRegion && !bnet.canRefresh ? html`<${Notice} kind="info">Sign in again to load your characters from ${regionLabel(region)}.<//>` : null}
      <div class="settings-table">
        <${Table} columns=${columns} rows=${bnet.characters} rowKey=${(c) => `${c.namespace}|${c.realm_slug}|${c.name}`} dense
          empty="Battle.net shows no World of Warcraft characters on this account yet." />
      </div>
    </div>
    <div class="settings-sub">${regionRow}</div>
  <//>`;
}

// ---------- 2. notifications ----------

function NotificationsCard({ settings, change, isOfficer }) {
  const me = useApi('/api/me', { focus: false });
  const [prefs, setPrefs] = useState(null);
  const [testing, setTesting] = useState(false);
  useEffect(() => {
    const p = me.data && me.data.notifyPrefs;
    if (p && typeof p === 'object') setPrefs(p);
  }, [me.data]);

  const master = settings ? settings.notifications !== false : true;
  const kinds = NOTIFY_KINDS.filter((k) => !k.officer || isOfficer);
  const unsupported = !!me.data && !(me.data.notifyPrefs && typeof me.data.notifyPrefs === 'object');

  const setPref = async (key, on) => {
    const before = prefs;
    setPrefs((p) => ({ ...(p || {}), [key]: on }));
    try {
      const r = await api.put('/api/me/notifications', { [key]: on });
      if (r?.notifyPrefs && typeof r.notifyPrefs === 'object') setPrefs(r.notifyPrefs);
    } catch (err) {
      setPrefs(before);
      toast(err?.message || "Couldn't save that choice.", 'alarm');
    }
  };

  const test = async () => {
    setTesting(true);
    try {
      await gc.notify.test();
      toast('Test sent. If nothing popped up, check the Windows notification settings for Guild Camp.', 'ok');
    } catch (err) {
      toast(err?.message || "Couldn't show a notification.", 'alarm');
    } finally {
      setTesting(false);
    }
  };

  let body;
  if (me.error && !prefs) body = html`<${ErrorBox} error=${me.error} title="Couldn't load your choices." onRetry=${me.reload} />`;
  else if (unsupported) body = html`<p class="hint mb-0">Choosing by kind isn't available in this version. You get all of them.</p>`;
  else if (!prefs) body = html`<${Loading} label="Loading your choices…" />`;
  else {
    body = html`<div class="settings-kinds">
      ${kinds.map((k) => html`<${Checkbox} key=${k.key} label=${k.label} hint=${k.hint}
        checked=${prefs[k.key] !== false} disabled=${!master} onValue=${(on) => setPref(k.key, on)} />`)}
    </div>`;
  }

  return html`<${Card} id=${sectionDomId('notifications')} title="Notifications" class="settings-card"
      footer=${html`<div class="row row--between">
        <span>Guild Camp shows these while it runs, also from the tray.</span>
        <${Button} size="sm" icon="bell" busy=${testing} onClick=${test}>Send a test notification<//>
      </div>`}>
    <${ToggleRow} title="Desktop notifications" checked=${master} disabled=${!settings}
      hint="Pop-ups from Guild Camp when something happens in the guild, even while you play."
      onValue=${(on) => change({ notifications: on }, on ? 'Desktop notifications are on.' : 'Desktop notifications are off.')} />
    <div class=${cx('settings-sub', !master && 'is-off')}>
      <h3 class="settings-sub-title">Tell me about</h3>
      ${!master ? html`<p class="hint">Turn on desktop notifications to get these.</p>` : null}
      ${body}
    </div>
  <//>`;
}

// ---------- 3. Discord webhook ----------

/** "Velanne shared a Discord webhook. Use it?" for GET /api/share/status webhookOffer ({ from, at }), or ''. */
export function webhookOfferText(offer) {
  if (!offer || typeof offer !== 'object') return '';
  const from = typeof offer.from === 'string' && offer.from.trim() ? offer.from.trim() : 'An officer';
  return `${from} shared a Discord webhook. Use it?`;
}

// Discord posts go out when the game confirms a change reached the guild, not when it is saved here.
export const WEBHOOK_SAVED = 'Saved. What you create in Guild Camp posts to that Discord channel once it goes out to your guild.';

// An officer shared the guild's webhook over the officer channel in game: use it here, or not now.
function WebhookOffer({ offer, current, change }) {
  const [busy, setBusy] = useState('');
  const accept = async () => {
    setBusy('use');
    try {
      const r = await api.post('/api/share/webhook/accept');
      if (r && r.url) await change({ discordWebhook: r.url }, WEBHOOK_SAVED);
    } catch (err) {
      toast(err?.message || "Couldn't use that webhook. Please try again.", 'alarm');
    } finally {
      setBusy('');
      shareLive.refresh();
    }
  };
  const dismiss = async () => {
    setBusy('dismiss');
    try {
      await api.post('/api/share/webhook/dismiss');
    } catch (err) {
      toast(err?.message || 'That did not work. Please try again.', 'alarm');
    } finally {
      setBusy('');
      shareLive.refresh();
    }
  };
  return html`<${Notice} kind="info" icon="link" class="settings-webhook-offer">
    <p class="mb-0"><strong>${webhookOfferText(offer)}</strong>${current ? ' It replaces the webhook you have now.' : ''}</p>
    <div class="row settings-webhook-offer-actions">
      <${Button} size="sm" variant="primary" busy=${busy === 'use'} disabled=${Boolean(busy)} onClick=${accept}>Use it<//>
      <${Button} size="sm" variant="ghost" busy=${busy === 'dismiss'} disabled=${Boolean(busy)} onClick=${dismiss}>Not now<//>
    </div>
  <//>`;
}

export function ShareWebhook() {
  const [busy, setBusy] = useState(false);
  const share = async () => {
    setBusy(true);
    try {
      const r = await api.post('/api/share/webhook/share');
      toast(savedReply(r && r.message, syncStatus.get()) || savedLine(syncStatus.get()), 'ok');
    } catch (err) {
      toast(err?.message || "Couldn't share the webhook. Please try again.", 'alarm');
    } finally {
      setBusy(false);
      shareLive.refresh();
    }
  };
  return html`<div class="settings-webhook-share">
    <div class="row">
      <${Button} size="sm" icon="partners" busy=${busy} onClick=${share}>Share with officers<//>
      <span class="hint">Other officers' Guild Camp asks them whether to use it. Only officers get it.</span>
    </div>
    <${ShareHint} officer />
  </div>`;
}

function DiscordCard({ settings, change, isOfficer }) {
  const current = settings?.discordWebhook || '';
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const share = useShareStatus();
  const offer = share?.data?.webhookOffer || null;
  const showForm = !current || editing;

  const save = async (e) => {
    e?.preventDefault();
    const v = value.trim();
    if (!v) { setError('Paste the webhook URL first.'); return; }
    if (!isWebhookUrl(v)) {
      setError("That isn't a Discord webhook URL. It starts with https://discord.com/api/webhooks/.");
      return;
    }
    setError('');
    setSaving(true);
    const ok = await change({ discordWebhook: v }, WEBHOOK_SAVED);
    setSaving(false);
    if (ok) { setValue(''); setEditing(false); }
  };

  const remove = async () => {
    if (await change({ discordWebhook: null }, 'Webhook removed. Guild Camp no longer posts to Discord.')) {
      setEditing(false);
      setValue('');
    }
  };

  return html`<${Card} id=${sectionDomId('discord')} title="Discord" class="settings-card"
      actions=${html`<${Pill} kind=${current ? 'ok' : 'muted'} dot>${current ? 'Posting to Discord' : 'Not set'}<//>`}>
    <div class="stack">
      <p class="mb-0">Guild Camp can post to a channel in your guild's Discord when something <strong>you</strong> create here goes out to
        your guild: a raid you schedule, a call to arms, a notice or a request. It only posts what you create, so nothing shows up twice
        when guildmates use it too.</p>

      ${offer ? html`<${WebhookOffer} offer=${offer} current=${current} change=${change} />` : null}

      ${current && !editing ? html`<${PathBox} value=${maskWebhook(current)} label="Discord webhook">
          <${Button} size="sm" icon="edit" onClick=${() => { setEditing(true); setError(''); }}>Change<//>
          <${ConfirmButton} question="Stop posting to Discord?" yes="Remove" onConfirm=${remove}>Remove<//>
        <//>` : null}

      ${current && !editing && isOfficer ? html`<${ShareWebhook} />` : null}

      ${showForm ? html`<form class="stack stack--tight" onSubmit=${save} novalidate>
          <div class="form-row">
            <${Input} label="Webhook URL" type="password" value=${value} onValue=${(v) => { setValue(v); setError(''); }}
              placeholder="https://discord.com/api/webhooks/…" error=${error} spellcheck="false" autocomplete="off" disabled=${!settings} />
            <${Button} type="submit" variant="primary" busy=${saving} disabled=${!settings}>Save<//>
            ${editing ? html`<${Button} variant="ghost" onClick=${() => { setEditing(false); setValue(''); setError(''); }}>Cancel<//>` : null}
          </div>
          <p class="hint mb-0">In Discord: Server Settings → Integrations → Webhooks → New Webhook. Pick the channel, then Copy Webhook URL.
            Anyone with this address can post to that channel, so keep it to yourself.</p>
        </form>` : null}
    </div>
  <//>`;
}

// ---------- 4. Coach AI key ----------

function CoachCard() {
  const [has, setHas] = useState(null); // null while asking
  const [unavailable, setUnavailable] = useState('');
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [plainText, setPlainText] = useState(false);

  useEffect(() => {
    let live = true;
    invokeOptional('secrets.has', 'anthropicKey')
      .then((v) => { if (live) setHas(!!v); })
      .catch((err) => { if (live) { setHas(false); setUnavailable(err?.message || "Guild Camp couldn't check for a key."); } });
    return () => { live = false; };
  }, []);

  const save = async (e) => {
    e?.preventDefault();
    const problem = keyProblem(value);
    if (problem) { setError(problem); return; }
    setError('');
    setSaving(true);
    try {
      const r = await invokeOptional('secrets.set', 'anthropicKey', value.trim());
      setValue(''); // never keep the key on the page
      setHas(true);
      setEditing(false);
      setPlainText(r && r.encrypted === false);
      toast('Key saved. The Coach can answer with AI now.', 'ok');
    } catch (err) {
      setError(err?.message || "Couldn't save the key. Try again.");
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    await invokeOptional('secrets.set', 'anthropicKey', null);
    setHas(false);
    setEditing(false);
    setPlainText(false);
    toast("Key removed. The Coach's AI answers are off.", 'ok');
  };

  const showForm = has === false || editing;
  const keysLink = 'https://console.anthropic.com/settings/keys';

  return html`<${Card} id=${sectionDomId('coach')} title="Coach AI" class="settings-card"
      actions=${has === null ? null : html`<${Pill} kind=${has ? 'ok' : 'muted'} dot>${has ? 'Key saved' : 'No key'}<//>`}>
    <div class="stack">
      <p class="mb-0">The Coach can answer your questions with Claude, Anthropic's AI. It uses your own Anthropic API key,
        so Anthropic bills you for what you ask. The key stays on this PC, encrypted, and Guild Camp never shows it again.</p>
      ${unavailable ? html`<${Notice} kind="warn">${unavailable}<//>` : null}
      ${plainText ? html`<${Notice} kind="warn">This PC has no secure storage, so the key is saved without encryption.<//>` : null}

      ${has && !editing ? html`<div class="actions-row">
          <${Button} size="sm" icon="key" onClick=${() => { setEditing(true); setError(''); }}>Replace key<//>
          <${ConfirmButton} question="Remove your key?" yes="Remove" onConfirm=${remove}>Remove key<//>
        </div>` : null}

      ${showForm && !unavailable ? html`<form class="stack stack--tight" onSubmit=${save} novalidate>
          <div class="form-row">
            <${Input} label="Anthropic API key" type="password" value=${value} onValue=${(v) => { setValue(v); setError(''); }}
              placeholder="sk-ant-…" error=${error} spellcheck="false" autocomplete="off" />
            <${Button} type="submit" variant="primary" busy=${saving}>Save key<//>
            ${editing ? html`<${Button} variant="ghost" onClick=${() => { setEditing(false); setValue(''); setError(''); }}>Cancel<//>` : null}
          </div>
          <p class="hint mb-0">No key yet? Make one at <${Link} href=${keysLink}>console.anthropic.com<//>, then paste it here.</p>
        </form>` : null}
    </div>
  <//>`;
}

// ---------- 5. calendar ----------

function CalendarCard() {
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(null);

  const exportIcs = async () => {
    setBusy(true);
    try {
      const file = await invokeOptional('calendar.export');
      if (file) {
        setSaved(file);
        toast('Calendar file saved. Open it to add the raids to your calendar.', 'ok');
      }
    } catch (err) {
      toast(err?.message || "Couldn't save the calendar file.", 'alarm');
    } finally {
      setBusy(false);
    }
  };

  const show = async () => {
    try { await gc.app.showItemInFolder(saved); } catch (err) { toast(err?.message || "Couldn't show the file.", 'alarm'); }
  };

  return html`<${Card} id=${sectionDomId('calendar')} title="Calendar" class="settings-card">
    <div class="stack">
      <p class="mb-0">Save the guild's raids and events as a calendar file, with a reminder 30 minutes before each one.
        Open it with Outlook or Apple Calendar, or import it into Google Calendar.</p>
      <div class="actions-row">
        <${Button} variant="primary" icon="download" busy=${busy} onClick=${exportIcs}>Export raids to your calendar<//>
      </div>
      ${saved ? html`<${PathBox} value=${saved} label="Saved calendar file">
          <${Button} size="sm" icon="folder" onClick=${show}>Show in folder<//>
        <//>` : null}
      <p class="hint mb-0">The file doesn't change by itself. Export it again when raids change.</p>
    </div>
  <//>`;
}

// ---------- 6. app ----------

function AppCard({ settings, change, info }) {
  const s = settings || {};
  const ready = !!settings;
  const startupSupported = info ? info.startWithWindowsSupported !== false : true;

  const setTheme = async (theme) => {
    const before = s.theme || 'system';
    applyTheme(theme); // show it straight away; the saved value follows
    if (!(await change({ theme }))) applyTheme(before);
  };

  return html`<${Card} id=${sectionDomId('app')} title="App" class="settings-card">
    <${Row} title="Theme" hint="Match Windows follows your light or dark mode setting.">
      <div class="settings-seg" role="radiogroup" aria-label="Theme">
        ${THEMES.map((t) => html`<button key=${t.value} type="button" role="radio" aria-checked=${(s.theme || 'system') === t.value ? 'true' : 'false'}
            class=${cx('settings-seg-opt', (s.theme || 'system') === t.value && 'is-on')} disabled=${!ready}
            onClick=${() => setTheme(t.value)}>${t.label}</button>`)}
      </div>
    <//>
    <${ToggleRow} title="Start with Windows" checked=${s.startWithWindows} disabled=${!ready || !startupSupported}
      hint=${startupSupported ? 'Starts quietly in the tray when you sign in to Windows, so your guild stays in sync.' : 'Only the installed app can start with Windows.'}
      onValue=${(on) => change({ startWithWindows: on }, on ? 'Guild Camp will start with Windows.' : 'Guild Camp will no longer start with Windows.')} />
    <${ToggleRow} title="Keep running when I close the window" checked=${s.closeToTray} disabled=${!ready}
      hint="Guild Camp stays in the tray and keeps syncing while you play. Quit from the tray icon."
      onValue=${(on) => change({ closeToTray: on })} />
    <${ToggleRow} title="Update the app automatically" checked=${s.appAutoUpdate} disabled=${!ready}
      hint="Downloads new versions of Guild Camp and installs them the next time it starts."
      onValue=${(on) => change({ appAutoUpdate: on }, on ? 'App updates will download by themselves.' : 'App updates will wait for you.')} />
    <${ToggleRow} title="Update the addon automatically" checked=${s.addonAutoUpdate} disabled=${!ready}
      hint="Keeps the Guild Camp addon up to date in every game folder. It updates while World of Warcraft is closed."
      onValue=${(on) => change({ addonAutoUpdate: on }, on ? 'The addon will update by itself.' : 'Addon updates will wait for you.')} />
    <${ToggleRow} title="Install the addon in new game folders automatically" checked=${s.addonAutoInstall !== false} disabled=${!ready}
      hint="When Guild Camp finds a game folder without the addon, it installs it there for you while World of Warcraft is closed."
      onValue=${(on) => change({ addonAutoInstall: on }, on ? 'New game folders get the addon by themselves.' : 'New game folders will wait for you to install the addon.')} />
    <${ToggleRow} title="Sync with the game" checked=${s.syncEnabled} disabled=${!ready}
      hint=${html`Reads your characters, professions and bank after each /reload or logout, and passes guild news back to the addon. Details on <${Link} href="/addon">Addon & sync<//>.`}
      onValue=${(on) => change({ syncEnabled: on }, on ? 'Sync is on.' : 'Sync is off. Guild Camp stops reading the game.')} />
  <//>`;
}

// ---------- Coach overlay and live link (main/overlay.js, main/live.js) ----------

const HOTKEYS = ['CommandOrControl+Shift+G', 'CommandOrControl+Shift+C', 'Alt+Shift+G', 'Alt+F1', 'CommandOrControl+F12'];
const keyLabel = (k) => String(k || '').replace(/CommandOrControl|CmdOrCtrl/, 'Ctrl');

function OverlayCard({ settings, change }) {
  const s = settings || {};
  const ready = !!settings;
  const [live, setLive] = useState(null);
  useEffect(() => { gc.live.state().then(setLive, () => {}); }, []);
  useGcEvent('live', setLive);
  const hotkeys = HOTKEYS.includes(s.overlayHotkey) || !s.overlayHotkey ? HOTKEYS : [s.overlayHotkey, ...HOTKEYS];
  const liveLine = s.liveLink === false ? 'Off.'
    : !live ? 'Checking…'
      : live.status === 'live' ? `On: following ${live.game || 'the game'}'s combat log.`
        : live.status === 'waiting' ? 'On: combat logging is on, waiting for your next fight.'
          : 'On, but the game isn\'t writing a combat log. In game, type /combatlog, or /wow live on so the addon turns it on at every login.';
  return html`<${Card} id=${sectionDomId('overlay')} title="Overlay & live link" class="settings-card">
    <${ToggleRow} title="Coach overlay" checked=${s.overlayEnabled !== false} disabled=${!ready}
      hint=${`A small window that stays on top of the game: your session, last death, next steps and a quick Ask box. Play WoW in "Windowed (Fullscreen)" mode to see it.`}
      onValue=${(on) => change({ overlayEnabled: on }, on ? 'The Coach overlay is on.' : 'The Coach overlay is off.')} />
    <${Row} title="Hotkey" hint="Shows or hides the overlay, even while the game has focus.">
      <div class="row nowrap">
        <select class="select" disabled=${!ready || s.overlayEnabled === false} value=${s.overlayHotkey}
          onChange=${(e) => change({ overlayHotkey: e.currentTarget.value }, `The overlay hotkey is now ${keyLabel(e.currentTarget.value)}.`)}>
          ${hotkeys.map((k) => html`<option key=${k} value=${k} selected=${k === s.overlayHotkey}>${keyLabel(k)}</option>`)}
        </select>
        <${Button} size="sm" variant="secondary" disabled=${s.overlayEnabled === false} onClick=${() => gc.overlay.toggle()}>Show it now<//>
      </div>
    <//>
    <${Row} title="See-through" hint="How solid the overlay is over the game.">
      <input class="range" type="range" min="40" max="100" step="5" disabled=${!ready} value=${Math.round((s.overlayOpacity || 0.94) * 100)}
        aria-label="Overlay opacity" onChange=${(e) => change({ overlayOpacity: Number(e.currentTarget.value) / 100 })} />
    <//>
    <${ToggleRow} title="Live link" checked=${s.liveLink !== false} disabled=${!ready}
      hint=${html`Follows the game's combat log while you play, for live kills, deaths and "Why did I die?". ${liveLine}`}
      onValue=${(on) => change({ liveLink: on }, on ? 'The live link is on.' : 'The live link is off.')} />
    <${ToggleRow} title="War alerts on Discord" checked=${s.warAlerts !== false} disabled=${!ready || s.liveLink === false}
      hint="When the live link sees you die to players, post who and where to the guild's Discord (at most every 2 minutes), so guildies nearby can help."
      onValue=${(on) => change({ warAlerts: on }, on ? 'War alerts are on.' : 'War alerts are off.')} />
  <//>`;
}

// ---------- 7. about & help ----------

function AboutCard({ info }) {
  const open = async (fn, path) => {
    try { await fn(path); } catch (err) { toast(err?.message || "Couldn't open that.", 'alarm'); }
  };
  if (!info) {
    return html`<${Card} id=${sectionDomId('about')} title="About & help" class="settings-card"><${Loading} /><//>`;
  }
  return html`<${Card} id=${sectionDomId('about')} title="About & help" class="settings-card">
    <div class="settings-about">
      <div class="settings-version">
        <span class="settings-version-name">Guild Camp ${info.version || ''}</span>
        ${info.isPackaged === false ? html`<${Pill} kind="info">Development build<//>` : null}
      </div>
      <span class="hint">${[platformName(info.platform), info.arch, info.electron ? `Electron ${info.electron}` : null].filter(Boolean).join(' · ')}</span>
      <div class="actions-row">
        <${Button} size="sm" href="/updates" icon="updates">Updates<//>
        <${Button} size="sm" href="/addon" icon="addon">Addon & sync<//>
      </div>
    </div>
    ${info.secretsEncrypted === false ? html`<${Notice} kind="warn">This PC has no secure storage, so your Battle.net sign-in and API key are saved without encryption.<//>` : null}
    ${info.userData ? html`<div class="settings-file">
      <div class="settings-row-text">
        <span class="settings-row-title">Data folder</span>
        <span class="settings-row-hint">Your guild data, settings, Battle.net sign-in and logs on this PC.</span>
      </div>
      <${PathBox} value=${info.userData} label="Data folder">
        <${Button} size="sm" icon="folder" onClick=${() => open(gc.app.openPath, info.userData)}>Open folder<//>
      <//>
    </div>` : null}
    ${info.logFile ? html`<div class="settings-file">
      <div class="settings-row-text">
        <span class="settings-row-title">Log file</span>
        <span class="settings-row-hint">Something not working? Open the log and send it to an officer.</span>
      </div>
      <${PathBox} value=${info.logFile} label="Log file">
        <${Button} size="sm" onClick=${() => open(gc.app.openPath, info.logFile)}>Open log<//>
        <${Button} size="sm" icon="folder" onClick=${() => open(gc.app.showItemInFolder, info.logFile)}>Show in folder<//>
      <//>
    </div>` : null}
  <//>`;
}
