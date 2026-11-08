'use strict';
// Records of types this version doesn't know (docs/SHARING.md §11): anyone may pass one on in anyone's name, so
// they have no author caps, one small store-wide budget and a short life, and an author check about one can be
// closed even though nothing can be sent to undo it (trust-3, app part). A forger can send many: they are asked
// about as one group per sender, whatever types they make up (D4).
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../../src/shared/sharing');
const sharing = require('../../src/core/sharing');
const { setupShare, NOW, D } = require('./sharing-helpers');

const junk = (i, author, t = NOW - 60) => `zz:${i.toString(36)}^${S.makeVersion(t, author, false)}^${author}^^x`;
// This computer started sharing in the guild an hour ago: records in my name since then are checked.
const sharedSince = (h, t = NOW - 3600) => h.db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
  .run(`share_since:${h.gid}`, String(t));
const viaOf = (list, by) => Object.fromEntries(list.map((x) => [x.split('^')[0], `${by},${NOW},m`]));

test('trust-3: "Undo it" on an author check about an unknown-type record forged in my name closes the check instead of failing', async (t) => {
  const h = await setupShare(t);
  sharedSince(h);
  const recs = [junk(0, 'Thrallia')];
  const r = h.imp(recs, { via: viaOf(recs, 'Jaina') });
  assert.equal(r.checks, 1, 'the forged record raises an author check');
  const open = () => h.row("SELECT COUNT(*) AS n FROM share_author_checks WHERE state = 'open'").n;
  const row = h.row("SELECT id FROM share_author_checks WHERE state = 'open' ORDER BY id LIMIT 1");
  assert.equal(sharing.status(h.db).authorChecks[0].summary, 'A guild change');
  const outboxBefore = h.row('SELECT COUNT(*) AS n FROM share_outbox').n;

  const res = h.db.transaction(() => sharing.authorCheck(h.db, h.ctx, row.id, 'undo'))();
  assert.equal(res.ok, true);
  assert.match(res.message, /can't undo that kind of change/);
  assert.match(res.message, new RegExp(`within ${S.K.UNKNOWN_DAYS} days`));
  assert.equal(h.row('SELECT state FROM share_author_checks WHERE id = ?', row.id).state, 'undone', 'the check is closed');
  assert.equal(open(), 0);
  assert.equal(h.row('SELECT COUNT(*) AS n FROM share_outbox').n, outboxBefore, 'nothing is queued for a type the addon can\'t send');
  assert.ok(!sharing.status(h.db).authorChecks.some((c) => c.id === row.id), 'it leaves the list');
  // Asking again says it was handled.
  assert.throws(() => sharing.authorCheck(h.db, h.ctx, row.id, 'undo'), (e) => e.status === 404);
});

test('D4: forged unknown-type records in my name from one sender open one author check that counts them; another sender gets its own, another made-up type joins the sender\'s; "Undo it" closes the whole group; "It was me" keeps a group from asking again', async (t) => {
  const h = await setupShare(t);
  sharedSince(h);
  const recs = [0, 1, 2, 3, 4].map((i) => junk(i, 'Thrallia'));
  const r = h.imp(recs, { via: viaOf(recs, 'Jaina') });
  assert.equal(r.checks, 1, 'one check for the whole group');
  let checks = sharing.status(h.db).authorChecks;
  assert.deepEqual(checks.map((c) => [c.summary, c.via, c.kind, c.count]), [["5 changes of a kind this version doesn't know", 'Jaina', 'unknown', 5]]);
  // More from Jaina join her group.
  const more = [5, 6].map((i) => junk(i, 'Thrallia'));
  assert.equal(h.imp(more, { via: viaOf(more, 'Jaina') }).checks, 0);
  assert.equal(sharing.status(h.db).authorChecks[0].count, 7);
  // Another sender gets one check; another made-up type from Jaina joins her group.
  const zul = [7, 8].map((i) => junk(i, 'Thrallia'));
  const other = ['yy:a1', 'yy:a2'].map((id) => `${id}^${S.makeVersion(NOW - 60, 'Thrallia', false)}^Thrallia^^x`);
  assert.equal(h.imp([...zul, ...other], { via: { ...viaOf(zul, 'Zuljinne'), ...viaOf(other, 'Jaina') } }).checks, 1);
  checks = sharing.status(h.db).authorChecks;
  assert.deepEqual(checks.map((c) => [c.via, c.count]).sort(), [['Jaina', 9], ['Zuljinne', 2]]);

  // "Undo it" on Jaina's group of 9: closed, all of it, and nothing is queued.
  const group = checks.find((c) => c.count === 9);
  const res = h.db.transaction(() => sharing.authorCheck(h.db, h.ctx, group.id, 'undo'))();
  assert.equal(res.message, `Closed. This version can't undo those changes. They go away by themselves within ${S.K.UNKNOWN_DAYS} days.`);
  assert.equal(h.row('SELECT COUNT(*) AS n FROM share_outbox').n, 0);
  assert.deepEqual(sharing.status(h.db).authorChecks.map((c) => c.count).sort(), [2]);
  // A new forged record from Jaina after that starts a new group.
  const late = [junk(9, 'Thrallia')];
  assert.equal(h.imp(late, { via: viaOf(late, 'Jaina') }).checks, 1);
  // "It was me" on Zuljinne's group: those versions never ask again, even when they come back as new.
  const zg = sharing.status(h.db).authorChecks.find((c) => c.via === 'Zuljinne');
  assert.equal(h.db.transaction(() => sharing.authorCheck(h.db, h.ctx, zg.id, 'mine'))().ok, true);
  h.db.prepare("DELETE FROM shared_records WHERE id LIKE 'zz:%'").run();
  assert.equal(h.imp(zul, { via: viaOf(zul, 'Zuljinne') }).checks, 0);
  assert.equal(sharing.status(h.db).authorChecks.filter((c) => c.via === 'Zuljinne').length, 0);
});

test('D4: one sender forging 30 records in my name, each of a different made-up type, still opens one author check that counts 30', async (t) => {
  const h = await setupShare(t);
  sharedSince(h);
  const letter = (i) => String.fromCharCode(97 + i);
  const recs = Array.from({ length: 30 }, (_, i) => `q${letter(i % 26)}${letter(Math.floor(i / 26))}:k${i}^${S.makeVersion(NOW - 60, 'Thrallia', false)}^Thrallia^^x`);
  assert.equal(new Set(recs.map((r) => r.split(':')[0])).size, 30, '30 types');
  const r = h.imp(recs, { via: viaOf(recs, 'Jaina') });
  assert.equal(r.checks, 1);
  const checks = sharing.status(h.db).authorChecks;
  assert.deepEqual(checks.map((c) => [c.via, c.kind, c.count, c.summary]), [['Jaina', 'unknown', 30, "30 changes of a kind this version doesn't know"]]);
  // "Undo it" closes all 30.
  h.db.transaction(() => sharing.authorCheck(h.db, h.ctx, checks[0].id, 'undo'))();
  assert.equal(sharing.status(h.db).authorChecks.length, 0);
});

test('trust-3: a known-type author check still queues the undo (regression)', async (t) => {
  const h = await setupShare(t);
  sharedSince(h);
  const cr = S.encode({ type: 'cr', key: 'abc123', v: S.makeVersion(NOW - 60, 'Thrallia', false), author: 'Thrallia', fields: { pid: 'Thrallia.t000', item: 'Flask of the Titans', notes: 'forged', state: 'o' } });
  const r = h.imp([cr], { via: { 'cr:abc123': `Jaina,${NOW},m` } });
  assert.equal(r.checks, 1);
  const row = h.row("SELECT id FROM share_author_checks WHERE state = 'open' LIMIT 1");
  const res = h.db.transaction(() => sharing.authorCheck(h.db, h.ctx, row.id, 'undo'))();
  assert.equal(res.message, sharing.LINES.saved);
  assert.equal(h.row("SELECT COUNT(*) AS n FROM share_outbox WHERE rec_id = 'cr:abc123' AND del = 1 AND state = 'queued'").n, 1, 'a tombstone is queued');
});

test('trust-3: unknown types live 14 days, have no author caps and share one store-wide budget (JS codec)', () => {
  assert.equal(S.K.UNKNOWN_DAYS, 14);
  const rec = junk(1, 'Thrallia', NOW - 10 * D);
  assert.equal(S.expiresAt(rec), NOW - 10 * D + 14 * D);
  assert.equal(S.isExpired(junk(2, 'Thrallia', NOW - 15 * D), S.hourStart(NOW)), true);
  assert.equal(S.checkRecord(junk(3, 'Thrallia', NOW - 15 * D), NOW), 'expired');
  // 300 records of a made-up type in Thrallia's name are not her records: they never use up her caps.
  assert.equal(S.overAuthorCaps({ count: 300, bytes: 65536, rcBytes: 0 }, 'zz', 100), false);
  assert.equal(S.overAuthorCaps({ count: 300, bytes: 100, rcBytes: 0 }, 'su', 100), true);
  assert.ok(S.K.UNKNOWN_MAX_RECORDS > 0 && S.K.UNKNOWN_MAX_RECORDS < S.K.AUTHOR_MAX_RECORDS);
  assert.ok(S.K.UNKNOWN_MAX_BYTES >= S.K.RECORD_MAX);
});

test('Y4: a group of records of a type this version doesn\'t know that I closed survives a fresh start: when they come back with the store, passed on by anyone, nothing asks again; a new one still asks; the closed group goes once every record in it has expired', async (t) => {
  const { resetGuild } = require('../../src/core/services/reset');
  const prune = require('../../src/core/share/prune');
  const h = await setupShare(t);
  sharedSince(h);
  const recs = [0, 1, 2].map((i) => junk(i, 'Thrallia'));
  assert.equal(h.imp(recs, { via: viaOf(recs, 'Jaina') }).checks, 1);
  const [group] = sharing.status(h.db).authorChecks;
  assert.equal(h.db.transaction(() => sharing.authorCheck(h.db, h.ctx, group.id, 'undo'))().ok, true);
  // An answered check about one known-type record (kind NULL) goes at the fresh start as before.
  h.db.prepare("INSERT INTO share_author_checks (guild_id, rec_id, v, summary, state) VALUES (?, 'cr:abc123', 'v1', 'Crafting request', 'undone')").run(h.gid);
  // The fresh start, then the next upload: my character played again, and the store with those records still in it.
  h.setNow(NOW + 600);
  resetGuild(h.db, h.gid, null);
  assert.deepEqual(h.rows('SELECT kind, state FROM share_author_checks').map((r) => [r.kind, r.state]), [['unknown', 'undone']], 'only the closed group stays');
  h.db.prepare("INSERT INTO characters (guild_id, user_id, name, game_guild, rank, rank_index) VALUES (?, ?, 'Thrallia', 'wow', 'Member', 4)").run(h.gid, h.me);
  const back = h.imp(recs, { via: viaOf(recs, 'Zuljinne') });
  assert.equal(back.imported, 3, 'they are stored again');
  assert.equal(back.checks, 0, 'not asked again');
  assert.deepEqual(sharing.status(h.db).authorChecks, []);
  // A new forged one still asks.
  const late = [junk(7, 'Thrallia', NOW + 300)];
  assert.equal(h.imp(late, { via: viaOf(late, 'Jaina') }).checks, 1);
  // Every addon drops those records within 14 days of their time: then the closed group goes too.
  const closed = () => h.row("SELECT COUNT(*) AS n FROM share_author_checks WHERE kind = 'unknown' AND state = 'undone'").n;
  prune.maybePrune(h.db, h.gid, NOW + 10 * D);
  assert.equal(closed(), 1, 'kept while its records can still come back');
  prune.maybePrune(h.db, h.gid, NOW + 16 * D);
  assert.equal(closed(), 0);
});
