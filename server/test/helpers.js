// Shared test helpers for every server test file.
//
//   const { startServer, seed, client, addUser, addLegacyKey } = require('./helpers');
//
//   const srv = await startServer({ fetch: fakeFetch });   // cfg overrides
//   const s = seed(srv.db);                                 // guild + owner/officer/member with device tokens
//   const owner = client(srv.url, s.owner.token);
//   const { status, body } = await owner.get('/api/me');
//   await srv.close();                                      // stops timers, closes server, DB and temp dirs
//
// startServer(overrides)
//   Starts the real app on 127.0.0.1 with an ephemeral port, an in-memory database (DB ':memory:'),
//   devLogin: true, timers: false, a fresh temp UPDATES_DIR, and every route file loaded.
//   Useful overrides: fetch (stand-in for outside HTTP), publishToken, bnetClientId/bnetClientSecret,
//   anthropicKey, rateLimits ({ sync, auth, discord, publish } per minute), routes (['guild', ...] to
//   load only some route files), bundledAddonDir, dbFile (a real file instead of ':memory:').
//   Returns { url, db, cfg, app, ctx, close() }.
//
// seed(db, { guildName, faction, inviteCode })
//   Inserts one guild and three members with device tokens. Returns
//   { guildId, inviteCode, owner, officer, member } where each person is
//   { id, battletag, token, deviceId }.
//
// addUser(db, battletag, { guildId, role, device }) → { id, battletag, token, deviceId }
//   One more user (optionally in a guild with a role, optionally without a device: device: false).
//
// addLegacyKey(db, userId, guildId) → raw 'wowg_…' key (old companion sync key, api_tokens table).
//
// client(url, token) → { get(path), post(path, body), put(path, body), del(path), raw(method, path, opts) }
//   Every call resolves { status, body, headers }. body is parsed JSON when the response is JSON,
//   otherwise text. raw(method, path, { headers, body }) sends body as-is (Buffer/string/stream)
//   and adds the bearer token unless headers.authorization is given.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { config } = require('../src/config');
const { open } = require('../src/db');
const { createApp, stopTimers } = require('../src/app');
const A = require('../src/auth');

async function startServer(overrides = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-test-'));
  const cfg = {
    ...config({ NODE_ENV: 'test' }),
    baseUrl: 'http://127.0.0.1',
    dbFile: ':memory:',
    devLogin: true,
    timers: false,
    updatesDir: path.join(tmp, 'updates'),
    ...overrides,
  };
  const db = open(cfg.dbFile);
  const app = createApp(cfg, db);
  const server = await new Promise((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
    s.on('error', reject);
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    stopTimers(app);
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise((resolve) => server.close(() => resolve()));
    try { db.close(); } catch { /* already closed */ }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return { url, db, cfg, app, ctx: app.locals.ctx, close };
}

function addDevice(db, userId, guildId = null, name = 'Test PC') {
  const t = A.newDeviceToken();
  const r = db.prepare('INSERT INTO devices (user_id, guild_id, token_hash, prefix, name, platform, app_version) VALUES (?,?,?,?,?,?,?)')
    .run(userId, guildId, t.hash, t.prefix, name, 'win32', '0.11.0');
  return { token: t.raw, deviceId: Number(r.lastInsertRowid) };
}

function addUser(db, battletag, { guildId = null, role = 'member', device = true } = {}) {
  const r = db.prepare('INSERT INTO users (bnet_id, battletag) VALUES (?,?)').run(`test:${battletag}`, battletag);
  const id = Number(r.lastInsertRowid);
  if (guildId) {
    // Distinct joined_at values keep "first membership" deterministic.
    db.prepare("INSERT INTO memberships (user_id, guild_id, role, joined_at) VALUES (?,?,?, datetime('now', ?))")
      .run(id, guildId, role, `-${1000 - id} seconds`);
  }
  const dev = device ? addDevice(db, id, guildId) : { token: null, deviceId: null };
  return { id, battletag, ...dev };
}

function seed(db, { guildName = 'wow', faction = 'Horde', inviteCode = 'TESTINVITE' } = {}) {
  const g = db.prepare('INSERT INTO guilds (name, faction, invite_code) VALUES (?,?,?)').run(guildName, faction, inviteCode);
  const guildId = Number(g.lastInsertRowid);
  return {
    guildId,
    inviteCode,
    owner: addUser(db, 'Owner#1111', { guildId, role: 'owner' }),
    officer: addUser(db, 'Officer#2222', { guildId, role: 'officer' }),
    member: addUser(db, 'Member#3333', { guildId, role: 'member' }),
  };
}

function addLegacyKey(db, userId, guildId) {
  const raw = 'wowg_' + crypto.randomBytes(24).toString('base64url');
  db.prepare('INSERT INTO api_tokens (user_id, guild_id, token_hash, prefix) VALUES (?,?,?,?)')
    .run(userId, guildId, A.legacyTokenHash(raw), raw.slice(0, 10));
  return raw;
}

function client(url, token) {
  async function send(method, p, { headers = {}, body } = {}) {
    const h = { ...headers };
    const lower = Object.fromEntries(Object.keys(h).map((k) => [k.toLowerCase(), k]));
    if (token && !lower.authorization) h.Authorization = `Bearer ${token}`;
    const init = { method, headers: h, redirect: 'manual' };
    if (body !== undefined) {
      init.body = body;
      if (body && typeof body.pipe === 'function') init.duplex = 'half';
    }
    const res = await fetch(url + p, init);
    const text = await res.text();
    let parsed = text;
    if ((res.headers.get('content-type') || '').includes('application/json')) {
      try { parsed = JSON.parse(text); } catch { /* leave as text */ }
    }
    return { status: res.status, body: parsed, headers: res.headers };
  }
  const json = (method) => (p, body) => send(method, p, body === undefined ? {} : {
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return {
    get: (p) => send('GET', p),
    post: json('POST'),
    put: json('PUT'),
    del: (p) => send('DELETE', p),
    raw: (method, p, opts) => send(method, p, opts),
  };
}

module.exports = { startServer, seed, client, addUser, addDevice, addLegacyKey };
