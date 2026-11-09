'use strict';
// Dungeon groups (routes/dungeons.js): dg and dj shared records (docs/SHARING.md §4.3). The tests check what each
// action queues, the line-up every PC computes from the records, and what guildmates' records do here.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startCore, seedGuild } = require('./helpers');
const { shareKit } = require('./share-kit');
const S = require('../../src/shared/sharing');
const sharing = require('../../src/core/sharing');

async function setup() {
  const c = await startCore();
  const g = seedGuild(c.db, { role: 'member', character: 'Mokra' });
  c.db.prepare("UPDATE characters SET class = 'PRIEST', level = 22 WHERE name = 'Mokra'").run();
  const kit = shareKit(c);
  const close = async () => { kit.restore(); await c.close(); };
  return { c, db: c.db, g, api: c.api, kit, close };
}

test('dungeon routes need the guild', async () => {
  const c = await startCore();
  try {
    const r = await c.api.get('/api/dungeons');
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'NO_GUILD');
  } finally { await c.close(); }
});

test('dungeon groups: post, edit, guildmates join first come first in, wait, leave, call off', async () => {
  const t = await setup();
  const { db, api, kit } = t;
  try {
    let r = await api.post('/api/dungeons', { role: 'healer' });
    assert.deepEqual([r.status, r.body.error], [400, 'Name the dungeon.']);
    r = await api.post('/api/dungeons', { dungeon: 'Deadmines', role: 'bard' });
    assert.deepEqual([r.status, r.body.error], [400, 'Pick your role: tank, healer or dps.']);
    r = await api.post('/api/dungeons', { dungeon: 'Deadmines', role: 'healer', character: 'Somebody' });
    assert.deepEqual([r.status, r.body.error], [400, 'Pick one of your characters.']);
    r = await api.post('/api/dungeons', { dungeon: 'Deadmines', role: 'healer', slots: { tank: 5, healer: 5, dps: 5 } });
    assert.deepEqual([r.status, r.body.error], [400, 'A group can have at most 10 people.']);
    r = await api.post('/api/dungeons', { dungeon: 'Deadmines', role: 'healer', startsAt: '2001-01-01T00:00:00Z' });
    assert.deepEqual([r.status, r.body.error], [400, 'That time has already passed.']);

    // A group for now: 1 tank, 1 healer (me), 3 dps.
    r = await api.post('/api/dungeons', { dungeon: 'The Deadmines', role: 'healer', note: 'VC quests' });
    assert.equal(r.status, 201);
    const key = r.body.group.key;
    const dg = kit.last('dg');
    const myPid = sharing.myPid(db);
    assert.deepEqual(dg.fields, {
      pid: myPid, character: 'Mokra', dungeon: 'The Deadmines', startsAt: kit.now(), role: 'h', level: 22,
      tank: 1, heal: 1, dps: 3, note: 'VC quests', state: 'o', guests: [],
    });
    assert.deepEqual(r.body.group.open, { tank: 1, healer: 0, dps: 3 }, 'the leader fills a healer slot');
    assert.deepEqual([r.body.group.mine, r.body.group.canJoin, r.body.group.canCancel], [true, false, true]);
    assert.equal(r.body.group.leader.class, 'PRIEST');
    assert.ok(db.prepare("SELECT 1 FROM activity WHERE text = 'Mokra is putting a group together for The Deadmines'").get());
    assert.equal((await api.post(`/api/dungeons/${key}/join`, { role: 'dps' })).status, 409, 'the leader cannot join');

    // Edit: two tanks wanted now.
    r = await api.post(`/api/dungeons/${key}`, { slots: { tank: 2 } });
    assert.equal(r.status, 200);
    assert.deepEqual(kit.last('dg').fields.tank, 2);
    assert.deepEqual(r.body.group.open, { tank: 2, healer: 0, dps: 3 });

    // Guildmates join: Grom (tank), then Varok (tank), then Zul (tank, waits). The leader hears.
    const grom = kit.mate('Grom', { cls: 'WARRIOR', level: 23 });
    const varok = kit.mate('Varok');
    const zul = kit.mate('Zul');
    const join = (m, role, t) => kit.rec('dj', `${key}:${m.pid}`, { character: m.name, role, status: 'y', class: 'WARRIOR', level: 21, joinedAt: t }, { author: m.name, t });
    kit.imp([join(zul, 't', kit.now() - 10), join(varok, 't', kit.now() - 20), join(grom, 't', kit.now() - 30)]);
    let list = (await api.get('/api/dungeons')).body;
    let g = list.groups.find((x) => x.key === key);
    assert.deepEqual(g.members.map((m) => m.character), ['Grom', 'Varok'], 'first come, first in, whatever the arrival order');
    assert.deepEqual(g.waiting.map((m) => m.character), ['Zul']);
    assert.deepEqual(g.open, { tank: 0, healer: 0, dps: 3 });
    assert.ok(t.c.events.some((e) => e.title === '🛡️ Grom joined your The Deadmines group'));

    // A join on someone's own group is refused on import.
    kit.imp([kit.rec('dj', `${key}:${myPid}`, { character: 'Mokra', role: 'd', status: 'y' }, { author: 'Mokra' })]);
    assert.deepEqual({ ...db.prepare('SELECT state, reason FROM shared_records WHERE id = ?').get(`dj:${key}:${myPid}`) }, { state: 'ignored', reason: 'own group' });

    // Varok leaves: Zul moves up.
    kit.imp([kit.rec('dj', `${key}:${varok.pid}`, { character: 'Varok', role: 't', status: 'w', joinedAt: kit.now() - 20 }, { author: 'Varok', t: kit.now() - 5 })]);
    g = (await api.get('/api/dungeons')).body.groups.find((x) => x.key === key);
    assert.deepEqual(g.members.map((m) => m.character), ['Grom', 'Zul']);
    assert.deepEqual(g.waiting, []);

    // Players from outside the guild: the leader adds them as guests; they take spots in the order added, after the leader.
    r = await api.post(`/api/dungeons/${key}/guest`, { name: 'not a name!', role: 'dps' });
    assert.deepEqual([r.status, r.body.error], [400, "Type the player's character name, like Brokk or Brokk-Mirage."]);
    r = await api.post(`/api/dungeons/${key}/guest`, { name: 'Brokk-Mirage', role: 'dps', class: 'WARRIOR', level: 21 });
    assert.equal(r.status, 200);
    assert.equal(r.body.message, 'Brokk-Mirage added to the group.');
    assert.deepEqual(kit.last('dg').fields.guests, [{ name: 'Brokk-Mirage', role: 'd', class: 'WARRIOR', level: 21 }]);
    const brokk = r.body.group.members.find((m) => m.character === 'Brokk-Mirage');
    assert.deepEqual([brokk.guest, brokk.battletag, brokk.role], [true, null, 'dps']);
    assert.deepEqual(r.body.group.open, { tank: 0, healer: 0, dps: 2 });
    assert.equal((await api.post(`/api/dungeons/${key}/guest`, { name: 'brokk-mirage', role: 'tank' })).status, 409, 'already in it');
    assert.equal((await api.post(`/api/dungeons/${key}/guest`, { name: 'Ýrsa', role: 'healer' })).status, 200, 'names in any script');
    r = await api.post(`/api/dungeons/${key}/unguest`, { name: 'Ýrsa' });
    assert.deepEqual([r.status, kit.last('dg').fields.guests.map((x) => x.name)], [200, ['Brokk-Mirage']]);
    assert.equal((await api.post(`/api/dungeons/${key}/unguest`, { name: 'Nobody' })).status, 404);

    // Call it off: final, and it leaves the board.
    r = await api.post(`/api/dungeons/${key}/cancel`);
    assert.equal(r.status, 200);
    assert.deepEqual([kit.last('dg').final, kit.last('dg').fields.state], [true, 'x']);
    list = (await api.get('/api/dungeons')).body;
    assert.ok(!list.groups.some((x) => x.key === key));
    assert.equal((await api.post(`/api/dungeons/${key}/done`)).status, 409);
  } finally { await t.close(); }
});

test("dungeon groups: joining a guildmate's group, the waiting list, leaving, and the new-group notification", async () => {
  const t = await setup();
  const { db, api, kit } = t;
  try {
    const grom = kit.mate('Grom', { cls: 'WARRIOR', level: 25 });
    const varok = kit.mate('Varok');
    const starts = kit.now() + 1800;
    kit.imp([kit.rec('dg', 'gr0up1', {
      pid: grom.pid, character: 'Grom', dungeon: 'Wailing Caverns', startsAt: starts, role: 't', level: 25,
      tank: 1, heal: 1, dps: 1, note: 'fast run', state: 'o',
    }, { author: 'Grom' })]);
    assert.deepEqual(t.c.events.map((e) => [e.kind, e.title, e.body]),
      [['cta', '🛡️ Grom is grouping for Wailing Caverns', 'In 30 min. fast run Join in Guild Camp or with /wow lfg.']]);

    let list = (await api.get('/api/dungeons')).body;
    assert.deepEqual(list.myCharacters.map((c) => c.name), ['Mokra']);
    let g = list.groups.find((x) => x.key === 'gr0up1');
    assert.deepEqual([g.dungeon, g.leader.character, g.leader.role, g.canJoin, g.canCancel], ['Wailing Caverns', 'Grom', 'tank', true, false]);
    assert.deepEqual(g.open, { tank: 0, healer: 1, dps: 1 });

    // Varok took the dps spot first; I join as dps and wait.
    kit.imp([kit.rec('dj', `gr0up1:${varok.pid}`, { character: 'Varok', role: 'd', status: 'y', joinedAt: kit.now() - 100 }, { author: 'Varok' })]);
    let r = await api.post('/api/dungeons/gr0up1/join', { role: 'tank' });
    assert.equal(r.status, 200);
    assert.equal(r.body.message, "The tank spots are taken. You're on the waiting list.");
    const dj = kit.last('dj');
    const myPid = sharing.myPid(db);
    assert.deepEqual([dj.key, dj.fields], [`gr0up1:${myPid}`, { character: 'Mokra', role: 't', status: 'y', class: 'PRIEST', level: 22, joinedAt: kit.now() }]);
    assert.equal((await api.post('/api/dungeons/gr0up1/join', { role: 'healer' })).status, 409, 'already in it');

    // Leave and join again as healer: in.
    kit.tick(10);
    r = await api.post('/api/dungeons/gr0up1/leave');
    assert.deepEqual([r.status, kit.last('dj').fields.status], [200, 'w']);
    kit.tick(10);
    r = await api.post('/api/dungeons/gr0up1/join', { role: 'healer' });
    assert.equal(r.body.message, "You're in. Grom invites you in game.");
    g = r.body.group;
    assert.deepEqual(g.joined, { character: 'Mokra', role: 'healer', waiting: false });
    assert.equal(g.state, 'full');
    assert.equal((await api.post('/api/dungeons/gr0up1/cancel')).status, 403, 'only the leader');
    assert.equal((await api.post('/api/dungeons/gr0up1/guest', { name: 'Brokk', role: 'dps' })).status, 403, 'only the leader adds guests');

    // The leader marks it done: off the board everywhere.
    kit.imp([kit.rec('dg', 'gr0up1', { pid: grom.pid, character: 'Grom', dungeon: 'Wailing Caverns', startsAt: starts, role: 't', state: 'd' }, { author: 'Grom', t: kit.now() })]);
    list = (await api.get('/api/dungeons')).body;
    assert.deepEqual(list.groups, []);
    assert.equal((await api.post('/api/dungeons/nope!!/join')).status, 404);
  } finally { await t.close(); }
});

test('dungeon group state: slots, first come first in, waiting, leader ignored', () => {
  const NOW = 1794067200;
  const rec = (type, key, t, author, fields, final) => S.encode({ type, key, v: S.makeVersion(t, author, final), author, del: false, fields });
  const dg = rec('dg', 'dg1grp', NOW, 'Lead', { pid: 'Lead.aaaa', dungeon: 'SFK', role: 'd', tank: 1, heal: 1, dps: 2, state: 'o' });
  const j = (who, role, at, status = 'y') => rec('dj', `dg1grp:${who}.bbbb`, NOW + 5, who, { character: who, role, status, joinedAt: at });
  let s = S.dungeonGroupState(dg, []);
  assert.deepEqual([s.state, s.open], ['open', { t: 1, h: 1, d: 1 }]);
  s = S.dungeonGroupState(dg, [j('Bb', 'd', NOW + 2), j('Aa', 'd', NOW + 2), j('Cc', 't', NOW + 3), j('Dd', 'h', NOW + 9, 'w')]);
  assert.deepEqual(s.members.map((m) => m.character), ['Aa', 'Cc'], 'a tie goes to the smaller pid');
  assert.deepEqual(s.waiting.map((m) => m.character), ['Bb']);
  assert.equal(s.state, 'open');
  s = S.dungeonGroupState(dg, [j('Aa', 'd', NOW + 2), j('Cc', 't', NOW + 3), j('Ee', 'h', NOW + 4), rec('dj', 'dg1grp:Lead.aaaa', NOW, 'Lead', { role: 'h', status: 'y' })]);
  assert.equal(s.state, 'full', "the leader's own join never counts");
  assert.equal(S.dungeonGroupState(rec('dg', 'dg1grp', NOW, 'Lead', { pid: 'Lead.aaaa', role: 'd', state: 'x' }, true), []).state, 'cancelled');
  assert.equal(S.dungeonGroupState(null, []).state, 'cancelled');
  // Guests take spots right after the leader, before guildmates' joins.
  const withGuests = rec('dg', 'dg1grp', NOW, 'Lead', { pid: 'Lead.aaaa', role: 'd', tank: 1, heal: 1, dps: 2, state: 'o', guests: [{ name: 'Out-Realm', role: 'd' }, { name: 'Late', role: 'd' }] });
  s = S.dungeonGroupState(withGuests, [j('Aa', 'd', NOW + 2), j('Cc', 't', NOW + 3)]);
  assert.deepEqual(s.members.map((m) => [m.character, m.guest]), [['Out-Realm', true], ['Cc', false]]);
  assert.deepEqual(s.waiting.map((m) => m.character), ['Late', 'Aa']);
});
