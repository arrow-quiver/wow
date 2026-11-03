// Phase 2: raids, sign-ups, soft reserves with loyalty bonus, loot screen.
const test = require('node:test');
const assert = require('node:assert');
const dbm = require('../src/db');
const R = require('../src/raids');
const { createApp, config } = require('../src/server');
const { toUtc } = require('../src/routes/raids');
const { applyPayload, buildInbox, toLua } = require('../src/sync');
const { WowClient } = require('./wowsim');
const { parseSavedVariables } = require('../../companion/lua');

function setup() {
  const db = dbm.open(':memory:');
  const user = (bt) => db.prepare('INSERT INTO users (bnet_id, battletag) VALUES (?,?)').run('dev:' + bt, bt).lastInsertRowid;
  const [a, b, c] = [user('Alpha#1'), user('Bravo#2'), user('Charlie#3')];
  const g = db.prepare("INSERT INTO guilds (name, invite_code) VALUES ('wow','x')").run().lastInsertRowid;
  db.prepare("INSERT INTO memberships (user_id, guild_id, role) VALUES (?,?,'owner'),(?,?,'member'),(?,?,'member')").run(a, g, b, g, c, g);
  R.importItems(db, g, 'Hyjal Summit', 'Rage Winterchill | Frost Greaves\nAnetheron | Night Cloak\nArchimonde | Tear of the Earth\n\nLoose Trinket');
  const items = Object.fromEntries(R.itemsForInstance(db, g, 'Hyjal Summit').map((i) => [i.name, i.id]));
  const raid = (n) => {
    const id = db.prepare("INSERT INTO raids (guild_id, title, instance, starts_at, sr_limit) VALUES (?,?, 'Hyjal Summit', ?, 2)").run(g, `Week ${n}`, new Date(Date.now() + n * 86400000).toISOString()).lastInsertRowid;
    return R.raidFor(db, g, id);
  };
  const signup = (r, uid, ch, status = 'yes') => db.prepare("INSERT INTO signups (raid_id, user_id, character, role, status) VALUES (?,?,?, 'dps', ?)").run(r.id, uid, ch, status);
  return { db, g, a, b, c, items, raid, signup };
}

test('loot list import handles "Boss | Item" and plain lines', () => {
  const { items } = setup();
  assert.deepStrictEqual(Object.keys(items).sort(), ['Frost Greaves', 'Loose Trinket', 'Night Cloak', 'Tear of the Earth']);
});

test('reserve limit, locking and unknown items are enforced', () => {
  const { db, a, items, raid } = setup();
  const r = raid(1);
  R.setReserves(db, r, a, [items['Frost Greaves'], items['Night Cloak']]);
  assert.throws(() => R.setReserves(db, r, a, [items['Frost Greaves'], items['Night Cloak'], items['Tear of the Earth']]), /up to 2/);
  assert.throws(() => R.setReserves(db, r, a, [99999]), /isn’t on this raid’s loot list/);
  db.prepare("UPDATE raids SET status = 'locked' WHERE id = ?").run(r.id);
  assert.throws(() => R.setReserves(db, R.raidFor(db, r.guild_id, r.id), a, []), /locked/);
  assert.strictEqual(R.myReserves(db, r, a).length, 2);
});

test('SR+ bonus grows each attended raid, resets on win, switch and no-show', () => {
  const { db, g, a, b, c, items, raid, signup } = setup();
  const greaves = items['Frost Greaves'];
  const cloak = items['Night Cloak'];
  // Week 1: A and B reserve greaves, C reserves cloak. Everyone attends except C (signed yes).
  const w1 = raid(1);
  for (const [u, ch] of [[a, 'Alpha'], [b, 'Bravo'], [c, 'Charlie']]) signup(w1, u, ch);
  R.setReserves(db, w1, a, [greaves]); R.setReserves(db, w1, b, [greaves]); R.setReserves(db, w1, c, [cloak]);
  R.closeRaid(db, w1, [a, b]);
  assert.strictEqual(R.bonusOf(db, g, a, greaves), 10);
  assert.strictEqual(R.bonusOf(db, g, b, greaves), 10);
  assert.strictEqual(R.bonusOf(db, g, c, cloak), 0, 'no-show gets no bonus');
  assert.throws(() => R.closeRaid(db, R.raidFor(db, g, w1.id), [a]), /already closed/);

  // Week 2: same reserves; greaves drops, rolls include bonus, A wins.
  const w2 = raid(2);
  for (const [u, ch] of [[a, 'Alpha'], [b, 'Bravo']]) signup(w2, u, ch);
  R.setReserves(db, w2, a, [greaves]); R.setReserves(db, w2, b, [greaves]);
  const seq = [0.5, 0.2]; // A rolls 51, B rolls 21
  const rolls = R.rollItem(db, w2, greaves, () => seq.shift());
  assert.deepStrictEqual(rolls.map((r) => [r.character, r.roll, r.bonus, r.total]), [['Alpha', 51, 10, 61], ['Bravo', 21, 10, 31]]);
  R.awardItem(db, w2, { itemId: greaves, userId: a, character: 'Alpha', kind: 'sr' });
  R.closeRaid(db, w2, [a, b]);
  assert.strictEqual(R.bonusOf(db, g, a, greaves), 0, 'winner resets');
  assert.strictEqual(R.bonusOf(db, g, b, greaves), 20, 'loser keeps growing');
  const log = db.prepare('SELECT item_name, character, kind, roll, bonus FROM loot_log').all();
  assert.deepStrictEqual(log, [{ item_name: 'Frost Greaves', character: 'Alpha', kind: 'sr', roll: 51, bonus: 10 }]);

  // Week 3: B attends but switches to the cloak → greaves streak ends.
  const w3 = raid(3);
  signup(w3, b, 'Bravo');
  R.setReserves(db, w3, b, [cloak]);
  R.closeRaid(db, w3, [b]);
  assert.strictEqual(R.bonusOf(db, g, b, greaves), 0);
  assert.strictEqual(R.bonusOf(db, g, b, cloak), 10);
});

test('people not in the raid are left out of rolls', () => {
  const { db, a, b, items, raid, signup } = setup();
  const r = raid(1);
  signup(r, a, 'Alpha'); signup(r, b, 'Bravo', 'tentative');
  R.setReserves(db, r, a, [items['Night Cloak']]); R.setReserves(db, r, b, [items['Night Cloak']]);
  assert.deepStrictEqual(R.rollItem(db, r, items['Night Cloak']).map((x) => x.character), ['Alpha']);
});

test('local start time converts to UTC using the browser offset', () => {
  assert.strictEqual(toUtc('2026-12-09T20:00', '-120', 0), '2026-12-09T18:00:00.000Z');
  assert.strictEqual(toUtc('2026-12-09T20:00', '', -120), '2026-12-09T18:00:00.000Z');
  assert.strictEqual(toUtc('nonsense', '0', 0), null);
});

test('addon readiness reaches the sign-up list, raids reach the addon', () => {
  const { db, g, a, raid, signup, items } = setup();
  const wow = new WowClient();
  wow.fire('ADDON_LOADED', 'WowGuild');
  wow.fire('PLAYER_LOGIN');
  wow.fire('PLAYER_LOGOUT');
  const sv = parseSavedVariables(wow.saveVariables()).WowGuildDB;
  assert.deepStrictEqual(sv.characters.Thrallia.readiness.consumables, { potion: 5, bandage: 10 });
  assert.strictEqual(sv.characters.Thrallia.readiness.durability, 50);
  applyPayload(db, g, a, sv);
  const r = raid(1);
  signup(r, a, 'Thrallia');
  R.setReserves(db, r, a, [items['Night Cloak']]);
  const s = R.signupsFor(db, r)[0];
  assert.strictEqual(s.ready.ilvl, 58.2);
  const inbox = buildInbox(db, g, a);
  assert.strictEqual(inbox.raids[0].title, 'Week 1');
  assert.strictEqual(inbox.raids[0].signup, 'yes');
  assert.deepStrictEqual(inbox.raids[0].reserves, [{ name: 'Night Cloak', bonus: 0 }]);
  // The panel renders the raid without errors.
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-')), 'Inbox.lua');
  fs.writeFileSync(f, `WowGuildInbox = ${toLua(inbox)}\n`);
  const wow2 = new WowClient({ inboxFile: f });
  wow2.fire('ADDON_LOADED', 'WowGuild');
  wow2.fire('PLAYER_LOGIN');
  wow2.slash('');
});

test('raid pages work end to end over HTTP', async () => {
  const db = dbm.open(':memory:');
  const cfg = { ...config({}), devLogin: true, timers: false };
  const app = createApp(cfg, db);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const url = `http://127.0.0.1:${srv.address().port}`;
  try {
    const login = async (bt) => {
      const res = await fetch(`${url}/login/dev`, { method: 'POST', body: new URLSearchParams({ battletag: bt }), redirect: 'manual' });
      const cookie = res.headers.get('set-cookie').split(';')[0];
      const html = await (await fetch(`${url}/`, { headers: { cookie } })).text();
      return { cookie, csrf: (/name="_csrf" value="([^"]+)"/.exec(html) || [])[1] };
    };
    const post = (s, path, body) => {
      const form = new URLSearchParams({ _csrf: s.csrf });
      for (const [k, v] of Object.entries(body)) for (const x of [].concat(v)) form.append(k, x);
      return fetch(url + path, { method: 'POST', headers: { cookie: s.cookie }, body: form, redirect: 'manual' });
    };
    const get = async (s, path) => { const r = await fetch(url + path, { headers: { cookie: s.cookie } }); return { status: r.status, text: await r.text() }; };

    const owner = await login('Owner#1');
    await post(owner, '/guild/create', { name: 'wow', faction: 'Horde' });
    await post(owner, '/loot/items', { instance: 'Hyjal Summit', items: 'Rage Winterchill | Frost Greaves\nAnetheron | Night Cloak' });
    const created = await post(owner, '/raids', { title: 'Hyjal week 1', instance: 'Hyjal Summit', starts: '2026-12-09T20:00', tz_offset: '-120', sr_limit: '1' });
    assert.strictEqual(created.status, 302);
    const raidPath = created.headers.get('location');
    const raid = db.prepare('SELECT * FROM raids').get();
    assert.strictEqual(raid.starts_at, '2026-12-09T18:00:00.000Z');

    const invite = db.prepare('SELECT invite_code FROM guilds').get().invite_code;
    const member = await login('Member#2');
    await post(member, `/join/${invite}`, {});
    await post(member, `${raidPath}/signup`, { character: 'Bravo', role: 'healer', status: 'yes' });
    const greaves = db.prepare("SELECT id FROM loot_items WHERE name = 'Frost Greaves'").get().id;
    const tooMany = await post(member, `${raidPath}/reserves`, { item: [String(greaves), String(greaves + 1)] });
    assert.match(decodeURIComponent(tooMany.headers.get('location')), /up to 1 item/);
    await post(member, `${raidPath}/reserves`, { item: String(greaves) });
    const page = await get(member, raidPath);
    assert.match(page.text, /Bravo/);
    assert.match(page.text, /value="\d+" checked/);
    assert.strictEqual((await get(member, `${raidPath}/loot`)).status, 403, 'members cannot open the loot screen');

    await post(owner, `${raidPath}/roll`, { item_id: String(greaves) });
    const loot = await get(owner, `${raidPath}/loot`);
    assert.match(loot.text, /Bravo/);
    const memberId = db.prepare("SELECT id FROM users WHERE battletag = 'Member#2'").get().id;
    await post(owner, `${raidPath}/award`, { item_id: String(greaves), user_id: String(memberId), kind: 'sr' });
    await post(owner, `${raidPath}/award`, { item_name: 'Random Ring', user_id: String(memberId), kind: 'os' });
    await post(owner, `${raidPath}/close`, { attended: String(memberId) });
    assert.strictEqual(db.prepare('SELECT status FROM raids').get().status, 'done');
    assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM loot_log').get().n, 2);
    for (const p of ['/raids', raidPath, '/loot', '/loot?instance=Hyjal%20Summit']) assert.strictEqual((await get(member, p)).status, 200, p);

    // Reminder fires once for a raid starting within the hour.
    db.prepare("INSERT INTO raids (guild_id, title, instance, starts_at) VALUES (1, 'Soon', 'Hyjal Summit', ?)").run(new Date(Date.now() + 30 * 60000).toISOString());
    assert.strictEqual(await app.locals.remind(), 1);
    assert.strictEqual(await app.locals.remind(), 0);
  } finally { srv.close(); }
});
