'use strict';
// Calendar export: the guild's raids and events as an .ics file, with my own sign-up on each.
// The app's calendar.export() saves this text with a save dialog; the player imports the file into
// Google, Apple or Outlook calendar. (There is no feed address to subscribe to any more.)
//
//   GET /api/calendar.ics   → text/calendar
const { needGuild } = require('../http');
const { buildIcs, feedRaids } = require('../services/calendar');

function register(app, ctx) {
  const { db } = ctx;
  app.get('/api/calendar.ics', needGuild, (req, res) => {
    const ics = buildIcs({ guildName: req.guild.name, raids: feedRaids(db, req.guild.id, req.user.id) });
    res.setHeader('Cache-Control', 'no-store');
    res.type('text/calendar; charset=utf-8').send(ics);
  });
}

module.exports = { register };
