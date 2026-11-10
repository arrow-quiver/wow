// Celebrations (services/celebrate.js).
//
//   POST /api/celebrate   from the app itself: a "[Guild Camp] <what> — from <me>" line of mine the app read from
//                         the chat log (main/live.js). { what, from } → { posted }: the Discord post and an activity
//                         line. The same line within 15 minutes posts once.
// Every hour (with timers): my own anniversaries today (time in the guild, character birthdays) go to Discord once.
const Celebrate = require('../services/celebrate');
const CtaDiscord = require('../services/ctaDiscord');
const { HttpError, str, needGuild } = require('../http');

function register(app, ctx) {
  const { db } = ctx;
  const log = ctx.log || console;

  app.post('/api/celebrate', needGuild, async (req, res) => {
    const what = str(req.body && req.body.what, 255);
    const from = str(req.body && req.body.from, 48);
    if (!what) throw new HttpError(400, 'Say what to celebrate.');
    const text = Celebrate.discordText({ what, from });
    if (!text) return res.json({ posted: false });
    // The same line again (the chat log read twice, a second app): nothing new.
    const c = { character: from, zone: `celebrate:${what}`, message: '' };
    const at = CtaDiscord.claim(db, req.guild.id, c);
    if (!at) return res.json({ posted: false, duplicate: true });
    ctx.activity(req.guild.id, 'celebrate', Celebrate.linkName(what));
    let posted = false;
    if (ctx.cfg.discordWebhook) {
      posted = Boolean(await ctx.discord(null, text));
      if (!posted) CtaDiscord.release(db, req.guild.id, c, at);
    }
    res.json({ posted });
  });

  async function anniversaries() {
    const me = ctx.me && ctx.me(); const g = ctx.guild && ctx.guild();
    if (!me || !g || !ctx.cfg.discordWebhook) return 0;
    const today = new Date().toISOString().slice(0, 10);
    let n = 0;
    for (const a of Celebrate.anniversaries(db, g.id).filter((x) => x.userId === me.id)) {
      const key = `${a.kind}:${a.name}:${today}`;
      const r = db.prepare('INSERT OR IGNORE INTO celebrated (guild_id, user_id, key) VALUES (?, ?, ?)').run(g.id, me.id, key);
      if (!r.changes) continue;
      if (await ctx.discord(null, Celebrate.anniversaryDiscord(a))) n += 1;
    }
    return n;
  }
  ctx.services.celebrate = { anniversaries };
  if (ctx.cfg.timers) {
    const h = setInterval(() => { anniversaries().catch((err) => log.warn(`Anniversaries: ${err.message}`)); }, 60 * 60 * 1000);
    if (h.unref) h.unref();
    ctx.timers.push(h);
  }
}

module.exports = { register };
