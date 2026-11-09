// Who you are in Guild Camp. There are no accounts: the app's own guild data (the local core, GET /api/me) knows
// "me", the guild of my most recently played character and my role from my in-game rank; the Battle.net sign-in
// in the app (gc.auth.state) adds the BattleTag and the character list.
//
//   const { user, guild, role, isOfficer, isOwner, battletag, name, bnet, loaded, refresh } = useSession();
//   pageGate({ route, session, onboarded, smoke }) decides what the app frame shows for a route (main.js).
//
//   user       { id, battletag, ... } from GET /api/me (battletag is the BattleTag, or my main's name, or "You")
//   guild      the current guild, or null until the first sync with the addon brings it
//   role       'owner' | 'officer' | 'member' | null (from the in-game guild rank)
//   battletag  the Battle.net BattleTag when signed in to Battle.net, else null
//   name       what to call me on screen: the BattleTag, else the name Guild Camp knows me by
//   bnet       the Battle.net state: { available, signedIn, signingIn, battletag, region, characters, profileAt, canRefresh, error }
//   loaded     the first read finished (even if it failed)
//   ready      the local guild data answered
//   signedIn   same as `ready` (kept for code written when Guild Camp had accounts)
//
// Refreshes by itself on 'auth' (Battle.net sign-in/out) and on 'server-event' (the core changed something, for
// example the first sync found the guild). refreshSession() reads both again.
import { gc } from './gc.js';
import { createStore, useStore } from './store.js';

export const ROLES = ['owner', 'officer', 'member'];

export const EMPTY_BNET = Object.freeze({
  available: false, signedIn: false, signingIn: false, battletag: null, region: 'eu', characters: [], profileAt: null, canRefresh: false, error: null,
});

const EMPTY = Object.freeze({
  loaded: false, ready: false, signedIn: false, user: null, guild: null, role: null, battletag: null, name: '', bnet: EMPTY_BNET, error: null,
});

// ---------- pure helpers (exported for tests) ----------

/** A Battle.net state from gc.auth.state() or the 'auth' channel, with every field present. */
export function normalizeBnet(s) {
  if (!s || typeof s !== 'object') return EMPTY_BNET;
  const signedIn = !!s.signedIn;
  return {
    available: !!s.available,
    signedIn,
    signingIn: !!s.signingIn,
    battletag: signedIn && typeof s.battletag === 'string' && s.battletag ? s.battletag : null,
    region: typeof s.region === 'string' && s.region ? s.region : 'eu',
    characters: signedIn && Array.isArray(s.characters) ? s.characters : [],
    profileAt: signedIn ? s.profileAt || null : null,
    canRefresh: signedIn && !!s.canRefresh,
    error: typeof s.error === 'string' && s.error ? s.error : null,
  };
}

/**
 * The session from GET /api/me (`me`, null when it could not be read) and the Battle.net state.
 * The guild and role only count together: no guild, no role.
 */
export function buildSession(me, bnet, { error = null } = {}) {
  const b = normalizeBnet(bnet);
  const m = me && typeof me === 'object' ? me : null;
  const baseUser = m && m.user && typeof m.user === 'object' ? m.user : null;
  const guild = m && m.guild && typeof m.guild === 'object' ? m.guild : null;
  const rawRole = m ? (m.role ?? (guild && guild.role)) : null;
  const role = guild && ROLES.includes(rawRole) ? rawRole : null;
  // Signed in to Battle.net, the BattleTag is the true one even before the local data has caught up.
  const user = baseUser && b.battletag && baseUser.battletag !== b.battletag ? { ...baseUser, battletag: b.battletag } : baseUser;
  const name = b.battletag || (user && typeof user.battletag === 'string' && user.battletag) || (user && user.name) || '';
  return {
    loaded: true,
    ready: !!m,
    signedIn: !!m,
    user,
    guild,
    role,
    battletag: b.battletag,
    name: String(name || ''),
    bnet: b,
    error: error ? String(error) : null,
  };
}

// Pages that work before the game has shown Guild Camp a guild (they need the app, not guild data).
export const GUILDLESS_PATHS = Object.freeze(['/addon', '/settings', '/updates', '/releases']);

/**
 * What the app frame shows for a route:
 *   'page'         the page itself
 *   'loading'      the first read of who I am hasn't finished
 *   'welcome'      first run: setup isn't done yet (settings.onboarded is false), so go to /welcome
 *   'unavailable'  the local guild data didn't answer
 *   'no-guild'     the page needs guild data and the game hasn't shown Guild Camp a guild yet
 * `onboarded` is settings.onboarded (unknown counts as done, so nobody is ever locked out); a smoke run skips the
 * welcome flow because it visits every page itself.
 */
export function pageGate({ route, session, onboarded = true, smoke = false } = {}) {
  if (!route || route.public || route.path === '*') return 'page';
  if (onboarded === false && !smoke) return 'welcome';
  if (GUILDLESS_PATHS.includes(route.path)) return 'page';
  if (!session || !session.loaded) return 'loading';
  if (!session.ready) return 'unavailable';
  if (!session.guild) return 'no-guild';
  return 'page';
}

/** settings.onboarded as the gate reads it: false only when the settings say so. */
export function isOnboarded(settings) {
  return !(settings && typeof settings === 'object' && settings.onboarded === false);
}

/** "Zulgar#1234" → { name: 'Zulgar', digits: '1234' }; "Zulgar" → { name: 'Zulgar', digits: '' }. */
export function splitBattleTag(tag) {
  const [name, digits = ''] = String(tag || '').split('#');
  return { name: name || '', digits };
}

// ---------- the store ----------

export const sessionStore = createStore(EMPTY);

let lastMe = null;
let lastBnet = EMPTY_BNET;

function commit(error = null) {
  sessionStore.set(buildSession(lastMe, lastBnet, { error }));
  return getSession();
}

/**
 * Sets the session directly. Pass null to mark it loaded and empty (nothing could be read), { me, bnet } (either may
 * be left out to keep what is there), or a GET /api/me answer.
 */
export function setSession(value) {
  if (!value || typeof value !== 'object') {
    lastMe = null;
    lastBnet = EMPTY_BNET;
    return commit();
  }
  if ('me' in value || 'bnet' in value) {
    if ('me' in value) lastMe = value.me && typeof value.me === 'object' ? value.me : null;
    if ('bnet' in value) lastBnet = normalizeBnet(value.bnet);
  } else {
    lastMe = value;
  }
  return commit();
}

async function readMe() {
  return gc.api.request('GET', '/api/me');
}

async function readBnet() {
  return normalizeBnet(await gc.auth.state());
}

// One read at a time; callers that arrive meanwhile share it.
let inflight = null;

/**
 * Reads GET /api/me and the Battle.net state again. Never rejects: what can't be read keeps its last value and
 * the problem is in `error`. ({ fromServer } is accepted for older callers; both are always read fresh.)
 */
export function refreshSession() {
  if (!inflight) {
    inflight = Promise.all([
      readMe().then((me) => ({ me }), (err) => ({ err })),
      readBnet().then((bnet) => ({ bnet }), () => ({})),
    ]).then(([meRes, bnetRes]) => {
      if (meRes.me && typeof meRes.me === 'object') lastMe = meRes.me;
      if (bnetRes.bnet) lastBnet = bnetRes.bnet;
      return commit(meRes.err ? meRes.err.message || 'Guild Camp could not read your guild data.' : null);
    }).finally(() => { inflight = null; });
  }
  return inflight;
}

// Many events can arrive together (a sync imports a lot): read once, a moment after the last one.
let soon = null;
function refreshSoon(ms = 250) {
  clearTimeout(soon);
  soon = setTimeout(() => { refreshSession(); }, ms);
}

export function getSession() { return withRoles(sessionStore.get()); }

function withRoles(s) {
  return {
    ...s,
    isOwner: s.role === 'owner',
    isOfficer: s.role === 'owner' || s.role === 'officer',
    refresh: () => refreshSession(),
  };
}

// gc.on throws for a channel an older preload doesn't know; the session must not break on that.
function listen(channel, cb) {
  try { gc.on(channel, cb); } catch { /* not available */ }
}

// Battle.net signed in or out: show it at once, then read "me" again (the core takes the BattleTag from it).
listen('auth', (payload) => {
  if (payload && typeof payload === 'object' && 'signedIn' in payload) {
    lastBnet = normalizeBnet(payload);
    commit(sessionStore.get().error);
  }
  refreshSoon(150);
});

// The core changed something (a sync found the guild, a rank changed, …).
listen('server-event', () => refreshSoon());

export function useSession() {
  return withRoles(useStore(sessionStore));
}
