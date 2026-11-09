'use strict';
// The in-process event bus: what used to be the server's events table + the app polling GET /api/events.
//
// Routes call ctx.emit(guildId, kind, opts) exactly as they did on the server. Only the player on this
// computer can see anything, so emit() decides here whether "me" should hear about it:
//   userId / userIds   only that member (or members): shown when it is me
//   exceptUserId       everyone but that member (usually whoever caused it): hidden when it is me
//   officersOnly       only the Guild Master and officers
//   recipe             only when one of my characters in the guild knows that recipe (case-insensitive); like the
//                      crafter lists, not one in another game guild or in no guild (identity.notElsewhere)
//   prefs              my notification choices (users.notify_prefs), per kind
// A visible event is kept in the events table (pruned after 14 days, a short history) and sent on the
// emitter as 'event' { id, kind, title, body, route, created_at }. main.js turns that into a native
// notification and the renderer's 'server-event' channel.
//
// Exports: createEvents(db, { log, emitter, meId, roleOf }) → { emit, recent, prune }
//          readPrefs(value), mergePrefs(current, patch), KINDS, KIND_PREF, DEFAULT_PREFS
const { str } = require('./http');
const { notElsewhere } = require('./identity');

const KINDS = ['cta', 'raid', 'notice', 'request', 'bank', 'coach', 'drive', 'release'];
// Event kind → the notify_prefs key that turns it off. Kinds not listed (release) always show.
const KIND_PREF = { cta: 'cta', raid: 'raids', notice: 'notices', request: 'requests', bank: 'bank', coach: 'coach', drive: 'drives' };
const DEFAULT_PREFS = Object.freeze({ cta: true, raids: true, notices: true, requests: true, bank: true, coach: true, drives: true });
const PRUNE_DAYS = 14;

// Full prefs object from users.notify_prefs (JSON text, an object, or null). Unknown keys are dropped.
function readPrefs(value) {
  let p = value;
  if (typeof p === 'string') { try { p = JSON.parse(p); } catch { p = null; } }
  const out = { ...DEFAULT_PREFS };
  if (p && typeof p === 'object') for (const k of Object.keys(DEFAULT_PREFS)) if (typeof p[k] === 'boolean') out[k] = p[k];
  return out;
}

// Applies a partial update ({ raids: false }) to the current prefs. Non-boolean values are ignored.
function mergePrefs(current, patch) {
  const out = readPrefs(current);
  if (patch && typeof patch === 'object') for (const k of Object.keys(DEFAULT_PREFS)) if (typeof patch[k] === 'boolean') out[k] = patch[k];
  return out;
}

const cleanId = (v) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);
// App routes look like "/raids/12" or "/requests?mine=1".
const cleanRoute = (v) => (typeof v === 'string' && /^\/[\w\-./?=&%#:]*$/.test(v) && v.length <= 200 ? v : null);

/**
 * @param {object} db
 * @param {object} deps
 * @param {object} deps.emitter       EventEmitter that receives 'event'
 * @param {() => number} deps.meId    my users.id
 * @param {(guildId) => string|null} deps.roleOf   my role in that guild
 * @param {object} [deps.log]
 */
function createEvents(db, { log = console, emitter, meId, roleOf } = {}) {
  const q = {
    insert: db.prepare(`INSERT INTO events (guild_id, kind, title, body, route, user_id, except_user_id, officers_only, recipe)
      VALUES (?,?,?,?,?,?,?,?,?)`),
    row: db.prepare('SELECT id, kind, title, body, route, created_at FROM events WHERE id = ?'),
    recent: db.prepare('SELECT id, kind, title, body, route, created_at FROM events WHERE guild_id = ? ORDER BY id DESC LIMIT ?'),
    prune: db.prepare("DELETE FROM events WHERE created_at < datetime('now', ?)"),
    prefs: db.prepare('SELECT notify_prefs FROM users WHERE id = ?'),
    knows: db.prepare(`SELECT 1 FROM recipes r JOIN characters c ON c.id = r.character_id
      WHERE c.guild_id = ? AND c.user_id = ? AND ${notElsewhere('c')} AND lower(r.name) = lower(?) LIMIT 1`),
  };
  let lastPrune = 0;

  function prune() {
    lastPrune = Date.now();
    return q.prune.run(`-${PRUNE_DAYS} days`).changes;
  }

  function visibleToMe(gid, kind, { userId, userIds, exceptUserId, officersOnly, recipe }) {
    const me = meId();
    if (Array.isArray(userIds)) {
      if (!userIds.map(cleanId).includes(me)) return false;
    } else if (userId != null && cleanId(userId) !== me) {
      return false;
    }
    if (exceptUserId != null && cleanId(exceptUserId) === me) return false;
    if (officersOnly) {
      const role = roleOf(gid);
      if (role !== 'owner' && role !== 'officer') return false;
    }
    if (recipe && !q.knows.get(gid, me, String(recipe))) return false;
    const pref = KIND_PREF[kind];
    if (pref && readPrefs((q.prefs.get(me) || {}).notify_prefs)[pref] === false) return false;
    return true;
  }

  // Returns the event id when it was shown to me, otherwise null. Never throws: a failed notification
  // must not undo the action that caused it.
  function emit(guildId, kind, opts = {}) {
    try {
      const gid = cleanId(guildId);
      if (!gid || typeof kind !== 'string' || !/^[a-z]{1,20}$/.test(kind)) {
        log.warn(`Event not sent: bad guild or kind (${guildId}, ${kind})`);
        return null;
      }
      if (!KINDS.includes(kind)) log.warn(`Event kind "${kind}" is not one of ${KINDS.join(', ')}`);
      if (Date.now() - lastPrune > 3600 * 1000) prune();
      const o = opts && typeof opts === 'object' ? opts : {};
      if (!visibleToMe(gid, kind, o)) return null;
      const id = Number(q.insert.run(gid, kind, str(o.title, 120) || kind, str(o.body, 300), cleanRoute(o.route),
        cleanId(o.userId), cleanId(o.exceptUserId), o.officersOnly ? 1 : 0, str(o.recipe, 100)).lastInsertRowid);
      const event = q.row.get(id);
      if (emitter) {
        try { emitter.emit('event', event); } catch (e) { log.warn('An event listener failed:', e.message); }
      }
      return id;
    } catch (e) {
      log.warn('Event not sent:', e.message);
      return null;
    }
  }

  // The newest events shown for this guild (newest first).
  const recent = (guildId, limit = 50) => q.recent.all(guildId, Math.max(1, Math.min(200, limit)));

  return { emit, recent, prune };
}

module.exports = { createEvents, readPrefs, mergePrefs, KINDS, KIND_PREF, DEFAULT_PREFS, PRUNE_DAYS };
