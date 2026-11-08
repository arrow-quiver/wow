'use strict';
// Sync: the app's sync engine (src/main/sync.js) uploads the addon's saved data, and fetches the guild
// news the addon shows in game. Shapes are documented in docs/api/sync.md.
//
//   POST /api/sync    WowGuildDB as JSON (+ Auctionator prices) → counts + latest versions
//   GET  /api/inbox   the news for WowGuild_Inbox/Inbox.lua, as JSON
//   POST /api/sync/roster-guild  { name } → { ok, guild, created }: the player accepts the roster's guild
//
// A guildless upload whose roster scan names a guild replies with `rosterGuild: { name, realm }` too; the
// app asks the player before that guild is set up.
// The guild comes from the upload itself: the most recently played character that has a guild decides
// which guild is current (identity.selectGuild creates it locally the first time). An upload with no
// character in a guild is accepted and stores nothing; the reply says so in plain words (`noGuild`).
// Roles follow the in-game ranks of the roster rows the upload brought (identity.syncRanks).
const { HttpError, ver } = require('../http');
const { applyPayload, buildInbox, emptyInbox } = require('../services/sync');
const coach = require('../services/coach');
const identity = require('../identity');

const NO_GUILD_UPLOAD = 'None of your characters is in a guild yet. Guild Camp starts working as soon as you log in to a character in your guild.';
// The guild the last guildless upload's roster scan named (identity.rosterGuildFromPayload), waiting for the
// player's yes (POST /api/sync/roster-guild). Cleared by any upload that has a guild.
const OFFER_KEY = 'roster_guild_offer';
const rosterGuildMessage = (o) => `None of your characters has a guild saved, but your last guild roster scan was for ${o.name}${o.realm ? ` on ${o.realm}` : ''}.`;

function register(app, ctx) {
  const { db, cfg } = ctx;
  coach.setKeyPresent(() => Boolean(cfg.anthropicKey));

  const q = {
    log: db.prepare('INSERT INTO sync_log (guild_id, user_id, bytes) VALUES (?,?,?)'),
    user: db.prepare(`UPDATE users SET addon_version = COALESCE(?, addon_version), last_sync_at = datetime('now') WHERE id = ?`),
  };

  // What the addon gets back: the guild news, plus the newest addon version (so it can tell the
  // player to update from the app).
  function inboxFor(req) {
    const latest = ctx.latest() || {};
    const news = req.guild ? buildInbox(db, req.guild.id, req.user.id, { ctx }) : emptyInbox();
    return { ...news, latestAddon: (latest.addon && latest.addon.version) || null };
  }

  app.post('/api/sync', async (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'The upload must be a JSON object with the addon\'s data.');

    const addonVersion = ver(body.addonVersion);
    const wanted = identity.guildFromPayload(body);
    // No character says which guild. The roster scan may still name one: when it isn't the current guild (or
    // there is none yet), nothing is stored in the wrong guild; the offer is kept and the app asks the player.
    const offer = wanted ? null : identity.rosterGuildFromPayload(body);
    const otherGuild = Boolean(offer && req.guild
      && identity.guildKey(req.guild.game_guild || req.guild.name) !== identity.guildKey(offer.name));
    if (!wanted && (!req.guild || otherGuild)) {
      q.user.run(addonVersion, req.user.id);
      // The player chose their guild in Settings: a save from another guild is skipped, nothing is offered.
      if (otherGuild && identity.pinnedGuild(db)) {
        identity.setSetting(db, OFFER_KEY, null);
        return res.json({
          ok: true, noGuild: true, message: `Skipped a save from ${offer.name}: you chose ${req.guild.game_guild || req.guild.name} in Settings.`,
          characters: 0, roster: 0, recipes: 0, ctas: 0, inventory: 0, bank: 0, prices: 0, coachPending: 0,
          latest: ctx.latest(),
        });
      }
      identity.setSetting(db, OFFER_KEY, offer ? JSON.stringify(offer) : null);
      return res.json({
        ok: true, noGuild: true, message: offer ? rosterGuildMessage(offer) : NO_GUILD_UPLOAD,
        ...(offer ? { rosterGuild: { name: offer.name, realm: offer.realm } } : {}),
        characters: 0, roster: 0, recipes: 0, ctas: 0, inventory: 0, bank: 0, prices: 0, coachPending: 0,
        latest: ctx.latest(),
      });
    }

    identity.setSetting(db, OFFER_KEY, null);
    let switched = null;
    if (wanted) {
      const pick = identity.selectGuild(db, wanted);
      if (pick.created) ctx.log.info(`Guild Camp set up ${pick.guild.name}${pick.guild.realm ? ` on ${pick.guild.realm}` : ''}.`);
      if (pick.created || pick.switched) switched = { id: pick.guild.id, name: pick.guild.name, faction: pick.guild.faction, created: pick.created };
    }
    req.guild = identity.myMembership(db);
    const guildId = req.guild.id;
    const userId = req.user.id;

    // Throws 400 when the body isn't an object. Everything is written in one transaction.
    const stats = applyPayload(db, guildId, userId, body, { trustedRanks: true, ctx });
    // The roster scan carries in-game ranks: roles follow them. My name follows my main character
    // until Battle.net tells Guild Camp my BattleTag.
    identity.syncRanks(db, guildId, { audit: (action, detail) => ctx.audit({ guild: req.guild, user: req.user }, action, detail) });
    identity.refreshMyName(db);
    req.guild = identity.myMembership(db);

    q.log.run(guildId, userId, Number(req.get('Content-Length')) || 0);
    q.user.run(addonVersion, userId);

    // Calls to arms sent from the game with /wow cta. A re-upload of the same queue adds nothing,
    // so these only fire once per call. A call without a message just skips that line.
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
    // checking GET /api/inbox until coachPending is 0. Without a key the Coach still runs for new
    // questions, so the player gets a clear "add your key" answer instead of silence.
    const coachPending = coach.inboxPart(db, guildId, userId).pending;
    const asked = Boolean(stats.coach && stats.coach.questions);
    if ((coachPending && cfg.anthropicKey) || asked) {
      const svc = ctx.services.coach;
      if (svc && typeof svc.kick === 'function') {
        try { svc.kick(); } catch (e) { ctx.log.warn('Coach kick failed:', e.message); }
      }
    }

    res.json({
      ok: true,
      guild: { id: guildId, name: req.guild.name, faction: req.guild.faction, role: req.guild.role },
      characters: stats.characters,
      roster: stats.roster,
      recipes: stats.recipes,
      ctas: stats.ctas.length,
      inventory: stats.inventory,
      bank: stats.bank,
      prices: stats.prices,
      coachPending,
      latest: ctx.latest(),
      ...(switched ? { switched } : {}),
    });
  });

  // The player said yes to the guild their roster scan named. `name` must match the stored offer, so only
  // a guild the game itself reported can be set up this way. The app syncs again right after.
  app.post('/api/sync/roster-guild', (req, res) => {
    let offer = null;
    try { offer = JSON.parse(identity.getSetting(db, OFFER_KEY) || 'null'); } catch { offer = null; }
    const name = req.body && typeof req.body.name === 'string' ? req.body.name.trim() : '';
    if (!offer || !offer.name || identity.guildKey(offer.name) !== identity.guildKey(name)) {
      throw new HttpError(409, 'That guild is no longer on offer. Log in to a character in your guild, then log out or type /reload.');
    }
    const pick = identity.selectGuild(db, { ...offer, updated: Math.max(offer.updated || 0, Math.floor(Date.now() / 1000)), force: true });
    identity.setSetting(db, OFFER_KEY, null);
    if (pick.created) ctx.log.info(`Guild Camp set up ${pick.guild.name}${pick.guild.realm ? ` on ${pick.guild.realm}` : ''} from the roster scan.`);
    res.json({ ok: true, guild: { id: pick.guild.id, name: pick.guild.name, faction: pick.guild.faction }, created: pick.created });
  });

  app.get('/api/inbox', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(inboxFor(req));
  });
}

module.exports = { register, NO_GUILD_UPLOAD };
