// War alerts and the war map.
//
//   POST /api/war/death   a death the app's live link saw (main/main.js, from main/live.js). Saved in pvp_deaths; a
//                         death to players is posted to the guild's Discord when `alert` is on, a webhook is set and
//                         the last post was over ALERT_GAP_MS ago.        → { saved, posted }
//   POST /api/war/help    { zone?, message? } "Call for help" from the Coach overlay: posts to Discord at once, with
//                         the zone and the players of my last death to players (under HELP_RECENT_MS old).
//                         → { posted } (409 without a webhook, 429 more than once a minute)
//   GET  /api/war?days=7  the War page: the guild's marks by zone (from "wm" records), hotspots, my recent deaths
//                         and nemeses. Shapes: docs/api/war.md.
//
// Discord only ever hears what the player on this computer did (like every Guild Camp post).
const W = require('../services/war');
const st = require('../share/store');
const { HttpError, str, int, num, bool, list } = require('../http');

const ALERT_GAP_MS = 2 * 60 * 1000;
const HELP_GAP_MS = 60 * 1000;
const HELP_RECENT_MS = 10 * 60 * 1000;

function register(app, ctx) {
  const { db } = ctx;
  const log = ctx.log || console;
  const now = () => st.localNow() * 1000; // the sharing clock (tests fix it)
  let lastHelp = 0;

  const q = {
    insert: db.prepare(`INSERT OR IGNORE INTO pvp_deaths (guild_id, user_id, character, at, pvp, killer, enemies, zone, zone_id, spell,
      amount, seconds, damage_taken, healed) VALUES (@guildId, @userId, @character, @at, @pvp, @killer, @enemies, @zone, @zoneId, @spell,
      @amount, @seconds, @damageTaken, @healed)`),
    lastPosted: db.prepare('SELECT MAX(at) AS at FROM pvp_deaths WHERE user_id = ? AND posted = 1'),
    markPosted: db.prepare('UPDATE pvp_deaths SET posted = 1 WHERE id = ?'),
    lastPvp: db.prepare('SELECT * FROM pvp_deaths WHERE user_id = ? AND pvp = 1 ORDER BY at DESC LIMIT 1'),
  };

  app.post('/api/war/death', async (req, res) => {
    const b = req.body || {};
    const character = str(b.character, 48);
    const at = int(b.at, 0);
    if (!character || !at) throw new HttpError(400, 'A death needs the character and when it happened.');
    const enemies = list(b.enemies, 40).map((e) => str(e, 48)).filter(Boolean);
    const row = {
      guildId: req.guild ? req.guild.id : null, userId: req.user.id, character, at, pvp: bool(b.pvp) ? 1 : 0,
      killer: str(b.killer, 60), enemies: JSON.stringify(enemies), zone: str(b.zone, 60), zoneId: int(b.zoneId, 0),
      spell: str(b.spell, 80), amount: int(b.amount, 0), seconds: num(b.seconds, 0, 3600), damageTaken: int(b.damageTaken, 0), healed: int(b.healed, 0),
    };
    const r = q.insert.run(row);
    const saved = r.changes > 0;
    let posted = false;
    if (saved && row.pvp && bool(b.alert) && ctx.cfg.discordWebhook) {
      const last = q.lastPosted.get(req.user.id).at || 0;
      if (at - last >= ALERT_GAP_MS) {
        posted = await ctx.discord(null, W.alertText({ ...row, enemies }));
        if (posted) q.markPosted.run(r.lastInsertRowid);
      }
    }
    res.json({ saved, posted });
  });

  app.post('/api/war/help', async (req, res) => {
    if (!ctx.cfg.discordWebhook) throw new HttpError(409, 'Add your guild\'s Discord webhook in Settings → Discord first.');
    const t = now();
    if (t - lastHelp < HELP_GAP_MS) throw new HttpError(429, 'You called for help a moment ago. Give the guild a minute.');
    const b = req.body || {};
    const d = q.lastPvp.get(req.user.id);
    const recent = d && t - d.at <= HELP_RECENT_MS ? d : null;
    const text = W.helpText({
      character: str(b.character, 48) || (recent && recent.character) || String(req.user.battletag || 'A guildmate').split('#')[0],
      zone: str(b.zone, 60) || (recent && recent.zone), enemies: recent ? JSON.parse(recent.enemies || '[]') : [],
      message: str(b.message, 200),
    });
    const posted = await ctx.discord(null, text);
    if (!posted) throw new HttpError(502, 'Discord didn\'t take the message. Check the webhook in Settings → Discord.');
    lastHelp = t;
    log.info('Called the guild for help on Discord.');
    res.json({ posted: true });
  });

  app.get('/api/war', (req, res) => {
    const days = int(req.query.days, 1, 60) || 7;
    res.json(W.overview(db, { guildId: req.guild ? req.guild.id : null, userId: req.user.id, days, now: now(),
      alerts: Boolean(ctx.cfg.discordWebhook) }));
  });
}

module.exports = { register, ALERT_GAP_MS, HELP_GAP_MS };
