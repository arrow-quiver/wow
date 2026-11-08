'use strict';
// Core: what the app is, who I am, my notification choices, the guild and its settings, and the members
// Guild Camp knows about. There are no accounts, invites or devices any more (docs/PIVOT.md).
//
//   GET  /api/meta                 → { app: 'guild-camp', version, guild: {name, faction}|null, blizzard, latest }
//   GET  /api/me                   → { user, guild|null, role|null, notifyPrefs, bnet: {characters, profile_at, note} }
//   PUT  /api/me/notifications     any of { cta, raids, notices, requests, bank, coach, drives } as booleans
//   GET  /api/guild                → { guild, memberCount, options: { wowheadGames } }
//   PUT  /api/guild/settings       partial update, each field with its own rule (below)
//   GET  /api/members              → { members: [...] } (me and the guildmates whose records reached me)
const { HttpError, str, num, bool, needGuild, guildJson, userJson, isOfficer, isOwner } = require('../http');
const { readPrefs, mergePrefs } = require('../events');
const identity = require('../identity');
const sharing = require('../sharing');
const { version } = require('../../../package.json');

// Which Wowhead database item tooltips use (old views/wowhead.js).
const WOWHEAD_GAMES = [
  { value: 'forever', label: 'WoW: Forever' },
  { value: 'retail', label: 'Retail' },
  { value: 'classic', label: 'Classic' },
];
const ROLE_ORDER = "CASE m.role WHEN 'owner' THEN 0 WHEN 'officer' THEN 1 ELSE 2 END";
const rankLabel = (max) => (max == null ? 'off'
  : max === 0 ? 'Guild Master only' : `Guild Master + ${max} rank${max === 1 ? '' : 's'} below`);
const relayLabel = (max) => (max === 0 ? 'the Guild Master' : `the Guild Master and the ${max} rank${max === 1 ? '' : 's'} below`);
const shortName = (battletag) => String(battletag || '').split('#')[0];
const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
// An in-game rank index (0–9) from a request, null for "off" / "nobody", NaN when it is neither.
const rankInput = (v) => {
  if (v === null || v === '') return null;
  const n = Number.isInteger(v) ? v : typeof v === 'string' && /^\d$/.test(v.trim()) ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 0 && n <= 9 ? n : NaN;
};

function register(app, ctx) {
  const { db, cfg } = ctx;
  const q = {
    memberCount: db.prepare('SELECT COUNT(*) AS n FROM memberships WHERE guild_id = ?'),
    setPrefs: db.prepare('UPDATE users SET notify_prefs = ? WHERE id = ?'),
    guild: db.prepare('SELECT * FROM guilds WHERE id = ?'),
    members: db.prepare(`SELECT u.id, u.bnet_id, u.battletag, m.role, m.joined_at, u.addon_version, u.app_version, u.last_sync_at,
        (SELECT COUNT(*) FROM characters c WHERE c.user_id = u.id AND c.guild_id = m.guild_id AND ${identity.notElsewhere('c')}) AS characters,
        (SELECT MIN(c.rank_index) FROM characters c WHERE c.user_id = u.id AND c.guild_id = m.guild_id) AS rank_index
      FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.guild_id = ? ORDER BY ${ROLE_ORDER}, u.battletag COLLATE NOCASE`),
    mains: db.prepare(`SELECT user_id, name, class, level, is_main FROM characters
      WHERE guild_id = ? AND user_id IS NOT NULL AND ${identity.notElsewhere()} ORDER BY ${identity.looseLast()}, is_main DESC, level DESC, name`),
    roles: db.prepare(`SELECT m.user_id, m.role, u.battletag,
        (SELECT MIN(c.rank_index) FROM characters c WHERE c.guild_id = m.guild_id AND c.user_id = m.user_id) AS best
      FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.guild_id = ?`),
  };

  const json = (row, role) => guildJson(row, { role, discordWebhook: cfg.discordWebhook });

  app.get('/api/meta', (req, res) => {
    const g = identity.currentGuild(db);
    res.json({
      app: 'guild-camp',
      version,
      guild: g ? { name: g.name, faction: g.faction } : null,
      blizzard: Boolean(cfg.bnetClientId && cfg.bnetClientSecret),
      latest: ctx.latest(),
    });
  });

  // ---- Me ----
  app.get('/api/me', (req, res) => {
    const role = req.guild ? req.guild.role : null;
    res.json({
      user: userJson(req.user),
      guild: json(req.guild, role),
      role,
      notifyPrefs: readPrefs(req.user.notify_prefs),
      // What Battle.net sign-in in the app read: how many WoW characters, when, and a plain note.
      bnet: identity.bnetSummary(db, req.user.id),
    });
  });

  app.put('/api/me/notifications', (req, res) => {
    const patch = req.body && typeof req.body.notifyPrefs === 'object' ? req.body.notifyPrefs : req.body;
    const prefs = mergePrefs(req.user.notify_prefs, patch);
    q.setPrefs.run(JSON.stringify(prefs), req.user.id);
    res.json({ notifyPrefs: prefs });
  });

  // ---- Guild info and settings ----
  app.get('/api/guild', needGuild, (req, res) => {
    res.json({
      guild: json(req.guild, req.guild.role),
      memberCount: q.memberCount.get(req.guild.id).n,
      options: { wowheadGames: WOWHEAD_GAMES },
    });
  });

  // Partial update. Everything is checked before anything is saved.
  //   wowhead_game, coach_enabled, coach_budget_usd   anyone (the tooltips, key and budget are the player's own)
  //   realm, game_guild                                officers (normally read from the game by itself)
  //   officer_rank_max, relay_rank_max                 the Guild Master only. Shared with the guild as one CFG
  //                                                    record (docs/SHARING.md §5, §10), edited on top of the stored
  //                                                    version; roles here follow at once. relay_rank_max is "who
  //                                                    passes on officer changes": null = officers only.
  // The Discord webhook is an app setting now (settings.discordWebhook), not a guild setting.
  app.put('/api/guild/settings', needGuild, (req, res) => {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const g = req.guild;
    const changes = [];

    if (has(b, 'discord_webhook')) {
      throw new HttpError(400, 'The Discord webhook is set in Settings now, on this computer only.');
    }

    if (has(b, 'wowhead_game')) {
      const game = WOWHEAD_GAMES.find((x) => x.value === b.wowhead_game);
      if (!game) throw new HttpError(400, 'Pick WoW: Forever, Retail or Classic for item tooltips.');
      changes.push({
        sql: 'UPDATE guilds SET wowhead_game = ? WHERE id = ?', args: [game.value],
        audit: ['Wowhead tooltips set', game.value],
        message: `Item tooltips now use Wowhead's ${game.value === 'forever' ? 'Forever' : game.label} database.`,
      });
    }

    if (has(b, 'realm') || has(b, 'game_guild')) {
      if (!isOfficer(req)) throw new HttpError(403, 'Only officers can change the realm and guild name.');
      const realm = has(b, 'realm') ? str(b.realm, 60) : g.realm || null;
      const gameGuild = has(b, 'game_guild') ? str(b.game_guild, 60) : g.game_guild || null;
      // A new realm or guild name makes the old realm status and official roster meaningless.
      changes.push({
        sql: 'UPDATE guilds SET realm = ?, game_guild = ?, realm_status = NULL, official_roster_at = NULL WHERE id = ?', args: [realm, gameGuild],
        audit: ['realm set', `${realm || '-'} / ${gameGuild || '-'}`],
        message: 'Realm saved. Use "Refresh now" to fetch realm status and the official roster.',
      });
    }

    if (has(b, 'coach_enabled') || has(b, 'coach_budget_usd')) {
      const enabled = has(b, 'coach_enabled') ? bool(b.coach_enabled) : Boolean(g.coach_enabled);
      let budget = g.coach_budget_usd ?? 15;
      if (has(b, 'coach_budget_usd')) {
        budget = num(b.coach_budget_usd, 0, 500);
        if (budget == null) throw new HttpError(400, 'Set a monthly Coach budget between $0 and $500.');
        budget = Math.round(budget * 100) / 100;
      }
      changes.push({
        sql: 'UPDATE guilds SET coach_enabled = ?, coach_budget_usd = ? WHERE id = ?', args: [enabled ? 1 : 0, budget],
        audit: ['coach settings', `${enabled ? 'on' : 'off'}, $${budget}/month`],
        message: 'Coach settings saved.',
      });
    }

    // Officer and relay ranks: one CFG record for the guild, from the Guild Master only. "Off" for officers
    // means the Guild Master alone (rank 0), which is how the record says it.
    let ranks = null;
    if (has(b, 'officer_rank_max') || has(b, 'relay_rank_max')) {
      if (!isOwner(req)) {
        throw new HttpError(403, has(b, 'officer_rank_max')
          ? 'Only the Guild Master can choose which ranks are officers.'
          : 'Only the Guild Master can choose who passes on officer changes.');
      }
      ranks = { officerRankMax: g.officer_rank_max == null ? 0 : g.officer_rank_max, relayRankMax: g.relay_rank_max ?? null };
      if (has(b, 'officer_rank_max')) {
        const max = rankInput(b.officer_rank_max);
        if (Number.isNaN(max)) throw new HttpError(400, 'Pick Off, or an in-game rank from 0 to 9, for officers.');
        ranks.officerRankMax = max == null ? 0 : max;
        changes.push({
          audit: ['officer ranks set', rankLabel(max)],
          message: max == null
            ? 'In-game ranks no longer make anyone an officer here.'
            : `Officers now follow in-game ranks: ${rankLabel(max)}.`,
        });
      }
      if (has(b, 'relay_rank_max')) {
        const max = rankInput(b.relay_rank_max);
        if (Number.isNaN(max)) throw new HttpError(400, 'Pick Nobody, or an in-game rank from 0 to 9, for who passes on officer changes.');
        ranks.relayRankMax = max;
        changes.push({
          audit: ['relay ranks set', rankLabel(max)],
          message: max == null
            ? 'Only officers pass on officer changes now.'
            : `Officer changes are also passed on by ${relayLabel(max)}.`,
        });
      }
    }

    if (!changes.length) throw new HttpError(400, 'Nothing to save.');
    const rolesBefore = new Map(q.roles.all(g.id).map((r) => [r.user_id, r.role]));
    db.transaction(() => {
      for (const c of changes) if (c.sql) db.prepare(c.sql).run(...c.args, g.id);
      // The record's projection sets the guild's ranks and moves roles to them at once.
      if (ranks) sharing.queue(db, ctx, { type: 'CFG', key: '1', fields: ranks, need: 'g', base: sharing.baseOf(db, g.id, 'CFG:1') });
    })();
    for (const c of changes) ctx.audit(req, c.audit[0], c.audit[1]);
    for (const r of q.roles.all(g.id)) {
      const was = rolesBefore.get(r.user_id);
      if (was && was !== r.role) ctx.audit(req, r.role === 'member' ? 'rank demote' : 'rank promote', `${r.battletag}: ${r.role}${r.best == null ? '' : ` (rank ${r.best})`}`);
    }
    const fresh = identity.myMembership(db);
    res.json({ guild: json(q.guild.get(g.id), fresh ? fresh.role : g.role), messages: changes.map((c) => c.message) });
  });

  // ---- Members (everyone Guild Camp knows plays in the guild: me, and guildmates who shared with me) ----
  app.get('/api/members', needGuild, (req, res) => {
    const mains = new Map();
    for (const c of q.mains.all(req.guild.id)) {
      if (!mains.has(c.user_id)) mains.set(c.user_id, { name: c.name, class: c.class, level: c.level, is_main: c.is_main });
    }
    const members = q.members.all(req.guild.id).map((m) => ({
      id: m.id,
      battletag: m.battletag,
      name: shortName(m.battletag),
      role: m.role,
      rank_index: m.rank_index ?? null,
      joined_at: m.joined_at,
      characters: m.characters,
      main: mains.get(m.id) || null,
      addon_version: m.addon_version,
      app_version: m.app_version,
      last_sync_at: m.last_sync_at,
      isMe: m.id === req.user.id,
    }));
    res.json({ members });
  });
}

module.exports = { register, WOWHEAD_GAMES };
