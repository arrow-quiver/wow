// Calendar feeds, web push and Blizzard API status.
const { buildIcs, calendarToken } = require('../calendar');
const blizzard = require('../blizzard');

module.exports = function freebies(app, { db, cfg, push, needGuild, needOfficer, back, audit }) {
  // ---- calendar feed (public URL with a secret token, like Google's "secret address") ----
  app.get('/calendar/:token([\\w-]{20,}).ics', (req, res) => {
    const u = db.prepare('SELECT * FROM users WHERE calendar_token = ?').get(req.params.token);
    const m = u && db.prepare('SELECT g.* FROM memberships ms JOIN guilds g ON g.id = ms.guild_id WHERE ms.user_id = ?').get(u.id);
    if (!m) return res.status(404).type('text/plain').send('Calendar not found. Get a fresh link from Settings.');
    const raids = db.prepare(`SELECT r.*, s.status AS signup, (SELECT COUNT(*) FROM signups x WHERE x.raid_id = r.id AND x.status = 'yes') AS coming
      FROM raids r LEFT JOIN signups s ON s.raid_id = r.id AND s.user_id = ? WHERE r.guild_id = ? AND r.starts_at > ? ORDER BY r.starts_at`)
      .all(u.id, m.id, new Date(Date.now() - 30 * 86400000).toISOString());
    res.setHeader('Cache-Control', 'private, max-age=600');
    res.type('text/calendar; charset=utf-8').send(buildIcs({ guildName: m.name, baseUrl: cfg.baseUrl, raids }));
  });
  app.post('/settings/calendar/reset', needGuild, (req, res) => {
    db.prepare('UPDATE users SET calendar_token = ? WHERE id = ?').run(calendarToken(), req.user.id);
    audit(req, 'calendar link replaced');
    back(res, '/settings', 'New calendar link made. Re-add it to your calendar; the old link stopped working.');
  });

  // ---- web push ----
  app.get('/push/key', needGuild, (req, res) => res.json({ publicKey: push.publicKey }));
  app.post('/push/subscribe', needGuild, (req, res) => {
    const s = req.body && req.body.subscription;
    if (!s || typeof s.endpoint !== 'string' || !/^https:\/\//.test(s.endpoint) || !s.keys || !s.keys.p256dh || !s.keys.auth) return res.status(400).json({ error: 'Bad subscription' });
    db.prepare(`INSERT INTO push_subs (user_id, guild_id, endpoint, p256dh, auth) VALUES (?,?,?,?,?)
      ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, guild_id = excluded.guild_id, p256dh = excluded.p256dh, auth = excluded.auth`)
      .run(req.user.id, req.guild.id, s.endpoint.slice(0, 1000), String(s.keys.p256dh).slice(0, 200), String(s.keys.auth).slice(0, 100));
    res.json({ ok: true });
  });
  app.post('/push/unsubscribe', needGuild, (req, res) => {
    const endpoint = req.body && req.body.endpoint;
    if (endpoint) db.prepare('DELETE FROM push_subs WHERE endpoint = ? AND user_id = ?').run(endpoint, req.user.id);
    else db.prepare('DELETE FROM push_subs WHERE user_id = ?').run(req.user.id);
    res.json({ ok: true });
  });
  app.post('/push/prefs', needGuild, (req, res) => {
    const prefs = {};
    for (const k of ['cta', 'raids', 'notices', 'requests']) prefs[k] = req.body[k] === 'on';
    db.prepare('UPDATE push_subs SET prefs = ? WHERE user_id = ?').run(JSON.stringify(prefs), req.user.id);
    back(res, '/settings', 'Notification choices saved.');
  });
  app.post('/push/test', needGuild, async (req, res) => {
    const n = await push.notify(req.guild.id, 'notices', { title: 'wow guild', body: 'Notifications are working.', url: '/' }, { userIds: [req.user.id], ignorePrefs: true });
    back(res, '/settings', n ? `Test sent to ${n} device${n === 1 ? '' : 's'}.` : 'No devices with notifications turned on yet.');
  });

  // ---- Blizzard API status ----
  app.post('/admin/blizzard', needOfficer, async (req, res) => {
    try { const s = await blizzard.check(cfg); blizzard.save(db, s); back(res, '/admin', 'Blizzard API checked.'); } catch (e) { back(res, '/admin', `Blizzard API check failed: ${e.message}`); }
  });
};
