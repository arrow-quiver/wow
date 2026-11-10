'use strict';
// Celebrations (services/celebrate.js, routes/celebrate.js): Discord posts for my lines, anniversaries.
const test = require('node:test');
const assert = require('node:assert');
const { startCore, seedGuild } = require('./helpers');
const { fakeDiscord } = require('./sharing-helpers');
const C = require('../../src/core/services/celebrate');

test('Discord texts', () => {
  assert.strictEqual(C.discordText({ what: 'Grom reached level 40!' }), '🎉 **Grom** reached **level 40**! Grats!');
  assert.match(C.discordText({ what: 'Grom reached level 60!' }), /^🔥 \*\*LOK'TAR OGAR!\*\* 🔥\n\*\*Grom\*\* has reached \*\*level 60\*\*! The Horde grows stronger/);
  assert.strictEqual(C.discordText({ what: 'Grom looted |cffa335ee|Hitem:19019::::|h[Thunderfury]|h|r!' }), '💜 **Grom** looted **Thunderfury**!');
  assert.strictEqual(C.discordText({ what: 'Grom reached 300 in Blacksmithing!' }), '🔨 **Grom** reached **300 Blacksmithing**!');
  assert.match(C.discordText({ what: 'Grom learned to ride!' }), /^🐺 \*\*Grom\*\* learned to ride!/);
  assert.strictEqual(C.discordText({ what: 'Grom reached PvP rank Stone Guard!' }), '🎖️ **Grom** reached PvP rank **Stone Guard**!');
  assert.strictEqual(C.discordText({ what: 'Welcome to the guild, Newbie! Your buddy is Mokra.', from: 'Thrallia' }), '👋 Welcome to the guild, **Newbie**! Your guild buddy: **Mokra**. (from Thrallia)');
  assert.strictEqual(C.discordText({ what: 'something else' }), null);
});

test('POST /api/celebrate posts once; anniversaries and birthdays today', async (t) => {
  const discord = fakeDiscord();
  const c = await startCore({ fetch: discord.fetch, settings: { discordWebhook: 'https://discord.com/api/webhooks/1/c' } });
  t.after(() => c.close());
  const g = seedGuild(c.db, { character: 'Mychar' });
  assert.deepStrictEqual((await c.api.post('/api/celebrate', { what: 'Mychar reached level 40!', from: 'Mychar' })).body, { posted: true });
  assert.deepStrictEqual((await c.api.post('/api/celebrate', { what: 'Mychar reached level 40!', from: 'Mychar' })).body, { posted: false });
  assert.deepStrictEqual((await c.api.post('/api/celebrate', { what: 'hello', from: 'Mychar' })).body, { posted: false });
  assert.strictEqual(discord.calls.length, 1);
  assert.strictEqual((await c.api.post('/api/celebrate', {})).status, 400);
  // Joined 3 months ago today; a character first seen a year ago today.
  const now = new Date(Date.UTC(2026, 10, 10, 12));
  c.db.prepare("UPDATE memberships SET joined_at = '2026-08-10 09:00:00' WHERE guild_id = ?").run(g.guildId);
  c.db.prepare("UPDATE characters SET first_seen = '2025-11-10 08:00:00' WHERE guild_id = ?").run(g.guildId);
  const a = C.anniversaries(c.db, g.guildId, now.getTime());
  assert.deepStrictEqual(a.map((x) => [x.kind, x.months, x.text]), [
    ['guild', 3, 'Mychar has been in the guild for 3 months!'], ['character', 12, 'Happy birthday, Mychar: 1 year with the guild!']]);
  assert.deepStrictEqual(C.anniversaries(c.db, g.guildId, Date.UTC(2026, 10, 11)), []);
  assert.deepStrictEqual(C.inboxPart(c.db, g.guildId, now.getTime()).lines.length, 2);
  assert.strictEqual(C.anniversaryDiscord(a[0]), '🎂 **Mychar** has been in the guild for **3 months**! Thanks for being part of it.');
});
