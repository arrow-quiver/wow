'use strict';
// War alerts and the war map (routes/war.js, services/war.js, the "wm" record).
const test = require('node:test');
const assert = require('node:assert');
const { setupShare, rec, NOW, PIDS } = require('./sharing-helpers');
const W = require('../../src/core/services/war');

const WEBHOOK = 'https://discord.com/api/webhooks/1/war';
const death = (over = {}) => ({
  character: 'Thrallia', at: NOW * 1000 - 5000, killer: 'Sneaky', pvp: true, enemies: ['Sneaky', 'Holy', 'Bigaxe'],
  zone: 'Hillsbrad Foothills', zoneId: 1424, spell: 'Eviscerate', amount: 612, seconds: 4.2, damageTaken: 2100, healed: 0, alert: true, ...over,
});

test('a death to players is saved and posted to Discord once per 2 minutes; other deaths are only saved', async (t) => {
  const h = await setupShare(t, { webhook: WEBHOOK });
  const api = h.srv.api;
  let r = await api.post('/api/war/death', death());
  assert.deepStrictEqual(r.body, { saved: true, posted: true });
  const text = h.discord.calls.at(-1).body.content;
  assert.strictEqual(text, '⚔️ **Thrallia** died to **Sneaky** and 2 more in **Hillsbrad Foothills** (Eviscerate for 612). Anyone near?');
  // The same death again (the app restarted mid-log): not saved twice, not posted.
  r = await api.post('/api/war/death', death());
  assert.deepStrictEqual(r.body, { saved: false, posted: false });
  // A minute later: saved, too soon to post.
  r = await api.post('/api/war/death', death({ at: NOW * 1000 + 60000 }));
  assert.deepStrictEqual(r.body, { saved: true, posted: false });
  // Three minutes later, alerts off: saved only.
  r = await api.post('/api/war/death', death({ at: NOW * 1000 + 180000, alert: false }));
  assert.deepStrictEqual(r.body, { saved: true, posted: false });
  // A death to a monster is never posted.
  r = await api.post('/api/war/death', death({ at: NOW * 1000 + 400000, pvp: false, killer: 'Crushridge Ogre', enemies: [] }));
  assert.deepStrictEqual(r.body, { saved: true, posted: false });
  assert.strictEqual(h.discord.calls.length, 1);
  assert.strictEqual((await api.post('/api/war/death', { at: 5 })).status, 400);

  const war = (await api.get('/api/war?days=7')).body;
  assert.strictEqual(war.alerts, true);
  assert.strictEqual(war.mine.deaths, 4);
  assert.strictEqual(war.mine.pvpDeaths, 3);
  assert.deepStrictEqual(war.mine.nemeses, [{ name: 'Sneaky', kills: 3 }]);
  assert.strictEqual(war.mine.recent[0].killer, 'Crushridge Ogre');
  assert.strictEqual(war.mine.recent.at(-1).posted, true);
});

test('two deaths arriving together post one alert; a failed post frees the slot', async (t) => {
  const h = await setupShare(t, { webhook: WEBHOOK });
  const api = h.srv.api;
  h.discord.down = true;
  let r = await api.post('/api/war/death', death({ at: NOW * 1000 - 20000 }));
  assert.deepStrictEqual(r.body, { saved: true, posted: false });
  // Discord is back: the next death may post although the failed one was under 2 minutes ago.
  h.discord.down = false;
  h.discord.delayMs = 50;
  const [a, b] = await Promise.all([
    api.post('/api/war/death', death({ at: NOW * 1000 - 10000 })),
    api.post('/api/war/death', death({ at: NOW * 1000 - 9000, killer: 'Holy' })),
  ]);
  assert.deepStrictEqual([a.body.saved, b.body.saved], [true, true]);
  assert.strictEqual([a.body.posted, b.body.posted].filter(Boolean).length, 1);
  assert.strictEqual(h.discord.calls.length, 2, 'the failed post and one alert');
});

test('Call for help posts the zone and the players of my last death, at most once a minute', async (t) => {
  const h = await setupShare(t, { webhook: WEBHOOK });
  const api = h.srv.api;
  await api.post('/api/war/death', death({ alert: false }));
  const r = await api.post('/api/war/help', {});
  assert.strictEqual(r.status, 200);
  assert.strictEqual(h.discord.calls.at(-1).body.content, '🆘 **Thrallia** needs help in **Hillsbrad Foothills**: 3 enemies (Sneaky, Holy, Bigaxe).');
  assert.strictEqual((await api.post('/api/war/help', {})).status, 429);
  h.setNow(NOW + 120);
  await api.post('/api/war/help', { zone: 'Ashenvale', message: 'Bring a healer' });
  assert.strictEqual(h.discord.calls.at(-1).body.content, '🆘 **Thrallia** needs help in **Ashenvale**: 3 enemies (Sneaky, Holy, Bigaxe). Bring a healer');
  h.settings.discordWebhook = '';
  h.setNow(NOW + 300);
  assert.strictEqual((await api.post('/api/war/help', {})).status, 409);
});

test('the guild war map comes from "wm" records: marks by zone, hotspots, names', async (t) => {
  const h = await setupShare(t);
  h.linkAll();
  const marks = (list) => list.map(([x, y, ago, kind]) => ({ map: 1424, x, y, at: NOW - ago, kind }));
  h.imp([
    rec('wm', PIDS.Grommash, NOW - 60, 'Grommash', { marks: marks([[452, 381, 600, 'd'], [460, 377, 300, 'k'], [800, 100, 9 * 86400, 'd']]), maps: [{ id: 1424, name: 'Hillsbrad Foothills' }] }),
    rec('wm', PIDS.Jaina, NOW - 60, 'Jaina', { marks: [...marks([[455, 384, 1200, 'd']]), { map: 1440, x: 500, y: 500, at: NOW - 100, kind: 'k' }] }),
  ]);
  assert.strictEqual(h.row('SELECT COUNT(*) AS n FROM war_marks').n, 5);
  let war = (await h.srv.api.get('/api/war')).body;
  assert.deepStrictEqual(war.guild, { deaths: 2, kills: 2, players: 2 });
  assert.strictEqual(war.zones[0].zone, 'Hillsbrad Foothills');
  assert.strictEqual(war.zones[0].marks.length, 3, 'the 9-day-old mark is outside the week');
  assert.strictEqual(war.zones[1].zone, 'Map 1440', 'no name shared for that map');
  assert.strictEqual(war.hotspots.length, 1);
  assert.deepStrictEqual({ ...war.hotspots[0], last: 0 }, { mapId: 1424, zone: 'Hillsbrad Foothills', x: 456, y: 381, deaths: 2, kills: 1, last: 0 });
  assert.ok(war.zones[0].marks.some((m) => m.who === 'Grommash'));
  assert.strictEqual(war.alerts, false);
  // A newer list replaces the old one; a tombstone clears it.
  h.imp([rec('wm', PIDS.Grommash, NOW - 30, 'Grommash', { marks: marks([[100, 100, 60, 'k']]) })]);
  h.imp([rec('wm', PIDS.Jaina, NOW - 20, 'Jaina', null, { del: true })]);
  war = (await h.srv.api.get('/api/war?days=30')).body;
  assert.deepStrictEqual(war.guild, { deaths: 0, kills: 1, players: 1 });
});

test('alert and help texts', () => {
  assert.strictEqual(W.alertText({ character: 'Grom', killer: 'A*b', enemies: ['A*b', 'C'], zone: null }), '⚔️ **Grom** died to **Ab** and **C**. Anyone near?');
  assert.strictEqual(W.alertText({ character: 'Grom', enemies: [] }), '⚔️ **Grom** died to players. Anyone near?');
  assert.strictEqual(W.helpText({ character: 'Grom', enemies: ['a', 'b', 'c', 'd', 'e'] }), '🆘 **Grom** needs help: 5 enemies (a, b, c, d, …).');
});
