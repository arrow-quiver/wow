// How I actually play (services/playstyle.js).
//
//   POST /api/play/session   from the app itself (main/main.js, the live link's session every minute while it
//                            changes): { character, startedAt, lastAt, minutes, kills, pvpKills, deaths, pvpDeaths,
//                            damageDone, damageTaken, healingTaken, fights, fightShare } → { saved }
//   GET  /api/coach/report?char=   the weekly report for one of my characters (my main by default)
const Playstyle = require('../services/playstyle');
const { HttpError, str, int, num } = require('../http');

function register(app, ctx) {
  const { db } = ctx;
  const n = (v) => int(v, 0, 1e12) || 0;

  app.post('/api/play/session', (req, res) => {
    const b = req.body || {};
    const character = str(b.character, 48);
    const startedAt = int(b.startedAt, 1, 1e13);
    const lastAt = int(b.lastAt, 1, 1e13);
    if (!character || !startedAt || !lastAt || lastAt < startedAt) throw new HttpError(400, 'A session needs the character and when it started and last changed.');
    db.prepare(`INSERT INTO play_sessions (user_id, character, started_at, last_at, minutes, kills, pvp_kills, deaths, pvp_deaths,
        damage_done, damage_taken, healing_taken, fights, fight_share)
      VALUES (@user, @character, @startedAt, @lastAt, @minutes, @kills, @pvpKills, @deaths, @pvpDeaths, @damageDone, @damageTaken, @healingTaken, @fights, @fightShare)
      ON CONFLICT (user_id, character, started_at) DO UPDATE SET last_at = excluded.last_at, minutes = excluded.minutes,
        kills = excluded.kills, pvp_kills = excluded.pvp_kills, deaths = excluded.deaths, pvp_deaths = excluded.pvp_deaths,
        damage_done = excluded.damage_done, damage_taken = excluded.damage_taken, healing_taken = excluded.healing_taken,
        fights = excluded.fights, fight_share = excluded.fight_share`).run({
      user: req.user.id, character, startedAt, lastAt, minutes: int(b.minutes, 0, 100000) || 0,
      kills: n(b.kills), pvpKills: n(b.pvpKills), deaths: n(b.deaths), pvpDeaths: n(b.pvpDeaths),
      damageDone: n(b.damageDone), damageTaken: n(b.damageTaken), healingTaken: n(b.healingTaken), fights: n(b.fights),
      fightShare: num(b.fightShare, 0, 1) || 0,
    });
    res.json({ saved: true });
  });

  app.get('/api/coach/report', (req, res) => {
    let character = str(req.query.char, 48);
    if (!character) {
      const main = db.prepare('SELECT name FROM characters WHERE user_id = ? ORDER BY is_main DESC, level DESC LIMIT 1').get(req.user.id);
      const played = db.prepare('SELECT character FROM play_sessions WHERE user_id = ? ORDER BY last_at DESC LIMIT 1').get(req.user.id);
      character = (played && played.character) || (main && main.name) || '';
    }
    if (!character) throw new HttpError(404, 'No character yet. Log in with the addon and /reload once.');
    res.json(Playstyle.report(db, req.user.id, character));
  });
}

module.exports = { register };
