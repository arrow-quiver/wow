'use strict';
// Dropping the records every addon has already expired (docs/SHARING.md §11) from this computer's copy, so the
// database never holds more than an addon store would, without changing what any page shows.
//
//   pruneShared(db, guildId, now) → number of records dropped
//       A record goes once it has expired by the codec's own rule (S.isExpired at the start of the hour, with its
//       parent still known), and the version the rows show has expired too. Records of types this version doesn't
//       know go after 14 days, tombstones after their lifetime, raid closes and awards only once an LY covers them.
//       A record with a change of mine still to send stays (its rows go back to it if the change is refused).
//   maybePrune(db, guildId, now) → pruneShared at most once per server hour per guild (share_pruned_at:<guild>), then
//       forgetPruned and forgetClosedUnknown
//   forgetPruned(db, guildId, hour) → share_pruned entries dropped: those whose until has passed, unless a record still
//       stored here expires with that id (a raid close waiting for its SR+ checkpoint, say)
//   forgetClosedUnknown(db, guildId, hour) → answered author checks about records of a type this version doesn't know,
//       dropped once every record in them has expired (a copy coming back would be refused anyway)
//   expiredHere(db, guildId, rec) → true when an incoming record is one this computer dropped (that version or
//       an older one) or a child of a dropped parent ("with the raid / request / drive"): it has expired too. A raid
//       close not yet covered by an SR+ checkpoint is taken whatever its raid: no addon expires it.
//
// The rows a dropped record made stay as history: share_pruned keeps its id and last version, and the
// projectors (share/project.js) leave an entity's rows alone when its record was dropped rather than removed.
// It also keeps until: when a late copy of that version, or of a record that expires with it, could no longer be
// taken anyway. After that the entry goes, so the table doesn't grow for good. Entries of raids, drives, loot lists,
// awards and characters stay (until NULL): a record that arrives much later can still touch their rows (an award
// or close of an old raid, a player's alt), and their rows are history the pages show.
const S = require('../../shared/sharing');
const st = require('./store');

const DAY = S.K.DAY;
// Slack on top of every lifetime below (clock differences between PCs, a game left closed for weeks).
const MARGIN_DAYS = 30;
// How long an SR+ checkpoint (LY) lives: a raid close or award is dropped only once one covers it.
const LY_DAYS = 180;
// The types other records expire with ("with the raid / request / drive / bank request").
const PARENTS = new Set(Object.values(S.TYPES).map((spec) => spec && spec.expiry && spec.expiry.parent).filter(Boolean));
// Dropped records whose entry stays for good (see above).
const KEEP = new Set(['RD', 'DR', 'LL', 'LA', 'ch']);

// When a late copy of this dropped record can no longer be taken anyway (server seconds): the latest expiry the codec
// could give it or an older version of it, with its parent known or not; for a parent, the latest a child's copy
// could live with its parent unknown (PARENT_FALLBACK_DAYS); for a close or award, an SR+ checkpoint's lifetime too.
// null: the entry stays (KEEP).
function prunedUntil(rec, lookup) {
  if (KEEP.has(rec.type)) return null;
  const spec = S.TYPES[rec.type];
  const e = (spec && spec.expiry) || {};
  const t = Number(rec.t) || 0;
  let at = Math.max(t, S.expiresAt(rec, lookup) || 0, S.expiresAt(rec, () => null) || 0);
  if (e.days) at = Math.max(at, t + Math.max(e.days, e.finalDays || 0) * DAY);
  if (e.parent) at = Math.max(at, t + S.K.PARENT_FALLBACK_DAYS * DAY);
  if (PARENTS.has(rec.type)) at += S.K.PARENT_FALLBACK_DAYS * DAY;
  if (spec && spec.fold) at += LY_DAYS * DAY;
  return at + MARGIN_DAYS * DAY;
}

// The id of the record whose expiry this one follows, or null.
function parentId(rec) {
  const spec = rec && S.TYPES[rec.type];
  const e = spec && spec.expiry;
  if (!e || !e.parent) return null;
  let key = null;
  if (e.seg) key = String(rec.key).split(':')[e.seg - 1] || null;
  else if (e.field && rec.fields && typeof rec.fields[e.field] === 'string' && rec.fields[e.field]) key = rec.fields[e.field];
  return key ? `${e.parent}:${key}` : null;
}

function expiredHere(db, guildId, rec) {
  if (!rec) return false;
  const v = st.prunedV(db, guildId, rec.id);
  if (v !== null && S.compareVersions(rec.v, v) <= 0) return true;
  // A record that expires with its parent has expired once the parent was dropped, except one kept until an SR+
  // checkpoint covers it (a raid close): every addon keeps that one, parent or not (S.isExpired, at any hour).
  const parent = parentId(rec);
  if (parent && st.wasPruned(db, guildId, parent) && !st.storedRow(db, guildId, parent)
    && S.isExpired(rec, Number.MAX_SAFE_INTEGER, st.lookupFor(db, guildId))) return true;
  return false;
}

function pruneShared(db, guildId, now) {
  const hour = S.hourStart(now);
  const lookup = st.lookupFor(db, guildId);
  const pending = new Set(db.prepare("SELECT DISTINCT rec_id FROM share_outbox WHERE guild_id = ? AND state IN ('queued','waiting')")
    .all(guildId).map((r) => r.rec_id));
  // Decide every record first, while every parent is still there to look up.
  const gone = [];
  for (const r of db.prepare('SELECT id, v, body, state, kept FROM shared_records WHERE guild_id = ?').all(guildId)) {
    if (pending.has(r.id) || !S.isExpired(r.body, hour, lookup)) continue;
    const shown = r.state === 'ok' ? r.body : r.kept;
    if (shown && shown !== r.body && !S.isExpired(shown, hour, lookup)) continue;
    gone.push({ ...r, made: Boolean(shown) });
  }
  const del = db.prepare('DELETE FROM shared_records WHERE guild_id = ? AND id = ?');
  const mark = db.prepare(`INSERT INTO share_pruned (guild_id, id, v, until) VALUES (?,?,?,?)
    ON CONFLICT (guild_id, id) DO UPDATE SET v = excluded.v, until = excluded.until, at = datetime('now')`);
  const sent = db.prepare('SELECT v FROM share_sent WHERE guild_id = ? AND rec_id = ?');
  const unsend = db.prepare('DELETE FROM share_sent WHERE guild_id = ? AND rec_id = ? AND v = ?');
  for (const r of gone) {
    del.run(guildId, r.id);
    const type = r.id.slice(0, r.id.indexOf(':'));
    // Rows were made from it: they stay, and the id remembers its last version. (Unknown types and records only
    // ever ignored made none.)
    if (S.TYPES[type] && r.made) {
      const rec = S.decode(r.body);
      mark.run(guildId, r.id, r.v, rec ? prunedUntil(rec, lookup) : null);
    }
    // My log of sent versions has no use for versions that can't come back any more.
    for (const s of sent.all(guildId, r.id)) if (S.compareVersions(s.v, r.v) <= 0) unsend.run(guildId, r.id, s.v);
  }
  return gone.length;
}

function forgetPruned(db, guildId, hour) {
  const due = db.prepare('SELECT id FROM share_pruned WHERE guild_id = ? AND until IS NOT NULL AND until <= ?').all(guildId, hour);
  if (!due.length) return 0;
  // A record still here (stored, or a change of mine still to send) that expires with the id keeps it: while it is
  // here, the rows of that id are history, not removed.
  const parents = new Set();
  const bodies = db.prepare(`SELECT body FROM shared_records WHERE guild_id = ?
    UNION ALL SELECT record AS body FROM share_outbox WHERE guild_id = ? AND state IN ('queued','waiting') AND record IS NOT NULL`).all(guildId, guildId);
  for (const r of bodies) {
    const p = parentId(S.decode(r.body));
    if (p) parents.add(p);
  }
  const del = db.prepare('DELETE FROM share_pruned WHERE guild_id = ? AND id = ?');
  let n = 0;
  for (const r of due) if (!parents.has(r.id)) n += del.run(guildId, r.id).changes;
  return n;
}

function forgetClosedUnknown(db, guildId, hour) {
  const gone = (recs) => {
    let list = [];
    try { list = JSON.parse(recs || '[]'); } catch { list = []; }
    return (Array.isArray(list) ? list : []).every((x) => !Array.isArray(x) || (S.tOfVersion(x[1]) || 0) + (S.K.UNKNOWN_DAYS + 1) * DAY <= hour);
  };
  const del = db.prepare('DELETE FROM share_author_checks WHERE id = ?');
  let n = 0;
  for (const c of db.prepare("SELECT id, recs FROM share_author_checks WHERE guild_id = ? AND kind = 'unknown' AND state != 'open'").all(guildId)) {
    if (gone(c.recs)) n += del.run(c.id).changes;
  }
  return n;
}

function maybePrune(db, guildId, now) {
  const hour = S.hourStart(now);
  const key = `share_pruned_at:${guildId}`;
  if (Number(st.get(db, key)) === hour) return 0;
  const n = pruneShared(db, guildId, now);
  forgetPruned(db, guildId, hour);
  forgetClosedUnknown(db, guildId, hour);
  st.set(db, key, hour);
  return n;
}

module.exports = { pruneShared, maybePrune, expiredHere, parentId, prunedUntil, forgetPruned, forgetClosedUnknown };
