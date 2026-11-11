'use strict';
// Guild seasons (services/seasons.js, routes/seasons.js): points, streaks, titles, badges, the hall of fame, the
// officers' announcement and the shout-outs.
const test = require('node:test');
const assert = require('node:assert');
const { startCore, seedGuild, addPlayer } = require('./helpers');
const { fakeDiscord } = require('./sharing-helpers');
const S = require('../../src/core/services/seasons');

const DAY = 86400000;
const sql = (t) => new Date(t).toISOString().replace('T', ' ').slice(0, 19);

async function setup(t, { webhook } = {}) {
  const discord = fakeDiscord();
  const c = await startCore({ fetch: discord.fetch, settings: webhook ? { discordWebhook: webhook } : {} });
  c.discord = discord;
  t.after(() => c.close());
  const g = seedGuild(c.db, { character: 'Mychar' });
  g.userId = g.me;
  const grom = addPlayer(c.db, g.guildId, 'Grom#3333', { role: 'member', character: 'Grommash' }).id;
  const jaina = addPlayer(c.db, g.guildId, 'Jaina#4444', { role: 'member', character: 'Jainah' }).id;
  const db = c.db;
  let n = 0;
  const give = (userId, who, value, at) => {
    const log = db.prepare("INSERT INTO bank_log (guild_id, kind, who, item_id, count, amount, at, dedupe) VALUES (?, 'deposit', ?, NULL, NULL, ?, ?, ?)")
      .run(g.guildId, who, value, new Date(at).toISOString(), `d${n += 1}`);
    db.prepare("INSERT INTO donations (guild_id, log_id, who, user_id, kind, value, priced_from, at, shouted) VALUES (?, ?, ?, ?, 'gold', ?, 'gold', ?, 0)")
      .run(g.guildId, log.lastInsertRowid, who, userId, value, new Date(at).toISOString());
  };
  const kill = (userId, at) => db.prepare("INSERT INTO war_marks (guild_id, pid, user_id, map_id, x, y, at, kind) VALUES (?, ?, ?, 1424, 1, 1, ?, 'k')")
    .run(g.guildId, `p${userId}-${n += 1}`, userId, Math.floor(at / 1000));
  const craft = (crafter, at) => db.prepare("INSERT INTO craft_requests (guild_id, requester_id, item, status, crafter_id, updated_at) VALUES (?, ?, 'Thing', 'done', ?, ?)")
    .run(g.guildId, g.userId, crafter, sql(at));
  const raid = (users, at) => {
    const r = db.prepare("INSERT INTO raids (guild_id, title, instance, starts_at, status) VALUES (?, 'MC', 'Molten Core', ?, 'done')").run(g.guildId, new Date(at).toISOString());
    for (const u of users) db.prepare('INSERT INTO attendance (raid_id, user_id) VALUES (?, ?)').run(r.lastInsertRowid, u);
  };
  return { c, db, g, grom, jaina, give, kill, craft, raid };
}

test('points, titles and the MVP for a month; streak bonus; the hall of fame', async (t) => {
  const h = await setup(t);
  const now = Date.UTC(2026, 10, 20, 12); // Fri 20 Nov 2026
  // Grom: 300 gold given, 3 kills. Jaina: 2 crafts, 2 raids. Me: one raid.
  h.give(h.grom, 'Grommash', 300 * 10000, now - 2 * DAY);
  for (let i = 0; i < 3; i++) h.kill(h.grom, now - DAY);
  h.craft(h.jaina, now - 3 * DAY); h.craft(h.jaina, now - 10 * DAY);
  h.raid([h.jaina, h.g.userId], now - 4 * DAY); h.raid([h.jaina], now - 11 * DAY);
  // Last month: Jaina gave a lot (another season), which also makes her streak run across months.
  h.give(h.jaina, 'Jainah', 1000 * 10000, Date.UTC(2026, 9, 28));
  const s = S.season(h.db, h.g.guildId, { now });
  assert.strictEqual(s.month, '2026-11');
  assert.strictEqual(s.current, true);
  const by = Object.fromEntries(s.players.map((p) => [p.name, p]));
  assert.deepStrictEqual([by.Grommash.gold, by.Grommash.kills, by.Grommash.base], [300, 3, 306]);
  assert.deepStrictEqual([by.Jainah.crafts, by.Jainah.raids, by.Jainah.base], [2, 2, 30]);
  assert.strictEqual(by.Mychar.base, 10);
  // Streaks: Grom has points this week only (1 week: no bonus). Jaina: this week, last week, and late October.
  assert.strictEqual(by.Grommash.streak, 1);
  assert.strictEqual(by.Grommash.score, 306);
  assert.ok(by.Jainah.streak >= 2);
  assert.strictEqual(by.Jainah.score, Math.round(30 * (1 + S.STREAK_STEP * (by.Jainah.streak - 1))));
  assert.deepStrictEqual(s.players.map((p) => p.rank), [1, 2, 3]);
  assert.deepStrictEqual(by.Grommash.titles, ['MVP', 'Quartermaster', 'Warlord']);
  assert.deepStrictEqual(by.Jainah.titles, ['Master Crafter', 'Stalwart']);
  assert.deepStrictEqual(s.mvp, { userId: h.grom, name: 'Grommash', score: 306 });
  // Last month's season: Jaina was the MVP; it's in the hall of fame.
  const hall = S.hall(h.db, h.g.guildId, { now, months: 3 });
  assert.deepStrictEqual(hall.map((x) => [x.month, x.mvp.name]), [['2026-10', 'Jainah']]);
  assert.strictEqual(hall[0].leaders.donor.value, 1000);
  // The announcement text.
  const text = S.announceText(S.season(h.db, h.g.guildId, { month: '2026-10', now }));
  assert.match(text, /^🏆 \*\*October 2026 season: the winners\*\*\n👑 MVP: \*\*Jainah\*\* with 1000 points\n💰 Quartermaster: \*\*Jainah\*\* \(1,000g given\)/);
});

test('streaks and badges', () => {
  const W = S._weekOf;
  const now = Date.UTC(2026, 10, 18);
  const weeks = new Set([W(now), W(now) - 1, W(now) - 2, W(now) - 4]);
  assert.strictEqual(S._streakOf(weeks, W(now)), 3);
  assert.strictEqual(S._streakOf(new Set([W(now) - 1, W(now) - 2]), W(now)), 2, 'last week still counts');
  assert.strictEqual(S._streakOf(new Set([W(now) - 2]), W(now)), 0);
  assert.strictEqual(S._bestStreak(new Set([1, 2, 3, 7, 8])), 3);
});

test('GET /api/seasons: the board with badges, my place, and officers announce a finished month once', async (t) => {
  const h = await setup(t, { webhook: 'https://discord.com/api/webhooks/1/s' });
  const now = Date.now();
  for (let i = 0; i < 12; i++) h.kill(h.grom, now - 1000 * i);
  h.give(h.g.userId, 'Mychar', 150 * 10000, now - 1000);
  const r = (await h.c.api.get('/api/seasons')).body;
  assert.strictEqual(r.current, true);
  assert.strictEqual(r.players[0].name, 'Mychar', '150 points beat 24');
  assert.deepStrictEqual(r.players.find((p) => p.name === 'Grommash').badges.map((b) => b.name), ['Bloodied']);
  assert.deepStrictEqual(r.myBadges.map((b) => b.name), ['Benefactor']);
  assert.strictEqual(r.mine.rank, 1);
  // The addon's inbox field carries the board for its Leaderboard page: one row per player, best first.
  const Seasons = require('../../src/core/services/seasons');
  const part = Seasons.inboxPart(h.c.db, h.g.guildId, now);
  assert.deepStrictEqual(part.board.map((b) => [b.rank, b.name]), [[1, 'Mychar'], [2, 'Grommash']]);
  assert.deepStrictEqual({ gold: part.board[0].gold, score: part.board[0].score, kills: part.board[1].kills }, { gold: 150, score: 150, kills: 12 });
  assert.strictEqual(part.count, 2);
  assert.ok(part.daysLeft >= 1 && part.daysLeft <= 31);
  assert.deepStrictEqual(part.leaders.map((l) => `${l.title}:${l.name}`), ['Quartermaster:Mychar', 'Warlord:Grommash']);
  assert.strictEqual(part.players.Mychar.rank, 1, 'the tooltip entries are still there');
  assert.strictEqual(r.canAnnounce, false, 'not while the month runs');
  assert.ok(r.allBadges.length >= 10);
  // A running month can't be announced; last month (empty) has nobody to crown.
  assert.strictEqual((await h.c.api.post('/api/seasons/announce', { month: r.month })).status, 409);
  const last = S.monthOf(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 1, 15));
  assert.strictEqual((await h.c.api.post('/api/seasons/announce', { month: last })).status, 409);
  h.give(h.jaina, 'Jainah', 50 * 10000, S.bounds(last).start + DAY);
  let a = await h.c.api.post('/api/seasons/announce', { month: last });
  assert.strictEqual(a.status, 200);
  assert.match(h.c.discord.calls.at(-1).body.content, /MVP: \*\*Jainah\*\* with 50 points/);
  assert.strictEqual((await h.c.api.post('/api/seasons/announce', { month: last })).status, 409, 'once');
  a = await h.c.api.post('/api/seasons/announce', { month: last, force: true });
  assert.strictEqual(a.status, 200);
  // Members can't announce.
  const asGrom = h.c.as ? h.c.as(h.grom) : null;
  if (asGrom) assert.strictEqual((await asGrom.post('/api/seasons/announce', { month: last })).status, 403);
});

test('shout-outs: my own new donations and badges go to Discord once; old ones never', async (t) => {
  const h = await setup(t, { webhook: 'https://discord.com/api/webhooks/1/s' });
  const now = Date.now();
  h.give(h.g.userId, 'Mychar', 50 * 10000, now - 5 * DAY);  // too old: never posted
  h.give(h.grom, 'Grommash', 99 * 10000, now - 1000);       // not mine: never posted by this app
  const shout = h.c.ctx.services.seasons.shoutOuts;
  assert.strictEqual(await shout(), 0, 'first run: badges I already have are remembered, not posted');
  h.give(h.g.userId, 'Mychar', 60 * 10000, now - 500);       // new, mine
  assert.strictEqual(await shout(), 2, 'the donation, and the Benefactor badge it earned (110 gold)');
  const posts = h.c.discord.calls.map((c) => c.body.content);
  assert.ok(posts.includes('🎁 **Mychar** topped up the guild bank: 60g. Thank you!'));
  assert.ok(posts.includes('🏅 **Mychar** earned the **Benefactor** badge!'));
  assert.strictEqual(await shout(), 0, 'once');
  assert.ok(!posts.some((p) => /Grommash|50g/.test(p)));
});
