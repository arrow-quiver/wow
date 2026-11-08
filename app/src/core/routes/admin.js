'use strict';
// Officer tools: sync health (what this computer knows about members' last syncs and versions), local
// backups of guildcamp.db, the audit log, fresh start, Blizzard API and game data status, AI usage. Also
// runs the background jobs: the daily backup check, the daily Blizzard API check, game data hourly and
// realm status every 5 minutes. Ported from the old server's routes/admin.js. Shapes: docs/api/admin.md.
//
//   GET  /api/admin                     everything on the Officer tools page (officer)
//   GET  /api/admin/audit?before=&limit= more of the audit log (officer)
//   GET  /api/admin/status              Blizzard, game data and AI usage (officer)
//   POST /api/admin/backups             make a backup now → { backup: { file, path, size, created }, backups }
//   POST /api/admin/reset {confirm}     fresh start (Guild Master): wipes game data in the local database; guild
//                                       data shared in game comes back with the next upload (services/reset.js)
//   POST /api/admin/blizzard            check Blizzard's API now (officer)
//   POST /api/admin/gamedata/refresh    realm status and the official roster now (officer)
// Backups live in <dataDir>/backups; the app reveals one in the folder with app.showItemInFolder(path).
const path = require('path');
const { HttpError, int, needOfficer, isOwner } = require('../http');
const backup = require('../services/backup');
const { notElsewhere } = require('../identity');
const { resetGuild } = require('../services/reset');
const blizzard = require('../services/blizzard');
const gamedata = require('../services/gamedata');
const ai = require('../services/ai');
const coach = require('../services/coach');
const version = require('../../shared/version');

const DAY_MS = 86400000;
const STALE_DAYS = 7; // sync health: a member who hasn't synced for a week is flagged
const AUDIT_PAGE = 50;
const AUDIT_MAX = 200;
const BACKUP_KEEP = 14; // what the daily job keeps (services/backup.js runBackup default)
const NO_BNET_APP = 'Blizzard game data is off: this copy of Guild Camp has no Battle.net app built in.';

const shortName = (battletag) => String(battletag || '').split('#')[0];
// SQLite datetime('now') text is UTC without a zone marker; ISO strings pass through.
const timeMs = (t) => {
  if (!t) return NaN;
  const s = String(t);
  return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(' ', 'T')}Z`);
};

function register(app, ctx) {
  const { db, cfg } = ctx;
  // Backups need a database file; an in-memory database (tests) has nowhere to copy from.
  const backupsEnabled = Boolean(cfg.dbFile && cfg.dbFile !== ':memory:');
  const backupDir = backupsEnabled ? backup.backupDir(cfg.dbFile) : null;

  const q = {
    members: db.prepare(`SELECT u.id, u.battletag, u.addon_version, u.app_version, u.last_sync_at, m.role, m.joined_at,
        (SELECT COUNT(*) FROM characters c WHERE c.user_id = u.id AND c.guild_id = m.guild_id AND ${notElsewhere('c')}) AS characters
      FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.guild_id = ? ORDER BY u.last_sync_at IS NULL, u.last_sync_at DESC, u.battletag COLLATE NOCASE`),
    // The roster as this computer last saw it: when each character was online, and the addon version
    // a character reported (only my own characters for now; guildmates' arrive with the sharing wave).
    roster: db.prepare(`SELECT c.name, c.class, c.level, c.rank, c.rank_index, c.online, c.last_seen, c.user_id, c.extras
      FROM characters c WHERE c.guild_id = ? AND (c.rank IS NOT NULL OR c.user_id IS NOT NULL) AND ${notElsewhere('c')}
      ORDER BY c.online DESC, c.last_seen IS NULL, c.last_seen DESC, c.name`),
    audit: db.prepare(`SELECT a.id, a.user_id, a.action, a.detail, a.created_at, u.battletag
      FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
      WHERE a.guild_id = ? AND a.id < ? ORDER BY a.id DESC LIMIT ?`),
    guild: db.prepare('SELECT * FROM guilds WHERE id = ?'),
    itemsKnown: db.prepare('SELECT COUNT(*) AS n FROM item_info WHERE found = 1'),
    officialRoster: db.prepare('SELECT COUNT(*) AS n FROM characters WHERE guild_id = ? AND in_official_roster = 1'),
  };

  // ---------- views ----------

  const latestVersions = () => {
    const latest = ctx.latest();
    return {
      app: (latest && latest.app && latest.app.version) || null,
      addon: (latest && latest.addon && latest.addon.version) || null,
    };
  };

  // A member is outdated when they report a version and it is older than the newest release.
  const outdated = (v, newest) => Boolean(v && newest && version.valid(v) && version.valid(newest) && version.lt(v, newest));

  function syncHealth(guildId, latest, meId) {
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
        last_sync_at: m.last_sync_at ?? null,
        addon_version: m.addon_version ?? null,
        app_version: m.app_version ?? null,
        addonOutdated: outdated(m.addon_version, latest.addon),
        appOutdated: outdated(m.app_version, latest.app),
        neverSynced: !m.last_sync_at,
        stale: Boolean(m.last_sync_at) && (!Number.isFinite(synced) || now - synced > STALE_DAYS * DAY_MS),
        isMe: m.id === meId,
      };
    });
  }

  function rosterHealth(guildId, latest, meId) {
    return q.roster.all(guildId).map((c) => {
      let extras = null;
      try { extras = c.extras ? JSON.parse(c.extras) : null; } catch { extras = null; }
      const addonVersion = extras && typeof extras.addonVersion === 'string' ? extras.addonVersion : null;
      return {
        name: c.name, class: c.class, level: c.level, rank: c.rank ?? null, rank_index: c.rank_index ?? null,
        online: c.online, last_seen: c.last_seen ?? null, mine: c.user_id === meId,
        addon_version: addonVersion, addonOutdated: outdated(addonVersion, latest.addon),
      };
    });
  }

  function backupList() {
    if (!backupsEnabled) return [];
    return backup.listBackups(backupDir).map((b) => ({ file: b.file, path: b.path, size: b.bytes, created: b.at }));
  }

  // One page of the audit log, newest first. `before` is the id to continue from (exclusive).
  function auditPage(guildId, before, limit = AUDIT_PAGE) {
    const rows = q.audit.all(guildId, before || Number.MAX_SAFE_INTEGER, limit + 1);
    const more = rows.length > limit;
    const entries = rows.slice(0, limit).map((a) => ({
      id: a.id,
      user_id: a.user_id ?? null,
      battletag: a.battletag ?? null,
      name: a.battletag ? shortName(a.battletag) : 'Guild Camp',
      action: a.action,
      detail: a.detail || null,
      created_at: a.created_at,
    }));
    return { entries, nextBefore: more && entries.length ? entries[entries.length - 1].id : null };
  }

  const blizzardView = () => ({
    configured: Boolean(cfg.bnetClientId && cfg.bnetClientSecret),
    region: cfg.bnetRegion || 'eu',
    note: cfg.bnetClientId && cfg.bnetClientSecret ? null : NO_BNET_APP,
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
    if (!backupsEnabled) throw new HttpError(409, 'Backups need a database file, and this one is kept in memory.');
    return backup.runBackup(db, backupDir, { keep: BACKUP_KEEP });
  }

  // Blizzard's Game Data API: what's reachable and whether a Forever namespace exists yet.
  async function checkBlizzard() {
    const status = await blizzard.check(cfg);
    blizzard.save(db, status);
    return status;
  }

  // One game data pass; realm-up notifications go out as 'notice' events. Rank changes from the
  // official roster are applied to roles inside gamedata.applyRoster.
  const gameRun = (opts = {}) => gamedata.run(db, cfg, { notify: (gid, kind, o) => ctx.emit(gid, kind, o), ...opts });

  ctx.services.admin = { backupNow, checkBlizzard, gameRun, syncHealth, auditPage, backupList };

  // ---------- routes ----------

  app.get('/api/admin', needOfficer, (req, res) => {
    const before = req.query.before === undefined ? null : int(req.query.before, 1);
    if (req.query.before !== undefined && before == null) throw new HttpError(400, 'The audit log cursor must be a number.');
    const gid = req.guild.id;
    const latest = latestVersions();
    res.json({
      isOwner: isOwner(req),
      latest,
      members: syncHealth(gid, latest, req.user.id),
      roster: rosterHealth(gid, latest, req.user.id),
      // What this computer knows. Guildmates' versions and syncs arrive once they share them in game.
      knownLocally: true,
      backupsEnabled,
      backupDir,
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

  // ---- backups (of this computer's database) ----
  app.post('/api/admin/backups', needOfficer, (req, res) => {
    let file;
    try {
      file = backupNow();
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(500, `The backup didn't work: ${e.message}`);
    }
    const name = path.basename(file);
    ctx.audit(req, 'backup made', name);
    const list = backupList();
    res.json({ ok: true, backup: list.find((b) => b.file === name) || { file: name, path: file, size: null, created: null }, backups: list, message: 'Backup made.' });
  });

  // ---- fresh start (Guild Master): wipe game data on this computer, keep people, settings and unsent changes.
  // A backup is made first. Guild data shared in game comes back from the addon with the next upload. ----
  app.post('/api/admin/reset', needOfficer, (req, res) => {
    if (!isOwner(req)) throw new HttpError(403, 'Only the Guild Master can wipe the game data on this PC.');
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
    // Roles stay as they were (in-game ranks didn't change); the next sync brings the roster back.
    const rows = Object.values(r.removed).reduce((a, b) => a + b, 0);
    const kept = r.backup ? path.basename(r.backup) : null;
    ctx.audit(req, 'wiped guild data for a fresh start', `${rows} rows${kept ? `, backup ${kept}` : ''}`);
    res.json({
      ok: true,
      rows,
      removed: r.removed,
      backup: kept,
      message: `Fresh start done: ${rows} rows of game data removed from this PC${kept ? ` (backup ${kept} kept)` : ''}. `
        + 'People, settings and your unsent changes stay. Guild data shared in game comes back after you log out or type /reload.',
    });
  });

  // ---- Blizzard API check ----
  app.post('/api/admin/blizzard', needOfficer, async (req, res) => {
    try {
      await checkBlizzard();
    } catch (e) {
      throw new HttpError(502, `The Blizzard API check didn't work: ${e.message}`);
    }
    res.json({ ok: true, blizzard: blizzardView(), gameData: gameDataView(req.guild.id), message: 'Blizzard API checked.' });
  });

  // ---- game data: realm status and the official roster, right now ----
  app.post('/api/admin/gamedata/refresh', needOfficer, async (req, res) => {
    const view = gameDataView(req.guild.id);
    let message;
    let lines = [];
    if (!(cfg.bnetClientId && cfg.bnetClientSecret)) {
      message = `${NO_BNET_APP} There is nothing to refresh.`;
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

    // Daily database backups into <dataDir>/backups (the last 14 kept), checked hourly.
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

    // Blizzard's API and game data only run with the Battle.net app built into the installer.
    if (cfg.bnetClientId && cfg.bnetClientSecret) {
      const bliz = async () => {
        try {
          const s = await checkBlizzard();
          ctx.log.info(`Blizzard API: ${s.ok ? 'reachable' : 'not reachable'}, Forever namespace: ${s.forever || 'not yet'}`);
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
}

module.exports = { register };
