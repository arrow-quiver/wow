// Community: the Camp dashboard (who's online, calls to arms, notices, activity, onboarding, upcoming raids),
// the roster, character pages and mains, crafters and shopping lists, crafting requests, and leveling partners.
// Ported from the old web/src/server.js. Shapes are documented in docs/api/community.md.
const { HttpError, str, int, parseJson, needGuild, needOfficer, isOfficer } = require('../http');
const C = require('../services/community');

const shortName = (battletag) => String(battletag || '').split('#')[0];
const CTA_WINDOW = "datetime('now','-1 day')";
// Requests that are finished stay on the board this long.
const REQUEST_DONE_DAYS = 7;
// Leveling-partner posts expire after this many days.
const PARTNER_DAYS = 3;

function register(app, ctx) {
  const { db, cfg } = ctx;
  ctx.services.community = C;

  const q = {
    online: db.prepare(`SELECT c.id, c.name, c.class, c.race, c.level, c.zone, c.rank, c.is_main, c.user_id, u.battletag
      FROM characters c LEFT JOIN users u ON u.id = c.user_id
      WHERE c.guild_id = ? AND c.online = 1 ORDER BY c.level DESC, c.name`),
    ctas: db.prepare(`SELECT c.id, c.zone, c.needed, c.message, c.character, c.source, c.created_at, c.user_id, u.battletag,
        (SELECT ch.class FROM characters ch WHERE ch.guild_id = c.guild_id AND ch.name = c.character) AS class
      FROM ctas c JOIN users u ON u.id = c.user_id
      WHERE c.guild_id = ? AND c.created_at > ${CTA_WINDOW} ORDER BY c.id DESC LIMIT 8`),
    announcements: db.prepare(`SELECT a.id, a.body, a.user_id, a.created_at, u.battletag FROM announcements a
      JOIN users u ON u.id = a.user_id WHERE a.guild_id = ? ORDER BY a.id DESC LIMIT 5`),
    announcement: db.prepare(`SELECT a.id, a.body, a.user_id, a.created_at, u.battletag FROM announcements a
      JOIN users u ON u.id = a.user_id WHERE a.id = ? AND a.guild_id = ?`),
    addAnnouncement: db.prepare('INSERT INTO announcements (guild_id, user_id, body) VALUES (?,?,?)'),
    delAnnouncement: db.prepare('DELETE FROM announcements WHERE id = ? AND guild_id = ?'),
    activity: db.prepare('SELECT id, kind, text, created_at FROM activity WHERE guild_id = ? AND id < ? ORDER BY id DESC LIMIT ?'),
    mySync: db.prepare('SELECT MAX(received_at) AS t FROM sync_log WHERE guild_id = ? AND user_id = ?'),
    // The character a call to arms is signed with (old rule: the main, else the highest level).
    main: db.prepare(`SELECT name, class, level, zone FROM characters WHERE guild_id = ? AND user_id = ?
      ORDER BY is_main DESC, level DESC LIMIT 1`),
    // "Use my last zone": the zone of whichever of my characters was seen most recently.
    lastZone: db.prepare(`SELECT name, zone FROM characters WHERE guild_id = ? AND user_id = ? AND zone IS NOT NULL AND zone != ''
      ORDER BY last_seen IS NULL, last_seen DESC, updated_at DESC LIMIT 1`),
    raids: db.prepare(`SELECT r.id, r.kind, r.title, r.instance, r.starts_at, r.status, r.size,
        s.status AS my_status, s.role AS my_role, s.character AS my_character,
        (SELECT COUNT(*) FROM signups x WHERE x.raid_id = r.id AND x.status = 'yes') AS coming,
        (SELECT COUNT(*) FROM signups x WHERE x.raid_id = r.id AND x.status = 'tentative') AS maybe
      FROM raids r LEFT JOIN signups s ON s.raid_id = r.id AND s.user_id = ?
      WHERE r.guild_id = ? AND r.status IN ('open','locked') AND r.starts_at > ? ORDER BY r.starts_at LIMIT 4`),
    addCta: db.prepare("INSERT INTO ctas (guild_id, user_id, character, zone, message, needed, source) VALUES (?,?,?,?,?,?, 'app')"),
    cta: db.prepare('SELECT id, zone, needed, message, character, source, created_at, user_id FROM ctas WHERE id = ?'),

    roster: db.prepare(`SELECT c.id, c.name, c.class, c.race, c.level, c.rank, c.zone, c.online, c.last_seen, c.is_main,
        c.is_bank, c.in_official_roster, c.user_id, c.updated_at, u.battletag
      FROM characters c LEFT JOIN users u ON u.id = c.user_id
      WHERE c.guild_id = ? ORDER BY c.online DESC, c.level DESC, c.name`),
    charExact: db.prepare('SELECT * FROM characters WHERE guild_id = ? AND name = ?'),
    charNoCase: db.prepare('SELECT * FROM characters WHERE guild_id = ? AND name = ? COLLATE NOCASE ORDER BY id LIMIT 1'),
    battletag: db.prepare('SELECT battletag FROM users WHERE id = ?'),
    profs: db.prepare('SELECT name, skill, max_skill FROM professions WHERE character_id = ? ORDER BY skill DESC, name'),
    recipes: db.prepare('SELECT profession, name, recipe_id FROM recipes WHERE character_id = ? ORDER BY profession, name'),
    alts: db.prepare(`SELECT name, class, level, is_main, online, zone FROM characters
      WHERE guild_id = ? AND user_id = ? AND id != ? ORDER BY level DESC, name`),
    clearMain: db.prepare('UPDATE characters SET is_main = 0 WHERE guild_id = ? AND user_id = ?'),
    setMain: db.prepare('UPDATE characters SET is_main = 1 WHERE id = ?'),

    requests: db.prepare(`SELECT cr.id, cr.item, cr.notes, cr.status, cr.requester_id, cr.crafter_id, cr.created_at, cr.updated_at,
        u.battletag AS requester, cu.battletag AS crafter,
        EXISTS (SELECT 1 FROM recipes r JOIN characters c ON c.id = r.character_id
          WHERE c.guild_id = cr.guild_id AND c.user_id = @userId AND lower(r.name) = lower(cr.item)) AS i_can_craft
      FROM craft_requests cr JOIN users u ON u.id = cr.requester_id LEFT JOIN users cu ON cu.id = cr.crafter_id
      WHERE cr.guild_id = @guildId AND cr.status != 'cancelled'
        AND (cr.status IN ('open','claimed') OR cr.updated_at > datetime('now', '-${REQUEST_DONE_DAYS} days'))
      ORDER BY cr.id DESC`),
    request: db.prepare(`SELECT cr.*, u.battletag AS requester, cu.battletag AS crafter FROM craft_requests cr
      JOIN users u ON u.id = cr.requester_id LEFT JOIN users cu ON cu.id = cr.crafter_id
      WHERE cr.id = ? AND cr.guild_id = ?`),
    addRequest: db.prepare('INSERT INTO craft_requests (guild_id, requester_id, item, notes) VALUES (?,?,?,?)'),
    setRequest: db.prepare("UPDATE craft_requests SET status = ?, crafter_id = ?, updated_at = datetime('now') WHERE id = ?"),
    crafterUsers: db.prepare(`SELECT DISTINCT c.user_id FROM recipes r JOIN characters c ON c.id = r.character_id
      WHERE c.guild_id = ? AND c.user_id IS NOT NULL AND lower(r.name) = lower(?)`),

    partners: db.prepare(`SELECT b.id, b.user_id, b.character, b.zone, b.when_text, b.note, b.created_at,
        COALESCE(c.level, b.level) AS level, c.class, u.battletag
      FROM buddy_posts b LEFT JOIN characters c ON c.guild_id = b.guild_id AND c.name = b.character
      JOIN users u ON u.id = b.user_id
      WHERE b.guild_id = ? AND b.active = 1 AND b.created_at > datetime('now', '-${PARTNER_DAYS} days') ORDER BY b.id DESC`),
    partner: db.prepare('SELECT * FROM buddy_posts WHERE id = ? AND guild_id = ?'),
    myChars: db.prepare('SELECT name, class, level, zone, is_main FROM characters WHERE guild_id = ? AND user_id = ? ORDER BY is_main DESC, level DESC, name'),
    charLevel: db.prepare('SELECT level FROM characters WHERE guild_id = ? AND name = ?'),
    retirePosts: db.prepare('UPDATE buddy_posts SET active = 0 WHERE guild_id = ? AND user_id = ? AND character = ?'),
    addPartner: db.prepare('INSERT INTO buddy_posts (guild_id, user_id, character, level, zone, when_text, note) VALUES (?,?,?,?,?,?,?)'),
    closePartner: db.prepare('UPDATE buddy_posts SET active = 0 WHERE id = ? AND user_id = ? AND guild_id = ?'),
  };

  const who = (req) => shortName(req.user.battletag);
  const realmOf = (guild) => {
    const r = parseJson(guild.realm_status, null);
    return r && r.found ? r : null;
  };

  // ---------------------------------------------------------------- Camp

  app.get('/api/camp', needGuild, (req, res) => {
    const gid = req.guild.id;
    const uid = req.user.id;
    const officer = isOfficer(req);
    const main = q.main.get(gid, uid) || null;
    const last = q.lastZone.get(gid, uid) || null;
    res.json({
      guild: { id: gid, name: req.guild.name, faction: req.guild.faction, realm: req.guild.realm ?? null },
      realm: realmOf(req.guild),
      rosterScannedAt: req.guild.roster_scanned_at ?? null,
      online: q.online.all(gid),
      ctas: q.ctas.all(gid),
      announcements: q.announcements.all(gid).map((a) => ({ ...a, canDelete: officer })),
      activity: q.activity.all(gid, Number.MAX_SAFE_INTEGER, 12),
      raids: q.raids.all(uid, gid, new Date().toISOString()).map(raidJson),
      mySync: q.mySync.get(gid, uid).t || null,
      onboarding: C.onboardingFor(db, cfg, gid, req.user),
      me: { main, lastZone: last ? last.zone : null, lastZoneCharacter: last ? last.name : null },
      isOfficer: officer,
    });
  });

  // Older activity lines for "Show more". before = the smallest id already shown.
  app.get('/api/activity', needGuild, (req, res) => {
    const before = int(req.query.before, 1) || Number.MAX_SAFE_INTEGER;
    const limit = int(req.query.limit, 1, 100) || 30;
    const rows = q.activity.all(req.guild.id, before, limit + 1);
    res.json({ activity: rows.slice(0, limit), more: rows.length > limit });
  });

  // ---- Call to arms ----
  app.post('/api/ctas', needGuild, async (req, res) => {
    const b = req.body || {};
    const zone = str(b.zone, 60);
    if (!zone) throw new HttpError(400, 'Say where the fight is.');
    // How many people are needed is optional; when given it is 1 to 40.
    const needed = b.needed == null || b.needed === '' ? null : int(b.needed, 1, 40);
    const message = str(b.message, 200) || '';
    const main = q.main.get(req.guild.id, req.user.id);
    const signer = main ? main.name : who(req);
    const id = Number(q.addCta.run(req.guild.id, req.user.id, main ? main.name : null, zone, message, needed).lastInsertRowid);
    await ctx.discord(req.guild, `⚔️ **Call to arms: ${zone}**${needed ? ` (need ${needed})` : ''}\n${message}\n— ${signer}`);
    ctx.emit(req.guild.id, 'cta', {
      title: `⚔️ Call to arms: ${zone}`,
      body: `${needed ? `Need ${needed}. ` : ''}${message} (${signer})`.trim(),
      route: '/',
      exceptUserId: req.user.id,
    });
    res.status(201).json({ cta: { ...q.cta.get(id), battletag: req.user.battletag, class: main ? main.class : null }, message: 'Horn sounded.' });
  });

  // ---- Notices (officers) ----
  app.post('/api/announcements', needOfficer, async (req, res) => {
    const body = str(req.body && req.body.body, 500);
    if (!body) throw new HttpError(400, 'Write the notice first.');
    const id = Number(q.addAnnouncement.run(req.guild.id, req.user.id, body).lastInsertRowid);
    ctx.audit(req, 'notice posted', body.slice(0, 80));
    await ctx.discord(req.guild, `📜 **Notice**\n${body}`);
    ctx.emit(req.guild.id, 'notice', { title: '📜 Guild notice', body, route: '/', exceptUserId: req.user.id });
    res.status(201).json({ announcement: { ...q.announcement.get(id, req.guild.id), canDelete: true }, message: 'Notice posted.' });
  });

  app.delete('/api/announcements/:id', needOfficer, (req, res) => {
    const id = int(req.params.id, 1);
    const a = id && q.announcement.get(id, req.guild.id);
    if (!a) throw new HttpError(404, 'That notice was already removed.');
    q.delAnnouncement.run(a.id, req.guild.id);
    ctx.audit(req, 'notice deleted', a.body.slice(0, 80));
    res.json({ ok: true, message: 'Notice removed.' });
  });

  // ---------------------------------------------------------------- Roster and characters

  app.get('/api/roster', needGuild, (req, res) => {
    const characters = q.roster.all(req.guild.id);
    res.json({
      characters,
      scannedAt: req.guild.roster_scanned_at ?? null,
      officialRosterAt: req.guild.official_roster_at ?? null,
      counts: {
        total: characters.length,
        online: characters.filter((c) => c.online).length,
        linked: characters.filter((c) => c.user_id).length,
        mains: characters.filter((c) => c.is_main).length,
      },
    });
  });

  // Exact name first (names are unique per guild), then any capitalisation so typed links still work.
  const findChar = (guildId, raw) => {
    const name = str(raw, 40);
    if (!name) return null;
    return q.charExact.get(guildId, name) || q.charNoCase.get(guildId, name) || null;
  };

  app.get('/api/characters/:name', needGuild, (req, res) => {
    const c = findChar(req.guild.id, req.params.name);
    if (!c) throw new HttpError(404, "That character isn't on the guild roster yet.");
    const mine = c.user_id === req.user.id;
    const owner = c.user_id ? q.battletag.get(c.user_id) : null;
    res.json({
      character: {
        id: c.id, name: c.name, class: c.class, race: c.race, level: c.level, faction: c.faction,
        rank: c.rank, zone: c.zone, online: c.online, last_seen: c.last_seen, is_main: c.is_main, is_bank: c.is_bank,
        in_official_roster: c.in_official_roster ?? null, user_id: c.user_id, battletag: owner ? owner.battletag : null,
        updated_at: c.updated_at,
        // Gold is only shown to the character's own player.
        money: mine ? c.money ?? null : null,
        readiness: parseJson(c.readiness, null),
        extras: parseJson(c.extras, null),
      },
      professions: q.profs.all(c.id),
      recipes: q.recipes.all(c.id),
      alts: c.user_id ? q.alts.all(req.guild.id, c.user_id, c.id) : [],
      isMine: mine,
      canMakeMain: mine && !c.is_main,
    });
  });

  app.post('/api/characters/:name/main', needGuild, (req, res) => {
    const c = findChar(req.guild.id, req.params.name);
    if (!c || c.user_id !== req.user.id) throw new HttpError(404, "That isn't one of your characters.");
    db.transaction(() => {
      q.clearMain.run(req.guild.id, req.user.id);
      q.setMain.run(c.id);
    })();
    res.json({ ok: true, character: { name: c.name, is_main: 1 }, message: `${c.name} is now your main.` });
  });

  // ---------------------------------------------------------------- Crafters and shopping lists

  app.get('/api/crafters', needGuild, (req, res) => {
    const query = str(req.query.q, 60) || '';
    const gid = req.guild.id;
    res.json({
      q: query,
      results: query ? C.searchRecipes(db, gid, query) : [],
      professions: C.professionSummary(db, gid),
      shopping: C.shoppingFor(db, gid, req.user.id),
      lists: C.guildShoppingLists(db, gid, { exceptUserId: req.user.id }),
    });
  });

  // ---------------------------------------------------------------- Crafting requests

  // What the signed-in member may do with a request (same rules the POST routes enforce).
  const allowed = (r, me) => ({
    canClaim: r.status === 'open' && r.requester_id !== me,
    canDone: r.status === 'claimed' && (r.crafter_id === me || r.requester_id === me),
    canCancel: r.requester_id === me && (r.status === 'open' || r.status === 'claimed'),
  });
  const requestJson = (r, me, crafters) => ({
    id: r.id, item: r.item, notes: r.notes || '', status: r.status,
    requester_id: r.requester_id, requester: r.requester, crafter_id: r.crafter_id ?? null, crafter: r.crafter ?? null,
    created_at: r.created_at, updated_at: r.updated_at,
    crafters, mine: r.requester_id === me, i_can_craft: Boolean(r.i_can_craft),
    ...allowed(r, me),
  });

  app.get('/api/requests', needGuild, (req, res) => {
    const me = req.user.id;
    const rows = q.requests.all({ guildId: req.guild.id, userId: me });
    // Who can craft each open request (one lookup per distinct item).
    const cache = new Map();
    const craftersOf = (item) => {
      const k = item.toLowerCase();
      if (!cache.has(k)) cache.set(k, C.whoCanCraft(db, req.guild.id, item).map(({ name, class: cls, online }) => ({ name, class: cls, online })));
      return cache.get(k);
    };
    const requests = rows.map((r) => requestJson(r, me, r.status === 'open' ? craftersOf(r.item) : []));
    const count = (s) => requests.filter((r) => r.status === s).length;
    res.json({ requests, counts: { open: count('open'), claimed: count('claimed'), done: count('done') } });
  });

  app.post('/api/requests', needGuild, async (req, res) => {
    const item = str(req.body && req.body.item, 100);
    if (!item) throw new HttpError(400, 'Name the item you need.');
    const notes = str(req.body.notes, 200) || '';
    const me = req.user.id;
    const id = Number(q.addRequest.run(req.guild.id, me, item, notes).lastInsertRowid);
    const name = who(req);
    ctx.activity(req.guild.id, 'craft', `${name} asked for ${item}`);
    await ctx.discord(req.guild, `🔨 **Crafting request:** ${item}${notes ? ` (${notes})` : ''}, for ${name}`);
    // Only members who can craft it hear about it.
    const crafters = q.crafterUsers.all(req.guild.id, item).map((r) => r.user_id).filter((u) => u !== me);
    if (crafters.length) {
      ctx.emit(req.guild.id, 'request', {
        title: `🔨 ${name} needs ${item}`,
        body: `You can craft it.${notes ? ` ${notes}` : ''}`,
        route: '/requests',
        recipe: item,
        exceptUserId: me,
      });
    }
    const r = q.request.get(id, req.guild.id);
    res.status(201).json({
      request: requestJson(r, me, C.whoCanCraft(db, req.guild.id, item).map(({ name: n, class: cls, online }) => ({ name: n, class: cls, online }))),
      message: crafters.length ? 'Request posted. Crafters who know it have been told.' : 'Request posted.',
    });
  });

  app.post('/api/requests/:id/:verb', needGuild, (req, res) => {
    const verb = req.params.verb;
    if (!['claim', 'done', 'cancel'].includes(verb)) throw new HttpError(404, 'Not found.');
    const id = int(req.params.id, 1);
    const r = id && q.request.get(id, req.guild.id);
    if (!r) throw new HttpError(404, 'That request no longer exists.');
    const me = req.user.id;
    const name = who(req);
    const can = allowed(r, me);
    let message;
    if (verb === 'claim' && can.canClaim) {
      q.setRequest.run('claimed', me, r.id);
      ctx.activity(req.guild.id, 'craft', `${name} is making ${r.item}`);
      ctx.emit(req.guild.id, 'request', {
        title: `🔨 ${name} is making ${r.item}`,
        body: 'They claimed your crafting request.',
        route: '/requests',
        userId: r.requester_id,
      });
      message = `You're making ${r.item}. ${shortName(r.requester)} can see that.`;
    } else if (verb === 'done' && can.canDone) {
      q.setRequest.run('done', r.crafter_id, r.id);
      ctx.activity(req.guild.id, 'craft', `${r.item} delivered`);
      // The requester hears about it, unless they marked it delivered themselves.
      if (r.requester_id !== me) {
        ctx.emit(req.guild.id, 'request', {
          title: `📦 ${r.item} delivered`,
          body: `${name} marked your crafting request as delivered.`,
          route: '/requests',
          userId: r.requester_id,
        });
      }
      message = 'Marked as delivered.';
    } else if (verb === 'cancel' && can.canCancel) {
      q.setRequest.run('cancelled', r.crafter_id, r.id);
      message = 'Request cancelled.';
    } else {
      throw new HttpError(409, 'That request has already moved on.');
    }
    const updated = q.request.get(r.id, req.guild.id);
    res.json({ ok: true, request: requestJson(updated, me, []), message });
  });

  // ---------------------------------------------------------------- Leveling partners (old "buddies")

  app.get('/api/partners', needGuild, (req, res) => {
    const me = req.user.id;
    res.json({
      posts: q.partners.all(req.guild.id).map((p) => ({ ...p, mine: p.user_id === me })),
      myCharacters: q.myChars.all(req.guild.id, me),
    });
  });

  app.post('/api/partners', needGuild, (req, res) => {
    const b = req.body || {};
    const character = str(b.character, 40);
    if (!character) throw new HttpError(400, 'Pick the character you are leveling.');
    const zone = str(b.zone, 60) || '';
    const whenText = str(b.when_text ?? b.when, 60) || '';
    const note = str(b.note, 140) || '';
    const c = q.charLevel.get(req.guild.id, character);
    const id = db.transaction(() => {
      // One live post per character: a new one replaces the old.
      q.retirePosts.run(req.guild.id, req.user.id, character);
      return Number(q.addPartner.run(req.guild.id, req.user.id, character, c ? c.level : null, zone, whenText, note).lastInsertRowid);
    })();
    ctx.activity(req.guild.id, 'buddy', `${character} is looking for leveling partners${zone ? ` in ${zone}` : ''}`);
    const post = q.partners.all(req.guild.id).find((p) => p.id === id);
    res.status(201).json({ post: { ...post, mine: true }, message: 'Posted. Guildies can see it for 3 days.' });
  });

  app.post('/api/partners/:id/close', needGuild, (req, res) => {
    const id = int(req.params.id, 1);
    const p = id && q.partner.get(id, req.guild.id);
    if (!p) throw new HttpError(404, 'That post no longer exists.');
    if (p.user_id !== req.user.id) throw new HttpError(403, 'You can only remove your own posts.');
    q.closePartner.run(p.id, req.user.id, req.guild.id);
    res.json({ ok: true, message: 'Post removed.' });
  });
}

// Upcoming raid for the Camp preview, with the signed-in member's sign-up.
function raidJson(r) {
  return {
    id: r.id, kind: r.kind, title: r.title, instance: r.instance, starts_at: r.starts_at, status: r.status, size: r.size,
    coming: r.coming, maybe: r.maybe,
    mySignup: r.my_status ? { status: r.my_status, role: r.my_role, character: r.my_character } : null,
  };
}

module.exports = { register };
