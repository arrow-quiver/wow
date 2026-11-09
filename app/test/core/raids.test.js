'use strict';
// Raids domain: scheduling (raids, PvP, events), sign-ups, soft reserves, SR+ loyalty, the officer loot
// screen, loot lists and history, Discord posts, reminders and notifications. Every request is "me"
// (Velanne, an officer unless a test says otherwise). Every change is a shared record (docs/SHARING.md §10):
// the tests check what each action queues, and that the rows and replies come out as before through the
// projection. Guildmates' sign-ups, reserves and officer changes arrive as their records, the way an upload
// brings them in.
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../../src/shared/sharing');
const sharing = require('../../src/core/sharing');
const { startCore, seedGuild, addPlayer, asRole } = require('./helpers');
const { shareKit } = require('./share-kit');
const { startFrom, readinessFlags } = require('../../src/core/routes/raids');
const R = require('../../src/core/services/raids');
const { resetGuild } = require('../../src/core/services/reset');

const WEBHOOK = 'https://discord.com/api/webhooks/1/abc';
const DAY = 86400000;
const inDays = (n) => new Date(Date.now() + n * DAY).toISOString();
const unix = (iso) => Math.floor(Date.parse(iso) / 1000);
const HYJAL = S.instanceKey('Hyjal Summit');

// A stand-in for outside HTTP that records every call.
function fakeFetch({ fail = false } = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
    if (fail) return new Response('nope', { status: 500 });
    return new Response(null, { status: 204 });
  };
  return { fetch, calls, webhook: () => calls.filter((c) => c.url === WEBHOOK).map((c) => c.body.content) };
}

async function setup({ role = 'officer', fail = false } = {}) {
  const net = fakeFetch({ fail });
  const c = await startCore({ fetch: net.fetch, settings: { discordWebhook: WEBHOOK } });
  const g = seedGuild(c.db, { role, character: 'Velanne', cls: 'PRIEST' });
  const kit = shareKit(c);
  const mokra = kit.mate('Mokra', { role: 'member', battletag: 'Grom#3333', cls: 'SHAMAN' });
  const grim = kit.mate('Grim', { role: 'owner', battletag: 'Thrall#1111', cls: 'WARRIOR' });
  const db = c.db;
  const setChar = (userId, name, cls, readiness = null, isMain = 0) => db.prepare(
    `INSERT INTO characters (guild_id, user_id, name, class, level, readiness, is_main) VALUES (?,?,?,?,60,?,?)
     ON CONFLICT (guild_id, name) DO UPDATE SET class = excluded.class, readiness = excluded.readiness, is_main = excluded.is_main`,
  ).run(g.guildId, userId, name, cls, readiness ? JSON.stringify(readiness) : null, isMain);
  const audit = () => db.prepare('SELECT action, detail FROM audit_log ORDER BY id').all();
  const activity = () => db.prepare('SELECT kind, text FROM activity ORDER BY id').all().map((r) => `${r.kind}: ${r.text}`);
  const keyOf = (raid) => R.raidFor(db, g.guildId, raid.id).share_id;
  // A guildmate's sign-up (and reserves, as item keys) for one of my raids, arriving from the game.
  const signupAs = (mate, raid, opts) => kit.signup(keyOf(raid), mate, opts);
  const myPid = () => sharing.myPid(db);
  const bonus = (uid, item) => (db.prepare('SELECT bonus FROM loyalty WHERE user_id = ? AND item_id = ?').get(uid, item) || { bonus: 0 }).bonus;
  // Starting SR+ bonuses for an instance: a checkpoint (LY) an officer's app wrote earlier.
  const checkpoint = (ik, bonuses, t = kit.now() - 3600) => kit.imp([kit.rec('LY', ik, { upto: t - 60, bonuses }, { author: 'Grim', t })]);
  const close = async () => { kit.restore(); await c.close(); };
  return { c, api: c.api, db, g, me: g.me, mokra, grim, net, kit, setChar, signupAs, keyOf, myPid, bonus, checkpoint, audit, activity, close };
}

async function schedule(t, body = {}) {
  const res = await t.api.post('/api/raids', { kind: 'raid', title: 'Hyjal week 1', instance: 'Hyjal Summit', starts_at: inDays(2), size: 20, sr_limit: 2, ...body });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.raid;
}

// Item ids (loot_items rows) and item keys (what records carry) by name.
async function lootList(t, instance = 'Hyjal Summit') {
  const res = await t.api.post('/api/loot/items', { instance, text: 'Rage Winterchill | Frost Greaves | 30871\nAnetheron | Night Cloak\nArchimonde | Tear of the Earth\n\nLoose Trinket' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const ids = Object.fromEntries(res.body.items.map((i) => [i.name, i.id]));
  const keys = Object.fromEntries(res.body.items.map((i) => [i.name, R.itemKeyOf(i)]));
  return { ids, keys };
}

// ---------------------------------------------------------------- units

test('start times: ISO with a zone, local time plus offset, and nonsense', () => {
  assert.equal(startFrom({ starts_at: '2026-12-09T18:00:00.000Z' }, 0), '2026-12-09T18:00:00.000Z');
  assert.equal(startFrom({ starts_at: '2026-12-09T20:00:00+02:00' }, 0), '2026-12-09T18:00:00.000Z');
  assert.equal(startFrom({ starts: '2026-12-09T20:00', tz_offset: '-120' }, 0), '2026-12-09T18:00:00.000Z');
  assert.equal(startFrom({ starts_at: '2026-12-09T20:00' }, -120), '2026-12-09T18:00:00.000Z', 'no zone → this computer\'s offset');
  assert.equal(startFrom({ starts_at: 'tomorrow' }, 0), null);
  assert.equal(startFrom({ starts_at: '1990-01-01T00:00:00Z' }, 0), null);
  assert.equal(startFrom({}, 0), null);
});

test('readiness flags: no data, low repair, no consumables', () => {
  const base = { unspent: false, unenchanted: null };
  assert.deepEqual(readinessFlags(null), { noData: true, lowRepair: false, noConsumables: false, ...base });
  assert.deepEqual(readinessFlags({ ilvl: 60, durability: 25, consumables: {} }), { noData: false, lowRepair: true, noConsumables: true, ...base });
  assert.deepEqual(readinessFlags({ ilvl: 60, durability: 30, consumables: { flask: 2 } }), { noData: false, lowRepair: false, noConsumables: false, ...base });
  assert.deepEqual(readinessFlags({ ilvl: 60, durability: null, consumables: { potion: 0 } }), { noData: false, lowRepair: false, noConsumables: true, ...base });
  // Addon 0.12+: talents, resistances and unenchanted slots.
  const f = readinessFlags({ ilvl: 62, durability: 90, consumables: { flask: 1 }, talents: { a: 0, b: 21, c: 28, unspent: 2 }, resists: { fire: 120 }, unenchanted: [9, 15] });
  assert.equal(f.unspent, true);
  assert.deepEqual(f.unenchanted, ['Wrist', 'Back']);
  assert.deepEqual(readinessFlags({ consumables: {}, talents: { a: 31, b: 20, c: 0, unspent: 0 }, unenchanted: [] }).unenchanted, []);
});

// ---------------------------------------------------------------- scheduling

test('officers schedule raids: an RD record, the row at once, audit and activity; Discord once the game sends it', async () => {
  const t = await setup({ role: 'member' });
  try {
    assert.equal((await t.api.post('/api/raids', { title: 'X', instance: 'Y', starts_at: inDays(1) })).status, 403);
    asRole(t.db, 'officer');
    const bad = await t.api.post('/api/raids', { title: 'X', instance: '', starts_at: inDays(1) });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, 'Fill in the name, instance and start time.');
    assert.equal((await t.api.post('/api/raids', { title: 'X', instance: 'Y', starts_at: 'soon' })).status, 400);
    assert.deepEqual(t.kit.queued(), [], 'nothing is queued for a refused request');

    const res = await t.api.post('/api/raids', {
      kind: 'raid', title: '  Hyjal week 1  ', instance: 'Hyjal Summit', starts: '2026-12-09T20:00', tz_offset: '-120',
      size: 99, sr_limit: 9, duration_min: 150, notes: 'Bring fire resistance',
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.message, 'Raid scheduled.');
    const raid = res.body.raid;
    assert.equal(raid.title, 'Hyjal week 1');
    assert.equal(raid.starts_at, '2026-12-09T18:00:00.000Z');
    assert.equal(raid.size, 40);
    assert.equal(raid.sr_limit, 5);
    assert.equal(raid.duration_min, 150);
    assert.equal(raid.status, 'open');
    assert.equal(raid.kind, 'raid');
    assert.equal(raid.notes, 'Bring fire resistance');
    assert.equal(raid.created_by, t.me);
    assert.equal('guild_id' in raid, false);

    // The record: a random key that is the row's share_id, for officers only, a new record (no base).
    const e = t.kit.last('RD');
    assert.deepEqual([e.type, e.need, e.base, e.del, e.chan, e.state, e.author, e.final], ['RD', 'o', '', false, null, 'queued', 'Velanne', false]);
    assert.match(e.key, /^[0-9a-z]{6}$/);
    assert.equal(t.keyOf(raid), e.key);
    assert.deepEqual(e.fields, {
      kind: 'r', title: 'Hyjal week 1', instance: 'Hyjal Summit', startsAt: unix('2026-12-09T18:00:00Z'), minutes: 150, size: 40, srLimit: 5, notes: 'Bring fire resistance',
    });
    assert.equal(e.note, sharing.LINES.saved);

    assert.equal(t.net.calls.length, 0, 'nothing goes to Discord before the game sends it');
    assert.deepEqual(t.c.events, [], 'the scheduler is not notified');
    assert.deepEqual(t.audit().at(-1), { action: 'scheduled raid', detail: 'Hyjal week 1 (2026-12-09T18:00:00.000Z)' });
    assert.ok(t.activity().includes('raid: Velanne scheduled Hyjal week 1'));

    // The game sent it: the post goes out, once.
    t.kit.ack(e);
    await t.kit.settle();
    const posts = t.net.webhook();
    assert.equal(posts.length, 1);
    assert.match(posts[0], /^🗓️ \*\*Raid: Hyjal week 1\*\* \(Hyjal Summit\)\n<t:\d+:F>, <t:\d+:R>\nSign up and reserve in Guild Camp\.$/);
    t.kit.ack(e);
    await t.kit.settle();
    assert.equal(t.net.webhook().length, 1);
    assert.equal(t.kit.entry(e.op).state, 'sent');
    assert.equal(R.raidFor(t.db, t.g.guildId, raid.id).title, 'Hyjal week 1', 'the same row, now from the stored record');

    // PvP and guild events: no reserves, their own Discord wording.
    const pvp = await t.api.post('/api/raids', { kind: 'pvp', title: 'Tarren Mill premade', instance: 'Tarren Mill', starts_at: inDays(1), sr_limit: 3 });
    assert.equal(pvp.status, 201);
    assert.equal(pvp.body.raid.sr_limit, 0);
    assert.equal(pvp.body.message, 'PvP scheduled.');
    assert.deepEqual([t.kit.last('RD').fields.kind, t.kit.last('RD').fields.srLimit], ['p', 0]);
    t.kit.ack(t.kit.last('RD'));
    await t.kit.settle();
    assert.match(t.net.webhook()[1], /^⚔️ \*\*PvP: Tarren Mill premade\*\* \(Tarren Mill\)\n.*\nSign up in Guild Camp\.$/s);
    const evt = await t.api.post('/api/raids', { kind: 'event', title: 'Fishing contest', instance: 'Booty Bay', starts_at: inDays(3) });
    assert.equal(evt.body.raid.kind, 'event');
    assert.equal(t.kit.last('RD').fields.kind, 'e');
    const defaults = await t.api.post('/api/raids', { title: 'Defaults', instance: 'Molten Core', starts_at: inDays(4), kind: 'nonsense' });
    assert.equal(defaults.body.raid.kind, 'raid');
    assert.equal(defaults.body.raid.sr_limit, 2);
    assert.equal(defaults.body.raid.size, null);
    assert.equal(defaults.body.raid.duration_min, 180);
    assert.equal(t.kit.last('RD').fields.size, null);
    assert.equal(t.kit.queued('RD').length, 2, 'one entry per raid still waiting for the game');
  } finally { await t.close(); }

  // A failing webhook never breaks anything.
  const broken = await setup({ fail: true });
  try {
    const res = await broken.api.post('/api/raids', { title: 'Still works', instance: 'MC', starts_at: inDays(1) });
    assert.equal(res.status, 201);
    assert.equal(res.body.message, 'Raid scheduled.');
    broken.kit.ack(broken.kit.last('RD'));
    await broken.kit.settle();
    assert.equal((await broken.api.post(`/api/raids/${res.body.raid.id}/cancel`)).status, 200);
  } finally { await broken.close(); }
});

// ---------------------------------------------------------------- list, sign-ups, detail

test('raid list: upcoming and past with role counts, my sign-up and instances', async () => {
  const t = await setup();
  try {
    const a = await schedule(t, { title: 'Soonest', starts_at: inDays(1) });
    const b = await schedule(t, { title: 'Later', starts_at: inDays(5), instance: 'Black Temple' });
    // Rows from before sharing are still listed.
    t.db.prepare("INSERT INTO raids (guild_id, title, instance, starts_at, status) VALUES (?, 'Old one', 'Karazhan', ?, 'open')").run(t.g.guildId, inDays(-3));
    t.db.prepare("INSERT INTO raids (guild_id, title, instance, starts_at, status) VALUES (?, 'Closed early', 'Karazhan', ?, 'done')").run(t.g.guildId, inDays(1));
    await lootList(t, 'Serpentshrine Cavern');

    await t.api.post(`/api/raids/${a.id}/signup`, { character: 'Velanne', role: 'healer', status: 'yes' });
    t.signupAs(t.mokra, a, { role: 'tank' });
    t.signupAs(t.grim, a, { status: 'tentative' });

    const res = await t.api.get('/api/raids');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.upcoming.map((r) => r.title), ['Soonest', 'Later']);
    assert.deepEqual(res.body.past.map((r) => r.title), ['Closed early', 'Old one']);
    const first = res.body.upcoming[0];
    assert.deepEqual(first.counts, { tank: 1, healer: 1, dps: 0, tentative: 1, bench: 0, no: 0 });
    assert.deepEqual(first.mySignup, { status: 'yes', role: 'healer', character: 'Velanne' });
    assert.equal(first.myReserves, 0);
    assert.equal(res.body.upcoming[1].mySignup, null);
    assert.deepEqual(res.body.upcoming[1].counts, { tank: 0, healer: 0, dps: 0, tentative: 0, bench: 0, no: 0 });
    assert.deepEqual(res.body.instances, ['Black Temple', 'Hyjal Summit', 'Karazhan', 'Serpentshrine Cavern']);
    assert.equal(b.id > a.id, true);
    assert.equal((await t.api.get('/api/raids/99999')).status, 404);
    assert.equal((await t.api.get('/api/raids/abc')).status, 404);
  } finally { await t.close(); }
});

test('sign-ups: an su record per player, validation, statuses incl. bench, closed raids and the activity line', async () => {
  const t = await setup();
  try {
    const raid = await schedule(t);
    const key = t.keyOf(raid);
    const url = `/api/raids/${raid.id}/signup`;
    const none = await t.api.post(url, { character: '  ', role: 'tank' });
    assert.equal(none.status, 400);
    assert.equal(none.body.error, 'Pick a character.');
    assert.deepEqual(t.kit.queued('su'), []);

    const first = await t.api.post(url, { character: 'Velanne', role: 'healer', status: 'yes', note: 'Might be 15 min late' });
    assert.equal(first.status, 200);
    assert.equal(first.body.message, 'You’re signed up.');
    assert.equal(first.body.signup.role, 'healer');
    assert.equal(first.body.signup.note, 'Might be 15 min late');
    assert.equal(first.body.signup.mine, true);
    assert.deepEqual(first.body.counts, { tank: 0, healer: 1, dps: 0, tentative: 0, bench: 0, no: 0 });
    const su = t.kit.last('su');
    assert.equal(su.key, `${key}:${t.myPid()}`, 'one sign-up per player: the key is the raid and my player id');
    assert.deepEqual([su.need, su.base, su.del, su.author], [null, '', false, 'Velanne']);
    assert.deepEqual(su.fields, { character: 'Velanne', role: 'h', status: 'y', note: 'Might be 15 min late', reserves: [], reservesAt: null, prev: [], prevAt: null });

    const bench = await t.api.post(url, { character: 'Velanne', role: 'wizard', status: 'bench' });
    assert.equal(bench.body.message, 'Sign-up updated.');
    assert.equal(bench.body.signup.role, 'dps', 'unknown roles fall back to damage');
    assert.equal(bench.body.signup.status, 'bench');
    assert.equal(t.kit.queued('su').length, 1, 'a change still waiting for the game is replaced');
    assert.deepEqual([t.kit.last('su').fields.role, t.kit.last('su').fields.status, t.kit.last('su').fields.note], ['d', 'b', '']);
    const no = await t.api.post(url, { character: 'Velanne', role: 'dps', status: 'no' });
    assert.equal(no.body.message, 'Marked as can’t make it.');
    assert.equal(t.activity().filter((a) => a.includes('signed up for')).length, 1, 'only the first "yes" makes an activity line');

    // Locked reserves: sign-ups still work.
    assert.equal((await t.api.post(`/api/raids/${raid.id}/lock`)).status, 200);
    assert.equal((await t.api.post(url, { character: 'Velanne', status: 'yes' })).status, 200);
    await t.api.post(`/api/raids/${raid.id}/cancel`);
    const closed = await t.api.post(url, { character: 'Velanne', status: 'yes' });
    assert.equal(closed.status, 409);
    assert.equal(closed.body.error, 'Sign-ups are closed for this raid.');

    // A raid row from before sharing can be read but not changed.
    const old = Number(t.db.prepare("INSERT INTO raids (guild_id, title, instance, starts_at) VALUES (?, 'Old', 'MC', ?)").run(t.g.guildId, inDays(1)).lastInsertRowid);
    assert.equal((await t.api.get(`/api/raids/${old}`)).status, 200);
    for (const [p, body] of [['signup', { character: 'Velanne' }], ['reserves', { item_ids: [] }], ['lock', {}], ['cancel', {}], ['close', {}], ['award', { item_name: 'X', character: 'Y' }]]) {
      const r = await t.api.post(`/api/raids/${old}/${p}`, body);
      assert.equal(r.status, 409, p);
      assert.equal(r.body.error, 'This was made with an older Guild Camp and can’t be changed. Make it again.', p);
    }
  } finally { await t.close(); }
});

test('raid detail: roster with readiness flags, my characters, loot list with my bonus, reserve board', async () => {
  const t = await setup();
  try {
    const { ids, keys } = await lootList(t);
    const raid = await schedule(t, { sr_limit: 1 });
    asRole(t.db, 'member');
    t.setChar(t.me, 'Velanne', 'PRIEST', { ilvl: 58.2, durability: 22, consumables: {}, at: 1700000000 }, 1);
    t.setChar(t.me, 'Velalt', 'MAGE');
    t.setChar(t.mokra.id, 'Mokra', 'SHAMAN', { ilvl: 63, durability: 90, consumables: { flask: 2, potion: 5 }, at: 1700000000 });
    await t.api.post(`/api/raids/${raid.id}/signup`, { character: 'Velanne', role: 'healer', status: 'yes', note: 'Late' });
    t.signupAs(t.mokra, raid, { role: 'tank', reserves: [keys['Night Cloak']] });
    t.signupAs(t.grim, raid, { status: 'no' });
    await t.api.post(`/api/raids/${raid.id}/reserves`, { item_ids: [ids['Night Cloak']] });
    t.checkpoint(HYJAL, [{ pid: t.myPid(), item: keys['Night Cloak'], bonus: 20 }]);

    const res = await t.api.get(`/api/raids/${raid.id}`);
    assert.equal(res.status, 200);
    const d = res.body;
    assert.equal(d.raid.scheduledBy, 'Velanne');
    assert.deepEqual(d.signups.map((s) => [s.character, s.role, s.status]), [['Mokra', 'tank', 'yes'], ['Velanne', 'healer', 'yes'], ['Grim', 'dps', 'no']]);
    const mine = d.signups.find((s) => s.character === 'Velanne');
    assert.equal(mine.class, 'PRIEST');
    assert.equal(mine.readiness.ilvl, 58.2);
    assert.deepEqual(mine.flags, { noData: false, lowRepair: true, noConsumables: true, unspent: false, unenchanted: null });
    assert.equal(mine.mine, true);
    assert.deepEqual(d.signups.find((s) => s.character === 'Mokra').flags, { noData: false, lowRepair: false, noConsumables: false, unspent: false, unenchanted: null });
    assert.equal(d.signups.find((s) => s.character === 'Mokra').battletag, 'Grom#3333');
    assert.deepEqual(d.signups.find((s) => s.character === 'Grim').flags.noData, false, 'readiness from their shared character');
    assert.deepEqual(d.counts, { tank: 1, healer: 1, dps: 0, tentative: 0, bench: 0, no: 1 });
    assert.equal(d.mySignup.character, 'Velanne');
    assert.deepEqual(d.myCharacters.map((c) => c.name), ['Velanne', 'Velalt']);

    assert.equal(d.items.length, 4);
    const cloak = d.items.find((i) => i.name === 'Night Cloak');
    assert.deepEqual([cloak.boss, cloak.bonus, cloak.reserved, cloak.mine], ['Anetheron', 20, 2, true]);
    assert.equal(d.items.find((i) => i.name === 'Frost Greaves').wh_id, 30871);
    assert.deepEqual(d.myReserves.map((r) => [r.name, r.bonus]), [['Night Cloak', 20]]);
    assert.equal(d.board.length, 1);
    assert.equal(d.board[0].item, 'Night Cloak');
    assert.deepEqual(d.board[0].reservers.map((r) => [r.character, r.bonus, r.inRaid]), [['Velanne', 20, true], ['Mokra', 0, true]]);
    assert.equal(d.canSignUp, true);
    assert.equal(d.canReserve, true);
    assert.equal(d.isOfficer, false);
    assert.deepEqual(d.loot, []);
    assert.deepEqual(d.attended, []);
  } finally { await t.close(); }
});

// ---------------------------------------------------------------- reserves

test('reserves: on my sign-up record; limit, unknown items, clearing, the replaced list in prev, locking and non-raid events', async () => {
  const t = await setup();
  try {
    const { ids, keys } = await lootList(t);
    const raid = await schedule(t, { sr_limit: 1 });
    const key = t.keyOf(raid);
    asRole(t.db, 'member');
    const url = `/api/raids/${raid.id}/reserves`;
    const first = await t.api.post(url, { item_ids: [ids['Frost Greaves']] });
    assert.equal(first.status, 409);
    assert.equal(first.body.error, 'Sign up for this raid first, then pick your reserves.');
    await t.api.post(`/api/raids/${raid.id}/signup`, { character: 'Velanne', role: 'dps' });

    const tooMany = await t.api.post(url, { item_ids: [ids['Frost Greaves'], ids['Night Cloak']] });
    assert.equal(tooMany.status, 400);
    assert.equal(tooMany.body.error, 'You can reserve up to 1 item.');
    const unknown = await t.api.post(url, { item_ids: [999999] });
    assert.equal(unknown.status, 400);
    assert.match(unknown.body.error, /isn’t on this raid’s loot list/);
    const ok = await t.api.post(url, { item_ids: [ids['Frost Greaves']] });
    assert.equal(ok.body.message, 'Reserves saved.');
    assert.deepEqual(ok.body.myReserves.map((r) => r.name), ['Frost Greaves']);
    let su = t.kit.last('su');
    assert.equal(su.key, `${key}:${t.myPid()}`);
    assert.deepEqual([su.fields.character, su.fields.role, su.fields.status], ['Velanne', 'd', 'y'], 'the sign-up stays as it was');
    assert.deepEqual(su.fields.reserves, [keys['Frost Greaves']]);
    assert.equal(su.fields.reservesAt, t.kit.now());
    assert.deepEqual([su.fields.prev, su.fields.prevAt], [[], null]);
    assert.equal(t.kit.queued('su').length, 1);

    const cleared = await t.api.post(url, { item_ids: [] });
    assert.equal(cleared.body.message, 'Reserves cleared.');
    assert.deepEqual(cleared.body.myReserves, []);
    await t.api.post(url, { item_ids: [ids['Frost Greaves']] });
    // The same picks again change nothing.
    const before = t.kit.last('su');
    await t.api.post(url, { item_ids: [ids['Frost Greaves']] });
    assert.equal(t.kit.last('su').op, before.op);

    // Once the game has sent my picks, a change carries them in prev (they count if the raid was locked meanwhile).
    t.kit.ack(t.kit.last('su'));
    const sentAt = t.kit.now();
    t.kit.tick(60);
    await t.api.post(url, { item_ids: [ids['Night Cloak']] });
    su = t.kit.last('su');
    assert.deepEqual([su.fields.reserves, su.fields.prev, su.fields.prevAt, su.fields.reservesAt], [[keys['Night Cloak']], [keys['Frost Greaves']], sentAt, sentAt + 60]);
    // A further change before the game sends this one keeps that prev: the cloak never reached anyone.
    t.kit.tick(60);
    await t.api.post(url, { item_ids: [ids['Tear of the Earth']] });
    su = t.kit.last('su');
    assert.deepEqual([su.fields.reserves, su.fields.prev, su.fields.prevAt], [[keys['Tear of the Earth']], [keys['Frost Greaves']], sentAt]);
    assert.equal(su.base, t.kit.entry(before.op).v, 'edited on top of the version the game confirmed');

    assert.equal((await t.api.post(`/api/raids/${raid.id}/lock`)).status, 403);
    asRole(t.db, 'officer');
    const lock = await t.api.post(`/api/raids/${raid.id}/lock`);
    assert.equal(lock.status, 200);
    assert.equal(lock.body.message, 'Reserves locked.');
    assert.equal(lock.body.raid.status, 'locked');
    const rt = t.kit.last('RT');
    assert.deepEqual([rt.key, rt.need, rt.base, rt.final, rt.fields.status, rt.fields.lockedAt], [key, 'o', '', false, 'l', t.kit.now()]);
    const locked = await t.api.post(url, { item_ids: [] });
    assert.equal(locked.status, 409);
    assert.equal(locked.body.error, 'Reserves are locked for this raid.');
    assert.equal((await t.api.get(`/api/raids/${raid.id}`)).body.canReserve, false);
    // Sign-ups still work while reserves are locked, and keep the reserves as they were.
    assert.equal((await t.api.post(`/api/raids/${raid.id}/signup`, { character: 'Velanne', role: 'healer' })).status, 200);
    assert.deepEqual([t.kit.last('su').fields.reserves, t.kit.last('su').fields.role], [[keys['Tear of the Earth']], 'h']);
    assert.equal((await t.api.post(`/api/raids/${raid.id}/lock`)).status, 409);
    const unlock = await t.api.post(`/api/raids/${raid.id}/unlock`);
    assert.equal(unlock.body.message, 'Reserves reopened.');
    assert.equal(unlock.body.raid.status, 'open');
    assert.deepEqual(t.kit.queued('RT').map((e) => [e.fields.status, e.base]), [['o', '']], 'the reopen replaced the lock that was still waiting');
    assert.equal((await t.api.post(`/api/raids/${raid.id}/unlock`)).status, 409);
    assert.deepEqual(t.audit().filter((a) => a.action.startsWith('raid ')).map((a) => a.action), ['raid locked', 'raid reopened']);

    const pvp = await schedule(t, { kind: 'pvp', instance: 'Hyjal Summit' });
    await t.api.post(`/api/raids/${pvp.id}/signup`, { character: 'Velanne' });
    const pvpRes = await t.api.post(`/api/raids/${pvp.id}/reserves`, { item_ids: [ids['Frost Greaves']] });
    assert.equal(pvpRes.status, 400);
    assert.equal((await t.api.get(`/api/raids/${pvp.id}`)).body.canReserve, false);
  } finally { await t.close(); }
});

// ---------------------------------------------------------------- cancel, compare-and-set

test('cancel: an RT x (final) record; Discord once the game sends it; a raid I signed up for being cancelled tells me', async () => {
  const t = await setup();
  try {
    const raid = await schedule(t);
    t.signupAs(t.mokra, raid);
    asRole(t.db, 'member');
    assert.equal((await t.api.post(`/api/raids/${raid.id}/cancel`)).status, 403);
    asRole(t.db, 'officer');
    const res = await t.api.post(`/api/raids/${raid.id}/cancel`);
    assert.equal(res.status, 200);
    assert.equal(res.body.message, 'Raid cancelled.');
    assert.equal(res.body.raid.status, 'cancelled');
    const e = t.kit.last('RT');
    assert.deepEqual([e.key, e.need, e.base, e.final, e.fields.status], [t.keyOf(raid), 'o', '', true, 'x']);
    assert.ok(S.isFinalV(e.v), 'a cancel is a final version: a late lock never undoes it');
    assert.deepEqual(t.c.events, [], 'I cancelled it: I am not told');
    assert.equal(t.net.webhook().length, 0);
    assert.deepEqual(t.audit().at(-1), { action: 'raid cancelled', detail: 'Hyjal week 1' });
    const again = await t.api.post(`/api/raids/${raid.id}/cancel`);
    assert.equal(again.status, 409);
    assert.equal(again.body.error, 'Only upcoming raids can be cancelled.');
    const close = await t.api.post(`/api/raids/${raid.id}/close`, { attendee_user_ids: [] });
    assert.equal(close.status, 409);
    assert.equal(close.body.error, 'Cancelled raids can’t be closed.');
    const list = await t.api.get('/api/raids');
    assert.equal(list.body.upcoming[0].status, 'cancelled', 'cancelled raids stay in the list so people see it');

    t.kit.ack(t.kit.last('RD'));
    t.kit.ack(e);
    await t.kit.settle();
    assert.equal(t.net.webhook().length, 2);
    assert.match(t.net.webhook().at(-1), /^❌ \*\*Hyjal week 1\*\* on <t:\d+:F> is cancelled\.$/);

    const evt = await schedule(t, { kind: 'event', title: 'Fishing' });
    assert.equal((await t.api.post(`/api/raids/${evt.id}/cancel`)).body.message, 'Event cancelled.');

    // A guildmate's cancel of a raid I'm signed up for tells me (their app writes it, mine notifies).
    const theirs = t.kit.rec('RD', 'zz0001', { kind: 'r', title: 'Theirs', instance: 'MC', startsAt: unix(inDays(1)), srLimit: 2 }, { author: 'Grim' });
    t.kit.imp([theirs]);
    const theirsRow = R.raidByKey(t.db, t.g.guildId, 'zz0001');
    await t.api.post(`/api/raids/${theirsRow.id}/signup`, { character: 'Velanne' });
    t.kit.tick(5);
    t.kit.imp([t.kit.rec('RT', 'zz0001', { status: 'x' }, { author: 'Grim', t: t.kit.now() })]);
    assert.deepEqual(t.c.events.map((e2) => e2.title), ['🗓️ Theirs', '❌ Theirs is cancelled'], 'their app scheduled it, mine tells me; then the cancel');
    assert.equal(R.raidFor(t.db, t.g.guildId, theirsRow.id).status, 'cancelled');
  } finally { await t.close(); }
});

test('compare-and-set: a stale lock is rolled back with a plain note; a newer change from another officer wins; edits name their base', async () => {
  const t = await setup();
  try {
    const raid = await schedule(t);
    const key = t.keyOf(raid);
    t.kit.ack(t.kit.last('RD'));
    assert.equal((await t.api.post(`/api/raids/${raid.id}/lock`)).body.raid.status, 'locked');
    const lock = t.kit.last('RT');

    // The addon found a newer status than the one this computer edited: "no,stale".
    const r = t.kit.ack(lock, 'no,stale');
    assert.equal(r.refused, 1);
    const refused = t.kit.entry(lock.op);
    assert.deepEqual([refused.state, refused.note], ['refused', 'Someone changed this in the meantime. Check it and try again.']);
    assert.equal(R.raidFor(t.db, t.g.guildId, raid.id).status, 'open', 'the lock is rolled back');
    assert.deepEqual(t.kit.queued('RT'), []);
    const status = (await t.api.get('/api/share/status')).body;
    assert.deepEqual(status.refused.map((x) => [x.id, x.note]), [[`RT:${key}`, sharing.LINES.stale]]);

    // Lock again; meanwhile Grim (the Guild Master) cancelled it in game. His newer record wins here too.
    t.kit.tick(5);
    await t.api.post(`/api/raids/${raid.id}/lock`);
    const mine = t.kit.last('RT');
    t.kit.tick(5);
    t.kit.imp([t.kit.rec('RT', key, { status: 'x' }, { author: 'Grim', t: t.kit.now() })]);
    assert.equal(t.kit.entry(mine.op).state, 'refused');
    assert.equal(R.raidFor(t.db, t.g.guildId, raid.id).status, 'cancelled');
    assert.ok(t.audit().some((a) => a.detail === 'Grim cancelled Hyjal week 1.'), 'officer records from others are audited');

    // Grim locked another raid in game; my reopen names the version I edited.
    const r2 = await schedule(t, { title: 'Week 2' });
    const k2 = t.keyOf(r2);
    t.kit.tick(5);
    const theirLock = t.kit.rec('RT', k2, { status: 'l', lockedAt: t.kit.now() }, { author: 'Grim', t: t.kit.now() });
    t.kit.imp([theirLock]);
    assert.equal(R.raidFor(t.db, t.g.guildId, r2.id).status, 'locked');
    t.kit.tick(5);
    assert.equal((await t.api.post(`/api/raids/${r2.id}/unlock`)).status, 200);
    assert.equal(t.kit.last('RT').base, S.parse(theirLock).v);
    assert.equal(t.kit.last('RT').base, sharing.baseOf(t.db, t.g.guildId, `RT:${k2}`));
  } finally { await t.close(); }
});

// ---------------------------------------------------------------- SR+ through the loot screen

test('SR+ end to end through the records: rolls with bonus, awards reset the winner, closing grows the rest and resets no-shows', async () => {
  const t = await setup();
  try {
    const { ids, keys } = await lootList(t);
    const greaves = ids['Frost Greaves'];
    const cloak = ids['Night Cloak'];
    const charlie = t.kit.mate('Charlie', { battletag: 'Charlie#3' });
    // Charlie's 30 on the cloak from earlier raids, in an officer's checkpoint.
    t.checkpoint(HYJAL, [{ pid: charlie.pid, item: keys['Night Cloak'], bonus: 30 }]);
    assert.equal(t.bonus(charlie.id, cloak), 30);

    // Week 1: Mokra and I reserve greaves, Charlie the cloak. Charlie signs up "yes" but doesn't come.
    t.kit.tick(60);
    const w1 = await schedule(t, { title: 'Week 1' });
    await t.api.post(`/api/raids/${w1.id}/signup`, { character: 'Velanne', role: 'dps', status: 'yes' });
    await t.api.post(`/api/raids/${w1.id}/reserves`, { item_ids: [greaves] });
    t.signupAs(t.mokra, w1, { reserves: [keys['Frost Greaves']] });
    t.signupAs(charlie, w1, { reserves: [keys['Night Cloak']] });

    asRole(t.db, 'member');
    assert.equal((await t.api.post(`/api/raids/${w1.id}/close`, { attendee_user_ids: [t.mokra.id] })).status, 403);
    asRole(t.db, 'officer');
    t.kit.tick(60);
    const closed = await t.api.post(`/api/raids/${w1.id}/close`, { attendee_user_ids: [t.mokra.id, t.me, 0, -4, 'x', 987654] });
    assert.equal(closed.status, 200);
    assert.equal(closed.body.message, 'Raid closed. 2 attended, 1 no-show. Bonuses updated.');
    assert.equal(closed.body.raid.status, 'done');
    const close1 = t.kit.last('RT');
    assert.deepEqual([close1.key, close1.need, close1.final], [t.keyOf(w1), 'o', true]);
    assert.deepEqual(close1.fields, {
      status: 'd', lockedAt: null, kind: 'r', instance: HYJAL, closedAt: t.kit.now(),
      attendees: [{ pid: t.mokra.pid, items: [keys['Frost Greaves']] }, { pid: t.myPid(), items: [keys['Frost Greaves']] }].sort((a, b) => (a.pid < b.pid ? -1 : 1)),
      noShows: [charlie.pid],
    });
    assert.equal(t.bonus(t.mokra.id, greaves), 10);
    assert.equal(t.bonus(t.me, greaves), 10);
    assert.equal(t.bonus(charlie.id, cloak), 0, 'no-show resets the bonus');
    assert.deepEqual(t.audit().at(-1), { action: 'raid closed', detail: 'Week 1: 2 attended, 1 no-shows' });
    assert.ok(t.activity().includes('raid: Week 1 finished with 2 raiders'));
    const twice = await t.api.post(`/api/raids/${w1.id}/close`, { attendee_user_ids: [] });
    assert.deepEqual([twice.status, twice.body.error], [409, 'This raid is already closed.']);
    assert.deepEqual((await t.api.get(`/api/raids/${w1.id}`)).body.attended.sort(), [t.mokra.id, t.me].sort());

    // Week 2: greaves drops. Only reservers in the raid roll; the bonus is added.
    t.kit.tick(7 * 86400);
    const w2 = await schedule(t, { title: 'Week 2' });
    t.signupAs(t.mokra, w2, { reserves: [keys['Frost Greaves']] });
    await t.api.post(`/api/raids/${w2.id}/signup`, { character: 'Velanne', status: 'bench' });
    t.signupAs(charlie, w2, { status: 'tentative', reserves: [keys['Frost Greaves']] });
    await t.api.post(`/api/raids/${w2.id}/reserves`, { item_ids: [greaves] });

    asRole(t.db, 'member');
    assert.equal((await t.api.get(`/api/raids/${w2.id}/loot`)).status, 403, 'members cannot open the loot screen');
    asRole(t.db, 'officer');
    const screen = await t.api.get(`/api/raids/${w2.id}/loot`);
    assert.equal(screen.status, 200);
    assert.equal(screen.body.board.length, 1);
    assert.deepEqual(screen.body.board[0].reservers.map((r) => [r.character, r.bonus, r.inRaid]).sort(),
      [['Charlie', 0, false], ['Mokra', 10, true], ['Velanne', 10, true]]);
    assert.deepEqual(screen.body.board[0].rolls, []);
    assert.deepEqual(screen.body.attending.map((a) => a.character), ['Mokra', 'Velanne']);
    assert.equal(screen.body.items.length, 4);

    assert.equal((await t.api.post(`/api/raids/${w2.id}/roll`, { item_id: 0 })).status, 404);
    const queuedBefore = t.kit.queued().length;
    const roll = await t.api.post(`/api/raids/${w2.id}/roll`, { item_id: greaves });
    assert.equal(roll.status, 200);
    assert.equal(t.kit.queued().length, queuedBefore, 'rolls stay on this computer');
    assert.deepEqual(roll.body.rolls.map((r) => r.character).sort(), ['Mokra', 'Velanne']);
    for (const r of roll.body.rolls) {
      assert.ok(r.roll >= 1 && r.roll <= 100);
      assert.equal(r.bonus, 10);
      assert.equal(r.total, r.roll + 10);
    }
    assert.match(roll.body.message, /has the highest roll for Frost Greaves/);
    assert.equal((await t.api.get(`/api/raids/${w2.id}/loot`)).body.board[0].rolls.length, 2);
    const mokraRoll = roll.body.rolls.find((r) => r.character === 'Mokra').roll;

    // Give it to Mokra (a reserve win): an LA record with the roll; bonus resets, reserve fulfilled, rolls cleared.
    t.kit.tick(60);
    const award = await t.api.post(`/api/raids/${w2.id}/award`, { item_id: greaves, user_id: t.mokra.id, kind: 'sr' });
    assert.equal(award.status, 200);
    assert.equal(award.body.message, 'Frost Greaves given to Mokra.');
    assert.equal(award.body.award.character, 'Mokra');
    assert.equal(award.body.award.kind, 'sr');
    assert.equal(award.body.award.wh_id, 30871);
    assert.equal(award.body.award.bonus, 10);
    assert.equal(award.body.award.user_id, t.mokra.id);
    const la = t.kit.last('LA');
    assert.deepEqual([la.need, la.base, la.final], ['o', '', false]);
    assert.equal(award.body.award.share_id, la.key);
    assert.deepEqual(la.fields, {
      raid: t.keyOf(w2), instance: HYJAL, item: keys['Frost Greaves'], itemName: 'Frost Greaves', character: 'Mokra', pid: t.mokra.pid, kind: 's', roll: mokraRoll, bonus: 10,
    });
    assert.equal(t.bonus(t.mokra.id, greaves), 0);
    assert.equal(t.net.webhook().length, 0, 'the post waits for the game');
    t.kit.ack(t.kit.queued('RD').find((e) => e.key === t.keyOf(w2)));
    t.kit.ack(la);
    await t.kit.settle();
    assert.match(t.net.webhook().at(-1), /^💎 \*\*Frost Greaves\*\* → Mokra \(SR, Week 2\)$/);
    assert.deepEqual(t.audit().at(-1), { action: 'loot given', detail: 'Frost Greaves → Mokra (sr)' });
    assert.ok(t.activity().includes('loot: Mokra received Frost Greaves'));
    assert.equal(t.c.events.length, 0, 'loot awards send no notification');
    assert.deepEqual((await t.api.get(`/api/raids/${w2.id}/loot`)).body.board[0].rolls, [], 'the rolls for it are done');

    // Off-reserve loot: by name (matched to the list when it can be), to a member or a typed-in character.
    t.kit.tick(1);
    const os = await t.api.post(`/api/raids/${w2.id}/award`, { item_name: 'random ring', user_id: t.me, kind: 'os' });
    assert.equal(os.body.award.item_name, 'random ring');
    assert.equal(os.body.award.character, 'Velanne');
    assert.deepEqual([t.kit.last('LA').fields.item, t.kit.last('LA').fields.pid, t.kit.last('LA').fields.kind], [S.itemKey('random ring'), t.myPid(), 'o']);
    t.kit.tick(1);
    const matched = await t.api.post(`/api/raids/${w2.id}/award`, { item_name: 'loose trinket', character: 'Pugsy', kind: 'free' });
    assert.equal(matched.body.award.item_name, 'Loose Trinket');
    assert.equal(matched.body.award.item_id, ids['Loose Trinket']);
    assert.equal(matched.body.award.character, 'Pugsy');
    assert.equal(matched.body.award.user_id, null);
    assert.deepEqual([t.kit.last('LA').fields.pid, t.kit.last('LA').fields.item], ['', keys['Loose Trinket']]);
    t.kit.tick(1);
    const byChar = await t.api.post(`/api/raids/${w2.id}/award`, { item_name: 'Night Cloak', character: 'mokra', kind: 'ms' });
    assert.equal(byChar.body.award.user_id, t.mokra.id, 'a sign-up name finds the member');
    assert.equal(byChar.body.award.character, 'Mokra');
    assert.equal((await t.api.post(`/api/raids/${w2.id}/award`, { item_name: 'X' })).body.error, 'Pick who gets it.');
    assert.equal((await t.api.post(`/api/raids/${w2.id}/award`, { user_id: t.mokra.id })).body.error, 'Pick an item.');
    const outsider = addPlayer(t.db, t.g.guildId, 'Outsider#1', { role: 'member' }).id;
    t.db.prepare('DELETE FROM memberships WHERE user_id = ?').run(outsider);
    assert.equal((await t.api.post(`/api/raids/${w2.id}/award`, { item_name: 'X', user_id: outsider })).status, 400);

    const after = await t.api.get(`/api/raids/${w2.id}/loot`);
    assert.deepEqual(after.body.awarded.map((a) => a.item_name), ['Night Cloak', 'Loose Trinket', 'random ring', 'Frost Greaves']);
    assert.deepEqual(after.body.board[0].reservers.map((r) => r.character).sort(), ['Charlie', 'Velanne'], 'the winner’s reserve is fulfilled');

    // Closing week 2: I (bench, attended, still reserving greaves) grow to 20.
    t.kit.tick(60);
    await t.api.post(`/api/raids/${w2.id}/close`, { attendee_user_ids: [t.mokra.id, t.me] });
    assert.deepEqual(t.kit.last('RT').fields.attendees.find((a) => a.pid === t.mokra.pid).items, [], 'the snapshot leaves out what was won');
    assert.equal(t.bonus(t.me, greaves), 20);
    assert.equal(t.bonus(t.mokra.id, greaves), 0);

    // Loot page: history and my bonuses.
    const loot = await t.api.get('/api/loot');
    assert.equal(loot.body.history.length, 4);
    assert.equal(loot.body.history[0].title, 'Week 2');
    assert.deepEqual(loot.body.myLoyalty.map((l) => [l.name, l.bonus]), [['Frost Greaves', 20]]);
    // Awards stay possible after the raid closed (someone forgot to record one).
    assert.equal((await t.api.post(`/api/raids/${w2.id}/award`, { item_name: 'Late find', user_id: t.mokra.id })).status, 200);

    // Every loyalty number is the same as the old server's rules give for the same raids.
    const fold = S.loyaltyFold(HYJAL, require('../../src/core/share/project').foldRecords(t.db, t.g.guildId, HYJAL));
    assert.deepEqual(fold.bonuses, { [t.myPid()]: { [keys['Frost Greaves']]: 20 } });
  } finally { await t.close(); }
});

test('closing a PvP premade or guild event records attendance but leaves SR+ loyalty for that instance alone', async () => {
  const t = await setup();
  try {
    const { ids, keys } = await lootList(t);
    const greaves = ids['Frost Greaves'];
    const cloak = ids['Night Cloak'];
    t.checkpoint(HYJAL, [{ pid: t.mokra.pid, item: keys['Frost Greaves'], bonus: 30 }, { pid: t.myPid(), item: keys['Night Cloak'], bonus: 20 }]);
    assert.deepEqual([t.bonus(t.mokra.id, greaves), t.bonus(t.me, cloak)], [30, 20]);

    // A PvP premade at the same place: Mokra comes, I sign up "yes" and don't show.
    t.kit.tick(60);
    const pvp = await schedule(t, { kind: 'pvp', title: 'Hyjal brawl', instance: 'Hyjal Summit' });
    t.signupAs(t.mokra, pvp);
    await t.api.post(`/api/raids/${pvp.id}/signup`, { character: 'Velanne', role: 'healer', status: 'yes' });
    t.kit.tick(60);
    const closedPvp = await t.api.post(`/api/raids/${pvp.id}/close`, { attendee_user_ids: [t.mokra.id] });
    assert.equal(closedPvp.status, 200, JSON.stringify(closedPvp.body));
    assert.equal(closedPvp.body.message, 'PvP closed. 1 attended, 1 no-show.');
    assert.equal(closedPvp.body.raid.status, 'done');
    assert.equal(closedPvp.body.attended, 1);
    assert.equal(closedPvp.body.noShows, 1);
    assert.deepEqual([t.kit.last('RT').fields.kind, t.kit.last('RT').fields.noShows], ['p', [t.myPid()]]);
    assert.deepEqual((await t.api.get(`/api/raids/${pvp.id}`)).body.attended, [t.mokra.id]);
    assert.equal(t.bonus(t.mokra.id, greaves), 30, 'attending without a reserve does not end the streak');
    assert.equal(t.bonus(t.me, cloak), 20, 'a no-show at a PvP premade does not reset the bonus');
    assert.deepEqual(t.audit().at(-1), { action: 'raid closed', detail: 'Hyjal brawl: 1 attended, 1 no-shows' });

    const evt = await schedule(t, { kind: 'event', title: 'Hyjal sightseeing', instance: 'Hyjal Summit' });
    await t.api.post(`/api/raids/${evt.id}/signup`, { character: 'Velanne', status: 'yes' });
    t.kit.tick(60);
    const closedEvt = await t.api.post(`/api/raids/${evt.id}/close`, { attendee_user_ids: [t.mokra.id, t.me] });
    assert.equal(closedEvt.body.message, 'Event closed. 2 attended.');
    assert.equal(t.bonus(t.mokra.id, greaves), 30);
    assert.equal(t.bonus(t.me, cloak), 20);
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM loyalty').get().n, 2, 'no loyalty rows added or removed');
  } finally { await t.close(); }
});

// ---------------------------------------------------------------- loot lists

test('loot lists: one LL record per instance; officers paste and remove items; everyone reads lists and history', async () => {
  const t = await setup({ role: 'member' });
  try {
    assert.equal((await t.api.post('/api/loot/items', { instance: 'MC', text: 'Lucifron | Boots' })).status, 403);
    asRole(t.db, 'officer');
    assert.equal((await t.api.post('/api/loot/items', { instance: '', text: 'x' })).body.error, 'Name the instance.');
    assert.equal((await t.api.post('/api/loot/items', { instance: 'MC', text: '  ' })).status, 400);

    const res = await t.api.post('/api/loot/items', { instance: 'Molten Core', text: 'Lucifron | Felheart Gloves | https://www.wowhead.com/classic/item=16805\nMagmadar | Striker\'s Mark | 17069\nCore Leather' });
    assert.equal(res.status, 200);
    assert.equal(res.body.added, 3);
    assert.equal(res.body.message, '3 items added to Molten Core.');
    assert.deepEqual(res.body.items.map((i) => [i.boss, i.name, i.item_id]), [[null, 'Core Leather', null], ['Lucifron', 'Felheart Gloves', 16805], ['Magmadar', 'Striker\'s Mark', 17069]]);
    const ll = t.kit.last('LL');
    assert.deepEqual([ll.key, ll.need, ll.base], [S.instanceKey('Molten Core'), 'o', '']);
    assert.deepEqual(ll.fields, {
      name: 'Molten Core', bosses: ['Lucifron', 'Magmadar'],
      items: [{ item: S.itemKey(16805), boss: 1, name: 'Felheart Gloves' }, { item: S.itemKey(17069), boss: 2, name: 'Striker\'s Mark' }, { item: S.itemKey('Core Leather'), boss: 0, name: 'Core Leather' }],
    });
    const again = await t.api.post('/api/loot/items', { instance: 'Molten Core', items: 'Lucifron | Core Leather\nRagnaros | Sulfuras' });
    assert.equal(again.body.added, 1);
    assert.equal(again.body.message, '1 item added to Molten Core.');
    assert.equal(again.body.items.find((i) => i.name === 'Core Leather').boss, 'Lucifron');
    assert.deepEqual(t.kit.queued('LL').map((e) => [e.fields.bosses, e.fields.items.length]), [[['Lucifron', 'Magmadar', 'Ragnaros'], 4]], 'one list record, replaced while it waits');
    const unchanged = await t.api.post('/api/loot/items', { instance: 'Molten Core', text: 'Sulfuras' });
    assert.equal(unchanged.body.added, 0);
    await t.api.post('/api/loot/items', { instance: 'Blackwing Lair', text: 'Razorgore | Arcane Infused Gem' });
    assert.deepEqual(t.kit.queued('LL').map((e) => e.fields.name), ['Molten Core', 'Blackwing Lair']);
    assert.deepEqual(t.audit().filter((a) => a.action === 'loot list items added').map((a) => a.detail), ['3 to Molten Core', '1 to Molten Core', '1 to Blackwing Lair']);

    asRole(t.db, 'member');
    const loot = await t.api.get('/api/loot');
    assert.equal(loot.status, 200);
    assert.deepEqual(loot.body.lists.map((l) => [l.instance, l.items.length]), [['Blackwing Lair', 1], ['Molten Core', 4]]);
    assert.equal(loot.body.lists[1].items.find((i) => i.name === 'Felheart Gloves').wh_id, 16805);
    assert.deepEqual(loot.body.history, []);
    assert.deepEqual(loot.body.myLoyalty, []);

    const gloves = loot.body.lists[1].items.find((i) => i.name === 'Felheart Gloves');
    assert.equal((await t.api.del(`/api/loot/items/${gloves.id}`)).status, 403);
    asRole(t.db, 'officer');
    // The list was sent: the removal is an edit on top of the version the game confirmed.
    t.kit.ack(t.kit.queued('LL')[0]);
    const del = await t.api.del(`/api/loot/items/${gloves.id}`);
    assert.equal(del.status, 200);
    assert.equal(del.body.message, 'Felheart Gloves removed.');
    const edit = t.kit.last('LL');
    assert.equal(edit.base, sharing.baseOf(t.db, t.g.guildId, `LL:${S.instanceKey('Molten Core')}`));
    assert.notEqual(edit.base, '');
    assert.deepEqual(edit.fields.items.map((i) => i.name), ['Striker\'s Mark', 'Core Leather', 'Sulfuras']);
    assert.deepEqual(edit.fields.bosses, ['Magmadar', 'Lucifron', 'Ragnaros'], 'boss numbers follow the items left');
    assert.deepEqual(t.audit().at(-1), { action: 'loot list item removed', detail: 'Felheart Gloves (Molten Core)' });
    assert.equal((await t.api.del(`/api/loot/items/${gloves.id}`)).status, 404);
    assert.equal((await t.api.del('/api/loot/items/abc')).status, 404);

    // A refused edit puts the list back as the guild has it.
    t.kit.ack(edit, 'no,stale');
    assert.ok((await t.api.get('/api/loot')).body.lists.find((l) => l.instance === 'Molten Core').items.some((i) => i.name === 'Felheart Gloves'));

    // A shared list holds at most 150 items.
    const many = Array.from({ length: 151 }, (_, i) => `Boss | Thing ${i}`).join('\n');
    const big = await t.api.post('/api/loot/items', { instance: 'Naxxramas', text: many });
    assert.equal(big.status, 400);
    assert.equal(big.body.error, 'A loot list can hold up to 150 items. Remove some first.');

    // A list typed in before sharing becomes one shared list on its first edit.
    t.db.prepare("INSERT INTO loot_items (guild_id, instance, boss, name, item_id) VALUES (?, 'Onyxia''s Lair', 'Onyxia', 'Head of Onyxia', 18423)").run(t.g.guildId);
    await t.api.post('/api/loot/items', { instance: 'Onyxia\'s Lair', text: 'Onyxia | Onyxia Tooth Pendant' });
    assert.deepEqual(t.kit.last('LL').fields.items.map((i) => [i.item, i.name]), [[S.itemKey(18423), 'Head of Onyxia'], [S.itemKey('Onyxia Tooth Pendant'), 'Onyxia Tooth Pendant']]);
  } finally { await t.close(); }
});

test('a first loot list cancelled from the outbox or refused (no,expired) takes its items with it, so the next paste does not re-share them and reserves only offer what the guild has', async () => {
  const t = await setup();
  try {
    const rows = (instance) => t.db.prepare('SELECT name, item_key FROM loot_items WHERE guild_id = ? AND instance = ? ORDER BY name').all(t.g.guildId, instance)
      .map((r) => [r.name, r.item_key]);
    await t.api.post('/api/loot/items', { instance: 'Molten Core', text: 'Lucifron | Felheart Gloves\nMagmadar | Striker\'s Mark' });
    const first = t.kit.last('LL');
    assert.equal(rows('Molten Core').length, 2, 'the page shows the list at once');
    const cancel = await t.api.post(`/api/share/outbox/${first.op}/cancel`);
    assert.equal(cancel.status, 200);
    assert.deepEqual(rows('Molten Core'), [], 'the dropped list leaves no items behind');
    assert.deepEqual((await t.api.get('/api/loot')).body.lists, []);

    // The next paste shares only what it adds; a raid on the instance offers only that.
    await t.api.post('/api/loot/items', { instance: 'Molten Core', text: 'Garr | Drillborer Disk' });
    const next = t.kit.last('LL');
    assert.deepEqual([next.base, next.fields.items.map((i) => i.name)], ['', ['Drillborer Disk']]);
    const raid = await schedule(t, { title: 'MC', instance: 'Molten Core' });
    await t.api.post(`/api/raids/${raid.id}/signup`, { character: 'Velanne' });
    assert.deepEqual((await t.api.get(`/api/raids/${raid.id}`)).body.items.map((i) => i.name), ['Drillborer Disk']);

    // Refused by the game: the same.
    t.kit.ack(next, 'no,expired');
    assert.equal(t.kit.entry(next.op).note, 'This waited too long and was not sent.');
    assert.deepEqual(rows('Molten Core'), []);
    assert.deepEqual((await t.api.get(`/api/raids/${raid.id}`)).body.items, []);

    // A list typed before sharing stays as typed when its first shared edit is dropped, and gets its keys
    // once the guild has the list.
    t.db.prepare("INSERT INTO loot_items (guild_id, instance, boss, name, item_id) VALUES (?, 'Onyxia''s Lair', 'Onyxia', 'Head of Onyxia', 18423)").run(t.g.guildId);
    await t.api.post('/api/loot/items', { instance: 'Onyxia\'s Lair', text: 'Onyxia | Onyxia Tooth Pendant' });
    assert.deepEqual(rows('Onyxia\'s Lair'), [['Head of Onyxia', null], ['Onyxia Tooth Pendant', S.itemKey('Onyxia Tooth Pendant')]]);
    await t.api.post(`/api/share/outbox/${t.kit.last('LL').op}/cancel`);
    assert.deepEqual(rows('Onyxia\'s Lair'), [['Head of Onyxia', null]]);
    await t.api.post('/api/loot/items', { instance: 'Onyxia\'s Lair', text: 'Onyxia | Onyxia Tooth Pendant' });
    t.kit.ack(t.kit.last('LL'));
    assert.deepEqual(rows('Onyxia\'s Lair'), [['Head of Onyxia', S.itemKey(18423)], ['Onyxia Tooth Pendant', S.itemKey('Onyxia Tooth Pendant')]]);
  } finally { await t.close(); }
});

test('a raid whose instance capitalisation differs from the loot list ("molten core" vs "Molten Core") shows the list: items, reserves, loot screen, award by name and the "Add the items" link; new raids take the list\'s spelling', async () => {
  const t = await setup();
  try {
    await t.api.post('/api/loot/items', { instance: 'Molten Core', text: 'Lucifron | Felheart Gloves | 16805\nMagmadar | Striker\'s Mark' });
    // Another officer's app shared the raid with the instance typed in lower case.
    const startsAt = unix(inDays(2));
    t.kit.imp([t.kit.rec('RD', 'mc0001', { kind: 'r', title: 'MC Thursday', instance: 'molten core', startsAt, minutes: 180, size: 40, srLimit: 2, notes: '' }, { author: 'Grim' })]);
    const raid = R.raidByKey(t.db, t.g.guildId, 'mc0001');
    assert.equal(raid.instance, 'molten core');
    let d = (await t.api.get(`/api/raids/${raid.id}`)).body;
    assert.deepEqual(d.items.map((i) => i.name), ['Felheart Gloves', 'Striker\'s Mark']);
    assert.equal(d.needsSignup, true);

    await t.api.post(`/api/raids/${raid.id}/signup`, { character: 'Velanne' });
    d = (await t.api.get(`/api/raids/${raid.id}`)).body;
    assert.equal(d.canReserve, true);
    const gloves = d.items.find((i) => i.name === 'Felheart Gloves');
    const res = await t.api.post(`/api/raids/${raid.id}/reserves`, { item_ids: [gloves.id] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(t.kit.last('su').fields.reserves, [S.itemKey(16805)]);
    assert.deepEqual((await t.api.get(`/api/raids/${raid.id}`)).body.myReserves.map((r) => r.name), ['Felheart Gloves']);

    // The officer's loot screen, and an award typed by name.
    assert.deepEqual((await t.api.get(`/api/raids/${raid.id}/loot`)).body.items.map((i) => i.name), ['Felheart Gloves', 'Striker\'s Mark']);
    const award = await t.api.post(`/api/raids/${raid.id}/award`, { item_name: 'striker\'s mark', character: 'Mokra', kind: 'ms' });
    assert.equal(award.status, 200);
    assert.equal(award.body.award.item_id, d.items.find((i) => i.name === 'Striker\'s Mark').id);
    assert.equal(t.kit.last('LA').fields.item, S.itemKey('Striker\'s Mark'));

    // The raid page's "Add the items" link names the raid's spelling: the items land on the list the raid shows.
    const add = await t.api.post('/api/loot/items', { instance: 'molten core', text: 'Garr | Core Hound Tooth' });
    assert.deepEqual([add.body.instance, add.body.added, add.body.items.length], ['Molten Core', 1, 3]);
    assert.equal((await t.api.get(`/api/raids/${raid.id}`)).body.items.length, 3);

    // A new raid typed in lower case takes the list's spelling; the instance list offers it once.
    const mine = await schedule(t, { title: 'MC Sunday', instance: 'molten core' });
    assert.equal(mine.instance, 'Molten Core');
    assert.equal(t.kit.last('RD').fields.instance, 'Molten Core');
    const fresh = await schedule(t, { title: 'Ony', instance: 'Onyxia\'s Lair' });
    assert.equal(fresh.instance, 'Onyxia\'s Lair', 'no list: as typed');
    assert.deepEqual((await t.api.get('/api/raids')).body.instances, ['Molten Core', 'Onyxia\'s Lair']);
  } finally { await t.close(); }
});

test('reserve picker before signing up: the raid says needsSignup and canReserve is false, so saving never meets the 409; a sign-up turns reserves on', async () => {
  const t = await setup();
  try {
    const { ids } = await lootList(t);
    const raid = await schedule(t);
    asRole(t.db, 'member');
    let d = (await t.api.get(`/api/raids/${raid.id}`)).body;
    assert.deepEqual([d.mySignup, d.canReserve, d.needsSignup], [null, false, true]);
    // What the picker would have saved.
    const early = await t.api.post(`/api/raids/${raid.id}/reserves`, { item_ids: [ids['Night Cloak']] });
    assert.deepEqual([early.status, early.body.error], [409, 'Sign up for this raid first, then pick your reserves.']);

    await t.api.post(`/api/raids/${raid.id}/signup`, { character: 'Velanne', status: 'tentative' });
    d = (await t.api.get(`/api/raids/${raid.id}`)).body;
    assert.deepEqual([d.mySignup.status, d.canReserve, d.needsSignup], ['tentative', true, false]);
    assert.equal((await t.api.post(`/api/raids/${raid.id}/reserves`, { item_ids: [ids['Night Cloak']] })).status, 200);

    // Nothing to ask for when reserves aren't open: locked, no loot list, or not a raid.
    asRole(t.db, 'officer');
    await t.api.post(`/api/raids/${raid.id}/lock`);
    asRole(t.db, 'member');
    d = (await t.api.get(`/api/raids/${raid.id}`)).body;
    assert.deepEqual([d.canReserve, d.needsSignup], [false, false]);
    asRole(t.db, 'officer');
    const bare = await schedule(t, { title: 'Kara', instance: 'Karazhan' });
    const pvp = await schedule(t, { kind: 'pvp', title: 'AV', instance: 'Hyjal Summit' });
    for (const r of [bare, pvp]) {
      d = (await t.api.get(`/api/raids/${r.id}`)).body;
      assert.deepEqual([d.canReserve, d.needsSignup], [false, false], r.title);
    }
  } finally { await t.close(); }
});

// ---------------------------------------------------------------- reminders, timers

test('one-hour reminder: once per raid, a notification when I signed up, a Discord post for raids I made', async () => {
  const t = await setup();
  try {
    const soon = await schedule(t, { title: 'Soon', starts_at: new Date(Date.now() + 30 * 60000).toISOString() });
    await schedule(t, { title: 'Later', starts_at: inDays(1) });
    t.signupAs(t.mokra, soon, { role: 'tank' });
    await t.api.post(`/api/raids/${soon.id}/signup`, { character: 'Velanne', role: 'healer', status: 'tentative' });
    // Someone else's raid I can't make: no reminder for me, and no Discord post from my app.
    t.kit.imp([t.kit.rec('RD', 'th0001', { kind: 'r', title: 'Theirs', instance: 'MC', startsAt: Math.floor(Date.now() / 1000) + 20 * 60, srLimit: 2 }, { author: 'Grim' })]);
    const theirs = R.raidByKey(t.db, t.g.guildId, 'th0001');
    assert.equal(theirs.created_by, t.grim.id);
    assert.deepEqual(t.c.events.splice(0).map((e) => e.title), ['🗓️ Theirs'], 'a guildmate’s new raid is announced to me');
    await t.api.post(`/api/raids/${theirs.id}/signup`, { character: 'Velanne', status: 'no' });
    const posts = t.net.webhook().length;

    assert.equal(await t.c.ctx.services.raids.remind(), 2);
    assert.equal(await t.c.ctx.services.raids.remind(), 0);
    assert.deepEqual(t.c.events.map((e) => [e.kind, e.title, e.route]), [['raid', '⏰ Soon starts in an hour', `/raids/${soon.id}`]]);
    assert.equal(t.net.webhook().length, posts + 1);
    assert.match(t.net.webhook().at(-1), /^⏰ \*\*Soon\*\* starts <t:\d+:R>\. 1 tank, 0 healers, 0 damage signed up\. Sign up in Guild Camp\.$/);
  } finally { await t.close(); }
});

test('Y3: after a fresh start, a raid whose one-hour reminder already went out comes back with the store and is not reminded again (no second notification, no second Discord post); one that was never reminded still is', async () => {
  const t = await setup();
  try {
    const soon = await schedule(t, { title: 'Soon', starts_at: new Date(Date.now() + 30 * 60000).toISOString() });
    const key = t.keyOf(soon);
    await t.api.post(`/api/raids/${soon.id}/signup`, { character: 'Velanne', role: 'healer' });
    for (const e of t.kit.queued()) t.kit.ack(e, 'ok'); // the game sent them
    assert.equal(await t.c.ctx.services.raids.remind(), 1);
    assert.deepEqual(t.c.events.map((e) => e.title), ['⏰ Soon starts in an hour']);
    const posts = t.net.webhook().length;
    // The fresh start, then the next upload: my characters and the guild's store, with a raid nobody was reminded of yet.
    const store = t.db.prepare("SELECT body FROM shared_records WHERE state = 'ok'").all().map((r) => r.body);
    resetGuild(t.db, t.g.guildId, null);
    assert.equal(R.raidByKey(t.db, t.g.guildId, key), undefined, 'the rows went');
    seedGuild(t.db, { role: 'officer', character: 'Velanne', cls: 'PRIEST' });
    t.kit.tick(60);
    t.kit.imp([...store, t.kit.rec('RD', 'nw0001', { kind: 'r', title: 'Later today', instance: 'MC', startsAt: Math.floor(Date.now() / 1000) + 40 * 60, srLimit: 2 }, { author: 'Velanne' })]);
    for (const e of t.kit.queued()) t.kit.ack(e, 'ok');
    assert.ok(R.raidByKey(t.db, t.g.guildId, key), 'the raid came back with the store');
    assert.equal(R.raidByKey(t.db, t.g.guildId, key).reminded, 1);
    t.c.events.length = 0;
    assert.equal(await t.c.ctx.services.raids.remind(), 1, 'only the raid nobody was reminded of');
    assert.equal(t.net.webhook().length, posts + 1);
    assert.match(t.net.webhook().at(-1), /^⏰ \*\*Later today\*\* starts/);
    assert.equal(t.c.events.some((e) => e.title === '⏰ Soon starts in an hour'), false);
  } finally { await t.close(); }
});

test('Y3: two fresh starts in a row before the next upload (the first one\'s raids not back yet) still don\'t remind a raid twice, and what was remembered goes once the raid has started', async () => {
  const t = await setup();
  try {
    const soon = await schedule(t, { title: 'Soon', starts_at: new Date(Date.now() + 30 * 60000).toISOString() });
    const key = t.keyOf(soon);
    for (const e of t.kit.queued()) t.kit.ack(e, 'ok');
    assert.equal(await t.c.ctx.services.raids.remind(), 1);
    const posts = t.net.webhook().length;
    const store = t.db.prepare("SELECT body FROM shared_records WHERE state = 'ok'").all().map((r) => r.body);
    resetGuild(t.db, t.g.guildId, null);
    resetGuild(t.db, t.g.guildId, null); // clicked again before the game uploaded
    seedGuild(t.db, { role: 'officer', character: 'Velanne', cls: 'PRIEST' });
    t.kit.tick(60);
    t.kit.imp(store);
    assert.equal(R.raidByKey(t.db, t.g.guildId, key).reminded, 1, 'the raid came back, reminded');
    t.c.events.length = 0;
    assert.equal(await t.c.ctx.services.raids.remind(), 0);
    assert.equal(t.net.webhook().length, posts, 'no second Discord post');
    assert.deepEqual(t.c.events, []);
    // A later fresh start once the raid has started forgets it.
    t.db.prepare('UPDATE raids SET starts_at = ? WHERE share_id = ?').run(new Date(Date.now() - 60000).toISOString(), key);
    resetGuild(t.db, t.g.guildId, null);
    assert.equal(t.db.prepare("SELECT value FROM app_settings WHERE key = ?").get(`raids_reminded:${t.g.guildId}`), undefined);
  } finally { await t.close(); }
});

test('the reminder loop only runs when timers are on', async () => {
  const off = await startCore();
  try { assert.equal(off.ctx.timers.length, 0); } finally { await off.close(); }
  const on = await startCore({ timers: true });
  try { assert.ok(on.ctx.timers.length >= 1); } finally { await on.close(); }
  assert.equal(on.ctx.timers.length, 0, 'close() clears them');
});
