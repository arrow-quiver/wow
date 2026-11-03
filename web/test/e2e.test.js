// End to end: simulated game → SavedVariables → companion → website → inbox → back in game.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const dbm = require('../src/db');
const A = require('../src/auth');
const { createApp, config } = require('../src/server');
const { WowClient } = require('./wowsim');
const { parseSavedVariables } = require('../../companion/lua');

function startServer() {
  const db = dbm.open(':memory:');
  const cfg = { ...config({}), devLogin: true, baseUrl: 'http://127.0.0.1' };
  const app = createApp(cfg, db);
  return new Promise((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => {
      cfg.baseUrl = `http://127.0.0.1:${srv.address().port}`;
      resolve({ db, srv, cfg, url: cfg.baseUrl });
    });
  });
}

function seed(db) {
  const u = db.prepare("INSERT INTO users (bnet_id, battletag) VALUES ('dev:J#1','J#1')").run().lastInsertRowid;
  const u2 = db.prepare("INSERT INTO users (bnet_id, battletag) VALUES ('dev:Grom#2','Grom#2')").run().lastInsertRowid;
  const g = db.prepare("INSERT INTO guilds (name, faction, invite_code) VALUES ('wow','Horde','abc123')").run().lastInsertRowid;
  db.prepare("INSERT INTO memberships VALUES (?,?,'owner',datetime('now'))").run(u, g);
  db.prepare("INSERT INTO memberships VALUES (?,?,'member',datetime('now'))").run(u2, g);
  const t = A.newApiToken();
  db.prepare('INSERT INTO api_tokens (user_id, guild_id, token_hash, prefix) VALUES (?,?,?,?)').run(u, g, t.hash, t.prefix);
  // Grom wants something only Thrallia (J) can make.
  db.prepare("INSERT INTO craft_requests (guild_id, requester_id, item, notes) VALUES (?,?,'Copper Chain Vest','mats in mail')").run(g, u2);
  db.prepare("INSERT INTO announcements (guild_id, user_id, body) VALUES (?,?,'Raid sign-ups Sunday')").run(g, u);
  return { userId: u, guildId: g, token: t.raw };
}

test('Lua SavedVariables parser handles WoW output', () => {
  const src = Buffer.from('\nWowGuildDB = {\n\t["a"] = "x\\"y\\n",\n\t["list"] = {\n\t\t"one", -- [1]\n\t\t2, -- [2]\n\t},\n\t["map"] = { [5] = true, ["k"] = nil },\n\t["n"] = -1.5e2,\n\t["name"] = "Zul\xc3\xa9",\n}\nOther = 0x1F\n', 'latin1');
  const out = parseSavedVariables(src);
  assert.deepStrictEqual(out.WowGuildDB.list, ['one', 2]);
  assert.strictEqual(out.WowGuildDB.a, 'x"y\n');
  assert.strictEqual(out.WowGuildDB.n, -150);
  assert.strictEqual(out.WowGuildDB.name, 'Zulé');
  assert.strictEqual(out.WowGuildDB.map['5'], true);
  assert.strictEqual(out.Other, 31);
});

test('addon collects data out of combat and parses /wow cta', () => {
  const wow = new WowClient();
  wow.fire('ADDON_LOADED', 'WowGuild');
  wow.fire('PLAYER_LOGIN');
  wow.fire('GUILD_ROSTER_UPDATE');
  wow.fire('TRADE_SKILL_SHOW');
  wow.slash('cta Crossroads 8 Alliance at the flight master');
  wow.slash('cta 3 help');
  wow.fire('PLAYER_LOGOUT');
  const db = parseSavedVariables(wow.saveVariables()).WowGuildDB;
  const me = db.characters.Thrallia;
  assert.strictEqual(me.class, 'SHAMAN');
  assert.strictEqual(me.level, 23);
  assert.deepStrictEqual(me.professions.map((p) => p.name), ['Blacksmithing', 'Fishing', 'Cooking']);
  assert.deepStrictEqual(me.recipes.Blacksmithing.map((r) => r.name), ['Rough Sharpening Stone', 'Copper Chain Vest']);
  assert.strictEqual(db.roster.members.length, 3);
  assert.strictEqual(db.roster.members[1].name, 'Grommash Hellscream');
  assert.deepStrictEqual(db.ctaQueue.map((c) => [c.zone, c.needed, c.msg]), [['Crossroads', 8, 'Alliance at the flight master'], ['The Barrens', 3, 'help']]);
  // In combat: nothing gets collected.
  wow.exec('__inCombat = true; WowGuildDB.roster = { members = {} }');
  wow.fire('GUILD_ROSTER_UPDATE');
  assert.strictEqual(wow.eval('#WowGuildDB.roster.members'), '0');
});

test('companion uploads, site stores it, inbox comes back into the game', async () => {
  const { db, srv, url } = await startServer();
  try {
    const { guildId, token } = seed(db);
    // 1. Play a session in the simulated game.
    const wow = new WowClient();
    wow.fire('ADDON_LOADED', 'WowGuild');
    wow.fire('PLAYER_LOGIN');
    wow.fire('GUILD_ROSTER_UPDATE');
    wow.fire('TRADE_SKILL_SHOW');
    wow.slash('cta Crossroads 8 Alliance at the flight master');
    wow.fire('PLAYER_LOGOUT');

    // 2. Lay out a fake game folder like the real one.
    const game = fs.mkdtempSync(path.join(os.tmpdir(), 'wowgame-'));
    const sv = path.join(game, 'WTF', 'Account', 'ACCOUNT1', 'SavedVariables');
    fs.mkdirSync(sv, { recursive: true });
    fs.mkdirSync(path.join(game, 'Interface', 'AddOns', 'WowGuild', 'Data'), { recursive: true });
    fs.writeFileSync(path.join(sv, 'WowGuild.lua'), wow.saveVariables());
    const cfgFile = path.join(game, 'config.json');
    fs.writeFileSync(cfgFile, JSON.stringify({ siteUrl: url, syncKey: token, wowFolder: game }));

    // 3. Run the companion once (in a child process, like members will).
    const outText = await new Promise((resolve, reject) => {
      require('child_process').execFile(process.execPath, [path.join(__dirname, '..', '..', 'companion', 'companion.js'), '--once'],
        { env: { ...process.env, WOW_COMPANION_CONFIG: cfgFile } }, (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout)));
    });
    assert.match(outText, /Uploaded: 1 character\(s\), 3 roster entries, 2 recipes, 1 call\(s\) to arms/);

    // 4. Site has the data.
    const chars = db.prepare('SELECT name, user_id, online, level FROM characters WHERE guild_id = ? ORDER BY name').all(guildId);
    assert.deepStrictEqual(chars.map((c) => c.name), ['Grommash Hellscream', 'Thrallia', 'Zuljinne']);
    assert.ok(chars.find((c) => c.name === 'Thrallia').user_id, 'own character is linked to the uploader');
    assert.strictEqual(chars.find((c) => c.name === 'Grommash Hellscream').user_id, null, 'roster entries are not claimed');
    assert.strictEqual(chars.filter((c) => c.online).length, 2);
    assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM ctas').get().n, 1);

    // Re-uploading the same file does not duplicate the call to arms.
    await fetch(`${url}/api/sync`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(parseSavedVariables(fs.readFileSync(path.join(sv, 'WowGuild.lua'))).WowGuildDB) });
    assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM ctas').get().n, 1);

    // 5. The inbox the companion wrote loads in game and shows the craft request.
    const inboxFile = path.join(game, 'Interface', 'AddOns', 'WowGuild', 'Data', 'Inbox.lua');
    assert.ok(fs.existsSync(inboxFile));
    const wow2 = new WowClient({ inboxFile });
    wow2.fire('ADDON_LOADED', 'WowGuild');
    wow2.fire('PLAYER_LOGIN');
    assert.strictEqual(wow2.eval('WowGuildInbox.canCraft[1].item'), 'Copper Chain Vest');
    assert.match(wow2.printed(), /1 crafting request you can make/);
    wow2.slash(''); // open the panel: must not error
  } finally {
    srv.close();
  }
});

test('API rejects bad tokens and browser POSTs need CSRF', async () => {
  const { db, srv, url } = await startServer();
  try {
    seed(db);
    const r = await fetch(`${url}/api/sync`, { method: 'POST', headers: { Authorization: 'Bearer wowg_nope', 'Content-Type': 'application/json' }, body: '{}' });
    assert.strictEqual(r.status, 401);
    const login = await fetch(`${url}/login/dev`, { method: 'POST', body: new URLSearchParams({ battletag: 'J#1' }), redirect: 'manual' });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const noCsrf = await fetch(`${url}/cta`, { method: 'POST', headers: { cookie }, body: new URLSearchParams({ zone: 'X' }), redirect: 'manual' });
    assert.strictEqual(noCsrf.status, 403);
    const page = await (await fetch(`${url}/`, { headers: { cookie } })).text();
    const csrf = /name="_csrf" value="([^"]+)"/.exec(page)[1];
    const ok = await fetch(`${url}/cta`, { method: 'POST', headers: { cookie }, body: new URLSearchParams({ zone: 'Tarren Mill', _csrf: csrf }), redirect: 'manual' });
    assert.strictEqual(ok.status, 302);
    for (const p of ['/', '/roster', '/crafters', '/crafters?q=vest', '/requests', '/buddies', '/settings']) {
      const res = await fetch(url + p, { headers: { cookie } });
      assert.strictEqual(res.status, 200, p);
    }
  } finally {
    srv.close();
  }
});
