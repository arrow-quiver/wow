// App notifications. Routes call ctx.emit(); the desktop app polls GET /api/events?after=<id>
// every 20 s and shows a native notification for each event returned.
//
// Who sees an event:
//   userId / userIds   only that member (userIds inserts one row per member; [] inserts nothing)
//   exceptUserId       everyone but that member (usually whoever caused the event)
//   officersOnly       only the owner and officers
//   recipe             only members with a character that knows this recipe (case-insensitive)
//   prefs              the member's notification choices (users.notify_prefs), per kind
// Events older than 14 days are pruned.
const { str } = require('../http');

const KINDS = ['cta', 'raid', 'notice', 'request', 'bank', 'coach', 'drive', 'release'];
// Event kind → the notify_prefs key that turns it off. Kinds not listed (release) always show.
const KIND_PREF = { cta: 'cta', raid: 'raids', notice: 'notices', request: 'requests', bank: 'bank', coach: 'coach', drive: 'drives' };
const DEFAULT_PREFS = Object.freeze({ cta: true, raids: true, notices: true, requests: true, bank: true, coach: true, drives: true });
const PRUNE_DAYS = 14;
const PAGE_SIZE = 100;

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

function allowedByPrefs(kind, prefs) {
  const key = KIND_PREF[kind];
  return !key || prefs[key] !== false;
}

const cleanId = (v) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);
// App routes look like "/raids/12" or "/requests?mine=1".
const cleanRoute = (v) => (typeof v === 'string' && /^\/[\w\-./?=&%#:]*$/.test(v) && v.length <= 200 ? v : null);

function createEvents(db, { log = console } = {}) {
  const q = {
    insert: db.prepare(`INSERT INTO events (guild_id, kind, title, body, route, user_id, except_user_id, officers_only, recipe)
      VALUES (?,?,?,?,?,?,?,?,?)`),
    maxId: db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM events WHERE guild_id = ?'),
    prune: db.prepare("DELETE FROM events WHERE created_at < datetime('now', ?)"),
    page: db.prepare(`SELECT e.id, e.kind, e.title, e.body, e.route, e.created_at FROM events e
      WHERE e.guild_id = @guildId AND e.id > @after
        AND (e.user_id IS NULL OR e.user_id = @userId)
        AND (e.except_user_id IS NULL OR e.except_user_id != @userId)
        AND (e.officers_only = 0 OR @officer = 1)
        AND (e.recipe IS NULL OR EXISTS (
          SELECT 1 FROM recipes r JOIN characters c ON c.id = r.character_id
          WHERE c.guild_id = e.guild_id AND c.user_id = @userId AND lower(r.name) = lower(e.recipe)))
      ORDER BY e.id LIMIT @limit`),
  };
  let lastPrune = 0;

  function prune() {
    lastPrune = Date.now();
    return q.prune.run(`-${PRUNE_DAYS} days`).changes;
  }

  // Inserts the event and returns its id (the last id when userIds made several rows), or null.
  // Never throws: a failed notification must not undo the action that caused it.
  function emit(guildId, kind, { title, body, route, userId, userIds, exceptUserId, officersOnly, recipe } = {}) {
    try {
      const gid = cleanId(guildId);
      if (!gid || typeof kind !== 'string' || !/^[a-z]{1,20}$/.test(kind)) {
        log.warn(`Event not sent: bad guild or kind (${guildId}, ${kind})`);
        return null;
      }
      if (!KINDS.includes(kind)) log.warn(`Event kind "${kind}" is not one of ${KINDS.join(', ')}`);
      if (Date.now() - lastPrune > 3600 * 1000) prune();
      const targets = Array.isArray(userIds) ? [...new Set(userIds.map(cleanId).filter(Boolean))] : [cleanId(userId)];
      if (!targets.length) return null;
      const row = [
        str(title, 120) || kind, str(body, 300), cleanRoute(route),
        cleanId(exceptUserId), officersOnly ? 1 : 0, str(recipe, 100),
      ];
      let id = null;
      db.transaction(() => {
        for (const uid of targets) {
          id = Number(q.insert.run(gid, kind, row[0], row[1], row[2], uid, row[3], row[4], row[5]).lastInsertRowid);
        }
      })();
      return id;
    } catch (e) {
      log.warn('Event not sent:', e.message);
      return null;
    }
  }

  // Highest event id in the guild (0 when there are none).
  function latestId(guildId) {
    return q.maxId.get(guildId).id;
  }

  // Events after `afterId` that this member should see, oldest first, and the cursor to send next time.
  // afterId null/undefined → no events, just the current cursor (a freshly started app gets no flood).
  function listFor(user, guildId, role, afterId, prefs) {
    const userId = typeof user === 'object' && user ? user.id : user;
    const max = latestId(guildId);
    if (afterId == null || afterId >= max) return { events: [], latestId: max };
    const rows = q.page.all({
      guildId, after: Math.max(0, afterId), userId,
      officer: role === 'owner' || role === 'officer' ? 1 : 0, limit: PAGE_SIZE,
    });
    // A full page means more may follow: resume after the last row scanned. Otherwise the cursor
    // jumps to the newest event, skipping rows meant for other members.
    const cursor = rows.length === PAGE_SIZE ? rows[rows.length - 1].id : max;
    const p = readPrefs(prefs);
    return { events: rows.filter((e) => allowedByPrefs(e.kind, p)), latestId: cursor };
  }

  return { emit, listFor, latestId, prune };
}

module.exports = { createEvents, readPrefs, mergePrefs, KINDS, KIND_PREF, DEFAULT_PREFS, PRUNE_DAYS };
