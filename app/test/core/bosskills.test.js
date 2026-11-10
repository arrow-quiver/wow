'use strict';
// Raid boss kills (services/bosskills.js): projected from "ek" records, matched to the scheduled raid, counted as
// raid attendance for season points once per raid (or per instance and day), shown on the raid and the digest.
const test = require('node:test');
const assert = require('node:assert');
const { setupShare } = require('./sharing-helpers');
const BK = require('../../src/core/services/bosskills');
const Seasons = require('../../src/core/services/seasons');
const G = require('../../src/core/services/guildlife');
const text = require('../../src/core/share/text');

test('boss kills: the raid they belong to, attendance points once, the raid page and the digest', async (t) => {
  const h = await setupShare(t, { role: 'officer' });
  const { db, gid, me } = h;
  h.linkAll();
  const start = Math.floor(Date.now() / 1000) - 3 * 3600;
  db.prepare("INSERT INTO raids (guild_id, title, instance, starts_at, status) VALUES (?, 'MC night', 'Molten Core', ?, 'open')").run(gid, new Date(start * 1000).toISOString());
  const raidId = db.prepare('SELECT id FROM raids WHERE guild_id = ?').get(gid).id;
  h.imp([
    h.rec('ek', 'e00001', h.NOW - 100, 'Jaina', { enc: 663, boss: 'Lucifron', instance: 'Molten Core', at: start + 1800, size: 38, names: ['Thrallia', 'Jaina', 'Pugguy'] }),
    h.rec('ek', 'e00002', h.NOW - 90, 'Jaina', { enc: 664, boss: 'Magmadar', instance: 'Molten Core', at: start + 3000, size: 38, names: ['Thrallia', 'Jaina'] }),
    // No scheduled raid: Onyxia, once per day.
    h.rec('ek', 'e00003', h.NOW - 80, 'Jaina', { enc: 1084, boss: 'Onyxia', instance: "Onyxia's Lair", at: start + 4000, size: 40, names: ['Jaina'] }),
  ]);
  const kills = BK.kills(db, gid);
  assert.deepStrictEqual(kills.map((k) => [k.boss, k.raidId]), [['Onyxia', null], ['Magmadar', raidId], ['Lucifron', raidId]]);
  assert.strictEqual(kills[2].userIds.length, 2, 'Pugguy is no guildie');
  // Season: Thrallia 1 raid (MC), Jaina 2 (MC + Onyxia).
  let s = Seasons.season(db, gid);
  assert.strictEqual(s.players.find((p) => p.userId === me).raids, 1);
  assert.strictEqual(s.players.find((p) => p.name === 'Jaina').raids, 2);
  // The raid page: its kills, and who they saw (for the close dialog).
  const r = await h.srv.api.get(`/api/raids/${raidId}`);
  assert.deepStrictEqual(r.body.bossKills.kills.map((k) => k.boss), ['Lucifron', 'Magmadar']);
  assert.strictEqual(r.body.bossKills.seen.length, 2);
  // An officer closes the raid with both: still one raid each.
  db.prepare('INSERT INTO attendance (raid_id, user_id) VALUES (?, ?)').run(raidId, me);
  s = Seasons.season(db, gid);
  assert.strictEqual(s.players.find((p) => p.userId === me).raids, 1);
  // The digest names the bosses.
  const d = G.digest(db, gid, { week: new Date((start + 1800) * 1000).toISOString().slice(0, 10) });
  assert.match(G.discordText(d), /💀 Bosses down: Lucifron/);
});

test('a boss kill on Discord', () => {
  const ek = { type: 'ek', key: 'e1', author: 'Mokra', fields: { enc: 672, boss: 'Ragnaros', instance: 'Molten Core', at: 1, size: 38, names: [] } };
  assert.strictEqual(text.discordPost(ek, { created: true }), '💀 **Ragnaros** is down! Molten Core, 38 raiders. For the Horde!');
  assert.strictEqual(text.summaryOf(ek), 'Boss kill: Ragnaros (Molten Core)');
});
