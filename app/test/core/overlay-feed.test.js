'use strict';
// The war table's live alerts read the guild feed (activity). Guildmates' new calls to arms, boss kills, bounties,
// kill-on-sight entries and kills, and recruits saying yes add a line when they arrive (only records from the last
// six hours, so a rebuild doesn't replay old news). Guildmates' moments from guild chat: a line, once.
const test = require('node:test');
const assert = require('node:assert');
const { setupShare, PIDS } = require('./sharing-helpers');

const feed = (h) => h.rows('SELECT kind, text FROM activity ORDER BY id').map((r) => `${r.kind}: ${r.text}`);

test('guildmates\' records add feed lines when new; old ones and repeats don\'t', async (t) => {
  const h = await setupShare(t);
  h.linkAll();
  const now = h.NOW;
  const before = feed(h).length;
  h.imp([
    h.rec('ca', 'c00001', now - 60, 'Jaina', { character: 'Jaina', zone: 'Tarren Mill', needed: 5, message: '' }),
    h.rec('ek', 'e00001', now - 50, 'Jaina', { enc: 672, boss: 'Ragnaros', instance: 'Molten Core', at: now - 50, size: 38, names: ['Jaina'] }),
    h.rec('ko', 'Gankalot', now - 40, 'Jaina', { pid: PIDS.Jaina, reason: 'Camps the Crossroads', state: 'o' }),
    h.rec('rk', 'Newblood', now - 30, 'Jaina', { pid: PIDS.Jaina, level: 20, class: '', zone: '', state: 'i', at: now - 30 }),
    // From days ago (a store catching up): no line.
    h.rec('ca', 'c00002', now - 3 * 86400, 'Jaina', { character: 'Jaina', zone: 'Old Fight', needed: null, message: '' }),
  ]);
  const lines = feed(h).slice(before).sort();
  assert.deepStrictEqual(lines, [
    'cta: Call to arms in Tarren Mill: 5 needed — Jaina',
    'boss: Ragnaros is down! Molten Core',
    'kos: Gankalot is now kill on sight — Camps the Crossroads',
    'recruit: Newblood wants to join the guild',
  ].sort());
  // The same records again: nothing new.
  h.imp([h.rec('ek', 'e00001', now - 20, 'Jaina', { enc: 672, boss: 'Ragnaros', instance: 'Molten Core', at: now - 50, size: 39, names: ['Jaina'] })]);
  assert.strictEqual(feed(h).length, before + 4);
});

test('a guildmate\'s moment from guild chat: one feed line, no Discord', async (t) => {
  const h = await setupShare(t, { webhook: 'https://discord.com/api/webhooks/1/x' });
  const api = h.srv.api;
  const c = { what: 'Grom reached level 60!', from: 'Grom' };
  assert.deepStrictEqual((await api.post('/api/celebrate/feed', c)).body, { added: true });
  assert.deepStrictEqual((await api.post('/api/celebrate/feed', c)).body, { added: false });
  assert.strictEqual(h.discord.calls.length, 0);
  // Not a celebration: no line.
  assert.deepStrictEqual((await api.post('/api/celebrate/feed', { what: 'buy gold at example', from: 'Spam' })).body, { added: false });
  assert.match(feed(h).pop(), /^celebrate: Grom reached level 60/);
});
