'use strict';
// The hunt (services/hunt.js, routes/hunt.js): kill on sight, bounties, kills that count, season points.
const test = require('node:test');
const assert = require('node:assert');
const { setupShare, PIDS } = require('./sharing-helpers');
const H = require('../../src/core/services/hunt');
const Seasons = require('../../src/core/services/seasons');
const text = require('../../src/core/share/text');

test('kill on sight: add, a guildmate\'s entry arrives, take off', async (t) => {
  const h = await setupShare(t);
  const api = h.srv.api;
  let r = await api.post('/api/kos', { name: 'gankalot-Thunderfury', reason: 'Camps the Crossroads' });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  assert.strictEqual(r.body.message, 'Gankalot is now kill on sight for the guild.');
  assert.strictEqual((await api.post('/api/kos', { name: 'not a name!' })).status, 400);
  h.linkAll();
  h.imp([h.rec('ko', 'Stabby', h.NOW - 30, 'Jaina', { pid: PIDS.Jaina, reason: 'Ganked me twice', state: 'o' })]);
  r = await api.get('/api/hunt');
  assert.deepStrictEqual(r.body.kos.map((k) => k.name).sort(), ['Gankalot', 'Stabby']);
  assert.strictEqual(r.body.kos.find((k) => k.name === 'Stabby').addedBy, 'Jaina');
  assert.strictEqual(r.body.kosPoints, 8);
  r = await api.post('/api/kos/Stabby/remove', {});
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual((await api.get('/api/hunt')).body.kos.map((k) => k.name), ['Gankalot']);
  assert.strictEqual((await api.post('/api/kos/Nobody/remove', {})).status, 404);
});

test('bounties: officers only; first kill claims a player bounty; zone bounties pay up to the cap; season points', async (t) => {
  const h = await setupShare(t, { role: 'officer' });
  const api = h.srv.api;
  assert.strictEqual((await api.post('/api/bounties', { points: 5 })).status, 400);
  let r = await api.post('/api/bounties', { target: 'Stabby', points: 50, days: 3, note: 'Ganking lowbies' });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  const playerKey = r.body.key;
  r = await api.post('/api/bounties', { zone: 'Hillsbrad Foothills', points: 5, cap: 2 });
  const zoneKey = r.body.key;
  const { db, gid } = h;
  // Mark the bounties as made a minute ago (the queue stamps them now).
  db.prepare("UPDATE bounties SET created_at = datetime('now', '-1 minute')").run();
  h.linkAll();
  const now = Math.floor(Date.now() / 1000);
  h.imp([h.rec('ko', 'Stabby', h.NOW - 40, 'Jaina', { pid: PIDS.Jaina, reason: '', state: 'o' })]);
  h.imp([
    h.rec('kk', 'k00001', h.NOW - 20, 'Jaina', { pid: PIDS.Jaina, target: 'Stabby', zone: 'Ashenvale', at: now - 20, kos: 1, bounty: playerKey }),
    h.rec('kk', 'k00002', h.NOW - 10, 'Zuljinne', { pid: PIDS.Zuljinne, target: 'Stabby', zone: 'Ashenvale', at: now - 10, kos: 0, bounty: playerKey }),
    h.rec('kk', 'k00003', h.NOW - 9, 'Zuljinne', { pid: PIDS.Zuljinne, target: 'Abc', zone: 'Hillsbrad Foothills', at: now - 9, kos: 0, bounty: zoneKey }),
    h.rec('kk', 'k00004', h.NOW - 8, 'Jaina', { pid: PIDS.Jaina, target: 'Bcd', zone: 'Hillsbrad Foothills', at: now - 8, kos: 0, bounty: zoneKey }),
    h.rec('kk', 'k00005', h.NOW - 7, 'Jaina', { pid: PIDS.Jaina, target: 'Cde', zone: 'Hillsbrad Foothills', at: now - 7, kos: 0, bounty: zoneKey }),
  ]);
  r = await api.get('/api/hunt');
  const player = r.body.bounties.find((b) => b.key === playerKey);
  assert.strictEqual(player.status, 'claimed');
  assert.deepStrictEqual(player.claims.map((c) => c.name), ['Jaina']);
  const zone = r.body.bounties.find((b) => b.key === zoneKey);
  assert.strictEqual(zone.status, 'claimed');
  assert.deepStrictEqual(zone.claims.map((c) => c.name), ['Zuljinne', 'Jaina']);
  // Season points: Jaina 50 (bounty) + 8 (kill on sight) + 5 (zone); Zuljinne 5.
  const s = Seasons.season(db, gid);
  const jaina = s.players.find((p) => p.name === 'Jaina');
  const zul = s.players.find((p) => p.name === 'Zuljinne');
  assert.strictEqual(jaina.hunt, 63);
  assert.strictEqual(zul.hunt, 5);
  // Close one: still listed, closed.
  r = await api.post(`/api/bounties/${player.id}/close`, {});
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await api.get('/api/hunt')).body.bounties.find((b) => b.key === playerKey).status, 'closed');
  assert.strictEqual(H.payouts(db, gid).length, 3);
});

test('bounties: members can\'t post or close them', async (t) => {
  const h = await setupShare(t);
  assert.strictEqual((await h.srv.api.post('/api/bounties', { target: 'Stabby', points: 5 })).status, 403);
  assert.strictEqual((await h.srv.api.get('/api/hunt')).body.canPost, false);
});

test('the hunt on Discord', () => {
  const ko = { type: 'ko', key: 'Gankalot', author: 'Mokra', fields: { pid: 'x', reason: 'Camps the Crossroads', state: 'o' } };
  assert.strictEqual(text.discordPost(ko, { created: true }), '☠️ **Kill on sight:** Gankalot — Camps the Crossroads');
  const kk = { type: 'kk', key: 'k1', author: 'Mokra', fields: { pid: 'x', target: 'Stabby', zone: 'Ashenvale', at: 1, kos: 0, bounty: 'b2b2b2' } };
  assert.strictEqual(text.discordPost(kk, { created: true }), '🎯 **Mokra** slew Stabby in Ashenvale and claims the bounty! For the Horde!');
  const bt = { type: 'BT', key: 'b2', author: 'Mokra', fields: { target: '', zone: 'Hillsbrad Foothills', points: 5, cap: 10, ends: 1, note: '', state: 'o' } };
  assert.strictEqual(text.discordPost(bt, { created: true }), '💰 **Bounty:** 5 points a kill in Hillsbrad Foothills (10 kills)');
  assert.strictEqual(text.summaryOf(bt), 'Bounty: Hillsbrad Foothills, 5 points');
});

test('kill-on-sight points: only targets on the list, once an hour per target, ten a day', async (t) => {
  const h = await setupShare(t);
  const { db, gid } = h;
  h.linkAll();
  h.imp([h.rec('ko', 'Stabby', h.NOW - 9000, 'Jaina', { pid: PIDS.Jaina, reason: '', state: 'o' })]);
  const at = h.NOW - 8000;
  const recs = [h.rec('kk', 'n00001', h.NOW - 50, 'Jaina', { pid: PIDS.Jaina, target: 'Nobody', zone: '', at, kos: 1, bounty: '' })];
  for (let i = 0; i < 4; i += 1) recs.push(h.rec('kk', `s0000${i}`, h.NOW - 40 + i, 'Jaina', { pid: PIDS.Jaina, target: 'Stabby', zone: '', at: at + i * 1200, kos: 1, bounty: '' }));
  h.imp(recs);
  const ev = H.events(db, gid, 0, (h.NOW + 100) * 1000).filter((e) => e.kind === 'kos');
  // Stabby at +0, +20 and +40 min are within the hour: one; +60 min counts again.
  assert.strictEqual(ev.length, 2);
});
