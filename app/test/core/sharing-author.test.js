'use strict';
// Author checks across fresh starts and guilds (docs/SHARING.md §5), notifications after a fresh start, and the
// player id a first upload takes (§3).
//   D3: share_since is per guild ('share_since:<guild id>', when this computer started sharing there), and a fresh
//       start keeps it: the log of versions this computer sent (share_sent) keeps my own records from asking.
//   D5: a record stamped before the guild's last fresh start comes back as new, but doesn't notify again.
//   D1: a player id made up on a character this computer plays never wins over the addon's own.
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../../src/shared/sharing');
const sharing = require('../../src/core/sharing');
const st = require('../../src/core/share/store');
const { resetGuild } = require('../../src/core/services/reset');
const { setupShare, rec, NOW, D, G, PIDS, ME_PID } = require('./sharing-helpers');

const CHS = Object.entries(PIDS).map(([n, p]) => rec('ch', n, NOW - 3000, n, { pid: p, alts: [n], level: 60 }));
const sinceAt = (h, t) => h.db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
  .run(`share_since:${h.gid}`, String(t));
const checks = (h) => sharing.status(h.db).authorChecks.map((c) => c.summary).sort();

// ------------------------------------------------------------------------------------------ D3
test('D3: share_since is per guild: a fresh start in another guild leaves this guild\'s author checks as they were (a forged request in my name here is still asked about)', async (t) => {
  const h = await setupShare(t);
  sinceAt(h, NOW - 10 * D);
  h.imp(CHS);
  const rivals = Number(h.db.prepare("INSERT INTO guilds (name, faction, invite_code, realm, game_guild) VALUES ('Rivals', 'Horde', 'rivals-1', 'Forever', 'Rivals')").run().lastInsertRowid);
  h.setNow(NOW + 600);
  resetGuild(h.db, rivals, null);
  assert.equal(st.sinceOf(h.db, h.gid), NOW - 10 * D, 'this guild keeps its own time');
  const forged = rec('cr', 'f0f0f0', NOW - 2 * D, 'Thrallia', { pid: ME_PID, item: 'Arcanite Reaper', notes: 'forged', state: 'o' });
  const r = h.imp([forged], { via: { 'cr:f0f0f0': `Jaina,${NOW},m` } });
  assert.equal(r.checks, 1);
  assert.deepEqual(checks(h), ['Crafting request: Arcanite Reaper']);
});

test('D3: after a fresh start, a forged request in my name dated before it is still asked about when it comes back; my own records (sent from here, or held as mine before) are not', async (t) => {
  const h = await setupShare(t);
  sinceAt(h, NOW - 10 * D);
  h.imp(CHS);
  // A bank request sent from here: its "ok" arrived.
  const mine = h.queue({ type: 'bq', key: 'b0b0b0', fields: { pid: ME_PID, item: 'Silk Cloth', count: 2, state: 'o' } });
  const v = S.makeVersion(NOW - 3 * D, 'Thrallia');
  const sent = S.encode({ type: 'bq', key: 'b0b0b0', v, author: 'Thrallia', fields: { pid: ME_PID, item: 'Silk Cloth', count: 2, state: 'o' } });
  h.imp([sent], { sent: { [mine.op]: `ok,${v},Thrallia` }, via: { 'bq:b0b0b0': `Thrallia,${NOW},d` } });
  assert.ok(st.wasSent(h.db, h.gid, 'bq:b0b0b0', v), 'logged as mine when its "ok" arrived');
  // An older one of mine whose outbox history is long gone (sent weeks ago), held here as mine.
  const old = rec('bq', 'b1b1b1', NOW - 8 * D, 'Thrallia', { pid: ME_PID, item: 'Wool Cloth', count: 5, state: 'o' });
  h.db.prepare("INSERT INTO shared_records (guild_id, id, v, author, via, how, body, state) VALUES (?, 'bq:b1b1b1', ?, 'Thrallia', ?, 'd', ?, 'ok')")
    .run(h.gid, S.parse(old).v, `Thrallia,${NOW - 8 * D},d`, old);
  h.db.prepare("DELETE FROM share_outbox").run();
  assert.deepEqual(checks(h), []);

  h.setNow(NOW + 600);
  resetGuild(h.db, h.gid, null);
  assert.equal(st.sinceOf(h.db, h.gid), NOW - 10 * D, 'the fresh start keeps when this computer started sharing');
  // The next upload: my character played after the fresh start, the store as it is, plus a request a guildmate
  // forged in my name, dated before the fresh start.
  h.db.prepare("INSERT INTO characters (guild_id, user_id, name, game_guild, rank, rank_index) VALUES (?, ?, 'Thrallia', 'wow', 'Member', 4)").run(h.gid, h.me);
  const forged = rec('cr', 'f0f0f0', NOW - 2 * D, 'Thrallia', { pid: ME_PID, item: 'Arcanite Reaper', notes: 'forged', state: 'o' });
  const back = [...CHS, sent, old, forged];
  const via = { 'bq:b0b0b0': `Thrallia,${NOW},d`, 'bq:b1b1b1': `Thrallia,${NOW},d`, 'cr:f0f0f0': `Jaina,${NOW},m` };
  const r = h.imp(back, { via });
  assert.equal(h.stored('bq:b0b0b0').state, 'ok');
  assert.equal(h.stored('bq:b1b1b1').state, 'ok');
  assert.equal(r.checks, 1, 'only the forged one asks');
  assert.deepEqual(checks(h), ['Crafting request: Arcanite Reaper']);
});

test('D3: the update moves the one share_since to every guild that has shared records, and logs the versions this computer sent or said were mine', () => {
  const { Database, MIGRATIONS, migrate } = require('../../src/core/db');
  const db = new Database(':memory:');
  db.exec('CREATE TABLE schema_version (v INTEGER NOT NULL); INSERT INTO schema_version (v) VALUES (16);');
  for (let i = 0; i < 16; i++) db.exec(MIGRATIONS[i]);
  const guild = (name) => Number(db.prepare("INSERT INTO guilds (name, faction, invite_code) VALUES (?, 'Horde', ?)").run(name, `x-${name}`).lastInsertRowid);
  const [a, b, c] = [guild('wow'), guild('Rivals'), guild('Quiet')];
  for (const g of [a, b]) db.prepare("INSERT INTO shared_records (guild_id, id, v, author, body) VALUES (?, 'AN:aaaaaa', 'v', 'X', 'x')").run(g);
  db.prepare("INSERT INTO app_settings (key, value) VALUES ('share_since', '1794000000')").run();
  db.prepare("INSERT INTO share_outbox (op, guild_id, rec_id, t, state, sent_v) VALUES ('o1', ?, 'bq:b0b0b0', 1, 'sent', 'v1')").run(a);
  db.prepare("INSERT INTO share_author_checks (guild_id, rec_id, v, summary, state) VALUES (?, 'AN:cccccc', 'v2', 's', 'mine')").run(b);
  migrate(db);
  const get = (k) => (db.prepare('SELECT value FROM app_settings WHERE key = ?').get(k) || {}).value;
  assert.deepEqual([get(`share_since:${a}`), get(`share_since:${b}`), get(`share_since:${c}`), get('share_since')], ['1794000000', '1794000000', undefined, undefined]);
  assert.deepEqual(db.prepare('SELECT guild_id, rec_id, v FROM share_sent ORDER BY guild_id').all().map((r) => [r.guild_id, r.rec_id, r.v]),
    [[a, 'bq:b0b0b0', 'v1'], [b, 'AN:cccccc', 'v2']]);
  db.close();
});

// ------------------------------------------------------------------------------------------ D5
test('D5: after a fresh start, a guildmate\'s notice from before it comes back with the store but doesn\'t notify again; a newer one does', async (t) => {
  const h = await setupShare(t, { role: 'officer' });
  h.imp(CHS);
  const notice = rec('AN', 'n1n1n1', NOW - 3600, 'Grommash', { body: 'Raid at eight.' });
  h.imp([notice], { via: { 'AN:n1n1n1': `Grommash,${NOW},d` } });
  const notices = () => h.events.filter((e) => e.kind === 'notice').map((e) => e.body);
  assert.deepEqual(notices(), ['Raid at eight.']);

  h.setNow(NOW + 600);
  resetGuild(h.db, h.gid, null);
  const later = rec('AN', 'n2n2n2', NOW + 900, 'Grommash', { body: 'Bring flasks.' });
  h.setNow(NOW + 1000);
  h.imp([...CHS, notice, later], { via: { 'AN:n1n1n1': `Grommash,${NOW},d`, 'AN:n2n2n2': `Grommash,${NOW + 900},d` } });
  assert.ok(h.row("SELECT 1 FROM announcements WHERE share_id = 'n1n1n1'"), 'the old notice shows again');
  assert.deepEqual(notices(), ['Raid at eight.', 'Bring flasks.'], 'only the new one notifies');
});

// ------------------------------------------------------------------------------------------ D1
test('D1: a first upload whose addon has its own player id, with a guildmate\'s forged ch of my character naming an id made up on that same character: the addon\'s id is kept', async (t) => {
  const h = await setupShare(t, { pid: null });
  const forged = h.chFor('Thrallia', 'Thrallia.fak3', { alts: ['Thrallia'], main: true, t: NOW - 50 });
  const p = h.payload([forged], { via: { 'ch:Thrallia': `Jaina,${NOW},m` } });
  p.guilds[G].pid = 'Thrallia.mine';
  h.impRaw(p, { file: { account: 'ACC', install: 'C:/WoW' } });
  assert.equal(st.myPid(h.db, h.gid), 'Thrallia.mine');
  assert.equal(sharing.exportMe(h.db).pid, 'Thrallia.mine', 'the addon keeps its id');
});

test('D1: without an id of the addon\'s own, a second computer still takes my id from my character\'s ch (regression)', async (t) => {
  const h = await setupShare(t, { pid: null });
  h.imp([rec('ch', 'Thrallia', NOW - 60, 'Thrallia', { pid: 'Thrallia.pc22', alts: ['Thrallia'] })], { via: { 'ch:Thrallia': `Jaina,${NOW},m` } });
  assert.equal(sharing.myPid(h.db), 'Thrallia.pc22');
});
