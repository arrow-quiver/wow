// Builds the Express app: security headers, rate limits, body parsing, bearer auth, then every
// route file in src/routes (sorted by name), then the JSON 404 and error handlers.
const express = require('express');
const fs = require('fs');
const path = require('path');
const A = require('./auth');
const { HttpError, ver, sendHtmlError } = require('./http');
const { rateLimit } = require('./ratelimit');
const { createContext } = require('./context');

const ROUTES_DIR = path.join(__dirname, 'routes');
// Old companion sync keys (wowg_…) still work here, and only here, while members switch to the app.
const LEGACY_PATHS = new Set(['/api/sync', '/api/inbox', '/api/inbox.lua']);
// Default limits per minute. cfg.rateLimits can override any of them (tests use this).
const RATE_LIMITS = { sync: 40, auth: 20, discord: 120, publish: 30 };

function createApp(cfg, db) {
  if (!cfg.sessionSecret) throw new Error('SESSION_SECRET must be set in production.');
  const app = express();
  const ctx = createContext(cfg, db);
  app.locals.ctx = ctx;
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  const https = cfg.baseUrl.startsWith('https://');

  // ---- Security headers. JSON gets a locked-down CSP; HTML pages set their own (http.sendHtml). ----
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    if (https) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
    next();
  });

  // ---- Rate limits ----
  const limits = { ...RATE_LIMITS, ...(cfg.rateLimits || {}) };
  const authHtml = (req, res, retryAfter, msg) => (req.originalUrl.startsWith('/api/')
    ? res.status(429).json({ error: msg })
    : sendHtmlError(res, 429, msg));
  app.use('/api/sync', rateLimit({ max: limits.sync, key: (req) => req.headers.authorization || req.ip, message: 'Too many uploads. Guild Camp will retry shortly.' }));
  app.use(['/auth', '/api/auth'], rateLimit({ max: limits.auth, message: 'Too many sign-in attempts. Wait a minute and try again.', onLimit: authHtml }));
  app.use('/discord', rateLimit({ max: limits.discord }));
  app.use('/api/publish', rateLimit({ max: limits.publish, message: 'Too many uploads. Wait a minute and try again.' }));

  // ---- Bodies ----
  // /discord keeps the raw bytes (Buffer in req.body) so the Ed25519 signature can be checked.
  app.use('/discord', express.raw({ type: () => true, limit: '1mb' }));
  // Uploads to /api/publish/* (PUT) stream straight to disk, so nothing reads their body here.
  // POST /api/publish/app/commit is a small JSON body and is parsed like any other call.
  const json = express.json({ limit: '15mb' });
  app.use('/api', (req, res, next) => {
    if (req.originalUrl.startsWith('/api/publish/') && req.method !== 'POST') return next();
    json(req, res, (err) => {
      if (err) return next(err);
      if (req.body === undefined) req.body = {};
      next();
    });
  });

  // ---- Bearer auth ----
  const q = {
    device: db.prepare('SELECT * FROM devices WHERE token_hash = ?'),
    user: db.prepare('SELECT * FROM users WHERE id = ?'),
    membership: db.prepare('SELECT g.*, m.role FROM memberships m JOIN guilds g ON g.id = m.guild_id WHERE m.user_id = ? ORDER BY m.joined_at, m.guild_id LIMIT 1'),
    touchDevice: db.prepare("UPDATE devices SET last_used_at = datetime('now') WHERE id = ?"),
    deviceVersion: db.prepare('UPDATE devices SET app_version = ? WHERE id = ?'),
    userVersion: db.prepare('UPDATE users SET app_version = ? WHERE id = ?'),
    // A legacy key only counts while its owner is still a member of the key's guild.
    legacy: db.prepare(`SELECT t.id, t.user_id, t.guild_id, t.prefix, t.last_used_at, ms.role FROM api_tokens t
      JOIN memberships ms ON ms.user_id = t.user_id AND ms.guild_id = t.guild_id WHERE t.token_hash = ?`),
    guild: db.prepare('SELECT * FROM guilds WHERE id = ?'),
    touchLegacy: db.prepare("UPDATE api_tokens SET last_used_at = datetime('now') WHERE id = ?"),
  };
  // SQLite datetime('now') text is UTC without a zone marker.
  const staleMinute = (t) => !t || Date.parse(`${t.replace(' ', 'T')}Z`) < Date.now() - 60000;

  app.use((req, res, next) => {
    req.user = null;
    req.device = null;
    req.guild = null;
    req.legacyKey = null;
    req.authError = null;
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
    if (!m) return next();
    const raw = m[1];
    const kind = A.tokenKind(raw);
    if (kind === 'device') {
      const device = q.device.get(A.hashToken(raw));
      if (!device) { req.authError = 'revoked'; return next(); }
      const user = q.user.get(device.user_id);
      if (!user) { req.authError = 'revoked'; return next(); }
      req.device = device;
      req.user = user;
      req.guild = q.membership.get(user.id) || null;
      if (staleMinute(device.last_used_at)) q.touchDevice.run(device.id);
      // Keep the app version current for Settings → Devices and Officer tools.
      const appVersion = ver(req.get('X-App-Version'));
      if (appVersion && appVersion !== device.app_version) {
        q.deviceVersion.run(appVersion, device.id);
        q.userVersion.run(appVersion, user.id);
        device.app_version = appVersion;
        user.app_version = appVersion;
      }
      return next();
    }
    if (kind === 'legacy') {
      if (!LEGACY_PATHS.has(req.path)) { req.authError = 'legacy'; return next(); }
      const key = q.legacy.get(A.legacyTokenHash(raw));
      if (!key) { req.authError = 'legacy'; return next(); }
      const user = q.user.get(key.user_id);
      const guild = q.guild.get(key.guild_id);
      if (!user || !guild) { req.authError = 'legacy'; return next(); }
      req.user = user;
      req.guild = { ...guild, role: key.role };
      req.legacyKey = { id: key.id, prefix: key.prefix };
      if (staleMinute(key.last_used_at)) q.touchLegacy.run(key.id);
      return next();
    }
    // Some other bearer value (for example the PUBLISH_TOKEN): needPublisher checks it.
    next();
  });

  app.get('/healthz', (req, res) => res.json({ ok: true }));

  // ---- Domain routes: every .js file in src/routes, sorted by name. ----
  // cfg.routes (array of base names) limits which files load; tests can use it to isolate a domain.
  const files = fs.readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.js')).sort();
  for (const file of files) {
    const name = file.replace(/\.js$/, '');
    if (Array.isArray(cfg.routes) && !cfg.routes.includes(name)) continue;
    const mod = require(path.join(ROUTES_DIR, file));
    if (typeof mod.register !== 'function') throw new Error(`routes/${file} must export register(app, ctx)`);
    mod.register(app, ctx);
  }
  // Test hook: extra register(app, ctx) functions, mounted after the route files.
  for (const extra of cfg.extraRoutes || []) extra(app, ctx);

  app.use((req, res) => res.status(404).json({ error: 'Not found.' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    let status = 500;
    let message = 'Something went wrong on the server. Try again in a minute.';
    if (err instanceof HttpError) {
      status = err.status;
      message = err.message;
    } else if (err && err.type === 'entity.parse.failed') {
      status = 400; message = 'That request was not valid JSON.';
    } else if (err && err.type === 'entity.too.large') {
      status = 413; message = 'That upload is too large.';
    } else if (err && Number.isInteger(err.status) && err.status >= 400 && err.status < 500) {
      status = err.status; message = 'That request could not be read.';
    }
    if (status >= 500) console.error(`${req.method} ${req.originalUrl} failed:`, err && err.stack ? err.stack : err);
    if (res.headersSent) return req.socket.destroy();
    // Browser-facing pages (Battle.net sign-in window) get an HTML page instead of JSON.
    if (req.path.startsWith('/auth/')) return sendHtmlError(res, status, message);
    res.status(status).json({ error: message });
  });

  return app;
}

// Clears every interval/timeout a domain pushed onto ctx.timers. Accepts the app or the ctx.
function stopTimers(appOrCtx) {
  const ctx = appOrCtx && appOrCtx.locals ? appOrCtx.locals.ctx : appOrCtx;
  if (!ctx || !Array.isArray(ctx.timers)) return;
  for (const t of ctx.timers.splice(0)) { clearInterval(t); clearTimeout(t); }
}

module.exports = { createApp, stopTimers, LEGACY_PATHS };
