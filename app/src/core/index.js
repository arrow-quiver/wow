'use strict';
// The local core: the old guild server's domain logic, running inside the Electron main process.
//
//   const core = await createCore({ dataDir, log, getIdentity, getSecret, getSettings, credentials });
//   core.url      'http://127.0.0.1:<random port>'   (main's api.js sends Authorization: Bearer <core.token>)
//   core.token    random secret made at each launch
//   core.emitter  emits 'event' { id, kind, title, body, route, created_at } (a notification for me),
//                 'session' (session()) when who I am, my guild, my role or the guild's Wowhead database or
//                 officer / relay ranks changed (after a request that writes), and 'outbox' when a change
//                 was queued for the addon to share (the app's sync engine then rewrites the inbox)
//   core.setIdentity({ battletag, characters })   after Battle.net sign-in / sign-out in the app
//   core.session() → { user, guild, role }        (the same shapes as GET /api/me, without HTTP)
//   await core.close()                            stops the timers and the server, closes the database
//
// Options
//   dataDir      folder for guildcamp.db (and backups/). Required unless dbFile is given.
//   log          { info, warn, error } (default: silent)
//   getIdentity  () → { battletag|null, characters: [...] }   read once at start; later changes come via setIdentity
//   getSecret    (name) → string|null   ('anthropicKey' for the Coach AI)
//   getSettings  () → app settings (discordWebhook, bnetRegion)
//   credentials  { clientId, clientSecret } | null   built-in Battle.net app (Blizzard game data)
//   getLatest    () → { app: version|{version}|null, addon: version|{version}|null }   newest releases (optional)
//   Test options: fetch (stand-in for outside HTTP), timers: false, dbFile (':memory:'), coachWaitMs,
//   extraRoutes ([register(app, ctx)], mounted after the real routes).
const crypto = require('crypto');
const path = require('path');
const { EventEmitter } = require('events');
const { open } = require('./db');
const { createConfig } = require('./config');
const { createContext } = require('./context');
const { createApp } = require('./app');
const identity = require('./identity');
const sharing = require('./sharing');
const { guildJson, userJson } = require('./http');

const silent = { info() {}, warn() {}, error() {}, debug() {} };

function listen(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
    server.once('error', reject);
  });
}

async function createCore({
  dataDir, log, getIdentity, getSecret, getSettings, credentials, getLatest,
  fetch, timers = true, dbFile, coachWaitMs, extraRoutes,
} = {}) {
  if (!dataDir && !dbFile) throw new Error('createCore needs a data folder.');
  const logger = log || silent;
  const cfg = createConfig({
    dataDir, dbFile: dbFile || (dataDir ? path.join(dataDir, 'guildcamp.db') : undefined),
    getSecret, getSettings, credentials, fetch, timers, coachWaitMs,
  });
  const db = open(cfg.dbFile);
  const emitter = new EventEmitter();
  let ctx;
  let server = null;
  try {
    ctx = createContext(cfg, db, { log: logger, emitter, getLatest });
    identity.ensureMe(db);

    const session = () => {
      const me = identity.ensureMe(db);
      const g = identity.myMembership(db);
      const role = g ? g.role : null;
      return { user: userJson(me), guild: guildJson(g, { role, discordWebhook: cfg.discordWebhook }), role };
    };
    // What other pages read from the session: who I am, the guild and my role, and the guild settings they use
    // (the Wowhead database for item links, the ranks for roles), whether changed here or by an imported CFG.
    const signature = () => {
      const s = session();
      const g = s.guild || {};
      return JSON.stringify([s.user && s.user.battletag, g.id, g.name, s.role, g.wowhead_game, g.officer_rank_max, g.relay_rank_max]);
    };
    let lastSignature = signature();
    const checkSession = () => {
      try {
        const now = signature();
        if (now === lastSignature) return;
        lastSignature = now;
        emitter.emit('session', session());
      } catch (e) {
        logger.warn('Session check failed:', e.message);
      }
    };

    const setIdentity = (value) => {
      try {
        identity.applyIdentity(db, value);
      } catch (e) {
        logger.warn('Saving your Battle.net details failed:', e.message);
      }
      checkSession();
    };
    if (typeof getIdentity === 'function') {
      try { identity.applyIdentity(db, getIdentity()); } catch (e) { logger.warn('Reading your Battle.net details failed:', e.message); }
      lastSignature = signature();
    }
    // Once: who I am, repaired where an older version let a guildmate's change decide it (asks rather than guesses).
    try {
      const fixed = sharing.repairIdentity(db);
      if (fixed.unlinked.length || fixed.asked) logger.info(`Checked who you are in your guilds: ${fixed.asked} question${fixed.asked === 1 ? '' : 's'} to answer under Sharing.`);
    } catch (e) {
      logger.warn('Checking who you are in your guilds failed:', e.message);
    }

    const token = crypto.randomBytes(32).toString('base64url');
    const app = createApp(ctx, { token, afterWrite: checkSession, extraRoutes });
    server = await listen(app);
    const url = `http://127.0.0.1:${server.address().port}`;
    logger.info(`Local data service ready (${cfg.dbFile === ':memory:' ? 'in memory' : cfg.dbFile}).`);

    let closed = false;
    async function close() {
      if (closed) return;
      closed = true;
      for (const t of ctx.timers.splice(0)) { clearInterval(t); clearTimeout(t); }
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      await new Promise((resolve) => server.close(() => resolve()));
      try { db.close(); } catch (e) { logger.warn('Closing the database failed:', e.message); }
    }

    return { url, token, emitter, close, setIdentity, session, db, ctx };
  } catch (err) {
    if (ctx) for (const t of ctx.timers.splice(0)) { clearInterval(t); clearTimeout(t); }
    if (server) server.close();
    try { db.close(); } catch { /* already failing */ }
    throw err;
  }
}

module.exports = { createCore };
