// Raids domain over HTTP: scheduling (raids, PvP, events), sign-ups, soft reserves, SR+ loyalty,
// the officer loot screen, loot lists and history, Discord posts and events, reminders, notifications.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, seed, client, addUser } = require('./helpers');
const { startFrom, readinessFlags, utcLabel } = require('../src/routes/raids');

const WEBHOOK = 'https://discord.com/api/webhooks/1/abc';
const DAY = 86400000;
const inDays = (n) => new Date(Date.now() + n * DAY).toISOString();

// A stand-in for outside HTTP that records every call. Discord scheduled events answer { id }.
function fakeFetch({ fail = false } = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
    if (fail) return new Response('nope', { status: 500 });
    if (/scheduled-events$/.test(url)) return new Response(JSON.stringify({ id: 'ev-77' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    return new Response(null, { status: 204 });
  };
  return { fetch, calls, webhook: () => calls.filter((c) => c.url === WEBHOOK).map((c) => c.body.content) };
}

async function setup(overrides = {}) {
  const net = fakeFetch(overrides.netOptions);
  const srv = await startServer({ fetch: net.fetch, ...overrides.cfg });
  const s = seed(srv.db);
  srv.db.prepare('UPDATE guilds SET discord_webhook = ? WHERE id = ?').run(WEBHOOK, s.guildId);
  const owner = client(srv.url, s.owner.token);
  const officer = client(srv.url, s.officer.token);
  const member = client(srv.url, s.member.token);
  const char = (userId, name, cls, readiness = null, isMain = 0) => srv.db.prepare(
    'INSERT INTO characters (guild_id, user_id, name, class, level, readiness, is_main) VALUES (?,?,?,?,60,?,?)',
  ).run(s.guildId, userId, name, cls, readiness ? JSON.stringify(readiness) : null, isMain);
  const audit = () => srv.db.prepare('SELECT action, detail FROM audit_log ORDER BY id').all();
  const activity = () => srv.db.prepare('SELECT kind, text FROM activity ORDER BY id').all().map((r) => `${r.kind}: ${r.text}`);
  const events = () => srv.db.prepare('SELECT * FROM events ORDER BY id').all();
  return { srv, s, net, owner, officer, member, char, audit, activity, events, db: srv.db };
}

async function schedule(c, body = {}) {
  const res = await c.post('/api/raids', { kind: 'raid', title: 'Hyjal week 1', instance: 'Hyjal Summit', starts_at: inDays(2), size: 20, sr_limit: 2, ...body });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.raid;
}

async function lootList(c, instance = 'Hyjal Summit') {
  const res = await c.post('/api/loot/items', { instance, text: 'Rage Winterchill | Frost Greaves | 30871\nAnetheron | Night Cloak\nArchimonde | Tear of the Earth\n\nLoose Trinket' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return Object.fromEntries(res.body.items.map((i) => [i.name, i.id]));
}

// ---------------------------------------------------------------- units

test('start times: ISO with a zone, local time plus offset, and nonsense', () => {
  assert.equal(startFrom({ starts_at: '2026-12-09T18:00:00.000Z' }, 0), '2026-12-09T18:00:00.000Z');
  assert.equal(startFrom({ starts_at: '2026-12-09T20:00:00+02:00' }, 0), '2026-12-09T18:00:00.000Z');
  assert.equal(startFrom({ starts: '2026-12-09T20:00', tz_offset: '-120' }, 0), '2026-12-09T18:00:00.000Z');
  assert.equal(startFrom({ starts_at: '2026-12-09T20:00' }, -120), '2026-12-09T18:00:00.000Z', 'no zone → server default offset');
  assert.equal(startFrom({ starts_at: 'tomorrow' }, 0), null);
  assert.equal(startFrom({ starts_at: '1990-01-01T00:00:00Z' }, 0), null);
  assert.equal(startFrom({}, 0), null);
  assert.equal(utcLabel('2026-12-09T18:05:00.000Z'), 'Wed 9 Dec, 18:05 UTC');
});

test('readiness flags: no data, low repair, no consumables', () => {
  assert.deepEqual(readinessFlags(null), { noData: true, lowRepair: false, noConsumables: false });
  assert.deepEqual(readinessFlags({ ilvl: 60, durability: 25, consumables: {} }), { noData: false, lowRepair: true, noConsumables: true });
  assert.deepEqual(readinessFlags({ ilvl: 60, durability: 30, consumables: { flask: 2 } }), { noData: false, lowRepair: false, noConsumables: false });
  assert.deepEqual(readinessFlags({ ilvl: 60, durability: null, consumables: { potion: 0 } }), { noData: false, lowRepair: false, noConsumables: true });
});

// ---------------------------------------------------------------- scheduling

test('officers schedule raids; Discord post, notification for everyone else, audit and activity', async () => {
  const t = await setup();
  try {
    assert.equal((await t.member.post('/api/raids', { title: 'X', instance: 'Y', starts_at: inDays(1) })).status, 403);
    const bad = await t.officer.post('/api/raids', { title: 'X', instance: '', starts_at: inDays(1) });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, 'Fill in the name, instance and start time.');
    assert.equal((await t.officer.post('/api/raids', { title: 'X', instance: 'Y', starts_at: 'soon' })).status, 400);

    const res = await t.officer.post('/api/raids', {
      kind: 'raid', title: '  Hyjal week 1  ', instance: 'Hyjal Summit', starts: '2026-12-09T20:00', tz_offset: '-120',
      size: 99, sr_limit: 9, duration_min: 150, notes: 'Bring fire resistance',
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.message, 'Raid scheduled and posted to Discord.');
    const raid = res.body.raid;
    assert.equal(raid.title, 'Hyjal week 1');
    assert.equal(raid.starts_at, '2026-12-09T18:00:00.000Z');
    assert.equal(raid.size, 40);
    assert.equal(raid.sr_limit, 5);
    assert.equal(raid.duration_min, 150);
    assert.equal(raid.status, 'open');
    assert.equal(raid.kind, 'raid');
    assert.equal(raid.notes, 'Bring fire resistance');
    assert.equal('guild_id' in raid, false);

    const posts = t.net.webhook();
    assert.equal(posts.length, 1);
    assert.match(posts[0], /^🗓️ \*\*Raid: Hyjal week 1\*\* \(Hyjal Summit\)\n<t:\d+:F>, <t:\d+:R>\nSign up and reserve: http:\/\/127\.0\.0\.1\/raids\/\d+$/);
    // Without the Discord app set up, no scheduled event is created.
    assert.equal(t.net.calls.some((c) => /scheduled-events/.test(c.url)), false);

    const ev = t.events().filter((e) => e.kind === 'raid');
    assert.equal(ev.length, 1);
    assert.equal(ev[0].title, '🗓️ Hyjal week 1');
    assert.equal(ev[0].body, 'Hyjal Summit, Wed 9 Dec, 18:00 UTC. Sign up in Guild Camp.');
    assert.equal(ev[0].route, `/raids/${raid.id}`);
    assert.equal(ev[0].except_user_id, t.s.officer.id);
    const seen = await t.member.get('/api/events?after=0');
    assert.equal(seen.body.events.length, 1);
    assert.equal((await t.officer.get('/api/events?after=0')).body.events.length, 0, 'the scheduler is not notified');

    assert.deepEqual(t.audit().at(-1), { action: 'scheduled raid', detail: 'Hyjal week 1 (2026-12-09T18:00:00.000Z)' });
    assert.ok(t.activity().includes('raid: Officer scheduled Hyjal week 1'));

    // PvP and guild events: no reserves, their own Discord wording.
    const pvp = await t.owner.post('/api/raids', { kind: 'pvp', title: 'Tarren Mill premade', instance: 'Tarren Mill', starts_at: inDays(1), sr_limit: 3 });
    assert.equal(pvp.status, 201);
    assert.equal(pvp.body.raid.sr_limit, 0);
    assert.equal(pvp.body.message, 'PvP scheduled and posted to Discord.');
    assert.match(t.net.webhook()[1], /^⚔️ \*\*PvP: Tarren Mill premade\*\* \(Tarren Mill\)\n.*\nSign up: /s);
    const evt = await t.owner.post('/api/raids', { kind: 'event', title: 'Fishing contest', instance: 'Booty Bay', starts_at: inDays(3) });
    assert.equal(evt.body.raid.kind, 'event');
    assert.match(t.net.webhook()[2], /^🎉 \*\*Event: Fishing contest\*\*/);
    const defaults = await t.owner.post('/api/raids', { title: 'Defaults', instance: 'Molten Core', starts_at: inDays(4), kind: 'nonsense' });
    assert.equal(defaults.body.raid.kind, 'raid');
    assert.equal(defaults.body.raid.sr_limit, 2);
    assert.equal(defaults.body.raid.size, null);
    assert.equal(defaults.body.raid.duration_min, 180);
  } finally { await t.srv.close(); }
});

test('Discord app: scheduled events are created on schedule and removed on cancel, and failures never break the request', async () => {
  const t = await setup({ cfg: { discordBotToken: 'bot-token' } });
  try {
    t.db.prepare("UPDATE guilds SET discord_server_id = 'srv9'").run();
    const raid = await schedule(t.officer, { notes: 'Flasks please' });
    const create = t.net.calls.find((c) => /scheduled-events$/.test(c.url));
    assert.equal(create.url, 'https://discord.com/api/v10/guilds/srv9/scheduled-events');
    assert.equal(create.body.name, 'Hyjal week 1');
    assert.match(create.body.description, /^Flasks please\n\nSign up and reserve loot: http:\/\/127\.0\.0\.1\/raids\/\d+$/);
    assert.equal(t.db.prepare('SELECT discord_event_id FROM raids WHERE id = ?').get(raid.id).discord_event_id, 'ev-77');

    const cancel = await t.officer.post(`/api/raids/${raid.id}/cancel`);
    assert.equal(cancel.status, 200);
    const del = t.net.calls.find((c) => c.method === 'DELETE');
    assert.equal(del.url, 'https://discord.com/api/v10/guilds/srv9/scheduled-events/ev-77');
  } finally { await t.srv.close(); }

  const broken = await setup({ cfg: { discordBotToken: 'bot-token' }, netOptions: { fail: true } });
  try {
    broken.db.prepare("UPDATE guilds SET discord_server_id = 'srv9'").run();
    const res = await broken.officer.post('/api/raids', { title: 'Still works', instance: 'MC', starts_at: inDays(1) });
    assert.equal(res.status, 201);
    assert.equal(res.body.message, 'Raid scheduled.', 'the webhook failed, so it does not claim a Discord post');
    assert.equal(broken.db.prepare('SELECT discord_event_id FROM raids').get().discord_event_id, null);
    assert.equal((await broken.officer.post(`/api/raids/${res.body.raid.id}/cancel`)).status, 200);
  } finally { await broken.srv.close(); }
});

// ---------------------------------------------------------------- list, sign-ups, detail

test('raid list: upcoming and past with role counts, my sign-up and instances', async () => {
  const t = await setup();
  try {
    const a = await schedule(t.officer, { title: 'Soonest', starts_at: inDays(1) });
    const b = await schedule(t.officer, { title: 'Later', starts_at: inDays(5), instance: 'Black Temple' });
    t.db.prepare("INSERT INTO raids (guild_id, title, instance, starts_at, status) VALUES (?, 'Old one', 'Karazhan', ?, 'open')").run(t.s.guildId, inDays(-3));
    t.db.prepare("INSERT INTO raids (guild_id, title, instance, starts_at, status) VALUES (?, 'Closed early', 'Karazhan', ?, 'done')").run(t.s.guildId, inDays(1));
    await lootList(t.owner, 'Serpentshrine Cavern');

    await t.member.post(`/api/raids/${a.id}/signup`, { character: 'Mokra', role: 'healer', status: 'yes' });
    await t.officer.post(`/api/raids/${a.id}/signup`, { character: 'Velanne', role: 'tank', status: 'yes' });
    await t.owner.post(`/api/raids/${a.id}/signup`, { character: 'Grim', role: 'dps', status: 'tentative' });

    const res = await t.member.get('/api/raids');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.upcoming.map((r) => r.title), ['Soonest', 'Later']);
    assert.deepEqual(res.body.past.map((r) => r.title), ['Closed early', 'Old one']);
    const first = res.body.upcoming[0];
    assert.deepEqual(first.counts, { tank: 1, healer: 1, dps: 0, tentative: 1, bench: 0, no: 0 });
    assert.deepEqual(first.mySignup, { status: 'yes', role: 'healer', character: 'Mokra' });
    assert.equal(first.myReserves, 0);
    assert.equal(res.body.upcoming[1].mySignup, null);
    assert.deepEqual(res.body.upcoming[1].counts, { tank: 0, healer: 0, dps: 0, tentative: 0, bench: 0, no: 0 });
    assert.deepEqual(res.body.instances, ['Black Temple', 'Hyjal Summit', 'Karazhan', 'Serpentshrine Cavern']);
    assert.equal(b.id > a.id, true);

    const outsider = addUser(t.db, 'Nobody#9');
    assert.equal((await client(t.srv.url, outsider.token).get('/api/raids')).status, 403);
    assert.equal((await t.member.get('/api/raids/99999')).status, 404);
    assert.equal((await t.member.get('/api/raids/abc')).status, 404);
  } finally { await t.srv.close(); }
});

test('sign-ups: validation, statuses incl. bench, closed raids and the activity line', async () => {
  const t = await setup();
  try {
    const raid = await schedule(t.officer);
    const url = `/api/raids/${raid.id}/signup`;
    const none = await t.member.post(url, { character: '  ', role: 'tank' });
    assert.equal(none.status, 400);
    assert.equal(none.body.error, 'Pick a character.');

    const first = await t.member.post(url, { character: 'Mokra', role: 'healer', status: 'yes', note: 'Might be 15 min late' });
    assert.equal(first.status, 200);
    assert.equal(first.body.message, 'You’re signed up.');
    assert.equal(first.body.signup.role, 'healer');
    assert.equal(first.body.signup.note, 'Might be 15 min late');
    assert.deepEqual(first.body.counts, { tank: 0, healer: 1, dps: 0, tentative: 0, bench: 0, no: 0 });

    const bench = await t.member.post(url, { character: 'Mokra', role: 'wizard', status: 'bench' });
    assert.equal(bench.body.message, 'Sign-up updated.');
    assert.equal(bench.body.signup.role, 'dps', 'unknown roles fall back to damage');
    assert.equal(bench.body.signup.status, 'bench');
    const no = await t.member.post(url, { character: 'Mokra', role: 'dps', status: 'no' });
    assert.equal(no.body.message, 'Marked as can’t make it.');
    assert.equal(t.activity().filter((a) => a.includes('signed up for')).length, 1, 'only the first "yes" makes an activity line');

    await t.officer.post(`/api/raids/${raid.id}/cancel`);
    const closed = await t.member.post(url, { character: 'Mokra', status: 'yes' });
    assert.equal(closed.status, 409);
    assert.equal(closed.body.error, 'Sign-ups are closed for this raid.');
  } finally { await t.srv.close(); }
});

test('raid detail: roster with readiness flags, my characters, loot list with my bonus, reserve board', async () => {
  const t = await setup();
  try {
    const items = await lootList(t.owner);
    const raid = await schedule(t.officer, { sr_limit: 1 });
    t.char(t.s.member.id, 'Mokra', 'SHAMAN', { ilvl: 58.2, durability: 22, consumables: {}, at: 1700000000 }, 1);
    t.char(t.s.member.id, 'Mokralt', 'MAGE');
    t.char(t.s.officer.id, 'Velanne', 'PRIEST', { ilvl: 63, durability: 90, consumables: { flask: 2, potion: 5 }, at: 1700000000 });
    await t.member.post(`/api/raids/${raid.id}/signup`, { character: 'Mokra', role: 'healer', status: 'yes', note: 'Late' });
    await t.officer.post(`/api/raids/${raid.id}/signup`, { character: 'Velanne', role: 'tank', status: 'yes' });
    await t.owner.post(`/api/raids/${raid.id}/signup`, { character: 'Grim', role: 'dps', status: 'no' });
    await t.member.post(`/api/raids/${raid.id}/reserves`, { item_ids: [items['Night Cloak']] });
    await t.officer.post(`/api/raids/${raid.id}/reserves`, { item_ids: [items['Night Cloak']] });
    t.db.prepare('INSERT INTO loyalty (guild_id, user_id, item_id, bonus) VALUES (?,?,?,20)').run(t.s.guildId, t.s.member.id, items['Night Cloak']);

    const res = await t.member.get(`/api/raids/${raid.id}`);
    assert.equal(res.status, 200);
    const d = res.body;
    assert.equal(d.raid.scheduledBy, 'Officer');
    assert.deepEqual(d.signups.map((s) => [s.character, s.role, s.status]), [['Velanne', 'tank', 'yes'], ['Mokra', 'healer', 'yes'], ['Grim', 'dps', 'no']]);
    const mokra = d.signups.find((s) => s.character === 'Mokra');
    assert.equal(mokra.class, 'SHAMAN');
    assert.equal(mokra.readiness.ilvl, 58.2);
    assert.deepEqual(mokra.flags, { noData: false, lowRepair: true, noConsumables: true });
    assert.equal(mokra.mine, true);
    assert.deepEqual(d.signups.find((s) => s.character === 'Velanne').flags, { noData: false, lowRepair: false, noConsumables: false });
    assert.deepEqual(d.signups.find((s) => s.character === 'Grim').flags, { noData: true, lowRepair: false, noConsumables: false });
    assert.deepEqual(d.counts, { tank: 1, healer: 1, dps: 0, tentative: 0, bench: 0, no: 1 });
    assert.equal(d.mySignup.character, 'Mokra');
    assert.deepEqual(d.myCharacters.map((c) => c.name), ['Mokra', 'Mokralt']);

    assert.equal(d.items.length, 4);
    const cloak = d.items.find((i) => i.name === 'Night Cloak');
    assert.deepEqual([cloak.boss, cloak.bonus, cloak.reserved, cloak.mine], ['Anetheron', 20, 2, true]);
    assert.equal(d.items.find((i) => i.name === 'Frost Greaves').wh_id, 30871);
    assert.deepEqual(d.myReserves.map((r) => [r.name, r.bonus]), [['Night Cloak', 20]]);
    assert.equal(d.board.length, 1);
    assert.equal(d.board[0].item, 'Night Cloak');
    assert.deepEqual(d.board[0].reservers.map((r) => [r.character, r.bonus, r.inRaid]), [['Mokra', 20, true], ['Velanne', 0, true]]);
    assert.equal(d.canSignUp, true);
    assert.equal(d.canReserve, true);
    assert.equal(d.isOfficer, false);
    assert.deepEqual(d.loot, []);
    assert.deepEqual(d.attended, []);
  } finally { await t.srv.close(); }
});

// ---------------------------------------------------------------- reserves

test('reserves: limit, unknown items, clearing, locking and non-raid events', async () => {
  const t = await setup();
  try {
    const items = await lootList(t.owner);
    const raid = await schedule(t.officer, { sr_limit: 1 });
    const url = `/api/raids/${raid.id}/reserves`;
    const tooMany = await t.member.post(url, { item_ids: [items['Frost Greaves'], items['Night Cloak']] });
    assert.equal(tooMany.status, 400);
    assert.equal(tooMany.body.error, 'You can reserve up to 1 item.');
    const unknown = await t.member.post(url, { item_ids: [999999] });
    assert.equal(unknown.status, 400);
    assert.match(unknown.body.error, /isn’t on this raid’s loot list/);
    const ok = await t.member.post(url, { item_ids: [items['Frost Greaves']] });
    assert.equal(ok.body.message, 'Reserves saved.');
    assert.deepEqual(ok.body.myReserves.map((r) => r.name), ['Frost Greaves']);
    const cleared = await t.member.post(url, { item_ids: [] });
    assert.equal(cleared.body.message, 'Reserves cleared.');
    assert.deepEqual(cleared.body.myReserves, []);
    await t.member.post(url, { item_ids: [items['Frost Greaves']] });

    assert.equal((await t.member.post(`/api/raids/${raid.id}/lock`)).status, 403);
    const lock = await t.officer.post(`/api/raids/${raid.id}/lock`);
    assert.equal(lock.status, 200);
    assert.equal(lock.body.message, 'Reserves locked.');
    assert.equal(lock.body.raid.status, 'locked');
    const locked = await t.member.post(url, { item_ids: [] });
    assert.equal(locked.status, 409);
    assert.equal(locked.body.error, 'Reserves are locked for this raid.');
    assert.equal((await t.member.get(`/api/raids/${raid.id}`)).body.canReserve, false);
    // Sign-ups still work while reserves are locked.
    assert.equal((await t.member.post(`/api/raids/${raid.id}/signup`, { character: 'Mokra' })).status, 200);
    assert.equal((await t.officer.post(`/api/raids/${raid.id}/lock`)).status, 409);
    const unlock = await t.officer.post(`/api/raids/${raid.id}/unlock`);
    assert.equal(unlock.body.message, 'Reserves reopened.');
    assert.equal((await t.officer.post(`/api/raids/${raid.id}/unlock`)).status, 409);
    assert.deepEqual(t.audit().filter((a) => a.action.startsWith('raid ')).map((a) => a.action), ['raid locked', 'raid reopened']);

    const pvp = await schedule(t.officer, { kind: 'pvp', instance: 'Hyjal Summit' });
    const pvpRes = await t.member.post(`/api/raids/${pvp.id}/reserves`, { item_ids: [items['Frost Greaves']] });
    assert.equal(pvpRes.status, 400);
    assert.equal((await t.member.get(`/api/raids/${pvp.id}`)).body.canReserve, false);
  } finally { await t.srv.close(); }
});

// ---------------------------------------------------------------- cancel

test('cancel: only upcoming raids, signed-up members are told, Discord gets a post', async () => {
  const t = await setup();
  try {
    const raid = await schedule(t.officer);
    await t.member.post(`/api/raids/${raid.id}/signup`, { character: 'Mokra', status: 'yes' });
    await t.owner.post(`/api/raids/${raid.id}/signup`, { character: 'Grim', status: 'no' });
    await t.officer.post(`/api/raids/${raid.id}/signup`, { character: 'Velanne', status: 'tentative' });
    const before = t.events().length;
    assert.equal((await t.member.post(`/api/raids/${raid.id}/cancel`)).status, 403);
    const res = await t.officer.post(`/api/raids/${raid.id}/cancel`);
    assert.equal(res.status, 200);
    assert.equal(res.body.message, 'Raid cancelled.');
    assert.equal(res.body.raid.status, 'cancelled');
    const ev = t.events().slice(before);
    assert.deepEqual(ev.map((e) => [e.kind, e.title, e.user_id, e.route]), [['raid', '❌ Hyjal week 1 is cancelled', t.s.member.id, `/raids/${raid.id}`]],
      'only signed-up people (not "can’t make it", not the officer who cancelled) are told');
    assert.match(t.net.webhook().at(-1), /^❌ \*\*Hyjal week 1\*\* on <t:\d+:F> is cancelled\.$/);
    assert.deepEqual(t.audit().at(-1), { action: 'raid cancelled', detail: 'Hyjal week 1' });
    const again = await t.officer.post(`/api/raids/${raid.id}/cancel`);
    assert.equal(again.status, 409);
    assert.equal(again.body.error, 'Only upcoming raids can be cancelled.');
    const close = await t.officer.post(`/api/raids/${raid.id}/close`, { attendee_user_ids: [] });
    assert.equal(close.status, 409);
    assert.equal(close.body.error, 'Cancelled raids can’t be closed.');
    const list = await t.member.get('/api/raids');
    assert.equal(list.body.upcoming[0].status, 'cancelled', 'cancelled raids stay in the list so people see it');

    const evt = await schedule(t.officer, { kind: 'event', title: 'Fishing' });
    assert.equal((await t.officer.post(`/api/raids/${evt.id}/cancel`)).body.message, 'Event cancelled.');
  } finally { await t.srv.close(); }
});

// ---------------------------------------------------------------- SR+ through the loot screen

test('SR+ end to end: rolls with bonus, awards reset the winner, closing grows the rest and resets no-shows', async () => {
  const t = await setup();
  try {
    const items = await lootList(t.owner);
    const greaves = items['Frost Greaves'];
    const cloak = items['Night Cloak'];
    const extra = addUser(t.db, 'Charlie#3', { guildId: t.s.guildId });
    const charlie = client(t.srv.url, extra.token);

    // Week 1: member and officer reserve greaves, Charlie the cloak. Charlie signs up "yes" but doesn't come.
    const w1 = await schedule(t.officer, { title: 'Week 1' });
    for (const [c, name] of [[t.member, 'Mokra'], [t.officer, 'Velanne'], [charlie, 'Charlie']]) {
      await c.post(`/api/raids/${w1.id}/signup`, { character: name, role: 'dps', status: 'yes' });
    }
    await t.member.post(`/api/raids/${w1.id}/reserves`, { item_ids: [greaves] });
    await t.officer.post(`/api/raids/${w1.id}/reserves`, { item_ids: [greaves] });
    await charlie.post(`/api/raids/${w1.id}/reserves`, { item_ids: [cloak] });
    t.db.prepare('INSERT INTO loyalty (guild_id, user_id, item_id, bonus) VALUES (?,?,?,30)').run(t.s.guildId, extra.id, cloak);

    assert.equal((await t.member.post(`/api/raids/${w1.id}/close`, { attendee_user_ids: [t.s.member.id] })).status, 403);
    const closed = await t.officer.post(`/api/raids/${w1.id}/close`, { attendee_user_ids: [t.s.member.id, t.s.officer.id, 0, -4, 'x', 987654] });
    assert.equal(closed.status, 200);
    assert.equal(closed.body.message, 'Raid closed. 2 attended, 1 no-show. Bonuses updated.');
    assert.equal(closed.body.raid.status, 'done');
    const bonus = (uid, item) => (t.db.prepare('SELECT bonus FROM loyalty WHERE user_id = ? AND item_id = ?').get(uid, item) || { bonus: 0 }).bonus;
    assert.equal(bonus(t.s.member.id, greaves), 10);
    assert.equal(bonus(t.s.officer.id, greaves), 10);
    assert.equal(bonus(extra.id, cloak), 0, 'no-show resets the bonus');
    assert.deepEqual(t.audit().at(-1), { action: 'raid closed', detail: 'Week 1: 2 attended, 1 no-shows' });
    assert.ok(t.activity().includes('raid: Week 1 finished with 2 raiders'));
    assert.equal((await t.officer.post(`/api/raids/${w1.id}/close`, { attendee_user_ids: [] })).status, 409);
    assert.deepEqual((await t.member.get(`/api/raids/${w1.id}`)).body.attended.sort(), [t.s.member.id, t.s.officer.id].sort());

    // Week 2: greaves drops. Only reservers in the raid roll; the bonus is added.
    const w2 = await schedule(t.officer, { title: 'Week 2' });
    await t.member.post(`/api/raids/${w2.id}/signup`, { character: 'Mokra', status: 'yes' });
    await t.officer.post(`/api/raids/${w2.id}/signup`, { character: 'Velanne', status: 'bench' });
    await charlie.post(`/api/raids/${w2.id}/signup`, { character: 'Charlie', status: 'tentative' });
    for (const c of [t.member, t.officer, charlie]) await c.post(`/api/raids/${w2.id}/reserves`, { item_ids: [greaves] });

    assert.equal((await t.member.get(`/api/raids/${w2.id}/loot`)).status, 403, 'members cannot open the loot screen');
    const screen = await t.officer.get(`/api/raids/${w2.id}/loot`);
    assert.equal(screen.status, 200);
    assert.equal(screen.body.board.length, 1);
    assert.deepEqual(screen.body.board[0].reservers.map((r) => [r.character, r.bonus, r.inRaid]).sort(),
      [['Charlie', 0, false], ['Mokra', 10, true], ['Velanne', 10, true]]);
    assert.deepEqual(screen.body.board[0].rolls, []);
    assert.deepEqual(screen.body.attending.map((a) => a.character), ['Mokra', 'Velanne']);
    assert.equal(screen.body.items.length, 4);

    assert.equal((await t.officer.post(`/api/raids/${w2.id}/roll`, { item_id: 0 })).status, 404);
    const roll = await t.officer.post(`/api/raids/${w2.id}/roll`, { item_id: greaves });
    assert.equal(roll.status, 200);
    assert.deepEqual(roll.body.rolls.map((r) => r.character).sort(), ['Mokra', 'Velanne']);
    for (const r of roll.body.rolls) {
      assert.ok(r.roll >= 1 && r.roll <= 100);
      assert.equal(r.bonus, 10);
      assert.equal(r.total, r.roll + 10);
    }
    assert.match(roll.body.message, /has the highest roll for Frost Greaves/);
    const again = await t.officer.get(`/api/raids/${w2.id}/loot`);
    assert.equal(again.body.board[0].rolls.length, 2);

    // Give it to the member (a reserve win): bonus resets, reserve fulfilled, rolls cleared.
    const award = await t.officer.post(`/api/raids/${w2.id}/award`, { item_id: greaves, user_id: t.s.member.id, kind: 'sr' });
    assert.equal(award.status, 200);
    assert.equal(award.body.message, 'Frost Greaves given to Mokra.');
    assert.equal(award.body.award.character, 'Mokra');
    assert.equal(award.body.award.kind, 'sr');
    assert.equal(award.body.award.wh_id, 30871);
    assert.equal(award.body.award.bonus, 10);
    assert.equal(bonus(t.s.member.id, greaves), 0);
    assert.match(t.net.webhook().at(-1), /^💎 \*\*Frost Greaves\*\* → Mokra \(SR, Week 2\)$/);
    assert.deepEqual(t.audit().at(-1), { action: 'loot given', detail: 'Frost Greaves → Mokra (sr)' });
    assert.ok(t.activity().includes('loot: Mokra received Frost Greaves'));
    assert.equal(t.events().filter((e) => e.title.includes('Frost Greaves')).length, 0, 'loot awards send no notification');

    // Off-reserve loot: by name (matched to the list when it can be), to a member or a typed-in character.
    const os = await t.officer.post(`/api/raids/${w2.id}/award`, { item_name: 'random ring', user_id: t.s.officer.id, kind: 'os' });
    assert.equal(os.body.award.item_name, 'random ring');
    assert.equal(os.body.award.character, 'Velanne');
    const matched = await t.officer.post(`/api/raids/${w2.id}/award`, { item_name: 'loose trinket', character: 'Pugsy', kind: 'free' });
    assert.equal(matched.body.award.item_name, 'Loose Trinket');
    assert.equal(matched.body.award.item_id, items['Loose Trinket']);
    assert.equal(matched.body.award.character, 'Pugsy');
    assert.equal(matched.body.award.user_id, null);
    const byChar = await t.officer.post(`/api/raids/${w2.id}/award`, { item_name: 'Night Cloak', character: 'mokra', kind: 'ms' });
    assert.equal(byChar.body.award.user_id, t.s.member.id, 'a sign-up name finds the member');
    assert.equal(byChar.body.award.character, 'Mokra');
    assert.equal((await t.officer.post(`/api/raids/${w2.id}/award`, { item_name: 'X' })).body.error, 'Pick who gets it.');
    assert.equal((await t.officer.post(`/api/raids/${w2.id}/award`, { user_id: t.s.member.id })).body.error, 'Pick an item.');
    const outsider = addUser(t.db, 'Outsider#1');
    assert.equal((await t.officer.post(`/api/raids/${w2.id}/award`, { item_name: 'X', user_id: outsider.id })).status, 400);
    assert.equal((await t.member.post(`/api/raids/${w2.id}/award`, { item_name: 'X', user_id: t.s.member.id })).status, 403);

    const after = await t.officer.get(`/api/raids/${w2.id}/loot`);
    assert.deepEqual(after.body.awarded.map((a) => a.item_name), ['Night Cloak', 'Loose Trinket', 'random ring', 'Frost Greaves']);
    assert.deepEqual(after.body.board[0].reservers.map((r) => r.character).sort(), ['Charlie', 'Velanne'], 'the winner’s reserve is fulfilled');

    // Closing week 2: the officer (bench, attended, still reserving greaves) grows to 20.
    await t.officer.post(`/api/raids/${w2.id}/close`, { attendee_user_ids: [t.s.member.id, t.s.officer.id] });
    assert.equal(bonus(t.s.officer.id, greaves), 20);
    assert.equal(bonus(t.s.member.id, greaves), 0);

    // Loot page: history and my bonuses.
    const loot = await t.officer.get('/api/loot');
    assert.equal(loot.body.history.length, 4);
    assert.equal(loot.body.history[0].title, 'Week 2');
    assert.deepEqual(loot.body.myLoyalty.map((l) => [l.name, l.bonus]), [['Frost Greaves', 20]]);
    // Awards stay possible after the raid closed (someone forgot to record one), not after a cancel.
    assert.equal((await t.officer.post(`/api/raids/${w2.id}/award`, { item_name: 'Late find', user_id: t.s.member.id })).status, 200);
  } finally { await t.srv.close(); }
});

test('closing a PvP premade or guild event records attendance but leaves SR+ loyalty for that instance alone', async () => {
  const t = await setup();
  try {
    const items = await lootList(t.owner);
    const greaves = items['Frost Greaves'];
    const cloak = items['Night Cloak'];
    const bonus = (uid, item) => (t.db.prepare('SELECT bonus FROM loyalty WHERE user_id = ? AND item_id = ?').get(uid, item) || { bonus: 0 }).bonus;
    // Earned in earlier Hyjal raids.
    t.db.prepare('INSERT INTO loyalty (guild_id, user_id, item_id, bonus) VALUES (?,?,?,30)').run(t.s.guildId, t.s.member.id, greaves);
    t.db.prepare('INSERT INTO loyalty (guild_id, user_id, item_id, bonus) VALUES (?,?,?,20)').run(t.s.guildId, t.s.officer.id, cloak);

    // A PvP premade at the same place: the member comes, the officer signs up "yes" and doesn't show.
    const pvp = await schedule(t.officer, { kind: 'pvp', title: 'Hyjal brawl', instance: 'Hyjal Summit' });
    await t.member.post(`/api/raids/${pvp.id}/signup`, { character: 'Mokra', role: 'dps', status: 'yes' });
    await t.officer.post(`/api/raids/${pvp.id}/signup`, { character: 'Velanne', role: 'healer', status: 'yes' });
    const closedPvp = await t.officer.post(`/api/raids/${pvp.id}/close`, { attendee_user_ids: [t.s.member.id] });
    assert.equal(closedPvp.status, 200, JSON.stringify(closedPvp.body));
    assert.equal(closedPvp.body.message, 'PvP closed. 1 attended, 1 no-show.');
    assert.equal(closedPvp.body.raid.status, 'done');
    assert.equal(closedPvp.body.attended, 1);
    assert.equal(closedPvp.body.noShows, 1);
    assert.deepEqual((await t.member.get(`/api/raids/${pvp.id}`)).body.attended, [t.s.member.id]);
    assert.equal(bonus(t.s.member.id, greaves), 30, 'attending without a reserve does not end the streak');
    assert.equal(bonus(t.s.officer.id, cloak), 20, 'a no-show at a PvP premade does not reset the bonus');
    assert.deepEqual(t.audit().at(-1), { action: 'raid closed', detail: 'Hyjal brawl: 1 attended, 1 no-shows' });

    // A guild event there: same.
    const evt = await schedule(t.officer, { kind: 'event', title: 'Hyjal sightseeing', instance: 'Hyjal Summit' });
    await t.officer.post(`/api/raids/${evt.id}/signup`, { character: 'Velanne', status: 'yes' });
    const closedEvt = await t.officer.post(`/api/raids/${evt.id}/close`, { attendee_user_ids: [t.s.member.id, t.s.officer.id] });
    assert.equal(closedEvt.body.message, 'Event closed. 2 attended.');
    assert.equal(bonus(t.s.member.id, greaves), 30);
    assert.equal(bonus(t.s.officer.id, cloak), 20);
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM loyalty').get().n, 2, 'no loyalty rows added or removed');
  } finally { await t.srv.close(); }
});

// ---------------------------------------------------------------- loot lists

test('loot lists: officers paste and remove items; everyone reads lists and history', async () => {
  const t = await setup();
  try {
    assert.equal((await t.member.post('/api/loot/items', { instance: 'MC', text: 'Lucifron | Boots' })).status, 403);
    assert.equal((await t.officer.post('/api/loot/items', { instance: '', text: 'x' })).body.error, 'Name the instance.');
    assert.equal((await t.officer.post('/api/loot/items', { instance: 'MC', text: '  ' })).status, 400);

    const res = await t.officer.post('/api/loot/items', { instance: 'Molten Core', text: 'Lucifron | Felheart Gloves | https://www.wowhead.com/classic/item=16805\nMagmadar | Striker\'s Mark | 17069\nCore Leather' });
    assert.equal(res.status, 200);
    assert.equal(res.body.added, 3);
    assert.equal(res.body.message, '3 items added to Molten Core.');
    assert.deepEqual(res.body.items.map((i) => [i.boss, i.name, i.item_id]), [[null, 'Core Leather', null], ['Lucifron', 'Felheart Gloves', 16805], ['Magmadar', 'Striker\'s Mark', 17069]]);
    // The old form field name ("items") still works; repeats only update.
    const again = await t.officer.post('/api/loot/items', { instance: 'Molten Core', items: 'Lucifron | Core Leather\nRagnaros | Sulfuras' });
    assert.equal(again.body.added, 1);
    assert.equal(again.body.message, '1 item added to Molten Core.');
    assert.equal(again.body.items.find((i) => i.name === 'Core Leather').boss, 'Lucifron');
    await t.officer.post('/api/loot/items', { instance: 'Blackwing Lair', text: 'Razorgore | Arcane Infused Gem' });
    assert.deepEqual(t.audit().filter((a) => a.action === 'loot list items added').map((a) => a.detail), ['3 to Molten Core', '1 to Molten Core', '1 to Blackwing Lair']);

    const loot = await t.member.get('/api/loot');
    assert.equal(loot.status, 200);
    assert.deepEqual(loot.body.lists.map((l) => [l.instance, l.items.length]), [['Blackwing Lair', 1], ['Molten Core', 4]]);
    assert.equal(loot.body.lists[1].items.find((i) => i.name === 'Felheart Gloves').wh_id, 16805);
    assert.deepEqual(loot.body.history, []);
    assert.deepEqual(loot.body.myLoyalty, []);

    const gloves = loot.body.lists[1].items.find((i) => i.name === 'Felheart Gloves');
    assert.equal((await t.member.del(`/api/loot/items/${gloves.id}`)).status, 403);
    const del = await t.officer.del(`/api/loot/items/${gloves.id}`);
    assert.equal(del.status, 200);
    assert.equal(del.body.message, 'Felheart Gloves removed.');
    assert.deepEqual(t.audit().at(-1), { action: 'loot list item removed', detail: 'Felheart Gloves (Molten Core)' });
    assert.equal((await t.officer.del(`/api/loot/items/${gloves.id}`)).status, 404);
    assert.equal((await t.officer.del('/api/loot/items/abc')).status, 404);
  } finally { await t.srv.close(); }
});

// ---------------------------------------------------------------- reminders, timers, links

test('one-hour reminder: once per raid, app notification for the people signed up, Discord post', async () => {
  const t = await setup();
  try {
    const soon = await schedule(t.officer, { title: 'Soon', starts_at: new Date(Date.now() + 30 * 60000).toISOString() });
    await schedule(t.officer, { title: 'Later', starts_at: inDays(1) });
    await t.member.post(`/api/raids/${soon.id}/signup`, { character: 'Mokra', role: 'tank', status: 'yes' });
    await t.owner.post(`/api/raids/${soon.id}/signup`, { character: 'Grim', role: 'dps', status: 'no' });
    await t.officer.post(`/api/raids/${soon.id}/signup`, { character: 'Velanne', role: 'healer', status: 'tentative' });
    const before = t.events().length;
    const posts = t.net.webhook().length;

    assert.equal(await t.srv.ctx.services.raids.remind(), 1);
    assert.equal(await t.srv.ctx.services.raids.remind(), 0);
    const ev = t.events().slice(before);
    assert.deepEqual(ev.map((e) => [e.kind, e.title, e.user_id, e.route]).sort((a, b) => a[2] - b[2]), [
      ['raid', '⏰ Soon starts in an hour', t.s.officer.id, `/raids/${soon.id}`],
      ['raid', '⏰ Soon starts in an hour', t.s.member.id, `/raids/${soon.id}`],
    ].sort((a, b) => a[2] - b[2]));
    assert.equal(t.net.webhook().length, posts + 1);
    assert.match(t.net.webhook().at(-1), /^⏰ \*\*Soon\*\* starts <t:\d+:R>\. 1 tank, 0 healers, 0 damage signed up\.\nhttp:\/\/127\.0\.0\.1\/raids\/\d+$/);
    const owner = await t.owner.get('/api/events?after=0');
    assert.equal(owner.body.events.some((e) => e.title.startsWith('⏰')), false, '"can’t make it" gets no reminder');
  } finally { await t.srv.close(); }
});

test('the reminder loop only runs when timers are on', async () => {
  const off = await startServer({ routes: ['raids'] });
  try { assert.equal(off.ctx.timers.length, 0); } finally { await off.close(); }
  const on = await startServer({ routes: ['raids'], timers: true });
  try { assert.equal(on.ctx.timers.length, 1); } finally { await on.close(); }
  assert.equal(on.ctx.timers.length, 0, 'close() clears it');
});

test('Discord raid links open a small page that points at the app', async () => {
  const t = await setup();
  try {
    const page = await client(t.srv.url).get('/raids/12');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.match(page.body, /guildcamp:\/\/raids\/12/);
    assert.match(page.body, /href="\/get"/);
    assert.equal((await client(t.srv.url).get('/raids/x%22y')).status, 404);
  } finally { await t.srv.close(); }
});
