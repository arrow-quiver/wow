'use strict';
// Local changes going out (docs/SHARING.md §9, §10 "Export"): queue() and its provisional rows, the inbox's
// outbox / me / seed, and GET /api/share/status.
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../../src/shared/sharing');
const sharing = require('../../src/core/sharing');
const { parseSavedVariables, toLua } = require('../../src/shared/lua');
const { setupShare, rec, NOW, D, G, PIDS, ME_PID } = require('./sharing-helpers');

const MC = 'Molten Core';
const IK = S.instanceKey(MC);
const CHS = Object.entries(PIDS).map(([n, p]) => rec('ch', n, NOW - 3000, n, { pid: p, alts: [n] }));

test('queue: the outbox entry, a provisional record signed by my main, rows at once, and an outbox event', async (t) => {
  const h = await setupShare(t, { role: 'officer' });
  const key = sharing.newKey();
  assert.match(key, /^[0-9a-z]{6}$/);
  assert.notEqual(sharing.newKey(), key);
  const fields = { kind: 'r', title: 'Molten Core Thursday', instance: MC, startsAt: NOW + 2 * D, minutes: 180, size: 40, srLimit: 2, notes: 'Bring fire resist; ~flasks' };
  const r = h.queue({ type: 'RD', key, fields, need: 'o' });
  assert.deepEqual({ ...r, op: 'x' }, { op: 'x', id: `RD:${key}`, key });
  assert.match(r.op, /^o[0-9a-z]+$/);
  assert.equal(h.outboxEvents.length, 1);
  const row = h.outbox()[0];
  assert.deepEqual([row.rec_id, row.t, row.base, row.need, row.chan, row.del, row.state], [`RD:${key}`, NOW, '', 'o', null, 0, 'queued']);
  assert.equal(row.body, S.encodeBody('RD', key, fields));
  assert.equal(row.note, 'Saved. It goes to your guild the next time you log in or type /reload.');
  const prov = S.decode(row.record);
  assert.equal(prov.author, 'Thrallia');
  assert.equal(prov.t, NOW);
  assert.deepEqual(prov.fields, fields);
  const rd = sharing.recordOf(h.db, h.gid, `RD:${key}`);
  assert.equal(rd.state, 'pending');
  assert.equal(rd.fields.title, 'Molten Core Thursday');
  assert.equal(sharing.summaryOf(rd), 'Molten Core Thursday: scheduled');
  assert.equal(h.row('SELECT title FROM raids WHERE share_id = ?', key).title, 'Molten Core Thursday');
  assert.equal(sharing.baseOf(h.db, h.gid, `RD:${key}`), '');

  // Two edits in a row: one entry, the first base kept, t after the stored copy's.
  h.imp([rec('RT', key, NOW + 30, 'Varok', { status: 'l', lockedAt: NOW + 30 })]);
  const base = h.stored(`RT:${key}`).v;
  const a = h.queue({ type: 'RT', key, fields: { status: 'o' }, need: 'o' });
  h.imp([rec('RT', key, NOW + 40, 'Grommash', { status: 'l', lockedAt: NOW + 40 })], { via: { [`RT:${key}`]: `Grommash,${NOW},d` } });
  const b = h.queue({ type: 'RT', key, fields: { status: 'x' }, need: 'o' });
  const entries = sharing.exportOutbox(h.db).filter((e) => e.id === `RT:${key}`);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].op, b.op);
  assert.notEqual(a.op, b.op);
  assert.equal(h.outbox().find((x) => x.op === a.op).state, 'refused', 'the newer lock from Grommash beat my reopen');
  assert.equal(entries[0].base, h.stored(`RT:${key}`).v, 'no entry was waiting any more: the current base');
  void base;
  const x = S.decode(h.outbox().find((o) => o.op === b.op).record);
  assert.equal(x.t, NOW + 41, 'one past the stored copy\'s t');
  assert.ok(S.isFinalV(x.v), 'a cancel is final');
  const c = h.queue({ type: 'RT', key, fields: { status: 'x' }, need: 'o', base: 'zzzzzzzz' });
  assert.equal(sharing.exportOutbox(h.db).find((e) => e.id === `RT:${key}`).base, entries[0].base, 'a replaced entry keeps the first base');
  void c;
});

test('queue: tombstones, the OFFICER channel, and refusals in plain words', async (t) => {
  const h = await setupShare(t, { role: 'officer' });
  h.imp([...CHS, rec('AN', 'q2w8zz', NOW - 60, 'Grommash', { body: 'old notice' })]);
  assert.equal(h.row('SELECT COUNT(*) AS n FROM announcements').n, 1);
  h.queue({ type: 'AN', key: 'q2w8zz', del: true, need: 'o' });
  assert.equal(h.row('SELECT COUNT(*) AS n FROM announcements').n, 0, 'removed at once');
  const e = sharing.exportOutbox(h.db)[0];
  assert.deepEqual({ ...e, op: 0 }, { op: 0, g: G, id: 'AN:q2w8zz', t: NOW, need: 'o', base: h.stored('AN:q2w8zz').v, del: true });
  assert.throws(() => h.queue({ type: 'XX', key: '1' }), /can't be shared/);
  assert.throws(() => h.queue({ type: 'RD', key: 'BAD KEY' }), /bad key/);
  assert.throws(() => h.queue({ type: 'LL', key: IK, fields: { name: MC, items: Array.from({ length: 150 }, (_, i) => ({ item: `h${String(i).padStart(5, '0')}`, boss: 1, name: 'x'.repeat(100) })) }, need: 'o' }), /too large/);
  // No character yet: nothing to sign with.
  h.db.prepare('UPDATE characters SET user_id = NULL WHERE user_id = ?').run(h.me);
  assert.throws(() => h.queue({ type: 'AN', key: 'aaaaaa', fields: { body: 'x' } }), /Log in to World of Warcraft/);
});

test('exportMe: pid, BattleTag, main and every character of mine (the anchor first)', async (t) => {
  const h = await setupShare(t);
  h.db.prepare("INSERT INTO characters (guild_id, user_id, name, level, is_main, game_guild) VALUES (?,?, 'Zalt', 10, 0, 'wow')").run(h.gid, h.me);
  h.db.prepare("INSERT INTO app_settings (key, value) VALUES ('me_battletag', 'Calvin#1234')").run();
  const me = { pid: ME_PID, bt: 'Calvin#1234', main: 'Thrallia', alts: ['Thrallia', 'Zalt'] };
  // The current guild's fields at the top, and per guild partition (player ids are per guild).
  assert.deepEqual(sharing.exportMe(h.db), { ...me, g: G, byG: { [G]: me } });
  h.db.prepare("UPDATE characters SET is_main = 1 WHERE name = 'Zalt'").run();
  assert.equal(sharing.exportMe(h.db).main, 'Zalt');
});

test('exportSeed: only when a store holds under half the records; caps; officer records only first-hand or trusted', async (t) => {
  const h = await setupShare(t, { role: 'officer' });
  const recs = [...CHS];
  for (let i = 0; i < 20; i++) recs.push(rec('ca', `c${String(i).padStart(5, '0')}`, NOW - 100 - i, 'Jaina', { character: 'Jaina', zone: `Z${i}` }));
  recs.push(rec('AN', 'an0001', NOW - 50, 'Grommash', { body: 'first hand' }));
  recs.push(rec('AN', 'an0002', NOW - 50, 'Grommash', { body: 'relayed by a member' }));
  recs.push(rec('WH', '1', NOW - 50, 'Varok', { url: 'https://discord.com/api/webhooks/1/x' }));
  h.imp(recs, { via: { 'AN:an0002': `Jaina,${NOW},m` } });
  assert.deepEqual(sharing.exportSeed(h.db, h.gid), [], 'this store has them all');
  // Another account's store (WTF wiped): nearly empty.
  h.imp([], { file: { account: 'ALT', install: 'C:/WoW' } });
  const seed = sharing.exportSeed(h.db, h.gid);
  const ids = seed.map((s) => S.parse(s).id);
  assert.ok(ids.includes('AN:an0001'));
  assert.ok(!ids.includes('AN:an0002'), 'officer records relayed by members are never seeded');
  assert.ok(!ids.includes('WH:1'), 'the webhook never travels on GUILD');
  assert.equal(ids.filter((id) => id.startsWith('ca:')).length, 20);
  assert.ok(seed.every((s) => h.stored(S.parse(s).id).body === s), 'records exactly as stored');
  // The seed goes into the inbox and reads back from Lua the same.
  const inbox = (await h.srv.api.get('/api/inbox')).body;
  assert.deepEqual(inbox.seed, seed);
  assert.equal(inbox.seedG, G, 'the partition the seed is for');
  const lua = parseSavedVariables(Buffer.from(`WowGuildInbox = ${toLua(inbox)}\n`, 'utf8')).WowGuildInbox;
  assert.deepEqual(lua.seed, seed);
  // Expired records are not seeded.
  h.setNow(NOW + 2 * D);
  assert.ok(!sharing.exportSeed(h.db, h.gid).some((s) => s.startsWith('ca:')));
});

test('exportSeed caps: at most 3,000 records and 400 KB', async (t) => {
  const h = await setupShare(t);
  const ins = h.db.prepare("INSERT INTO shared_records (guild_id, id, v, author, how, body, state) VALUES (?,?,?,?, 'd', ?, 'ok')");
  h.db.transaction(() => {
    for (let i = 0; i < 3200; i++) {
      const key = S.toB36(1e8 + i).slice(-6);
      const r = rec('lp', `${PIDS.Jaina}:J${key}`, NOW - i, 'Jaina', { character: 'Jaina', zone: 'x'.repeat(60), note: 'y'.repeat(100) });
      ins.run(h.gid, S.parse(r).id, S.parse(r).v, 'Jaina', r);
    }
  })();
  h.imp([], { file: { account: 'NEW', install: 'C:/WoW' } });
  const seed = sharing.exportSeed(h.db, h.gid);
  const bytes = seed.reduce((n, s) => n + Buffer.byteLength(s), 0);
  assert.ok(seed.length <= 3000 && bytes <= 400 * 1024, `${seed.length} records, ${bytes} bytes`);
  assert.ok(seed.length > 1000);
  assert.equal(S.parse(seed[0]).t, NOW, 'newest first');
});

test('GET /api/inbox carries outbox, me and seed; the addon reads them back from Lua', async (t) => {
  const h = await setupShare(t, { role: 'officer' });
  h.imp(CHS);
  h.queue({ type: 'AN', key: 'q2w8zz', fields: { body: 'Raid on Friday^bring "fire" resist' }, need: 'o' });
  h.queue({ type: 'su', key: `k3f9a2:${ME_PID}`, fields: { character: 'Thrallia', role: 'h', status: 'y', note: 'late 10 min', reserves: ['d72', 'eim'], reservesAt: NOW - 600 } });
  const inbox = (await h.srv.api.get('/api/inbox')).body;
  assert.deepEqual(inbox.outbox.map((e) => ({ ...e, op: 0 })), [
    { op: 0, g: G, id: 'AN:q2w8zz', t: NOW, need: 'o', base: '', body: 'Raid on Friday~5Ebring "fire" resist' },
    { op: 0, g: G, id: `su:k3f9a2:${ME_PID}`, t: NOW, base: '', body: `Thrallia^h^y^late 10 min^d72;eim^${S.toB36(NOW - 600)}` },
  ]);
  const me = { pid: ME_PID, main: 'Thrallia', alts: ['Thrallia'] };
  assert.deepEqual(inbox.me, { ...me, g: G, byG: { [G]: me } });
  assert.deepEqual(inbox.seed, []);
  const lua = parseSavedVariables(Buffer.from(`WowGuildInbox = ${toLua(inbox)}\n`, 'utf8')).WowGuildInbox;
  assert.deepEqual(lua.outbox, inbox.outbox);
  assert.deepEqual(lua.me, inbox.me);
});

test('GET /api/share/status: sharing state, the outbox with summaries, refused changes', async (t) => {
  const h = await setupShare(t, { role: 'officer' });
  const empty = (await h.srv.api.get('/api/share/status')).body;
  assert.deepEqual(empty, { enabled: false, pid: ME_PID, peers: 0, records: 0, lastHello: null, lastExchange: null, outbox: [], refused: [], authorChecks: [], webhookOffer: null });
  h.imp([...CHS, rec('RD', 'k3f9a2', NOW - 60, 'Grommash', { kind: 'r', title: 'Molten Core Thursday', instance: MC, startsAt: NOW + D })]);
  const a = h.queue({ type: 'RT', key: 'k3f9a2', fields: { status: 'l', lockedAt: NOW }, need: 'o' });
  const b = h.queue({ type: 'AN', key: 'q2w8zz', fields: { body: 'hello' }, need: 'o' });
  h.imp([], { sent: { [a.op]: 'wait,officer', [b.op]: 'no,expired' } });
  const s = (await h.srv.api.get('/api/share/status')).body;
  assert.equal(s.enabled, true);
  assert.equal(s.peers, 3);
  assert.equal(s.records, CHS.length + 1);
  assert.equal(s.lastHello, new Date((NOW - 60) * 1000).toISOString());
  assert.deepEqual(s.outbox.map((e) => [e.op, e.type, e.summary, e.state, e.note]), [[a.op, 'RT', 'Molten Core Thursday: locked', 'waiting', 'Log in on an officer character to send this.']]);
  assert.deepEqual(s.refused.map((e) => [e.op, e.summary, e.note]), [[b.op, 'Notice: hello', 'This waited too long and was not sent.']]);
  assert.ok(s.outbox[0].createdAt);
  // A member cannot accept a webhook or share one; a bad op is a 404.
  assert.equal((await h.srv.api.post('/api/share/outbox/nope!/cancel', {})).status, 404);
});
