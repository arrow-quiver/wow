// Guild seasons (services/seasons.js): the monthly leaderboard, titles, badges, streaks and the hall of fame.
//
//   GET  /api/seasons?month=YYYY-MM   the season (this month by default), every player's badges, the hall of fame
//   POST /api/seasons/announce        { month } officers: post the month's winners to the guild's Discord, once
//                                     per month from this app (409 already announced or no webhook; { force: true }
//                                     posts again)
//
// Shout-outs (every SHOUT_MS, when a Discord webhook is set): my own new donations ("🎁 Grom topped up the guild
// bank…") and badges I just earned ("🏅 Grom earned the Slayer badge!"). Like every Guild Camp post, Discord only
// hears about the player on this computer, so nothing is posted twice by two apps.
const Seasons = require('../services/seasons');
const Donations = require('../services/donations');
const { HttpError, str, needGuild, isOfficer } = require('../http');

const SHOUT_MS = 5 * 60 * 1000;
const SHOUT_RECENT_DAYS = 2;

function register(app, ctx) {
  const { db } = ctx;
  const log = ctx.log || console;

  app.get('/api/seasons', needGuild, (req, res) => {
    const gid = req.guild.id;
    Donations.capture(db, gid);
    const s = Seasons.season(db, gid, { month: str(req.query.month, 7) });
    const badges = Seasons.badgesOf(db, gid);
    for (const p of s.players) p.badges = badges[p.userId] || [];
    const announced = db.prepare('SELECT posted_at FROM season_posts WHERE guild_id = ? AND month = ?').get(gid, s.month);
    res.json({
      ...s,
      me: req.user.id,
      mine: s.players.find((p) => p.userId === req.user.id) || null,
      myBadges: badges[req.user.id] || [],
      allBadges: Seasons.BADGES.map(([id, name, what, n]) => ({ id, name, what, n })),
      hall: Seasons.hall(db, gid),
      canAnnounce: isOfficer(req) && !s.current,
      announced: announced ? announced.posted_at : null,
      discord: Boolean(ctx.cfg.discordWebhook),
    });
  });

  app.post('/api/seasons/announce', needGuild, async (req, res) => {
    if (!isOfficer(req)) throw new HttpError(403, 'Only officers announce the season\'s winners.');
    const gid = req.guild.id;
    const month = str(req.body && req.body.month, 7);
    const s = Seasons.season(db, gid, { month });
    if (s.current) throw new HttpError(409, 'This season is still running. Announce it once the month is over.');
    if (!ctx.cfg.discordWebhook) throw new HttpError(409, 'Add your guild\'s Discord webhook in Settings → Discord first.');
    const done = db.prepare('SELECT 1 FROM season_posts WHERE guild_id = ? AND month = ?').get(gid, s.month);
    if (done && !(req.body && req.body.force === true)) throw new HttpError(409, 'This season\'s winners were already announced from this app.');
    const text = Seasons.announceText(s);
    if (!text) throw new HttpError(409, 'Nobody scored this season, so there\'s nobody to crown.');
    if (!(await ctx.discord(null, text))) throw new HttpError(502, 'Discord didn\'t take the message. Check the webhook in Settings → Discord.');
    db.prepare('INSERT INTO season_posts (guild_id, month) VALUES (?, ?) ON CONFLICT(guild_id, month) DO UPDATE SET posted_at = datetime(\'now\')').run(gid, s.month);
    ctx.audit(req, 'season.announce', { month: s.month });
    res.json({ posted: true, month: s.month });
  });

  // ---- shout-outs ----
  async function shoutOuts() {
    if (!ctx.cfg.discordWebhook) return 0;
    const me = ctx.me && ctx.me();
    const g = ctx.guild && ctx.guild();
    if (!me || !g) return 0;
    const gid = g.id;
    Donations.capture(db, gid);
    let n = 0;
    const mine = db.prepare(`SELECT d.*, COALESCE(nm.name, i.name) AS item_name FROM donations d
      LEFT JOIN item_names nm ON nm.item_id = d.item_id LEFT JOIN item_info i ON i.item_id = d.item_id
      WHERE d.guild_id = ? AND d.user_id = ? AND d.shouted = 0 AND d.value IS NOT NULL AND d.at >= ? ORDER BY d.at LIMIT 5`)
      .all(gid, me.id, new Date(Date.now() - SHOUT_RECENT_DAYS * 86400000).toISOString().replace('T', ' ').slice(0, 19));
    for (const d of mine) {
      if (await ctx.discord(null, Seasons.donationText(d))) { db.prepare('UPDATE donations SET shouted = 1 WHERE id = ?').run(d.id); n += 1; }
    }
    // Old donations (before shout-outs existed, or older than SHOUT_RECENT_DAYS) are marked so they never go out.
    db.prepare('UPDATE donations SET shouted = 1 WHERE guild_id = ? AND user_id = ? AND shouted = 0 AND at < ?')
      .run(gid, me.id, new Date(Date.now() - SHOUT_RECENT_DAYS * 86400000).toISOString().replace('T', ' ').slice(0, 19));

    const badges = Seasons.badgesOf(db, gid)[me.id] || [];
    const seen = new Set(db.prepare('SELECT badge FROM my_badges WHERE guild_id = ? AND user_id = ?').all(gid, me.id).map((r) => r.badge));
    // The first time: remember what I already had, without posting it all ('_start' marks that it happened).
    const first = !seen.has('_start');
    if (first) db.prepare("INSERT OR IGNORE INTO my_badges (guild_id, user_id, badge) VALUES (?, ?, '_start')").run(gid, me.id);
    const name = (Seasons.season(db, gid).players.find((p) => p.userId === me.id) || {}).name
      || String(me.battletag || '').split('#')[0];
    for (const b of badges) {
      if (seen.has(b.id)) continue;
      if (!first && !(await ctx.discord(null, Seasons.badgeText(name, b)))) continue;
      db.prepare('INSERT OR IGNORE INTO my_badges (guild_id, user_id, badge) VALUES (?, ?, ?)').run(gid, me.id, b.id);
      if (!first) n += 1;
    }
    return n;
  }
  ctx.services.seasons = { shoutOuts };
  if (ctx.cfg.timers) {
    const h = setInterval(() => { shoutOuts().catch((err) => log.warn(`Season shout-outs failed: ${err.message}`)); }, SHOUT_MS);
    if (h.unref) h.unref();
    ctx.timers.push(h);
  }
}

module.exports = { register, SHOUT_MS };
