// Joining the guild by itself (services/membership.js tryAutoJoin) and officer roles from in-game ranks
// (syncRanks): Battle.net sign-in reads the player's WoW characters, POST /api/guild/auto-join takes the
// characters the addon saved, POST /api/sync joins a guildless member whose upload matches the roster,
// and owner/officer roster scans (or Blizzard's official roster) keep rank-following roles current.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, seed, client, addUser } = require('./helpers');
const M = require('../src/services/membership');
const gamedata = require('../src/services/gamedata');

const ROUTES = ['auth', 'guild', 'events', 'releases', 'sync'];
const REALM = 'Mirage Raceway';
const GAME_GUILD = 'Just Now WoW';
const NOW = () => Math.floor(Date.now() / 1000);

const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

async function setup(t, overrides = {}) {
  const srv = await startServer({ routes: ROUTES, ...overrides });
  t.after(() => srv.close());
  const s = seed(srv.db, { guildName: GAME_GUILD });
  srv.db.prepare('UPDATE guilds SET realm = ?, game_guild = ? WHERE id = ?').run(REALM, GAME_GUILD, s.guildId);
  const db = srv.db;
  // A character the guild roster knows (from a member's scan: rank set), optionally owned and ranked.
  const rosterChar = (name, { rank = 'Member', rankIndex = null, userId = null, official = false } = {}) => db.prepare(
    'INSERT INTO characters (guild_id, user_id, name, rank, rank_index, in_official_roster, class, level) VALUES (?,?,?,?,?,?,?,?)',
  ).run(s.guildId, userId, name, official ? null : rank, rankIndex, official ? 1 : null, 'WARRIOR', 20);
  const role = (userId) => (db.prepare('SELECT role, role_source FROM memberships WHERE user_id = ?').get(userId) || null);
  const count = (sql, ...args) => db.prepare(`SELECT COUNT(*) AS n FROM ${sql}`).get(...args).n;
  return {
    srv, db, s, rosterChar, role, count,
    owner: client(srv.url, s.owner.token),
    officer: client(srv.url, s.officer.token),
    member: client(srv.url, s.member.token),
  };
}

// The app's upload: WowGuildDB as JSON.
const upload = (c, payload) => c.raw('POST', '/api/sync', {
  headers: { 'Content-Type': 'application/json', 'X-App-Version': '0.11.2' },
  body: typeof payload === 'string' ? payload : JSON.stringify(payload),
});

const newcomer = (db, battletag) => {
  const u = addUser(db, battletag);
  return { ...u, c: null };
};

// ---------------------------------------------------------------- Battle.net sign-in

// Battle.net stand-in: token, userinfo, account profile per namespace, character summaries.
function fakeBattleNet(opts = {}) {
  const { profiles = {}, summaries = {} } = opts;
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, auth: init.headers && init.headers.Authorization });
    if (url === 'https://oauth.battle.net/token') return json({ access_token: 'user-token' });
    if (url === 'https://oauth.battle.net/userinfo') return json({ id: 777, battletag: 'Real#4242' });
    const u = new URL(url);
    assert.equal(u.host, 'eu.api.blizzard.com', url);
    if (opts.hang) return new Promise(() => {});
    if (opts.fail) return json({}, 500);
    const ns = u.searchParams.get('namespace');
    assert.equal(u.searchParams.get('locale'), 'en_GB');
    if (u.pathname === '/profile/user/wow') {
      if (profiles[ns] === 403) return json({}, 403);
      return profiles[ns] ? json(profiles[ns]) : json({ code: 404 }, 404);
    }
    const m = /^\/profile\/wow\/character\/([^/]+)\/([^/]+)$/.exec(u.pathname);
    if (m) {
      const sum = summaries[`${ns}|${decodeURIComponent(m[1])}|${decodeURIComponent(m[2])}`];
      return sum ? json(sum) : json({}, 404);
    }
    throw new Error(`unexpected ${url}`);
  };
  return { calls, fetch, opts };
}

const bnetChar = (name, realm, slug, level, classId = 1, faction = 'HORDE') => ({
  character: { href: 'https://eu.api.blizzard.com/…' }, name, id: level * 7,
  realm: { key: { href: '…' }, name: realm, id: 1, slug },
  playable_class: { key: { href: '…' }, name: 'Warrior', id: classId },
  playable_race: { name: 'Orc', id: 2 }, gender: { type: 'MALE', name: 'Male' },
  faction: { type: faction, name: faction === 'HORDE' ? 'Horde' : 'Alliance' }, level,
});

async function signInWithBattleNet(srv) {
  const anon = client(srv.url);
  const r = await anon.get('/auth/bnet?device=Gaming%20PC&platform=win32&appVersion=0.11.0');
  assert.equal(r.status, 302);
  const loc = new URL(r.headers.get('location'));
  const cookie = r.headers.get('set-cookie').split(';')[0];
  const started = Date.now();
  const cb = await anon.raw('GET', `/auth/bnet/callback?code=good-code&state=${encodeURIComponent(loc.searchParams.get('state'))}`, { headers: { cookie } });
  assert.equal(cb.status, 302, typeof cb.body === 'string' ? cb.body : JSON.stringify(cb.body));
  const m = /^\/auth\/app\/done#token=(gcd_[\w-]+)$/.exec(cb.headers.get('location'));
  assert.ok(m, cb.headers.get('location'));
  return { token: decodeURIComponent(m[1]), scope: loc.searchParams.get('scope'), ms: Date.now() - started };
}

test('Battle.net sign-in reads the WoW characters and joins the guild through a verified character', async (t) => {
  const bn = fakeBattleNet({
    profiles: {
      'profile-classic-eu': 403,
      'profile-classic1x-eu': { wow_accounts: [{ id: 1, characters: [
        bnetChar('Thrallia', REALM, 'mirage-raceway', 23, 7),
        bnetChar('Bankalt', REALM, 'mirage-raceway', 5, 4),
        bnetChar('Elsewhere', 'Firemaw', 'firemaw', 60, 1, 'ALLIANCE'),
      ] }] },
    },
    summaries: {
      'profile-classic1x-eu|mirage-raceway|thrallia': { name: 'Thrallia', guild: { name: GAME_GUILD, realm: { name: REALM } }, faction: { type: 'HORDE' } },
      'profile-classic1x-eu|firemaw|elsewhere': { name: 'Elsewhere', guild: { name: 'Other Guild' } },
    },
  });
  const { srv, db, s, rosterChar } = await setup(t, { bnetClientId: 'cid', bnetClientSecret: 'secret', fetch: bn.fetch, devLogin: false });
  // An officer's roster scan put Thrallia in the roster at rank 1 (Officer); nobody owns her yet.
  rosterChar('Thrallia', { rank: 'Officer', rankIndex: 1 });

  const { token, scope } = await signInWithBattleNet(srv);
  assert.equal(scope, 'openid wow.profile');

  // Every account profile namespace was asked, with the player's own token.
  const profileCalls = bn.calls.filter((c) => c.url.includes('/profile/user/wow'));
  const spaces = profileCalls.map((c) => new URL(c.url).searchParams.get('namespace'));
  for (const ns of ['profile-eu', 'profile-classic-eu', 'profile-classic1x-eu', 'profile-forever-eu', 'profile-camelot-eu']) assert.ok(spaces.includes(ns), ns);
  assert.ok(profileCalls.every((c) => c.auth === 'Bearer user-token'));
  const summaryCalls = bn.calls.filter((c) => c.url.includes('/profile/wow/character/'));
  assert.equal(summaryCalls.length, 3, 'one summary per character (up to 10)');
  assert.ok(summaryCalls[0].url.includes('/mirage-raceway/'), 'characters on the guild realm come first');

  // Characters stored with the guild from the summary.
  const user = db.prepare("SELECT * FROM users WHERE bnet_id = '777'").get();
  const rows = db.prepare('SELECT namespace, name, realm, realm_slug, level, class, faction, guild FROM bnet_characters WHERE user_id = ? ORDER BY level DESC').all(user.id);
  assert.deepEqual(rows.map((r) => ({ ...r })), [
    { namespace: 'profile-classic1x-eu', name: 'Elsewhere', realm: 'Firemaw', realm_slug: 'firemaw', level: 60, class: 'WARRIOR', faction: 'Alliance', guild: 'Other Guild' },
    { namespace: 'profile-classic1x-eu', name: 'Thrallia', realm: REALM, realm_slug: 'mirage-raceway', level: 23, class: 'SHAMAN', faction: 'Horde', guild: GAME_GUILD },
    { namespace: 'profile-classic1x-eu', name: 'Bankalt', realm: REALM, realm_slug: 'mirage-raceway', level: 5, class: 'ROGUE', faction: 'Horde', guild: null },
  ]);
  assert.ok(user.bnet_profile_at);
  assert.equal(user.bnet_profile_note, 'Read 3 characters from Battle.net (Classic Era 3).');

  // Joined through Battle.net; Thrallia's in-game rank makes them an officer straight away.
  const ms = db.prepare('SELECT role, role_source FROM memberships WHERE user_id = ?').get(user.id);
  assert.deepEqual({ ...ms }, { role: 'officer', role_source: 'rank' });
  assert.equal(db.prepare('SELECT user_id FROM characters WHERE name = ?').get('Thrallia').user_id, user.id, 'the matched character is claimed');
  assert.ok(db.prepare("SELECT 1 FROM activity WHERE text = 'Real#4242 joined (matched Thrallia)'").get());
  const audit = db.prepare('SELECT action, detail, user_id FROM audit_log ORDER BY id').all();
  assert.deepEqual(audit.map((a) => a.action), ['rank promote', 'auto join']);
  assert.equal(audit[1].detail, 'Thrallia (Battle.net)');
  assert.equal(audit[1].user_id, user.id);
  const ev = db.prepare("SELECT * FROM events WHERE kind = 'notice'").get();
  assert.deepEqual([ev.title, ev.body, ev.route, ev.officers_only], ['Real#4242 joined the guild', 'Matched Thrallia in the guild roster.', '/guild-settings', 1]);

  const me = await client(srv.url, token).get('/api/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.role, 'officer');
  assert.equal(me.body.guild.id, s.guildId);
  assert.equal(me.body.guild.auto_join, 'roster');
  assert.equal(me.body.guild.officer_rank_max, 1);
  assert.equal(me.body.device.name, 'Gaming PC');
  assert.deepEqual(me.body.bnet, { characters: 3, profile_at: user.bnet_profile_at, note: 'Read 3 characters from Battle.net (Classic Era 3).' });

  // Signing in again replaces the stored characters and leaves the membership alone.
  bn.calls.length = 0;
  await signInWithBattleNet(srv);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM bnet_characters WHERE user_id = ?').get(user.id).n, 3);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM memberships WHERE user_id = ?').get(user.id).n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action = 'auto join'").get().n, 1);

  // Battle.net trouble on a later sign-in keeps what was read before.
  bn.opts.fail = true;
  await signInWithBattleNet(srv);
  const after = db.prepare('SELECT bnet_profile_at, bnet_profile_note FROM users WHERE id = ?').get(user.id);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM bnet_characters WHERE user_id = ?').get(user.id).n, 3);
  assert.match(after.bnet_profile_note, /it had a problem/);
  assert.ok(after.bnet_profile_at);
});

test('Battle.net sign-in never fails because the character step is slow or broken', async (t) => {
  for (const mode of ['hang', 'fail']) {
    const bn = fakeBattleNet({ [mode]: true });
    const { srv, db } = await setup(t, { bnetClientId: 'cid', bnetClientSecret: 'secret', fetch: bn.fetch, devLogin: false, bnetProfileTimeoutMs: 250 });
    const { token, ms } = await signInWithBattleNet(srv);
    assert.ok(ms < 3000, `${mode}: sign-in took ${ms} ms`);
    const me = await client(srv.url, token).get('/api/me');
    assert.equal(me.status, 200);
    assert.equal(me.body.guild, null, 'no characters, no guild');
    assert.equal(me.body.bnet.characters, 0);
    assert.equal(me.body.bnet.profile_at, null);
    assert.equal(me.body.bnet.note, `Couldn't read your characters from Battle.net (${mode === 'hang' ? 'it did not answer in time' : 'it had a problem'}). Guild Camp uses the addon instead.`);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM bnet_characters').get().n, 0);
    await srv.close();
  }
});

test('an empty Battle.net account is noted, and dev sign-ins report no Battle.net characters', async (t) => {
  const bn = fakeBattleNet();
  const { srv } = await setup(t, { bnetClientId: 'cid', bnetClientSecret: 'secret', fetch: bn.fetch });
  const { token } = await signInWithBattleNet(srv);
  const me = await client(srv.url, token).get('/api/me');
  assert.equal(me.body.bnet.characters, 0);
  assert.ok(me.body.bnet.profile_at);
  assert.equal(me.body.bnet.note, 'Battle.net shows no World of Warcraft characters on this account yet.');

  const dev = await client(srv.url).post('/api/auth/dev', { battletag: 'Dev#1' });
  const devMe = await client(srv.url, dev.body.token).get('/api/me');
  assert.deepEqual(devMe.body.bnet, { characters: 0, profile_at: null, note: null });
});

// ---------------------------------------------------------------- reported characters

test('auto-join with characters from the addon: guild, realm, roster and ownership are all checked', async (t) => {
  const { srv, db, s, rosterChar, role } = await setup(t);
  rosterChar('Grom', { rank: 'Member', rankIndex: 4 });
  rosterChar('Takenby', { userId: s.member.id });
  // A character the member synced themselves but no roster scan has seen: not in the roster.
  db.prepare('INSERT INTO characters (guild_id, user_id, name) VALUES (?,?,?)').run(s.guildId, null, 'Unscanned');
  const u = addUser(db, 'Grommash#5151');
  const c = client(srv.url, u.token);
  const ch = (name, extra = {}) => ({ name, realm: REALM, guild: GAME_GUILD, faction: 'Horde', level: 20, class: 'WARRIOR', updated: NOW(), ...extra });
  const tryJoin = async (characters) => {
    const r = await c.post('/api/guild/auto-join', { characters });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
  };

  assert.equal((await client(srv.url).post('/api/guild/auto-join', { characters: [] })).status, 401);
  let r = await c.post('/api/guild/auto-join', { characters: 'Grom' });
  assert.deepEqual([r.status, r.body], [400, { error: 'Send your characters as a list.' }]);
  r = await c.raw('POST', '/api/guild/auto-join', { headers: { 'Content-Type': 'application/json' }, body: '[1]' });
  assert.equal(r.status, 400);

  let res = await tryJoin([]);
  assert.deepEqual(res, {
    status: 'no-match', guild: { id: s.guildId, name: GAME_GUILD, faction: 'Horde' }, role: null, via: null, character: null,
    reason: `Log in to World of Warcraft once with the Guild Camp addon on a character in ${GAME_GUILD}, then Guild Camp will add you.`,
    detected: null,
  });

  res = await tryJoin([ch('Grom', { guild: 'Other Guild' })]);
  assert.equal(res.status, 'no-match');
  assert.match(res.reason, /^Log in to World of Warcraft once/);
  assert.deepEqual(res.detected, { guild: 'Other Guild', realm: REALM, faction: 'Horde' });

  res = await tryJoin([ch('Grom', { realm: 'Firemaw' })]);
  assert.equal(res.status, 'no-match');
  assert.equal(res.reason, `Grom is on Firemaw, but ${GAME_GUILD} plays on ${REALM}. Log in to a character in ${GAME_GUILD}, then Guild Camp will add you.`);

  for (const name of ['Newbie', 'Unscanned']) {
    res = await tryJoin([ch(name)]);
    assert.equal(res.status, 'no-match', name);
    assert.equal(res.reason, `None of your characters are in ${GAME_GUILD}'s roster yet. Ask someone in the guild to open the guild roster in game, or use an invite link.`);
  }

  res = await tryJoin([ch('Takenby')]);
  assert.equal(res.status, 'no-match');
  assert.equal(res.reason, 'Takenby is already linked to someone else in Guild Camp. Ask an officer for an invite link.');

  // Only the first 50 characters count.
  res = await tryJoin([...Array.from({ length: 50 }, (_, i) => ch(`Filler${i}`, { guild: 'Elsewhere' })), ch('Grom')]);
  assert.equal(res.status, 'no-match');
  assert.equal(role(u.id), null);

  // Names and realms compare loosely (case, spaces); the guild name ignores case.
  res = await tryJoin([ch('Newbie'), ch('grom', { realm: 'mirage-raceway', guild: 'just now wow', name: 'grom' })]);
  assert.equal(res.status, 'joined', res.reason);
  assert.deepEqual({ ...res, reason: undefined }, {
    status: 'joined', guild: { id: s.guildId, name: GAME_GUILD, faction: 'Horde' }, role: 'member', via: 'roster', character: 'Grom',
    reason: undefined, detected: { guild: GAME_GUILD, realm: REALM, faction: 'Horde' },
  });
  assert.equal(res.reason, `You're in ${GAME_GUILD}. Guild Camp matched Grom.`);
  assert.deepEqual({ ...role(u.id) }, { role: 'member', role_source: 'rank' });
  assert.equal(db.prepare('SELECT user_id FROM characters WHERE name = ?').get('Grom').user_id, u.id);
  assert.equal(db.prepare('SELECT guild_id FROM devices WHERE user_id = ?').get(u.id).guild_id, s.guildId);
  assert.ok(db.prepare("SELECT 1 FROM activity WHERE text = 'Grommash#5151 joined (matched Grom)'").get());
  assert.equal(db.prepare("SELECT detail FROM audit_log WHERE action = 'auto join'").get().detail, 'Grom (guild roster)');

  res = await tryJoin([ch('Grom')]);
  assert.equal(res.status, 'already');
  assert.equal(res.role, 'member');
  assert.equal(res.reason, `You're already in ${GAME_GUILD}.`);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action = 'auto join'").get().n, 1);

  // The addon's own map (keyed by name) works too, and Blizzard's official roster counts as the roster.
  rosterChar('Official', { official: true });
  const v = addUser(db, 'Viaofficial#6161');
  const r2 = await client(srv.url, v.token).post('/api/guild/auto-join', { characters: { Official: { realm: REALM, guild: GAME_GUILD, level: 9 } } });
  assert.equal(r2.body.status, 'joined');
  assert.equal(r2.body.character, 'Official');
});

test('the officer notice reaches officers only, and a guild without an in-game name says so', async (t) => {
  const { srv, db, s, rosterChar, officer, member } = await setup(t);
  rosterChar('Grom');
  const u = addUser(db, 'Grommash#5151');
  const r = await client(srv.url, u.token).post('/api/guild/auto-join', { characters: [{ name: 'Grom', realm: REALM, guild: GAME_GUILD }] });
  assert.equal(r.body.status, 'joined');
  const seen = async (c) => (await c.get('/api/events?after=0')).body.events.map((e) => e.title);
  assert.deepEqual(await seen(officer), ['Grommash#5151 joined the guild']);
  assert.deepEqual(await seen(member), []);

  db.prepare('UPDATE guilds SET game_guild = NULL WHERE id = ?').run(s.guildId);
  const w = addUser(db, 'Who#7171');
  const r2 = await client(srv.url, w.token).post('/api/guild/auto-join', { characters: [{ name: 'Grom', realm: REALM, guild: GAME_GUILD }] });
  assert.equal(r2.body.status, 'no-match');
  assert.equal(r2.body.reason, `Guild Camp doesn't know which in-game guild ${GAME_GUILD} is yet. An officer can set it in Guild settings. Until then, use an invite link.`);
});

// ---------------------------------------------------------------- settings: verified / off

test('auto_join verified and off; settings are validated, audited and returned', async (t) => {
  const { srv, db, s, rosterChar, officer, member } = await setup(t);
  rosterChar('Grom');
  const ch = [{ name: 'Grom', realm: REALM, guild: GAME_GUILD }];

  let r = await officer.get('/api/guild');
  assert.equal(r.body.guild.auto_join, 'roster');
  assert.equal(r.body.guild.officer_rank_max, 1);

  r = await member.put('/api/guild/settings', { auto_join: 'off' });
  assert.equal(r.status, 403);
  r = await officer.put('/api/guild/settings', { auto_join: 'sometimes' });
  assert.deepEqual([r.status, r.body], [400, { error: 'Pick how new members join: roster, verified or off.' }]);

  r = await officer.put('/api/guild/settings', { auto_join: 'verified' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.messages, ['New members now join by themselves only when Battle.net confirms their character.']);
  assert.equal(r.body.guild.auto_join, 'verified');

  // Verified: what the addon reports isn't enough; a Battle.net character is.
  const u = addUser(db, 'Grommash#5151');
  const c = client(srv.url, u.token);
  r = await c.post('/api/guild/auto-join', { characters: ch });
  assert.equal(r.body.status, 'no-match');
  assert.equal(r.body.reason, `${GAME_GUILD} only adds people when Battle.net shows their character in the guild. Sign in with Battle.net again after you play, or use an invite link.`);
  db.prepare("INSERT INTO bnet_characters (user_id, namespace, name, realm, realm_slug, level, guild) VALUES (?, 'profile-classic1x-eu', 'Zuljin', ?, 'mirage-raceway', 30, 'Some Other Guild')").run(u.id, REALM);
  r = await c.post('/api/guild/auto-join', { characters: ch });
  assert.equal(r.body.reason, `None of your Battle.net characters are in ${GAME_GUILD}'s roster yet. Ask someone in the guild to open the guild roster in game, or use an invite link.`);
  // A Battle.net character in the in-game guild (by its guild name) is verified even without a roster scan.
  db.prepare("INSERT INTO bnet_characters (user_id, namespace, name, realm, realm_slug, level, guild) VALUES (?, 'profile-classic1x-eu', 'Newgrom', ?, 'mirage-raceway', 12, ?)").run(u.id, REALM, GAME_GUILD);
  r = await c.post('/api/guild/auto-join', { characters: [] });
  assert.deepEqual([r.body.status, r.body.via, r.body.character, r.body.role], ['joined', 'battlenet', 'Newgrom', 'member']);
  assert.match(r.body.reason, /on your Battle.net account/);

  // A Battle.net character on another realm doesn't count, even with the same guild name.
  const w = addUser(db, 'Wrongrealm#1');
  db.prepare("INSERT INTO bnet_characters (user_id, namespace, name, realm, realm_slug, level, guild) VALUES (?, 'profile-eu', 'Grom', 'Firemaw', 'firemaw', 70, ?)").run(w.id, GAME_GUILD);
  r = await client(srv.url, w.token).post('/api/guild/auto-join', {});
  assert.equal(r.body.status, 'no-match');

  r = await officer.put('/api/guild/settings', { auto_join: 'off' });
  assert.deepEqual(r.body.messages, ['New members now need an invite link.']);
  const x = addUser(db, 'Invitee#2');
  db.prepare("INSERT INTO bnet_characters (user_id, namespace, name, realm, realm_slug, level, guild) VALUES (?, 'profile-classic1x-eu', 'Grom', ?, 'mirage-raceway', 20, ?)").run(x.id, REALM, GAME_GUILD);
  r = await client(srv.url, x.token).post('/api/guild/auto-join', { characters: ch });
  assert.deepEqual([r.body.status, r.body.reason], ['disabled', `${GAME_GUILD} only lets people in with an invite link. Ask an officer for one.`]);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM memberships WHERE user_id = ?').get(x.id).n, 0);
  // An invite link still works.
  r = await client(srv.url, x.token).post('/api/guild/join', { code: s.inviteCode });
  assert.equal(r.status, 200);

  const audit = db.prepare("SELECT action, detail FROM audit_log WHERE action = 'auto join set' ORDER BY id").all();
  assert.deepEqual(audit.map((a) => a.detail), ['verified', 'off']);
});

// ---------------------------------------------------------------- no guild on the server

test('no guild on the server: the detected guild is offered, and creating it stores realm and in-game name', async (t) => {
  const srv = await startServer({ routes: ROUTES });
  t.after(() => srv.close());
  const a = addUser(srv.db, 'Founder#1');
  const ca = client(srv.url, a.token);
  let r = await ca.post('/api/guild/auto-join', { characters: [
    { name: 'Oldalt', realm: 'Firemaw', guild: 'Retail Guild', faction: 'Alliance', updated: 100 },
    { name: 'Thrallia', realm: REALM, guild: GAME_GUILD, faction: 'Horde', updated: 200 },
  ] });
  assert.deepEqual(r.body, {
    status: 'no-guild-on-server', guild: null, role: null, via: null, character: null,
    reason: `${GAME_GUILD} isn't set up on this server yet. Whoever sets it up runs it in Guild Camp.`,
    detected: { guild: GAME_GUILD, realm: REALM, faction: 'Horde' },
  });

  // Without characters: nothing detected.
  const b = addUser(srv.db, 'Empty#2');
  r = await client(srv.url, b.token).post('/api/guild/auto-join', { characters: [] });
  assert.deepEqual([r.body.status, r.body.detected, r.body.reason], ['no-guild-on-server', null, 'Nobody has set up a guild on this server yet.']);
  // A Battle.net character with a guild is detected too (WoW: Forever first).
  srv.db.prepare("INSERT INTO bnet_characters (user_id, namespace, name, realm, realm_slug, level, faction, guild) VALUES (?, 'profile-eu', 'Main', 'Draenor', 'draenor', 80, 'Alliance', 'Retail Raiders')").run(b.id);
  srv.db.prepare("INSERT INTO bnet_characters (user_id, namespace, name, realm, realm_slug, level, faction, guild) VALUES (?, 'profile-forever-eu', 'Fresh', ?, 'mirage-raceway', 12, 'Horde', ?)").run(b.id, REALM, GAME_GUILD);
  r = await client(srv.url, b.token).post('/api/guild/auto-join', {});
  assert.deepEqual(r.body.detected, { guild: GAME_GUILD, realm: REALM, faction: 'Horde' });

  // The founder sets it up and becomes the owner; realm and in-game name are stored.
  r = await ca.post('/api/guild', { name: GAME_GUILD, faction: 'Horde', realm: ` ${REALM} `, game_guild: GAME_GUILD });
  assert.equal(r.status, 201);
  assert.equal(r.body.role, 'owner');
  assert.equal(r.body.guild.realm, REALM);
  assert.equal(r.body.guild.game_guild, GAME_GUILD);
  assert.equal(r.body.guild.auto_join, 'roster');
  assert.equal(r.body.guild.officer_rank_max, 1);
  assert.equal(srv.db.prepare('SELECT role_source FROM memberships WHERE user_id = ?').get(a.id).role_source, 'manual');

  // Now the other player's Battle.net character (in that guild, by name) joins them.
  r = await client(srv.url, b.token).post('/api/guild/auto-join', {});
  assert.deepEqual([r.body.status, r.body.via, r.body.character], ['joined', 'battlenet', 'Fresh']);

  r = await ca.post('/api/guild/auto-join', {});
  assert.deepEqual([r.body.status, r.body.role], ['already', 'owner']);
});

// ---------------------------------------------------------------- POST /api/sync without a guild

test('a guildless upload joins when its characters match the roster; otherwise 409 and nothing is stored', async (t) => {
  const { srv, db, s, rosterChar, count } = await setup(t);
  rosterChar('Grom', { rank: 'Member', rankIndex: 3 });
  const u = addUser(db, 'Grommash#5151');
  const c = client(srv.url, u.token);
  const payload = (name, extra = {}) => ({
    addonVersion: '0.11.1',
    characters: { [name]: { name, realm: REALM, guild: GAME_GUILD, class: 'WARRIOR', race: 'Orc', level: 21, faction: 'Horde', updated: NOW(),
      professions: [{ name: 'Mining', skill: 50, max: 75 }], ...extra } },
    roster: { scannedAt: NOW(), guild: GAME_GUILD, members: [{ name, rank: 'Member', rankIndex: 0, level: 21, online: true }] },
    ctaQueue: [{ zone: 'Crossroads', needed: 3, msg: 'help', character: name, at: NOW() }],
  });

  let r = await upload(c, payload('Stranger'));
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'NO_GUILD_MATCH');
  assert.equal(r.body.error, `None of your characters are in ${GAME_GUILD}'s roster yet. Ask someone in the guild to open the guild roster in game, or use an invite link.`);
  assert.equal(r.body.autoJoin.status, 'no-match');
  assert.equal(r.body.autoJoin.reason, r.body.error);
  assert.equal(count('characters WHERE name = ?', 'Stranger'), 0, 'nothing stored');
  assert.equal(count('sync_log'), 0);
  assert.equal(count('ctas'), 0);
  assert.equal(db.prepare('SELECT addon_version, last_sync_at FROM users WHERE id = ?').get(u.id).last_sync_at, null);

  r = await upload(c, payload('Grom'));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.joined, { guild: { id: s.guildId, name: GAME_GUILD, faction: 'Horde' }, role: 'member', via: 'roster', character: 'Grom' });
  assert.equal(r.body.characters, 1);
  assert.equal(r.body.ctas, 1);
  const grom = db.prepare('SELECT user_id, level, rank_index FROM characters WHERE name = ?').get('Grom');
  assert.equal(grom.user_id, u.id);
  assert.equal(grom.level, 21);
  assert.equal(grom.rank_index, 3, 'a member\'s upload never writes rank_index, even their own');
  assert.equal(count('sync_log'), 1);
  assert.equal(count('professions'), 1);
  assert.equal(db.prepare('SELECT role FROM memberships WHERE user_id = ?').get(u.id).role, 'member');

  r = await upload(c, payload('Grom'));
  assert.equal(r.status, 200);
  assert.equal('joined' in r.body, false, 'only the joining upload says so');
});

// ---------------------------------------------------------------- rank mapping

test('officer roles follow in-game ranks from trusted roster scans; manual roles and the owner stay put', async (t) => {
  const { srv, db, s, rosterChar, role, officer, owner, member } = await setup(t);
  const follower = (bt, startRole, charName) => {
    const u = addUser(db, bt, { guildId: s.guildId, role: startRole });
    db.prepare("UPDATE memberships SET role_source = 'rank' WHERE user_id = ?").run(u.id);
    rosterChar(charName, { userId: u.id });
    return u;
  };
  const a = follower('Aaa#1', 'member', 'Aaa');
  const b = follower('Bbb#2', 'officer', 'Bbb');
  rosterChar('Mem', { userId: s.member.id });
  rosterChar('Own', { userId: s.owner.id });
  db.prepare("UPDATE memberships SET role_source = 'rank' WHERE user_id = ?").run(s.owner.id); // even then, never touched
  const rosterScan = (at, ranks) => ({ roster: { scannedAt: at, guild: GAME_GUILD, members: Object.entries(ranks).map(([name, rankIndex]) => ({ name, rank: `Rank ${rankIndex}`, rankIndex, online: true })) } });
  const rankIdx = (name) => db.prepare('SELECT rank_index FROM characters WHERE name = ?').get(name).rank_index;

  // An officer's scan: Aaa is rank 1 (officer), Bbb rank 4 (member). Mem is manual, Own is the owner.
  let at = NOW() - 100;
  let r = await upload(officer, rosterScan(at, { Aaa: 1, Bbb: 4, Mem: 0, Own: 5 }));
  assert.equal(r.status, 200);
  assert.deepEqual([rankIdx('Aaa'), rankIdx('Bbb'), rankIdx('Mem'), rankIdx('Own')], [1, 4, 0, 5]);
  assert.equal(role(a.id).role, 'officer');
  assert.equal(role(b.id).role, 'member');
  assert.equal(role(s.member.id).role, 'member', 'manual roles never change by rank');
  assert.equal(role(s.owner.id).role, 'owner');
  let audit = db.prepare("SELECT action, detail, user_id FROM audit_log WHERE action LIKE 'rank %' ORDER BY id").all();
  assert.deepEqual(audit.map((x) => [x.action, x.detail]), [['rank promote', 'Aaa#1 (rank 1)'], ['rank demote', 'Bbb#2 (rank 4)']]);
  assert.ok(audit.every((x) => x.user_id === s.officer.id));

  // A member's (newer) scan updates rank names but never rank_index or roles.
  at += 10;
  r = await upload(member, rosterScan(at, { Aaa: 7, Bbb: 0 }));
  assert.equal(r.body.roster, 2);
  assert.equal(db.prepare('SELECT rank FROM characters WHERE name = ?').get('Bbb').rank, 'Rank 0');
  assert.deepEqual([rankIdx('Aaa'), rankIdx('Bbb')], [1, 4]);
  assert.deepEqual([role(a.id).role, role(b.id).role], ['officer', 'member']);

  // A scan without rank indexes (an older addon) keeps the ones we have.
  at += 10;
  await upload(owner, { roster: { scannedAt: at, guild: GAME_GUILD, members: [{ name: 'Aaa', rank: 'Officer', online: true }, { name: 'Bbb', rank: 'Grunt', rankIndex: null }] } });
  assert.deepEqual([rankIdx('Aaa'), rankIdx('Bbb')], [1, 4]);

  // A manual promote pins the role: later scans leave Bbb an officer.
  r = await officer.post(`/api/members/${b.id}/promote`);
  assert.equal(r.status, 200);
  assert.deepEqual({ ...role(b.id) }, { role: 'officer', role_source: 'manual' });
  at += 10;
  await upload(officer, rosterScan(at, { Bbb: 6, Aaa: 1 }));
  assert.equal(role(b.id).role, 'officer');
  // A manual demote pins too.
  r = await owner.post(`/api/members/${a.id}/demote`);
  assert.deepEqual({ ...role(a.id) }, { role: 'member', role_source: 'manual' });
  db.prepare("UPDATE memberships SET role_source = 'rank', role = 'officer' WHERE user_id = ?").run(a.id);

  // Changing officer_rank_max runs the mapping again.
  r = await officer.put('/api/guild/settings', { officer_rank_max: 0 });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.messages, ['Officers now follow in-game ranks: Guild Master only.']);
  assert.equal(r.body.guild.officer_rank_max, 0);
  assert.equal(role(a.id).role, 'member');
  r = await officer.put('/api/guild/settings', { officer_rank_max: null });
  assert.deepEqual(r.body.messages, ['In-game ranks no longer make anyone an officer here.']);
  r = await officer.put('/api/guild/settings', { officer_rank_max: '2' });
  assert.equal(r.status, 200);
  assert.equal(role(a.id).role, 'officer');
  for (const bad of [10, -1, 1.5, 'x', true]) {
    r = await officer.put('/api/guild/settings', { officer_rank_max: bad });
    assert.deepEqual([r.status, r.body], [400, { error: 'Pick Off, or an in-game rank from 0 to 9, for officers.' }], String(bad));
  }
  assert.equal(db.prepare('SELECT officer_rank_max FROM guilds').get().officer_rank_max, 2);
  const setAudit = db.prepare("SELECT detail FROM audit_log WHERE action = 'officer ranks set' ORDER BY id").all().map((x) => x.detail);
  assert.deepEqual(setAudit, ['Guild Master only', 'off', 'Guild Master + 2 ranks below']);
  assert.equal(role(s.owner.id).role, 'owner');

  // Blizzard's official roster is trusted too: its rank (0 = Guild Master) sets rank_index, then the mapping runs.
  gamedata.applyRoster(db, s.guildId, [{ name: 'Aaa', level: 30, class: 'MAGE', rank: 5 }, { name: 'Newface', level: 10, rank: 1 }]);
  assert.equal(rankIdx('Aaa'), 5);
  assert.equal(rankIdx('Newface'), 1);
  assert.equal(role(a.id).role, 'member');
  audit = db.prepare("SELECT action, detail, user_id FROM audit_log WHERE action LIKE 'rank %' ORDER BY id DESC LIMIT 1").get();
  assert.deepEqual({ ...audit }, { action: 'rank demote', detail: 'Aaa#1 (rank 5)', user_id: null });
});

test('syncRanks and cleanReported as units', async (t) => {
  const { db, s, rosterChar } = await setup(t);
  const u = addUser(db, 'Solo#1', { guildId: s.guildId });
  db.prepare("UPDATE memberships SET role_source = 'rank' WHERE user_id = ?").run(u.id);
  rosterChar('Solochar', { userId: u.id, rankIndex: 1 });
  rosterChar('Soloalt', { userId: u.id, rankIndex: 6 });
  // The best (lowest) rank among the member's characters counts.
  assert.deepEqual(M.syncRanks({ db }, s.guildId), { promoted: ['Solo#1'], demoted: [] });
  assert.deepEqual(M.syncRanks({ db }, s.guildId), { promoted: [], demoted: [] }, 'nothing to do the second time');
  assert.deepEqual(M.syncRanks({ db }, 9999), { promoted: [], demoted: [] });

  const clean = M.cleanReported([null, 'x', { name: '' }, { name: ' Thrall ', realm: 'R'.repeat(99), level: '12', updated: 'soon', class: 7, guild: { evil: 1 } }]);
  assert.deepEqual(clean, [{ name: 'Thrall', realm: 'R'.repeat(60), guild: null, faction: null, level: 12, class: '7', updated: null }]);
  assert.equal(M.cleanReported(Array.from({ length: 80 }, (_, i) => ({ name: `C${i}` }))).length, 50);
  assert.deepEqual(M.cleanReported({ Keyname: { level: 3 } }).map((c) => c.name), ['Keyname']);
  assert.ok(M.sameRealm('Mirage Raceway', 'mirage-raceway'));
  assert.ok(M.sameRealm("Mal'Ganis", 'malganis'));
  assert.ok(!M.sameRealm('', ''));
});
