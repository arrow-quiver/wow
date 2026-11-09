'use strict';
// The `ctx` object every route file receives in register(app, ctx).
//
// ctx = {
//   db, cfg, log,
//   events,                       // { emit, recent, prune } from events.js
//   emit(guildId, kind, opts),    // notification for me, when I should see it (events.js)
//   audit(req, action, detail),   // audit_log row for req.guild / req.user
//   activity(guildId, kind, text),
//   discord(guild, content),      // POST to the webhook in Settings (the guild argument is ignored). Never throws.
//   me(), guild(),                // my users row; the current guild with my role (or null)
//   services: {},                 // domain services attach here (ctx.services.coach, ...)
//   timers: [],                   // setInterval/setTimeout handles; close() clears them
//   latest(),                     // { app: {version}|null, addon: {version}|null } from the app's updater/addon manager
//   outboxChanged(),              // sharing.queue() calls this: the emitter sends 'outbox', and the app's sync
//                                 // engine rewrites the inbox for the addon within 2 s
// }
const { createEvents } = require('./events');
const identity = require('./identity');

function createContext(cfg, db, { log = console, emitter, getLatest } = {}) {
  const q = {
    audit: db.prepare('INSERT INTO audit_log (guild_id, user_id, action, detail) VALUES (?,?,?,?)'),
    activity: db.prepare('INSERT INTO activity (guild_id, kind, text) VALUES (?,?,?)'),
    role: db.prepare('SELECT role FROM memberships WHERE user_id = ? AND guild_id = ?'),
  };
  const events = createEvents(db, {
    log,
    emitter,
    meId: () => identity.meId(db),
    roleOf: (guildId) => (q.role.get(identity.meId(db), guildId) || {}).role || null,
  });

  const ctx = {
    db,
    cfg,
    log,
    events,

    // Records officer and account actions so the guild can see who changed what.
    audit(req, action, detail = '') {
      if (!req || !req.guild) return;
      q.audit.run(req.guild.id, req.user ? req.user.id : null, String(action).slice(0, 100), String(detail ?? '').slice(0, 300));
    },

    // A line on the Camp activity feed.
    activity(guildId, kind, text) {
      q.activity.run(guildId, String(kind).slice(0, 30), String(text).slice(0, 300));
    },

    emit: (guildId, kind, opts) => events.emit(guildId, kind, opts),

    // Posts to the Discord webhook from Settings. No-op without one. Never throws.
    // Only called for things the player on this computer did. Resolves true when Discord accepted it.
    async discord(guild, content) {
      const url = cfg.discordWebhook;
      if (!url || !content) return false;
      try {
        const res = await cfg.fetch(url, {
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

    // Something was queued for the addon to send (sharing.js): the app rewrites the inbox soon.
    outboxChanged() {
      if (!emitter) return;
      try { emitter.emit('outbox'); } catch (e) { log.warn('An outbox listener failed:', e.message); }
    },

    me: () => identity.ensureMe(db),
    guild: () => identity.myMembership(db),

    services: {},
    timers: [],

    latest() {
      let l = null;
      try { l = typeof getLatest === 'function' ? getLatest() : null; } catch (e) { log.warn('Latest versions unavailable:', e.message); }
      const pick = (v) => {
        if (!v) return null;
        if (typeof v === 'string') return { version: v };
        return typeof v === 'object' && typeof v.version === 'string' ? { ...v } : null;
      };
      return { app: pick(l && l.app), addon: pick(l && l.addon) };
    },
  };
  return ctx;
}

module.exports = { createContext };
