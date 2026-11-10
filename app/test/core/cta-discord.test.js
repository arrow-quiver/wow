'use strict';
// Calls to arms on Discord (services/ctaDiscord.js): made in the app, read from the chat log, or arriving with an
// upload; each posts once.
const test = require('node:test');
const assert = require('node:assert');
const { startCore, seedGuild } = require('./helpers');
const { fakeDiscord } = require('./sharing-helpers');
const CD = require('../../src/core/services/ctaDiscord');

async function setup(t, webhook = 'https://discord.com/api/webhooks/1/cta') {
  const discord = fakeDiscord();
  const c = await startCore({ fetch: discord.fetch, settings: webhook ? { discordWebhook: webhook } : {} });
  t.after(() => c.close());
  const g = seedGuild(c.db, { character: 'Mychar' });
  return { c, g, discord };
}
const until = async (fn) => { for (let i = 0; i < 50 && !fn(); i++) await new Promise((r) => setTimeout(r, 10)); };

test('a call to arms made in the app goes to Discord at once, once', async (t) => {
  const { c, discord } = await setup(t);
  const r = await c.api.post('/api/ctas', { zone: 'Hillsbrad Foothills', needed: 3, message: 'Alliance at the mill' });
  assert.strictEqual(r.status, 201);
  await until(() => discord.calls.length);
  assert.strictEqual(discord.calls.length, 1);
  assert.strictEqual(discord.calls[0].body.content, '📣 **Call to arms** from **Mychar**: **Hillsbrad Foothills**, 3 needed. "Alliance at the mill"');
  // The same call read back from the chat log a moment later: not again.
  const again = await c.api.post('/api/ctas/discord', { character: 'Mychar', zone: 'Hillsbrad Foothills', needed: 3, message: 'Alliance at the mill' });
  assert.deepStrictEqual(again.body, { posted: false });
  assert.strictEqual(discord.calls.length, 1);
});

test('from the chat log: posted once; a different call posts; no webhook, no post', async (t) => {
  const { c, discord } = await setup(t);
  assert.deepStrictEqual((await c.api.post('/api/ctas/discord', { character: 'Mychar', zone: 'Tarren Mill', message: '' })).body, { posted: true });
  assert.strictEqual(discord.calls.at(-1).body.content, '📣 **Call to arms** from **Mychar**: **Tarren Mill**');
  assert.deepStrictEqual((await c.api.post('/api/ctas/discord', { character: 'Mychar', zone: 'Tarren Mill' })).body, { posted: false });
  assert.deepStrictEqual((await c.api.post('/api/ctas/discord', { character: 'Mychar', zone: 'Southshore' })).body, { posted: true });
  assert.strictEqual((await c.api.post('/api/ctas/discord', { character: 'Mychar' })).status, 400);
  const none = await setup(t, null);
  assert.deepStrictEqual((await none.c.api.post('/api/ctas/discord', { character: 'Mychar', zone: 'X' })).body, { posted: false });
});

test('sweep: my recent calls that came with an upload; old ones never', async (t) => {
  const { c, g, discord } = await setup(t);
  const ins = c.db.prepare("INSERT INTO ctas (guild_id, user_id, character, zone, message, source, created_at) VALUES (?, ?, 'Mychar', ?, ?, 'game', datetime('now', ?))");
  ins.run(g.guildId, g.me, 'Ashenvale', 'help', '-2 minutes');
  ins.run(g.guildId, g.me, 'Duskwood', 'old one', '-3 hours');
  assert.strictEqual(await CD.sweep(c.db, c.ctx, g.guildId, g.me), 1);
  assert.strictEqual(discord.calls.at(-1).body.content, '📣 **Call to arms** from **Mychar**: **Ashenvale**. "help"');
  assert.strictEqual(await CD.sweep(c.db, c.ctx, g.guildId, g.me), 0, 'once');
  assert.strictEqual(c.db.prepare('SELECT COUNT(*) AS n FROM ctas WHERE discord_posted = 0').get().n, 0);
});
