'use strict';
// How I actually play (services/playstyle.js, routes/play.js): sessions from the live link, the measured style,
// the weekly report, and the Coach's prompt.
const test = require('node:test');
const assert = require('node:assert');
const { startCore, seedGuild } = require('./helpers');
const P = require('../../src/core/services/playstyle');

const H = 3600000;
const session = (startedAt, over = {}) => ({
  character: 'Mychar', startedAt, lastAt: startedAt + 2 * H, minutes: 120, kills: 40, pvpKills: 2, deaths: 1, pvpDeaths: 1,
  damageDone: 90000, damageTaken: 40000, healingTaken: 5000, fights: 50, fightShare: 0.3, ...over,
});

test('sessions are saved and updated; the weekly report compares weeks and reads the deaths', async (t) => {
  const c = await startCore();
  t.after(() => c.close());
  const g = seedGuild(c.db, { character: 'Mychar' });
  const now = Date.now();
  // Last week: a calm session. This week: two rough ones.
  assert.deepStrictEqual((await c.api.post('/api/play/session', session(now - 9 * 24 * H, { deaths: 1 }))).body, { saved: true });
  await c.api.post('/api/play/session', session(now - 2 * 24 * H, { deaths: 4, pvpDeaths: 3, fightShare: 0.6, pvpKills: 4 }));
  const s3 = session(now - 5 * H, { deaths: 1, minutes: 30, lastAt: now - 4.5 * H });
  await c.api.post('/api/play/session', s3);
  await c.api.post('/api/play/session', { ...s3, minutes: 60, deaths: 4, pvpDeaths: 2, lastAt: now - 4 * H }); // the same session, later
  assert.strictEqual(c.db.prepare('SELECT COUNT(*) AS n FROM play_sessions').get().n, 3);
  assert.strictEqual((await c.api.post('/api/play/session', { character: 'x' })).status, 400);
  // Deaths the live link saw this week.
  const d = c.db.prepare(`INSERT INTO pvp_deaths (guild_id, user_id, character, at, pvp, killer, enemies, zone, spell, amount, seconds, healed)
    VALUES (?, ?, 'Mychar', ?, ?, ?, '[]', 'Hillsbrad Foothills', ?, 600, ?, ?)`);
  d.run(g.guildId, g.me, now - 3 * H, 1, 'Sneaky', 'Eviscerate', 3.1, 0);
  d.run(g.guildId, g.me, now - 2 * H, 1, 'Sneaky', 'Eviscerate', 2.5, 0);
  d.run(g.guildId, g.me, now - H, 0, 'Ogre', 'Smash', 9, 300);

  const r = (await c.api.get('/api/coach/report')).body;
  assert.strictEqual(r.character, 'Mychar');
  assert.deepStrictEqual([r.week.sessions, r.week.hours, r.week.deaths, r.week.pvpDeaths], [2, 3, 8, 5]);
  assert.deepStrictEqual([r.lastWeek.sessions, r.lastWeek.deaths], [1, 1]);
  assert.strictEqual(r.week.deathsPerHour, 2.7);
  assert.ok(r.style.aggression > 50);
  assert.ok(r.style.labels.includes('Dies now and then') || r.style.labels.includes('Dies a lot'));
  assert.deepStrictEqual(r.deaths.killers, [{ name: 'Sneaky', n: 2 }]);
  assert.deepStrictEqual(r.deaths.spells[0], { name: 'Eviscerate', n: 2 });
  assert.match(r.tips.join(' '), /up from 0\.5/);
  assert.match(r.tips.join(' '), /Eviscerate killed you 2 times/);
  assert.match(r.tips.join(' '), /Sneaky got you 2 times/);
  assert.match(r.text, /^My week on Mychar \(from the combat log\): 3 hours over 2 sessions/);
  assert.match(r.text, /What killed me most: Eviscerate ×2/);
  // The Coach's prompt line.
  assert.match(P.contextText(c.db, g.me, 'Mychar', now), /^How they actually play, measured from the combat log over the last 4 weeks \(5 hours\): /);
  assert.strictEqual(P.contextText(c.db, g.me, 'Nobody', now), '');
});

test('too little play: no style yet, and the tip says how to start', () => {
  const m = { hours: 0.2, sessions: 1, kills: 1, pvpKills: 0, deaths: 0, pvpDeaths: 0, fightShare: 0.1, deathsPerHour: null, pvpPerHour: null };
  assert.strictEqual(P.style(m), null);
});
