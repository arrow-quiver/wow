// Core: server info, sign-in (Battle.net and dev), the signed-in member, notification
// choices, and devices. Shapes are documented in docs/api/core.md.
// Battle.net sign-in also reads the player's WoW characters and joins them to the guild when one of
// them matches (services/membership.js).
const A = require('../auth');
const {
  HttpError, str, int, ver, needUser, guildJson, userJson, deviceJson, htmlPage, sendHtml, sendHtmlError,
} = require('../http');
const { readPrefs, mergePrefs } = require('../services/events');
const membership = require('../services/membership');
const { version } = require('../../package.json');

const NONCE_COOKIE = 'gc_auth_nonce';

// Device details sent by the app at sign-in. Throws a 400 when something is malformed.
function cleanDevice(input) {
  const d = input && typeof input === 'object' ? input : { name: input };
  const rawName = d.name == null ? '' : String(d.name);
  if (rawName.length > 200) throw new HttpError(400, 'That device name is too long.');
  // Control characters never belong in a name shown in Settings → Devices.
  const name = str(rawName.replace(/[\u0000-\u001f\u007f]/g, ' '), 60) || 'Guild Camp';
  const platform = d.platform == null || d.platform === '' ? null : String(d.platform);
  if (platform !== null && !/^[a-z0-9_-]{1,20}$/i.test(platform)) throw new HttpError(400, 'That device platform is not valid.');
  const appVersion = d.appVersion == null || d.appVersion === '' ? null : ver(String(d.appVersion));
  if (d.appVersion != null && d.appVersion !== '' && !appVersion) throw new HttpError(400, 'That app version is not valid.');
  return { name, platform: platform && platform.toLowerCase(), appVersion };
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore a malformed cookie */ }
    }
  }
  return out;
}

function register(app, ctx) {
  const { db, cfg } = ctx;
  const secureCookie = cfg.baseUrl.startsWith('https://');
  const q = {
    firstGuild: db.prepare('SELECT name, faction FROM guilds ORDER BY id LIMIT 1'),
    upsertBnet: db.prepare('INSERT INTO users (bnet_id, battletag) VALUES (?,?) ON CONFLICT (bnet_id) DO UPDATE SET battletag = excluded.battletag'),
    upsertDev: db.prepare('INSERT INTO users (bnet_id, battletag) VALUES (?,?) ON CONFLICT (bnet_id) DO NOTHING'),
    userByBnet: db.prepare('SELECT * FROM users WHERE bnet_id = ?'),
    guildOf: db.prepare('SELECT guild_id FROM memberships WHERE user_id = ? ORDER BY joined_at, guild_id LIMIT 1'),
    addDevice: db.prepare(`INSERT INTO devices (user_id, guild_id, token_hash, prefix, name, platform, app_version)
      VALUES (?,?,?,?,?,?,?)`),
    deleteDevice: db.prepare('DELETE FROM devices WHERE id = ? AND user_id = ?'),
    devices: db.prepare('SELECT * FROM devices WHERE user_id = ? ORDER BY COALESCE(last_used_at, created_at) DESC, id DESC'),
    syncKeys: db.prepare('SELECT id, prefix, created_at, last_used_at FROM api_tokens WHERE user_id = ? ORDER BY id DESC'),
    deleteSyncKey: db.prepare('DELETE FROM api_tokens WHERE id = ? AND user_id = ?'),
    setPrefs: db.prepare('UPDATE users SET notify_prefs = ? WHERE id = ?'),
    setUserVersion: db.prepare('UPDATE users SET app_version = ? WHERE id = ?'),
  };

  // A new device token for this user. Returns the raw token (shown once).
  function createDevice(userId, device) {
    const t = A.newDeviceToken();
    const g = q.guildOf.get(userId);
    q.addDevice.run(userId, g ? g.guild_id : null, t.hash, t.prefix, device.name, device.platform, device.appVersion);
    if (device.appVersion) q.setUserVersion.run(device.appVersion, userId);
    return t.raw;
  }

  const setCookie = (res, value, maxAgeSec) => {
    res.append('Set-Cookie', `${NONCE_COOKIE}=${encodeURIComponent(value)}; Path=/auth; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secureCookie ? '; Secure' : ''}`);
  };

  // ---- Server info (public): what the app shows before sign-in ----
  app.get('/api/meta', (req, res) => {
    const g = q.firstGuild.get();
    let releases = { app: null, addon: null };
    try {
      const l = ctx.latest() || {};
      releases = { app: l.app || null, addon: l.addon || null };
    } catch (e) {
      ctx.log.warn('Could not read the latest releases:', e.message);
    }
    res.json({
      server: 'guild-camp',
      version,
      devLogin: Boolean(cfg.devLogin),
      bnet: A.bnetEnabled(cfg),
      guild: g ? { name: g.name, faction: g.faction } : null,
      releases,
    });
  });

  // ---- Battle.net sign-in (opened by the app in a sign-in window) ----
  app.get('/auth/bnet', (req, res) => {
    if (!A.bnetEnabled(cfg)) return sendHtmlError(res, 503, 'Battle.net sign-in is not set up on this server yet.');
    let device;
    try {
      device = cleanDevice({ name: req.query.device, platform: req.query.platform, appVersion: req.query.appVersion });
    } catch (e) {
      return sendHtmlError(res, 400, `${e.message} Start again from Guild Camp.`);
    }
    const { state, nonce } = A.signState(cfg, device);
    // The nonce cookie ties the callback to the window that started sign-in.
    setCookie(res, nonce, Math.floor(A.STATE_TTL_MS / 1000));
    res.setHeader('Cache-Control', 'no-store');
    res.redirect(302, A.bnetAuthorizeUrl(cfg, state));
  });

  app.get('/auth/bnet/callback', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!A.bnetEnabled(cfg)) return sendHtmlError(res, 503, 'Battle.net sign-in is not set up on this server yet.');
    if (req.query.error) {
      setCookie(res, '', 0);
      return sendHtmlError(res, 400, 'Sign-in was cancelled.');
    }
    const payload = A.readState(cfg, typeof req.query.state === 'string' ? req.query.state : '');
    const nonce = parseCookies(req.headers.cookie)[NONCE_COOKIE];
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    if (!code || code.length > 500 || !payload || !A.safeEqual(nonce, payload.nonce)) {
      return sendHtmlError(res, 400, 'Sign-in expired or was started from a different address.');
    }
    setCookie(res, '', 0);
    let who;
    try {
      who = await A.bnetExchange(cfg, code, cfg.fetch);
    } catch (e) {
      console.error('Battle.net sign-in failed:', e.message);
      return sendHtmlError(res, 502, 'Battle.net sign-in failed. Try again in a minute.');
    }
    let device;
    try { device = cleanDevice(payload.device); } catch { device = { name: 'Guild Camp', platform: null, appVersion: null }; }
    const raw = db.transaction(() => {
      q.upsertBnet.run(who.bnetId, who.battletag);
      return createDevice(q.userByBnet.get(who.bnetId).id, device);
    })();
    // Read the player's WoW characters (about 6 s at most) and join them to the guild when one of
    // their characters is in it. Sign-in never fails because of this step.
    try {
      const user = q.userByBnet.get(who.bnetId);
      await membership.refreshBnetProfile(ctx, user.id, who.accessToken);
      // A join is recorded by tryAutoJoin itself (activity, audit, officer notice).
      membership.tryAutoJoin(ctx, user, { reported: [] });
    } catch (e) {
      ctx.log.warn('Battle.net characters / auto join after sign-in failed:', e.message);
    }
    // The token travels in the fragment: browsers never send it to a server or in a Referer.
    res.redirect(302, `/auth/app/done#token=${encodeURIComponent(raw)}`);
  });

  // The sign-in window lands here. The app reads the token from the address and closes the window.
  app.get('/auth/app/done', (req, res) => {
    sendHtml(res, 200, htmlPage({
      title: 'Signed in',
      heading: 'You are signed in',
      body: `<p>You can close this window and go back to Guild Camp.</p>
        <p class="muted">Guild Camp finishes signing in on its own. If it doesn't, start again from the app.</p>`,
    }));
  });

  // ---- Dev sign-in (DEV_LOGIN=1 only) ----
  app.post('/api/auth/dev', (req, res) => {
    if (!cfg.devLogin) throw new HttpError(404, 'Not found.');
    const bt = str(req.body.battletag, 40);
    if (!bt || !/^[^#]+#\d+$/.test(bt)) throw new HttpError(400, 'Use a BattleTag like Name#1234.');
    const device = cleanDevice(req.body.device);
    const bnetId = `dev:${bt}`;
    const raw = db.transaction(() => {
      q.upsertDev.run(bnetId, bt);
      return createDevice(q.userByBnet.get(bnetId).id, device);
    })();
    res.json({ token: raw, user: userJson(q.userByBnet.get(bnetId)) });
  });

  app.post('/api/auth/signout', needUser, (req, res) => {
    if (req.device) q.deleteDevice.run(req.device.id, req.user.id);
    res.json({ ok: true });
  });

  // ---- The signed-in member ----
  app.get('/api/me', needUser, (req, res) => {
    const role = req.guild ? req.guild.role : null;
    const guild = guildJson(req.guild, { role, baseUrl: cfg.baseUrl });
    if (guild) Object.assign(guild, { auto_join: req.guild.auto_join || 'roster', officer_rank_max: req.guild.officer_rank_max ?? null });
    res.json({
      user: userJson(req.user),
      guild,
      role,
      device: deviceJson(req.device, req.device && req.device.id),
      notifyPrefs: readPrefs(req.user.notify_prefs),
      // What Battle.net sign-in read: how many WoW characters, when, and a plain note.
      bnet: membership.bnetSummary(db, req.user.id),
    });
  });

  // Body: any of { cta, raids, notices, requests, bank, coach, drives } as booleans.
  app.put('/api/me/notifications', needUser, (req, res) => {
    const patch = req.body && typeof req.body.notifyPrefs === 'object' ? req.body.notifyPrefs : req.body;
    const prefs = mergePrefs(req.user.notify_prefs, patch);
    q.setPrefs.run(JSON.stringify(prefs), req.user.id);
    res.json({ notifyPrefs: prefs });
  });

  // ---- Devices (Settings → Devices) ----
  app.get('/api/devices', needUser, (req, res) => {
    const current = req.device ? req.device.id : null;
    res.json({
      devices: q.devices.all(req.user.id).map((d) => deviceJson(d, current)),
      // Old companion sync keys still accepted for syncing during the switch to the app.
      syncKeys: q.syncKeys.all(req.user.id),
    });
  });

  app.delete('/api/devices/:id', needUser, (req, res) => {
    const id = int(req.params.id, 1);
    const r = id ? q.deleteDevice.run(id, req.user.id) : { changes: 0 };
    if (!r.changes) throw new HttpError(404, 'Device not found.');
    ctx.audit(req, 'device signed out', `#${id}`);
    res.json({ ok: true, current: Boolean(req.device && req.device.id === id) });
  });

  app.delete('/api/sync-keys/:id', needUser, (req, res) => {
    const id = int(req.params.id, 1);
    const r = id ? q.deleteSyncKey.run(id, req.user.id) : { changes: 0 };
    if (!r.changes) throw new HttpError(404, 'Sync key not found.');
    ctx.audit(req, 'sync key revoked');
    res.json({ ok: true });
  });
}

module.exports = { register, cleanDevice };
