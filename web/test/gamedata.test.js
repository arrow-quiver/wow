// Official Blizzard game data: namespaces, item details, realm status, official roster.
const test = require('node:test');
const assert = require('node:assert');
const dbm = require('../src/db');
const G = require('../src/gamedata');
const blizzard = require('../src/blizzard');
const { applyPayload } = require('../src/sync');
const { createApp, config } = require('../src/server');

// A stand-in for Blizzard's API. `realmUp` can be flipped between calls.
function fakeBlizzard(state = { realmUp: true, ns: 'forever' }) {
  const calls = [];
  const json = (o) => ({ ok: true, status: 200, json: async () => o });
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('oauth.battle.net')) return json({ access_token: 't' });
    const u = new URL(url); const ns = u.searchParams.get('namespace') || '';
    const p = u.pathname;
    if (p === '/data/wow/item/14047') return json({ name: 'Runecloth', quality: { type: 'COMMON' }, level: 50, required_level: 0, item_class: { name: 'Trade Goods' }, item_subclass: { name: 'Cloth' }, inventory_type: { name: 'Non-equippable' } });
    if (p === '/data/wow/item/19019') return json({ name: 'Thunderfury, Blessed Blade of the Windseeker', quality: { type: 'LEGENDARY' }, level: 80, required_level: 60, item_class: { name: 'Weapon' }, item_subclass: { name: 'Sword' }, inventory_type: { name: 'One-Hand' } });
    if (p.startsWith('/data/wow/item/')) return { ok: false, status: 404 };
    if (!ns.includes(state.ns)) return { ok: false, status: 404 };
    if (p === '/data/wow/realm/index') return json({ realms: [{ name: 'Living Flame', slug: 'living-flame' }, { name: "Zul'jin", slug: 'zuljin' }] });
    if (p === '/data/wow/realm/zuljin') return json({ connected_realm: { href: `https://eu.api.blizzard.com/data/wow/connected-realm/42?namespace=${ns}` } });
    if (p === '/data/wow/connected-realm/42') return json({ status: { type: state.realmUp ? 'UP' : 'DOWN' }, has_queue: state.realmUp, population: { name: 'Full' } });
    if (p === '/data/wow/guild/zuljin/wow/roster') return json({ members: [
      { character: { name: 'Grommash', level: 60, playable_class: { id: 1 } }, rank: 0 },
      { character: { name: 'Newbie', level: 12, playable_class: { id: 8 } }, rank: 4 },
    ] });
    return { ok: false, status: 404 };
  };
  return { calls, fetchImpl, state };
}
const CFG = { bnetClientId: 'id', bnetClientSecret: 'sec', bnetRegion: 'eu' };

function guildDb() {
  const db = dbm.open(':memory:');
  const u = db.prepare("INSERT INTO users (bnet_id, battletag) VALUES ('a','J#1')").run().lastInsertRowid;
  const g = db.prepare("INSERT INTO guilds (name, invite_code) VALUES ('wow','i')").run().lastInsertRowid;
  db.prepare("INSERT INTO memberships (user_id, guild_id, role) VALUES (?,?,'owner')").run(u, g);
  return { db, u, g };
}

test('namespaces fall back to Classic Era items until Forever is in the API', () => {
  assert.deepStrictEqual(G.namespaces(null, 'forever', 'eu'), { static: 'static-classic1x-eu', dynamic: null, profile: null, label: 'Classic Era item data (Forever not in the API yet)' });
  const f = G.namespaces({ foreverKey: 'forever' }, 'forever', 'us');
  assert.strictEqual(f.static, 'static-forever-us');
  assert.strictEqual(f.profile, 'profile-forever-us');
  assert.strictEqual(G.namespaces(null, 'retail', 'eu').dynamic, 'dynamic-eu');
  assert.strictEqual(G.slug("Zul'jin"), 'zuljin');
  assert.strictEqual(G.slug('Living Flame'), 'living-flame');
});

test('item details fill in names for items the guild has seen', async () => {
  const { db, u, g } = guildDb();
  applyPayload(db, g, u, { characters: { Grommash: { name: 'Grommash', inventory: { bags: [{ id: 14047, count: 20 }] } } } });
  db.prepare('INSERT INTO prices (guild_id, item_id, day, price) VALUES (?,?,?,?)').run(g, 19019, '2026-11-03', 5000000);
  db.prepare('INSERT INTO prices (guild_id, item_id, day, price) VALUES (?,?,?,?)').run(g, 99999, '2026-11-03', 1);
  const ids = G.missingItemIds(db).sort((a, b) => a - b);
  assert.deepStrictEqual(ids, [14047, 19019, 99999]);
  const B = fakeBlizzard();
  const log = await G.run(db, CFG, { fetchImpl: B.fetchImpl, only: 'items' });
  assert.match(log[0], /2 of 3 items filled from static-classic1x-eu/);
  assert.strictEqual(db.prepare('SELECT name FROM item_names WHERE item_id = 19019').get().name, 'Thunderfury, Blessed Blade of the Windseeker');
  const tf = db.prepare('SELECT * FROM item_info WHERE item_id = 19019').get();
  assert.strictEqual(tf.quality, 'LEGENDARY'); assert.strictEqual(tf.req_level, 60); assert.strictEqual(tf.slot, 'One-Hand');
  assert.strictEqual(db.prepare('SELECT found FROM item_info WHERE item_id = 99999').get().found, 0, 'unknown items are remembered so they are not asked for again');
  assert.deepStrictEqual(G.missingItemIds(db), []);
  assert.strictEqual(B.calls.filter((c) => c.includes('oauth')).length, 1, 'one token for the whole run');
});

test('addon reports the realm; realm status and official roster arrive once Forever is in the API', async () => {
  const { db, u, g } = guildDb();
  applyPayload(db, g, u, { characters: { Grommash: { name: 'Grommash', class: 'WARRIOR', level: 58, guild: 'wow', realm: "Zul'jin" } } });
  const row = db.prepare('SELECT realm, game_guild FROM guilds WHERE id = ?').get(g);
  assert.deepStrictEqual({ ...row }, { realm: "Zul'jin", game_guild: 'wow' });

  const B = fakeBlizzard({ realmUp: true, ns: 'forever' });
  // Before Forever appears: nothing realm-related is asked for.
  await G.run(db, CFG, { fetchImpl: B.fetchImpl });
  assert.ok(!B.calls.some((c) => c.includes('/realm/')));

  blizzard.save(db, { foreverKey: 'forever', forever: 'static-forever-eu', region: 'eu' });
  const sent = [];
  const notify = (gid, kind, msg) => sent.push([gid, kind, msg]);
  B.state.realmUp = false;
  await G.run(db, CFG, { fetchImpl: B.fetchImpl, notify });
  let st = JSON.parse(db.prepare('SELECT realm_status FROM guilds').get().realm_status);
  assert.strictEqual(st.up, false); assert.strictEqual(st.slug, 'zuljin');
  assert.strictEqual(sent.length, 0);
  // Official roster: new member added, linked character's level only goes up.
  const chars = Object.fromEntries(db.prepare('SELECT name, level, class, user_id, in_official_roster FROM characters').all().map((c) => [c.name, c]));
  assert.strictEqual(chars.Newbie.class, 'MAGE'); assert.strictEqual(chars.Newbie.user_id, null);
  assert.strictEqual(chars.Grommash.level, 60); assert.strictEqual(chars.Grommash.user_id, u);
  assert.match(db.prepare('SELECT official_roster_note FROM guilds').get().official_roster_note, /2 members/);

  // Realm comes back up: everyone gets told.
  B.state.realmUp = true;
  await G.run(db, CFG, { fetchImpl: B.fetchImpl, notify, only: 'realm' });
  st = JSON.parse(db.prepare('SELECT realm_status FROM guilds').get().realm_status);
  assert.strictEqual(st.up, true); assert.strictEqual(st.queue, true);
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0][2].title, /Zul'jin is back up/);
  assert.match(sent[0][2].body, /queue/);
});

test('officers set the realm and refresh from Settings; the camp shows realm status', async () => {
  const db = dbm.open(':memory:');
  const B = fakeBlizzard({ realmUp: true, ns: 'forever' });
  const cfg = { ...config({}), ...CFG, devLogin: true, timers: false, gameFetch: B.fetchImpl, pushSend: async () => {} };
  const app = createApp(cfg, db);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const url = `http://127.0.0.1:${srv.address().port}`;
  try {
    const res = await fetch(`${url}/login/dev`, { method: 'POST', body: new URLSearchParams({ battletag: 'Owner#1' }), redirect: 'manual' });
    const cookie = res.headers.get('set-cookie').split(';')[0];
    const csrf = /name="_csrf" value="([^"]+)"/.exec(await (await fetch(`${url}/`, { headers: { cookie } })).text())[1];
    const post = (p, body) => fetch(url + p, { method: 'POST', headers: { cookie }, body: new URLSearchParams({ _csrf: csrf, ...body }), redirect: 'manual' });
    const get = async (p) => (await fetch(url + p, { headers: { cookie } })).text();
    await post('/guild/create', { name: 'wow', faction: 'Horde' });
    blizzard.save(db, { foreverKey: 'forever', region: 'eu' });
    assert.match(await get('/settings'), /Realm and official Blizzard data[\s\S]*Using: WoW: Forever/);
    await post('/settings/realm', { realm: "Zul'jin", game_guild: 'wow' });
    const r = await post('/settings/gamedata/refresh', {});
    assert.strictEqual(r.status, 302);
    const home = await get('/');
    assert.match(home, /class="realm-line"><strong>Zul&#39;jin<\/strong> <span class="realm-up">Up<\/span> · <strong>login queue<\/strong> · Full population/);
    assert.match(await get('/roster'), /Newbie/);
    assert.match(await get('/settings'), /Official guild list: 2 members/);
  } finally { srv.close(); }
});
