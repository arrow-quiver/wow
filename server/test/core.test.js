// Core server tests: config, db migrations, auth, guild, members, settings, devices, events, errors.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { startServer, seed, client, addUser, addDevice, addLegacyKey } = require('./helpers');
const { open, MIGRATIONS } = require('../src/db');
const { config } = require('../src/config');
const { createApp } = require('../src/app');
const A = require('../src/auth');
const H = require('../src/http');
const { rateLimit } = require('../src/ratelimit');
const { needPublisher, HttpError } = H;

// ---------- units ----------

test('config: defaults, production secret, updates dir next to the database', () => {
  const c = config({});
  assert.equal(c.port, 3000);
  assert.equal(c.baseUrl, 'http://localhost:3000');
  assert.equal(c.sessionSecret, 'dev-secret-change-me');
  assert.equal(c.timers, true);
  assert.equal(c.devLogin, false);
  assert.equal(typeof c.fetch, 'function');
  assert.ok(c.bundledAddonDir.endsWith(path.join('addon', 'WowGuild')));
  const p = config({ NODE_ENV: 'production', DB_FILE: '/data/wow.db', BASE_URL: 'https://x.example/', PUBLISH_TOKEN: 'pt', DEV_LOGIN: '1' });
  assert.equal(p.sessionSecret, null);
  assert.equal(p.baseUrl, 'https://x.example');
  assert.equal(p.publishToken, 'pt');
  assert.equal(p.devLogin, true);
  assert.equal(path.resolve(p.updatesDir), path.resolve('/data/updates'));
  assert.equal(config({ UPDATES_DIR: '/u' }).updatesDir, '/u');
  assert.equal(config({ NODE_ENV: 'test' }).timers, false);
  assert.throws(() => createApp(p, open(':memory:')), /SESSION_SECRET/);
});

test('http validators', () => {
  assert.equal(H.str('  hi  '), 'hi');
  assert.equal(H.str('abcdef', 3), 'abc');
  assert.equal(H.str(''), null);
  assert.equal(H.str('   '), null);
  assert.equal(H.str(null), null);
  assert.equal(H.str({ a: 1 }), null);
  assert.equal(H.str(42), '42');
  assert.equal(H.int('12.9'), 12);
  assert.equal(H.int('x'), null);
  assert.equal(H.int(''), null);
  assert.equal(H.int(true), null);
  assert.equal(H.int(99, 1, 40), 40);
  assert.equal(H.int(-5, 1, 40), 1);
  assert.equal(H.num('2.5', 0, 10), 2.5);
  assert.equal(H.num('1e9', 0, 500), 500);
  assert.equal(H.bool('on'), true);
  assert.equal(H.bool('0'), false);
  assert.equal(H.bool(1), true);
  assert.equal(H.bool(undefined), false);
  assert.equal(H.oneOf('a', ['a', 'b']), 'a');
  assert.equal(H.oneOf('c', ['a', 'b'], 'b'), 'b');
  assert.deepEqual(H.list({ 1: 'a', 2: 'b' }), ['a', 'b']);
  assert.deepEqual(H.list('nope'), []);
  assert.equal(H.list(new Array(50).fill(0), 10).length, 10);
  assert.equal(H.ver('0.11.0-beta.1'), '0.11.0-beta.1');
  assert.equal(H.ver('bad version'), null);
  assert.equal(H.esc('<a href="x">&\''), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
});

test('auth: tokens, signed state, constant-time compare', () => {
  const t = A.newDeviceToken();
  assert.match(t.raw, /^gcd_[\w-]{40,}$/);
  assert.equal(t.hash, A.hashToken(t.raw));
  assert.equal(t.prefix, t.raw.slice(0, 12));
  assert.equal(A.tokenKind(t.raw), 'device');
  assert.equal(A.tokenKind('wowg_abc'), 'legacy');
  assert.equal(A.tokenKind('something'), null);
  assert.equal(A.tokenKind('gcd_bad token'), null);
  assert.match(A.inviteCode(), /^[\w-]{8}$/);
  assert.equal(A.safeEqual('abc', 'abc'), true);
  assert.equal(A.safeEqual('abc', 'abcd'), false);
  assert.equal(A.safeEqual('', ''), false);

  const cfg = { sessionSecret: 's3cret' };
  const now = 1_000_000;
  const { state, nonce } = A.signState(cfg, { name: 'PC', platform: 'win32', appVersion: '0.11.0' }, now);
  const p = A.readState(cfg, state, now + 1000);
  assert.equal(p.nonce, nonce);
  assert.deepEqual(p.device, { name: 'PC', platform: 'win32', appVersion: '0.11.0' });
  assert.equal(A.readState(cfg, state, now + 11 * 60 * 1000), null, 'expires after 10 minutes');
  assert.equal(A.readState({ sessionSecret: 'other' }, state, now), null, 'other secret');
  const [body, mac] = state.split('.');
  const forged = Buffer.from(JSON.stringify({ ...p, device: { name: 'Evil' } })).toString('base64url');
  assert.equal(A.readState(cfg, `${forged}.${mac}`, now), null, 'altered payload');
  assert.equal(A.readState(cfg, body, now), null);
  assert.equal(A.readState(cfg, null, now), null);
});

test('rate limiter answers 429 with Retry-After once the limit is passed', () => {
  const mw = rateLimit({ max: 2, windowMs: 60000 });
  const codes = [];
  for (let i = 0; i < 3; i++) {
    const res = {
      headers: {}, setHeader(k, v) { this.headers[k] = v; },
      status(c) { codes.push(c); return this; }, json(b) { this.body = b; return this; },
    };
    mw({ ip: '1.2.3.4' }, res, () => codes.push(200));
    if (i === 2) {
      assert.ok(Number(res.headers['Retry-After']) > 0);
      assert.match(res.body.error, /Too many/);
    }
  }
  assert.deepEqual(codes, [200, 200, 429]);
});

// ---------- database ----------

test('db: new migrations apply on top of a database made by the old 10 migrations', () => {
  assert.ok(MIGRATIONS.length >= 13);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-mig-'));
  const file = path.join(dir, 'wow.db');
  try {
    // Simulate the production database: only the old migrations, schema_version 10, real data.
    const old = new Database(file);
    old.exec('CREATE TABLE schema_version (v INTEGER NOT NULL)');
    old.prepare('INSERT INTO schema_version (v) VALUES (0)').run();
    MIGRATIONS.slice(0, 10).forEach((sql, i) => old.transaction(() => {
      old.exec(sql);
      old.prepare('UPDATE schema_version SET v = ?').run(i + 1);
    })());
    old.prepare("INSERT INTO guilds (name, faction, invite_code) VALUES ('wow', 'Horde', 'abc')").run();
    old.prepare("INSERT INTO users (bnet_id, battletag) VALUES ('1', 'Old#1')").run();
    old.prepare("INSERT INTO memberships (user_id, guild_id, role) VALUES (1, 1, 'owner')").run();
    old.prepare("INSERT INTO api_tokens (user_id, guild_id, token_hash, prefix) VALUES (1, 1, 'h', 'wowg_x')").run();
    assert.equal(old.prepare('SELECT v FROM schema_version').get().v, 10);
    old.close();

    const db = open(file);
    assert.equal(db.prepare('SELECT v FROM schema_version').get().v, MIGRATIONS.length);
    assert.equal(db.prepare('SELECT name FROM guilds').get().name, 'wow');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM api_tokens').get().n, 1, 'legacy keys are kept');
    const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    assert.ok(cols('users').includes('notify_prefs'));
    assert.ok(cols('users').includes('app_version'));
    for (const c of ['id', 'user_id', 'guild_id', 'token_hash', 'prefix', 'name', 'platform', 'app_version', 'addon_version', 'created_at', 'last_used_at']) {
      assert.ok(cols('devices').includes(c), `devices.${c}`);
    }
    for (const c of ['guild_id', 'kind', 'title', 'body', 'route', 'user_id', 'except_user_id', 'officers_only', 'recipe', 'created_at']) {
      assert.ok(cols('events').includes(c), `events.${c}`);
    }
    for (const c of ['kind', 'version', 'notes', 'file', 'size', 'sha256', 'sha512', 'published_by', 'created_at']) {
      assert.ok(cols('releases').includes(c), `releases.${c}`);
    }
    assert.ok(cols('push_subs').length, 'push_subs stays');
    assert.throws(() => db.prepare("INSERT INTO releases (kind, version) VALUES ('other', '1.0.0')").run(), /CHECK/);
    assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
    assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
    db.close();

    // Opening again is a no-op.
    const again = open(file);
    assert.equal(again.prepare('SELECT v FROM schema_version').get().v, MIGRATIONS.length);
    again.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- HTTP ----------

test('meta, healthz, 404 and error JSON shapes, security headers', async () => {
  const srv = await startServer({
    baseUrl: 'https://camp.example',
    routes: ['auth', 'guild', 'events'],
    extraRoutes: [(app) => {
      app.get('/api/test/boom', () => { throw new Error('kaboom'); });
      app.get('/api/test/http', () => { throw new HttpError(418, 'I am a teapot.'); });
      app.get('/api/test/async', async () => { await Promise.resolve(); throw new HttpError(409, 'Async conflict.'); });
      app.post('/api/test/echo', (req, res) => res.json({ body: req.body }));
    }],
  });
  const anon = client(srv.url);
  try {
    const h = await anon.get('/healthz');
    assert.equal(h.status, 200);
    assert.deepEqual(h.body, { ok: true });
    assert.equal(h.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(h.headers.get('x-frame-options'), 'DENY');
    assert.equal(h.headers.get('referrer-policy'), 'same-origin');
    assert.equal(h.headers.get('content-security-policy'), "default-src 'none'; frame-ancestors 'none'");
    assert.match(h.headers.get('strict-transport-security'), /max-age=/);
    assert.equal(h.headers.get('x-powered-by'), null);

    let m = await anon.get('/api/meta');
    assert.equal(m.status, 200);
    assert.deepEqual(m.body, {
      server: 'guild-camp', version: require('../package.json').version, devLogin: true, bnet: false,
      guild: null, releases: { app: null, addon: null },
    });
    seed(srv.db, { guildName: 'Camp', faction: 'Alliance' });
    srv.db.prepare("INSERT INTO releases (kind, version, notes, file) VALUES ('addon', '0.11.0', 'old', 'a.zip'), ('addon', '0.11.1', 'new', 'b.zip'), ('app', '0.12.0', 'n', 'Guild-Camp-Setup-0.12.0.exe')").run();
    m = await anon.get('/api/meta');
    assert.deepEqual(m.body.guild, { name: 'Camp', faction: 'Alliance' });
    assert.equal(m.body.releases.addon.version, '0.11.1');
    assert.equal(m.body.releases.app.file, 'Guild-Camp-Setup-0.12.0.exe');

    let r = await anon.get('/api/nope');
    assert.equal(r.status, 404);
    assert.deepEqual(r.body, { error: 'Not found.' });
    r = await anon.get('/nothing-here');
    assert.deepEqual([r.status, r.body], [404, { error: 'Not found.' }]);

    const logged = [];
    const origError = console.error;
    console.error = (...a) => logged.push(a.join(' '));
    try { r = await anon.get('/api/test/boom'); } finally { console.error = origError; }
    assert.equal(r.status, 500);
    assert.deepEqual(r.body, { error: 'Something went wrong on the server. Try again in a minute.' });
    assert.ok(logged.some((l) => l.includes('kaboom')), 'stack is logged');

    r = await anon.get('/api/test/http');
    assert.deepEqual([r.status, r.body], [418, { error: 'I am a teapot.' }]);
    r = await anon.get('/api/test/async');
    assert.deepEqual([r.status, r.body], [409, { error: 'Async conflict.' }]);

    r = await anon.raw('POST', '/api/test/echo', { headers: { 'Content-Type': 'application/json' }, body: '{nope' });
    assert.deepEqual([r.status, r.body], [400, { error: 'That request was not valid JSON.' }]);
    r = await anon.post('/api/test/echo');
    assert.deepEqual(r.body, { body: {} }, 'no body → {}');
    r = await anon.post('/api/test/echo', { a: 1 });
    assert.deepEqual(r.body, { body: { a: 1 } });
  } finally {
    await srv.close();
  }
});

test('dev sign-in, me, notification prefs, X-App-Version', async () => {
  const srv = await startServer();
  const anon = client(srv.url);
  try {
    let r = await anon.post('/api/auth/dev', { battletag: 'nobody' });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /BattleTag like Name#1234/);
    r = await anon.post('/api/auth/dev', { battletag: 'Bob#1234', device: { name: 'Desk\u0007PC', platform: 'Win32', appVersion: '0.11.0' } });
    assert.equal(r.status, 200);
    assert.match(r.body.token, /^gcd_/);
    assert.equal(r.body.user.battletag, 'Bob#1234');
    assert.equal(r.body.user.name, 'Bob');
    assert.equal(r.body.user.bnet_id, undefined);
    const token = r.body.token;
    const dev = srv.db.prepare('SELECT * FROM devices').get();
    assert.equal(dev.name, 'Desk PC');
    assert.equal(dev.platform, 'win32');
    assert.equal(dev.app_version, '0.11.0');
    assert.notEqual(dev.token_hash, token, 'only the hash is stored');
    assert.equal(srv.db.prepare('SELECT bnet_id FROM users').get().bnet_id, 'dev:Bob#1234');

    r = await anon.post('/api/auth/dev', { battletag: 'Bob#1234', device: { platform: 'not a platform!' } });
    assert.equal(r.status, 400);
    r = await anon.post('/api/auth/dev', { battletag: 'Bob#1234', device: 'Laptop' });
    assert.equal(r.status, 200);
    assert.equal(srv.db.prepare('SELECT COUNT(*) n FROM users').get().n, 1, 'same user signs in again');
    assert.equal(srv.db.prepare('SELECT COUNT(*) n FROM devices').get().n, 2, 'one device per sign-in');

    r = await anon.get('/api/me');
    assert.deepEqual([r.status, r.body], [401, { error: 'Sign in first.' }]);

    const bob = client(srv.url, token);
    r = await bob.get('/api/me');
    assert.equal(r.status, 200);
    assert.equal(r.body.user.battletag, 'Bob#1234');
    assert.equal(r.body.guild, null);
    assert.equal(r.body.role, null);
    assert.equal(r.body.device.name, 'Desk PC');
    assert.equal(r.body.device.current, true);
    assert.equal(r.body.device.token_hash, undefined);
    assert.deepEqual(r.body.notifyPrefs, { cta: true, raids: true, notices: true, requests: true, bank: true, coach: true, drives: true });

    r = await bob.put('/api/me/notifications', { raids: false, bank: 'no', bogus: false });
    assert.equal(r.status, 200);
    assert.equal(r.body.notifyPrefs.raids, false);
    assert.equal(r.body.notifyPrefs.bank, true, 'non-booleans are ignored');
    assert.equal(r.body.notifyPrefs.bogus, undefined);
    r = await bob.put('/api/me/notifications', { notifyPrefs: { cta: false } });
    assert.equal(r.body.notifyPrefs.cta, false);
    assert.equal(r.body.notifyPrefs.raids, false, 'earlier choices are kept');
    assert.equal((await bob.get('/api/me')).body.notifyPrefs.cta, false);

    // The app sends X-App-Version on every call; the device and user follow it.
    r = await bob.raw('GET', '/api/me', { headers: { 'X-App-Version': '0.12.0' } });
    assert.equal(r.body.device.app_version, '0.12.0');
    assert.equal(srv.db.prepare('SELECT app_version FROM users').get().app_version, '0.12.0');
    assert.ok(srv.db.prepare('SELECT last_used_at FROM devices WHERE name = ?').get('Desk PC').last_used_at);

    // A token that no longer exists gets a clear message.
    r = await client(srv.url, 'gcd_doesnotexist').get('/api/me');
    assert.equal(r.status, 401);
    assert.match(r.body.error, /signed out/);
  } finally {
    await srv.close();
  }

  const off = await startServer({ devLogin: false });
  try {
    const r = await client(off.url).post('/api/auth/dev', { battletag: 'Bob#1234' });
    assert.deepEqual([r.status, r.body], [404, { error: 'Not found.' }]);
  } finally {
    await off.close();
  }
});

test('guild create, invite preview, join, guild info, invite reset', async () => {
  const srv = await startServer({ baseUrl: 'https://camp.example' });
  const signIn = async (bt) => client(srv.url, (await client(srv.url).post('/api/auth/dev', { battletag: bt })).body.token);
  try {
    const alice = await signIn('Alice#1');
    const bob = await signIn('Bob#2');
    const carl = await signIn('Carl#3');

    let r = await alice.get('/api/guild');
    assert.deepEqual([r.status, r.body], [403, { error: 'Join a guild first.' }]);

    r = await alice.post('/api/guild', { name: '  The Camp  ', faction: 'Alliance' });
    assert.equal(r.status, 201);
    assert.equal(r.body.role, 'owner');
    assert.equal(r.body.guild.name, 'The Camp');
    assert.equal(r.body.guild.faction, 'Alliance');
    assert.equal(r.body.guild.wowhead_game, 'forever');
    const code = r.body.guild.invite_code;
    assert.equal(r.body.guild.inviteUrl, `https://camp.example/join/${code}`);
    assert.equal(r.body.guild.discord_webhook, null, 'owner sees the webhook field');
    const gid = r.body.guild.id;
    assert.equal(srv.db.prepare('SELECT guild_id FROM devices WHERE user_id = (SELECT id FROM users WHERE battletag = ?)').get('Alice#1').guild_id, gid);
    assert.match(srv.db.prepare("SELECT text FROM activity WHERE kind = 'guild'").get().text, /Alice lit the campfire/);

    r = await alice.post('/api/guild', { name: 'Again' });
    assert.deepEqual([r.status, r.body], [400, { error: 'You are already in a guild.' }]);
    r = await bob.post('/api/guild', { name: 'Second' });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /already has a guild/);

    // Public invite preview.
    r = await client(srv.url).get(`/api/guild/invite/${code}`);
    assert.deepEqual([r.status, r.body], [200, { guild: { name: 'The Camp', faction: 'Alliance', members: 1 } }]);
    r = await client(srv.url).get('/api/guild/invite/nope');
    assert.equal(r.status, 404);
    assert.match(r.body.error, /invite link doesn't work/);

    r = await bob.post('/api/guild/join', { code: 'wrong' });
    assert.equal(r.status, 404);
    r = await bob.post('/api/guild/join', { code });
    assert.deepEqual([r.status, r.body.role], [200, 'member']);
    assert.equal(r.body.guild.discord_webhook, undefined, 'members never see the webhook');
    assert.equal(r.body.guild.invite_code, code, 'members see the invite code');
    r = await bob.post('/api/guild/join', { code });
    assert.equal(r.status, 200, 'joining again is harmless');
    assert.equal(srv.db.prepare('SELECT COUNT(*) n FROM memberships').get().n, 2);
    assert.ok(srv.db.prepare("SELECT 1 FROM activity WHERE text = 'Bob joined the camp'").get());

    // A pasted link works as well as a bare code.
    r = await carl.post('/api/guild/join', { code: `guildcamp://join/${code}` });
    assert.equal(r.status, 200);

    r = await bob.get('/api/guild');
    assert.equal(r.status, 200);
    assert.equal(r.body.guild.role, 'member');
    assert.equal(r.body.guild.inviteUrl, `https://camp.example/join/${code}`);
    assert.equal('discord_webhook' in r.body.guild, false);
    assert.equal(r.body.memberCount, 3);
    assert.deepEqual(r.body.options.wowheadGames.map((g) => g.value), ['forever', 'retail', 'classic']);

    r = await bob.post('/api/guild/invite/reset');
    assert.deepEqual([r.status, r.body], [403, { error: 'Officers only.' }]);
    r = await alice.post('/api/guild/invite/reset');
    assert.equal(r.status, 200);
    assert.notEqual(r.body.invite_code, code);
    assert.equal(r.body.inviteUrl, `https://camp.example/join/${r.body.invite_code}`);
    assert.match(r.body.message, /old one no longer works/);
    assert.equal((await client(srv.url).get(`/api/guild/invite/${code}`)).status, 404);
    assert.ok(srv.db.prepare("SELECT 1 FROM audit_log WHERE action = 'invite link replaced'").get());

    const me = await bob.get('/api/me');
    assert.equal(me.body.role, 'member');
    assert.equal(me.body.guild.name, 'The Camp');
  } finally {
    await srv.close();
  }
});

test('guild create defaults: name "wow" and faction Horde', async () => {
  const srv = await startServer();
  try {
    const u = addUser(srv.db, 'Solo#1');
    const r = await client(srv.url, u.token).post('/api/guild', { faction: 'Pirates' });
    assert.equal(r.status, 201);
    assert.equal(r.body.guild.name, 'wow');
    assert.equal(r.body.guild.faction, 'Horde');
  } finally {
    await srv.close();
  }
});

test('member roles: promote, demote, remove, owner protection', async () => {
  const srv = await startServer();
  const s = seed(srv.db);
  const owner = client(srv.url, s.owner.token);
  const officer = client(srv.url, s.officer.token);
  const member = client(srv.url, s.member.token);
  const role = (id) => (srv.db.prepare('SELECT role FROM memberships WHERE user_id = ?').get(id) || {}).role;
  try {
    // Everyone in the guild can list members.
    srv.db.prepare("INSERT INTO characters (guild_id, user_id, name, class, level, is_main) VALUES (?,?,?,?,?,?)").run(s.guildId, s.member.id, 'Alt', 'MAGE', 20, 0);
    srv.db.prepare("INSERT INTO characters (guild_id, user_id, name, class, level, is_main) VALUES (?,?,?,?,?,?)").run(s.guildId, s.member.id, 'Mainy', 'ROGUE', 18, 1);
    srv.db.prepare("UPDATE users SET addon_version = '0.11.0', app_version = '0.11.0', last_sync_at = datetime('now') WHERE id = ?").run(s.member.id);
    let r = await member.get('/api/members');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.members.map((m) => m.role), ['owner', 'officer', 'member']);
    const mem = r.body.members.find((m) => m.id === s.member.id);
    assert.equal(mem.battletag, 'Member#3333');
    assert.equal(mem.characters, 2);
    assert.deepEqual(mem.main, { name: 'Mainy', class: 'ROGUE', level: 18, is_main: 1 });
    assert.equal(mem.addon_version, '0.11.0');
    assert.equal(mem.app_version, '0.11.0');
    assert.ok(mem.last_sync_at);
    assert.equal(mem.devices, 1);
    assert.equal(r.body.members.find((m) => m.id === s.owner.id).main, null);

    // Members can't manage anyone.
    r = await member.post(`/api/members/${s.officer.id}/promote`);
    assert.deepEqual([r.status, r.body], [403, { error: 'Officers only.' }]);

    // Officers can promote members, but not officers or the owner.
    const extra = addUser(srv.db, 'Extra#4444', { guildId: s.guildId });
    r = await officer.post(`/api/members/${extra.id}/promote`);
    assert.equal(r.status, 200);
    assert.match(r.body.message, /Extra is now an officer/);
    assert.equal(role(extra.id), 'officer');
    r = await officer.post(`/api/members/${extra.id}/promote`);
    assert.equal(r.status, 400);
    r = await officer.post(`/api/members/${s.owner.id}/promote`);
    assert.equal(r.status, 400);
    assert.equal(role(s.owner.id), 'owner');

    // Only the owner may demote officers.
    r = await officer.post(`/api/members/${extra.id}/demote`);
    assert.deepEqual([r.status, r.body], [403, { error: 'Only the guild owner can demote officers.' }]);
    r = await owner.post(`/api/members/${extra.id}/demote`);
    assert.equal(r.status, 200);
    assert.equal(role(extra.id), 'member');
    r = await owner.post(`/api/members/${extra.id}/demote`);
    assert.equal(r.status, 400, 'members cannot be demoted');

    // Nobody removes the owner; officers can't remove officers or themselves.
    r = await officer.post(`/api/members/${s.owner.id}/remove`);
    assert.equal(r.status, 403);
    assert.equal(role(s.owner.id), 'owner');
    r = await owner.post(`/api/members/${s.owner.id}/remove`);
    assert.equal(r.status, 403);
    const officer2 = addUser(srv.db, 'Officer2#5555', { guildId: s.guildId, role: 'officer' });
    r = await officer.post(`/api/members/${officer2.id}/remove`);
    assert.deepEqual([r.status, r.body], [403, { error: 'Only the guild owner can remove officers.' }]);
    r = await officer.post(`/api/members/${s.officer.id}/remove`);
    assert.equal(r.status, 400);
    r = await officer.post('/api/members/99999/remove');
    assert.equal(r.status, 404);
    r = await officer.post('/api/members/abc/remove');
    assert.equal(r.status, 404);

    // Officers remove members: devices, sync keys and character links go with them.
    const legacy = addLegacyKey(srv.db, s.member.id, s.guildId);
    srv.db.prepare("UPDATE users SET discord_id = '555' WHERE id = ?").run(s.member.id);
    srv.db.prepare("INSERT INTO link_codes (code, user_id, guild_id, expires_at) VALUES ('ABCD1234', ?, ?, ?)")
      .run(s.member.id, s.guildId, new Date(Date.now() + 15 * 60000).toISOString());
    r = await officer.post(`/api/members/${s.member.id}/remove`);
    assert.equal(r.status, 200);
    assert.match(r.body.message, /Member was removed/);
    assert.equal(role(s.member.id), undefined);
    assert.equal(srv.db.prepare('SELECT COUNT(*) n FROM devices WHERE user_id = ?').get(s.member.id).n, 0);
    assert.equal(srv.db.prepare('SELECT COUNT(*) n FROM api_tokens WHERE user_id = ?').get(s.member.id).n, 0);
    assert.equal(srv.db.prepare('SELECT COUNT(*) n FROM characters WHERE user_id = ?').get(s.member.id).n, 0);
    assert.equal(srv.db.prepare("SELECT COUNT(*) n FROM characters WHERE name IN ('Alt','Mainy') AND is_main = 0").get().n, 2);
    assert.equal(srv.db.prepare('SELECT discord_id FROM users WHERE id = ?').get(s.member.id).discord_id, null, 'Discord unlinked');
    assert.equal(srv.db.prepare('SELECT COUNT(*) n FROM link_codes WHERE user_id = ?').get(s.member.id).n, 0, 'pending link codes dropped');
    assert.equal((await member.get('/api/me')).status, 401, 'removed member is signed out');
    assert.ok(legacy);

    // The owner can remove officers.
    r = await owner.post(`/api/members/${officer2.id}/remove`);
    assert.equal(r.status, 200);

    const actions = srv.db.prepare('SELECT action FROM audit_log ORDER BY id').all().map((a) => a.action);
    assert.deepEqual(actions, ['promoted to officer', 'demoted to member', 'removed from guild', 'removed from guild']);
  } finally {
    await srv.close();
  }
});

test('guild settings: validation, partial updates, audit', async () => {
  const srv = await startServer();
  const s = seed(srv.db);
  const officer = client(srv.url, s.officer.token);
  const member = client(srv.url, s.member.token);
  const guild = () => srv.db.prepare('SELECT * FROM guilds WHERE id = ?').get(s.guildId);
  const hook = 'https://discord.com/api/webhooks/123/abc-DEF_1';
  try {
    let r = await member.put('/api/guild/settings', { discord_webhook: hook });
    assert.equal(r.status, 403);

    r = await officer.put('/api/guild/settings', {});
    assert.deepEqual([r.status, r.body], [400, { error: 'Nothing to save.' }]);

    r = await officer.put('/api/guild/settings', { discord_webhook: 'https://evil.example/api/webhooks/1/x' });
    assert.deepEqual([r.status, r.body], [400, { error: "That isn't a Discord webhook URL." }]);

    // All or nothing: a bad field means nothing is saved.
    r = await officer.put('/api/guild/settings', { discord_webhook: hook, wowhead_game: 'tbc' });
    assert.equal(r.status, 400);
    assert.equal(guild().discord_webhook, null);

    r = await officer.put('/api/guild/settings', { discord_webhook: hook });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.messages, ['Webhook saved.']);
    assert.equal(r.body.guild.discord_webhook, hook);
    assert.equal(guild().discord_webhook, hook);
    r = await member.get('/api/guild');
    assert.equal(r.body.guild.discord_webhook, undefined);

    r = await officer.put('/api/guild/settings', { discord_webhook: '' });
    assert.deepEqual(r.body.messages, ['Webhook removed.']);
    assert.equal(guild().discord_webhook, null);

    r = await officer.put('/api/guild/settings', { wowhead_game: 'retail' });
    assert.deepEqual(r.body.messages, ["Item tooltips now use Wowhead's Retail database."]);
    assert.equal(guild().wowhead_game, 'retail');

    srv.db.prepare("UPDATE guilds SET realm_status = '{\"up\":true}', official_roster_at = datetime('now') WHERE id = ?").run(s.guildId);
    assert.deepEqual((await member.get('/api/guild')).body.guild.realm_status, { up: true });
    r = await officer.put('/api/guild/settings', { realm: '  Mirage Raceway ', game_guild: 'wow' });
    assert.equal(r.status, 200);
    assert.equal(guild().realm, 'Mirage Raceway');
    assert.equal(guild().game_guild, 'wow');
    assert.equal(guild().realm_status, null);
    assert.equal(guild().official_roster_at, null);
    r = await officer.put('/api/guild/settings', { realm: 'Other' });
    assert.equal(guild().game_guild, 'wow', 'game guild kept when only the realm changes');

    r = await officer.put('/api/guild/settings', { coach_budget_usd: 'lots' });
    assert.equal(r.status, 400);
    r = await officer.put('/api/guild/settings', { coach_enabled: false, coach_budget_usd: 9999 });
    assert.equal(r.status, 200);
    assert.equal(guild().coach_enabled, 0);
    assert.equal(guild().coach_budget_usd, 500);
    r = await officer.put('/api/guild/settings', { coach_enabled: true });
    assert.equal(guild().coach_enabled, 1);
    assert.equal(guild().coach_budget_usd, 500, 'budget kept');

    const audit = srv.db.prepare('SELECT action, detail, user_id FROM audit_log ORDER BY id').all();
    assert.deepEqual(audit.map((a) => a.action), [
      'Discord webhook set', 'Discord webhook removed', 'Wowhead tooltips set', 'realm set', 'realm set', 'coach settings', 'coach settings',
    ]);
    assert.equal(audit[3].detail, 'Mirage Raceway / wow');
    assert.equal(audit[5].detail, 'off, $500/month');
    assert.ok(audit.every((a) => a.user_id === s.officer.id));
  } finally {
    await srv.close();
  }
});

test('devices: list, revoke own only, sign out, legacy sync keys', async () => {
  const srv = await startServer();
  const s = seed(srv.db);
  const second = addDevice(srv.db, s.member.id, s.guildId, 'Laptop');
  const key = addLegacyKey(srv.db, s.member.id, s.guildId);
  const member = client(srv.url, s.member.token);
  try {
    let r = await member.get('/api/devices');
    assert.equal(r.status, 200);
    assert.equal(r.body.devices.length, 2);
    assert.equal(r.body.devices.find((d) => d.id === s.member.deviceId).current, true);
    assert.equal(r.body.devices.find((d) => d.id === second.deviceId).current, false);
    assert.ok(r.body.devices.every((d) => d.token_hash === undefined));
    assert.equal(r.body.syncKeys.length, 1);
    assert.equal(r.body.syncKeys[0].prefix, key.slice(0, 10));

    r = await member.del(`/api/devices/${s.owner.deviceId}`);
    assert.deepEqual([r.status, r.body], [404, { error: 'Device not found.' }]);
    assert.equal((await client(srv.url, s.owner.token).get('/api/me')).status, 200);

    r = await member.del(`/api/devices/${second.deviceId}`);
    assert.deepEqual([r.status, r.body], [200, { ok: true, current: false }]);
    assert.equal((await client(srv.url, second.token).get('/api/me')).status, 401);

    r = await member.del('/api/sync-keys/99999');
    assert.equal(r.status, 404);
    const keyId = srv.db.prepare('SELECT id FROM api_tokens').get().id;
    r = await client(srv.url, s.owner.token).del(`/api/sync-keys/${keyId}`);
    assert.equal(r.status, 404, "someone else's key");
    r = await member.del(`/api/sync-keys/${keyId}`);
    assert.deepEqual([r.status, r.body], [200, { ok: true }]);

    r = await member.post('/api/auth/signout');
    assert.deepEqual([r.status, r.body], [200, { ok: true }]);
    assert.equal((await member.get('/api/me')).status, 401);
    assert.equal(srv.db.prepare('SELECT COUNT(*) n FROM devices WHERE user_id = ?').get(s.member.id).n, 0);
  } finally {
    await srv.close();
  }
});

test('events: targeting, recipes, prefs, cursor, paging, pruning', async () => {
  const srv = await startServer();
  const s = seed(srv.db);
  const { ctx } = srv;
  const owner = client(srv.url, s.owner.token);
  const officer = client(srv.url, s.officer.token);
  const member = client(srv.url, s.member.token);
  const titles = async (c, after) => (await c.get(`/api/events?after=${after}`)).body.events.map((e) => e.title);
  try {
    // No cursor: nothing, just where to start.
    ctx.emit(s.guildId, 'notice', { title: 'Before the app started' });
    let r = await member.get('/api/events');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.events, []);
    const start = r.body.latestId;
    assert.ok(start > 0);

    ctx.emit(s.guildId, 'cta', { title: 'Everyone', body: 'Fight at the crossroads', route: '/' });
    ctx.emit(s.guildId, 'coach', { title: 'Only member', userId: s.member.id, route: '/coach' });
    ctx.emit(s.guildId, 'cta', { title: 'Not officer', exceptUserId: s.officer.id });
    ctx.emit(s.guildId, 'bank', { title: 'Officers only', officersOnly: true, route: '/bank' });
    srv.db.prepare('INSERT INTO characters (guild_id, user_id, name) VALUES (?,?,?)').run(s.guildId, s.member.id, 'Crafty');
    const charId = srv.db.prepare("SELECT id FROM characters WHERE name = 'Crafty'").get().id;
    srv.db.prepare("INSERT INTO recipes (character_id, profession, name) VALUES (?, 'Alchemy', 'Flask of the Titans')").run(charId);
    ctx.emit(s.guildId, 'request', { title: 'Crafters', recipe: 'flask of the TITANS', exceptUserId: s.owner.id });
    ctx.emit(s.guildId, 'raid', { title: 'Two people', userIds: [s.member.id, s.owner.id, s.member.id] });
    assert.equal(ctx.emit(s.guildId, 'raid', { title: 'Nobody', userIds: [] }), null);
    ctx.emit(s.guildId + 1, 'cta', { title: 'Other guild' });

    assert.deepEqual(await titles(member, start), ['Everyone', 'Only member', 'Not officer', 'Crafters', 'Two people']);
    assert.deepEqual(await titles(officer, start), ['Everyone', 'Officers only']);
    assert.deepEqual(await titles(owner, start), ['Everyone', 'Not officer', 'Officers only', 'Two people']);

    r = await member.get(`/api/events?after=${start}`);
    const ev = r.body.events[0];
    assert.deepEqual(Object.keys(ev).sort(), ['body', 'created_at', 'id', 'kind', 'route', 'title']);
    assert.equal(ev.kind, 'cta');
    assert.equal(ev.body, 'Fight at the crossroads');
    assert.equal(ev.route, '/');
    // The cursor moves past events meant for others too.
    const latest = r.body.latestId;
    assert.equal(latest, srv.db.prepare('SELECT MAX(id) id FROM events WHERE guild_id = ?').get(s.guildId).id);
    r = await officer.get(`/api/events?after=${start}`);
    assert.equal(r.body.latestId, latest);
    assert.deepEqual((await member.get(`/api/events?after=${latest}`)).body, { events: [], latestId: latest });

    // A cursor from the future (database replaced) resets to the newest id.
    assert.deepEqual((await member.get('/api/events?after=999999')).body, { events: [], latestId: latest });
    assert.equal((await member.get('/api/events?after=abc')).status, 400);

    // Prefs: raids off hides raid events; release has no switch and always shows.
    await member.put('/api/me/notifications', { raids: false });
    ctx.emit(s.guildId, 'raid', { title: 'Raid soon' });
    ctx.emit(s.guildId, 'release', { title: 'Guild Camp 0.12.0' });
    r = await member.get(`/api/events?after=${latest}`);
    assert.deepEqual(r.body.events.map((e) => e.title), ['Guild Camp 0.12.0']);
    assert.ok(r.body.latestId > latest);
    assert.deepEqual(await titles(owner, latest), ['Raid soon', 'Guild Camp 0.12.0']);

    // Bad input is cleaned, never thrown.
    const warn = console.warn;
    console.warn = () => {};
    try {
      assert.equal(ctx.emit(null, 'cta', { title: 'x' }), null);
      assert.equal(ctx.emit(s.guildId, 'Bad Kind!', { title: 'x' }), null);
    } finally { console.warn = warn; }
    const id = ctx.emit(s.guildId, 'notice', { title: 'x'.repeat(500), body: 'y'.repeat(1000), route: 'javascript:alert(1)' });
    const row = srv.db.prepare('SELECT * FROM events WHERE id = ?').get(id);
    assert.equal(row.title.length, 120);
    assert.equal(row.body.length, 300);
    assert.equal(row.route, null);

    // Paging: a full page hands back the last id scanned.
    const before = (await owner.get('/api/events')).body.latestId;
    for (let i = 0; i < 150; i++) ctx.emit(s.guildId, 'notice', { title: `n${i}` });
    r = await owner.get(`/api/events?after=${before}`);
    assert.equal(r.body.events.length, 100);
    assert.equal(r.body.latestId, r.body.events[99].id);
    r = await owner.get(`/api/events?after=${r.body.latestId}`);
    assert.equal(r.body.events.length, 50);
    assert.equal(r.body.events[49].title, 'n149');

    // Users without a guild just get nothing.
    const loner = addUser(srv.db, 'Loner#9');
    assert.deepEqual((await client(srv.url, loner.token).get('/api/events?after=0')).body, { events: [], latestId: 0 });
    assert.equal((await client(srv.url).get('/api/events')).status, 401);

    // Pruning: older than 14 days goes.
    srv.db.prepare("INSERT INTO events (guild_id, kind, title, created_at) VALUES (?, 'notice', 'ancient', datetime('now', '-15 days'))").run(s.guildId);
    assert.equal(ctx.events.prune(), 1);
    assert.equal(srv.db.prepare("SELECT COUNT(*) n FROM events WHERE title = 'ancient'").get().n, 0);
  } finally {
    await srv.close();
  }
});

test('legacy wowg_ sync keys work only on sync paths and only for current members', async () => {
  const seen = [];
  const probe = (req, res) => {
    seen.push({ user: req.user && req.user.id, guild: req.guild && req.guild.id, role: req.guild && req.guild.role, legacy: req.legacyKey, device: req.device });
    res.json({ ok: true });
  };
  const srv = await startServer({
    routes: ['auth', 'guild', 'events'],
    extraRoutes: [(app) => {
      app.post('/api/sync', probe);
      app.get('/api/inbox', probe);
      app.get('/api/inbox.lua', probe);
      app.get('/api/other', probe);
    }],
  });
  const s = seed(srv.db);
  const key = addLegacyKey(srv.db, s.member.id, s.guildId);
  const legacy = client(srv.url, key);
  try {
    await legacy.post('/api/sync', { characters: [] });
    await legacy.get('/api/inbox');
    await legacy.get('/api/inbox.lua');
    assert.equal(seen.length, 3);
    for (const x of seen) {
      assert.equal(x.user, s.member.id);
      assert.equal(x.guild, s.guildId);
      assert.equal(x.role, 'member');
      assert.equal(x.device, null);
      assert.equal(x.legacy.prefix, key.slice(0, 10));
    }
    assert.ok(srv.db.prepare('SELECT last_used_at FROM api_tokens').get().last_used_at);

    await legacy.get('/api/other');
    assert.equal(seen[3].user, null, 'not accepted elsewhere');
    let r = await legacy.get('/api/me');
    assert.equal(r.status, 401);
    assert.match(r.body.error, /sync key no longer works/);
    r = await legacy.get('/api/guild');
    assert.equal(r.status, 401);

    // Once the owner of the key leaves the guild, the key stops working.
    srv.db.prepare('DELETE FROM memberships WHERE user_id = ?').run(s.member.id);
    await legacy.get('/api/inbox');
    assert.equal(seen[4].user, null);
    await client(srv.url, 'wowg_unknown').post('/api/sync', {});
    assert.equal(seen[5].user, null);
  } finally {
    await srv.close();
  }
});

test('needPublisher: owner device or PUBLISH_TOKEN; PUT upload bodies are not parsed, POST commit is', async () => {
  const srv = await startServer({
    publishToken: 'release-token-123',
    routes: ['auth'],
    extraRoutes: [(app) => {
      app.put('/api/publish/test', needPublisher, (req, res) => {
        let n = 0;
        req.on('data', (c) => { n += c.length; });
        req.on('end', () => res.json({ via: req.publisher.via, userId: req.publisher.userId, parsed: req.body !== undefined, bytes: n }));
      });
      app.post('/api/publish/test/commit', needPublisher, (req, res) => res.json({ body: req.body }));
    }],
  });
  const s = seed(srv.db);
  const put = (token, body = '{"a":1}') => client(srv.url, token).raw('PUT', '/api/publish/test', { headers: { 'Content-Type': 'application/json' }, body });
  try {
    let r = await put(s.owner.token);
    assert.deepEqual(r.body, { via: 'owner', userId: s.owner.id, parsed: false, bytes: 7 });
    r = await put('release-token-123', Buffer.alloc(1024, 1));
    assert.deepEqual(r.body, { via: 'token', userId: null, parsed: false, bytes: 1024 });
    r = await put(s.officer.token);
    assert.equal(r.status, 403);
    r = await put('release-token-12');
    assert.equal(r.status, 403);
    r = await put(null);
    assert.equal(r.status, 401);
    r = await put('gcd_revoked');
    assert.equal(r.status, 401);
    r = await client(srv.url, 'release-token-123').post('/api/publish/test/commit', { version: '0.11.1' });
    assert.deepEqual([r.status, r.body], [200, { body: { version: '0.11.1' } }]);
  } finally {
    await srv.close();
  }
  // No PUBLISH_TOKEN configured: an empty bearer never matches.
  const none = await startServer({ routes: [], extraRoutes: [(app) => app.put('/api/publish/x', needPublisher, (req, res) => res.json({ ok: true }))] });
  try {
    assert.equal((await client(none.url, 'anything').raw('PUT', '/api/publish/x', { body: 'x' })).status, 403);
  } finally {
    await none.close();
  }
});

test('rate limits answer 429 JSON with Retry-After', async () => {
  const srv = await startServer({ rateLimits: { auth: 2, sync: 1 }, routes: ['auth'] });
  const anon = client(srv.url);
  try {
    assert.equal((await anon.post('/api/auth/dev', { battletag: 'A#1' })).status, 200);
    assert.equal((await anon.post('/api/auth/dev', { battletag: 'A#1' })).status, 200);
    const r = await anon.post('/api/auth/dev', { battletag: 'A#1' });
    assert.equal(r.status, 429);
    assert.match(r.body.error, /Too many sign-in attempts/);
    assert.ok(Number(r.headers.get('retry-after')) > 0);
    const h = await anon.get('/auth/app/done');
    assert.equal(h.status, 429, 'the /auth pages share the sign-in limit');
    assert.match(h.headers.get('content-type'), /html/);
    // /api/sync is limited per token (the sync route itself isn't loaded here, hence 404).
    const a = client(srv.url, 'gcd_a');
    const b = client(srv.url, 'gcd_b');
    assert.equal((await a.post('/api/sync', {})).status, 404);
    assert.equal((await a.post('/api/sync', {})).status, 429);
    assert.equal((await b.post('/api/sync', {})).status, 404);
  } finally {
    await srv.close();
  }
});

test('ctx: discord webhook poster, audit, activity, latest()', async () => {
  const calls = [];
  let fail = false;
  const fetchStub = async (url, init) => {
    calls.push({ url, init });
    if (fail) throw new Error('network down');
    return { ok: true, status: 204 };
  };
  const srv = await startServer({ fetch: fetchStub, routes: [] });
  const { ctx, db } = srv;
  const warn = console.warn;
  console.warn = () => {};
  try {
    const s = seed(db);
    assert.equal(await ctx.discord({ discord_webhook: null }, 'hi'), false);
    assert.equal(await ctx.discord(null, 'hi'), false);
    assert.equal(calls.length, 0);
    assert.equal(await ctx.discord({ discord_webhook: 'https://discord.com/api/webhooks/1/x' }, 'x'.repeat(3000)), true);
    assert.equal(calls[0].url, 'https://discord.com/api/webhooks/1/x');
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.content.length, 1900);
    assert.deepEqual(body.allowed_mentions, { parse: [] });
    fail = true;
    assert.equal(await ctx.discord({ discord_webhook: 'https://discord.com/api/webhooks/1/x' }, 'hi'), false, 'never throws');

    ctx.audit({ guild: { id: s.guildId }, user: { id: s.owner.id } }, 'did a thing', 'd'.repeat(400));
    ctx.audit({ guild: null, user: { id: 1 } }, 'ignored');
    const a = db.prepare('SELECT * FROM audit_log').all();
    assert.equal(a.length, 1);
    assert.equal(a[0].detail.length, 300);
    ctx.activity(s.guildId, 'raid', 'Raid scheduled');
    assert.equal(db.prepare('SELECT text FROM activity').get().text, 'Raid scheduled');

    assert.deepEqual(ctx.latest(), { app: null, addon: null });
    db.prepare("INSERT INTO releases (kind, version, notes, file, size) VALUES ('app', '0.11.1', 'fix', 'Guild-Camp-Setup-0.11.1.exe', 10)").run();
    assert.equal(ctx.latest().app.version, '0.11.1');
    assert.equal(ctx.latest().addon, null);
    ctx.services.releases = { latest: () => ({ app: { version: '9.9.9' }, addon: null }) };
    assert.equal(ctx.latest().app.version, '9.9.9', 'the releases service wins when present');
    assert.ok(Array.isArray(ctx.timers));
    assert.deepEqual(ctx.services.releases && Object.keys(ctx.services), ['releases']);
  } finally {
    console.warn = warn;
    await srv.close();
  }
});

test('Battle.net sign-in: state, nonce cookie, token in the fragment, error pages', async () => {
  let bnetDown = false;
  const fetchStub = async (url, init) => {
    if (bnetDown) return { ok: false, status: 503, json: async () => ({}) };
    if (url === 'https://oauth.battle.net/token') {
      assert.match(init.headers.Authorization, /^Basic /);
      assert.equal(new URLSearchParams(init.body).get('code'), 'good-code');
      return { ok: true, status: 200, json: async () => ({ access_token: 'at' }) };
    }
    if (url === 'https://oauth.battle.net/userinfo') return { ok: true, status: 200, json: async () => ({ id: 777, battletag: 'Real#4242' }) };
    throw new Error(`unexpected ${url}`);
  };
  const srv = await startServer({ bnetClientId: 'cid', bnetClientSecret: 'secret', fetch: fetchStub, devLogin: false });
  const anon = client(srv.url);
  const err = console.error;
  console.error = () => {};
  try {
    const meta = await anon.get('/api/meta');
    assert.equal(meta.body.bnet, true);
    assert.equal(meta.body.devLogin, false);

    let r = await anon.get('/auth/bnet?device=Gaming%20PC&platform=win32&appVersion=0.11.0');
    assert.equal(r.status, 302);
    const loc = new URL(r.headers.get('location'));
    assert.equal(loc.origin + loc.pathname, 'https://oauth.battle.net/authorize');
    assert.equal(loc.searchParams.get('client_id'), 'cid');
    assert.equal(loc.searchParams.get('redirect_uri'), `${srv.cfg.baseUrl}/auth/bnet/callback`);
    const state = loc.searchParams.get('state');
    const cookie = r.headers.get('set-cookie').split(';')[0];
    assert.match(cookie, /^gc_auth_nonce=/);
    assert.match(r.headers.get('set-cookie'), /HttpOnly/);

    const cb = (qs, withCookie = true) => anon.raw('GET', `/auth/bnet/callback?${qs}`, { headers: withCookie ? { cookie } : {} });
    r = await cb(`code=good-code&state=${encodeURIComponent(state)}`, false);
    assert.equal(r.status, 400, 'no nonce cookie');
    assert.match(r.body, /Sign-in expired/);
    assert.match(r.headers.get('content-security-policy'), /style-src 'unsafe-inline'/);
    r = await cb(`code=good-code&state=${encodeURIComponent(state.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')))}`);
    assert.equal(r.status, 400, 'altered state');
    r = await cb('error=access_denied');
    assert.equal(r.status, 400);
    assert.match(r.body, /cancelled/);

    r = await cb(`code=good-code&state=${encodeURIComponent(state)}`);
    assert.equal(r.status, 302);
    const m = /^\/auth\/app\/done#token=(gcd_[\w-]+)$/.exec(r.headers.get('location'));
    assert.ok(m, r.headers.get('location'));
    const token = decodeURIComponent(m[1]);
    const me = await client(srv.url, token).get('/api/me');
    assert.equal(me.status, 200);
    assert.equal(me.body.user.battletag, 'Real#4242');
    assert.equal(me.body.device.name, 'Gaming PC');
    assert.equal(me.body.device.platform, 'win32');
    assert.equal(me.body.device.app_version, '0.11.0');
    assert.equal(srv.db.prepare('SELECT bnet_id FROM users').get().bnet_id, '777');

    // Battle.net trouble shows a friendly page instead of a stack trace.
    bnetDown = true;
    r = await cb(`code=good-code&state=${encodeURIComponent(state)}`);
    assert.equal(r.status, 502);
    assert.match(r.body, /Battle.net sign-in failed/);

    r = await anon.get('/auth/app/done');
    assert.equal(r.status, 200);
    assert.match(r.body, /You are signed in/);
    assert.match(r.body, /Guild Camp/);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.doesNotMatch(r.body, /<script/i);

    r = await anon.get('/auth/bnet?device=PC&platform=bad%20platform');
    assert.equal(r.status, 400);
    assert.match(r.headers.get('content-type'), /html/);
  } finally {
    console.error = err;
    await srv.close();
  }

  const off = await startServer();
  try {
    const r = await client(off.url).get('/auth/bnet?device=PC');
    assert.equal(r.status, 503);
    assert.match(r.body, /not set up/);
  } finally {
    await off.close();
  }
});
