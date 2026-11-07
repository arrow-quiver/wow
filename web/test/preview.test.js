// Preview deployments (Coolify, one per pull request): own URL, own database, no real side effects.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const dbm = require('../src/db');
const { createApp, config } = require('../src/server');

const PROD = {
  NODE_ENV: 'production', BASE_URL: 'https://wow.example.com', DB_FILE: '/data/wow.db', SESSION_SECRET: 's',
  BNET_CLIENT_ID: 'id', BNET_CLIENT_SECRET: 'secret', DISCORD_APP_ID: '1', DISCORD_PUBLIC_KEY: 'k', DISCORD_BOT_TOKEN: 't',
  ANTHROPIC_API_KEY: 'sk-real',
};

test('production config is unchanged by the preview support', () => {
  const c = config({ ...PROD, COOLIFY_URL: 'https://other.example.com' });
  assert.strictEqual(c.preview, false);
  assert.strictEqual(c.baseUrl, 'https://wow.example.com', 'BASE_URL wins over COOLIFY_URL in production');
  assert.strictEqual(c.dbFile, '/data/wow.db');
  assert.strictEqual(c.bnetClientId, 'id');
  assert.strictEqual(c.discordBotToken, 't');
  assert.strictEqual(c.anthropicKey, 'sk-real');
  assert.strictEqual(c.devLogin, false);
  assert.throws(() => createApp({ ...config({ NODE_ENV: 'production' }) }, dbm.open(':memory:')), /SESSION_SECRET/);
});

test('BASE_URL falls back to the first Coolify URL', () => {
  assert.strictEqual(config({ COOLIFY_URL: 'https://a.example.com/,https://b.example.com' }).baseUrl, 'https://a.example.com');
  assert.strictEqual(config({ COOLIFY_FQDN: 'c.example.com' }).baseUrl, 'https://c.example.com');
  assert.strictEqual(config({}).baseUrl, 'http://localhost:3000');
});

test('a preview gets its own URL and database and drops every real integration', () => {
  const c = config({ ...PROD, PREVIEW: '1', COOLIFY_URL: 'https://12.wow.example.com' });
  assert.strictEqual(c.preview, true);
  assert.strictEqual(c.baseUrl, 'https://12.wow.example.com', 'Coolify URL wins over a copied BASE_URL');
  assert.notStrictEqual(c.dbFile, '/data/wow.db');
  assert.match(c.dbFile.replace(/\\/g, '/'), /\/data\/preview\.db$/);
  for (const k of ['bnetClientId', 'bnetClientSecret', 'discordAppId', 'discordPublicKey', 'discordBotToken', 'anthropicKey']) assert.strictEqual(c[k], '', k);
  assert.strictEqual(c.devLogin, true, 'previews sign in by BattleTag');
  assert.strictEqual(config({ PREVIEW: '1', DEV_LOGIN: '0' }).devLogin, false);
  assert.strictEqual(config({ PREVIEW: '1', PREVIEW_DB_FILE: '/tmp/x.db' }).dbFile, '/tmp/x.db');
  assert.ok(config({ PREVIEW: '1', NODE_ENV: 'production' }).sessionSecret, 'a preview starts without its own secret');
});

test('a preview shows a banner and never posts to Discord', async () => {
  const realFetch = global.fetch;
  const outbound = [];
  global.fetch = (u, o) => { if (!String(u).startsWith('http://127.0.0.1')) outbound.push(String(u)); return realFetch(u, o); };
  const db = dbm.open(':memory:');
  const app = createApp({ ...config({ PREVIEW: '1' }), timers: false }, db);
  const srv = await new Promise((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
  const url = `http://127.0.0.1:${srv.address().port}`;
  try {
    assert.match(await (await realFetch(url + '/')).text(), /Preview site for testing/);
    const res = await realFetch(`${url}/login/dev`, { method: 'POST', body: new URLSearchParams({ battletag: 'Owner#1' }), redirect: 'manual' });
    const cookie = res.headers.get('set-cookie').split(';')[0];
    const csrf = () => realFetch(url + '/', { headers: { cookie } }).then((r) => r.text()).then((h) => /name="_csrf" value="([^"]+)"/.exec(h)[1]);
    const post = async (p, body) => realFetch(url + p, { method: 'POST', headers: { cookie }, body: new URLSearchParams({ _csrf: await csrf(), ...body }), redirect: 'manual' });
    await post('/guild/create', { name: 'wow', faction: 'Horde' });
    db.prepare("UPDATE guilds SET discord_webhook = 'https://discord.com/api/webhooks/1/abc'").run();
    assert.strictEqual((await post('/raids', { title: 'Hyjal', instance: 'Hyjal Summit', starts: '2026-12-09T20:00', tz_offset: '-120' })).status, 302);
    assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM raids').get().n, 1);
    assert.deepStrictEqual(outbound, [], 'nothing left the server');
  } finally { srv.close(); global.fetch = realFetch; }
});
