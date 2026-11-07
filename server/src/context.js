// The `ctx` object every route file receives in register(app, ctx). See docs/ARCHITECTURE.md.
const { createEvents } = require('./services/events');

function createContext(cfg, db, { log = console } = {}) {
  const q = {
    audit: db.prepare('INSERT INTO audit_log (guild_id, user_id, action, detail) VALUES (?,?,?,?)'),
    activity: db.prepare('INSERT INTO activity (guild_id, kind, text) VALUES (?,?,?)'),
    latest: db.prepare('SELECT version, notes, file, size, sha256, sha512, created_at FROM releases WHERE kind = ? ORDER BY id DESC LIMIT 1'),
  };
  const events = createEvents(db, { log });

  const ctx = {
    db,
    cfg,
    log,
    events, // { emit, listFor, latestId, prune } from services/events.js

    // Records officer and account actions so the guild can see who changed what.
    // Uses req.guild and req.user; does nothing outside a guild.
    audit(req, action, detail = '') {
      if (!req || !req.guild) return;
      q.audit.run(req.guild.id, req.user ? req.user.id : null, String(action).slice(0, 100), String(detail ?? '').slice(0, 300));
    },

    // A line on the Camp activity feed.
    activity(guildId, kind, text) {
      q.activity.run(guildId, String(kind).slice(0, 30), String(text).slice(0, 300));
    },

    // Notification for the desktop app. See services/events.js for the options.
    emit: (guildId, kind, opts) => events.emit(guildId, kind, opts),

    // Posts to the guild's Discord webhook. No-op without one. Never throws.
    // Resolves true when Discord accepted the message.
    async discord(guild, content) {
      if (!guild || !guild.discord_webhook || !content) return false;
      try {
        const res = await cfg.fetch(guild.discord_webhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: String(content).slice(0, 1900), allowed_mentions: { parse: [] } }),
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) log.warn(`Discord webhook failed: HTTP ${res.status}`);
        return Boolean(res.ok);
      } catch (e) {
        log.warn('Discord webhook failed:', e.message);
        return false;
      }
    },

    // Domain services attach here so routes can share them (ctx.services.coach, ctx.services.releases, ...).
    services: {},

    // Interval/timeout handles. index.js (and tests) clear them on shutdown via stopTimers().
    timers: [],

    // Latest published releases: { app: {...}|null, addon: {...}|null }.
    // When the releases domain registers ctx.services.releases.latest(), that wins (it can add
    // download URLs and the bundled-addon fallback). Otherwise the newest rows of the releases table.
    latest() {
      const svc = ctx.services.releases;
      if (svc && typeof svc.latest === 'function') return svc.latest();
      return { app: q.latest.get('app') || null, addon: q.latest.get('addon') || null };
    },
  };
  return ctx;
}

module.exports = { createContext };
