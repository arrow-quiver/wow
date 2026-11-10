'use strict';
// Recruiting (services/recruiting.js, routes/recruiting.js): recruits from "rk" records, recruiter kept as the
// state moves on, settings from "RA" (officers, no links), and season points when a recruit stays a week.
const test = require('node:test');
const assert = require('node:assert');
const { setupShare, PIDS } = require('./sharing-helpers');
const Seasons = require('../../src/core/services/seasons');
const R = require('../../src/core/services/recruiting');

test('recruits: found by Jaina, interested, joined (by an officer\'s addon): Jaina keeps the credit, a week later', async (t) => {
  const h = await setupShare(t);
  const { db, gid } = h;
  h.linkAll();
  const at = h.NOW - 10 * 86400;
  h.imp([h.rec('rk', 'Newblood', h.NOW - 300, 'Jaina', { pid: PIDS.Jaina, level: 22, class: 'WARRIOR', zone: 'The Barrens', state: 'c', at })]);
  h.imp([h.rec('rk', 'Newblood', h.NOW - 200, 'Jaina', { pid: PIDS.Jaina, level: 22, class: 'WARRIOR', zone: 'The Barrens', state: 'i', at: at + 60 })]);
  // The writer's "at" is back-dated: the app keeps its own clock for contacted and joined.
  h.imp([h.rec('rk', 'Newblood', h.NOW - 100, 'Zuljinne', { pid: PIDS.Zuljinne, level: 22, class: 'WARRIOR', zone: 'The Barrens', state: 'j', at: at - 99 * 86400 })]);
  const row = db.prepare('SELECT * FROM recruits WHERE name = ?').get('Newblood');
  const now = Math.floor(Date.now() / 1000);
  assert.ok(Math.abs(row.joined_at - now) < 60 && Math.abs(row.contacted_at - now) < 60);
  let r = await h.srv.api.get('/api/recruiting');
  const nb = r.body.recruits.find((x) => x.name === 'Newblood');
  assert.strictEqual(nb.recruiter, 'Jaina');
  assert.strictEqual(nb.state, 'j');
  assert.strictEqual(nb.stayed, false);
  // Not on the roster: left, no points.
  assert.strictEqual(nb.left, true);
  assert.strictEqual(R.events(db, gid, 0, Date.now() + 1e9).length, 0);
  // Eight days on: contacted 10 days ago, joined 8, on the roster since 8 days ago. 25 points for Jaina.
  db.prepare('UPDATE recruits SET contacted_at = ?, joined_at = ? WHERE name = ?').run(now - 10 * 86400, now - 8 * 86400, 'Newblood');
  db.prepare("INSERT INTO characters (guild_id, name, level, class, first_seen) VALUES (?, 'Newblood', 23, 'WARRIOR', ?)").run(gid, new Date((now - 8 * 86400) * 1000).toISOString());
  r = await h.srv.api.get('/api/recruiting');
  assert.strictEqual(r.body.recruits.find((x) => x.name === 'Newblood').stayed, true);
  const ev = R.events(db, gid, 0, Date.now() + 1e9);
  assert.strictEqual(ev.length, 1);
  assert.strictEqual(ev[0].at, (now - 8 * 86400 + 7 * 86400) * 1000);
  const s = Seasons.season(db, gid, { now: ev[0].at });
  assert.strictEqual(s.players.find((p) => p.name === 'Jaina').recruits, 1);
  assert.strictEqual(r.body.stats.recruiters[0].name, 'Jaina');
  assert.strictEqual(r.body.stats.recruiters[0].stayed, 1);
  // The record expires (60 days): the joined recruit stays, so past seasons keep the points.
  db.prepare("DELETE FROM shared_records WHERE id = 'rk:Newblood'").run();
  require('../../src/core/share/project').run(db, gid, ['rk:Newblood']);
  assert.ok(db.prepare('SELECT 1 FROM recruits WHERE name = ?').get('Newblood'));
});

test('no points for marking an old guildie as a recruit', async (t) => {
  const h = await setupShare(t);
  const { db, gid } = h;
  h.linkAll();
  const now = Math.floor(Date.now() / 1000);
  // Grom has been in the guild for a month; Jaina marks him contacted and joined.
  db.prepare("INSERT INTO characters (guild_id, name, level, class, first_seen) VALUES (?, 'Grom', 50, 'WARRIOR', ?)").run(gid, new Date((now - 30 * 86400) * 1000).toISOString());
  h.imp([h.rec('rk', 'Grom', h.NOW - 50, 'Jaina', { pid: PIDS.Jaina, level: 50, class: 'WARRIOR', zone: '', state: 'j', at: h.NOW - 50 })]);
  db.prepare('UPDATE recruits SET joined_at = ? WHERE name = ?').run(now - 9 * 86400, 'Grom');
  assert.strictEqual(R.events(db, gid, 0, Date.now() + 1e9).length, 0);
  assert.strictEqual((await h.srv.api.get('/api/recruiting')).body.recruits.find((x) => x.name === 'Grom').stayed, false);
});

test('credit only for the player who wrote it: a pid that isn\'t the writer\'s gets nobody the points', async (t) => {
  const h = await setupShare(t);
  h.linkAll();
  h.imp([h.rec('rk', 'Sneaky', h.NOW - 100, 'Zuljinne', { pid: PIDS.Jaina, level: 30, class: 'ROGUE', zone: '', state: 'c', at: h.NOW - 100 })]);
  const r = await h.srv.api.get('/api/recruiting');
  assert.strictEqual(r.body.recruits.find((x) => x.name === 'Sneaky').recruiter, null);
});

test('pre-claiming: 30 credited contacts a day, and a join more than 30 days after contact doesn\'t pay', async (t) => {
  const h = await setupShare(t);
  const { db, gid } = h;
  h.linkAll();
  const recs = [];
  for (let i = 0; i < 32; i += 1) recs.push(h.rec('rk', `Name${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`, h.NOW - 100 + i, 'Jaina', { pid: PIDS.Jaina, level: 20, class: '', zone: '', state: 'c', at: h.NOW - 100 + i }));
  h.imp(recs);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM recruits WHERE recruiter IS NOT NULL').get().n, 30);
  // Joined 40 days after contact: no points.
  const now = Math.floor(Date.now() / 1000);
  const name = db.prepare('SELECT name FROM recruits WHERE recruiter IS NOT NULL LIMIT 1').get().name;
  db.prepare("UPDATE recruits SET state = 'j', contacted_at = ?, joined_at = ? WHERE name = ?").run(now - 50 * 86400, now - 10 * 86400, name);
  db.prepare('INSERT INTO characters (guild_id, name, level, first_seen) VALUES (?, ?, 20, ?)').run(gid, name, new Date((now - 10 * 86400) * 1000).toISOString());
  assert.strictEqual(R.events(db, gid, 0, Date.now() + 1e9).length, 0);
});

test('recruiting your own alt pays nothing', async (t) => {
  const h = await setupShare(t);
  const { db, gid } = h;
  h.linkAll();
  h.imp([h.rec('rk', 'Altie', h.NOW - 100, 'Jaina', { pid: PIDS.Jaina, level: 1, class: '', zone: '', state: 'j', at: h.NOW - 100 })]);
  const now = Math.floor(Date.now() / 1000);
  const jaina = db.prepare('SELECT recruiter FROM recruits WHERE name = ?').get('Altie').recruiter;
  db.prepare('UPDATE recruits SET contacted_at = ?, joined_at = ? WHERE name = ?').run(now - 10 * 86400, now - 9 * 86400, 'Altie');
  db.prepare('INSERT INTO characters (guild_id, name, level, user_id, first_seen) VALUES (?, ?, 5, ?, ?)').run(gid, 'Altie', jaina, new Date((now - 9 * 86400) * 1000).toISOString());
  assert.strictEqual(R.events(db, gid, 0, Date.now() + 1e9).length, 0);
});

test('settings: officers only, no links, classes checked; the defaults before', async (t) => {
  const member = await setupShare(t);
  assert.strictEqual((await member.srv.api.get('/api/recruiting')).body.settings.custom, false);
  assert.strictEqual((await member.srv.api.put('/api/recruiting/settings', { ad: 'x', msg: 'y' })).status, 403);
  const h = await setupShare(t, { role: 'officer' });
  const api = h.srv.api;
  for (const ad of ['Join us discord.gg/abc', 'see example.com', 'our site: guild . co . za', 'http://x', 'Discord: ask me']) {
    assert.strictEqual((await api.put('/api/recruiting/settings', { ad, msg: 'Hi {name}' })).status, 400, ad);
  }
  assert.strictEqual((await api.put('/api/recruiting/settings', { ad: '', msg: 'Hi' })).status, 400);
  const r = await api.put('/api/recruiting/settings', { ad: 'wow is recruiting!', msg: 'Hey {name}!', classes: ['priest', 'shaman', 'nonsense'], minLevel: 20, maxLevel: 5 });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.deepStrictEqual(r.body.settings, { ad: 'wow is recruiting!', msg: 'Hey {name}!', classes: 'PRIEST,SHAMAN', minLevel: 20, maxLevel: 20, custom: true });
});
