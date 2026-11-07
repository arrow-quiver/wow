// Settings: the signed-in account and its devices, desktop notifications, Discord linking, the private calendar
// feed, how the app behaves on this PC, and version/log details for getting help.
// Server shapes: docs/api/core.md (/api/me, /api/devices), docs/api/discord.md, the admin domain's /api/calendar.
// App settings go through gc.settings.set and arrive back on the 'settings' channel.
// ?section=discord (or account, notifications, calendar, app, about) scrolls straight to that card.
// ?section=discord&link=1 also makes a Discord link code straight away when the member isn't linked yet.
import { html, cx, useState, useEffect, useRef, useCallback } from '../lib/html.js';
import { gc, useGcEvent } from '../lib/gc.js';
import { api, useApi, useAction } from '../lib/api.js';
import { useSession, setSession } from '../lib/session.js';
import { navigate, Link } from '../lib/router.js';
import { applyTheme, THEMES } from '../lib/theme.js';
import { localTime } from '../lib/format.js';
import {
  Page, Card, Table, Button, ConfirmButton, CopyButton, Checkbox, Notice, Pill, Icon, Async, ErrorBox, Loading,
  TimeAgo, useNow, toast,
} from '../components/index.js';

// ---------- helpers (exported for tests) ----------

export const SECTIONS = [
  { id: 'account', label: 'Account', icon: 'character' },
  { id: 'notifications', label: 'Notifications', icon: 'bell' },
  { id: 'discord', label: 'Discord', icon: 'link' },
  { id: 'calendar', label: 'Calendar', icon: 'raids' },
  { id: 'app', label: 'App', icon: 'settings' },
  { id: 'about', label: 'About & help', icon: 'info' },
];
const sectionDomId = (id) => `settings-${id}`;

// Slash commands named in the Discord card, in the old Settings page's order (/link is explained separately).
const COMMAND_LIST = ['online', 'raids', 'craft', 'price', 'cta', 'signup'];

// The notifyPrefs switches (docs/api/core.md), in the order shown. `officer` ones only matter to officers.
export const NOTIFY_KINDS = [
  { key: 'cta', label: 'Calls to arms', hint: 'Someone needs help in a fight.' },
  { key: 'raids', label: 'Raids and reminders', hint: 'New raids and events, and a reminder before they start.' },
  { key: 'notices', label: 'Guild notices', hint: 'Announcements from officers.' },
  { key: 'requests', label: 'Crafting requests', hint: 'Someone needs something you can craft.' },
  { key: 'bank', label: 'Bank requests', hint: 'Members asking the guild bank for items.', officer: true },
  { key: 'coach', label: 'Coach', hint: 'Your build plan or answer is ready.' },
  { key: 'drives', label: 'Supply drives', hint: 'New drives, and drives that reach their goal.' },
];

const PLATFORMS = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };
export const platformName = (p) => PLATFORMS[p] || (p ? String(p) : 'Unknown');

export function hostOf(url) {
  try { return new URL(url).host; } catch { return url || ''; }
}

// Google Calendar subscribes from a webcal:// address passed as ?cid=.
export function googleCalendarUrl(feedUrl) {
  return `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(String(feedUrl || '').replace(/^https?:/i, 'webcal:'))}`;
}

// Whole minutes left until an ISO time (0 once it has passed).
export function minutesLeft(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.ceil((t - now) / 60000));
}

const ROLE_LABEL = { owner: 'Guild owner', officer: 'Officer', member: 'Member' };

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
      toast(err?.message || "Couldn't change that setting.", 'alarm');
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

// A path or address shown in full, selectable, with buttons beside it.
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
  const me = useApi('/api/me');
  const layoutRef = useRef(null);
  const [active, setActive] = useActiveSection(layoutRef);

  // ?section=discord: jump to that card once the page has laid out.
  useEffect(() => {
    if (!SECTIONS.some((s) => s.id === query.section)) return undefined;
    setActive(query.section);
    const t = setTimeout(() => scrollToSection(query.section, false), 60);
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
        <${AccountCard} me=${me} session=${session} />
        <${NotificationsCard} me=${me} settings=${settings} change=${change} isOfficer=${session.isOfficer} />
        <${DiscordCard} isOfficer=${session.isOfficer} autoStart=${query.link === '1'} />
        <${CalendarCard} />
        <${AppCard} settings=${settings} change=${change} info=${info} />
        <${AboutCard} info=${info} />
      </div>
    </div>
  <//>`;
}

// ---------- 1. account ----------

function AccountCard({ me, session }) {
  const devices = useApi('/api/devices');
  const [signingOut, setSigningOut] = useState(false);

  const signOut = async () => {
    setSigningOut(true);
    try {
      const state = await gc.auth.signOut();
      setSession(state && typeof state === 'object' ? state : { signedIn: false });
      toast('Signed out. Sign in again whenever you like.', 'ok');
      navigate('/welcome', { replace: true });
    } catch (err) {
      setSigningOut(false);
      toast(err?.message || "Couldn't sign out. Try again.", 'alarm');
    }
  };

  const revoke = async (d) => {
    await api.del(`/api/devices/${d.id}`);
    toast(`${d.name || 'That device'} is signed out.`, 'ok');
    devices.reload();
  };
  const revokeKey = async (k) => {
    await api.del(`/api/sync-keys/${k.id}`);
    toast('Sync key revoked. The old companion can no longer upload with it.', 'ok');
    devices.reload();
  };

  const columns = [
    {
      key: 'name', label: 'Device',
      render: (d) => html`<div class="settings-device">
        <span class="settings-device-name">${d.name || 'Unnamed device'}${d.current ? html` <${Pill} kind="accent">This PC<//>` : null}</span>
        <span class="settings-device-sub">${platformName(d.platform)}${d.prefix ? html` · <span class="mono">${d.prefix}…</span>` : null}</span>
      </div>`,
    },
    { key: 'app_version', label: 'App', render: (d) => d.app_version || html`<span class="muted">—</span>`, width: '80px' },
    { key: 'created_at', label: 'Signed in', render: (d) => html`<${TimeAgo} t=${d.created_at} />`, width: '110px' },
    { key: 'last_used_at', label: 'Last used', render: (d) => html`<${TimeAgo} t=${d.last_used_at} />`, width: '110px' },
    {
      key: 'actions', label: html`<span class="sr">Actions</span>`, align: 'right', width: '190px',
      render: (d) => (d.current
        ? html`<span class="hint">Use Sign out above</span>`
        : html`<${ConfirmButton} icon="signout" question="Sign it out?" yes="Sign out" onConfirm=${() => revoke(d)}>Sign out<//>`),
    },
  ];

  return html`<${Card} id=${sectionDomId('account')} title="Account" class="settings-card"
      actions=${html`<${ConfirmButton} icon="signout" question="Sign out of Guild Camp?" yes="Sign out" busy=${signingOut}
        onConfirm=${signOut}>Sign out<//>`}>
    <${Async} q=${me} loadingLabel="Loading your account…">${(data) => {
      const user = data?.user || session.user || {};
      const guild = data?.guild || session.guild;
      const role = data?.role || session.role;
      const tag = String(user.battletag || '');
      const [name, digits] = tag.split('#');
      return html`<div class="settings-who">
        <span class="settings-avatar" aria-hidden="true">${(name || '?').slice(0, 1).toUpperCase()}</span>
        <div class="settings-who-text">
          <span class="settings-who-tag">${name || 'Signed in'}${digits ? html`<span class="settings-who-digits">#${digits}</span>` : null}</span>
          <span class="muted">${guild
            ? html`${ROLE_LABEL[role] || 'Member'} of <strong>${guild.name}</strong>${guild.faction ? ` (${guild.faction})` : ''}`
            : 'Not in a guild yet.'}</span>
          <span class="hint">Signed in with Battle.net${session.server ? ` on ${hostOf(session.server)}` : ''}.</span>
        </div>
      </div>`;
    }}<//>

    <div class="settings-sub">
      <h3 class="settings-sub-title">Signed-in devices</h3>
      <p class="hint">Every PC where you signed in to Guild Camp. Sign out the ones you no longer use.</p>
      <${Async} q=${devices} loadingLabel="Loading devices…">${(data) => html`
        <div class="settings-table">
          <${Table} columns=${columns} rows=${data?.devices || []} rowKey=${(d) => d.id} dense
            empty="No devices are signed in." />
        </div>
        ${data?.syncKeys?.length ? html`<div class="settings-keys">
          <h4 class="settings-sub-title">Old sync keys</h4>
          <p class="hint">Keys from the old companion app still upload game data. Revoke them once you use Guild Camp.</p>
          <ul class="list-lines">
            ${data.syncKeys.map((k) => html`<li key=${k.id} class="settings-key">
              <span class="mono">${k.prefix}…</span>
              <span class="hint">Made <${TimeAgo} t=${k.created_at} />, last used <${TimeAgo} t=${k.last_used_at} /></span>
              <span class="spacer"></span>
              <${ConfirmButton} question="Revoke this key?" yes="Revoke" onConfirm=${() => revokeKey(k)}>Revoke<//>
            </li>`)}
          </ul>
        </div>` : null}`}<//>
    </div>
  <//>`;
}

// ---------- 2. notifications ----------

function NotificationsCard({ me, settings, change, isOfficer }) {
  const [prefs, setPrefs] = useState(null);
  const [testing, setTesting] = useState(false);
  useEffect(() => { if (me.data?.notifyPrefs) setPrefs(me.data.notifyPrefs); }, [me.data]);

  const master = settings ? settings.notifications !== false : true;
  const kinds = NOTIFY_KINDS.filter((k) => !k.officer || isOfficer);

  const setPref = async (key, on) => {
    const before = prefs;
    setPrefs((p) => ({ ...(p || {}), [key]: on }));
    try {
      const r = await api.put('/api/me/notifications', { [key]: on });
      if (r?.notifyPrefs) setPrefs(r.notifyPrefs);
    } catch (err) {
      setPrefs(before);
      toast(err?.message || "Couldn't save that choice.", 'alarm');
    }
  };

  const test = async () => {
    setTesting(true);
    try {
      await gc.notify.test();
      toast('Test sent. If nothing popped up, check Windows notification settings for Guild Camp.', 'ok');
    } catch (err) {
      toast(err?.message || "Couldn't show a notification.", 'alarm');
    } finally {
      setTesting(false);
    }
  };

  return html`<${Card} id=${sectionDomId('notifications')} title="Notifications" class="settings-card"
      footer=${html`<div class="row row--between">
        <span>Guild Camp checks for news every 20 seconds while it runs, also from the tray.</span>
        <${Button} size="sm" icon="bell" busy=${testing} onClick=${test}>Send a test notification<//>
      </div>`}>
    <${ToggleRow} title="Desktop notifications" checked=${master} disabled=${!settings}
      hint="Pop-ups from Guild Camp when something happens in the guild, even while you play."
      onValue=${(on) => change({ notifications: on }, on ? 'Desktop notifications are on.' : 'Desktop notifications are off.')} />
    <div class=${cx('settings-sub', !master && 'is-off')}>
      <h3 class="settings-sub-title">Tell me about</h3>
      ${!master ? html`<p class="hint">Turn on desktop notifications to get these.</p>` : null}
      ${me.error && !prefs
        ? html`<${ErrorBox} error=${me.error} title="Couldn't load your choices." onRetry=${me.reload} />`
        : !prefs ? html`<${Loading} label="Loading your choices…" />`
          : html`<div class="settings-kinds">
            ${kinds.map((k) => html`<${Checkbox} key=${k.key} label=${k.label} hint=${k.hint}
              checked=${prefs[k.key] !== false} disabled=${!master} onValue=${(on) => setPref(k.key, on)} />`)}
          </div>`}
    </div>
  <//>`;
}

// ---------- 3. discord ----------

function DiscordCard({ isOfficer, autoStart = false }) {
  const [link, setLink] = useState(null); // { code, expires_at, command, linked }
  const now = useNow();
  const left = link ? minutesLeft(link.expires_at, now) : 0;
  const waiting = !!link && left > 0 && !link.linked;
  // While a fresh code is on screen, look every few seconds for the link to happen in Discord.
  const q = useApi('/api/discord', { interval: waiting ? 4000 : 0 });
  const linked = !!q.data?.linked;

  useEffect(() => {
    if (waiting && linked) {
      setLink(null);
      toast('Discord linked. You can use /signup and /cta now.', 'ok');
    }
  }, [linked]);

  const getCode = useAction(() => api.post('/api/discord/link', {}));
  const unlink = async () => {
    await api.post('/api/discord/unlink', {});
    setLink(null);
    toast('Discord unlinked.', 'ok');
    q.reload();
  };
  const register = useAction(() => api.post('/api/discord/register', {}), { success: (r) => r?.message || 'Slash commands registered.' });

  const newCode = async () => {
    const r = await getCode.run();
    if (r.ok) setLink(r.value);
  };

  // ?link=1 (e.g. from the Camp's "Link your Discord" step) starts linking straight away, once.
  const autoLinked = useRef(false);
  useEffect(() => {
    if (!autoStart || autoLinked.current || !q.data) return;
    autoLinked.current = true;
    if (q.data.configured && !q.data.linked) newCode();
  }, [autoStart, q.data]);

  return html`<${Card} id=${sectionDomId('discord')} title="Discord" class="settings-card"
      actions=${q.data?.configured ? html`<${Pill} kind=${linked ? 'ok' : 'muted'} dot>${linked ? 'Linked' : 'Not linked'}<//>` : null}>
    <${Async} q=${q} loadingLabel="Checking Discord…">${(d) => (!d?.configured
      ? html`<${Notice} kind="info" title="Discord isn't set up on this server yet.">
          Once the server owner adds the Discord app, you can link your account here and use slash commands
          like <code>/raids</code> and <code>/signup</code> in your guild's Discord.
        <//>`
      : html`<div class="stack">
          <p class="mb-0">${'Use '}${COMMAND_LIST.map((c, i) => html`${i ? (i === COMMAND_LIST.length - 1 ? ' and ' : ', ') : ''}<code>/${c}</code>`)}
            ${' straight from Discord. '}${linked
              ? 'Your Discord is linked, so /signup and /cta know who you are.'
              : 'Link your Discord once so /signup and /cta know who you are.'}</p>

          ${link ? html`<${LinkCode} link=${link} left=${left} onNew=${newCode} busy=${getCode.busy} />` : null}

          <div class="actions-row">
            ${!link ? html`<${Button} variant=${linked ? 'secondary' : 'primary'} icon="link" busy=${getCode.busy} onClick=${newCode}>
              ${linked ? 'Get a new link code' : 'Link Discord'}<//>` : null}
            ${linked ? html`<${ConfirmButton} size="md" variant="ghost" question="Unlink Discord?" yes="Unlink" onConfirm=${unlink}>Unlink<//>` : null}
          </div>

          ${isOfficer ? html`<div class="settings-officer">
            <div class="row row--between">
              <h3 class="settings-sub-title mb-0">For officers</h3>
              <${Pill} kind=${d.server_linked ? 'ok' : 'warn'} dot>${d.server_linked ? 'Server connected' : 'Server not connected yet'}<//>
            </div>
            <p class="hint">${d.server_linked
              ? 'Your Discord server is connected. '
              : 'The server connects by itself the first time someone runs /link in it. '}${'To add the commands to your server, invite the app, then register them. '}${"Inviting it as a bot also lets it put raids in Discord's Events list."}</p>
            <div class="actions-row">
              ${d.invite_url ? html`<${Button} href=${d.invite_url} icon="external">Invite the app<//>` : null}
              <${Button} icon="upload" busy=${register.busy} disabled=${!d.bot_configured} onClick=${() => register.run()}>Register slash commands<//>
            </div>
            ${!d.bot_configured ? html`<p class="hint mb-0">Registering needs the bot token on the server (DISCORD_BOT_TOKEN).</p>` : null}
            <p class="hint mb-0">Posts to a Discord channel (calls to arms, notices, requests) use the webhook in <${Link} href="/guild-settings">Guild settings<//>.</p>
          </div>` : null}
        </div>`)}<//>
  <//>`;
}

function LinkCode({ link, left, onNew, busy }) {
  if (left <= 0) {
    return html`<${Notice} kind="warn" title="That code has expired.">
      Codes last 15 minutes. <button type="button" class="link-btn" onClick=${onNew} disabled=${busy}>Get a new code</button>
    <//>`;
  }
  return html`<div class="settings-code" role="group" aria-label="Your Discord link code">
    <div class="settings-code-main">
      <span class="settings-code-label">Type this in your guild's Discord server</span>
      <code class="settings-code-cmd">${link.command || `/link ${link.code}`}</code>
      <span class="hint">Works once. Expires in ${left} min (at ${localTime(link.expires_at, 'time')}).</span>
    </div>
    <div class="settings-code-actions">
      <${CopyButton} text=${link.command || `/link ${link.code}`} label="Copy" done="Copied. Paste it in Discord." variant="primary" size="md" />
      <${Button} variant="ghost" size="sm" icon="refresh" busy=${busy} onClick=${onNew}>New code<//>
    </div>
  </div>`;
}

// ---------- 4. calendar ----------

function CalendarCard() {
  const q = useApi('/api/calendar');
  const reset = async () => {
    const r = await api.post('/api/calendar/reset', {});
    if (r?.url) q.setData(r);
    else q.reload();
    toast(r?.message || 'New calendar link made. The old one no longer works.', 'ok');
  };

  return html`<${Card} id=${sectionDomId('calendar')} title="Calendar" class="settings-card"
      footer=${q.data?.url ? html`<div class="row row--between">
        <span>Keep this link to yourself: anyone who has it can see the guild's raids.</span>
        <${ConfirmButton} icon="refresh" question="Make a new link? The old one stops working." yes="Replace" onConfirm=${reset}>Replace link<//>
      </div>` : null}>
    <p>Add the guild's raids and events to Google, Apple or Outlook calendar. They update by themselves, with a reminder
      30 minutes before.</p>
    <${Async} q=${q} loadingLabel="Getting your calendar link…" errorTitle="Couldn't get your calendar link.">${(d) => (d?.url
      ? html`<div class="stack">
          <${PathBox} value=${d.url} label="Your private calendar link">
            <${CopyButton} text=${d.url} label="Copy link" done="Calendar link copied." variant="primary" />
            <${Button} size="sm" href=${d.googleUrl || googleCalendarUrl(d.url)} icon="external">Google Calendar<//>
          <//>
          <ul class="settings-howto">
            <li><strong>Google Calendar:</strong> Other calendars → + → From URL, then paste the link.</li>
            <li><strong>Apple Calendar:</strong> File → New Calendar Subscription, then paste the link.</li>
            <li><strong>Outlook:</strong> Add calendar → Subscribe from web, then paste the link.</li>
          </ul>
        </div>`
      : html`<p class="muted">The server didn't send a calendar link.</p>`)}<//>
  <//>`;
}

// ---------- 5. app ----------

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
    <${Row} title="Server" hint=${s.serverUrl ? html`<span class="mono">${s.serverUrl}</span>` : 'Not set'}>
      <${Button} size="sm" onClick=${() => navigate('/welcome?step=server')}>Change server<//>
    <//>
    <${Row} title="Theme" hint="Match Windows follows your light or dark mode setting.">
      <div class="settings-seg" role="radiogroup" aria-label="Theme">
        ${THEMES.map((t) => html`<button key=${t.value} type="button" role="radio" aria-checked=${(s.theme || 'system') === t.value ? 'true' : 'false'}
            class=${cx('settings-seg-opt', (s.theme || 'system') === t.value && 'is-on')} disabled=${!ready}
            onClick=${() => setTheme(t.value)}>${t.label}</button>`)}
      </div>
    <//>
    <${ToggleRow} title="Start with Windows" checked=${s.startWithWindows} disabled=${!ready || !startupSupported}
      hint=${startupSupported ? 'Starts quietly in the tray when you sign in to Windows, so sync is always on.' : 'Only the installed app can start with Windows.'}
      onValue=${(on) => change({ startWithWindows: on }, on ? 'Guild Camp will start with Windows.' : 'Guild Camp will no longer start with Windows.')} />
    <${ToggleRow} title="Keep running when I close the window" checked=${s.closeToTray} disabled=${!ready}
      hint="Guild Camp stays in the tray and keeps syncing while you play. Quit from the tray icon."
      onValue=${(on) => change({ closeToTray: on })} />
    <${ToggleRow} title="Update the app automatically" checked=${s.appAutoUpdate} disabled=${!ready}
      hint="Downloads new versions of Guild Camp and installs them the next time it starts."
      onValue=${(on) => change({ appAutoUpdate: on }, on ? 'App updates will download by themselves.' : 'App updates will wait for you.')} />
    <${ToggleRow} title="Update the addon automatically" checked=${s.addonAutoUpdate} disabled=${!ready}
      hint="Keeps the Guild Camp addon up to date in every game folder."
      onValue=${(on) => change({ addonAutoUpdate: on }, on ? 'The addon will update by itself.' : 'Addon updates will wait for you.')} />
    <${ToggleRow} title="Install the addon in new game folders automatically" checked=${s.addonAutoInstall !== false} disabled=${!ready}
      hint="When Guild Camp finds a game folder without the addon, it installs it there for you."
      onValue=${(on) => change({ addonAutoInstall: on }, on ? 'New game folders get the addon by themselves.' : 'New game folders will wait for you to install the addon.')} />
    <${ToggleRow} title="Sync game data" checked=${s.syncEnabled} disabled=${!ready}
      hint=${html`Uploads your characters, professions and bank after each /reload or logout. Details on <${Link} href="/addon">Addon & sync<//>.`}
      onValue=${(on) => change({ syncEnabled: on }, on ? 'Sync is on.' : 'Sync is off. Your game data stays on this PC.')} />
  <//>`;
}

// ---------- 6. about & help ----------

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
    ${info.userData ? html`<div class="settings-file">
      <div class="settings-row-text">
        <span class="settings-row-title">Data folder</span>
        <span class="settings-row-hint">Settings, the sign-in token and logs for this PC.</span>
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
