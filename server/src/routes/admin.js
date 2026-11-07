// Officer tools: sync health, backups, the audit log, fresh start, Blizzard API and game data status,
// AI usage. Also runs the background jobs the old server started in its entry point: the daily
// backup check, the daily Blizzard API check, game data hourly and realm status every 5 minutes.
// Ported from the old web/src/server.js (/admin, /admin/*, /settings/gamedata/refresh) and
// routes/freebies.js (/admin/blizzard). Shapes are documented in docs/api/admin.md.
const fs = require('fs');
const path = require('path');
const {
  HttpError, int, needOfficer, isOwner,
} = require('../http');
const backup = require('../services/backup');
const { resetGuild } = require('../services/reset');
const blizzard = require('../services/blizzard');
const gamedata = require('../services/gamedata');
const ai = require('../services/ai');
const coach = require('../services/coach');
const version = require('../../../app/src/shared/version');

const DAY_MS = 86400000;
const STALE_DAYS = 7; // sync health: a member who hasn't synced for a week is flagged
const AUDIT_PAGE = 50;
const AUDIT_MAX = 200;
const BACKUP_KEEP = 14; // what the daily job keeps (services/backup.js runBackup default)

const shortName = (battletag) => String(battletag || '').split('#')[0];
// SQLite datetime('now') text is UTC without a zone marker; ISO strings pass through.
const timeMs = (t) => {
  if (!t) return NaN;
  const s = String(t);
  return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(' ', 'T')}Z`);
};

function register(app, ctx) {
  const { db, cfg } = ctx;
  // Backups need a database file; an in-memory database (tests, quick trials) has nowhere to copy from.
  const backupsEnabled = Boolean(cfg.dbFile && cfg.dbFile !== ':memory:');
  const backupDir = backupsEnabled ? backup.backupDir(cfg.dbFile) : null;

  const q = {
    members: db.prepare(`SELECT u.id, u.battletag, u.addon_version, u.app_version, u.companion_version, u.last_sync_at,
        u.discord_id, m.role, m.joined_at,
        (SELECT COUNT(*) FROM characters c WHERE c.user_id = u.id AND c.guild_id = m.guild_id) AS characters,
        (SELECT COUNT(*) FROM api_tokens t WHERE t.user_id = u.id AND t.guild_id = m.guild_id) AS sync_keys,
        (SELECT COUNT(*) FROM devices d WHERE d.user_id = u.id) AS devices
      FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.guild_id = ? ORDER BY u.last_sync_at IS NULL, u.last_sync_at DESC, u.battletag COLLATE NOCASE`),
    audit: db.prepare(`SELECT a.id, a.user_id, a.action, a.detail, a.created_at, u.battletag
      FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
      WHERE a.guild_id = ? AND a.id < ? ORDER BY a.id DESC LIMIT ?`),
    guild: db.prepare('SELECT * FROM guilds WHERE id = ?'),
    itemsKnown: db.prepare('SELECT COUNT(*) AS n FROM item_info WHERE found = 1'),
    officialRoster: db.prepare('SELECT COUNT(*) AS n FROM characters WHERE guild_id = ? AND in_official_roster = 1'),
  };

  // ---------- views ----------

  const latestVersions = () => {
    let latest = null;
    try { latest = ctx.latest(); } catch (e) { ctx.log.warn('Latest releases unavailable:', e.message); }
    return {
      app: (latest && latest.app && latest.app.version) || null,
      addon: (latest && latest.addon && latest.addon.version) || null,
    };
  };

  // A member is outdated when they report a version and it is older than the newest release.
  const outdated = (v, newest) => Boolean(v && newest && version.lt(v, newest));

  function syncHealth(guildId, latest) {
    const now = Date.now();
    return q.members.all(guildId).map((m) => {
      const synced = timeMs(m.last_sync_at);
      return {
        id: m.id,
        battletag: m.battletag,
        name: shortName(m.battletag),
        role: m.role,
        joined_at: m.joined_at,
        characters: m.characters,
        devices: m.devices,
        sync_keys: m.sync_keys,
        discord_linked: Boolean(m.discord_id),
        last_sync_at: m.last_sync_at ?? null,
        addon_version: m.addon_version ?? null,
        app_version: m.app_version ?? null,
        companion_version: m.companion_version ?? null,
        addonOutdated: outdated(m.addon_version, latest.addon),
        appOutdated: outdated(m.app_version, latest.app),
        // Still syncing with the old companion and never signed in to the app.
        legacyCompanion: Boolean(m.companion_version && !m.app_version),
        neverSynced: !m.last_sync_at,
        stale: Boolean(m.last_sync_at) && (!Number.isFinite(synced) || now - synced > STALE_DAYS * DAY_MS),
      };
    });
  }

  function backupList() {
    if (!backupsEnabled) return [];
    return backup.listBackups(backupDir).map((b) => ({ file: b.file, size: b.bytes, created: b.at }));
  }

  // One page of the audit log, newest first. `before` is the id to continue from (exclusive).
  function auditPage(guildId, before, limit = AUDIT_PAGE) {
    const rows = q.audit.all(guildId, before || Number.MAX_SAFE_INTEGER, limit + 1);
    const more = rows.length > limit;
    const entries = rows.slice(0, limit).map((a) => ({
      id: a.id,
      user_id: a.user_id ?? null,
      battletag: a.battletag ?? null,
      name: a.battletag ? shortName(a.battletag) : 'system',
      action: a.action,
      detail: a.detail || null,
      created_at: a.created_at,
    }));
    return { entries, nextBefore: more && entries.length ? entries[entries.length - 1].id : null };
  }

  const blizzardView = () => ({
    configured: Boolean(cfg.bnetClientId && cfg.bnetClientSecret),
    region: cfg.bnetRegion || 'eu',
    status: blizzard.load(db),
  });

  function gameDataView(guildId) {
    const g = q.guild.get(guildId);
    let realmStatus = null;
    try { realmStatus = g.realm_status ? JSON.parse(g.realm_status) : null; } catch { realmStatus = null; }
    const ns = gamedata.namespaces(blizzard.load(db), g.wowhead_game, cfg.bnetRegion);
    return {
      namespaces: ns,
      // Realm status and the official roster need a namespace with live data (not there for Forever yet).
      liveData: Boolean(ns.dynamic),
      itemsKnown: q.itemsKnown.get().n,
      realm: g.realm ?? null,
      game_guild: g.game_guild ?? null,
      realm_status: realmStatus,
      official_roster_at: g.official_roster_at ?? null,
      official_roster_note: g.official_roster_note ?? null,
      officialRosterMembers: q.officialRoster.get(guildId).n,
    };
  }

  function aiView(guildId) {
    const g = q.guild.get(guildId);
    const now = new Date();
    return {
      hasKey: Boolean(cfg.anthropicKey),
      coach_enabled: g.coach_enabled ?? 1,
      coach_budget_usd: g.coach_budget_usd ?? 15,
      spentUsd: Math.round(ai.monthSpend(db, guildId) * 10000) / 10000,
      month: `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`,
      limits: { ...coach.LIMITS },
    };
  }

  // ---------- jobs (also run by the timers below) ----------

  // A fresh snapshot now. → full path.
  function backupNow() {
    if (!backupsEnabled) throw new HttpError(409, 'Backups need a database file. This server keeps its data in memory.');
    return backup.runBackup(db, backupDir, { keep: BACKUP_KEEP });
  }

  // Blizzard's Game Data API: what's reachable and whether a Forever namespace exists yet.
  async function checkBlizzard() {
    const status = await blizzard.check(cfg);
    blizzard.save(db, status);
    return status;
  }

  // One game data pass; realm-up notifications go out as 'notice' events.
  const gameRun = (opts = {}) => gamedata.run(db, cfg, { notify: (gid, kind, o) => ctx.emit(gid, kind, o), ...opts });

  ctx.services.admin = { backupNow, checkBlizzard, gameRun, syncHealth, auditPage };

  // ---------- routes ----------

  app.get('/api/admin', needOfficer, (req, res) => {
    const before = req.query.before === undefined ? null : int(req.query.before, 1);
    if (req.query.before !== undefined && before == null) throw new HttpError(400, 'The audit log cursor must be a number.');
    const gid = req.guild.id;
    const latest = latestVersions();
    res.json({
      isOwner: isOwner(req),
      latest,
      members: syncHealth(gid, latest),
      backupsEnabled,
      canDownloadBackups: isOwner(req),
      backups: backupList(),
      audit: auditPage(gid, before),
      blizzard: blizzardView(),
      gameData: gameDataView(gid),
      ai: aiView(gid),
    });
  });

  // More of the audit log: ?before=<id from nextBefore>&limit=50 (up to 200).
  app.get('/api/admin/audit', needOfficer, (req, res) => {
    const before = req.query.before === undefined || req.query.before === '' ? null : int(req.query.before, 1);
    if (req.query.before !== undefined && req.query.before !== '' && before == null) throw new HttpError(400, 'The audit log cursor must be a number.');
    const limit = req.query.limit === undefined ? AUDIT_PAGE : int(req.query.limit, 1, AUDIT_MAX);
    if (limit == null) throw new HttpError(400, 'The page size must be a number.');
    res.json(auditPage(req.guild.id, before, limit));
  });

  // The parts Guild settings shows: Blizzard, game data and AI usage.
  app.get('/api/admin/status', needOfficer, (req, res) => {
    res.json({ blizzard: blizzardView(), gameData: gameDataView(req.guild.id), ai: aiView(req.guild.id) });
  });

  // ---- backups ----
  app.post('/api/admin/backups', needOfficer, (req, res) => {
    let file;
    try {
      file = backupNow();
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(500, `Backup failed: ${e.message}`);
    }
    const name = path.basename(file);
    ctx.audit(req, 'backup made', name);
    const list = backupList();
    res.json({ ok: true, backup: list.find((b) => b.file === name) || { file: name, size: null, created: null }, backups: list, message: 'Backup made.' });
  });

  // Download a backup. The whole database is in it (everyone's data), so only the owner may.
  app.get('/api/admin/backups/:file', needOfficer, (req, res, next) => {
    if (!isOwner(req)) throw new HttpError(403, 'Only the guild owner can download backups.');
    const wanted = String(req.params.file || '');
    // Only names the listing shows: no paths, no other files in the folder.
    const found = backup.isBackupName(wanted) && backupList().find((b) => b.file === wanted);
    if (!found) throw new HttpError(404, 'Backup not found.');
    const full = path.join(backupDir, found.file);
    if (!fs.existsSync(full)) throw new HttpError(404, 'Backup not found.');
    ctx.audit(req, 'downloaded backup', found.file);
    res.download(full, found.file, { headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/vnd.sqlite3' } }, (err) => {
      if (err && !res.headersSent) next(new HttpError(404, 'Backup not found.'));
    });
  });

  // ---- fresh start (owner): wipe game data, keep people and settings. A backup is made first. ----
  app.post('/api/admin/reset', needOfficer, (req, res) => {
    if (!isOwner(req)) throw new HttpError(403, 'Only the guild owner can wipe the guild’s data.');
    const g = q.guild.get(req.guild.id);
    const typed = typeof req.body.confirm === 'string' ? req.body.confirm.trim() : '';
    if (!typed || typed.toLowerCase() !== String(g.name).trim().toLowerCase()) {
      throw new HttpError(400, `Nothing was wiped. Type the guild name (${g.name}) to confirm.`);
    }
    let r;
    try {
      r = resetGuild(db, g.id, backupDir);
    } catch (e) {
      throw new HttpError(500, `Wipe failed, nothing changed: ${e.message}`);
    }
    const rows = Object.values(r.removed).reduce((a, b) => a + b, 0);
    const kept = r.backup ? path.basename(r.backup) : null;
    ctx.audit(req, 'wiped guild data for a fresh start', `${rows} rows${kept ? `, backup ${kept}` : ''}`);
    res.json({
      ok: true,
      rows,
      removed: r.removed,
      backup: kept,
      message: `Fresh start done: ${rows} rows of game data removed${kept ? ` (backup ${kept} kept)` : ''}. Members, settings, devices and sync keys are untouched.`,
    });
  });

  // ---- Blizzard API check ----
  app.post('/api/admin/blizzard', needOfficer, async (req, res) => {
    try {
      await checkBlizzard();
    } catch (e) {
      throw new HttpError(502, `Blizzard API check failed: ${e.message}`);
    }
    res.json({ ok: true, blizzard: blizzardView(), gameData: gameDataView(req.guild.id), message: 'Blizzard API checked.' });
  });

  // ---- game data: realm status and the official roster, right now ----
  app.post('/api/admin/gamedata/refresh', needOfficer, async (req, res) => {
    const view = gameDataView(req.guild.id);
    let message;
    let lines = [];
    if (!(cfg.bnetClientId && cfg.bnetClientSecret)) {
      message = 'No Battle.net app is set up on the server, so there is nothing to refresh.';
    } else if (!view.realm) {
      message = 'Save the realm name first, then refresh.';
    } else if (!view.liveData) {
      message = 'Blizzard’s API doesn’t have WoW: Forever realms yet, so realm status and the official guild list will appear once it does.';
    } else {
      try {
        const realm = await gameRun({ only: 'realm' });
        const roster = await gameRun({ only: 'roster' });
        lines = [...new Set([...realm, ...roster])];
      } catch (e) {
        throw new HttpError(502, `Refresh failed: ${e.message}`);
      }
      message = lines.join('. ') || 'Refreshed.';
    }
    res.json({ ok: true, log: lines, message, gameData: gameDataView(req.guild.id) });
  });

  // ---------- background jobs (never in tests) ----------
  if (cfg.timers) {
    const later = (fn, ms) => { const h = setTimeout(fn, ms); if (h.unref) h.unref(); ctx.timers.push(h); };
    const every = (fn, ms) => { const h = setInterval(fn, ms); if (h.unref) h.unref(); ctx.timers.push(h); };

    // Daily database backups into <dir of DB_FILE>/backups (the last 14 kept), checked hourly.
    if (backupsEnabled) {
      const tick = () => {
        try {
          const f = backup.backupIfDue(db, backupDir);
          if (f) ctx.log.info(`Backup written: ${f}`);
        } catch (e) { ctx.log.error(`Backup failed: ${e.message}`); }
      };
      later(tick, 30 * 1000);
      every(tick, 3600 * 1000);
    }

    // Blizzard API: check daily what's available (and whether WoW: Forever data has appeared).
    const bliz = async () => {
      try {
        const s = await checkBlizzard();
        ctx.log.info(`Blizzard API: ${s.ok ? 'reachable' : 'not reachable'}, Retail token ${s.tokenGold ?? '?'}g, Forever namespace: ${s.forever || 'not yet'}`);
      } catch (e) { ctx.log.warn(`Blizzard API check failed: ${e.message}`); }
    };
    later(bliz, 20 * 1000);
    every(bliz, 24 * 3600 * 1000);

    // Game data: items, realm status and the roster hourly; realm status every 5 minutes.
    let busy = false;
    const loop = (only) => async () => {
      if (busy) return;
      busy = true;
      try {
        for (const line of await gameRun({ only })) ctx.log.info(`Game data: ${line}`);
      } catch (e) { ctx.log.warn(`Game data failed: ${e.message}`); } finally { busy = false; }
    };
    later(loop(), 60 * 1000);
    every(loop(), 3600 * 1000);
    every(loop('realm'), 5 * 60 * 1000);
  }
}

module.exports = { register };
