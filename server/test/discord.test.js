// Discord domain over HTTP: the signed interactions endpoint Discord calls, slash commands end to end
// (link → /signup, /cta → camp feed + app notification), and the app's Settings → Discord calls.
// Command wording and the service's own rules are covered in services.test.js.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { startServer, seed, client, addUser } = require('./helpers');

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const PUBLIC_HEX = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex');
const DISCORD = { discordAppId: '1234567890', discordPublicKey: PUBLIC_HEX };

const okJson = (o) => ({ ok: true, status: 200, json: async () => o, text: async () => JSON.stringify(o) });

// Sends an interaction to /discord/interactions the way Discord does: raw JSON, Ed25519-signed.
function signedPost(url, payload, { key = privateKey, timestamp = String(Math.floor(Date.now() / 1000)), signature } = {}) {
  const body = Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload));
  const sig = signature ?? crypto.sign(null, Buffer.concat([Buffer.from(timestamp), body]), key).toString('hex');
  return client(url).raw('POST', '/discord/interactions', {
    headers: { 'Content-Type': 'application/json', 'X-Signature-Ed25519': sig, 'X-Signature-Timestamp': timestamp },
    body,
  });
}

// A slash command (type 2) or autocomplete (type 4) from a Discord member in server `srv1`.
const command = (name, options = [], { discordUser = '555', serverId = 'srv1', type = 2 } = {}) => ({
  type, guild_id: serverId, member: { user: { id: discordUser, username: 'someone' } }, data: { name, options },
});

test('interactions: 404 until Discord is configured, then signature checks and PING', async () => {
  let srv = await startServer();
  try {
    const r = await signedPost(srv.url, { type: 1 });
    assert.strictEqual(r.status, 404);
  } finally { await srv.close(); }

  srv = await startServer(DISCORD);
  try {
    let r = await signedPost(srv.url, { type: 1 });
    assert.deepStrictEqual([r.status, r.body], [200, { type: 1 }], 'PING → PONG');

    r = await signedPost(srv.url, { type: 1 }, { signature: '00' });
    assert.strictEqual(r.status, 401, 'bad signature');
    r = await signedPost(srv.url, { type: 1 }, { key: crypto.generateKeyPairSync('ed25519').privateKey });
    assert.strictEqual(r.status, 401, 'signed with someone else\'s key');
    r = await client(srv.url).raw('POST', '/discord/interactions', { headers: { 'Content-Type': 'application/json' }, body: '{"type":1}' });
    assert.strictEqual(r.status, 401, 'no signature headers');
    r = await client(srv.url).raw('POST', '/discord/interactions', {});
    assert.strictEqual(r.status, 401, 'no body at all');

    // Discord signs the exact bytes; a body that isn't JSON but is correctly signed is a 400.
    r = await signedPost(srv.url, 'not json');
    assert.strictEqual(r.status, 400);

    // Only POST: other methods fall through to the JSON 404.
    r = await client(srv.url).get('/discord/interactions');
    assert.strictEqual(r.status, 404);
  } finally { await srv.close(); }
});

test('interactions: link a Discord account, then /signup, /cta and the read-only commands', async () => {
  const srv = await startServer(DISCORD);
  try {
    const s = seed(srv.db);
    const member = client(srv.url, s.member.token);
    const { db } = srv;

    // Not connected yet: commands explain how to connect.
    let r = await signedPost(srv.url, command('online'));
    assert.strictEqual(r.status, 200);
    assert.match(r.body.data.content, /isn’t connected to Guild Camp yet/);
    assert.strictEqual(r.body.data.flags, 64, 'help is ephemeral');

    // The member gets a link code in the app...
    r = await member.post('/api/discord/link', {});
    assert.strictEqual(r.status, 200);
    const { code } = r.body;
    assert.match(code, /^[0-9A-F]{8}$/);
    assert.strictEqual(r.body.command, `/link ${code}`);
    assert.ok(Date.parse(r.body.expires_at) > Date.now() + 14 * 60000, 'valid for 15 minutes');
    assert.match(r.body.message, new RegExp(`type /link ${code} within 15 minutes`));

    // ...and types it in Discord. That links the account and connects the server.
    r = await signedPost(srv.url, command('link', [{ name: 'code', value: code }]));
    assert.match(r.body.data.content, /^Linked to Member in Guild Camp/);
    assert.strictEqual(db.prepare('SELECT discord_id FROM users WHERE id = ?').get(s.member.id).discord_id, '555');
    assert.strictEqual(db.prepare('SELECT discord_server_id FROM guilds WHERE id = ?').get(s.guildId).discord_server_id, 'srv1');
    r = await signedPost(srv.url, command('link', [{ name: 'code', value: code }], { discordUser: '777' }));
    assert.match(r.body.data.content, /didn’t work/, 'a code works once');

    r = await member.get('/api/discord');
    assert.strictEqual(r.body.linked, true);
    assert.strictEqual(r.body.server_linked, true);

    // Read-only commands work for anyone in the connected server.
    db.prepare("INSERT INTO characters (guild_id, user_id, name, level, online, zone, class) VALUES (?,?, 'Mokra', 58, 1, 'Winterspring', 'SHAMAN')").run(s.guildId, s.member.id);
    r = await signedPost(srv.url, command('online', [], { discordUser: 'stranger' }));
    assert.match(r.body.data.content, /1 around the fire[\s\S]*Mokra \(58\), Winterspring/);
    assert.strictEqual(r.body.data.flags, undefined, '/online is public');

    const raidId = Number(db.prepare("INSERT INTO raids (guild_id, title, instance, starts_at) VALUES (?, 'Molten Core', 'Molten Core', ?)")
      .run(s.guildId, new Date(Date.now() + 2 * 86400000).toISOString()).lastInsertRowid);
    r = await signedPost(srv.url, command('raids'));
    assert.match(r.body.data.content, /\*\*Molten Core\*\* <t:\d+:F> \(<t:\d+:R>\), 0 coming/);

    // Autocomplete for /signup lists open raids.
    r = await signedPost(srv.url, command('signup', [{ name: 'raid', value: 'molt', focused: true }], { type: 4 }));
    assert.strictEqual(r.body.type, 8);
    assert.strictEqual(r.body.data.choices[0].value, String(raidId));

    // /signup needs a linked account and signs that member up (main character by default).
    r = await signedPost(srv.url, command('signup', [{ name: 'raid', value: String(raidId) }, { name: 'role', value: 'healer' }], { discordUser: 'stranger' }));
    assert.match(r.body.data.content, /Link your Discord first/);
    r = await signedPost(srv.url, command('signup', [{ name: 'raid', value: String(raidId) }, { name: 'role', value: 'healer' }, { name: 'status', value: 'tentative' }]));
    assert.match(r.body.data.content, /Mokra is a maybe for \*\*Molten Core\*\* as healer/);
    assert.strictEqual(r.body.data.flags, 64);
    assert.deepStrictEqual({ ...db.prepare('SELECT user_id, character, role, status FROM signups WHERE raid_id = ?').get(raidId) },
      { user_id: s.member.id, character: 'Mokra', role: 'healer', status: 'tentative' });

    // /cta stores a call to arms, adds a camp feed line and notifies the app. Nothing goes to the
    // webhook: the reply is already public in Discord.
    const posted = [];
    srv.cfg.fetch = async (url, opts) => { posted.push([url, opts]); return okJson({}); };
    db.prepare("UPDATE guilds SET discord_webhook = 'https://discord.com/api/webhooks/1/x' WHERE id = ?").run(s.guildId);
    r = await signedPost(srv.url, command('cta', [{ name: 'zone', value: 'Tarren Mill' }, { name: 'needed', value: 5 }, { name: 'message', value: 'Alliance raid' }]));
    assert.match(r.body.data.content, /⚔️ \*\*Call to arms: Tarren Mill\*\* \(need 5\)\nAlliance raid\n— Mokra/);
    assert.strictEqual(r.body.data.flags, undefined, 'a call to arms is public');
    assert.deepStrictEqual({ ...db.prepare('SELECT user_id, character, zone, needed, source FROM ctas').get() },
      { user_id: s.member.id, character: 'Mokra', zone: 'Tarren Mill', needed: 5, source: 'discord' });
    assert.strictEqual(db.prepare("SELECT text FROM activity WHERE kind = 'cta'").get().text, 'Call to arms in Tarren Mill (from Discord)');
    const ev = db.prepare("SELECT kind, title, body, route FROM events WHERE kind = 'cta'").get();
    assert.deepStrictEqual({ ...ev }, { kind: 'cta', title: '⚔️ Call to arms: Tarren Mill', body: 'Called from Discord.', route: '/' });
    assert.strictEqual(posted.length, 0);

    // The officer's app sees the notification.
    const officer = client(srv.url, s.officer.token);
    r = await officer.get('/api/events?after=0');
    assert.ok(r.body.events.some((e) => e.kind === 'cta' && e.title === '⚔️ Call to arms: Tarren Mill'));

    r = await signedPost(srv.url, command('cta', []));
    assert.match(r.body.data.content, /Say where/);
    r = await signedPost(srv.url, command('nonsense'));
    assert.match(r.body.data.content, /Unknown command/);

    // Unlinking from the app makes /signup ask to link again.
    r = await member.post('/api/discord/unlink', {});
    assert.deepStrictEqual(r.body, { ok: true, message: 'Discord unlinked.' });
    assert.strictEqual(db.prepare('SELECT discord_id FROM users WHERE id = ?').get(s.member.id).discord_id, null);
    r = await signedPost(srv.url, command('signup', [{ name: 'raid', value: String(raidId) }, { name: 'role', value: 'dps' }]));
    assert.match(r.body.data.content, /Link your Discord first/);
  } finally { await srv.close(); }
});

test('interactions: a removed member loses their Discord link, and /cta and /signup refuse them', async () => {
  const srv = await startServer(DISCORD);
  try {
    const s = seed(srv.db);
    const { db } = srv;
    const member = client(srv.url, s.member.token);
    const officer = client(srv.url, s.officer.token);
    const raidId = Number(db.prepare("INSERT INTO raids (guild_id, title, instance, starts_at) VALUES (?, 'Molten Core', 'Molten Core', ?)")
      .run(s.guildId, new Date(Date.now() + 2 * 86400000).toISOString()).lastInsertRowid);
    const signupFor = (userId) => db.prepare('SELECT status, role FROM signups WHERE raid_id = ? AND user_id = ?').get(raidId, userId);
    const ctaCount = () => db.prepare('SELECT COUNT(*) AS n FROM ctas').get().n;

    // Linked and signed up while still in the guild.
    let r = await member.post('/api/discord/link', {});
    r = await signedPost(srv.url, command('link', [{ name: 'code', value: r.body.code }]));
    assert.match(r.body.data.content, /^Linked to Member/);
    r = await signedPost(srv.url, command('signup', [{ name: 'raid', value: String(raidId) }, { name: 'role', value: 'tank' }]));
    assert.match(r.body.data.content, /is coming for \*\*Molten Core\*\* as tank/);
    // A fresh link code made before the removal must not work after it.
    const pending = (await member.post('/api/discord/link', {})).body.code;
    assert.ok(pending);

    // An officer removes them: the Discord link and any pending link code go too.
    r = await officer.post(`/api/members/${s.member.id}/remove`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(db.prepare('SELECT discord_id FROM users WHERE id = ?').get(s.member.id).discord_id, null);
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM link_codes WHERE user_id = ?').get(s.member.id).n, 0);

    // Their Discord account can no longer call to arms or change sign-ups...
    r = await signedPost(srv.url, command('cta', [{ name: 'zone', value: 'Tarren Mill' }]));
    assert.match(r.body.data.content, /Link your Discord first/);
    assert.strictEqual(r.body.data.flags, 64);
    assert.strictEqual(ctaCount(), 0);
    r = await signedPost(srv.url, command('signup', [{ name: 'raid', value: String(raidId) }, { name: 'role', value: 'healer' }, { name: 'status', value: 'no' }]));
    assert.match(r.body.data.content, /Link your Discord first/);
    assert.deepStrictEqual({ ...signupFor(s.member.id) }, { status: 'yes', role: 'tank' }, 'sign-up left as it was');
    // ...nor relink with the code from before.
    r = await signedPost(srv.url, command('link', [{ name: 'code', value: pending }]));
    assert.match(r.body.data.content, /didn’t work/);
    assert.strictEqual(db.prepare('SELECT discord_id FROM users WHERE id = ?').get(s.member.id).discord_id, null);
    // The public commands still answer anyone in the connected server.
    r = await signedPost(srv.url, command('raids'));
    assert.match(r.body.data.content, /\*\*Molten Core\*\*/);

    // A Discord account still linked to someone who is no longer a member (membership gone some other
    // way) is refused by the membership check itself.
    const gone = addUser(db, 'Gone#6666', { guildId: s.guildId });
    db.prepare("UPDATE users SET discord_id = '666' WHERE id = ?").run(gone.id);
    db.prepare('DELETE FROM memberships WHERE user_id = ?').run(gone.id);
    r = await signedPost(srv.url, command('cta', [{ name: 'zone', value: 'Crossroads' }], { discordUser: '666' }));
    assert.match(r.body.data.content, /aren’t in this guild in Guild Camp any more/);
    assert.strictEqual(r.body.data.flags, 64);
    assert.strictEqual(ctaCount(), 0);
    r = await signedPost(srv.url, command('signup', [{ name: 'raid', value: String(raidId) }, { name: 'role', value: 'dps' }], { discordUser: '666' }));
    assert.match(r.body.data.content, /aren’t in this guild in Guild Camp any more/);
    assert.strictEqual(signupFor(gone.id), undefined);
  } finally { await srv.close(); }
});

test('interactions: a crash while answering becomes an ephemeral apology, not a 500', async () => {
  const srv = await startServer(DISCORD);
  const quiet = console.error;
  try {
    const s = seed(srv.db);
    srv.db.prepare("UPDATE guilds SET discord_server_id = 'srv1' WHERE id = ?").run(s.guildId);
    srv.db.prepare("UPDATE users SET discord_id = '555' WHERE id = ?").run(s.member.id);
    srv.db.exec('DROP TABLE ctas'); // make /cta fail inside the service
    console.error = () => {};
    const r = await signedPost(srv.url, command('cta', [{ name: 'zone', value: 'Crossroads' }]));
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body, { type: 4, data: { content: 'Something went wrong in Guild Camp. Try again in a moment.', flags: 64 } });
  } finally {
    console.error = quiet;
    await srv.close();
  }
});

test('GET /api/discord: what Settings shows', async () => {
  let srv = await startServer();
  try {
    const s = seed(srv.db);
    let r = await client(srv.url).get('/api/discord');
    assert.strictEqual(r.status, 401);
    r = await client(srv.url, s.member.token).get('/api/discord');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body, {
      configured: false, app_id: null, invite_url: null, bot_configured: false, linked: false, server_linked: false,
      commands: ['online', 'raids', 'cta', 'craft', 'price', 'signup', 'link'],
    });
    // Link codes need the Discord app.
    r = await client(srv.url, s.member.token).post('/api/discord/link', {});
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /Discord isn't set up on this server yet/);
  } finally { await srv.close(); }

  srv = await startServer({ ...DISCORD, discordBotToken: 'bot-token' });
  try {
    const s = seed(srv.db);
    srv.db.prepare("UPDATE users SET discord_id = '42' WHERE id = ?").run(s.member.id);
    srv.db.prepare("UPDATE guilds SET discord_server_id = 'srv9' WHERE id = ?").run(s.guildId);
    const r = await client(srv.url, s.member.token).get('/api/discord');
    assert.strictEqual(r.body.configured, true);
    assert.strictEqual(r.body.app_id, '1234567890');
    assert.strictEqual(r.body.invite_url, 'https://discord.com/oauth2/authorize?client_id=1234567890&scope=bot%20applications.commands&permissions=8589934592');
    assert.strictEqual(r.body.bot_configured, true);
    assert.strictEqual(r.body.linked, true);
    assert.strictEqual(r.body.server_linked, true);

    // Signed in but not in the guild yet: still answers, the server just isn't theirs.
    const loner = addUser(srv.db, 'Loner#4444');
    const l = await client(srv.url, loner.token).get('/api/discord');
    assert.deepStrictEqual([l.status, l.body.linked, l.body.server_linked], [200, false, false]);
    const link = await client(srv.url, loner.token).post('/api/discord/link', {});
    assert.deepStrictEqual([link.status, link.body.error], [403, 'Join a guild first.']);
  } finally { await srv.close(); }
});

test('link codes: a new code replaces the old one', async () => {
  const srv = await startServer(DISCORD);
  try {
    const s = seed(srv.db);
    const member = client(srv.url, s.member.token);
    const first = (await member.post('/api/discord/link', {})).body.code;
    const second = (await member.post('/api/discord/link', {})).body.code;
    assert.notStrictEqual(first, second);
    assert.deepStrictEqual(srv.db.prepare('SELECT code FROM link_codes WHERE user_id = ?').all(s.member.id).map((x) => x.code), [second]);
    let r = await signedPost(srv.url, command('link', [{ name: 'code', value: first }]));
    assert.match(r.body.data.content, /didn’t work/);

    // An expired code is refused too.
    srv.db.prepare("UPDATE link_codes SET expires_at = '2000-01-01T00:00:00.000Z'").run();
    r = await signedPost(srv.url, command('link', [{ name: 'code', value: second }]));
    assert.match(r.body.data.content, /didn’t work/);

    // Linking a Discord account that belonged to someone else moves it.
    srv.db.prepare("UPDATE users SET discord_id = '555' WHERE id = ?").run(s.officer.id);
    const third = (await member.post('/api/discord/link', {})).body.code;
    r = await signedPost(srv.url, command('link', [{ name: 'code', value: third }]));
    assert.match(r.body.data.content, /Linked to Member/);
    assert.strictEqual(srv.db.prepare('SELECT discord_id FROM users WHERE id = ?').get(s.officer.id).discord_id, null);
    assert.strictEqual(srv.db.prepare('SELECT discord_id FROM users WHERE id = ?').get(s.member.id).discord_id, '555');
  } finally { await srv.close(); }
});

test('POST /api/discord/register: officers only, needs the bot token, goes through cfg.fetch', async () => {
  const calls = [];
  let answer = (url, opts) => okJson(JSON.parse(opts.body));
  const fetch = async (url, opts) => { calls.push({ url, opts }); return answer(url, opts); };

  let srv = await startServer({ ...DISCORD, fetch });
  try {
    const s = seed(srv.db);
    const r = await client(srv.url, s.officer.token).post('/api/discord/register', {});
    assert.deepStrictEqual([r.status, r.body.error], [400, 'The Discord app details aren’t set on the server yet.']);
    assert.strictEqual(calls.length, 0);
  } finally { await srv.close(); }

  srv = await startServer({ ...DISCORD, discordBotToken: 'bot-token', fetch });
  try {
    const s = seed(srv.db);
    let r = await client(srv.url, s.member.token).post('/api/discord/register', {});
    assert.deepStrictEqual([r.status, r.body.error], [403, 'Officers only.']);
    assert.strictEqual(calls.length, 0);

    r = await client(srv.url, s.officer.token).post('/api/discord/register', {});
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body, { ok: true, registered: 7, message: '7 slash commands registered with Discord.' });
    assert.strictEqual(calls[0].url, 'https://discord.com/api/v10/applications/1234567890/commands');
    assert.strictEqual(calls[0].opts.method, 'PUT');
    assert.strictEqual(calls[0].opts.headers.Authorization, 'Bot bot-token');
    assert.deepStrictEqual(JSON.parse(calls[0].opts.body).map((c) => c.name), ['online', 'raids', 'cta', 'craft', 'price', 'signup', 'link']);
    const audit = srv.db.prepare('SELECT user_id, action, detail FROM audit_log WHERE action = ?').get('Discord commands registered');
    assert.deepStrictEqual({ ...audit }, { user_id: s.officer.id, action: 'Discord commands registered', detail: '7' });

    // Discord refuses: its answer is passed on as a 502. (app.js logs every 5xx; keep the test output clean.)
    const { warn, error } = console;
    console.warn = () => {};
    console.error = () => {};
    answer = () => ({ ok: false, status: 401, json: async () => ({}), text: async () => '{"message": "401: Unauthorized"}' });
    try {
      r = await client(srv.url, s.owner.token).post('/api/discord/register', {});
    } finally { Object.assign(console, { warn, error }); }
    assert.strictEqual(r.status, 502);
    assert.match(r.body.error, /^Discord said 401: \{"message": "401: Unauthorized"\}/);

    // Discord can't be reached at all.
    answer = () => { throw new TypeError('fetch failed'); };
    console.warn = () => {};
    console.error = () => {};
    try {
      r = await client(srv.url, s.owner.token).post('/api/discord/register', {});
    } finally { Object.assign(console, { warn, error }); }
    assert.deepStrictEqual([r.status, r.body.error], [502, "Couldn't reach Discord. Try again in a minute."]);
    assert.strictEqual(srv.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'Discord commands registered'").get().n, 1);
  } finally { await srv.close(); }
});

test('discord routes: signed-out calls are refused', async () => {
  const srv = await startServer(DISCORD);
  try {
    const anon = client(srv.url);
    for (const p of ['/api/discord/link', '/api/discord/unlink', '/api/discord/register']) {
      const r = await anon.post(p, {});
      assert.deepStrictEqual([r.status, r.body.error], [401, 'Sign in first.'], p);
    }
  } finally { await srv.close(); }
});
