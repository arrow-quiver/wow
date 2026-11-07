// Calendar feeds: each member gets a private .ics address (like Google's "secret address") that lists
// the guild's raids and events with their own sign-up, so Google, Apple or Outlook calendar keep them
// up to date. Ported from the old routes/freebies.js and the old Settings page.
// Shapes are documented in docs/api/admin.md.
const { HttpError, needGuild } = require('../http');
const { buildIcs, calendarToken, feedRaids } = require('../services/calendar');

const TOKEN_RE = /^[\w-]{20,64}$/;

function register(app, ctx) {
  const { db, cfg } = ctx;
  const q = {
    byToken: db.prepare('SELECT * FROM users WHERE calendar_token = ?'),
    guildOf: db.prepare('SELECT g.* FROM memberships ms JOIN guilds g ON g.id = ms.guild_id WHERE ms.user_id = ? ORDER BY ms.joined_at, ms.guild_id LIMIT 1'),
    token: db.prepare('SELECT calendar_token FROM users WHERE id = ?'),
    setToken: db.prepare('UPDATE users SET calendar_token = ? WHERE id = ?'),
  };

  // The feed address in the forms calendar apps want.
  const links = (token) => {
    const url = `${cfg.baseUrl}/calendar/${token}.ics`;
    const webcalUrl = url.replace(/^https?:/, 'webcal:');
    return { url, webcalUrl, googleUrl: `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcalUrl)}` };
  };

  // Writes a new token. A clash with someone else's token is astronomically unlikely, but the unique
  // index would reject it, so try again rather than fail.
  function newToken(userId) {
    for (let i = 0; i < 5; i++) {
      const t = calendarToken();
      try {
        q.setToken.run(t, userId);
        return t;
      } catch (e) {
        if (!/UNIQUE/i.test(e.message)) throw e;
      }
    }
    throw new HttpError(500, 'Could not make a calendar link. Try again.');
  }

  // ---- the public feed (the token is the secret) ----
  app.get('/calendar/:token.ics', (req, res) => {
    const token = String(req.params.token || '');
    const user = TOKEN_RE.test(token) ? q.byToken.get(token) : null;
    const guild = user && q.guildOf.get(user.id);
    if (!guild) {
      res.status(404).type('text/plain; charset=utf-8').send('Calendar not found. Get a fresh link in Guild Camp under Settings.');
      return;
    }
    const ics = buildIcs({ guildName: guild.name, baseUrl: cfg.baseUrl, raids: feedRaids(db, guild.id, user.id) });
    res.setHeader('Cache-Control', 'private, max-age=600');
    res.type('text/calendar; charset=utf-8').send(ics);
  });

  // ---- the member's own link (made on first use) ----
  app.get('/api/calendar', needGuild, (req, res) => {
    const row = q.token.get(req.user.id);
    const token = row && row.calendar_token ? row.calendar_token : newToken(req.user.id);
    res.json(links(token));
  });

  // A new link; the old one stops working at once.
  app.post('/api/calendar/reset', needGuild, (req, res) => {
    const token = newToken(req.user.id);
    ctx.audit(req, 'calendar link replaced');
    res.json({ ...links(token), message: 'New calendar link made. Add it to your calendar again; the old link stopped working.' });
  });
}

module.exports = { register };
