'use strict';
// Recruiting (services/recruiting.js, routes/recruiting.js): recruits from "rk" records, recruiter kept as the
// state moves on, settings from "RA" (officers, no links), and season points when a recruit stays a week.
const test = require('node:test');
const assert = require('node:assert');
const { setupShare, PIDS } = require('./sharing-helpers');
const Seasons = require('../../src/core/services/seasons');
const R = require('../../src/core/services/recruiting');

test('recruits: found by Jaina, interested, joined (by an officer\'s addon): Jaina keeps the credit', async (t) => {
  const h = await setupShare(t);
  const { db, gid } = h;
  h.linkAll();
  const at = h.NOW - 10 * 86400;
  h.imp([h.rec('rk', 'Newblood', h.NOW - 300, 'Jaina', { pid: PIDS.Jaina, level: 22, class: 'WARRIOR', zone: 'The Barrens', state: 'c', at })]);
  h.imp([h.rec('rk', 'Newblood', h.NOW - 200, 'Jaina', { pid: PIDS.Jaina, level: 22, class: 'WARRIOR', zone: 'The Barrens', state: 'i', at: at + 60 })]);
  h.imp([h.rec('rk', 'Newblood', h.NOW - 100, 'Zuljinne', { pid: PIDS.Zuljinne, level: 22, class: 'WARRIOR', zone: 'The Barrens', state: 'j', at: at + 3600 })]);
  let r = await h.srv.api.get('/api/recruiting');
  assert.strictEqual(r.status, 200);
  const nb = r.body.recruits.find((x) => x.name === 'Newblood');
  assert.strictEqual(nb.recruiter, 'Jaina');
  assert.strictEqual(nb.state, 'j');
  assert.strictEqual(nb.joinedAt, at + 3600);
  // Not on the roster: left, no points.
  assert.strictEqual(nb.left, true);
  assert.strictEqual(R.events(db, gid, 0, Date.now() + 1e9).length, 0);
  // On the roster (still in the guild) a week later: 25 points for Jaina.
  db.prepare("INSERT INTO characters (guild_id, name, level, class) VALUES (?, 'Newblood', 23, 'WARRIOR')").run(gid);
  r = await h.srv.api.get('/api/recruiting');
  assert.strictEqual(r.body.recruits.find((x) => x.name === 'Newblood').stayed, true);
  const ev = R.events(db, gid, 0, Date.now() + 1e9);
  assert.strictEqual(ev.length, 1);
  assert.strictEqual(ev[0].at, (at + 3600 + 7 * 86400) * 1000);
  const s = Seasons.season(db, gid, { now: ev[0].at });
  assert.strictEqual(s.players.find((p) => p.name === 'Jaina').recruits, 1);
  assert.strictEqual(r.body.stats.recruiters[0].name, 'Jaina');
  assert.strictEqual(r.body.stats.recruiters[0].stayed, 1);
});

test('credit only for the player who wrote it: a pid that isn\'t the writer\'s gets nobody the points', async (t) => {
  const h = await setupShare(t);
  h.linkAll();
  h.imp([h.rec('rk', 'Sneaky', h.NOW - 100, 'Zuljinne', { pid: PIDS.Jaina, level: 30, class: 'ROGUE', zone: '', state: 'c', at: h.NOW - 100 })]);
  const r = await h.srv.api.get('/api/recruiting');
  assert.strictEqual(r.body.recruits.find((x) => x.name === 'Sneaky').recruiter, null);
});

test('settings: officers only, no links, classes checked; the defaults before', async (t) => {
  const member = await setupShare(t);
  assert.strictEqual((await member.srv.api.get('/api/recruiting')).body.settings.custom, false);
  assert.strictEqual((await member.srv.api.put('/api/recruiting/settings', { ad: 'x', msg: 'y' })).status, 403);
  const h = await setupShare(t, { role: 'officer' });
  const api = h.srv.api;
  assert.strictEqual((await api.put('/api/recruiting/settings', { ad: 'Join us discord.gg/abc', msg: 'Hi {name}' })).status, 400);
  assert.strictEqual((await api.put('/api/recruiting/settings', { ad: '', msg: 'Hi' })).status, 400);
  const r = await api.put('/api/recruiting/settings', { ad: 'wow is recruiting!', msg: 'Hey {name}!', classes: ['priest', 'shaman', 'nonsense'], minLevel: 20, maxLevel: 5 });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.deepStrictEqual(r.body.settings, { ad: 'wow is recruiting!', msg: 'Hey {name}!', classes: 'PRIEST,SHAMAN', minLevel: 20, maxLevel: 20, custom: true });
});
