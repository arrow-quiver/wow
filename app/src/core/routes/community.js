// Community: the Camp dashboard (who's online, calls to arms, notices, activity, onboarding, upcoming raids),
// the roster, character pages and mains, crafters and shopping lists, crafting requests, and leveling partners.
// Ported from the old web/src/server.js. Shapes are documented in docs/api/community.md.
//
// Calls to arms, notices, crafting requests and claims, and leveling-partner posts are guild data shared
// through the addon (docs/SHARING.md §10). Each change queues a record with sharing.queue(), which also
// remakes the rows (ctas, announcements, craft_requests, buddy_posts) at once:
//   call to arms → ca; notice → AN, deleting one → its tombstone (any officer); crafting request → cr
//   (cancelled 'x' and done 'd' are final); claim, done, withdraw as the crafter → cl (never on your own
//   request); partner post → lp, closing it → its tombstone. My main character reaches the addon in the
//   inbox ("me"); the addon puts it on my character records itself.
// Guildmates are told by their own apps, and Discord posts go out when the game confirms the change.
const S = require('../../shared/sharing');
const { HttpError, str, int, parseJson, needGuild, needOfficer, isOfficer } = require('../http');
const C = require('../services/community');
const identity = require('../identity');
const sharing = require('../sharing');
const CtaDiscord = require('../services/ctaDiscord');

const shortName = (battletag) => String(battletag || '').split('#')[0];
const CTA_WINDOW = "datetime('now','-1 day')";
// Requests that are finished stay on the board this long.
const REQUEST_DONE_DAYS = 7;
// Leveling-partner posts expire after this many days.
const PARTNER_DAYS = 3;
// Rows made before guild data was shared (no share_id) can be read but not changed.
const OLD_ROW = 'This was made with an older Guild Camp and can’t be changed. Make it again.';
const NO_CHARACTER = 'Log in to World of Warcraft on a character in your guild first, then log out or type /reload.';
const REQUEST_VERBS = ['claim', 'done', 'cancel', 'withdraw'];

function register(app, ctx) {
  const { db, cfg } = ctx;
  ctx.services.community = C;
  // A character of mine in another in-game guild stays off this guild's roster, counts and pickers.
  const here = (c) => identity.notElsewhere(c);

  const q = {
    online: db.prepare(`SELECT c.id, c.name, c.class, c.race, c.level, c.zone, c.rank, c.is_main, c.user_id, u.battletag
      FROM characters c LEFT JOIN users u ON u.id = c.user_id
      WHERE c.guild_id = ? AND c.online = 1 AND ${here('c')} ORDER BY c.level DESC, c.name`),
    ctas: db.prepare(`SELECT c.id, c.zone, c.needed, c.message, c.character, c.source, c.created_at, c.user_id, u.battletag,
        (SELECT ch.class FROM characters ch WHERE ch.guild_id = c.guild_id AND ch.name = c.character) AS class
      FROM ctas c JOIN users u ON u.id = c.user_id
      WHERE c.guild_id = ? AND c.created_at > ${CTA_WINDOW} ORDER BY c.id DESC LIMIT 8`),
    announcements: db.prepare(`SELECT a.id, a.body, a.user_id, a.created_at, u.battletag FROM announcements a
      JOIN users u ON u.id = a.user_id WHERE a.guild_id = ? ORDER BY a.id DESC LIMIT 5`),
    announcement: db.prepare(`SELECT a.id, a.body, a.user_id, a.created_at, u.battletag FROM announcements a
      JOIN users u ON u.id = a.user_id WHERE a.id = ? AND a.guild_id = ?`),
    announcementByKey: db.prepare(`SELECT a.id, a.body, a.user_id, a.created_at, u.battletag FROM announcements a
      JOIN users u ON u.id = a.user_id WHERE a.guild_id = ? AND a.share_id = ?`),
    announcementKey: db.prepare('SELECT share_id FROM announcements WHERE id = ?'),
    delAnnouncement: db.prepare('DELETE FROM announcements WHERE id = ? AND guild_id = ?'),
    activity: db.prepare('SELECT id, kind, text, created_at FROM activity WHERE guild_id = ? AND id < ? ORDER BY id DESC LIMIT ?'),
    mySync: db.prepare('SELECT MAX(received_at) AS t FROM sync_log WHERE guild_id = ? AND user_id = ?'),
    // The character a call to arms is signed with (old rule: the main, else the highest level), one of the guild's
    // before one whose guild isn't known.
    main: db.prepare(`SELECT name, class, level, zone FROM characters WHERE guild_id = ? AND user_id = ? AND ${here()}
      ORDER BY ${identity.looseLast()}, is_main DESC, level DESC LIMIT 1`),
    // "Use my last zone": the zone of whichever of my characters was seen most recently.
    lastZone: db.prepare(`SELECT name, zone FROM characters WHERE guild_id = ? AND user_id = ? AND zone IS NOT NULL AND zone != '' AND ${here()}
      ORDER BY last_seen IS NULL, last_seen DESC, updated_at DESC LIMIT 1`),
    raids: db.prepare(`SELECT r.id, r.kind, r.title, r.instance, r.starts_at, r.status, r.size,
        s.status AS my_status, s.role AS my_role, s.character AS my_character,
        (SELECT COUNT(*) FROM signups x WHERE x.raid_id = r.id AND x.status = 'yes') AS coming,
        (SELECT COUNT(*) FROM signups x WHERE x.raid_id = r.id AND x.status = 'tentative') AS maybe
      FROM raids r LEFT JOIN signups s ON s.raid_id = r.id AND s.user_id = ?
      WHERE r.guild_id = ? AND r.status IN ('open','locked') AND r.starts_at > ? ORDER BY r.starts_at LIMIT 4`),
    cta: db.prepare('SELECT id, zone, needed, message, character, source, created_at, user_id FROM ctas WHERE guild_id = ? AND share_id = ?'),

    roster: db.prepare(`SELECT c.id, c.name, c.class, c.race, c.level, c.rank, c.rank_index, c.zone, c.online, c.last_seen, c.is_main,
        c.is_bank, c.in_official_roster, c.user_id, c.updated_at, u.battletag
      FROM characters c LEFT JOIN users u ON u.id = c.user_id
      WHERE c.guild_id = ? AND ${here('c')} ORDER BY c.online DESC, c.level DESC, c.name`),
    charExact: db.prepare('SELECT * FROM characters WHERE guild_id = ? AND name = ?'),
    charNoCase: db.prepare('SELECT * FROM characters WHERE guild_id = ? AND name = ? COLLATE NOCASE ORDER BY id LIMIT 1'),
    battletag: db.prepare('SELECT battletag FROM users WHERE id = ?'),
    profs: db.prepare('SELECT name, skill, max_skill FROM professions WHERE character_id = ? ORDER BY skill DESC, name'),
    recipes: db.prepare('SELECT profession, name, recipe_id FROM recipes WHERE character_id = ? ORDER BY profession, name'),
    alts: db.prepare(`SELECT name, class, level, is_main, online, zone FROM characters
      WHERE guild_id = ? AND user_id = ? AND id != ? AND ${here()} ORDER BY level DESC, name`),
    clearMain: db.prepare('UPDATE characters SET is_main = 0 WHERE guild_id = ? AND user_id = ?'),
    setMain: db.prepare('UPDATE characters SET is_main = 1 WHERE id = ?'),

    requests: db.prepare(`SELECT cr.id, cr.item, cr.notes, cr.status, cr.requester_id, cr.crafter_id, cr.created_at, cr.updated_at,
        u.battletag AS requester, cu.battletag AS crafter,
        EXISTS (SELECT 1 FROM recipes r JOIN characters c ON c.id = r.character_id
          WHERE c.guild_id = cr.guild_id AND c.user_id = @userId AND ${here('c')} AND lower(r.name) = lower(cr.item)) AS i_can_craft
      FROM craft_requests cr JOIN users u ON u.id = cr.requester_id LEFT JOIN users cu ON cu.id = cr.crafter_id
      WHERE cr.guild_id = @guildId AND cr.status != 'cancelled'
        AND (cr.status IN ('open','claimed') OR cr.updated_at > datetime('now', '-${REQUEST_DONE_DAYS} days'))
      ORDER BY cr.id DESC`),
    request: db.prepare(`SELECT cr.*, u.battletag AS requester, cu.battletag AS crafter FROM craft_requests cr
      JOIN users u ON u.id = cr.requester_id LEFT JOIN users cu ON cu.id = cr.crafter_id
      WHERE cr.id = ? AND cr.guild_id = ?`),
    requestByKey: db.prepare('SELECT id FROM craft_requests WHERE guild_id = ? AND share_id = ?'),

    partners: db.prepare(`SELECT b.id, b.user_id, b.character, b.zone, b.when_text, b.note, b.created_at,
        COALESCE(c.level, b.level) AS level, c.class, u.battletag
      FROM buddy_posts b LEFT JOIN characters c ON c.guild_id = b.guild_id AND c.name = b.character
      JOIN users u ON u.id = b.user_id
      WHERE b.guild_id = ? AND b.active = 1 AND b.created_at > datetime('now', '-${PARTNER_DAYS} days') ORDER BY b.id DESC`),
    partner: db.prepare('SELECT * FROM buddy_posts WHERE id = ? AND guild_id = ?'),
    myChars: db.prepare(`SELECT name, class, level, zone, is_main FROM characters WHERE guild_id = ? AND user_id = ? AND ${here()} ORDER BY is_main DESC, level DESC, name`),
    charLevel: db.prepare('SELECT level FROM characters WHERE guild_id = ? AND name = ?'),
    partnerByKey: db.prepare('SELECT id FROM buddy_posts WHERE guild_id = ? AND share_id = ?'),
    // My posts from before sharing were only ever on this computer: they are retired or closed here.
    retireOldPosts: db.prepare('UPDATE buddy_posts SET active = 0 WHERE guild_id = ? AND user_id = ? AND character = ? AND share_id IS NULL'),
    closePartner: db.prepare('UPDATE buddy_posts SET active = 0 WHERE id = ? AND user_id = ? AND guild_id = ?'),
  };

  const who = (req) => shortName(req.user.battletag);
  // My player id (made on my main character the first time): the player my requests and posts belong to.
  function myPid() {
    const pid = sharing.myPid(db);
    if (!pid) throw new HttpError(409, NO_CHARACTER);
    return pid;
  }
  // The record key of a row; rows from before sharing have none and can't be changed.
  function keyOf(row) {
    if (!row.share_id) throw new HttpError(409, OLD_ROW);
    return row.share_id;
  }
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
  // A call to arms (ca), signed with my main (else my highest-level character). It goes out at my next login
  // or /reload; the in-game /wow cta sends one at once.
  app.post('/api/ctas', needGuild, (req, res) => {
    const b = req.body || {};
    const zone = str(b.zone, 60);
    if (!zone) throw new HttpError(400, 'Say where the fight is.');
    // How many people are needed is optional; when given it is 1 to 40.
    const needed = b.needed == null || b.needed === '' ? null : int(b.needed, 1, 40);
    const message = str(b.message, 200) || '';
    const main = q.main.get(req.guild.id, req.user.id);
    const key = sharing.newKey();
    sharing.queue(db, ctx, { type: 'ca', key, fields: { character: main ? main.name : '', zone, needed, message } });
    // And on the guild's Discord, at once (services/ctaDiscord.js; never twice).
    const row = q.cta.get(req.guild.id, key);
    if (row) {
      db.prepare('UPDATE ctas SET discord_posted = 1 WHERE id = ?').run(row.id);
      CtaDiscord.post(db, ctx, req.guild.id, { character: main ? main.name : String(req.user.battletag || '').split('#')[0], zone, needed, message })
        .catch((err) => (ctx.log || console).warn(`Posting the call to arms to Discord failed: ${err.message}`));
    }
    res.status(201).json({ cta: { ...q.cta.get(req.guild.id, key), battletag: req.user.battletag, class: main ? main.class : null }, message: 'Call to arms posted.' });
  });

  // A call to arms of mine the app read from the chat log (main/live.js createChatWatch): to Discord at once.
  app.post('/api/ctas/discord', needGuild, async (req, res) => {
    const b = req.body || {};
    const c = { character: str(b.character, 48), zone: str(b.zone, 60), needed: b.needed == null ? null : int(b.needed, 1, 40), message: str(b.message, 200) || '' };
    if (!c.zone) throw new HttpError(400, 'Say where the fight is.');
    res.json({ posted: await CtaDiscord.post(db, ctx, req.guild.id, c) });
  });

  // My calls to arms that arrived with an upload (made in game while the chat log was off): to Discord, every minute.
  if (ctx.cfg.timers) {
    const h = setInterval(() => {
      const me = ctx.me && ctx.me(); const g = ctx.guild && ctx.guild();
      if (me && g) CtaDiscord.sweep(db, ctx, g.id, me.id).catch((err) => (ctx.log || console).warn(`Calls to arms on Discord: ${err.message}`));
    }, 60 * 1000);
    if (h.unref) h.unref();
    ctx.timers.push(h);
  }

  // ---- Notices (officers) ----
  app.post('/api/announcements', needOfficer, (req, res) => {
    const body = str(req.body && req.body.body, 500);
    if (!body) throw new HttpError(400, 'Write the notice first.');
    const key = sharing.newKey();
    sharing.queue(db, ctx, { type: 'AN', key, fields: { body }, need: 'o' });
    ctx.audit(req, 'notice posted', body.slice(0, 80));
    res.status(201).json({ announcement: { ...q.announcementByKey.get(req.guild.id, key), canDelete: true }, message: 'Notice posted.' });
  });

  // Any officer may delete any notice: its tombstone goes to the guild. A notice from before sharing was only
  // ever on this computer, so it just goes.
  app.delete('/api/announcements/:id', needOfficer, (req, res) => {
    const id = int(req.params.id, 1);
    const a = id && q.announcement.get(id, req.guild.id);
    if (!a) throw new HttpError(404, 'That notice was already removed.');
    const key = q.announcementKey.get(a.id).share_id;
    if (key) sharing.queue(db, ctx, { type: 'AN', key, del: true, need: 'o' });
    else q.delAnnouncement.run(a.id, req.guild.id);
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
    // Until Battle.net tells Guild Camp my BattleTag, I go by my main's name.
    identity.refreshMyName(db);
    // The addon learns my main from the inbox ("me") and puts it on my character records.
    ctx.outboxChanged();
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
    canWithdraw: r.status === 'claimed' && r.crafter_id === me,
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

  // A crafting request (cr) for my player. Crafters who know the recipe hear about it from their own apps.
  app.post('/api/requests', needGuild, (req, res) => {
    const item = str(req.body && req.body.item, 100);
    if (!item) throw new HttpError(400, 'Name the item you need.');
    const notes = str(req.body.notes, 200) || '';
    const me = req.user.id;
    const key = sharing.newKey();
    sharing.queue(db, ctx, { type: 'cr', key, fields: { pid: myPid(), item, notes, state: 'o' } });
    ctx.activity(req.guild.id, 'craft', `${who(req)} asked for ${item}`);
    const r = q.request.get(q.requestByKey.get(req.guild.id, key).id, req.guild.id);
    res.status(201).json({
      request: requestJson(r, me, C.whoCanCraft(db, req.guild.id, item).map(({ name: n, class: cls, online }) => ({ name: n, class: cls, online }))),
      message: 'Request posted.',
    });
  });

  // claim / done / withdraw as the crafter → my claim (cl:<request>:<my pid>); cancel, or done as the one who
  // asked → the request itself (cr), whose cancelled and done states are final.
  app.post('/api/requests/:id/:verb', needGuild, (req, res) => {
    const verb = req.params.verb;
    if (!REQUEST_VERBS.includes(verb)) throw new HttpError(404, 'Not found.');
    const id = int(req.params.id, 1);
    const r = id && q.request.get(id, req.guild.id);
    if (!r) throw new HttpError(404, 'That request no longer exists.');
    const me = req.user.id;
    const can = allowed(r, me);
    const may = { claim: can.canClaim, done: can.canDone, cancel: can.canCancel, withdraw: can.canWithdraw }[verb];
    if (!may) throw new HttpError(409, 'That request has already moved on.');
    const gid = req.guild.id;
    const key = keyOf(r);
    const pid = myPid();
    const cr = sharing.recordOf(db, gid, `cr:${key}`);
    if (!cr || cr.del || !cr.fields) throw new HttpError(409, 'That request has already moved on.');
    const mine = sharing.recordOf(db, gid, `cl:${key}:${pid}`);
    const claimedAt = mine && !mine.del && mine.fields && mine.fields.claimedAt != null ? mine.fields.claimedAt : sharing.serverNow(db);
    const claim = (state) => sharing.queue(db, ctx, { type: 'cl', key: `${key}:${pid}`, fields: { state, claimedAt } });
    const request = (state) => sharing.queue(db, ctx, { type: 'cr', key, fields: { ...cr.fields, state } });
    let message;
    if (verb === 'claim') {
      if (cr.fields.pid === pid) throw new HttpError(409, 'You can’t claim your own request.');
      claim('c');
      ctx.activity(gid, 'craft', `${who(req)} is making ${r.item}`);
      message = `You're making ${r.item}.`;
    } else if (verb === 'done') {
      if (r.requester_id === me) request('d'); else claim('d');
      ctx.activity(gid, 'craft', `${r.item} delivered`);
      message = 'Marked as delivered.';
    } else if (verb === 'cancel') {
      request('x');
      message = 'Request cancelled.';
    } else {
      claim('w');
      message = `You're no longer making ${r.item}.`;
    }
    const updated = q.request.get(r.id, gid);
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
    // One live post per character: the key is my player and the character, so a new post replaces the old.
    const key = `${myPid()}:${character}`;
    if (!S.keyOk('lp', key)) throw new HttpError(400, 'That character name can’t be shared. Pick one of your characters.');
    const c = q.charLevel.get(req.guild.id, character);
    db.transaction(() => {
      q.retireOldPosts.run(req.guild.id, req.user.id, character);
      sharing.queue(db, ctx, { type: 'lp', key, fields: { character, level: c ? c.level : null, zone, when: whenText, note } });
    })();
    ctx.activity(req.guild.id, 'buddy', `${character} is looking for leveling partners${zone ? ` in ${zone}` : ''}`);
    const id = q.partnerByKey.get(req.guild.id, key).id;
    const post = q.partners.all(req.guild.id).find((p) => p.id === id);
    res.status(201).json({ post: { ...post, mine: true }, message: 'Posted. It stays up for 3 days.' });
  });

  // Closing my post: its tombstone goes to the guild (a post from before sharing just closes here).
  app.post('/api/partners/:id/close', needGuild, (req, res) => {
    const id = int(req.params.id, 1);
    const p = id && q.partner.get(id, req.guild.id);
    if (!p) throw new HttpError(404, 'That post no longer exists.');
    if (p.user_id !== req.user.id) throw new HttpError(403, 'You can only remove your own posts.');
    if (p.share_id) sharing.queue(db, ctx, { type: 'lp', key: p.share_id, del: true });
    else q.closePartner.run(p.id, req.user.id, req.guild.id);
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
