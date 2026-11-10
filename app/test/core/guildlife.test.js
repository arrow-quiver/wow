'use strict';
// Guild life (services/guildlife.js, routes/guildlife.js): the bulletin board ("bb" records), leveling matches
// (seen_hours from roster scans) and the weekly digest (and its Discord post).
const test = require('node:test');
const assert = require('node:assert');
const { setupShare, PIDS } = require('./sharing-helpers');
const G = require('../../src/core/services/guildlife');
const text = require('../../src/core/share/text');

test('bulletin board: I post and take down; a guildmate\'s post arrives; owner rules', async (t) => {
  const h = await setupShare(t);
  const api = h.srv.api;
  let r = await api.post('/api/board', { character: 'Thrallia', kind: 'wts', text: 'Mooncloth, 4 left', price: 125000 });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  assert.strictEqual(r.body.post.kindLabel, 'Selling');
  assert.strictEqual(r.body.post.price, 125000);
  assert.strictEqual(r.body.post.mine, true);
  const bb = h.outbox().find((o) => /^bb:/.test(o.id || o.rec_id || o.record_id || o.key || ''));
  assert.ok(h.rows("SELECT * FROM shared_records WHERE id LIKE 'bb:%'").length === 1 || bb);
  // Bad input.
  assert.strictEqual((await api.post('/api/board', { character: 'Grommash', kind: 'wts', text: 'x' })).status, 400);
  assert.strictEqual((await api.post('/api/board', { character: 'Thrallia', kind: 'nope', text: 'x' })).status, 400);
  assert.strictEqual((await api.post('/api/board', { character: 'Thrallia', kind: 'lfg', text: '   ' })).status, 400);

  // A guildmate's post arrives through the addon.
  h.linkAll();
  h.imp([h.rec('bb', 'jb0001', h.NOW - 60, 'Jaina', { pid: PIDS.Jaina, character: 'Jaina', kind: 'l', text: 'LF2M Scarlet Monastery', state: 'o' })]);
  r = await api.get('/api/board');
  assert.deepStrictEqual(r.body.posts.map((p) => [p.character, p.kind, p.mine]), [['Thrallia', 'wts', true], ['Jaina', 'lfg', false]]);
  const jaina = r.body.posts[1];
  assert.strictEqual((await api.post(`/api/board/${jaina.id}/remove`, {})).status, 403);
  // Someone else can't take over her post.
  h.imp([h.rec('bb', 'jb0001', h.NOW - 30, 'Zuljinne', { pid: PIDS.Zuljinne, character: 'Zuljinne', kind: 'l', text: 'mine now', state: 'o' })]);
  assert.strictEqual((await api.get('/api/board')).body.posts[1].text, 'LF2M Scarlet Monastery');
  // She takes it down (final).
  h.imp([h.rec('bb', 'jb0001', h.NOW - 20, 'Jaina', { pid: PIDS.Jaina, character: 'Jaina', kind: 'l', text: 'LF2M Scarlet Monastery', state: 'x' }, { final: true })]);
  r = await api.get('/api/board');
  assert.deepStrictEqual(r.body.posts.map((p) => p.character), ['Thrallia']);
  // I take mine down.
  r = await api.post(`/api/board/${r.body.posts[0].id}/remove`, {});
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await api.get('/api/board')).body.posts.length, 0);
});

test('bulletin board on Discord: the post text', () => {
  const S = require('../../src/shared/sharing');
  const rec = { type: 'bb', key: 'b1b1b1', author: 'Thrallia', fields: { pid: 'Thrallia.p4m7', character: 'Thrallia', kind: 's', text: 'Mooncloth, 4 left', price: 125000, state: 'o' } };
  assert.strictEqual(text.discordPost(rec, { created: true }), '📌 **Selling:** Mooncloth, 4 left (12g 50s) — Thrallia');
  assert.strictEqual(text.discordPost({ ...rec, fields: { ...rec.fields, kind: 'h', price: null } }, { created: true }), '📌 **Help wanted:** Mooncloth, 4 left — Thrallia');
  assert.strictEqual(text.discordPost(rec, { created: false }), null);
  assert.strictEqual(text.summaryOf(rec), 'Bulletin board: Mooncloth, 4 left');
  assert.ok(S.TYPES.bb);
});

test('leveling matches: close in level, active lately, sharing hours first; when they usually play', async (t) => {
  const h = await setupShare(t);
  const { db, gid, me } = h;
  db.prepare('UPDATE characters SET level = 24 WHERE guild_id = ? AND name = ?').run(gid, 'Thrallia');
  const now = new Date().toISOString();
  const set = db.prepare('UPDATE characters SET level = ?, last_seen = ?, online = ?, user_id = NULL WHERE guild_id = ? AND name = ?');
  set.run(26, now, 0, gid, 'Zuljinne');
  set.run(22, now, 0, gid, 'Jaina');
  set.run(23, now, 1, gid, 'Varok');
  set.run(35, now, 1, gid, 'Relayer'); // too high
  set.run(25, '2020-01-01T00:00:00Z', 0, gid, 'Zulalt'); // gone a long time
  const hour = db.prepare('INSERT INTO seen_hours (guild_id, name, slot, n) VALUES (?,?,?,?)');
  // Me and Jaina: weekday evenings (Mon-Wed 20:00). Zuljinne: weekend mornings.
  for (const d of [1, 2, 3]) { hour.run(gid, 'Thrallia', d * 24 + 20, 3); hour.run(gid, 'Jaina', d * 24 + 20, 2); }
  hour.run(gid, 'Zuljinne', 6 * 24 + 9, 5);
  const r = await h.srv.api.get('/api/leveling');
  assert.strictEqual(r.status, 200);
  const [mine] = r.body.characters;
  assert.strictEqual(mine.character, 'Thrallia');
  assert.strictEqual(mine.usually, 'Weekday evenings');
  // Varok is online now (first), then Jaina shares 3 hours, then Zuljinne.
  assert.deepStrictEqual(mine.matches.map((m) => [m.name, m.sharedHours]), [['Varok', 0], ['Jaina', 3], ['Zuljinne', 0]]);
  assert.strictEqual(mine.matches[1].usually, 'Weekday evenings');
  assert.strictEqual(mine.matches[2].usually, 'Weekend mornings');
  assert.ok(me);
});

test('roster scans count the hours guildmates are online, once per scan', async (t) => {
  const h = await setupShare(t);
  const sync = require('../../src/core/services/sync');
  const scannedAt = Math.floor(Date.parse('2026-11-09T19:00:00Z') / 1000);
  const payload = { characters: [], roster: { scannedAt, members: [
    { name: 'Jaina', level: 22, online: true, zone: 'The Barrens' }, { name: 'Varok', level: 40, online: false },
  ] } };
  const up = () => sync.applyPayload(h.db, h.gid, h.me, payload, { trustedRanks: false });
  up(); up();
  const d = new Date(scannedAt * 1000);
  assert.deepStrictEqual(h.rows('SELECT name, slot, n FROM seen_hours'), [{ name: 'Jaina', slot: d.getDay() * 24 + d.getHours(), n: 1 }]);
});

test('weekly digest: the week in numbers, its Discord text, posted once', async (t) => {
  const h = await setupShare(t, { role: 'officer', webhook: 'https://discord.com/api/webhooks/1/x' });
  const { db, gid, me } = h;
  const week = G.weekOf(h.NOW * 1000);
  const mid = Date.parse(`${week}T12:00:00Z`) + 2 * 86400000; // Wednesday noon
  const at = new Date(mid).toISOString();
  const log = db.prepare("INSERT INTO bank_log (guild_id, kind, who, amount, at, dedupe) VALUES (?, 'deposit', 'Thrallia', 500000, ?, 'd1')").run(gid, at);
  db.prepare("INSERT INTO donations (guild_id, log_id, who, user_id, kind, value, priced_from, at) VALUES (?, ?, 'Thrallia', ?, 'gold', 500000, 'gold', ?)").run(gid, log.lastInsertRowid, me, at);
  db.prepare("INSERT INTO war_marks (guild_id, pid, user_id, map_id, x, y, at, kind, n) VALUES (?, 'Thrallia.p4m7', ?, 1424, 1, 1, ?, 'k', 3)").run(gid, me, Math.floor(mid / 1000));
  db.prepare("INSERT INTO war_marks (guild_id, pid, user_id, map_id, x, y, at, kind, n) VALUES (?, 'Thrallia.p4m7', ?, 1424, 2, 2, ?, 'd', NULL)").run(gid, me, Math.floor(mid / 1000));
  db.prepare("INSERT INTO raids (guild_id, title, instance, starts_at, status) VALUES (?, 'Onyxia', 'Onyxia''s Lair', ?, 'done')").run(gid, at);
  db.prepare("UPDATE memberships SET joined_at = ? WHERE user_id = ?").run(at.replace('T', ' ').slice(0, 19), me);

  const d = G.digest(db, gid, { week, now: h.NOW * 1000 });
  assert.strictEqual(d.week, week);
  assert.strictEqual(d.donations.count, 1);
  assert.strictEqual(d.donations.value, 500000);
  assert.deepStrictEqual(d.war, { kills: 3, deaths: 1 });
  assert.deepStrictEqual(d.raids.map((r) => r.title), ['Onyxia']);
  assert.deepStrictEqual(d.members.joined, ['Thrallia']);
  assert.strictEqual(d.top[0].name, 'Thrallia');
  assert.strictEqual(d.top[0].points, 50 + 2); // 50 gold + a kill mark (seasons counts each mark once)
  const msg = G.discordText(d);
  assert.match(msg, /^📰 \*\*wow — the week of \d{4}-\d{2}-\d{2}\*\*/);
  assert.match(msg, /🥇 Thrallia \(52\)/);
  assert.match(msg, /3 Alliance slain, 1 deaths/);
  assert.match(msg, /worth 50g/);
  assert.match(msg, /👋 Welcome Thrallia!/);
  assert.match(G.discordText({ ...d, top: [], raids: [], war: { kills: 0, deaths: 0 }, ctas: 0, donations: { count: 0 }, crafts: 0, board: 0, members: { ...d.members, joined: [] } }), /A quiet week/);

  // An officer posts it; once.
  const api = h.srv.api;
  let r = await api.get(`/api/digest?week=${week}`);
  assert.strictEqual(r.body.canPost, true);
  assert.strictEqual(r.body.posted, false);
  r = await api.post('/api/digest/post', { week });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.posted, true);
  assert.strictEqual(h.discord.calls.length, 1);
  r = await api.post('/api/digest/post', { week });
  assert.strictEqual(r.body.posted, false);
  assert.strictEqual(h.discord.calls.length, 1);
  assert.strictEqual((await api.get(`/api/digest?week=${week}`)).body.posted, true);
});

test('the digest posts itself on Sunday evening from the Guild Master\'s app only', async (t) => {
  assert.strictEqual(G.dueNow(new Date(2026, 10, 15, 18, 5)), true); // Sunday 18:05
  assert.strictEqual(G.dueNow(new Date(2026, 10, 15, 17, 59)), false);
  assert.strictEqual(G.dueNow(new Date(2026, 10, 16, 19, 0)), false); // Monday
  const officer = await setupShare(t, { role: 'officer', webhook: 'https://discord.com/api/webhooks/1/x' });
  assert.strictEqual(await officer.ctx.services.guildlife.autoDigest(new Date(2026, 10, 15, 19, 0)), null);
  const gm = await setupShare(t, { role: 'owner', webhook: 'https://discord.com/api/webhooks/1/x' });
  gm.db.prepare("UPDATE memberships SET role = 'owner'").run();
  assert.strictEqual(await gm.ctx.services.guildlife.autoDigest(new Date(2026, 10, 15, 19, 0)), 'posted');
  assert.strictEqual(await gm.ctx.services.guildlife.autoDigest(new Date(2026, 10, 15, 20, 0)), 'already');
});

test('the digest on Sunday evening west of UTC is the week that is ending, not the new one', async (t) => {
  const tz = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  t.after(() => { process.env.TZ = tz; });
  const gm = await setupShare(t, { role: 'owner', webhook: 'https://discord.com/api/webhooks/1/x' });
  gm.db.prepare("UPDATE memberships SET role = 'owner'").run();
  // Sunday 15 November 2026, 19:00 in Los Angeles = Monday 03:00 UTC.
  const sunday = new Date(2026, 10, 15, 19, 0);
  assert.strictEqual(sunday.getUTCDay(), 1);
  assert.strictEqual(await gm.ctx.services.guildlife.autoDigest(sunday), 'posted');
  assert.deepStrictEqual(gm.db.prepare('SELECT week FROM digest_posts').all().map((r) => r.week), ['2026-11-09']);
});
