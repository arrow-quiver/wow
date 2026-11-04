const express = require('express');
const path = require('path');
const crypto = require('crypto');
const dbm = require('./db');
const A = require('./auth');
const { applyPayload, buildInbox, toLua } = require('./sync');
const { layout } = require('./views/layout');
const P = require('./views/pages');
const { rateLimit } = require('./ratelimit');
const backup = require('./backup');
const wowhead = require('./views/wowhead');
const { createPush } = require('./push');
const blizzard = require('./blizzard');
const gamedata = require('./gamedata');
const { calendarToken } = require('./calendar');
const fs = require('fs');

function config(env = process.env) {
  return {
    port: Number(env.PORT || 3000),
    baseUrl: (env.BASE_URL || 'http://localhost:3000').replace(/\/$/, ''),
    sessionSecret: env.SESSION_SECRET || (env.NODE_ENV === 'production' ? null : 'dev-secret-change-me'),
    dbFile: env.DB_FILE || path.join(__dirname, '..', 'data', 'wow.db'),
    bnetClientId: env.BNET_CLIENT_ID || '',
    bnetClientSecret: env.BNET_CLIENT_SECRET || '',
    devLogin: env.DEV_LOGIN === '1',
    // Used only when a browser doesn't send its own offset. -120 = South Africa (UTC+2).
    defaultTzOffset: Number(env.DEFAULT_TZ_OFFSET ?? -120),
    timers: env.NODE_ENV !== 'test',
    // Discord app (slash commands). From discord.com/developers/applications.
    discordAppId: env.DISCORD_APP_ID || '',
    discordPublicKey: env.DISCORD_PUBLIC_KEY || '',
    discordBotToken: env.DISCORD_BOT_TOKEN || '',
    bnetRegion: (env.BNET_REGION || 'eu').toLowerCase(),
  };
}

function createApp(cfg, db) {
  if (!cfg.sessionSecret) throw new Error('SESSION_SECRET must be set in production');
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  const secureCookie = cfg.baseUrl.startsWith('https://');
  const bnetEnabled = Boolean(cfg.bnetClientId && cfg.bnetClientSecret);

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', [
      // Wowhead tooltips load their script, styles, icons and item data from these hosts.
      "default-src 'self'", "script-src 'self' https://wow.zamimg.com https://nether.wowhead.com",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://wow.zamimg.com",
      "font-src https://fonts.gstatic.com https://wow.zamimg.com", "img-src 'self' data: https://wow.zamimg.com https://*.wowhead.com",
      "connect-src 'self' https://nether.wowhead.com https://*.wowhead.com", "frame-src https://*.wowhead.com",
      "worker-src 'self'", "manifest-src 'self'", "form-action 'self'", "frame-ancestors 'none'", "base-uri 'self'",
    ].join('; '));
    if (secureCookie) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
    next();
  });
  app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));
  // Player downloads (built into the image by the Dockerfile's "kit" stage). Public on purpose.
  const DOWNLOADS = path.join(__dirname, '..', 'downloads');
  // The companion zip gets a config.json with this site's address (and, from Settings, a sync key),
  // so nobody has to edit it by hand. The exe is copied through without recompressing.
  const zipkit = require('./zipkit');
  let exeCache = null;
  const companionExe = () => {
    const src = path.join(DOWNLOADS, 'wow-companion.zip');
    const m = fs.statSync(src).mtimeMs;
    if (!exeCache || exeCache.m !== m) exeCache = { m, entry: zipkit.readEntries(fs.readFileSync(src)).find((e) => /\.exe$/i.test(e.name)) };
    return exeCache.entry;
  };
  const README = (key) => [
    'wow guild companion', '',
    '1. Keep wow-companion.exe and config.json together in any folder.',
    key ? '2. Your sync key is already in config.json. Keep it private.' : '2. Sign in on the guild site, go to Settings, choose "Create sync key" and paste it into config.json as syncKey.',
    '3. Run wow-companion.exe and leave it open while you play (or run it once with --install-startup).',
    '4. Install the addon (WowGuild) into your game\'s Interface\\AddOns folder.', '',
    `Guild site: ${cfg.baseUrl}`,
  ].join('\r\n');
  const companionZip = (key) => zipkit.writeZip([
    companionExe(),
    { name: 'config.json', data: JSON.stringify({ siteUrl: cfg.baseUrl, syncKey: key || 'paste-your-sync-key-here', wowFolder: '' }, null, 2) },
    { name: 'READ ME.txt', data: README(key) },
  ]);
  app.get('/downloads/wow-companion.zip', (req, res, next) => {
    try {
      const buf = companionZip(null);
      res.setHeader('Content-Disposition', 'attachment; filename="wow-companion.zip"');
      res.type('application/zip').send(buf);
    } catch (e) { next(); }
  });
  app.use('/downloads', express.static(DOWNLOADS, {
    maxAge: '10m',
    setHeaders: (res, file) => { if (/\.zip$/.test(file)) res.setHeader('Content-Disposition', `attachment; filename="${path.basename(file)}"`); },
  }));
  // Rate limits: generous for people, tight enough to stop scripts hammering the server.
  app.use('/discord', rateLimit({ max: 120 }));
  app.use('/api', rateLimit({ max: 40, key: (req) => (req.headers.authorization || req.ip).slice(0, 80), message: 'Too many uploads. The companion will retry shortly.' }));
  app.use(['/auth', '/login'], rateLimit({ max: 20 }));
  { const g = db.prepare('SELECT wowhead_game FROM guilds ORDER BY id LIMIT 1').get(); if (g) wowhead.setGame(g.wowhead_game); }
  const phase3 = require('./routes/phase3');
  // Discord calls this with its own signature; it must skip the session and CSRF checks below.
  phase3.mountDiscord(app, { db, cfg, discord: (...a) => discord(...a), notify: (...a) => notify(...a) });
  app.use('/api', express.json({ limit: '15mb' }));
  app.use('/push', express.json({ limit: '10kb' }));
  // Web push to phones/desktops. cfg.pushSend lets tests capture notifications.
  const push = createPush(db, cfg, cfg.pushSend ? { send: cfg.pushSend } : {});
  app.locals.push = push;
  const notify = (...a) => push.notify(...a).catch((e) => console.warn('Notify failed:', e.message));
  app.use(express.urlencoded({ extended: false, limit: '50kb' }));

  // ---- helpers ----
  const q = {
    user: db.prepare('SELECT * FROM users WHERE id = ?'),
    membership: db.prepare(`SELECT g.*, m.role FROM memberships m JOIN guilds g ON g.id = m.guild_id WHERE m.user_id = ? ORDER BY m.joined_at LIMIT 1`),
    activity: db.prepare('INSERT INTO activity (guild_id, kind, text) VALUES (?,?,?)'),
    audit: db.prepare('INSERT INTO audit_log (guild_id, user_id, action, detail) VALUES (?,?,?,?)'),
  };
  // Record officer and account actions so the guild can see who changed what.
  const audit = (req, action, detail = '') => {
    if (req.guild) q.audit.run(req.guild.id, req.user ? req.user.id : null, action, String(detail).slice(0, 300));
  };
  const readDownload = (f) => { try { return fs.readFileSync(path.join(DOWNLOADS, f), 'utf8').trim(); } catch { return null; } };
  const setCookie = (res, name, value, maxAgeSec) => {
    res.append('Set-Cookie', `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secureCookie ? '; Secure' : ''}`);
  };
  const login = (res, userId) => setCookie(res, 'wow_s', A.makeSession(userId, cfg.sessionSecret), 30 * 86400);

  async function discord(guild, content) {
    if (!guild.discord_webhook) return;
    try {
      await fetch(guild.discord_webhook, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: content.slice(0, 1900), allowed_mentions: { parse: [] } }),
        signal: AbortSignal.timeout(5000),
      });
    } catch (e) { console.warn('Discord webhook failed:', e.message); }
  }

  // Session middleware
  app.use((req, res, next) => {
    const s = A.readSession(A.parseCookies(req.headers.cookie).wow_s, cfg.sessionSecret);
    req.user = s ? q.user.get(s.userId) : null;
    req.csrf = s ? s.csrf : '';
    req.guild = req.user ? q.membership.get(req.user.id) : null;
    if (req.guild && req.guild.wowhead_game) wowhead.setGame(req.guild.wowhead_game);
    res.page = (opts) => res.send(layout({ user: req.user, guild: req.guild, csrf: req.csrf, flash: req.query.m, ...opts }));
    next();
  });
  // CSRF on all browser POSTs (API uses bearer tokens instead)
  app.use((req, res, next) => {
    if (req.method !== 'POST' || req.path.startsWith('/api/') || req.path === '/login/dev') return next();
    if (!req.user || !req.body || req.body._csrf !== req.csrf) return res.status(403).send('Form expired. Go back, reload the page and try again.');
    next();
  });
  const needGuild = (req, res, next) => (req.guild ? next() : res.redirect('/'));
  const needOfficer = (req, res, next) => (req.guild && ['owner', 'officer'].includes(req.guild.role) ? next() : res.status(403).send('Officers only.'));
  const back = (res, url, msg) => res.redirect(msg ? `${url}${url.includes('?') ? '&' : '?'}m=${encodeURIComponent(msg)}` : url);

  // ---- auth ----
  app.get('/auth/bnet', (req, res) => {
    if (!bnetEnabled) return res.redirect('/');
    const state = crypto.randomBytes(16).toString('base64url');
    setCookie(res, 'wow_state', A.sign(state, cfg.sessionSecret), 600);
    if (req.query.next && /^\/join\/[\w-]+$/.test(req.query.next)) setCookie(res, 'wow_next', req.query.next, 600);
    res.redirect(A.bnetAuthorizeUrl(cfg, state));
  });
  app.get('/auth/bnet/callback', async (req, res) => {
    const c = A.parseCookies(req.headers.cookie);
    if (!req.query.code || A.unsign(c.wow_state, cfg.sessionSecret) !== req.query.state) return res.status(400).send('Sign-in expired. Start again from the home page.');
    try {
      const { bnetId, battletag } = await A.bnetExchange(cfg, String(req.query.code));
      db.prepare('INSERT INTO users (bnet_id, battletag) VALUES (?,?) ON CONFLICT (bnet_id) DO UPDATE SET battletag = excluded.battletag').run(bnetId, battletag);
      const u = db.prepare('SELECT id FROM users WHERE bnet_id = ?').get(bnetId);
      login(res, u.id);
      setCookie(res, 'wow_state', '', 0);
      const next = c.wow_next && /^\/join\/[\w-]+$/.test(c.wow_next) ? c.wow_next : '/';
      setCookie(res, 'wow_next', '', 0);
      res.redirect(next);
    } catch (e) {
      console.error(e);
      res.status(502).send('Battle.net sign-in failed. Try again in a minute.');
    }
  });
  app.post('/login/dev', (req, res) => {
    if (!cfg.devLogin) return res.status(404).end();
    const bt = String(req.body.battletag || '').slice(0, 40);
    if (!/^.+#\d+$/.test(bt)) return back(res, '/', 'Use a BattleTag like Name#1234');
    db.prepare('INSERT INTO users (bnet_id, battletag) VALUES (?,?) ON CONFLICT (bnet_id) DO NOTHING').run(`dev:${bt}`, bt);
    login(res, db.prepare('SELECT id FROM users WHERE bnet_id = ?').get(`dev:${bt}`).id);
    res.redirect('/');
  });
  app.post('/logout', (req, res) => { setCookie(res, 'wow_s', '', 0); res.redirect('/'); });

  // ---- guild setup / join ----
  app.post('/guild/create', (req, res) => {
    if (req.guild) return res.redirect('/');
    // Single-guild mode for now: once a guild exists, others join by invite.
    if (db.prepare('SELECT COUNT(*) n FROM guilds').get().n > 0) return back(res, '/', 'This site already has a guild. Ask an officer for the invite link.');
    const name = String(req.body.name || 'wow').trim().slice(0, 40) || 'wow';
    const faction = req.body.faction === 'Alliance' ? 'Alliance' : 'Horde';
    const g = db.prepare('INSERT INTO guilds (name, faction, invite_code) VALUES (?,?,?)').run(name, faction, A.inviteCode());
    db.prepare("INSERT INTO memberships (user_id, guild_id, role) VALUES (?,?, 'owner')").run(req.user.id, g.lastInsertRowid);
    q.activity.run(g.lastInsertRowid, 'guild', `${req.user.battletag.split('#')[0]} lit the campfire`);
    res.redirect('/settings');
  });
  app.get('/join/:code', (req, res) => {
    const invite = db.prepare('SELECT * FROM guilds WHERE invite_code = ?').get(req.params.code);
    if (!invite) return res.status(404).page({ title: 'Invite', body: '<h1>That invite link doesn’t work</h1><p>Ask an officer for a fresh one.</p>' });
    if (!req.user) return res.page({ title: 'Join', body: P.landing({ devLogin: cfg.devLogin, bnetEnabled }).replace('/auth/bnet"', `/auth/bnet?next=/join/${encodeURIComponent(req.params.code)}"`) });
    if (req.guild) return res.redirect('/');
    res.page({ title: 'Join', body: P.setup({ csrf: req.csrf, invite }) });
  });
  app.post('/join/:code', (req, res) => {
    const g = db.prepare('SELECT * FROM guilds WHERE invite_code = ?').get(req.params.code);
    if (!g) return res.status(404).send('Invite not found');
    db.prepare("INSERT OR IGNORE INTO memberships (user_id, guild_id, role) VALUES (?,?, 'member')").run(req.user.id, g.id);
    q.activity.run(g.id, 'member', `${req.user.battletag.split('#')[0]} joined the camp`);
    res.redirect('/settings');
  });

  // ---- downloads page (public, so guildies can grab the tools before signing in) ----
  app.get('/get', (req, res) => {
    const fs = require('fs');
    const read = (f) => { try { return fs.readFileSync(path.join(DOWNLOADS, f), 'utf8').trim(); } catch { return null; } };
    const size = (f) => { try { const b = fs.statSync(path.join(DOWNLOADS, f)).size; return b < 1048576 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1048576).toFixed(1)} MB`; } catch { return null; } };
    res.page({ title: 'Downloads', active: 'settings', body: P.downloads({
      addon: size('WowGuild.zip') != null ? { version: read('addon-version.txt'), mb: size('WowGuild.zip') } : null,
      companion: size('wow-companion.zip') != null ? { version: read('companion-version.txt'), mb: size('wow-companion.zip') } : null,
      baseUrl: cfg.baseUrl, signedIn: Boolean(req.guild), csrf: req.csrf,
    }) });
  });

  // First steps for each member, shown on Camp until they're all done.
  function onboardingFor(req) {
    const gid = req.guild.id; const uid = req.user.id;
    const synced = db.prepare('SELECT 1 FROM sync_log WHERE guild_id = ? AND user_id = ? LIMIT 1').get(gid, uid);
    const chars = db.prepare('SELECT COUNT(*) n, MAX(is_main) main FROM characters WHERE guild_id = ? AND user_id = ?').get(gid, uid);
    const profs = db.prepare('SELECT 1 FROM professions p JOIN characters c ON c.id = p.character_id WHERE c.guild_id = ? AND c.user_id = ? LIMIT 1').get(gid, uid);
    const nextRaid = db.prepare("SELECT id, title FROM raids WHERE guild_id = ? AND status IN ('open','locked') AND starts_at > ? ORDER BY starts_at LIMIT 1").get(gid, new Date().toISOString());
    const myChar = db.prepare('SELECT name FROM characters WHERE guild_id = ? AND user_id = ? ORDER BY level DESC LIMIT 1').get(gid, uid);
    const steps = [
      { done: Boolean(synced), label: 'Install the addon and companion, then log in once', href: '/get' },
      { done: Boolean(profs), label: 'Open each profession window in game, then /reload', href: '/crafters' },
      { done: Boolean(chars.main), label: 'Pick your main character', href: myChar ? `/characters/${encodeURIComponent(myChar.name)}` : '/roster' },
    ];
    if (cfg.discordPublicKey) steps.push({ done: Boolean(req.user.discord_id), label: 'Link your Discord', href: '/settings' });
    if (nextRaid) steps.push({ done: Boolean(db.prepare('SELECT 1 FROM signups WHERE raid_id = ? AND user_id = ?').get(nextRaid.id, uid)), label: `Sign up for ${nextRaid.title}`, href: `/raids/${nextRaid.id}` });
    return steps;
  }

  // ---- camp ----
  app.get('/', (req, res) => {
    if (!req.user) return res.page({ title: '', body: P.landing({ devLogin: cfg.devLogin, bnetEnabled }) });
    if (!req.guild) return res.page({ title: 'Set up', body: P.setup({ csrf: req.csrf }) });
    const gid = req.guild.id;
    res.page({
      title: 'Camp', active: 'home',
      body: P.home({
        csrf: req.csrf,
        scannedAt: req.guild.roster_scanned_at,
        online: db.prepare('SELECT * FROM characters WHERE guild_id = ? AND online = 1 ORDER BY level DESC, name').all(gid),
        ctas: db.prepare(`SELECT c.*, u.battletag FROM ctas c JOIN users u ON u.id = c.user_id WHERE c.guild_id = ? AND c.created_at > datetime('now','-1 day') ORDER BY c.id DESC LIMIT 8`).all(gid),
        announcements: db.prepare('SELECT a.*, u.battletag FROM announcements a JOIN users u ON u.id = a.user_id WHERE a.guild_id = ? ORDER BY a.id DESC LIMIT 5').all(gid),
        activity: db.prepare('SELECT * FROM activity WHERE guild_id = ? ORDER BY id DESC LIMIT 12').all(gid),
        isOfficer: ['owner', 'officer'].includes(req.guild.role),
        mySync: (db.prepare('SELECT MAX(received_at) t FROM sync_log WHERE guild_id = ? AND user_id = ?').get(gid, req.user.id) || {}).t,
        onboarding: onboardingFor(req),
        realm: (() => { try { return req.guild.realm_status ? JSON.parse(req.guild.realm_status) : null; } catch { return null; } })(),
      }),
    });
  });

  app.post('/cta', needGuild, async (req, res) => {
    const zone = String(req.body.zone || '').trim().slice(0, 60);
    if (!zone) return back(res, '/', 'Say where the fight is.');
    const needed = Math.min(40, Math.max(1, Number(req.body.needed) || 0)) || null;
    const message = String(req.body.message || '').slice(0, 200);
    const main = db.prepare('SELECT name FROM characters WHERE guild_id = ? AND user_id = ? ORDER BY is_main DESC, level DESC LIMIT 1').get(req.guild.id, req.user.id);
    db.prepare("INSERT INTO ctas (guild_id, user_id, character, zone, message, needed, source) VALUES (?,?,?,?,?,?, 'web')")
      .run(req.guild.id, req.user.id, main ? main.name : null, zone, message, needed);
    await discord(req.guild, `⚔️ **Call to arms: ${zone}**${needed ? ` (need ${needed})` : ''}\n${message}\n— ${main ? main.name : req.user.battletag.split('#')[0]}`);
    notify(req.guild.id, 'cta', { title: `⚔️ Call to arms: ${zone}`, body: `${needed ? `Need ${needed}. ` : ''}${message} (${main ? main.name : req.user.battletag.split('#')[0]})`, url: '/' }, { exceptUserId: req.user.id });
    back(res, '/', 'Horn sounded.');
  });

  app.post('/announcements', needOfficer, async (req, res) => {
    const body = String(req.body.body || '').trim().slice(0, 500);
    if (!body) return back(res, '/');
    db.prepare('INSERT INTO announcements (guild_id, user_id, body) VALUES (?,?,?)').run(req.guild.id, req.user.id, body);
    audit(req, 'notice posted', body.slice(0, 80));
    await discord(req.guild, `📜 **Notice**\n${body}`);
    notify(req.guild.id, 'notices', { title: '📜 Guild notice', body, url: '/' }, { exceptUserId: req.user.id });
    back(res, '/', 'Notice posted.');
  });

  // ---- roster ----
  app.get('/roster', needGuild, (req, res) => {
    const chars = db.prepare(`SELECT c.*, u.battletag FROM characters c LEFT JOIN users u ON u.id = c.user_id
      WHERE c.guild_id = ? ORDER BY c.online DESC, c.level DESC, c.name`).all(req.guild.id);
    res.page({ title: 'Roster', active: 'roster', body: P.roster({ chars, scannedAt: req.guild.roster_scanned_at }) });
  });
  app.get('/characters/:name', needGuild, (req, res) => {
    const c = db.prepare('SELECT * FROM characters WHERE guild_id = ? AND name = ?').get(req.guild.id, req.params.name);
    if (!c) return res.status(404).page({ title: 'Not found', body: P.notFound() });
    res.page({
      title: c.name, active: 'roster',
      body: P.character({
        c, csrf: req.csrf, isOwner: c.user_id === req.user.id,
        profs: db.prepare('SELECT * FROM professions WHERE character_id = ? ORDER BY skill DESC').all(c.id),
        recipes: db.prepare('SELECT profession, name, recipe_id FROM recipes WHERE character_id = ? ORDER BY profession, name').all(c.id),
        alts: c.user_id ? db.prepare('SELECT * FROM characters WHERE guild_id = ? AND user_id = ? AND id != ? ORDER BY level DESC').all(req.guild.id, c.user_id, c.id) : [],
      }),
    });
  });
  app.post('/characters/:name/main', needGuild, (req, res) => {
    const c = db.prepare('SELECT * FROM characters WHERE guild_id = ? AND name = ? AND user_id = ?').get(req.guild.id, req.params.name, req.user.id);
    if (!c) return res.status(404).send('Not your character');
    db.transaction(() => {
      db.prepare('UPDATE characters SET is_main = 0 WHERE guild_id = ? AND user_id = ?').run(req.guild.id, req.user.id);
      db.prepare('UPDATE characters SET is_main = 1 WHERE id = ?').run(c.id);
    })();
    back(res, `/characters/${encodeURIComponent(c.name)}`, `${c.name} is now your main.`);
  });

  // ---- crafters ----
  app.get('/crafters', needGuild, (req, res) => {
    const qstr = String(req.query.q || '').trim().slice(0, 60);
    let results = [];
    let profSummary = [];
    if (qstr) {
      const rows = db.prepare(`SELECT r.name AS recipe, r.recipe_id, c.name, c.class, c.online FROM recipes r JOIN characters c ON c.id = r.character_id
        WHERE c.guild_id = ? AND r.name LIKE ? ESCAPE '\\' ORDER BY r.name, c.online DESC, c.name LIMIT 300`)
        .all(req.guild.id, `%${qstr.replace(/[\\%_]/g, (m) => '\\' + m)}%`);
      const map = new Map();
      for (const r of rows) { if (!map.has(r.recipe)) map.set(r.recipe, []); map.get(r.recipe).push(r); }
      results = [...map].map(([recipe, crafters]) => ({ recipe, recipeId: (crafters.find((c) => c.recipe_id) || {}).recipe_id, crafters }));
    } else {
      const rows = db.prepare(`SELECT p.name AS prof, p.skill, c.name, c.class FROM professions p JOIN characters c ON c.id = p.character_id
        WHERE c.guild_id = ? ORDER BY p.name, p.skill DESC`).all(req.guild.id);
      const map = new Map();
      for (const r of rows) { if (!map.has(r.prof)) map.set(r.prof, []); map.get(r.prof).push(r); }
      profSummary = [...map].map(([name, chars]) => ({ name, chars }));
    }
    // Your shopping list from the addon, with where each mat is.
    const shopRow = db.prepare('SELECT items, updated_at FROM shopping_lists WHERE user_id = ?').get(req.user.id);
    let shopping = null;
    if (shopRow) {
      const items = JSON.parse(shopRow.items);
      const need = new Map();
      for (const e of items) for (const g of e.reagents) {
        const cur = need.get(g.id) || { id: g.id, name: g.name, need: 0 };
        cur.need += g.qty * e.qty; need.set(g.id, cur);
      }
      const mine = db.prepare(`SELECT c.name, SUM(i.count) n FROM inventory i JOIN characters c ON c.id = i.character_id
        WHERE c.guild_id = ? AND c.user_id = ? AND i.item_id = ? GROUP BY c.name`);
      const bank = db.prepare(`SELECT COALESCE((SELECT SUM(count) FROM guild_bank WHERE guild_id = ? AND item_id = ?), 0) AS n`);
      const pricesFor = require('./economy').latestPrices(db, req.guild.id, [...need.keys()]);
      shopping = {
        items, updatedAt: shopRow.updated_at,
        mats: [...need.values()].map((m) => ({ ...m, chars: mine.all(req.guild.id, req.user.id, m.id), guildBank: bank.get(req.guild.id, m.id).n,
          price: pricesFor[m.id] ? pricesFor[m.id].price : null })).sort((a, b) => a.name.localeCompare(b.name)),
      };
      if (!items.length) shopping = null;
    }
    res.page({ title: 'Crafters', active: 'crafters', body: P.crafters({ q: qstr, results, profSummary, shopping }) });
  });

  // ---- crafting requests ----
  app.get('/requests', needGuild, (req, res) => {
    const rows = db.prepare(`SELECT cr.*, u.battletag AS requester, cu.battletag AS crafter,
        (SELECT group_concat(DISTINCT c.name) FROM recipes r JOIN characters c ON c.id = r.character_id
          WHERE c.guild_id = cr.guild_id AND lower(r.name) = lower(cr.item)) AS crafters
      FROM craft_requests cr JOIN users u ON u.id = cr.requester_id LEFT JOIN users cu ON cu.id = cr.crafter_id
      WHERE cr.guild_id = ? AND (cr.status IN ('open','claimed') OR cr.updated_at > datetime('now','-7 days')) AND cr.status != 'cancelled'
      ORDER BY cr.id DESC`).all(req.guild.id);
    res.page({ title: 'Crafting requests', active: 'requests', body: P.requests({ csrf: req.csrf, rows, userId: req.user.id, prefill: String(req.query.item || '').slice(0, 100) }) });
  });
  app.post('/requests', needGuild, async (req, res) => {
    const item = String(req.body.item || '').trim().slice(0, 100);
    if (!item) return back(res, '/requests', 'Name the item you need.');
    const notes = String(req.body.notes || '').trim().slice(0, 200);
    db.prepare('INSERT INTO craft_requests (guild_id, requester_id, item, notes) VALUES (?,?,?,?)').run(req.guild.id, req.user.id, item, notes);
    const who = req.user.battletag.split('#')[0];
    q.activity.run(req.guild.id, 'craft', `${who} asked for ${item}`);
    await discord(req.guild, `🔨 **Crafting request:** ${item}${notes ? ` (${notes})` : ''}, for ${who}`);
    const crafters = db.prepare(`SELECT DISTINCT c.user_id FROM recipes r JOIN characters c ON c.id = r.character_id
      WHERE c.guild_id = ? AND c.user_id IS NOT NULL AND lower(r.name) = lower(?)`).all(req.guild.id, item).map((r) => r.user_id);
    if (crafters.length) notify(req.guild.id, 'requests', { title: `🔨 ${who} needs ${item}`, body: `You can craft it.${notes ? ` ${notes}` : ''}`, url: '/requests' }, { userIds: crafters, exceptUserId: req.user.id });
    back(res, '/requests', 'Request posted.');
  });
  app.post('/requests/:id/:verb(claim|done|cancel)', needGuild, (req, res) => {
    const r = db.prepare('SELECT * FROM craft_requests WHERE id = ? AND guild_id = ?').get(req.params.id, req.guild.id);
    if (!r) return res.status(404).send('Request not found');
    const me = req.user.id;
    const who = req.user.battletag.split('#')[0];
    const upd = (status, crafter) => db.prepare("UPDATE craft_requests SET status = ?, crafter_id = ?, updated_at = datetime('now') WHERE id = ?").run(status, crafter, r.id);
    if (req.params.verb === 'claim' && r.status === 'open' && r.requester_id !== me) { upd('claimed', me); q.activity.run(req.guild.id, 'craft', `${who} is making ${r.item}`); }
    else if (req.params.verb === 'done' && r.status === 'claimed' && (r.crafter_id === me || r.requester_id === me)) { upd('done', r.crafter_id); q.activity.run(req.guild.id, 'craft', `${r.item} delivered`); }
    else if (req.params.verb === 'cancel' && r.requester_id === me && r.status !== 'done') upd('cancelled', r.crafter_id);
    else return back(res, '/requests', 'That request has already moved on.');
    back(res, '/requests');
  });

  // ---- leveling partners ----
  app.get('/buddies', needGuild, (req, res) => {
    const posts = db.prepare(`SELECT b.*, c.class, COALESCE(c.level, b.level) AS level FROM buddy_posts b
      LEFT JOIN characters c ON c.guild_id = b.guild_id AND c.name = b.character
      WHERE b.guild_id = ? AND b.active = 1 AND b.created_at > datetime('now','-3 days') ORDER BY b.id DESC`).all(req.guild.id);
    const myChars = db.prepare('SELECT name, level FROM characters WHERE guild_id = ? AND user_id = ? ORDER BY is_main DESC, level DESC').all(req.guild.id, req.user.id);
    res.page({ title: 'Leveling partners', active: 'buddies', body: P.buddies({ csrf: req.csrf, posts, myChars, userId: req.user.id }) });
  });
  app.post('/buddies', needGuild, (req, res) => {
    const character = String(req.body.character || '').trim().slice(0, 40);
    if (!character) return back(res, '/buddies');
    const c = db.prepare('SELECT level FROM characters WHERE guild_id = ? AND name = ?').get(req.guild.id, character);
    db.prepare('UPDATE buddy_posts SET active = 0 WHERE guild_id = ? AND user_id = ? AND character = ?').run(req.guild.id, req.user.id, character);
    db.prepare('INSERT INTO buddy_posts (guild_id, user_id, character, level, zone, when_text, note) VALUES (?,?,?,?,?,?,?)')
      .run(req.guild.id, req.user.id, character, c ? c.level : null, String(req.body.zone || '').slice(0, 60), String(req.body.when_text || '').slice(0, 60), String(req.body.note || '').slice(0, 140));
    q.activity.run(req.guild.id, 'buddy', `${character} is looking for leveling partners${req.body.zone ? ` in ${String(req.body.zone).slice(0, 60)}` : ''}`);
    back(res, '/buddies', 'Posted.');
  });
  app.post('/buddies/:id/close', needGuild, (req, res) => {
    db.prepare('UPDATE buddy_posts SET active = 0 WHERE id = ? AND user_id = ? AND guild_id = ?').run(req.params.id, req.user.id, req.guild.id);
    back(res, '/buddies');
  });

  // ---- settings ----
  const tokensFor = (req) => db.prepare('SELECT id, prefix, created_at, last_used_at FROM api_tokens WHERE user_id = ? AND guild_id = ? ORDER BY id DESC').all(req.user.id, req.guild.id);
  const settingsPage = (req, res, newToken) => res.page({
    title: 'Settings', active: 'settings',
    body: P.settings({
      csrf: req.csrf, tokens: tokensFor(req), newToken, guild: req.guild, baseUrl: cfg.baseUrl,
      isOfficer: ['owner', 'officer'].includes(req.guild.role),
      isOwner: req.guild.role === 'owner', me: req.user.id,
      members: db.prepare('SELECT u.id, u.battletag, m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.guild_id = ? ORDER BY m.role, u.battletag').all(req.guild.id),
      calendarUrl: (() => {
        let t = req.user.calendar_token;
        if (!t) { t = calendarToken(); db.prepare('UPDATE users SET calendar_token = ? WHERE id = ?').run(t, req.user.id); }
        return `${cfg.baseUrl}/calendar/${t}.ics`;
      })(),
      gameData: {
        ns: gamedata.namespaces(blizzard.load(db), req.guild.wowhead_game, cfg.bnetRegion),
        items: db.prepare('SELECT COUNT(*) n FROM item_info WHERE found = 1').get().n,
        realmStatus: (() => { try { return req.guild.realm_status ? JSON.parse(req.guild.realm_status) : null; } catch { return null; } })(),
      },
      pushDevices: db.prepare('SELECT COUNT(*) n FROM push_subs WHERE user_id = ?').get(req.user.id).n,
      pushPrefs: (() => { const r = db.prepare('SELECT prefs FROM push_subs WHERE user_id = ? LIMIT 1').get(req.user.id); try { return r ? JSON.parse(r.prefs) : null; } catch { return null; } })(),
      discordInfo: {
        configured: Boolean(cfg.discordPublicKey && cfg.discordAppId), appId: cfg.discordAppId,
        linked: Boolean(req.user.discord_id), serverLinked: Boolean(req.guild.discord_server_id),
      },
    }),
  });
  app.get('/settings', needGuild, (req, res) => settingsPage(req, res, null));
  app.post('/settings/token', needGuild, (req, res) => {
    const t = A.newApiToken();
    db.prepare('INSERT INTO api_tokens (user_id, guild_id, token_hash, prefix) VALUES (?,?,?,?)').run(req.user.id, req.guild.id, t.hash, t.prefix);
    audit(req, 'sync key created', t.prefix);
    settingsPage(req, res, t.raw);
  });
  // One click: companion with this site's address and a brand-new sync key already in config.json.
  app.post('/settings/companion', needGuild, (req, res) => {
    let buf;
    const t = A.newApiToken();
    try {
      db.prepare('INSERT INTO api_tokens (user_id, guild_id, token_hash, prefix) VALUES (?,?,?,?)').run(req.user.id, req.guild.id, t.hash, t.prefix);
      buf = companionZip(t.raw);
    } catch (e) {
      db.prepare('DELETE FROM api_tokens WHERE token_hash = ?').run(t.hash);
      return back(res, '/settings', 'The companion download isn’t available on this server yet.');
    }
    audit(req, 'companion downloaded with new sync key', t.prefix);
    res.setHeader('Content-Disposition', 'attachment; filename="wow-companion.zip"');
    res.setHeader('Cache-Control', 'no-store');
    res.type('application/zip').send(buf);
  });
  app.post('/settings/token/:id/revoke', needGuild, (req, res) => {
    const r = db.prepare('DELETE FROM api_tokens WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
    if (r.changes) audit(req, 'sync key revoked');
    back(res, '/settings', 'Sync key revoked.');
  });
  app.post('/settings/webhook', needOfficer, (req, res) => {
    const url = String(req.body.webhook || '').trim();
    if (url && !/^https:\/\/(discord|discordapp)\.com\/api\/webhooks\/[\w/-]+$/.test(url)) return back(res, '/settings', 'That isn’t a Discord webhook URL.');
    db.prepare('UPDATE guilds SET discord_webhook = ? WHERE id = ?').run(url || null, req.guild.id);
    audit(req, url ? 'Discord webhook set' : 'Discord webhook removed');
    back(res, '/settings', url ? 'Webhook saved.' : 'Webhook removed.');
  });
  // ---- members ----
  const memberRow = (req) => db.prepare('SELECT m.role, u.battletag, u.id FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.user_id = ? AND m.guild_id = ?').get(req.params.id, req.guild.id);
  app.post('/members/:id(\\d+)/promote', needOfficer, (req, res) => {
    const m = memberRow(req);
    if (!m || m.role !== 'member') return back(res, '/settings');
    db.prepare("UPDATE memberships SET role = 'officer' WHERE user_id = ? AND guild_id = ?").run(m.id, req.guild.id);
    audit(req, 'promoted to officer', m.battletag);
    back(res, '/settings', `${m.battletag.split('#')[0]} is now an officer.`);
  });
  app.post('/members/:id(\\d+)/demote', needOfficer, (req, res) => {
    const m = memberRow(req);
    if (req.guild.role !== 'owner') return res.status(403).send('Only the guild owner can demote officers.');
    if (!m || m.role !== 'officer') return back(res, '/settings');
    db.prepare("UPDATE memberships SET role = 'member' WHERE user_id = ? AND guild_id = ?").run(m.id, req.guild.id);
    audit(req, 'demoted to member', m.battletag);
    back(res, '/settings', `${m.battletag.split('#')[0]} is now a member.`);
  });
  app.post('/members/:id(\\d+)/remove', needOfficer, (req, res) => {
    const m = memberRow(req);
    if (!m || m.role === 'owner' || m.id === req.user.id) return back(res, '/settings', 'You can’t remove that member.');
    if (m.role === 'officer' && req.guild.role !== 'owner') return res.status(403).send('Only the guild owner can remove officers.');
    db.transaction(() => {
      db.prepare('DELETE FROM memberships WHERE user_id = ? AND guild_id = ?').run(m.id, req.guild.id);
      db.prepare('DELETE FROM api_tokens WHERE user_id = ? AND guild_id = ?').run(m.id, req.guild.id);
      db.prepare('UPDATE characters SET user_id = NULL, is_main = 0 WHERE user_id = ? AND guild_id = ?').run(m.id, req.guild.id);
    })();
    audit(req, 'removed from guild', m.battletag);
    back(res, '/settings', `${m.battletag.split('#')[0]} was removed. Their sync keys no longer work.`);
  });
  app.post('/settings/wowhead', needOfficer, (req, res) => {
    const game = wowhead.GAMES.includes(req.body.game) ? req.body.game : 'forever';
    db.prepare('UPDATE guilds SET wowhead_game = ? WHERE id = ?').run(game, req.guild.id);
    wowhead.setGame(game);
    audit(req, 'Wowhead tooltips set', game);
    back(res, '/settings', `Item tooltips now use Wowhead's ${game === 'retail' ? 'Retail' : game === 'classic' ? 'Classic' : 'Forever'} database.`);
  });
  app.post('/settings/invite/reset', needOfficer, (req, res) => {
    db.prepare('UPDATE guilds SET invite_code = ? WHERE id = ?').run(A.inviteCode(), req.guild.id);
    audit(req, 'invite link replaced');
    back(res, '/settings', 'New invite link made. The old one no longer works.');
  });

  // ---- officers: sync health, backups, audit log ----
  const latest = () => ({ addon: readDownload('addon-version.txt'), companion: readDownload('companion-version.txt') });
  app.get('/admin', needOfficer, (req, res) => {
    const gid = req.guild.id;
    res.page({
      title: 'Officer tools', active: 'admin',
      body: P.admin({
        latest: latest(), isOwner: req.guild.role === 'owner', csrf: req.csrf,
        members: db.prepare(`SELECT u.id, u.battletag, u.addon_version, u.companion_version, u.last_sync_at, u.discord_id, m.role, m.joined_at,
            (SELECT COUNT(*) FROM characters c WHERE c.user_id = u.id AND c.guild_id = m.guild_id) AS chars,
            (SELECT COUNT(*) FROM api_tokens t WHERE t.user_id = u.id AND t.guild_id = m.guild_id) AS keys
          FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.guild_id = ? ORDER BY u.last_sync_at IS NULL, u.last_sync_at DESC`).all(gid),
        backups: backup.listBackups(backup.backupDir(cfg.dbFile)),
        blizzard: blizzard.load(db),
        auditRows: db.prepare(`SELECT a.*, u.battletag FROM audit_log a LEFT JOIN users u ON u.id = a.user_id WHERE a.guild_id = ? ORDER BY a.id DESC LIMIT 100`).all(gid),
      }),
    });
  });
  app.get('/admin/backups/:file', needOfficer, (req, res) => {
    if (req.guild.role !== 'owner') return res.status(403).send('Only the guild owner can download backups.');
    const ok = backup.listBackups(backup.backupDir(cfg.dbFile)).find((b) => b.file === req.params.file);
    if (!ok) return res.status(404).send('Backup not found');
    audit(req, 'downloaded backup', ok.file);
    res.download(path.join(backup.backupDir(cfg.dbFile), ok.file));
  });
  app.post('/admin/reset', needOfficer, (req, res) => {
    if (req.guild.role !== 'owner') return res.status(403).send('Only the guild owner can wipe the guild’s data.');
    if (String(req.body.confirm || '').trim().toUpperCase() !== 'WIPE') return back(res, '/admin', 'Nothing was wiped. Type WIPE in the box to confirm.');
    try {
      const dir = cfg.dbFile && cfg.dbFile !== ':memory:' ? backup.backupDir(cfg.dbFile) : null;
      const r = require('./reset').resetGuild(db, req.guild.id, dir);
      const n = Object.values(r.removed).reduce((a, b) => a + b, 0);
      audit(req, 'wiped guild data for a fresh start', `${n} rows${r.backup ? `, backup ${path.basename(r.backup)}` : ''}`);
      back(res, '/admin', `Fresh start done: ${n} rows of game data removed${r.backup ? ` (backup ${path.basename(r.backup)} kept)` : ''}. Members, settings and sync keys are untouched.`);
    } catch (e) { back(res, '/admin', `Wipe failed, nothing changed: ${e.message}`); }
  });
  app.post('/admin/backups', needOfficer, (req, res) => {
    try { const f = backup.runBackup(db, backup.backupDir(cfg.dbFile)); audit(req, 'backup made', path.basename(f)); back(res, '/admin', 'Backup made.'); } catch (e) { back(res, '/admin', `Backup failed: ${e.message}`); }
  });

  // ---- raids & loot (Phase 2) ----
  const raids = require('./routes/raids')(app, { db, cfg, discord, activity: q.activity, needGuild, needOfficer, back, audit, notify });
  app.locals.remind = raids.remind;
  phase3.routes(app, { db, cfg, discord, activity: q.activity, needGuild, needOfficer, back, audit, notify });
  require('./routes/freebies')(app, { db, cfg, push, needGuild, needOfficer, back, audit });

  // Official Blizzard game data (gamedata.js). cfg.gameFetch lets tests stand in for Blizzard.
  const gameRun = (opts = {}) => gamedata.run(db, cfg, { fetchImpl: cfg.gameFetch, notify, ...opts });
  app.post('/settings/realm', needOfficer, (req, res) => {
    const realm = String(req.body.realm || '').trim().slice(0, 60) || null;
    const gameGuild = String(req.body.game_guild || '').trim().slice(0, 60) || null;
    db.prepare('UPDATE guilds SET realm = ?, game_guild = ?, realm_status = NULL, official_roster_at = NULL WHERE id = ?').run(realm, gameGuild, req.guild.id);
    audit(req, 'realm set', `${realm || '-'} / ${gameGuild || '-'}`);
    back(res, '/settings', 'Saved. Use "Refresh now" to fetch realm status and the official roster.');
  });
  app.post('/settings/gamedata/refresh', needOfficer, async (req, res) => {
    try {
      const realm = await gameRun({ only: 'realm' }); const roster = await gameRun({ only: 'roster' });
      back(res, '/settings', [...realm, ...roster].join('. ') || 'Refreshed.');
    } catch (e) { back(res, '/settings', `Refresh failed: ${e.message}`); }
  });
  if (cfg.timers) {
    let busy = false;
    const loop = (only) => async () => {
      if (busy) return; busy = true;
      try { for (const l of await gameRun({ only })) console.log('Game data:', l); } catch (e) { console.warn('Game data failed:', e.message); } finally { busy = false; }
    };
    setTimeout(loop(), 60 * 1000);
    setInterval(loop(), 3600 * 1000).unref();
    setInterval(loop('realm'), 5 * 60 * 1000).unref();
  }
  if (cfg.timers) setInterval(() => raids.remind().catch((e) => console.warn('Reminder failed:', e.message)), 60 * 1000).unref();

  // ---- companion API ----
  const bearer = (req, res, next) => {
    const m = /^Bearer (wowg_[\w-]+)$/.exec(req.headers.authorization || '');
    // The key must belong to someone who is still in the guild.
    const row = m && db.prepare(`SELECT t.*, g.discord_webhook, g.name AS guild_name FROM api_tokens t JOIN guilds g ON g.id = t.guild_id
      JOIN memberships ms ON ms.user_id = t.user_id AND ms.guild_id = t.guild_id WHERE token_hash = ?`).get(A.hashToken(m[1]));
    if (!row) return res.status(401).json({ error: 'Sync key not recognised. Create a new one in Settings.' });
    db.prepare("UPDATE api_tokens SET last_used_at = datetime('now') WHERE id = ?").run(row.id);
    req.tok = row;
    next();
  };
  app.post('/api/sync', bearer, async (req, res) => {
    try {
      const stats = applyPayload(db, req.tok.guild_id, req.tok.user_id, req.body);
      db.prepare('INSERT INTO sync_log (guild_id, user_id, bytes) VALUES (?,?,?)').run(req.tok.guild_id, req.tok.user_id, Number(req.headers['content-length']) || 0);
      const ver = (v) => (typeof v === 'string' && /^[\w.+-]{1,20}$/.test(v) ? v : null);
      db.prepare("UPDATE users SET addon_version = COALESCE(?, addon_version), companion_version = COALESCE(?, companion_version), last_sync_at = datetime('now') WHERE id = ?")
        .run(ver(req.body && req.body.addonVersion), ver(req.get('X-Companion-Version')), req.tok.user_id);
      for (const c of stats.ctas) {
        await discord({ discord_webhook: req.tok.discord_webhook }, `⚔️ **Call to arms: ${c.zone}**${c.needed ? ` (need ${c.needed})` : ''}\n${c.message || ''}\n— ${c.character || 'someone'} (from in game)`);
        notify(req.tok.guild_id, 'cta', { title: `⚔️ Call to arms: ${c.zone}`, body: `${c.needed ? `Need ${c.needed}. ` : ''}${c.message || ''} (${c.character || 'from in game'})`, url: '/' }, { exceptUserId: req.tok.user_id });
      }
      res.json({ ok: true, characters: stats.characters, roster: stats.roster, recipes: stats.recipes, ctas: stats.ctas.length,
        inventory: stats.inventory, bank: stats.bank, prices: stats.prices, latest: latest() });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });
  const inboxFor = (req) => ({ ...buildInbox(db, req.tok.guild_id, req.tok.user_id), latestAddon: latest().addon, site: cfg.baseUrl });
  app.get('/api/inbox', bearer, (req, res) => res.json(inboxFor(req)));
  app.get('/api/inbox.lua', bearer, (req, res) => {
    res.type('text/plain').send(`-- Written by the wow companion. Do not edit.\nWowGuildInbox = ${toLua(inboxFor(req))}\n`);
  });
  app.get('/healthz', (req, res) => res.json({ ok: true }));

  app.use((req, res) => res.status(404).page({ title: 'Not found', body: P.notFound() }));
  return app;
}

if (require.main === module) {
  const cfg = config();
  const db = dbm.open(cfg.dbFile);
  createApp(cfg, db).listen(cfg.port, () => console.log(`wow listening on ${cfg.port} (${cfg.baseUrl})`));
  // Daily database backups into /data/backups (kept 14 days).
  const dir = backup.backupDir(cfg.dbFile);
  const tick = () => { try { const f = backup.backupIfDue(db, dir); if (f) console.log('Backup written:', f); } catch (e) { console.error('Backup failed:', e.message); } };
  setTimeout(tick, 30 * 1000);
  setInterval(tick, 3600 * 1000);
  // Blizzard API: check daily what's available (and whether WoW: Forever data has appeared).
  const bliz = async () => {
    try {
      const s = await blizzard.check(cfg); blizzard.save(db, s);
      console.log(`Blizzard API: ${s.ok ? 'reachable' : 'not reachable'}, Retail token ${s.tokenGold ?? '?'}g, Forever namespace: ${s.forever || 'not yet'}`);
    } catch (e) { console.warn('Blizzard API check failed:', e.message); }
  };
  setTimeout(bliz, 20 * 1000);
  setInterval(bliz, 24 * 3600 * 1000);
  // Source check: log which free services this server can reach.
  setTimeout(async () => {
    for (const [name, url] of [['Wowhead tooltips', 'https://wow.zamimg.com/js/tooltips.js'], ['Wowhead data', 'https://nether.wowhead.com/tooltip/item/2589'], ['Discord', 'https://discord.com/api/v10/gateway']]) {
      try { const r = await fetch(url, { signal: AbortSignal.timeout(8000) }); console.log(`Source ${name}: ${r.status}`); } catch (e) { console.log(`Source ${name}: unreachable (${e.message})`); }
    }
  }, 15 * 1000);
}

module.exports = { createApp, config };
