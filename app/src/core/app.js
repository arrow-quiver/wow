'use strict';
// Builds the core's Express app: security headers, the per-launch bearer token, JSON bodies, "me" and
// the current guild on every request, then every route file, then the JSON 404 and error handlers.
//
// Only the app's own main process talks to this (src/main/api.js). It listens on 127.0.0.1 only, every
// request must carry `Authorization: Bearer <token>` (a random secret made at each launch, compared in
// constant time), and nothing sends CORS headers, so web pages in a browser can't use it.
const express = require('express');
const crypto = require('crypto');
const { HttpError, ver } = require('./http');
const identity = require('./identity');

// Route files, in order. Each exports register(app, ctx).
const ROUTES = ['core', 'sync', 'community', 'raids', 'economy', 'coach', 'admin', 'calendar', 'share'];

// Constant-time string comparison (hashes both sides first, so different lengths are safe too).
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const x = crypto.createHash('sha256').update(a).digest();
  const y = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(x, y);
}

// extraRoutes: test hook, register(app, ctx) functions mounted after the route files.
function createApp(ctx, { token, afterWrite, extraRoutes = [] } = {}) {
  if (typeof token !== 'string' || token.length < 32) throw new Error('The core needs a long random token.');
  const { db } = ctx;
  const app = express();
  app.disable('x-powered-by');
  app.disable('etag');
  app.locals.ctx = ctx;

  // After anything that can change data (a sync, a settings change), let index.js see whether who I am,
  // my guild or my role changed, so the app can update its navigation.
  if (typeof afterWrite === 'function') {
    app.use((req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') res.on('finish', () => afterWrite());
      next();
    });
  }

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  // Every request needs the launch token. No token, no answer (not even a 404).
  app.use((req, res, next) => {
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
    if (!m || !safeEqual(m[1], token)) return res.status(401).json({ error: 'Not allowed.' });
    next();
  });

  const json = express.json({ limit: '15mb' });
  app.use((req, res, next) => {
    json(req, res, (err) => {
      if (err) return next(err);
      if (req.body === undefined) req.body = {};
      next();
    });
  });

  // Me and the current guild (with my role from in-game ranks) on every request.
  const userVersion = db.prepare('UPDATE users SET app_version = ? WHERE id = ?');
  app.use((req, res, next) => {
    req.user = identity.ensureMe(db);
    req.guild = identity.myMembership(db);
    const appVersion = ver(req.get('X-App-Version'));
    if (appVersion && appVersion !== req.user.app_version) {
      userVersion.run(appVersion, req.user.id);
      req.user.app_version = appVersion;
    }
    next();
  });

  for (const name of ROUTES) {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const mod = require(`./routes/${name}`);
    if (typeof mod.register !== 'function') throw new Error(`routes/${name}.js must export register(app, ctx)`);
    mod.register(app, ctx);
  }
  for (const extra of extraRoutes) extra(app, ctx);

  app.use((req, res) => res.status(404).json({ error: 'Not found.' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    let status = 500;
    let message = 'Something went wrong inside Guild Camp. Try again, and check the log if it keeps happening.';
    let code;
    if (err instanceof HttpError) {
      status = err.status;
      message = err.message;
      code = err.code;
    } else if (err && err.type === 'entity.parse.failed') {
      status = 400; message = 'That request was not valid JSON.';
    } else if (err && err.type === 'entity.too.large') {
      status = 413; message = 'That upload is too large.';
    } else if (err && Number.isInteger(err.status) && err.status >= 400 && err.status < 500) {
      status = err.status; message = 'That request could not be read.';
    }
    if (status >= 500) ctx.log.error(`${req.method} ${req.originalUrl} failed:`, err && err.stack ? err.stack : err);
    if (res.headersSent) return req.socket.destroy();
    res.status(status).json(code ? { error: message, code } : { error: message });
  });

  return app;
}

module.exports = { createApp, safeEqual, ROUTES };
