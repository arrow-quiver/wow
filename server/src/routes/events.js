// Core: notifications for the desktop app. The app polls GET /api/events?after=<latestId>
// every 20 s and shows a native notification for each event returned. See services/events.js.
const { HttpError, int, needUser } = require('../http');

function register(app, ctx) {
  app.get('/api/events', needUser, (req, res) => {
    // Not in a guild yet: nothing to notify about. Polling keeps working instead of erroring.
    if (!req.guild) return res.json({ events: [], latestId: 0 });
    let after = null;
    if (req.query.after !== undefined) {
      after = int(req.query.after, 0);
      if (after == null) throw new HttpError(400, 'The event cursor must be a number.');
    }
    res.json(ctx.events.listFor(req.user, req.guild.id, req.guild.role, after, req.user.notify_prefs));
  });
}

module.exports = { register };
