'use strict';
// D7: a one-time repair for databases an older version let a guildmate mislead (docs/SHARING.md §3): a character
// moved to me by a forged ch, or a player id made on a guildmate's character. Characters this computer never
// uploaded are unlinked and asked about; a player id made on someone else's character is asked about, never
// changed by itself; my own records are never lost.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../../src/shared/sharing');
const sharing = require('../../src/core/sharing');
const st = require('../../src/core/share/store');
const { repairIdentity } = require('../../src/core/share/repair');
const { startCore, seedGuild } = require('./helpers');
const { setupShare, rec, NOW, D, PIDS, ME_PID } = require('./sharing-helpers');

const RAID = 'k3f9a2';
const ownerOf = (h, name) => (h.row('SELECT user_id FROM characters WHERE guild_id = ? AND name = ?', h.gid, name) || {}).user_id;
const post = (h, id, action) => h.srv.api.post(`/api/share/author-checks/${id}`, { action });
// My character as an upload of this computer leaves it (gold, game guild).
const uploaded = (h, name) => h.db.prepare("UPDATE characters SET money = 100, game_guild = 'wow' WHERE guild_id = ? AND name = ?").run(h.gid, name);
const raid = (h) => rec('RD', RAID, NOW - 4000, 'Grommash', { kind: 'r', title: 'MC', instance: 'Molten Core', startsAt: NOW + D, minutes: 180, size: 40, srLimit: 2 });
const signedUp = (h) => h.rows('SELECT s.character FROM signups s JOIN raids r ON r.id = s.raid_id WHERE r.share_id = ? AND s.user_id = ? ORDER BY s.character', RAID, h.me)
  .map((r) => r.character);

test('D7: a character an older version linked to me through a guildmate\'s ch is unlinked once, its sign-up in my name is set aside, and I am asked; "Undo it" leaves it out', async (t) => {
  const h = await setupShare(t);
  uploaded(h, 'Thrallia');
  h.imp([h.chFor('Jaina', ME_PID, { t: NOW - 500 }), h.chFor('Thrallia', ME_PID, { alts: ['Thrallia', 'Jaina'], main: true, t: NOW - 500 }), raid(h),
    rec('su', `${RAID}:${ME_PID}`, NOW - 400, 'Jaina', { character: 'Jaina', role: 'd', status: 'y', reserves: [] })],
  { via: { 'ch:Thrallia': `Jaina,${NOW},m` } });
  // What the older version did: Jaina moved to me, so her sign-up in my id's name was taken as mine.
  h.db.prepare("UPDATE characters SET user_id = ? WHERE guild_id = ? AND name = 'Jaina'").run(h.me, h.gid);
  h.db.prepare("UPDATE shared_records SET state = 'ok', reason = NULL WHERE id = ?").run(`su:${RAID}:${ME_PID}`);
  h.db.prepare("DELETE FROM share_author_checks").run();
  sharing.reproject(h.db, h.gid, `RD:${RAID}`);
  assert.deepEqual(signedUp(h), ['Jaina']);
  h.db.prepare("DELETE FROM app_settings WHERE key = 'share_repair'").run();

  const r = repairIdentity(h.db);
  assert.deepEqual(r.unlinked, [{ guildId: h.gid, names: ['Jaina'] }]);
  assert.notEqual(ownerOf(h, 'Jaina'), h.me);
  assert.equal(ownerOf(h, 'Thrallia'), h.me, 'my uploaded character stays mine');
  assert.deepEqual(signedUp(h), [], 'her sign-up in my name no longer shows as mine');
  assert.deepEqual([h.stored(`su:${RAID}:${ME_PID}`).state, h.stored(`su:${RAID}:${ME_PID}`).reason], ['ignored', 'link'], 'kept, not deleted');
  assert.deepEqual(sharing.exportMe(h.db).alts, ['Thrallia']);
  const [check] = sharing.status(h.db).authorChecks;
  assert.deepEqual([check.summary, check.kind], ['Jaina was linked to you as your character', 'repair']);
  assert.deepEqual(repairIdentity(h.db), { unlinked: [], asked: 0 }, 'only once');

  const undo = await post(h, check.id, 'undo');
  assert.deepEqual([undo.status, undo.body.message], [200, 'Saved. Jaina no longer counts as yours.']);
  assert.notEqual(ownerOf(h, 'Jaina'), h.me);
  assert.deepEqual(sharing.status(h.db).authorChecks, []);
});

test('D7: "It was me" on a character the repair unlinked (my other PC\'s) links it again and its sign-up shows as mine at once: nothing of mine is lost', async (t) => {
  const h = await setupShare(t);
  uploaded(h, 'Thrallia');
  h.db.prepare("INSERT INTO characters (guild_id, user_id, name, class, level, rank, rank_index) VALUES (?, ?, 'Zulalt2', 'MAGE', 60, 'r', 3)").run(h.gid, h.me);
  h.imp([h.chFor('Zulalt2', ME_PID, { t: NOW - 500 }), h.chFor('Thrallia', ME_PID, { alts: ['Thrallia', 'Zulalt2'], main: true, t: NOW - 500 }), raid(h),
    rec('su', `${RAID}:${ME_PID}`, NOW - 400, 'Zulalt2', { character: 'Zulalt2', role: 'h', status: 'y', reserves: [] })],
  { via: { 'su:k3f9a2:Thrallia.t000': `Zulalt2,${NOW},d` } });
  h.db.prepare("DELETE FROM share_author_checks").run();
  assert.deepEqual(signedUp(h), ['Zulalt2']);
  h.db.prepare("DELETE FROM app_settings WHERE key = 'share_repair'").run();

  repairIdentity(h.db);
  assert.deepEqual(signedUp(h), []);
  const [check] = sharing.status(h.db).authorChecks;
  const mine = await post(h, check.id, 'mine');
  assert.deepEqual([mine.status, mine.body.message], [200, 'Thanks. Zulalt2 now counts as yours.']);
  assert.equal(ownerOf(h, 'Zulalt2'), h.me);
  assert.equal(h.stored(`su:${RAID}:${ME_PID}`).state, 'ok');
  assert.deepEqual(signedUp(h), ['Zulalt2'], 'my sign-up from my other PC shows again');
  assert.deepEqual(sharing.exportMe(h.db).alts.sort(), ['Thrallia', 'Zulalt2']);
});

test('D7: a player id an older version took, made on a guildmate\'s character, is asked about and kept until I answer; "Undo it" makes my own and my coming sign-up goes out under it', async (t) => {
  // The one id from before ids were per guild: Jaina's own.
  const h = await setupShare(t, { pid: PIDS.Jaina });
  uploaded(h, 'Thrallia');
  h.db.prepare("DELETE FROM app_settings WHERE key = 'share_repair'").run();

  // The core starts after the update.
  const r = repairIdentity(h.db);
  assert.equal(r.asked, 1);
  assert.equal(st.myPid(h.db, h.gid), PIDS.Jaina, 'not changed by itself');
  // Until I answer, the id stays in use: an upload, and a sign-up made meanwhile.
  h.imp([raid(h)]);
  assert.equal(st.myPid(h.db, h.gid), PIDS.Jaina);
  h.queue({ type: 'su', key: `${RAID}:${sharing.myPid(h.db)}`, fields: { character: 'Thrallia', role: 'h', status: 'y' } });
  const [check] = sharing.status(h.db).authorChecks;
  assert.deepEqual([check.summary, check.kind], ['Your player id is made on Jaina, who isn\'t one of your characters', 'pid']);

  const undo = await post(h, check.id, 'undo');
  assert.deepEqual([undo.status, undo.body.message], [200, sharing.LINES.saved]);
  const fresh = st.myPid(h.db, h.gid);
  assert.match(fresh, /^Thrallia\.[0-9a-z]{4}$/);
  assert.equal(st.get(h.db, 'me_pid'), null, 'the old one is not taken again');
  assert.deepEqual(sharing.exportOutbox(h.db).map((e) => e.id).sort(), [`su:${RAID}:${PIDS.Jaina}`, `su:${RAID}:${fresh}`].sort());
  assert.equal(sharing.exportMe(h.db).pid, fresh);
});

test('D7: when an older version took Jaina\'s player id and linked Jaina to me with it, I am asked once, about the id; "Undo it" leaves her out and gives me my own', async (t) => {
  const h = await setupShare(t, { pid: PIDS.Jaina });
  uploaded(h, 'Thrallia');
  h.db.prepare("UPDATE characters SET user_id = ? WHERE guild_id = ? AND name = 'Jaina'").run(h.me, h.gid);
  h.db.prepare("DELETE FROM app_settings WHERE key = 'share_repair'").run();
  const r = repairIdentity(h.db);
  assert.deepEqual(r.unlinked, [{ guildId: h.gid, names: ['Jaina'] }]);
  assert.equal(ownerOf(h, 'Jaina'), null);
  assert.equal(st.myPid(h.db, h.gid), PIDS.Jaina, 'still in use until I answer');
  const checks = sharing.status(h.db).authorChecks;
  assert.deepEqual(checks.map((c) => c.kind), ['pid'], 'one question');
  const undo = await post(h, checks[0].id, 'undo');
  assert.equal(undo.status, 200, JSON.stringify(undo.body));
  assert.match(st.myPid(h.db, h.gid), /^Thrallia\.[0-9a-z]{4}$/);
  assert.notEqual(ownerOf(h, 'Jaina'), h.me);
  assert.deepEqual(sharing.exportMe(h.db).alts, ['Thrallia']);
});

test('D7: the one player id from before ids were per guild, made on a guildmate\'s character, is not taken up silently in a guild met after the update', async (t) => {
  const h = await setupShare(t, { pid: PIDS.Jaina });
  uploaded(h, 'Thrallia');
  assert.equal(st.myPid(h.db, h.gid), null, 'Jaina is not mine here');
  assert.match(sharing.myPid(h.db), /^Thrallia\.[0-9a-z]{4}$/, 'an id of my own instead');
});

test('D7: "It was me" on my player id\'s character keeps the id and makes the character mine', async (t) => {
  const h = await setupShare(t, { pid: PIDS.Jaina });
  uploaded(h, 'Thrallia');
  h.db.prepare("DELETE FROM app_settings WHERE key = 'share_repair'").run();
  repairIdentity(h.db);
  const [check] = sharing.status(h.db).authorChecks;
  const mine = await post(h, check.id, 'mine');
  assert.deepEqual([mine.status, mine.body.message], [200, 'Thanks. Jaina now counts as yours.']);
  assert.equal(st.myPid(h.db, h.gid), PIDS.Jaina);
  assert.equal(ownerOf(h, 'Jaina'), h.me);
});

test('D7: the core runs the repair once when it starts, after an update', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-repair-'));
  let c = null;
  t.after(async () => { if (c) await c.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  c = await startCore({ dataDir: dir });
  const g = seedGuild(c.db, { name: 'wow', realm: 'Forever', role: 'member', character: 'Thrallia' });
  c.db.prepare("UPDATE characters SET money = 5, game_guild = 'wow' WHERE name = 'Thrallia'").run();
  c.db.prepare("INSERT INTO characters (guild_id, user_id, name, rank, rank_index) VALUES (?, ?, 'Jaina', 'r', 3)").run(g.guildId, g.me);
  // A database from before the repair existed.
  c.db.prepare("DELETE FROM app_settings WHERE key = 'share_repair'").run();
  await c.close();
  c = await startCore({ dataDir: dir });
  assert.equal(c.db.prepare("SELECT user_id FROM characters WHERE name = 'Jaina'").get().user_id, null);
  assert.deepEqual((await c.api.get('/api/share/status')).body.authorChecks.map((x) => x.summary), ['Jaina was linked to you as your character']);
  c.db.prepare("UPDATE characters SET user_id = ? WHERE name = 'Jaina'").run(g.me);
  await c.close();
  c = await startCore({ dataDir: dir });
  assert.equal(c.db.prepare("SELECT user_id FROM characters WHERE name = 'Jaina'").get().user_id, g.me, 'not again');
  await c.close();
});

test('D7: the guild\'s bank character, linked to me by an older version, is unlinked and asked about even though its bags came in a shared bk record; my own uploaded character with bags but no gold stays mine', async (t) => {
  const h = await setupShare(t);
  uploaded(h, 'Thrallia');
  h.imp([
    rec('BC', '1', NOW - 900, 'Grommash', { names: ['Bankalt'] }),
    rec('bk', 'Bankalt', NOW - 800, 'Bankalt', { bags: [{ id: 14047, count: 20 }], bank: [] }),
  ]);
  const bags = (name) => h.row('SELECT COUNT(*) AS n FROM inventory i JOIN characters c ON c.id = i.character_id WHERE c.guild_id = ? AND c.name = ?', h.gid, name).n;
  assert.equal(bags('Bankalt'), 1, 'its bags came from the bk record');
  // What the older version did: Bankalt moved to me by a guildmate's ch.
  h.db.prepare("UPDATE characters SET user_id = ? WHERE guild_id = ? AND name = 'Bankalt'").run(h.me, h.gid);
  // An upload of mine with bags but no gold or guild (the bags alone show it came from here).
  const alt = Number(h.db.prepare("INSERT INTO characters (guild_id, user_id, name, class, level) VALUES (?, ?, 'Thrallalt', 'MAGE', 20)").run(h.gid, h.me).lastInsertRowid);
  h.db.prepare("INSERT INTO inventory (character_id, location, item_id, count) VALUES (?, 'bags', 2589, 5)").run(alt);
  h.db.prepare("DELETE FROM app_settings WHERE key = 'share_repair'").run();

  const r = repairIdentity(h.db);
  assert.deepEqual(r.unlinked, [{ guildId: h.gid, names: ['Bankalt'] }]);
  assert.notEqual(ownerOf(h, 'Bankalt'), h.me);
  assert.equal(ownerOf(h, 'Thrallalt'), h.me);
  assert.deepEqual(sharing.status(h.db).authorChecks.map((c) => [c.summary, c.kind]), [['Bankalt was linked to you as your character', 'repair']]);
  assert.deepEqual(sharing.exportMe(h.db).alts, ['Thrallia']);
});
