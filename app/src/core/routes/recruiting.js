// Recruiting (services/recruiting.js). The finding and messaging happen in game (Recruit.lua); here the guild sees
// who it's in touch with and officers set the ad and message.
//
//   GET /api/recruiting            { recruits, stats, settings, canEdit, points, stayDays }
//   PUT /api/recruiting/settings   officers: { ad, msg, classes, minLevel, maxLevel } → the "RA" record
const R = require('../services/recruiting');
const sharing = require('../sharing');
const { HttpError, str, int, needGuild, isOfficer } = require('../http');

const CLASSES = ['WARRIOR', 'PALADIN', 'HUNTER', 'ROGUE', 'PRIEST', 'SHAMAN', 'MAGE', 'WARLOCK', 'DRUID'];

function register(app, ctx) {
  const { db } = ctx;

  app.get('/api/recruiting', needGuild, (req, res) => {
    res.json({ recruits: R.list(db, req.guild.id), stats: R.stats(db, req.guild.id), settings: R.settings(db, req.guild.id),
      canEdit: isOfficer(req), points: R.RECRUIT_POINTS, stayDays: R.STAY_DAYS, classes: CLASSES });
  });

  app.put('/api/recruiting/settings', needGuild, (req, res) => {
    if (!isOfficer(req)) throw new HttpError(403, 'Only officers change the recruiting ad and message.');
    const b = req.body || {};
    const ad = str(b.ad, 255);
    const msg = str(b.msg, 200);
    if (!ad || !msg) throw new HttpError(400, 'Write both the channel ad and the message recruiters send.');
    if (/https?:\/\/|www\.|discord\.gg/i.test(`${ad} ${msg}`)) throw new HttpError(400, 'No links in game: Blizzard counts them as advertising. Give your Discord once they join.');
    const classes = (Array.isArray(b.classes) ? b.classes : String(b.classes || '').split(','))
      .map((c) => String(c).trim().toUpperCase()).filter((c) => CLASSES.includes(c));
    const minLevel = int(b.minLevel, 1, 60) || 1;
    const maxLevel = Math.max(minLevel, int(b.maxLevel, 1, 60) || 60);
    sharing.queue(db, ctx, { type: 'RA', key: '1', fields: { ad, msg, classes: [...new Set(classes)].join(','), minLevel, maxLevel }, need: 'o' });
    ctx.audit(req, 'recruiting settings', ad.slice(0, 60));
    res.json({ ok: true, settings: R.settings(db, req.guild.id), message: 'Saved and shared with the guild\'s addons.' });
  });
}

module.exports = { register };
