'use strict';
// Local changes going out (docs/SHARING.md §9, §10 "Export"): queue() writes an outbox entry plus a
// provisional record and remakes the touched rows at once; the inbox carries the entry to the addon.
const crypto = require('crypto');
const S = require('../../shared/sharing');
const identity = require('../identity');
const { HttpError } = require('../http');
const st = require('./store');
const project = require('./project');
const text = require('./text');

const rng = () => crypto.randomInt(36) / 36;
const newKey = () => S.randomKey(rng);

// My player id in the guild (default: the current one); made once per guild, on my main character of that
// guild, when there is none. null before any character of mine is known to be in the guild (its game guild
// from my upload, or the guild's roster): a character whose guild isn't known is never an anchor.
function ensurePid(db, guildId) {
  const g = st.guildRow(db, guildId);
  if (!g) return null;
  const have = st.myPid(db, g.id);
  if (have) return have;
  const anchor = st.myCharacters(db, g.id).filter((n) => S.authorOk(n))[0];
  if (!anchor) return null;
  const pid = S.newPid(anchor, rng);
  st.setMyPid(db, g.id, pid);
  return pid;
}

// v of the newest record the addon stores for this id ('' when none): the base of a compare-and-set edit.
// (For a record ignored here, that is the ignored version: the addon compares against what it holds.)
function baseOf(db, guildId, id) {
  const r = db.prepare('SELECT v FROM shared_records WHERE guild_id = ? AND id = ?').get(guildId, id);
  return r ? r.v : '';
}

// The record the rows show for an id, decoded, with { pending, state: 'ok'|'pending', str } — or null.
function recordOf(db, guildId, id) {
  const e = st.effective(db, guildId, id);
  if (!e) return null;
  return { ...e.rec, str: e.str, pending: e.pending, state: e.pending ? 'pending' : 'ok' };
}

const NEED = new Set(['o', 'g']);

/**
 * queue(db, ctx, { type, key, fields, del, need, base, chan }) → { op, id, key }
 * Throws HttpError 409 when there is no guild or no character to sign with, 400 for a bad record.
 */
function queue(db, ctx, args = {}) {
  const out = db.transaction(() => queueNow(db, args))();
  if (ctx && typeof ctx.outboxChanged === 'function') ctx.outboxChanged();
  return out;
}

function queueNow(db, { type, key, fields, del = false, need, base, chan } = {}) {
  const guild = identity.currentGuild(db);
  if (!guild) throw new HttpError(409, 'Guild Camp hasn\'t seen your guild yet. Log in to a character in your guild, then log out or type /reload.');
  const gid = guild.id;
  const spec = S.TYPES[type];
  if (!spec) throw new HttpError(400, 'That kind of change can\'t be shared.');
  if (typeof key !== 'string' || !S.keyOk(type, key)) throw new HttpError(400, 'That change has a bad key.');
  const author = st.myAuthor(db, gid);
  if (!author) throw new HttpError(409, 'Log in to World of Warcraft on a character in your guild first, then log out or type /reload.');
  const id = `${type}:${key}`;
  const isDel = Boolean(del);
  const f = isDel ? null : (fields && typeof fields === 'object' ? fields : {});
  const before = st.effective(db, gid, id);
  const t = S.nextT(st.serverNow(db), before ? before.rec.t : null);
  const final = !isDel && S.isFinal({ type, del: false, fields: f });
  const record = S.encode({ type, key, v: S.makeVersion(t, author, final), author, del: isDel, fields: f });
  const check = S.checkRecord(record, t);
  if (check === 'oversize') throw new HttpError(400, 'That is too large to share with your guild. Make it shorter.');
  if (check && check !== 'expired') throw new HttpError(400, 'That change can\'t be shared.');
  const body = isDel ? '' : S.encodeBody(type, key, f);

  const old = st.activeEntries(db, gid, id);
  let b = typeof base === 'string' ? base : baseOf(db, gid, id);
  if (old.length) b = old[0].base; // a replaced entry keeps the first base
  // Replaced entries stay 'dropped' for a while, so a late acknowledgement of one is still recognised.
  for (const o of old) db.prepare("UPDATE share_outbox SET state = 'dropped', note = NULL WHERE op = ?").run(o.op);
  const op = st.nextOp(db);
  // Officer-space records always wait for an officer character (CFG for the Guild Master); WH goes on OFFICER.
  const needV = NEED.has(need) ? need : spec.rank === 'gm' ? 'g' : S.spaceOf(type) === 'officer' ? 'o' : null;
  const chanV = chan === 'OFFICER' || spec.channel === 'OFFICER' ? 'OFFICER' : null;
  db.prepare(`INSERT INTO share_outbox (op, guild_id, rec_id, t, base, need, chan, del, body, record, state, note, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?, 'queued', ?, ?)`)
    .run(op, gid, id, t, b || '', needV, chanV, isDel ? 1 : 0, body, record,
      text.LINES.saved, st.iso(st.localNow()).replace('T', ' ').slice(0, 19));

  const out = project.run(db, gid, project.tasksFor(S.decode(record), before && before.rec));
  if (out.ranks) identity.syncRanks(db, gid);
  return { op, id, key };
}

// Drops a queued or waiting entry and puts the rows back as they were. → true when one was dropped.
function cancel(db, ctx, op) {
  const done = db.transaction(() => cancelNow(db, op))();
  if (done && ctx && typeof ctx.outboxChanged === 'function') ctx.outboxChanged();
  return done;
}

function cancelNow(db, op) {
  const row = st.outboxRow(db, op);
  const guild = identity.currentGuild(db);
  if (!row || !guild || row.guild_id !== guild.id || !st.ACTIVE.includes(row.state)) return false;
  const rec = row.record ? S.decode(row.record) : null;
  db.prepare("UPDATE share_outbox SET state = 'dropped', note = NULL WHERE op = ?").run(op);
  const now = st.effective(db, row.guild_id, row.rec_id);
  const tasks = [...project.tasksFor(rec, null), ...project.tasksFor(now && now.rec, null)];
  const out = project.run(db, row.guild_id, tasks);
  if (out.ranks) identity.syncRanks(db, row.guild_id);
  return true;
}

module.exports = { queue, cancel, newKey, ensurePid, baseOf, recordOf };
