'use strict';
// The local core itself: the database adapter, validators, configuration, the per-launch token, JSON
// errors, "me", the guild found in the first sync, roles from in-game ranks, guild settings, the event bus
// (notifications for me), the ctx helpers, the sharing seam and shutting down.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { startCore, seedGuild, addPlayer, asRole, client, tmpDir } = require('./helpers');
const { open, MIGRATIONS } = require('../../src/core/db');
const H = require('../../src/core/http');
const { createConfig } = require('../../src/core/config');
const { safeEqual } = require('../../src/core/app');
const identity = require('../../src/core/identity');
const S = require('../../src/shared/sharing');
const sharing = require('../../src/core/sharing');
const { readPrefs, mergePrefs } = require('../../src/core/events');
const { version } = require('../../package.json');

const WEBHOOK = 'https://discord.com/api/webhooks/42/abc';
const NOW = () => Math.floor(Date.now() / 1000);

// ---------- database adapter ----------

test('db: node:sqlite behaves like better-sqlite3 for the ported code', () => {
  const dir = tmpDir('gc-db-');
  const file = path.join(dir, 'guildcamp.db');
  try {
    const db = open(file);
    assert.strictEqual(db.prepare('SELECT v FROM schema_version').get().v, MIGRATIONS.length);
    assert.strictEqual(db.pragma('journal_mode', { simple: true }), 'wal');
    assert.strictEqual(db.pragma('foreign_keys', { simple: true }), 1);

    const r = db.prepare('INSERT INTO users (bnet_id, battletag) VALUES (?, ?)').run('a', 'A#1');
    assert.deepStrictEqual(r, { changes: 1, lastInsertRowid: 1 });
    assert.strictEqual(typeof r.lastInsertRowid, 'number');
    const row = db.prepare('SELECT id, battletag FROM users WHERE id = ?').get(1);
    assert.deepStrictEqual(row, { id: 1, battletag: 'A#1' }, 'rows are plain objects');
    assert.strictEqual(db.prepare('SELECT id FROM users WHERE id = 99').get(), undefined);
    assert.deepStrictEqual(db.prepare('SELECT id FROM users').pluck().all(), [1]);
    assert.deepStrictEqual([...db.prepare('SELECT battletag FROM users').iterate()], [{ battletag: 'A#1' }]);
    // Named parameters: bare names, and extra keys are ignored (as better-sqlite3 does).
    assert.deepStrictEqual(db.prepare('SELECT @a AS a, :b AS b').get({ a: 1, b: 2, extra: 3 }), { a: 1, b: 2 });
    assert.deepStrictEqual(db.prepare('SELECT ? AS a, ? AS b').get([5, 6]), { a: 5, b: 6 }, 'an array of values works too');
    assert.ok(Buffer.isBuffer(db.prepare('SELECT x\'00ff\' AS b').get().b), 'blobs are Buffers');

    // Transactions: commit, rollback, and nested SAVEPOINTs that roll back on their own.
    const add = (tag) => db.prepare('INSERT INTO users (bnet_id, battletag) VALUES (?, ?)').run(tag, tag);
    assert.throws(() => db.transaction(() => { add('b'); throw new Error('nope'); })(), /nope/);
    assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM users').get().n, 1, 'rolled back');
    const out = db.transaction((x) => {
      add('c');
      try { db.transaction(() => { add('d'); throw new Error('inner'); })(); } catch { /* only the inner part is undone */ }
      assert.ok(db.inTransaction);
      return x * 2;
    })(21);
    assert.strictEqual(out, 42);
    assert.deepStrictEqual(db.prepare('SELECT bnet_id FROM users ORDER BY id').pluck().all(), ['a', 'c']);
    assert.ok(!db.inTransaction);
    assert.throws(() => db.prepare("INSERT INTO memberships (user_id, guild_id, role) VALUES (99, 99, 'member')").run(), /FOREIGN KEY/);
    db.close();

    const again = open(file);
    assert.strictEqual(again.prepare('SELECT v FROM schema_version').get().v, MIGRATIONS.length, 'opening again is a no-op');
    again.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('http validators', () => {
  assert.equal(H.str('  hi  '), 'hi');
  assert.equal(H.str('abcdef', 3), 'abc');
  assert.equal(H.str(''), null);
  assert.equal(H.str(null), null);
  assert.equal(H.str({ a: 1 }), null);
  assert.equal(H.str(42), '42');
  assert.equal(H.int('12.9'), 12);
  assert.equal(H.int('x'), null);
  assert.equal(H.int(''), null);
  assert.equal(H.int(true), null);
  assert.equal(H.int(99, 1, 40), 40);
  assert.equal(H.num('1e9', 0, 500), 500);
  assert.equal(H.bool('on'), true);
  assert.equal(H.bool('0'), false);
  assert.equal(H.oneOf('c', ['a', 'b'], 'b'), 'b');
  assert.deepEqual(H.list({ 1: 'a', 2: 'b' }), ['a', 'b']);
  assert.equal(H.list(new Array(50).fill(0), 10).length, 10);
  assert.equal(H.ver('0.11.0-beta.1'), '0.11.0-beta.1');
  assert.equal(H.ver('bad version'), null);
  assert.ok(safeEqual('abc', 'abc'));
  assert.ok(!safeEqual('abc', 'abd'));
  assert.ok(!safeEqual('abc', 'abcd'));
  assert.ok(!safeEqual('', ''));
});

test('config: the player\'s key, webhook and region are read live; Battle.net only with built-in credentials', () => {
  const secrets = {};
  const settings = {};
  const cfg = createConfig({ dbFile: ':memory:', getSecret: (n) => secrets[n] || null, getSettings: () => settings });
  assert.strictEqual(cfg.anthropicKey, '');
  secrets.anthropicKey = '  sk-ant-test  ';
  assert.strictEqual(cfg.anthropicKey, 'sk-ant-test');
  assert.strictEqual(cfg.bnetRegion, 'eu');
  settings.bnetRegion = 'US';
  assert.strictEqual(cfg.bnetRegion, 'us');
  settings.bnetRegion = 'mars';
  assert.strictEqual(cfg.bnetRegion, 'eu');
  assert.strictEqual(cfg.discordWebhook, '');
  settings.discordWebhook = 'https://example.com/hook';
  assert.strictEqual(cfg.discordWebhook, '', 'only Discord webhook addresses');
  settings.discordWebhook = WEBHOOK;
  assert.strictEqual(cfg.discordWebhook, WEBHOOK);
  assert.strictEqual(cfg.bnetClientId, '');
  const withApp = createConfig({ dbFile: ':memory:', credentials: { clientId: 'id', clientSecret: 'sec' } });
  assert.deepStrictEqual([withApp.bnetClientId, withApp.bnetClientSecret], ['id', 'sec']);
  assert.strictEqual(withApp.defaultTzOffset, new Date().getTimezoneOffset());
  assert.strictEqual(createConfig({ dataDir: 'C:/x' }).dbFile, path.join('C:/x', 'guildcamp.db'));
});

// ---------- HTTP ----------

test('only the app may call it: 127.0.0.1, the launch token, no CORS, JSON errors', async () => {
  const logged = [];
  const c = await startCore({
    log: { info() {}, warn() {}, error: (...a) => logged.push(a.join(' ')) },
    extraRoutes: [(app) => {
      app.get('/api/test/boom', () => { throw new Error('kaboom'); });
      app.get('/api/test/http', () => { throw new H.HttpError(418, 'I am a teapot.', 'TEAPOT'); });
      app.post('/api/test/echo', (req, res) => res.json({ body: req.body }));
    }],
  });
  try {
    assert.match(c.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.ok(c.token.length >= 40);
    for (const who of [client(c.url), client(c.url, 'wrong-token'), client(c.url, `${c.token}x`)]) {
      const r = await who.get('/api/me');
      assert.deepStrictEqual([r.status, r.body], [401, { error: 'Not allowed.' }]);
      assert.strictEqual((await who.get('/nothing')).status, 401, 'not even a 404 without the token');
    }
    const r = await c.api.raw('GET', '/api/me', { headers: { Origin: 'https://evil.example' } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers.get('access-control-allow-origin'), null);
    assert.strictEqual(r.headers.get('x-content-type-options'), 'nosniff');
    assert.strictEqual(r.headers.get('x-frame-options'), 'DENY');
    assert.strictEqual(r.headers.get('x-powered-by'), null);
    assert.strictEqual(r.headers.get('cache-control'), 'no-store');
    const pre = await c.api.raw('OPTIONS', '/api/me', { headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'GET' } });
    assert.strictEqual(pre.headers.get('access-control-allow-origin'), null);

    assert.deepStrictEqual(await c.api.get('/api/nope').then((x) => [x.status, x.body]), [404, { error: 'Not found.' }]);
    const boom = await c.api.get('/api/test/boom');
    assert.strictEqual(boom.status, 500);
    assert.match(boom.body.error, /^Something went wrong inside Guild Camp\./);
    assert.ok(logged.some((l) => l.includes('kaboom')), 'the stack is logged');
    assert.deepStrictEqual((await c.api.get('/api/test/http')).body, { error: 'I am a teapot.', code: 'TEAPOT' });
    const bad = await c.api.raw('POST', '/api/test/echo', { headers: { 'Content-Type': 'application/json' }, body: '{nope' });
    assert.deepStrictEqual([bad.status, bad.body], [400, { error: 'That request was not valid JSON.' }]);
    assert.deepStrictEqual((await c.api.post('/api/test/echo')).body, { body: {} });
  } finally {
    await c.close();
  }
  await assert.rejects(fetch(`${c.url}/api/me`), 'closed: nothing listens any more');
});

test('me before any sync: "You", no guild, guild pages explain what to do', async () => {
  const c = await startCore();
  try {
    let r = await c.api.get('/api/me');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.user.battletag, 'You');
    assert.deepStrictEqual([r.body.guild, r.body.role], [null, null]);
    assert.deepStrictEqual(r.body.notifyPrefs, readPrefs(null));
    assert.deepStrictEqual(r.body.bnet, { characters: 0, profile_at: null, note: null });
    r = await c.api.get('/api/meta');
    assert.deepStrictEqual(r.body, { app: 'guild-camp', version, guild: null, blizzard: false, latest: { app: null, addon: null } });
    for (const p of ['/api/camp', '/api/roster', '/api/raids', '/api/bank', '/api/admin', '/api/guild', '/api/calendar.ics']) {
      r = await c.api.get(p);
      assert.strictEqual(r.status, 403, p);
      assert.strictEqual(r.body.code, 'NO_GUILD', p);
      assert.match(r.body.error, /hasn't seen your guild yet/, p);
    }
    // The inbox still answers (the addon learns the latest version), with nothing in it.
    r = await c.api.get('/api/inbox');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.guild, '');
    assert.deepStrictEqual(r.body.outbox, []);
  } finally {
    await c.close();
  }
});

test('the first sync sets the guild up; roles follow in-game ranks; my name follows my main until Battle.net', async () => {
  const c = await startCore({ latest: { app: '0.12.0', addon: { version: '0.11.2' } } });
  const sessions = [];
  c.core.emitter.on('session', (s) => sessions.push(s));
  try {
    // No character in a guild: nothing is stored, and the reply says why.
    let r = await c.api.post('/api/sync', { addonVersion: '0.11.0', characters: { Lonely: { name: 'Lonely', level: 5, realm: 'Forever', updated: NOW() } } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.noGuild, true);
    assert.match(r.body.message, /None of your characters is in a guild yet/);
    assert.strictEqual(identity.currentGuild(c.db), null);
    assert.strictEqual(c.db.prepare('SELECT COUNT(*) n FROM characters').get().n, 0);

    // The most recently played character with a guild decides the guild.
    r = await c.api.post('/api/sync', {
      addonVersion: '0.11.0',
      characters: {
        Oldalt: { name: 'Oldalt', class: 'MAGE', level: 30, realm: 'Forever', guild: 'Other Guild', faction: 'Alliance', updated: NOW() - 9000 },
        Thrall: { name: 'Thrall', class: 'SHAMAN', level: 60, realm: 'Forever', guild: 'Horde Heroes', faction: 'Horde', updated: NOW() - 60 },
      },
      roster: { scannedAt: NOW() - 30, guild: 'Horde Heroes', members: [
        { name: 'Thrall', rank: 'Officer', rankIndex: 1, online: true },
        { name: 'Garrosh', rank: 'Guild Master', rankIndex: 0, online: false },
        { name: 'Grunt', rank: 'Member', rankIndex: 4, online: true },
      ] },
    });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body.switched, { id: r.body.guild.id, name: 'Horde Heroes', faction: 'Horde', created: true });
    assert.deepStrictEqual(r.body.latest, { app: { version: '0.12.0' }, addon: { version: '0.11.2' } });
    const g = identity.currentGuild(c.db);
    assert.deepStrictEqual([g.name, g.game_guild, g.realm, g.faction, g.officer_rank_max], ['Horde Heroes', 'Horde Heroes', 'Forever', 'Horde', 1]);
    assert.strictEqual(r.body.guild.role, 'officer', 'rank 1 is an officer by default');
    r = await c.api.get('/api/me');
    assert.strictEqual(r.body.user.battletag, 'Thrall', 'until Battle.net says otherwise, I am my character');
    assert.strictEqual(r.body.role, 'officer');
    assert.strictEqual(r.body.guild.name, 'Horde Heroes');
    assert.strictEqual(r.body.user.addon_version, '0.11.0');
    assert.ok(sessions.length >= 1 && sessions.at(-1).role === 'officer', 'the app hears that my session changed');
    // Rank names alone never make anyone an officer; only the index counts.
    assert.strictEqual(c.db.prepare("SELECT rank_index FROM characters WHERE name = 'Grunt'").get().rank_index, 4);

    // Only the Guild Master changes which ranks are officers.
    r = await c.api.put('/api/guild/settings', { officer_rank_max: 0 });
    assert.deepStrictEqual([r.status, r.body.error], [403, 'Only the Guild Master can choose which ranks are officers.']);
    assert.strictEqual(asRole(c.db, 'owner'), 'owner');
    r = await c.api.put('/api/guild/settings', { officer_rank_max: 0 });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body.messages, ['Officers now follow in-game ranks: Guild Master only.']);
    assert.strictEqual(r.body.guild.role, 'owner');
    assert.strictEqual(asRole(c.db, 'officer'), 'member', 'rank 1 is no longer an officer');
    assert.strictEqual(asRole(c.db, 'owner'), 'owner');
    r = await c.api.put('/api/guild/settings', { officer_rank_max: '3' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(asRole(c.db, 'officer'), 'officer');
    for (const bad of [10, -1, 'x', 1.5]) {
      asRole(c.db, 'owner');
      assert.strictEqual((await c.api.put('/api/guild/settings', { officer_rank_max: bad })).status, 400, String(bad));
    }

    // Battle.net in the app: the BattleTag wins, and the characters are kept for /api/me.
    c.core.setIdentity({ battletag: 'Thrall#1234', characters: [{ name: 'Thrall', realm: 'Forever', level: 60, class: 'SHAMAN', namespace: 'profile-classic1x-eu', guild: 'Horde Heroes' }] });
    r = await c.api.get('/api/me');
    assert.strictEqual(r.body.user.battletag, 'Thrall#1234');
    assert.strictEqual(r.body.bnet.characters, 1);
    assert.match(r.body.bnet.note, /Read 1 character from Battle.net/);
    assert.strictEqual(sessions.at(-1).user.battletag, 'Thrall#1234');
    c.core.setIdentity({ battletag: null, characters: [] });
    r = await c.api.get('/api/me');
    assert.strictEqual(r.body.user.battletag, 'Thrall', 'signed out of Battle.net: back to the character name');
    assert.deepStrictEqual(r.body.bnet, { characters: 0, profile_at: null, note: null });

    // Playing a character in another guild switches to that guild; the old one's data stays.
    r = await c.api.post('/api/sync', { characters: { Oldalt: { name: 'Oldalt', class: 'MAGE', level: 31, realm: 'Forever', guild: 'Other Guild', faction: 'Alliance', updated: NOW() } } });
    assert.strictEqual(r.body.guild.name, 'Other Guild');
    assert.strictEqual(r.body.switched.created, true);
    assert.strictEqual(r.body.guild.role, 'member');
    assert.strictEqual((await c.api.get('/api/meta')).body.guild.name, 'Other Guild');
    r = await c.api.post('/api/sync', { characters: { Thrall: { name: 'Thrall', realm: 'Forever', guild: 'Horde Heroes', updated: NOW() + 5 } } });
    assert.strictEqual(r.body.guild.name, 'Horde Heroes');
    assert.strictEqual(r.body.switched.created, false);
    assert.strictEqual(r.body.guild.role, 'owner', 'back in the first guild with the rank I had there');
    assert.strictEqual(c.db.prepare('SELECT COUNT(*) n FROM guilds').get().n, 2);
  } finally {
    await c.close();
  }
});

test('the BattleTag known at start is used right away', async () => {
  const c = await startCore({ identity: { battletag: 'Jaina#4321', characters: [] } });
  try {
    assert.strictEqual((await c.api.get('/api/me')).body.user.battletag, 'Jaina#4321');
    assert.strictEqual(c.core.session().user.battletag, 'Jaina#4321');
    assert.deepStrictEqual([c.core.session().guild, c.core.session().role], [null, null]);
  } finally {
    await c.close();
  }
});

test('notification choices and the app version', async () => {
  const c = await startCore();
  try {
    let r = await c.api.put('/api/me/notifications', { raids: false, bogus: true, cta: 'no' });
    assert.deepStrictEqual(r.body.notifyPrefs, { ...readPrefs(null), raids: false });
    r = await c.api.put('/api/me/notifications', { notifyPrefs: { raids: true, coach: false } });
    assert.deepStrictEqual(r.body.notifyPrefs, { ...readPrefs(null), coach: false });
    assert.deepStrictEqual(mergePrefs('{"raids":false}', { drives: false }), { ...readPrefs(null), raids: false, drives: false });
    await c.api.raw('GET', '/api/me', { headers: { 'X-App-Version': '0.12.0' } });
    assert.strictEqual((await c.api.get('/api/me')).body.user.app_version, '0.12.0');
  } finally {
    await c.close();
  }
});

test('guild settings: who may change what, validation, audit; the webhook lives in Settings', async () => {
  const c = await startCore({ settings: { discordWebhook: WEBHOOK } });
  try {
    seedGuild(c.db, { role: 'member' });
    let r = await c.api.get('/api/guild');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.guild.role, 'member');
    assert.strictEqual(r.body.guild.discord_webhook, undefined, 'only officers see the webhook');
    assert.strictEqual(r.body.memberCount, 1);
    assert.deepStrictEqual(r.body.options.wowheadGames.map((g) => g.value), ['forever', 'retail', 'classic']);

    // Anyone: tooltips and the Coach (their own key and budget).
    r = await c.api.put('/api/guild/settings', { wowhead_game: 'classic', coach_enabled: false, coach_budget_usd: '7.456' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual(r.body.messages, ["Item tooltips now use Wowhead's Classic database.", 'Coach settings saved.']);
    assert.deepStrictEqual([r.body.guild.wowhead_game, r.body.guild.coach_enabled, r.body.guild.coach_budget_usd], ['classic', 0, 7.46]);
    // Officers: the realm and in-game guild name.
    r = await c.api.put('/api/guild/settings', { realm: 'Other' });
    assert.deepStrictEqual([r.status, r.body.error], [403, 'Only officers can change the realm and guild name.']);
    asRole(c.db, 'officer');
    r = await c.api.put('/api/guild/settings', { realm: 'Mirage Raceway', game_guild: 'wow' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.guild.realm, 'Mirage Raceway');
    assert.strictEqual(r.body.guild.discord_webhook, WEBHOOK, 'officers see the local webhook');

    for (const [body, error] of [
      [{ wowhead_game: 'tbc' }, 'Pick WoW: Forever, Retail or Classic for item tooltips.'],
      [{ coach_budget_usd: 'lots' }, 'Set a monthly Coach budget between $0 and $500.'],
      [{ discord_webhook: WEBHOOK }, 'The Discord webhook is set in Settings now, on this computer only.'],
      [{}, 'Nothing to save.'],
    ]) {
      r = await c.api.put('/api/guild/settings', body);
      assert.deepStrictEqual([r.status, r.body.error], [400, error], JSON.stringify(body));
    }
    // A bad field stops the whole update.
    r = await c.api.put('/api/guild/settings', { wowhead_game: 'retail', coach_budget_usd: -5000 });
    assert.strictEqual(r.status, 200, 'budgets are clamped, not refused');
    assert.strictEqual(r.body.guild.coach_budget_usd, 0);
    const audit = c.db.prepare('SELECT action FROM audit_log ORDER BY id').pluck().all();
    assert.ok(audit.includes('Wowhead tooltips set') && audit.includes('coach settings') && audit.includes('realm set'));
  } finally {
    await c.close();
  }
});

test('changing item tooltips or officer ranks in Guild settings reaches the app session once (also a CFG imported from the Guild Master), so other pages switch Wowhead database and roles', async () => {
  const c = await startCore();
  const sessions = [];
  c.core.emitter.on('session', (s) => sessions.push(s));
  const settle = () => new Promise((r) => setTimeout(r, 30));
  const write = async (body) => {
    const r = await c.api.put('/api/guild/settings', body);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    await settle();
  };
  try {
    seedGuild(c.db, { role: 'owner', character: 'Thrall' });
    await c.api.put('/api/me/notifications', { cta: true }); // any write: the seeded guild reaches the session
    await settle();
    sessions.length = 0;

    await write({ wowhead_game: 'classic' });
    assert.deepStrictEqual(sessions.map((s) => s.guild.wowhead_game), ['classic']);
    await write({ wowhead_game: 'classic' });
    assert.strictEqual(sessions.length, 1, 'the same value again: nothing new');
    await write({ officer_rank_max: 3 });
    await write({ relay_rank_max: 2 });
    assert.deepStrictEqual(sessions.slice(1).map((s) => [s.guild.officer_rank_max, s.guild.relay_rank_max, s.role]), [[3, null, 'owner'], [3, 2, 'owner']],
      'the Guild Master\'s own role stays: the ranks alone change the session');
    await write({ officer_rank_max: 3 });
    assert.strictEqual(sessions.length, 3);
  } finally {
    await c.close();
  }

  // A member whose role doesn't change: the Guild Master's CFG arrives with an upload.
  const m = await startCore();
  const seen = [];
  m.core.emitter.on('session', (s) => seen.push(s));
  try {
    seedGuild(m.db, { role: 'member', character: 'Grunt' });
    await m.api.put('/api/me/notifications', { cta: true });
    await settle();
    seen.length = 0;
    const t = NOW() - 60;
    const cfg = S.encode({ type: 'CFG', key: '1', v: S.makeVersion(t, 'Garrosh', false), author: 'Garrosh', del: false, fields: { officerRankMax: 2, relayRankMax: null } });
    const part = sharing.partitionOf(m.db, identity.currentGuild(m.db));
    const r = await m.api.post('/api/sync', {
      characters: { Grunt: { name: 'Grunt', class: 'WARRIOR', level: 60, realm: 'Forever', guild: 'wow', updated: NOW() } },
      shared: { v: 1, clock: { server: NOW(), here: NOW() }, guilds: { [part]: { recs: { 'CFG:1': cfg }, via: { 'CFG:1': `Garrosh,${NOW()},d` }, sent: {}, names: {} } } },
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    await settle();
    assert.deepStrictEqual(seen.map((s) => [s.guild.officer_rank_max, s.role]), [[2, 'member']]);
  } finally {
    await m.close();
  }
});

test('members: me and the guildmates Guild Camp knows, roles from ranks', async () => {
  const c = await startCore();
  try {
    const g = seedGuild(c.db, { role: 'owner', character: 'Thrall' });
    addPlayer(c.db, g.guildId, 'Jaina#2222', { role: 'officer' });
    addPlayer(c.db, g.guildId, 'Grom#3333', { role: 'member', characters: ['Grom', 'Gromalt'] });
    const r = await c.api.get('/api/members');
    assert.deepStrictEqual(r.body.members.map((m) => [m.name, m.role, m.characters, m.isMe]), [
      ['Thrall', 'owner', 1, true], ['Jaina', 'officer', 1, false], ['Grom', 'member', 2, false],
    ]);
    assert.strictEqual(r.body.members[0].rank_index, 0);
  } finally {
    await c.close();
  }
});

// ---------- the event bus ----------

test('events: only what I should see reaches me, as an event on the emitter', async () => {
  const c = await startCore();
  try {
    const g = seedGuild(c.db, { role: 'member', character: 'Me' });
    const other = addPlayer(c.db, g.guildId, 'Jaina#2222', { role: 'officer' });
    const me = g.me;
    const emit = (kind, opts) => c.ctx.emit(g.guildId, kind, opts);
    assert.ok(emit('raid', { title: 'Everyone', route: '/raids/1' }));
    assert.strictEqual(emit('raid', { title: 'Not for me', userId: other.id }), null);
    assert.ok(emit('request', { title: 'For me', userId: me }));
    assert.ok(emit('raid', { title: 'In the list', userIds: [other.id, me] }));
    assert.strictEqual(emit('raid', { title: 'Not in the list', userIds: [other.id] }), null);
    assert.strictEqual(emit('raid', { title: 'Empty list', userIds: [] }), null);
    assert.strictEqual(emit('cta', { title: 'I did it', exceptUserId: me }), null);
    assert.strictEqual(emit('notice', { title: 'Officers', officersOnly: true }), null);
    asRole(c.db, 'officer');
    assert.ok(emit('notice', { title: 'Officers now', officersOnly: true }));
    assert.strictEqual(emit('request', { title: 'Recipe', recipe: 'Copper Chain Vest' }), null);
    const charId = c.db.prepare("SELECT id FROM characters WHERE name = 'Me'").get().id;
    c.db.prepare("INSERT INTO recipes (character_id, profession, name) VALUES (?, 'Blacksmithing', 'Copper Chain Vest')").run(charId);
    assert.ok(emit('request', { title: 'Recipe now', recipe: 'copper chain vest' }));
    await c.api.put('/api/me/notifications', { raids: false });
    assert.strictEqual(emit('raid', { title: 'Muted' }), null);
    assert.ok(emit('release', { title: 'Releases always show' }));
    assert.strictEqual(emit('raid!', { title: 'Bad kind' }), null);
    assert.strictEqual(c.ctx.emit(0, 'raid', { title: 'Bad guild' }), null);

    assert.deepStrictEqual(c.events.map((e) => e.title), ['Everyone', 'For me', 'In the list', 'Officers now', 'Recipe now', 'Releases always show']);
    assert.deepStrictEqual(Object.keys(c.events[0]).sort(), ['body', 'created_at', 'id', 'kind', 'route', 'title']);
    assert.strictEqual(c.events[0].route, '/raids/1');
    assert.deepStrictEqual(c.ctx.events.recent(g.guildId, 2).map((e) => e.title), ['Releases always show', 'Recipe now']);
    // Old events are pruned.
    c.db.prepare("UPDATE events SET created_at = datetime('now', '-20 days') WHERE title = 'Everyone'").run();
    assert.strictEqual(c.ctx.events.prune(), 1);
  } finally {
    await c.close();
  }
});

// ---------- ctx ----------

test('ctx: Discord posts go to the webhook from Settings; audit, activity, latest()', async () => {
  const posts = [];
  let answer = 204;
  const settings = {};
  const c = await startCore({
    settings,
    latest: { app: '0.12.0', addon: '0.11.3' },
    fetch: async (url, init) => { posts.push({ url, body: JSON.parse(init.body) }); if (answer === 'throw') throw new Error('offline'); return { ok: answer < 300, status: answer }; },
  });
  try {
    const g = seedGuild(c.db);
    assert.strictEqual(await c.ctx.discord(null, 'nothing set'), false);
    assert.strictEqual(posts.length, 0);
    settings.discordWebhook = 'https://example.com/not-discord';
    assert.strictEqual(await c.ctx.discord(null, 'not a webhook'), false);
    settings.discordWebhook = WEBHOOK;
    assert.strictEqual(await c.ctx.discord({ discord_webhook: 'https://ignored.example' }, `x${'y'.repeat(3000)}`), true);
    assert.strictEqual(posts[0].url, WEBHOOK);
    assert.strictEqual(posts[0].body.content.length, 1900);
    assert.deepStrictEqual(posts[0].body.allowed_mentions, { parse: [] });
    answer = 500;
    assert.strictEqual(await c.ctx.discord(null, 'fails'), false);
    answer = 'throw';
    assert.strictEqual(await c.ctx.discord(null, 'offline'), false, 'never throws');

    c.ctx.audit({ guild: { id: g.guildId }, user: { id: g.me } }, 'did a thing', 'detail');
    c.ctx.audit(null, 'ignored');
    c.ctx.activity(g.guildId, 'test', 'A line');
    assert.strictEqual(c.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action = 'did a thing'").get().n, 1);
    assert.strictEqual(c.db.prepare("SELECT text FROM activity WHERE kind = 'test'").get().text, 'A line');
    assert.deepStrictEqual(c.ctx.latest(), { app: { version: '0.12.0' }, addon: { version: '0.11.3' } });
    assert.strictEqual(c.ctx.me().id, g.me);
    assert.strictEqual(c.ctx.guild().role, 'owner');
  } finally {
    await c.close();
  }
});

test('sharing seam: the upload hands payload.shared to importShared, the inbox carries exportOutbox', async () => {
  const c = await startCore();
  const orig = { importShared: sharing.importShared, exportOutbox: sharing.exportOutbox };
  const seen = [];
  sharing.importShared = (db, ctx, shared) => { seen.push({ shared, inTx: db.inTransaction, ctx: Boolean(ctx && ctx.emit) }); return { imported: 1 }; };
  sharing.exportOutbox = () => [{ type: 'hello' }];
  try {
    const r = await c.api.post('/api/sync', { characters: { Me: { name: 'Me', realm: 'Forever', guild: 'wow', updated: NOW() } }, shared: { records: [1, 2] } });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(seen, [{ shared: { records: [1, 2] }, inTx: true, ctx: true }]);
    assert.deepStrictEqual((await c.api.get('/api/inbox')).body.outbox, [{ type: 'hello' }]);
  } finally {
    Object.assign(sharing, orig);
    await c.close();
  }
  // The real importShared ignores anything that is not the addon's shared table (tests: test/core/sharing-*.test.js).
  const c2 = await startCore();
  try {
    assert.deepStrictEqual(sharing.importShared(c2.db, c2.ctx, 'nonsense').imported, 0);
    assert.deepStrictEqual(sharing.exportOutbox(c2.db), []);
  } finally {
    await c2.close();
  }
});

test('a database file on disk survives a restart; close() stops timers', async () => {
  const dir = tmpDir('gc-core-');
  try {
    let c = await startCore({ dataDir: dir, timers: true });
    assert.ok(c.ctx.timers.length > 0, 'background jobs started');
    await c.api.post('/api/sync', { characters: { Me: { name: 'Me', realm: 'Forever', guild: 'wow', updated: NOW() } } });
    await c.close();
    assert.strictEqual(c.ctx.timers.length, 0);
    assert.ok(fs.existsSync(path.join(dir, 'guildcamp.db')));
    c = await startCore({ dataDir: dir });
    assert.strictEqual((await c.api.get('/api/me')).body.guild.name, 'wow');
    assert.notStrictEqual(c.token, undefined);
    await c.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
