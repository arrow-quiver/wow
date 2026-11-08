'use strict';
// Shared helpers for the local core's tests (app/test/core).
//
//   const { startCore, client, seedGuild, addPlayer, asRole } = require('./helpers');
//
//   const c = await startCore({ fetch: fakeFetch });        // a core on 127.0.0.1 with an in-memory database
//   const g = seedGuild(c.db, { role: 'officer' });           // the guild, with me as an officer
//   const other = addPlayer(c.db, g.guildId, 'Jaina#2222', { role: 'member', character: 'Jaina' });
//   const { status, body } = await c.api.get('/api/camp');    // every request is "me"
//   await c.close();
//
// startCore(options)
//   Options: identity ({ battletag, characters }), settings (object, live: change it and the core sees
//   it), secrets (object, live; e.g. { anthropicKey: 'sk-test' }), credentials ({ clientId, clientSecret }),
//   latest ({ app, addon } versions), fetch (stand-in for outside HTTP), dataDir (a real folder instead of
//   memory), coachWaitMs, timers (default false), log, extraRoutes (test routes mounted after the real ones).
//   Returns { core, url, token, db, ctx, api: client(url, token), events: [event...], settings, secrets, close() }.
//   `events` collects what core.emitter sent as 'event' (notifications shown to me).
//
// seedGuild(db, { name, realm, faction, role, character, officerRankMax })
//   The guild as the first sync would make it, with my character on the roster at the in-game rank that
//   gives `role` (owner 0, officer 1, member 4). → { guildId, me, character }
// addPlayer(db, guildId, battletag, { role, character, characters }) → { id, battletag, character }
//   A guildmate (as the sharing wave will store one): users row, membership, roster character(s) with a rank.
// asRole(db, role) → my role after moving my best character to that rank.
// client(url, token) → { get, post, put, del, raw }, each resolving { status, body, headers }.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCore } = require('../../src/core');
const identity = require('../../src/core/identity');

const RANK_FOR = { owner: 0, officer: 1, member: 4 };
const quiet = { info() {}, warn() {}, error() {} };

async function startCore({
  identity: who = null, settings = {}, secrets = {}, credentials = null, latest = null, fetch, dataDir, coachWaitMs, timers = false, log = quiet,
  extraRoutes,
} = {}) {
  const core = await createCore({
    dataDir: dataDir || undefined,
    dbFile: dataDir ? undefined : ':memory:',
    log,
    getIdentity: () => who,
    getSecret: (name) => (Object.prototype.hasOwnProperty.call(secrets, name) ? secrets[name] : null),
    getSettings: () => settings,
    credentials,
    getLatest: () => latest || { app: null, addon: null },
    fetch,
    timers,
    coachWaitMs,
    extraRoutes,
  });
  const events = [];
  core.emitter.on('event', (e) => events.push(e));
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    await core.close();
  }
  return {
    core, url: core.url, token: core.token, db: core.db, ctx: core.ctx, api: client(core.url, core.token),
    events, settings, secrets, close,
  };
}

function seedGuild(db, {
  name = 'wow', realm = 'Forever', faction = 'Horde', role = 'owner', character = 'Mychar', cls = 'WARRIOR', level = 60, officerRankMax,
} = {}) {
  const { guild } = identity.selectGuild(db, { name, realm, faction });
  if (officerRankMax !== undefined) db.prepare('UPDATE guilds SET officer_rank_max = ? WHERE id = ?').run(officerRankMax, guild.id);
  const me = identity.meId(db);
  if (character) {
    db.prepare(`INSERT INTO characters (guild_id, user_id, name, class, level, faction, rank, rank_index)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT (guild_id, name) DO UPDATE SET user_id = excluded.user_id, rank_index = excluded.rank_index`)
      .run(guild.id, me, character, cls, level, faction, role === 'owner' ? 'Guild Master' : role === 'officer' ? 'Officer' : 'Member', RANK_FOR[role]);
  }
  identity.syncRanks(db, guild.id);
  identity.refreshMyName(db);
  return { guildId: guild.id, me, character };
}

function addPlayer(db, guildId, battletag, { role = 'member', character, characters, level = 60, cls = 'MAGE' } = {}) {
  const r = db.prepare('INSERT INTO users (bnet_id, battletag) VALUES (?,?)').run(`test:${battletag}`, battletag);
  const id = Number(r.lastInsertRowid);
  db.prepare("INSERT INTO memberships (user_id, guild_id, role, role_source, joined_at) VALUES (?,?, 'member', 'rank', datetime('now', ?))")
    .run(id, guildId, `-${1000 - id} seconds`);
  const names = characters || [character || String(battletag).split('#')[0]];
  names.forEach((n, i) => {
    db.prepare(`INSERT INTO characters (guild_id, user_id, name, class, level, rank, rank_index) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT (guild_id, name) DO UPDATE SET user_id = excluded.user_id, rank_index = excluded.rank_index`)
      .run(guildId, id, n, cls, level, role, i === 0 ? RANK_FOR[role] : null);
  });
  identity.syncRanks(db, guildId);
  return { id, battletag, character: names[0] };
}

function asRole(db, role) {
  const g = identity.currentGuild(db);
  const me = identity.meId(db);
  db.prepare('UPDATE characters SET rank_index = NULL WHERE guild_id = ? AND user_id = ?').run(g.id, me);
  const c = db.prepare('SELECT id FROM characters WHERE guild_id = ? AND user_id = ? ORDER BY id LIMIT 1').get(g.id, me);
  if (c) db.prepare('UPDATE characters SET rank_index = ? WHERE id = ?').run(RANK_FOR[role], c.id);
  identity.syncRanks(db, g.id);
  return identity.myMembership(db).role;
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

const tmpDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

module.exports = { startCore, seedGuild, addPlayer, asRole, client, tmpDir, RANK_FOR };
