// Live statuses pushed by the main process: sync engine, app updater, addon manager and settings, plus whether
// this PC can publish releases, and what sharing through the addon is doing. Each hook loads the current status
// once and then follows its event channel.
//   const sync = useSyncStatus();      // gc.sync.status() shape, or null while loading
//   const upd = useUpdaterStatus();    // gc.updater.status() shape
//   const addon = useAddonStatus();    // gc.addon.status() shape
//   const settings = useSettings();    // gc.settings.get() shape
//   const pub = usePublisherStatus();  // gc.publisher.status() shape (canPublish, reason, ...), or null
//   const share = useShareStatus();    // { data: GET /api/share/status | null, error, noGuild } or null while loading
import { gc } from './gc.js';
import { useEffect } from './html.js';
import { createStore, useStore } from './store.js';
import { api } from './api.js';
import { sessionStore } from './session.js';

function liveStatus(channel, fetchStatus, looksComplete) {
  const store = createStore(null);
  let started = false;
  const refresh = () => fetchStatus().then((s) => { if (s) store.set(s); return s; }, () => store.get());
  function start() {
    if (started) return;
    started = true;
    try {
      gc.on(channel, (payload) => {
        // Events normally carry the whole status; anything else is a hint to ask again.
        if (payload && typeof payload === 'object' && looksComplete(payload)) store.set(payload);
        else refresh();
      });
    } catch { /* an older main process without this channel: the first read still works */ }
    refresh();
  }
  function use() {
    useEffect(start, []);
    return useStore(store);
  }
  return { store, start, refresh, use, get: () => store.get() };
}

export const syncStatus = liveStatus('sync', () => gc.sync.status(), (p) => 'state' in p);
export const updaterStatus = liveStatus('updater', () => gc.updater.status(), (p) => 'state' in p);
export const addonStatus = liveStatus('addon', () => gc.addon.status(), (p) => Array.isArray(p.installs));
export const settingsStatus = liveStatus('settings', () => gc.settings.get(), (p) => 'syncEnabled' in p || 'theme' in p);

export const useSyncStatus = () => syncStatus.use();
export const useUpdaterStatus = () => updaterStatus.use();
export const useAddonStatus = () => addonStatus.use();
export const useSettings = () => settingsStatus.use();

// Whether this PC can publish releases (a source checkout plus the GitHub CLI, signed in). It has no event
// channel: it is read once, and again when the window comes back into focus (at most once a minute), since
// setting up gh happens outside Guild Camp.
const PUBLISHER_RECHECK_MS = 60000;
export const publisherStatus = (() => {
  const store = createStore(null);
  let started = false;
  let lastAt = 0;
  const refresh = () => {
    lastAt = Date.now();
    return gc.publisher.status().then((s) => { if (s && typeof s === 'object') store.set(s); return s; }, () => store.get());
  };
  function start() {
    if (started) return;
    started = true;
    refresh();
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('focus', () => { if (Date.now() - lastAt > PUBLISHER_RECHECK_MS) refresh(); });
    }
  }
  function use() {
    useEffect(start, []);
    return useStore(store);
  }
  return { store, start, refresh, use, get: () => store.get() };
})();
export const usePublisherStatus = () => publisherStatus.use();

// ---------- sharing through the addon (docs/SHARING.md) ----------

// The plain lines the app uses for sharing (docs/SHARING.md §2; the core's share/text.js LINES).
export const SHARE_LINES = Object.freeze({
  saved: 'Saved. It goes to your guild the next time you log in or type /reload.',
  newData: 'New guild data shows here after you log out or type /reload in game.',
  instance: 'Waiting until you leave the dungeon.',
  officer: 'Log in on an officer character to send this.',
  stale: 'Someone changed this in the meantime. Check it and try again.',
});

// The game finds new addon folders only when it starts. While a game folder's news folder (WowGuild_Inbox) was made
// during the game session that still runs, that session never loads it, also not after a /reload: the main process
// says restartNeeded in the sync status, and these lines replace the "log in or type /reload" ones.
export const RESTART_SHARE_LINES = Object.freeze({
  hint: "This goes to your guild after you restart World of Warcraft. A /reload isn't enough the first time.",
  saved: "Saved. It goes to your guild after you restart World of Warcraft. A /reload isn't enough the first time.",
  ready: "Changes marked “Ready to go” go to your guild after you restart World of Warcraft. A /reload isn't enough the first time.",
  changes: "Your changes reach the guild after you restart World of Warcraft. A /reload isn't enough the first time.",
});
export const READY_LINE = 'Changes marked “Ready to go” go to your guild the next time you log in or type /reload.';
export const CHANGES_LINE = 'Your changes reach the guild when you log in or type /reload.';

/** Whether sharing waits for a game restart (sync.status().restartNeeded). */
export function needsGameRestart(sync) {
  return Boolean(sync && typeof sync === 'object' && sync.restartNeeded === true);
}

/** "Saved. It goes to your guild …", with the restart wording while the game needs one. */
export function savedLine(sync) {
  return needsGameRestart(sync) ? RESTART_SHARE_LINES.saved : SHARE_LINES.saved;
}

/** A reply from the core: its saved line gets the restart wording while the game needs one; anything else stays. */
export function savedReply(message, sync) {
  return message === SHARE_LINES.saved ? savedLine(sync) : message;
}

/** The line above "Ready to go" changes on Addon & sync. */
export function readyLine(sync) {
  return needsGameRestart(sync) ? RESTART_SHARE_LINES.ready : READY_LINE;
}

/** When my changes reach the guild (Camp's "Your sync" card). */
export function changesLine(sync) {
  return needsGameRestart(sync) ? RESTART_SHARE_LINES.changes : CHANGES_LINE;
}

// The core's answer while no guild is known yet (app/src/core/http.js NO_GUILD).
export const NO_GUILD_TEXT = "Guild Camp hasn't seen your guild yet. Log in to World of Warcraft with the Guild Camp addon on a character in your guild, then log out or type /reload.";

/**
 * Whether an error is the core's "no guild yet" answer: 403 with code NO_GUILD (main/ipc.js serialiseError passes
 * the code on). The sentence still counts, for an error that lost its code on the way (an older main process).
 */
export function isNoGuild(err) {
  if (!err || typeof err !== 'object') return false;
  if (err.code === 'NO_GUILD') return true;
  return err.status === 403 && /hasn't seen your guild yet/.test(String(err.message || ''));
}

const SHARE_REFRESH_GAP_MS = 2000;
const SHARE_FOCUS_GAP_MS = 15000;

/**
 * GET /api/share/status, shared by every page that shows sharing. The store holds null until the first answer,
 * then { data, error, noGuild }: data is the status (null while there is no guild or it couldn't be read).
 * It reads again when the core reports a change ('server-event'), after each sync, when the guild changes, when
 * the window comes back into focus, and when a page that shows it opens (at most every 2 s).
 */
export const shareStatus = (() => {
  const store = createStore(null);
  let started = false;
  let inflight = null;
  let again = false;
  let lastAt = 0;
  let soon = null;
  const noGuildError = () => Object.assign(new Error(NO_GUILD_TEXT), { status: 403, code: 'NO_GUILD' });

  function read() {
    const s = sessionStore.get();
    // Known to have no guild: the core would only say so, so don't ask.
    if (s && s.loaded && s.ready && !s.guild) {
      store.set({ data: null, error: noGuildError(), noGuild: true });
      return Promise.resolve(null);
    }
    lastAt = Date.now();
    return api.get('/api/share/status').then((data) => {
      store.set({ data: data && typeof data === 'object' ? data : null, error: null, noGuild: false });
      return data;
    }, (error) => {
      const prev = store.get();
      const noGuild = isNoGuild(error);
      // A failed re-read keeps what is on screen; "no guild" clears it.
      store.set({ data: noGuild ? null : (prev && prev.data) || null, error, noGuild });
      return null;
    });
  }

  // One read at a time; a call that arrives meanwhile reads once more afterwards.
  function refresh() {
    if (inflight) { again = true; return inflight; }
    inflight = read().finally(() => {
      inflight = null;
      if (again) { again = false; refresh(); }
    });
    return inflight;
  }

  function refreshSoon(ms = 300) {
    clearTimeout(soon);
    soon = setTimeout(() => { refresh(); }, ms);
  }

  function start() {
    if (started) return;
    started = true;
    let lastSync;
    try { gc.on('server-event', () => refreshSoon()); } catch { /* an older main process */ }
    try {
      gc.on('sync', (s) => {
        const at = s && typeof s === 'object' ? s.lastSyncAt : undefined;
        if (at && at !== lastSync) { lastSync = at; refreshSoon(); }
      });
    } catch { /* an older main process */ }
    let guildId = (sessionStore.get().guild || {}).id;
    sessionStore.subscribe((s) => {
      const id = (s.guild || {}).id;
      if (id !== guildId) { guildId = id; refreshSoon(50); }
    });
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('focus', () => { if (Date.now() - lastAt > SHARE_FOCUS_GAP_MS) refresh(); });
    }
    refresh();
  }

  function use() {
    useEffect(() => {
      if (!started) start();
      else if (Date.now() - lastAt > SHARE_REFRESH_GAP_MS) refresh();
    }, []);
    return useStore(store);
  }
  return { store, start, refresh, use, get: () => store.get() };
})();
export const useShareStatus = () => shareStatus.use();

const KEEP_REFUSED_MS = 14 * 24 * 3600 * 1000;

/**
 * GET /api/share/status split for display: waiting (queued and waiting entries, newest first), sent (in the last
 * day), refused (the last 14 days, newest first) and the open author checks.
 */
export function shareGroups(status, now = Date.now()) {
  const s = status && typeof status === 'object' ? status : {};
  const outbox = Array.isArray(s.outbox) ? s.outbox.filter((e) => e && typeof e === 'object') : [];
  const refused = Array.isArray(s.refused) ? s.refused.filter((e) => e && typeof e === 'object') : [];
  const when = (e) => {
    const t = parseUtc(e.sentAt || e.createdAt);
    return t === null ? null : t;
  };
  return {
    waiting: outbox.filter((e) => e.state === 'queued' || e.state === 'waiting'),
    sent: outbox.filter((e) => e.state === 'sent'),
    refused: refused.filter((e) => { const t = when(e); return t === null || now - t <= KEEP_REFUSED_MS; }),
    checks: Array.isArray(s.authorChecks) ? s.authorChecks.filter((c) => c && c.id != null) : [],
  };
}

// "YYYY-MM-DD HH:MM:SS" (SQLite, UTC) or ISO → ms, or null.
function parseUtc(t) {
  if (!t) return null;
  const s = String(t);
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(s) ? `${s.replace(' ', 'T')}Z` : s);
  return Number.isFinite(ms) ? ms : null;
}

// What an outbox entry's state is called on screen: { kind, label } for a pill.
export function shareStateLabel(entry) {
  switch (entry && entry.state) {
    case 'queued': return { kind: 'info', label: 'Ready to go' };
    case 'waiting': return { kind: 'warn', label: 'Waiting' };
    case 'sent': return { kind: 'ok', label: 'Sent' };
    case 'refused': return { kind: 'alarm', label: 'Not sent' };
    default: return { kind: 'muted', label: 'Unknown' };
  }
}

// Whether the game said it is waiting for the player to leave a dungeon (the only place the app can know it).
export function waitingForDungeon(status) {
  return shareGroups(status).waiting.some((e) => e.state === 'waiting' && e.note === SHARE_LINES.instance);
}

/**
 * The author check line (docs/SHARING.md §5): "A change in your name arrived that this computer didn't make:
 * <summary>. Passed on by <name>."
 */
export function authorCheckText(check) {
  const c = check || {};
  const summary = String(c.summary || 'a guild change').replace(/[.\s]+$/, '');
  const by = typeof c.via === 'string' && c.via.trim() ? ` Passed on by ${c.via.trim()}.` : '';
  const many = c.kind === 'unknown' && Number(c.count) > 1;
  return `${many ? 'Changes' : 'A change'} in your name arrived that this computer didn't make: ${summary}.${by}`;
}

/**
 * What an author check says and what its two buttons ("mine" and "undo", POST /api/share/author-checks/:id) are
 * called, by the core's kind (sharing.status authorChecks[].kind):
 *   null      one change in my name            "It was me" · "Undo it"
 *   'unknown' changes of a kind this version doesn't know, from one sender, `count` of them
 *                                              "It was me" · "Close it" (the core can't undo them, only close the check)
 *   'pid'     my player id is made on a character that isn't mine     "Yes, it's mine" · "No, make a new id"
 *   'repair'  characters an older version linked to me                "Yes, mine" · "No, not mine"
 * Any other kind (a newer core) reads like the first, with the same two answers. → { text, mine, undo, undoIcon }
 */
export function authorCheckView(check) {
  const c = check && typeof check === 'object' ? check : {};
  const summary = String(c.summary || '').replace(/[.\s]+$/, '');
  if (c.kind === 'pid' && summary) return { text: `${summary}. Is that character yours?`, mine: "Yes, it's mine", undo: 'No, make a new id', undoIcon: 'refresh' };
  if (c.kind === 'repair' && summary) return { text: `${summary}. Is that right?`, mine: 'Yes, mine', undo: 'No, not mine', undoIcon: 'refresh' };
  if (c.kind === 'unknown') return { text: authorCheckText(c), mine: 'It was me', undo: 'Close it', undoIcon: 'close' };
  return { text: authorCheckText(c), mine: 'It was me', undo: 'Undo it', undoIcon: 'refresh' };
}

// Plain-English summary of a sync status for badges: { kind: 'ok'|'warn'|'alarm'|'info'|'muted', label }.
// sync.js states: 'off' | 'idle' | 'syncing' | 'error' | 'no-game'. `guildNote` is set while none of your
// characters is in a guild yet (the addon's data was read, but there was no guild to keep it for).
export function describeSync(s) {
  if (!s) return { kind: 'muted', label: 'Checking sync…' };
  switch (s.state) {
    case 'syncing': return { kind: 'info', label: 'Syncing…' };
    case 'error': return { kind: 'alarm', label: 'Sync problem' };
    case 'no-game': return { kind: 'warn', label: 'Game not found' };
    case 'off': return { kind: 'muted', label: 'Sync is off' };
    default:
      if (s.guildNote) return { kind: 'warn', label: 'Waiting for your guild' };
      return s.lastSyncAt ? { kind: 'ok', label: 'Synced', at: s.lastSyncAt } : { kind: 'ok', label: 'Waiting for the game' };
  }
}

// What the sidebar badge should say about updates, or null when there is nothing to do.
export function describeUpdates(updater, addon) {
  if (updater) {
    if (updater.state === 'downloaded') return { route: '/updates', label: 'Restart to update', kind: 'accent' };
    if (updater.state === 'downloading') {
      const pct = updater.progress && updater.progress.percent != null ? ` ${Math.round(updater.progress.percent)}%` : '';
      return { route: '/updates', label: `Downloading update${pct}`, kind: 'info' };
    }
    if (updater.state === 'available') return { route: '/updates', label: `App update ${updater.available?.version || ''}`.trim(), kind: 'accent' };
  }
  if (addon && Array.isArray(addon.installs)) {
    const outdated = addon.installs.filter((i) => i.state === 'outdated').length;
    if (outdated) return { route: '/addon', label: outdated === 1 ? 'Addon update' : `${outdated} addon updates`, kind: 'accent' };
  }
  return null;
}

// What a role from in-game ranks is called on screen.
export const ROLE_NAMES = { owner: 'Guild Master', officer: 'Officer', member: 'Member' };

/**
 * The role an in-game rank gives in Guild Camp (the core's rule, identity.roleFromRank):
 * rank 0 → 'owner' (the Guild Master); rank ≤ officerRankMax → 'officer'; any other rank → 'member'.
 * null when the rank isn't known. officerRankMax null means no rank below the Guild Master is an officer.
 */
export function roleForRank(rankIndex, officerRankMax) {
  if (rankIndex === null || rankIndex === undefined || rankIndex === '') return null;
  const r = Number(rankIndex);
  if (!Number.isInteger(r) || r < 0) return null;
  if (r === 0) return 'owner';
  const max = officerRankMax === null || officerRankMax === undefined || officerRankMax === '' ? null : Number(officerRankMax);
  return max !== null && Number.isInteger(max) && r <= max ? 'officer' : 'member';
}
