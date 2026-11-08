'use strict';
// GET /api/roster: every roster row carries the in-game rank index, which the Roster page uses for the Rank
// column and to show who counts as an officer (docs/PIVOT.md: roles come only from in-game ranks).
const test = require('node:test');
const assert = require('node:assert');
const { startCore } = require('./helpers');

test('GET /api/roster rows include rank_index from the roster scan (null when the game gave none)', async (t) => {
  const c = await startCore();
  t.after(() => c.close());
  const up = await c.api.post('/api/sync', {
    characters: { Thrallia: { name: 'Thrallia', realm: 'Forever', guild: 'wow', class: 'SHAMAN', level: 60, updated: 1794066000 } },
    roster: {
      guild: 'wow', scannedAt: 1794066000,
      members: [
        { name: 'Thrallia', rank: 'Guild Master', rankIndex: 0, level: 60, class: 'SHAMAN', online: true },
        { name: 'Grommash', rank: 'Officer', rankIndex: 1, level: 60, class: 'WARRIOR', online: false },
        { name: 'Zuljin', rank: 'Member', rankIndex: 4, level: 42, class: 'HUNTER', online: true },
        { name: 'Oldtimer', rank: 'Member', level: 12, class: 'ROGUE', online: false },
      ],
    },
  });
  assert.strictEqual(up.status, 200, JSON.stringify(up.body));
  const r = await c.api.get('/api/roster');
  assert.strictEqual(r.status, 200);
  const byName = Object.fromEntries(r.body.characters.map((ch) => [ch.name, ch]));
  for (const ch of r.body.characters) assert.ok(Object.prototype.hasOwnProperty.call(ch, 'rank_index'), `${ch.name} has rank_index`);
  assert.deepStrictEqual(
    ['Thrallia', 'Grommash', 'Zuljin', 'Oldtimer'].map((n) => [n, byName[n].rank, byName[n].rank_index]),
    [['Thrallia', 'Guild Master', 0], ['Grommash', 'Officer', 1], ['Zuljin', 'Member', 4], ['Oldtimer', 'Member', null]],
  );
  // The ranks decide the roles: Thrallia (rank 0) is the Guild Master, so this app's player owns the guild.
  assert.strictEqual((await c.api.get('/api/me')).body.role, 'owner');
});
