'use strict';
// Guild data shared through the addon in game (docs/SHARING.md; protocol codec in shared/sharing.js).
//
// On this computer the data crosses two files:
//   game → app   WowGuildDB.shared (SavedVariables): services/sync.js applyPayload() calls importShared()
//                inside the upload's transaction, after the player's characters and roster.
//   app → game   WowGuild_Inbox/Inbox.lua: services/sync.js buildInbox() adds exportOutbox() as `outbox`,
//                exportMe() as `me` and exportSeed() as `seed`.
//
// Domain rows of shared record types are a PROJECTION of the stored records (shared_records 'ok') plus
// this computer's own pending outbox entries (share/project.js). A route that changes shared data checks
// input and role as before, then calls queue(): that writes the outbox entry and a provisional record and
// remakes the rows at once, so the page shows the change straight away. When the game refuses the change,
// the rows are made again without it. Rows carry the record key in share_id.
//
// API (others depend on it)
//   queue(db, ctx, { type, key, fields, del, need: 'o'|'g'|undefined, base, chan: 'OFFICER'|undefined }) → { op, id, key }
//       fields are named as in shared/sharing.js TYPES (docs/SHARING.md Appendix A). A new entry for a
//       record already queued replaces it and keeps the first base. base defaults to baseOf(); need defaults
//       to 'o' for officer-space types ('g' for CFG); WH always goes on OFFICER. Atomic (its own savepoint).
//       Do not write the domain rows yourself: queue() makes them (find them by share_id = key).
//       Throws HttpError 409 (no guild / no character yet) or 400 (bad or oversize record).
//   newKey() → 6 random base36 characters (the key of a new raid, request, notice ...)
//   myPid(db, guildId?) → my player id in the guild (default the current one; ids are per guild, made on my
//       main character of that guild the first time; null before any character of mine there is known)
//   baseOf(db, guildId, id) → v of the newest stored record ('' none): the base for compare-and-set
//   recordOf(db, guildId, id) → the record the rows show, decoded, + { str, pending, state } | null
//   summaryOf(record, lookup?) → "Molten Core Thursday: locked"
//   pidOf(db, userId, guildId?) → player id of a users row (mine: in that guild, default the current one) | null
//   userOf(db, guildId, pid) → users.id (made if new)
//   raidCloseFields(db, guildId, raidKey, attendeeUserIds, { closedAt }) → RT 'd' fields (snapshot, no-shows)
//   importShared(db, ctx, payloadShared, { file }) → { imported, ignored, acked, refused, checks, checkpoints, posts }
//   afterImport(ctx, sharedStats) sends the Discord posts importShared collected (after the transaction)
//   queuePrices(db, ctx, guildId, userId, prices) → queued pr once a day from the player's Auctionator data
//   exportOutbox(db) / exportMe(db) / exportSeed(db, guildId)
//   status(db, ctx) → GET /api/share/status; cancel(db, ctx, op); authorCheck(db, ctx, id, 'mine'|'undo');
//   webhookOffer(db) / takeWebhook(db) / dismissWebhook(db) / shareWebhook(db, ctx)
//   repairIdentity(db) once at core start (share/repair.js): unlinks characters an older version linked to me
//       through a guildmate's ch, and asks when my player id is made on a character that isn't mine
//   LINES (the UI's plain-English lines), partitionOf(db, guild) (the addon's "<realm>/<guild>" key)
//   setClock(fn) tests only: replace the computer's clock (ms)
const S = require('../shared/sharing');
const identity = require('./identity');
const { HttpError } = require('./http');
const st = require('./share/store');
const project = require('./share/project');
const text = require('./share/text');
const { queue, cancel, newKey, ensurePid, baseOf, recordOf } = require('./share/queue');
const { importShared, namesText, retryNow } = require('./share/import');
const { repairIdentity } = require('./share/repair');
const { exportOutbox, exportMe, exportSeed } = require('./share/export');

const DAY = 86400;

function summaryOf(record, lookup) { return text.summaryOf(record, lookup); }

const userOf = (db, guildId, pid) => st.userForPid(db, guildId, pid);
const pidOf = (db, userId, guildId) => st.pidOfUser(db, userId, guildId);

// The RT 'd' fields of a raid close: attendees with the reserves that counted (minus items they won in this
// raid) and the players who signed up "yes" but did not come (§4.3, §4.4).
function raidCloseFields(db, guildId, raidKey, attendeeUserIds, { closedAt } = {}) {
  const rd = st.live(db, guildId, `RD:${raidKey}`);
  if (!rd) throw new HttpError(404, 'That raid was not found. It may have been removed.');
  const rt = st.effective(db, guildId, `RT:${raidKey}`);
  const status = S.raidStatus(rt ? rt.str : null);
  const lockedAt = status.status === 'open' ? null : status.lockedAt;
  const won = new Map();
  for (const [, e] of st.effectiveMany(db, guildId, 'LA:')) {
    const f = !e.rec.del && e.rec.fields;
    if (f && f.raid === raidKey && f.pid && f.item) (won.get(f.pid) || won.set(f.pid, new Set()).get(f.pid)).add(f.item);
  }
  const signups = new Map();
  for (const [id, e] of st.effectiveMany(db, guildId, `su:${raidKey}:`)) {
    if (!e.rec.del && e.rec.fields) signups.set(id.split(':')[2], e);
  }
  const attending = new Set();
  for (const uid of attendeeUserIds || []) {
    const pid = st.pidOfUser(db, uid);
    if (pid) attending.add(pid);
  }
  const attendees = [...attending].sort().map((pid) => {
    const su = signups.get(pid);
    const items = su ? S.countingReserves(su.str, lockedAt).filter((k) => !(won.get(pid) || new Set()).has(k)) : [];
    return { pid, items: [...new Set(items)] };
  });
  const noShows = [...signups.entries()].filter(([pid, e]) => e.rec.fields.status === 'y' && !attending.has(pid)).map(([pid]) => pid).sort();
  return {
    status: 'd', lockedAt, kind: rd.rec.fields.kind || 'r', instance: S.instanceKey(rd.rec.fields.instance),
    closedAt: closedAt == null ? st.serverNow(db) : closedAt, attendees, noShows,
  };
}

// Discord posts for my own records, after the upload's transaction committed. Never throws.
function afterImport(ctx, shared) {
  if (!ctx || typeof ctx.discord !== 'function' || !shared || !Array.isArray(shared.posts)) return;
  for (const post of shared.posts) {
    Promise.resolve().then(() => ctx.discord(null, post)).catch((e) => ctx.log && ctx.log.warn('Discord post failed:', e.message));
  }
}

// pr: once a day, the newest auction prices of the reagents I want and the guild bank's items (≤ 60).
function queuePrices(db, ctx, guildId, userId, prices) {
  if (!prices || !Array.isArray(prices.items) || !prices.items.length) return null;
  const today = Math.floor(st.serverNow(db) / DAY);
  if (Number(st.get(db, 'share_pr_day')) === today) return null;
  if (!st.myAuthor(db, guildId)) return null;
  const pid = ensurePid(db);
  if (!pid) return null;
  const latest = new Map();
  for (const row of prices.items) {
    if (!Array.isArray(row)) continue;
    const [id, price, day] = row.map(Number);
    if (!(id > 0 && price > 0 && day >= 0) || !Number.isInteger(id)) continue;
    const cur = latest.get(id);
    if (!cur || day > cur.day || (day === cur.day && price < cur.price)) latest.set(id, { price: Math.trunc(price), day: Math.trunc(day) });
  }
  const wanted = db.prepare('SELECT item_id FROM wanted_items WHERE user_id = ? ORDER BY item_id').all(userId).map((r) => r.item_id);
  const bank = db.prepare(`SELECT item_id FROM guild_bank WHERE guild_id = ?
      UNION SELECT i.item_id FROM inventory i JOIN characters c ON c.id = i.character_id WHERE c.guild_id = ? AND c.is_bank = 1
      ORDER BY item_id`).all(guildId, guildId).map((r) => r.item_id);
  const ids = [...new Set([...wanted, ...bank])].filter((id) => latest.has(id)).slice(0, 60);
  if (!ids.length) return null;
  const day = Math.max(...ids.map((id) => latest.get(id).day));
  const r = queue(db, ctx, { type: 'pr', key: pid, fields: { day, prices: ids.map((id) => ({ id, copper: latest.get(id).price })) } });
  st.set(db, 'share_pr_day', today);
  return r;
}

// ---- status and actions (routes/share.js) ------------------------------------------------------
function lookupOf(db, gid) { return (id) => { const e = st.effective(db, gid, id); return e ? e.rec : null; }; }

function entryJson(db, gid, row) {
  const rec = row.record ? S.decode(row.record) : null;
  return {
    op: row.op,
    id: row.rec_id,
    type: row.rec_id.slice(0, row.rec_id.indexOf(':')),
    summary: rec ? text.summaryOf(rec, lookupOf(db, gid)) : row.rec_id,
    state: row.state,
    note: row.note || (row.state === 'queued' ? text.LINES.saved : null),
    createdAt: row.created_at,
    sentAt: row.sent_at || null,
  };
}

function status(db) {
  const g = identity.currentGuild(db);
  const pid = st.myPid(db);
  if (!g) return { enabled: false, pid, peers: 0, records: 0, lastHello: null, lastExchange: null, outbox: [], refused: [], authorChecks: [], webhookOffer: null };
  const stats = st.getJson(db, `share_stats:${g.id}`);
  const outbox = db.prepare(`SELECT * FROM share_outbox WHERE guild_id = ? AND (state IN ('queued','waiting')
      OR (state = 'sent' AND sent_at >= datetime('now', '-1 day'))) ORDER BY created_at DESC, op DESC LIMIT 200`).all(g.id);
  const refused = db.prepare(`SELECT * FROM share_outbox WHERE guild_id = ? AND state = 'refused' ORDER BY COALESCE(sent_at, created_at) DESC LIMIT 50`).all(g.id);
  const checks = db.prepare("SELECT id, summary, via, created_at, kind, n FROM share_author_checks WHERE guild_id = ? AND state = 'open' ORDER BY id DESC LIMIT 50").all(g.id);
  const iso = (t) => (Number.isFinite(t) && t > 0 ? new Date(t * 1000).toISOString() : null);
  return {
    enabled: Boolean(stats),
    pid,
    peers: (stats && stats.peers) || 0,
    records: db.prepare("SELECT COUNT(*) AS n FROM shared_records WHERE guild_id = ? AND state = 'ok'").get(g.id).n,
    lastHello: iso(stats && stats.lastHello),
    lastExchange: iso(stats && stats.lastExchange),
    outbox: outbox.map((r) => entryJson(db, g.id, r)),
    refused: refused.map((r) => entryJson(db, g.id, r)),
    // kind: null (one record), 'unknown' (count records of a type this version doesn't know, from one sender),
    // 'pid' (my player id is made on a character that isn't mine), 'repair' (characters an older version linked to me).
    authorChecks: checks.map((c) => ({ id: c.id, summary: c.summary, via: c.via || null, at: c.created_at, kind: c.kind || null, count: c.n || 1 })),
    webhookOffer: webhookOffer(db),
  };
}

// The characters a ch check is about (share_author_checks.names, JSON), or [] for any other check.
function namesOf(row) {
  try {
    const v = JSON.parse(row.names || '[]');
    return Array.isArray(v) ? v.filter((n) => typeof n === 'string' && n) : [];
  } catch {
    return [];
  }
}

// [[record id, version], ...] a check is about: a grouped check's list, else its own record.
function recsOf(row) {
  try {
    const v = JSON.parse(row.recs || 'null');
    if (Array.isArray(v) && v.length) return v.filter((x) => Array.isArray(x) && typeof x[0] === 'string' && typeof x[1] === 'string');
  } catch { /* the check's own record */ }
  return [[row.rec_id, row.v]];
}

// Characters I said are mine: confirmed (store.mayBeMine), linked now (`link`: also rows a shared ch doesn't link,
// such as one an older version had linked), their rows made again, and the records they wrote in my player id's
// name that were set aside for want of a link used again at once.
function takeAsMine(db, ctx, g, names, link = []) {
  st.confirmAlts(db, g.id, names);
  const me = identity.meId(db);
  for (const n of link) db.prepare('UPDATE characters SET user_id = ? WHERE guild_id = ? AND name = ?').run(me, g.id, n);
  const anchor = st.anchorOf(st.myPid(db, g.id));
  const out = project.run(db, g.id, [...(anchor ? [`ch:${anchor}`] : []), ...names.map((n) => `ch:${n}`)]);
  if (out.ranks || link.length) identity.syncRanks(db, g.id);
  retryNow(db, ctx, g.id);
  if (ctx && typeof ctx.outboxChanged === 'function') ctx.outboxChanged();
}

// Every row of the guild made again from its records (after my player id changed).
function reprojectGuild(db, gid) {
  const tasks = new Set();
  const ids = db.prepare(`SELECT id FROM shared_records WHERE guild_id = ?
    UNION SELECT rec_id AS id FROM share_outbox WHERE guild_id = ? AND state IN ('queued','waiting')`).all(gid, gid);
  for (const { id } of ids) {
    const e = st.effective(db, gid, id);
    if (e) for (const t of project.tasksFor(e.rec, null)) tasks.add(t);
  }
  project.run(db, gid, tasks);
  identity.syncRanks(db, gid);
}

// "Your player id is made on Jaina, who isn't one of your characters" (share/repair.js). "It was me": Jaina is
// mine and the id stays. "Undo it": a new id made on a character of mine in the guild; my sign-ups for raids still
// to come go out again under it, and everything else stays as it is (records made under the old id keep showing
// under it).
function pidCheck(db, ctx, g, row, action) {
  const old = row.v;
  const anchor = namesOf(row)[0] || st.anchorOf(old);
  if (action === 'mine') {
    takeAsMine(db, ctx, g, [anchor], [anchor]);
    db.prepare("UPDATE share_author_checks SET state = 'mine' WHERE id = ?").run(row.id);
    return { ok: true, message: `Thanks. ${anchor} now counts as yours.` };
  }
  if (st.get(db, `me_pid:${g.id}`) === old) st.set(db, `me_pid:${g.id}`, null);
  if (st.get(db, 'me_pid') === old) st.set(db, 'me_pid', null);
  const fresh = ensurePid(db, g.id);
  reprojectGuild(db, g.id);
  if (fresh) {
    const now = st.serverNow(db);
    for (const [id, e] of st.effectiveMany(db, g.id, 'su:')) {
      const [raid, pid] = id.slice(3).split(':');
      if (pid !== old || e.rec.del || !e.rec.fields || !st.isMine(db, g.id, e.rec.author)) continue;
      const rd = st.live(db, g.id, `RD:${raid}`);
      const rt = st.effective(db, g.id, `RT:${raid}`);
      const status = S.raidStatus(rt ? rt.str : null).status;
      if (!rd || !(rd.rec.fields.startsAt > now) || (status !== 'open' && status !== 'locked')) continue;
      queue(db, ctx, { type: 'su', key: `${raid}:${fresh}`, fields: e.rec.fields });
    }
  }
  db.prepare("UPDATE share_author_checks SET state = 'undone' WHERE id = ?").run(row.id);
  if (ctx && typeof ctx.outboxChanged === 'function') ctx.outboxChanged();
  return { ok: true, message: fresh ? text.LINES.saved : 'Saved. Log in on a character of yours in this guild to get your own player id.' };
}

// "It was me" (mine) or "Undo it" (queues my previous version again, or a tombstone). → { ok, message }
// For a ch of mine that listed unknown characters (row.names): "It was me" makes them mine; "Undo it" sends
// nothing (they were never linked, and my addon re-stamps my own list).
function authorCheck(db, ctx, id, action) {
  const g = identity.currentGuild(db);
  const row = g ? db.prepare("SELECT * FROM share_author_checks WHERE id = ? AND guild_id = ? AND state = 'open'").get(Number(id), g.id) : null;
  if (!row) throw new HttpError(404, 'That change was already handled.');
  if (action !== 'mine' && action !== 'undo') throw new HttpError(400, 'Pick "It was me" or "Undo it".');
  // My player id is made on a character that isn't mine (share/repair.js).
  if (row.kind === 'pid') return pidCheck(db, ctx, g, row, action);
  // My anchor's ch listed characters this computer didn't know as mine (share/import.js chAltsCheck), or an older
  // version linked characters to me that this computer never played (share/repair.js, kind 'repair').
  const names = namesOf(row);
  if (names.length) {
    const anchor = row.rec_id.slice(row.rec_id.indexOf(':') + 1);
    if (action === 'mine') {
      // They are mine: linked now, and listed in my anchor's ch from the next login on. What they wrote in my
      // player id's name is used again.
      takeAsMine(db, ctx, g, names, row.kind === 'repair' ? names : []);
    }
    // Undo: nothing to send. They were never linked here (or no longer are), and the addon puts my own list back.
    db.prepare('UPDATE share_author_checks SET state = ? WHERE id = ?').run(action === 'mine' ? 'mine' : 'undone', row.id);
    const s = names.length > 1 ? '' : 's';
    return {
      ok: true,
      message: action === 'mine' ? `Thanks. ${namesText(names)} now count${s} as yours.`
        : row.kind === 'repair' ? `Saved. ${namesText(names)} no longer count${s} as yours.`
          : `Saved. Log in on ${anchor} once to put your own list back.`,
    };
  }
  // The record versions the check is about: one, or a group of records of a type this version doesn't know.
  const versions = recsOf(row);
  if (action === 'mine') {
    // Mine: never asked about again, also after a fresh start brings them back.
    for (const [recId, v] of versions) st.noteSent(db, g.id, recId, v);
    db.prepare("UPDATE share_author_checks SET state = 'mine' WHERE id = ?").run(row.id);
    return { ok: true, message: 'Thanks. Nothing changes.' };
  }
  const i = row.rec_id.indexOf(':');
  const type = row.rec_id.slice(0, i);
  const key = row.rec_id.slice(i + 1);
  if (!S.TYPES[type]) {
    // A type this version doesn't know (a newer addon's, or made up in my name): nothing can be sent to undo it.
    // The check closes, for every record in it; every addon drops such a record within K.UNKNOWN_DAYS (§11).
    db.prepare("UPDATE share_author_checks SET state = 'undone' WHERE id = ?").run(row.id);
    return {
      ok: true,
      message: versions.length > 1
        ? `Closed. This version can't undo those changes. They go away by themselves within ${S.K.UNKNOWN_DAYS} days.`
        : `Closed. This version can't undo that kind of change. It goes away by itself within ${S.K.UNKNOWN_DAYS} days.`,
    };
  }
  const need = type === 'CFG' ? 'g' : S.spaceOf(type) === 'officer' ? 'o' : undefined;
  const chan = type === 'WH' ? 'OFFICER' : undefined;
  const prev = row.prev ? S.decode(row.prev) : null;
  if (prev && !prev.del && prev.fields) queue(db, ctx, { type, key, fields: prev.fields, need, chan, base: baseOf(db, g.id, row.rec_id) });
  else queue(db, ctx, { type, key, del: true, need, chan, base: baseOf(db, g.id, row.rec_id) });
  db.prepare("UPDATE share_author_checks SET state = 'undone' WHERE id = ?").run(row.id);
  return { ok: true, message: text.LINES.saved };
}

function webhookOffer(db) {
  const o = st.getJson(db, 'shared_webhook');
  const m = identity.myMembership(db);
  if (!o || o.handled || !o.url || !m || (m.role !== 'owner' && m.role !== 'officer')) return null;
  return { from: o.from || null, at: Number.isFinite(o.at) ? new Date(o.at * 1000).toISOString() : null };
}

function takeWebhook(db) {
  const o = st.getJson(db, 'shared_webhook');
  if (!o || o.handled || !o.url || !webhookOffer(db)) throw new HttpError(404, 'There is no shared webhook waiting.');
  st.setJson(db, 'shared_webhook', { ...o, handled: true });
  return { url: o.url };
}

function dismissWebhook(db) {
  const o = st.getJson(db, 'shared_webhook');
  if (o && !o.handled) st.setJson(db, 'shared_webhook', { ...o, handled: true });
  return { ok: true };
}

function shareWebhook(db, ctx) {
  const url = ctx && ctx.cfg ? ctx.cfg.discordWebhook : '';
  if (!url) throw new HttpError(400, 'Add a Discord webhook in Settings first.');
  return queue(db, ctx, { type: 'WH', key: '1', fields: { url }, need: 'o', chan: 'OFFICER' });
}

module.exports = {
  queue, cancel, newKey, baseOf, recordOf, summaryOf,
  myPid: ensurePid, pidOf, userOf, raidCloseFields,
  importShared, afterImport, queuePrices,
  exportOutbox, exportMe, exportSeed,
  status, authorCheck, webhookOffer, takeWebhook, dismissWebhook, shareWebhook, repairIdentity,
  LINES: text.LINES,
  partitionOf: (db, guild) => st.partitionOf(db, guild),
  setClock: st.setClock,
  serverNow: (db) => st.serverNow(db),
  // For tests and the core-routes engineer: remake the rows of one record id.
  reproject: (db, guildId, id) => {
    const e = st.effective(db, guildId, id);
    const i = String(id).indexOf(':');
    const rec = e ? e.rec : { type: String(id).slice(0, i), key: String(id).slice(i + 1), del: true, fields: null };
    const out = project.run(db, guildId, project.tasksFor(rec, null));
    if (out.ranks) identity.syncRanks(db, guildId);
  },
};
