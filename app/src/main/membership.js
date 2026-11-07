'use strict';
// Joining the guild by itself: works out which guild the member is in and asks the server to add them.
//
//   const membership = createMembership({ api, wow, auth, log, store });
//   await membership.autoJoin()  → result (below). Reads the characters the addon saved in every game folder
//                                  (wow.detectGuild) and sends them to POST /api/guild/auto-join; the server
//                                  also checks the member's Battle.net characters. On 'joined' (and 'already')
//                                  the sign-in state is refreshed, so the 'auth' event carries the guild.
//   membership.status()          → the last result, or null
//   membership.record(result)    → keep a result that came from elsewhere (a sync upload) and emit it
//   membership.start()           background: while signed in without a guild, try now and then every 60 s.
//                                  Stops by itself once in a guild or signed out. → Promise of the first try
//   membership.stop({ forget })  stop trying (forget: also drop the last result, e.g. on sign-out)
//   membership.kick()            try again now (a SavedVariables file changed), unless a try just ran
//   events: 'change' (result)    every new result
//
// Result (the same shape everywhere: server, IPC, the 'membership' event):
//   { status: 'joined'|'already'|'no-guild-on-server'|'no-match'|'disabled',
//     guild: { id, name, faction } | null, role: 'owner'|'officer'|'member'|null,
//     via: 'battlenet'|'roster'|null, character: string|null,
//     reason: 'Plain sentence, always present.', detected: { guild, realm, faction } | null }
//
// Plain Node (no Electron). Timers and the clock can be injected for tests.

const { EventEmitter } = require('events');

const STATUSES = ['joined', 'already', 'no-guild-on-server', 'no-match', 'disabled'];
const ROLES = ['owner', 'officer', 'member'];
const VIAS = ['battlenet', 'roster'];
const MAX_CHARACTERS = 50;

const DEFAULTS = Object.freeze({
  intervalMs: 60 * 1000, // background tries while not in a guild
  kickGapMs: 30 * 1000, // kick() does nothing when a try finished this recently
  timeoutMs: 20 * 1000, // one auto-join request
});

// ---------------------------------------------------------------------------------------------
// Pure helpers (exported for tests)

function text(value, max) {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  return t ? t.slice(0, max) : null;
}

function number(value) {
  const n = Number(value);
  return value !== null && value !== '' && Number.isFinite(n) ? n : null;
}

/** What the server is sent: up to 50 characters with only the fields it needs (no folders or accounts). */
function cleanCharacters(list) {
  const out = [];
  for (const c of Array.isArray(list) ? list : []) {
    if (!c || typeof c !== 'object') continue;
    const name = text(c.name, 40);
    if (!name) continue;
    const level = number(c.level);
    out.push({
      name,
      realm: text(c.realm, 60),
      guild: text(c.guild, 60),
      faction: text(c.faction, 10),
      level: level === null ? null : Math.floor(level),
      class: text(c.class, 20),
      updated: number(c.updated),
    });
    if (out.length >= MAX_CHARACTERS) break;
  }
  return out;
}

function cleanGuild(g) {
  if (!g || typeof g !== 'object') return null;
  const name = text(g.name, 80);
  if (!name) return null;
  const id = number(g.id);
  return { id: id === null ? null : id, name, faction: text(g.faction, 20) };
}

function cleanDetected(d) {
  if (!d || typeof d !== 'object') return null;
  const guild = text(d.guild, 80) || text(d.name, 80);
  if (!guild) return null;
  return { guild, realm: text(d.realm, 80), faction: text(d.faction, 20) };
}

function defaultReason(status, guild) {
  const name = guild ? guild.name : 'the guild';
  switch (status) {
    case 'joined': return `You're in ${name}.`;
    case 'already': return `You're already in ${name}.`;
    case 'no-guild-on-server': return 'This server has no guild yet.';
    case 'disabled': return `${guild ? name : 'This guild'} only takes new members with an invite link.`;
    default: return "Guild Camp couldn't match you to the guild yet. It keeps checking, or you can use an invite link.";
  }
}

/** Any server answer → the result shape, with safe defaults. */
function normalizeResult(raw) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const status = STATUSES.includes(r.status) ? r.status : 'no-match';
  const guild = cleanGuild(r.guild);
  return {
    status,
    guild,
    role: ROLES.includes(r.role) ? r.role : null,
    via: VIAS.includes(r.via) ? r.via : null,
    character: text(r.character, 60),
    reason: text(r.reason, 500) || defaultReason(status, guild),
    detected: cleanDetected(r.detected),
  };
}

/** The `joined` part of a sync reply ({ guild, role, via, character }) → a 'joined' result. */
function joinedResult(joined) {
  const j = joined && typeof joined === 'object' ? joined : {};
  const guild = cleanGuild(j.guild);
  const character = text(j.character, 60);
  return normalizeResult({
    status: 'joined',
    guild,
    role: j.role,
    via: j.via,
    character,
    reason: `You're in ${guild ? guild.name : 'the guild'}${character ? ` (matched ${character})` : ''}.`,
  });
}

// ---------------------------------------------------------------------------------------------

const noopLog = { info() {}, warn() {}, error() {} };

/**
 * @param {object} deps
 * @param {object} deps.api    createApi() result
 * @param {object} deps.wow    { detectGuild({ extraRoots, scanDefaults }) } (the wow.js module)
 * @param {object} [deps.auth] createAuth() result: state(), refresh()
 * @param {object} [deps.log]
 * @param {object} [deps.store] settings (extraWowFolders)
 * Test overrides: scanDefaults, setTimeout/clearTimeout, now() → ms, intervalMs, kickGapMs, timeoutMs.
 */
function createMembership({ api, wow, auth, log, store, ...opts } = {}) {
  const o = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    if (Number.isFinite(opts[key]) && opts[key] >= 0) o[key] = opts[key];
  }
  const setTimer = typeof opts.setTimeout === 'function' ? opts.setTimeout : setTimeout;
  const clearTimer = typeof opts.clearTimeout === 'function' ? opts.clearTimeout : clearTimeout;
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const scanDefaults = opts.scanDefaults !== false;
  const logger = log || noopLog;
  const emitter = new EventEmitter();

  let last = null; // last result
  let running = null; // the auto-join request in progress
  let lastTryAt = 0;
  let active = false; // background loop on
  let timer = null;
  let ticking = null;
  let loggedReason = null;
  let loggedError = null;

  const authState = () => {
    try { return (auth && auth.state()) || {}; } catch { return {}; }
  };
  const signedIn = () => (auth ? Boolean(authState().signedIn) : true);
  // Looking for a guild only makes sense while signed in and not in one.
  const wanted = () => signedIn() && !authState().guild;

  function record(result) {
    const r = normalizeResult(result);
    last = r;
    if (r.reason !== loggedReason) {
      loggedReason = r.reason;
      if (r.status === 'joined') logger.info(`Joined ${r.guild ? r.guild.name : 'the guild'}${r.character ? ` (matched ${r.character})` : ''}.`);
      else if (r.status !== 'already') logger.info(`Not in the guild yet: ${r.reason}`);
    }
    try { emitter.emit('change', { ...r }); } catch (err) { logger.warn(`A "change" listener failed: ${err.message}`); }
    return { ...r };
  }

  function detect() {
    if (!wow || typeof wow.detectGuild !== 'function') return { characters: [], guild: null };
    try {
      const extraRoots = store ? store.get().extraWowFolders || [] : [];
      const found = wow.detectGuild({ extraRoots, scanDefaults });
      return found && Array.isArray(found.characters) ? found : { characters: [], guild: null };
    } catch (err) {
      logger.warn(`Couldn't read the characters the addon saved: ${err.message}`);
      return { characters: [], guild: null };
    }
  }

  async function attempt() {
    if (!signedIn()) throw Object.assign(new Error('Sign in with Battle.net first.'), { status: 401 });
    const found = detect();
    let raw;
    try {
      raw = await api.request('POST', '/api/guild/auto-join', { characters: cleanCharacters(found.characters) }, { timeout: o.timeoutMs });
    } catch (err) {
      // A server from before automatic joining doesn't know the address.
      if (err && err.status === 404) {
        raw = { status: 'disabled', reason: "This guild server can't add members by itself yet. Use an invite link from an officer." };
      } else {
        throw err;
      }
    }
    const result = normalizeResult(raw);
    // The guild the addon saw is what the "set up this guild" step offers, when the server didn't name one.
    if (result.status === 'no-guild-on-server' && !result.detected && found.guild) result.detected = cleanDetected(found.guild);
    return result;
  }

  /** One try now. Concurrent calls share it. Rejects when the server can't be reached. */
  function autoJoin() {
    if (running) return running;
    running = (async () => {
      try {
        const result = record(await attempt());
        loggedError = null;
        if ((result.status === 'joined' || result.status === 'already') && auth && typeof auth.refresh === 'function') {
          try { await auth.refresh(); } catch (err) { logger.warn(`Couldn't load your profile: ${err.message}`); }
        }
        return result;
      } finally {
        lastTryAt = now();
        running = null;
      }
    })();
    return running;
  }

  function clear() {
    if (timer) {
      clearTimer(timer);
      timer = null;
    }
  }

  function schedule() {
    clear();
    if (!active) return;
    timer = setTimer(() => { timer = null; tick(); }, o.intervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  function quietly(err) {
    const message = String((err && err.message) || err || 'Unknown problem.');
    if (message !== loggedError) {
      loggedError = message;
      logger.warn(`Couldn't check which guild you're in: ${message}`);
    }
    return last ? { ...last } : null;
  }

  // One background try, then the next one is booked. Stops once in a guild or signed out.
  function tick() {
    clear();
    if (!active) return Promise.resolve(last);
    if (!wanted()) {
      stop();
      return Promise.resolve(last);
    }
    if (!ticking) {
      ticking = autoJoin().catch(quietly).then((r) => {
        ticking = null;
        if (active) {
          if (wanted()) schedule();
          else stop();
        }
        return r;
      });
    }
    return ticking;
  }

  function start() {
    if (active) return ticking || Promise.resolve(last);
    if (!wanted()) return Promise.resolve(last);
    active = true;
    logger.info('Looking for your guild.');
    return tick();
  }

  function stop({ forget = false } = {}) {
    active = false;
    clear();
    if (forget) {
      last = null;
      loggedReason = null;
      loggedError = null;
    }
  }

  /** A SavedVariables file changed: try again now, unless a try just ran (same data). */
  function kick() {
    if (!wanted()) return Promise.resolve(last);
    if (running) return running.catch(quietly);
    if (now() - lastTryAt < o.kickGapMs) return Promise.resolve(last);
    if (active) return tick();
    return autoJoin().catch(quietly);
  }

  return Object.assign(emitter, {
    autoJoin,
    status: () => (last ? { ...last } : null),
    record,
    start,
    stop,
    kick,
    isRunning: () => active,
  });
}

module.exports = {
  createMembership,
  normalizeResult,
  joinedResult,
  cleanCharacters,
  MEMBERSHIP_DEFAULTS: DEFAULTS,
  STATUSES,
};
