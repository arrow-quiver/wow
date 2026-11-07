// Core: create/join the guild, joining by itself (auto join), guild info and settings, invite link,
// members and roles. Shapes are documented in docs/api/core.md.
const A = require('../auth');
const {
  HttpError, str, int, num, bool, list, needUser, needGuild, needOfficer, guildJson,
} = require('../http');
const membership = require('../services/membership');

// Who joins without an invite link (guilds.auto_join), with the message shown after saving.
const AUTO_JOIN_MESSAGES = {
  roster: 'New members now join by themselves when their character is in the guild roster.',
  verified: 'New members now join by themselves only when Battle.net confirms their character.',
  off: 'New members now need an invite link.',
};
const rankLabel = (max) => (max == null ? 'off'
  : max === 0 ? 'Guild Master only' : `Guild Master + ${max} rank${max === 1 ? '' : 's'} below`);

// Which Wowhead database item tooltips use (old views/wowhead.js).
const WOWHEAD_GAMES = [
  { value: 'forever', label: 'WoW: Forever' },
  { value: 'retail', label: 'Retail' },
  { value: 'classic', label: 'Classic' },
];
const WEBHOOK_RE = /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\/[\w/-]+$/;
const ROLE_ORDER = "CASE m.role WHEN 'owner' THEN 0 WHEN 'officer' THEN 1 ELSE 2 END";

const shortName = (battletag) => String(battletag || '').split('#')[0];
// Accepts a bare code or a pasted link (https://…/join/<code>, guildcamp://join/<code>).
const inviteFrom = (v) => {
  const s = str(v, 300);
  if (!s) return null;
  const m = /\/join\/([\w-]+)/.exec(s);
  const code = m ? m[1] : s;
  return /^[\w-]{1,40}$/.test(code) ? code : null;
};
const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

function register(app, ctx) {
  const { db, cfg } = ctx;
  const q = {
    guildCount: db.prepare('SELECT COUNT(*) AS n FROM guilds'),
    guild: db.prepare('SELECT * FROM guilds WHERE id = ?'),
    byInvite: db.prepare('SELECT * FROM guilds WHERE invite_code = ?'),
    memberCount: db.prepare('SELECT COUNT(*) AS n FROM memberships WHERE guild_id = ?'),
    addGuild: db.prepare('INSERT INTO guilds (name, faction, invite_code, realm, game_guild) VALUES (?,?,?,?,?)'),
    addMember: db.prepare('INSERT OR IGNORE INTO memberships (user_id, guild_id, role) VALUES (?,?,?)'),
    deviceGuild: db.prepare('UPDATE devices SET guild_id = ? WHERE user_id = ?'),
    member: db.prepare('SELECT m.role, u.id, u.battletag FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.user_id = ? AND m.guild_id = ?'),
    // A role set by a person stays put: in-game ranks no longer change it (role_source 'manual').
    setRole: db.prepare("UPDATE memberships SET role = ?, role_source = 'manual' WHERE user_id = ? AND guild_id = ?"),
    removeMember: db.prepare('DELETE FROM memberships WHERE user_id = ? AND guild_id = ?'),
    removeKeys: db.prepare('DELETE FROM api_tokens WHERE user_id = ? AND guild_id = ?'),
    removeDevices: db.prepare('DELETE FROM devices WHERE user_id = ?'),
    unlinkChars: db.prepare('UPDATE characters SET user_id = NULL, is_main = 0 WHERE user_id = ? AND guild_id = ?'),
    // A removed member's Discord account stops acting for them (/cta, /signup), and a link code
    // made before the removal can't link it again.
    unlinkDiscord: db.prepare('UPDATE users SET discord_id = NULL WHERE id = ?'),
    dropLinkCodes: db.prepare('DELETE FROM link_codes WHERE user_id = ?'),
    resetInvite: db.prepare('UPDATE guilds SET invite_code = ? WHERE id = ?'),
    members: db.prepare(`SELECT u.id, u.battletag, m.role, m.joined_at, u.addon_version, u.app_version, u.companion_version,
        u.last_sync_at, u.discord_id,
        (SELECT COUNT(*) FROM characters c WHERE c.user_id = u.id AND c.guild_id = m.guild_id) AS characters,
        (SELECT COUNT(*) FROM devices d WHERE d.user_id = u.id) AS devices,
        (SELECT COUNT(*) FROM api_tokens t WHERE t.user_id = u.id AND t.guild_id = m.guild_id) AS sync_keys
      FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.guild_id = ? ORDER BY ${ROLE_ORDER}, u.battletag COLLATE NOCASE`),
    mains: db.prepare(`SELECT user_id, name, class, level, is_main FROM characters
      WHERE guild_id = ? AND user_id IS NOT NULL ORDER BY is_main DESC, level DESC, name`),
  };

  // The guild shape plus who joins by themselves and which in-game ranks are officers here.
  const withJoining = (json, row) => (json && row ? { ...json, auto_join: row.auto_join || 'roster', officer_rank_max: row.officer_rank_max ?? null } : json);
  const fullGuild = (guildId, role) => {
    const row = q.guild.get(guildId);
    return withJoining(guildJson(row, { role, baseUrl: cfg.baseUrl }), row);
  };

  // ---- Create (only while the server has no guild) ----
  // realm and game_guild (the in-game realm and guild name) come from the setup screen when the app
  // detected the player's guild; members whose characters are in that guild can then join by themselves.
  app.post('/api/guild', needUser, (req, res) => {
    if (req.guild) throw new HttpError(400, 'You are already in a guild.');
    const name = str(req.body.name, 40) || 'wow';
    const faction = req.body.faction === 'Alliance' ? 'Alliance' : 'Horde';
    const realm = str(req.body.realm, 60);
    const gameGuild = str(req.body.game_guild, 60);
    const guildId = db.transaction(() => {
      // Single-guild mode for now: once a guild exists, others join by invite or by themselves.
      if (q.guildCount.get().n > 0) throw new HttpError(409, 'This server already has a guild. Ask an officer for the invite link.');
      const id = Number(q.addGuild.run(name, faction, A.inviteCode(), realm, gameGuild).lastInsertRowid);
      q.addMember.run(req.user.id, id, 'owner');
      q.deviceGuild.run(id, req.user.id);
      ctx.activity(id, 'guild', `${shortName(req.user.battletag)} lit the campfire`);
      return id;
    })();
    ctx.audit({ guild: { id: guildId }, user: req.user }, 'guild created', name);
    res.status(201).json({ guild: fullGuild(guildId, 'owner'), role: 'owner' });
  });

  // ---- Invite preview (public) and join ----
  app.get('/api/guild/invite/:code', (req, res) => {
    const code = inviteFrom(req.params.code);
    const g = code && q.byInvite.get(code);
    if (!g) throw new HttpError(404, "That invite link doesn't work. Ask an officer for a fresh one.");
    res.json({ guild: { name: g.name, faction: g.faction, members: q.memberCount.get(g.id).n } });
  });

  app.post('/api/guild/join', needUser, (req, res) => {
    const code = inviteFrom(req.body.code);
    const g = code && q.byInvite.get(code);
    if (!g) throw new HttpError(404, "That invite link doesn't work. Ask an officer for a fresh one.");
    if (req.guild) {
      if (req.guild.id === g.id) return res.json({ guild: fullGuild(g.id, req.guild.role), role: req.guild.role });
      throw new HttpError(400, 'You are already in a guild.');
    }
    db.transaction(() => {
      q.addMember.run(req.user.id, g.id, 'member');
      q.deviceGuild.run(g.id, req.user.id);
      ctx.activity(g.id, 'member', `${shortName(req.user.battletag)} joined the camp`);
    })();
    res.json({ guild: fullGuild(g.id, 'member'), role: 'member' });
  });

  // ---- Joining by itself ----
  // The app sends the characters the addon saved; Battle.net characters (read at sign-in) count too.
  // Every outcome is a 200 with the result object (services/membership.js); 400 only for bad input.
  app.post('/api/guild/auto-join', needUser, (req, res) => {
    const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : null;
    if (!b) throw new HttpError(400, 'Send your characters as a list.');
    const raw = b.characters;
    if (raw != null && typeof raw !== 'object') throw new HttpError(400, 'Send your characters as a list.');
    // A list, or the addon's map keyed by name. cleanReported keeps at most 50, with capped strings.
    res.json(membership.tryAutoJoin(ctx, req.user, { reported: Array.isArray(raw) ? list(raw, 50) : raw || [] }));
  });

  // ---- Guild info and settings ----
  app.get('/api/guild', needGuild, (req, res) => {
    res.json({
      guild: withJoining(guildJson(req.guild, { role: req.guild.role, baseUrl: cfg.baseUrl }), req.guild),
      memberCount: q.memberCount.get(req.guild.id).n,
      options: { wowheadGames: WOWHEAD_GAMES },
    });
  });

  // Partial update. Any of: discord_webhook, wowhead_game, realm + game_guild, coach_enabled + coach_budget_usd,
  // auto_join, officer_rank_max. Everything is checked before anything is saved.
  app.put('/api/guild/settings', needOfficer, (req, res) => {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const g = req.guild;
    const changes = [];

    if (has(b, 'discord_webhook')) {
      const url = b.discord_webhook == null ? '' : String(b.discord_webhook).trim();
      if (url && (url.length > 300 || !WEBHOOK_RE.test(url))) throw new HttpError(400, "That isn't a Discord webhook URL.");
      changes.push({
        sql: 'UPDATE guilds SET discord_webhook = ? WHERE id = ?', args: [url || null],
        audit: [url ? 'Discord webhook set' : 'Discord webhook removed', ''],
        message: url ? 'Webhook saved.' : 'Webhook removed.',
      });
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

    if (has(b, 'auto_join')) {
      if (!membership.AUTO_JOIN_MODES.includes(b.auto_join)) throw new HttpError(400, 'Pick how new members join: roster, verified or off.');
      changes.push({
        sql: 'UPDATE guilds SET auto_join = ? WHERE id = ?', args: [b.auto_join],
        audit: ['auto join set', b.auto_join],
        message: AUTO_JOIN_MESSAGES[b.auto_join],
      });
    }

    let ranksChanged = false;
    if (has(b, 'officer_rank_max')) {
      const v = b.officer_rank_max;
      const max = v === null || v === '' ? null : Number.isInteger(v) ? v : (typeof v === 'string' && /^\d$/.test(v.trim()) ? Number(v) : NaN);
      if (max !== null && !(Number.isInteger(max) && max >= 0 && max <= 9)) throw new HttpError(400, 'Pick Off, or an in-game rank from 0 to 9, for officers.');
      ranksChanged = max !== (g.officer_rank_max ?? null);
      changes.push({
        sql: 'UPDATE guilds SET officer_rank_max = ? WHERE id = ?', args: [max],
        audit: ['officer ranks set', rankLabel(max)],
        message: max == null
          ? 'In-game ranks no longer make anyone an officer here.'
          : `Officers now follow in-game ranks: ${rankLabel(max)}.`,
      });
    }

    if (!changes.length) throw new HttpError(400, 'Nothing to save.');
    db.transaction(() => {
      for (const c of changes) db.prepare(c.sql).run(...c.args, g.id);
    })();
    for (const c of changes) ctx.audit(req, c.audit[0], c.audit[1]);
    // Members who follow in-game ranks get their officer role from the new setting at once.
    if (ranksChanged) membership.syncRanks(ctx, g.id, req.user);
    res.json({ guild: fullGuild(g.id, g.role), messages: changes.map((c) => c.message) });
  });

  app.post('/api/guild/invite/reset', needOfficer, (req, res) => {
    const code = A.inviteCode();
    q.resetInvite.run(code, req.guild.id);
    ctx.audit(req, 'invite link replaced');
    res.json({
      invite_code: code,
      inviteUrl: `${cfg.baseUrl}/join/${encodeURIComponent(code)}`,
      message: 'New invite link made. The old one no longer works.',
    });
  });

  // ---- Members ----
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
      joined_at: m.joined_at,
      characters: m.characters,
      main: mains.get(m.id) || null,
      addon_version: m.addon_version,
      app_version: m.app_version,
      companion_version: m.companion_version,
      last_sync_at: m.last_sync_at,
      discord_linked: Boolean(m.discord_id),
      devices: m.devices,
      sync_keys: m.sync_keys,
    }));
    res.json({ members });
  });

  const target = (req) => {
    const id = int(req.params.id, 1);
    const m = id && q.member.get(id, req.guild.id);
    if (!m) throw new HttpError(404, "That person isn't in the guild.");
    return m;
  };

  // Officers may promote members.
  app.post('/api/members/:id/promote', needOfficer, (req, res) => {
    const m = target(req);
    if (m.role !== 'member') throw new HttpError(400, 'Only members can be promoted.');
    q.setRole.run('officer', m.id, req.guild.id);
    ctx.audit(req, 'promoted to officer', m.battletag);
    res.json({ ok: true, member: { id: m.id, role: 'officer' }, message: `${shortName(m.battletag)} is now an officer.` });
  });

  // Only the owner may demote officers.
  app.post('/api/members/:id/demote', needOfficer, (req, res) => {
    if (req.guild.role !== 'owner') throw new HttpError(403, 'Only the guild owner can demote officers.');
    const m = target(req);
    if (m.role !== 'officer') throw new HttpError(400, 'Only officers can be demoted.');
    q.setRole.run('member', m.id, req.guild.id);
    ctx.audit(req, 'demoted to member', m.battletag);
    res.json({ ok: true, member: { id: m.id, role: 'member' }, message: `${shortName(m.battletag)} is now a member.` });
  });

  // Officers may remove members; only the owner may remove officers; nobody can remove the owner.
  // Removing signs out all their devices, kills their old sync keys and unlinks their Discord account.
  app.post('/api/members/:id/remove', needOfficer, (req, res) => {
    const m = target(req);
    if (m.role === 'owner') throw new HttpError(403, 'Nobody can remove the guild owner.');
    if (m.id === req.user.id) throw new HttpError(400, "You can't remove yourself.");
    if (m.role === 'officer' && req.guild.role !== 'owner') throw new HttpError(403, 'Only the guild owner can remove officers.');
    db.transaction(() => {
      q.removeMember.run(m.id, req.guild.id);
      q.removeKeys.run(m.id, req.guild.id);
      q.removeDevices.run(m.id);
      q.unlinkChars.run(m.id, req.guild.id);
      q.unlinkDiscord.run(m.id);
      q.dropLinkCodes.run(m.id);
    })();
    ctx.audit(req, 'removed from guild', m.battletag);
    res.json({ ok: true, member: { id: m.id, role: null }, message: `${shortName(m.battletag)} was removed. Their devices are signed out.` });
  });
}

module.exports = { register, WOWHEAD_GAMES };
