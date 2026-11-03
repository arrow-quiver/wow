const express = require('express');
const path = require('path');
const crypto = require('crypto');
const dbm = require('./db');
const A = require('./auth');
const { applyPayload, buildInbox, toLua } = require('./sync');
const { layout } = require('./views/layout');
const P = require('./views/pages');

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
    next();
  });
  app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));
  const phase3 = require('./routes/phase3');
  // Discord calls this with its own signature; it must skip the session and CSRF checks below.
  phase3.mountDiscord(app, { db, cfg, discord: (...a) => discord(...a) });
  app.use('/api', express.json({ limit: '15mb' }));
  app.use(express.urlencoded({ extended: false, limit: '50kb' }));

  // ---- helpers ----
  const q = {
    user: db.prepare('SELECT * FROM users WHERE id = ?'),
    membership: db.prepare(`SELECT g.*, m.role FROM memberships m JOIN guilds g ON g.id = m.guild_id WHERE m.user_id = ? ORDER BY m.joined_at LIMIT 1`),
    activity: db.prepare('INSERT INTO activity (guild_id, kind, text) VALUES (?,?,?)'),
  };
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
    back(res, '/', 'Horn sounded.');
  });

  app.post('/announcements', needOfficer, async (req, res) => {
    const body = String(req.body.body || '').trim().slice(0, 500);
    if (!body) return back(res, '/');
    db.prepare('INSERT INTO announcements (guild_id, user_id, body) VALUES (?,?,?)').run(req.guild.id, req.user.id, body);
    await discord(req.guild, `📜 **Notice**\n${body}`);
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
        recipes: db.prepare('SELECT profession, name FROM recipes WHERE character_id = ? ORDER BY profession, name').all(c.id),
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
      const rows = db.prepare(`SELECT r.name AS recipe, c.name, c.class, c.online FROM recipes r JOIN characters c ON c.id = r.character_id
        WHERE c.guild_id = ? AND r.name LIKE ? ESCAPE '\\' ORDER BY r.name, c.online DESC, c.name LIMIT 300`)
        .all(req.guild.id, `%${qstr.replace(/[\\%_]/g, (m) => '\\' + m)}%`);
      const map = new Map();
      for (const r of rows) { if (!map.has(r.recipe)) map.set(r.recipe, []); map.get(r.recipe).push(r); }
      results = [...map].map(([recipe, crafters]) => ({ recipe, crafters }));
    } else {
      const rows = db.prepare(`SELECT p.name AS prof, p.skill, c.name, c.class FROM professions p JOIN characters c ON c.id = p.character_id
        WHERE c.guild_id = ? ORDER BY p.name, p.skill DESC`).all(req.guild.id);
      const map = new Map();
      for (const r of rows) { if (!map.has(r.prof)) map.set(r.prof, []); map.get(r.prof).push(r); }
      profSummary = [...map].map(([name, chars]) => ({ name, chars }));
    }
    res.page({ title: 'Crafters', active: 'crafters', body: P.crafters({ q: qstr, results, profSummary }) });
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
      members: db.prepare('SELECT u.id, u.battletag, m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.guild_id = ? ORDER BY m.role, u.battletag').all(req.guild.id),
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
    settingsPage(req, res, t.raw);
  });
  app.post('/settings/token/:id/revoke', needGuild, (req, res) => {
    db.prepare('DELETE FROM api_tokens WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
    back(res, '/settings', 'Sync key revoked.');
  });
  app.post('/settings/webhook', needOfficer, (req, res) => {
    const url = String(req.body.webhook || '').trim();
    if (url && !/^https:\/\/(discord|discordapp)\.com\/api\/webhooks\/[\w/-]+$/.test(url)) return back(res, '/settings', 'That isn’t a Discord webhook URL.');
    db.prepare('UPDATE guilds SET discord_webhook = ? WHERE id = ?').run(url || null, req.guild.id);
    back(res, '/settings', url ? 'Webhook saved.' : 'Webhook removed.');
  });
  app.post('/members/:id/promote', needOfficer, (req, res) => {
    db.prepare("UPDATE memberships SET role = 'officer' WHERE user_id = ? AND guild_id = ? AND role = 'member'").run(req.params.id, req.guild.id);
    back(res, '/settings', 'Promoted to officer.');
  });

  // ---- raids & loot (Phase 2) ----
  const raids = require('./routes/raids')(app, { db, cfg, discord, activity: q.activity, needGuild, needOfficer, back });
  app.locals.remind = raids.remind;
  phase3.routes(app, { db, cfg, discord, activity: q.activity, needGuild, needOfficer, back });
  if (cfg.timers) setInterval(() => raids.remind().catch((e) => console.warn('Reminder failed:', e.message)), 60 * 1000).unref();

  // ---- companion API ----
  const bearer = (req, res, next) => {
    const m = /^Bearer (wowg_[\w-]+)$/.exec(req.headers.authorization || '');
    const row = m && db.prepare('SELECT t.*, g.discord_webhook, g.name AS guild_name FROM api_tokens t JOIN guilds g ON g.id = t.guild_id WHERE token_hash = ?').get(A.hashToken(m[1]));
    if (!row) return res.status(401).json({ error: 'Sync key not recognised. Create a new one in Settings.' });
    db.prepare("UPDATE api_tokens SET last_used_at = datetime('now') WHERE id = ?").run(row.id);
    req.tok = row;
    next();
  };
  app.post('/api/sync', bearer, async (req, res) => {
    try {
      const stats = applyPayload(db, req.tok.guild_id, req.tok.user_id, req.body);
      db.prepare('INSERT INTO sync_log (guild_id, user_id, bytes) VALUES (?,?,?)').run(req.tok.guild_id, req.tok.user_id, Number(req.headers['content-length']) || 0);
      for (const c of stats.ctas) {
        await discord({ discord_webhook: req.tok.discord_webhook }, `⚔️ **Call to arms: ${c.zone}**${c.needed ? ` (need ${c.needed})` : ''}\n${c.message || ''}\n— ${c.character || 'someone'} (from in game)`);
      }
      res.json({ ok: true, characters: stats.characters, roster: stats.roster, recipes: stats.recipes, ctas: stats.ctas.length,
        inventory: stats.inventory, bank: stats.bank, prices: stats.prices });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });
  app.get('/api/inbox', bearer, (req, res) => res.json(buildInbox(db, req.tok.guild_id, req.tok.user_id)));
  app.get('/api/inbox.lua', bearer, (req, res) => {
    res.type('text/plain').send(`-- Written by the wow companion. Do not edit.\nWowGuildInbox = ${toLua(buildInbox(db, req.tok.guild_id, req.tok.user_id))}\n`);
  });
  app.get('/healthz', (req, res) => res.json({ ok: true }));

  app.use((req, res) => res.status(404).page({ title: 'Not found', body: P.notFound() }));
  return app;
}

if (require.main === module) {
  const cfg = config();
  const db = dbm.open(cfg.dbFile);
  createApp(cfg, db).listen(cfg.port, () => console.log(`wow listening on ${cfg.port} (${cfg.baseUrl})`));
}

module.exports = { createApp, config };
