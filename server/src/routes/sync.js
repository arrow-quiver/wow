// Sync: the desktop app (or an old companion) uploads the addon's saved data, and fetches the
// guild news the addon shows in game. Shapes are documented in docs/api/sync.md.
//
//   POST /api/sync        WowGuildDB as JSON (+ Auctionator prices) → counts + latest releases
//   GET  /api/inbox       the news for WowGuild_Inbox/Inbox.lua, as JSON
//   GET  /api/inbox.lua   the same news as Lua source, for old companions that save it as-is
//
// Auth: a device token (gcd_…) of a guild member, or an old companion sync key (wowg_…). app.js only
// accepts sync keys on these three paths, and only while the key's owner is still in the guild.
// POST /api/sync also takes a signed-in member who isn't in the guild yet: when the upload's characters
// match the guild roster they join (services/membership.js) and the upload is stored; otherwise 409.
const { HttpError, needUser, needGuild, ver } = require('../http');
const { applyPayload, buildInbox, toLua } = require('../services/sync');
const coach = require('../services/coach');
const membership = require('../services/membership');

const shortName = (battletag) => String(battletag || '').split('#')[0];

function register(app, ctx) {
  const { db, cfg } = ctx;
  // The Coach only counts "a plan is wanted" as pending when the server can make plans (has a
  // Claude key). routes/coach.js sets this too; it is a module-level switch, so the same value.
  coach.setKeyPresent(cfg.anthropicKey);

  const q = {
    log: db.prepare('INSERT INTO sync_log (guild_id, user_id, bytes) VALUES (?,?,?)'),
    user: db.prepare(`UPDATE users SET addon_version = COALESCE(?, addon_version), companion_version = COALESCE(?, companion_version),
      last_sync_at = datetime('now') WHERE id = ?`),
    device: db.prepare('UPDATE devices SET addon_version = COALESCE(?, addon_version) WHERE id = ?'),
    // Same lookup as the bearer middleware in app.js, for a member who joined during this upload.
    membership: db.prepare('SELECT g.*, m.role FROM memberships m JOIN guilds g ON g.id = m.guild_id WHERE m.user_id = ? ORDER BY m.joined_at, m.guild_id LIMIT 1'),
  };

  // What the addon gets back: the guild news, plus the newest addon version (so it can tell the
  // player to update from the app) and the server's address.
  function inboxFor(req) {
    const latest = ctx.latest() || {};
    return {
      ...buildInbox(db, req.guild.id, req.user.id),
      latestAddon: (latest.addon && latest.addon.version) || null,
      site: cfg.baseUrl,
    };
  }

  app.post('/api/sync', needUser, async (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'The upload must be a JSON object with the addon\'s data.');

    // Signed in but not in the guild yet: the characters in this upload may match the guild roster.
    // No match → 409 and nothing is stored; the app waits and tries again later.
    let joined = null;
    if (!req.guild) {
      const result = membership.tryAutoJoin(ctx, req.user, { reported: body.characters });
      if (result.status !== 'joined' && result.status !== 'already') {
        return res.status(409).json({ error: result.reason, code: 'NO_GUILD_MATCH', autoJoin: result });
      }
      req.guild = q.membership.get(req.user.id) || null;
      if (!req.guild) return res.status(409).json({ error: result.reason, code: 'NO_GUILD_MATCH', autoJoin: result });
      if (result.status === 'joined') joined = { guild: result.guild, role: result.role, via: result.via, character: result.character };
    }

    const guildId = req.guild.id;
    const userId = req.user.id;
    const trusted = req.guild.role === 'owner' || req.guild.role === 'officer';
    // Throws 400 when the body isn't an object. Everything is written in one transaction.
    const stats = applyPayload(db, guildId, userId, body, { trustedRanks: trusted });
    // An owner's or officer's roster scan carries in-game ranks: officer roles follow them.
    if (stats.rankScan) membership.syncRanks(ctx, guildId, req.user);

    q.log.run(guildId, userId, Number(req.get('Content-Length')) || 0);
    const addonVersion = ver(body.addonVersion);
    // Old companions report their own version; the app's version comes from X-App-Version (app.js).
    const companionVersion = req.legacyKey ? ver(req.get('X-Companion-Version')) : null;
    q.user.run(addonVersion, companionVersion, userId);
    if (req.device) q.device.run(addonVersion, req.device.id);

    // Calls to arms sent from the game with /wow cta. A re-upload of the same queue adds nothing,
    // so these only fire once per call. Same wording as the old site; a call without a message
    // just skips that line.
    for (const c of stats.ctas) {
      const message = String(c.message || '').trim();
      await ctx.discord(req.guild, [
        `⚔️ **Call to arms: ${c.zone}**${c.needed ? ` (need ${c.needed})` : ''}`,
        message,
        `— ${c.character || 'someone'} (from in game)`,
      ].filter(Boolean).join('\n'));
      ctx.emit(guildId, 'cta', {
        title: `⚔️ Call to arms: ${c.zone}`,
        body: [c.needed ? `Need ${c.needed}.` : '', message, `(${c.character || 'from in game'})`].filter(Boolean).join(' '),
        route: '/',
        exceptUserId: userId,
      });
    }

    // Questions asked in game, or a build plan wanted: start the Coach now. The app then keeps
    // checking GET /api/inbox until coachPending is 0. Without a Claude key the Coach still runs
    // for new questions, so the player gets a clear "not set up" answer instead of silence.
    const coachPending = coach.inboxPart(db, guildId, userId).pending;
    const asked = Boolean(stats.coach && stats.coach.questions);
    if ((coachPending && cfg.anthropicKey) || asked) {
      const svc = ctx.services.coach;
      if (svc && typeof svc.kick === 'function') {
        try { svc.kick(); } catch (e) { ctx.log.warn(`Coach kick failed for ${shortName(req.user.battletag)}:`, e.message); }
      }
    }

    res.json({
      ok: true,
      characters: stats.characters,
      roster: stats.roster,
      recipes: stats.recipes,
      ctas: stats.ctas.length,
      inventory: stats.inventory,
      bank: stats.bank,
      prices: stats.prices,
      coachPending,
      latest: ctx.latest(),
      ...(joined ? { joined } : {}),
    });
  });

  app.get('/api/inbox', needGuild, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(inboxFor(req));
  });

  // Old companions download this and save it as WowGuild_Inbox/Inbox.lua unchanged.
  app.get('/api/inbox.lua', needGuild, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.type('text/plain').send(`-- Written by Guild Camp. Do not edit.\nWowGuildInbox = ${toLua(inboxFor(req))}\n`);
  });
}

module.exports = { register };
