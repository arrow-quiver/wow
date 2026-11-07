// Raids and other scheduled events (PvP premades, guild events), sign-ups, soft reserves with the
// SR+ loyalty bonus, the officer loot screen (rolls and awards), loot lists and loot history, and the
// one-hour reminder. Ported from the old web/src/routes/raids.js. Shapes: docs/api/raids.md.
//
// The rules themselves live in services/raids.js (shared with tests and the inbox). This file adds
// validation, permissions, the Discord posts, app notifications, audit entries and activity lines.
const R = require('../services/raids');
const D = require('../services/discord');
const {
  HttpError, str, int, oneOf, list, isOfficer, needGuild, needOfficer, esc, htmlPage, sendHtml,
} = require('../http');

const KINDS = ['raid', 'pvp', 'event'];
const ROLES = ['tank', 'healer', 'dps'];
const STATUSES = ['yes', 'tentative', 'no', 'bench'];
const AWARD_KINDS = ['sr', 'ms', 'os', 'free'];
const KIND_ICON = { raid: '🗓️', pvp: '⚔️', event: '🎉' };
const KIND_NAME = { raid: 'Raid', pvp: 'PvP', event: 'Event' };
// Readiness: below this repair percentage a sign-up is flagged (same line the old sign-up list drew).
const LOW_REPAIR = 30;
// A raid stays under "Coming up" for 6 hours after it starts, unless it was closed.
const UPCOMING_GRACE_MS = 6 * 3600 * 1000;
const REMINDER_EVERY_MS = 60 * 1000;

const shortName = (battletag) => String(battletag || '').split('#')[0];
// A row id from a request (positive whole number), or null. (int() clamps, so 0 would become 1.)
const posId = (v) => { const n = int(v); return n && n > 0 ? n : null; };
const unix = (iso) => Math.floor(new Date(iso).getTime() / 1000);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// "Wed 9 Dec, 18:00 UTC" for notification text (the app shows local times everywhere else).
function utcLabel(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

// The start time from a request body, as ISO 8601 UTC, or null.
//   starts_at: "2026-12-09T18:00:00.000Z" (or any ISO time with a zone), what the app sends.
//   starts_at / starts without a zone ("2026-12-09T20:00") + tz_offset (getTimezoneOffset() minutes), like
//   the old form; without tz_offset the server's DEFAULT_TZ_OFFSET applies.
const ZONED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})$/i;
const LOCAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;
function startFrom(body, fallbackOffset) {
  const raw = str(body.starts_at, 40) || str(body.starts, 40);
  if (!raw) return null;
  let iso = null;
  if (ZONED.test(raw)) {
    const d = new Date(raw);
    iso = Number.isNaN(d.getTime()) ? null : d.toISOString();
  } else if (LOCAL.test(raw)) {
    iso = R.toUtc(raw.slice(0, 16), body.tz_offset, fallbackOffset);
  }
  if (!iso) return null;
  const year = Number(iso.slice(0, 4));
  return year >= 2000 && year <= 2100 ? iso : null;
}

// A raids row for JSON. Leaves out guild_id and the Discord event id.
function raidJson(r) {
  if (!r) return null;
  return {
    id: r.id,
    kind: r.kind || 'raid',
    title: r.title,
    instance: r.instance,
    starts_at: r.starts_at,
    duration_min: r.duration_min ?? 180,
    size: r.size ?? null,
    sr_limit: r.sr_limit,
    notes: r.notes || null,
    status: r.status,
    reminded: r.reminded,
    created_by: r.created_by ?? null,
    created_at: r.created_at,
  };
}

// Readiness flags shown next to a sign-up: no addon data, low repair, no consumables in bags.
function readinessFlags(ready) {
  if (!ready) return { noData: true, lowRepair: false, noConsumables: false };
  const total = Object.values(ready.consumables || {}).reduce((a, b) => a + (Number(b) || 0), 0);
  return {
    noData: false,
    lowRepair: ready.durability != null && Number(ready.durability) < LOW_REPAIR,
    noConsumables: total === 0,
  };
}

function signupJson(s, meId) {
  return {
    user_id: s.user_id,
    character: s.character,
    role: s.role,
    status: s.status,
    note: s.note || null,
    updated_at: s.updated_at,
    battletag: s.battletag,
    name: shortName(s.battletag),
    class: s.class || null,
    level: s.level ?? null,
    readiness: s.ready || null,
    flags: readinessFlags(s.ready),
    mine: s.user_id === meId,
  };
}

// Role and status counts for a list of sign-ups. tank/healer/dps count people coming ("yes").
function countsOf(signups) {
  const c = { tank: 0, healer: 0, dps: 0, tentative: 0, bench: 0, no: 0 };
  for (const s of signups) {
    if (s.status === 'yes' && s.role in c) c[s.role] += 1;
    else if (s.status in c) c[s.status] += 1;
  }
  return c;
}

const reserverJson = (r) => ({
  user_id: r.user_id,
  battletag: r.battletag,
  name: shortName(r.battletag),
  character: r.character || null,
  bonus: r.bonus,
  signup: r.signup || null,
  inRaid: r.signup === 'yes' || r.signup === 'bench',
});

const rollJson = (r) => ({
  user_id: r.user_id,
  battletag: r.battletag,
  name: shortName(r.battletag),
  character: r.character || null,
  roll: r.roll,
  bonus: r.bonus,
  total: r.total,
  created_at: r.created_at,
});

function register(app, ctx) {
  const { db, cfg } = ctx;
  const WH_ID = (alias, nameCol) => `COALESCE(${alias}.item_id, (SELECT n.item_id FROM item_names n WHERE n.name = ${nameCol} LIMIT 1))`;
  const q = {
    insertRaid: db.prepare(`INSERT INTO raids (guild_id, title, instance, starts_at, duration_min, size, sr_limit, notes, created_by, kind)
      VALUES (?,?,?,?,?,?,?,?,?,?)`),
    setEventId: db.prepare('UPDATE raids SET discord_event_id = ? WHERE id = ?'),
    setStatus: db.prepare('UPDATE raids SET status = ? WHERE id = ?'),
    listRaids: (where, order, limit) => `SELECT r.*,
        COALESCE(SUM(s.status = 'yes' AND s.role = 'tank'), 0) AS c_tank,
        COALESCE(SUM(s.status = 'yes' AND s.role = 'healer'), 0) AS c_healer,
        COALESCE(SUM(s.status = 'yes' AND s.role = 'dps'), 0) AS c_dps,
        COALESCE(SUM(s.status = 'tentative'), 0) AS c_tentative,
        COALESCE(SUM(s.status = 'bench'), 0) AS c_bench,
        COALESCE(SUM(s.status = 'no'), 0) AS c_no,
        me.status AS my_status, me.role AS my_role, me.character AS my_character,
        (SELECT COUNT(*) FROM reserves rv WHERE rv.raid_id = r.id AND rv.user_id = @userId) AS my_reserves
      FROM raids r
      LEFT JOIN signups s ON s.raid_id = r.id
      LEFT JOIN signups me ON me.raid_id = r.id AND me.user_id = @userId
      WHERE r.guild_id = @guildId AND ${where}
      GROUP BY r.id ORDER BY r.starts_at ${order} LIMIT ${limit}`,
    instances: db.prepare(`SELECT instance FROM loot_items WHERE guild_id = ? UNION SELECT instance FROM raids WHERE guild_id = ?
      ORDER BY instance COLLATE NOCASE`),
    mySignup: db.prepare('SELECT * FROM signups WHERE raid_id = ? AND user_id = ?'),
    upsertSignup: db.prepare(`INSERT INTO signups (raid_id, user_id, character, role, status, note, updated_at) VALUES (?,?,?,?,?,?, datetime('now'))
      ON CONFLICT (raid_id, user_id) DO UPDATE SET character = excluded.character, role = excluded.role, status = excluded.status,
      note = excluded.note, updated_at = excluded.updated_at`),
    myCharacters: db.prepare('SELECT name, class, level, is_main FROM characters WHERE guild_id = ? AND user_id = ? ORDER BY is_main DESC, level DESC, name'),
    raidItems: db.prepare(`SELECT li.*, ${WH_ID('li', 'li.name')} AS wh_id, COALESCE(l.bonus, 0) AS bonus,
        (SELECT COUNT(*) FROM reserves rv WHERE rv.raid_id = @raidId AND rv.item_id = li.id) AS reserved,
        EXISTS (SELECT 1 FROM reserves rv WHERE rv.raid_id = @raidId AND rv.item_id = li.id AND rv.user_id = @userId) AS mine
      FROM loot_items li LEFT JOIN loyalty l ON l.guild_id = li.guild_id AND l.item_id = li.id AND l.user_id = @userId
      WHERE li.guild_id = @guildId AND li.instance = @instance ORDER BY li.boss, li.name`),
    raidLoot: (order) => `SELECT lg.*, ${WH_ID('li', 'lg.item_name')} AS wh_id FROM loot_log lg
      LEFT JOIN loot_items li ON li.id = lg.item_id WHERE lg.raid_id = ? ORDER BY lg.id ${order}`,
    attended: db.prepare('SELECT user_id FROM attendance WHERE raid_id = ?'),
    userName: db.prepare('SELECT battletag FROM users WHERE id = ?'),
    signedUpIds: db.prepare("SELECT user_id FROM signups WHERE raid_id = ? AND status != 'no'"),
    remindIds: db.prepare("SELECT user_id FROM signups WHERE raid_id = ? AND status IN ('yes','tentative','bench')"),
    memberIds: db.prepare('SELECT user_id FROM memberships WHERE guild_id = ?'),
    isMember: db.prepare('SELECT 1 FROM memberships WHERE guild_id = ? AND user_id = ?'),
    attending: db.prepare(`SELECT s.user_id, s.character, s.role, s.status, c.class FROM signups s
      LEFT JOIN characters c ON c.guild_id = ? AND c.name = s.character
      WHERE s.raid_id = ? AND s.status IN ('yes','bench') ORDER BY s.character COLLATE NOCASE`),
    lootItem: db.prepare('SELECT * FROM loot_items WHERE id = ? AND guild_id = ?'),
    itemByName: db.prepare('SELECT id FROM loot_items WHERE guild_id = ? AND instance = ? AND lower(name) = lower(?)'),
    signupByCharacter: db.prepare('SELECT user_id, character FROM signups WHERE raid_id = ? AND lower(character) = lower(?)'),
    characterByName: db.prepare('SELECT user_id, name FROM characters WHERE guild_id = ? AND lower(name) = lower(?)'),
    mainOf: db.prepare('SELECT name FROM characters WHERE guild_id = ? AND user_id = ? ORDER BY is_main DESC, level DESC LIMIT 1'),
    lastAward: db.prepare(`SELECT lg.*, ${WH_ID('li', 'lg.item_name')} AS wh_id FROM loot_log lg
      LEFT JOIN loot_items li ON li.id = lg.item_id WHERE lg.raid_id = ? ORDER BY lg.id DESC LIMIT 1`),
    catalog: db.prepare(`SELECT li.*, ${WH_ID('li', 'li.name')} AS wh_id FROM loot_items li WHERE li.guild_id = ?
      ORDER BY li.instance COLLATE NOCASE, li.boss, li.name`),
    history: db.prepare(`SELECT l.*, r.title, r.kind AS raid_kind, ${WH_ID('li', 'l.item_name')} AS wh_id FROM loot_log l
      LEFT JOIN raids r ON r.id = l.raid_id LEFT JOIN loot_items li ON li.id = l.item_id
      WHERE l.guild_id = ? ORDER BY l.id DESC LIMIT 100`),
    myLoyalty: db.prepare(`SELECT li.id AS item_id, li.name, li.instance, li.boss, ${WH_ID('li', 'li.name')} AS wh_id, l.bonus
      FROM loyalty l JOIN loot_items li ON li.id = l.item_id
      WHERE l.guild_id = ? AND l.user_id = ? AND l.bonus > 0 ORDER BY l.bonus DESC, li.name`),
    deleteItem: db.prepare('DELETE FROM loot_items WHERE id = ?'),
  };
  // Statements built from the SQL templates above.
  q.upcoming = db.prepare(q.listRaids("r.starts_at >= @cutoff AND r.status != 'done'", 'ASC', 20));
  q.past = db.prepare(q.listRaids("(r.starts_at < @cutoff OR r.status = 'done')", 'DESC', 20));
  q.lootAsc = db.prepare(q.raidLoot('ASC'));
  q.lootDesc = db.prepare(q.raidLoot('DESC'));

  const who = (req) => shortName(req.user.battletag);
  // The Discord app (bot) can manage native scheduled events once it is set up for this guild's server.
  const discordApp = (guild) => Boolean(cfg.discordBotToken && guild && guild.discord_server_id);
  const raidUrl = (id) => `${cfg.baseUrl}/raids/${id}`;

  function raidOr404(req) {
    const id = /^\d{1,12}$/.test(String(req.params.id)) ? Number(req.params.id) : null;
    const raid = id ? R.raidFor(db, req.guild.id, id) : null;
    if (!raid) throw new HttpError(404, 'That raid was not found. It may have been removed.');
    return raid;
  }

  function summaryJson(r) {
    return {
      ...raidJson(r),
      counts: { tank: r.c_tank, healer: r.c_healer, dps: r.c_dps, tentative: r.c_tentative, bench: r.c_bench, no: r.c_no },
      mySignup: r.my_status ? { status: r.my_status, role: r.my_role, character: r.my_character } : null,
      myReserves: r.my_reserves,
    };
  }

  // ---------- list + schedule ----------

  app.get('/api/raids', needGuild, (req, res) => {
    const params = { guildId: req.guild.id, userId: req.user.id, cutoff: new Date(Date.now() - UPCOMING_GRACE_MS).toISOString() };
    const upcoming = q.upcoming.all(params);
    const past = q.past.all(params);
    res.json({
      upcoming: upcoming.map(summaryJson),
      past: past.map(summaryJson),
      instances: q.instances.all(req.guild.id, req.guild.id).map((r) => r.instance),
    });
  });

  app.post('/api/raids', needOfficer, async (req, res) => {
    const b = req.body || {};
    const g = req.guild;
    const kind = oneOf(b.kind, KINDS, 'raid');
    const title = str(b.title, 60);
    const instance = str(b.instance, 60);
    const startsAt = startFrom(b, cfg.defaultTzOffset);
    if (!title || !instance || !startsAt) throw new HttpError(400, 'Fill in the name, instance and start time.');
    const size = int(b.size, 0, 40) || null;
    const sr = int(b.sr_limit, 0, 5);
    const srLimit = kind === 'raid' ? (sr === null ? 2 : sr) : 0; // only raids have reserves
    const duration = int(b.duration_min, 15, 24 * 60) ?? 180;
    const notes = str(b.notes, 300);

    const id = Number(q.insertRaid.run(g.id, title, instance, startsAt, duration, size, srLimit, notes, req.user.id, kind).lastInsertRowid);
    const raid = R.raidFor(db, g.id, id);
    ctx.activity(g.id, 'raid', `${who(req)} scheduled ${title}`);
    ctx.audit(req, `scheduled ${kind}`, `${title} (${startsAt})`);
    const icon = KIND_ICON[kind];
    ctx.emit(g.id, 'raid', {
      title: `${icon} ${title}`,
      body: `${instance}, ${utcLabel(startsAt)}. Sign up in Guild Camp.`,
      route: `/raids/${id}`,
      exceptUserId: req.user.id,
    });

    // Discord: the webhook post and, when the Discord app is in the server, a native scheduled event.
    // Neither can fail the request.
    const [posted] = await Promise.all([
      ctx.discord(g, `${icon} **${KIND_NAME[kind]}: ${title}** (${instance})\n<t:${unix(startsAt)}:F>, <t:${unix(startsAt)}:R>\nSign up${kind === 'raid' ? ' and reserve' : ''}: ${raidUrl(id)}`),
      discordApp(g)
        ? D.createEvent(cfg, g.discord_server_id, raid, raidUrl(id))
          .then((eventId) => { if (eventId) q.setEventId.run(String(eventId), id); })
          .catch((e) => ctx.log.warn(`Discord event for raid ${id} not created: ${e.message}`))
        : null,
    ]);
    res.status(201).json({
      raid: raidJson(R.raidFor(db, g.id, id)),
      message: `${KIND_NAME[kind]} scheduled${posted ? ' and posted to Discord' : ''}.`,
    });
  });

  // ---------- one raid ----------

  app.get('/api/raids/:id', needGuild, (req, res) => {
    const raid = raidOr404(req);
    const me = req.user.id;
    const signups = R.signupsFor(db, raid);
    const items = q.raidItems.all({ raidId: raid.id, userId: me, guildId: raid.guild_id, instance: raid.instance })
      .map((i) => ({ ...i, mine: Boolean(i.mine) }));
    const whById = new Map(items.map((i) => [i.id, i.wh_id]));
    const mine = signups.find((s) => s.user_id === me);
    const creator = raid.created_by ? q.userName.get(raid.created_by) : null;
    const open = raid.status === 'open' || raid.status === 'locked';
    res.json({
      raid: { ...raidJson(raid), scheduledBy: creator ? shortName(creator.battletag) : null },
      signups: signups.map((s) => signupJson(s, me)),
      counts: countsOf(signups),
      mySignup: mine ? signupJson(mine, me) : null,
      myCharacters: q.myCharacters.all(raid.guild_id, me),
      items,
      myReserves: R.myReserves(db, raid, me).map((r) => ({ ...r, wh_id: whById.get(r.id) ?? r.item_id ?? null })),
      board: R.reserveBoard(db, raid).map((b) => ({ ...b, reservers: b.reservers.map(reserverJson) })),
      loot: q.lootAsc.all(raid.id),
      attended: q.attended.all(raid.id).map((r) => r.user_id),
      canSignUp: open,
      canReserve: raid.status === 'open' && (raid.kind || 'raid') === 'raid' && raid.sr_limit > 0 && items.length > 0,
      isOfficer: isOfficer(req),
    });
  });

  app.post('/api/raids/:id/signup', needGuild, (req, res) => {
    const raid = raidOr404(req);
    if (raid.status !== 'open' && raid.status !== 'locked') throw new HttpError(409, 'Sign-ups are closed for this raid.');
    const b = req.body || {};
    const character = str(b.character, 40);
    if (!character) throw new HttpError(400, 'Pick a character.');
    const role = oneOf(b.role, ROLES, 'dps');
    const status = oneOf(b.status, STATUSES, 'yes');
    const note = str(b.note, 120);
    const before = q.mySignup.get(raid.id, req.user.id);
    q.upsertSignup.run(raid.id, req.user.id, character, role, status, note);
    if (!before && status === 'yes') ctx.activity(req.guild.id, 'raid', `${character} signed up for ${raid.title}`);
    const signups = R.signupsFor(db, raid);
    const mine = signups.find((s) => s.user_id === req.user.id);
    res.json({
      ok: true,
      signup: signupJson(mine, req.user.id),
      counts: countsOf(signups),
      message: status === 'no' ? 'Marked as can’t make it.' : before ? 'Sign-up updated.' : 'You’re signed up.',
    });
  });

  app.post('/api/raids/:id/reserves', needGuild, (req, res) => {
    const raid = raidOr404(req);
    const b = req.body || {};
    const picked = list(b.item_ids ?? b.items ?? b.item, 50);
    R.setReserves(db, raid, req.user.id, picked); // throws 409 locked / 400 too many or not on the list
    res.json({
      ok: true,
      myReserves: R.myReserves(db, raid, req.user.id),
      message: picked.length ? 'Reserves saved.' : 'Reserves cleared.',
    });
  });

  // ---------- officer actions ----------

  const TRANSITIONS = {
    lock: { from: ['open'], to: 'locked', audit: 'raid locked', done: () => 'Reserves locked.', refuse: 'Only raids with open reserves can be locked.' },
    unlock: { from: ['locked'], to: 'open', audit: 'raid reopened', done: () => 'Reserves reopened.', refuse: 'Reserves aren’t locked for this raid.' },
    cancel: { from: ['open', 'locked'], to: 'cancelled', audit: 'raid cancelled', done: (r) => `${KIND_NAME[r.kind] || 'Raid'} cancelled.`, refuse: 'Only upcoming raids can be cancelled.' },
  };
  for (const [verb, t] of Object.entries(TRANSITIONS)) {
    app.post(`/api/raids/:id/${verb}`, needOfficer, async (req, res) => {
      const raid = raidOr404(req);
      if (!t.from.includes(raid.status)) throw new HttpError(409, t.refuse);
      q.setStatus.run(t.to, raid.id);
      ctx.audit(req, t.audit, raid.title);
      if (t.to === 'cancelled') {
        const g = req.guild;
        const signed = q.signedUpIds.all(raid.id).map((x) => x.user_id).filter((id) => id !== req.user.id);
        if (signed.length) {
          ctx.emit(g.id, 'raid', { title: `❌ ${raid.title} is cancelled`, body: 'Check Guild Camp for details.', route: `/raids/${raid.id}`, userIds: signed });
        }
        await Promise.all([
          ctx.discord(g, `❌ **${raid.title}** on <t:${unix(raid.starts_at)}:F> is cancelled.`),
          raid.discord_event_id && discordApp(g)
            ? D.deleteEvent(cfg, g.discord_server_id, raid.discord_event_id).catch((e) => ctx.log.warn(`Discord event for raid ${raid.id} not removed: ${e.message}`))
            : null,
        ]);
      }
      res.json({ ok: true, raid: raidJson(R.raidFor(db, req.guild.id, raid.id)), message: t.done(raid) });
    });
  }

  app.post('/api/raids/:id/close', needOfficer, (req, res) => {
    const raid = raidOr404(req);
    if (raid.status === 'cancelled') throw new HttpError(409, 'Cancelled raids can’t be closed.');
    const b = req.body || {};
    // Only people in the guild can be marked as attending.
    const members = new Set(q.memberIds.all(req.guild.id).map((r) => r.user_id));
    const attendees = [...new Set(list(b.attendee_user_ids ?? b.attended, 200).map(posId).filter((id) => id && members.has(id)))];
    const r = R.closeRaid(db, raid, attendees); // 409 when already closed
    ctx.activity(req.guild.id, 'raid', `${raid.title} finished with ${r.attended} raiders`);
    ctx.audit(req, 'raid closed', `${raid.title}: ${r.attended} attended, ${r.noShows} no-shows`);
    res.json({
      ok: true,
      raid: raidJson(R.raidFor(db, req.guild.id, raid.id)),
      attended: r.attended,
      noShows: r.noShows,
      message: `${KIND_NAME[raid.kind] || 'Raid'} closed. ${r.attended} attended${r.noShows ? `, ${plural(r.noShows, 'no-show')}` : ''}.${(raid.kind || 'raid') === 'raid' ? ' Bonuses updated.' : ''}`,
    });
  });

  // ---------- loot screen (officers) ----------

  function lootScreen(raid) {
    const board = R.reserveBoard(db, raid).map((b) => ({
      ...b,
      reservers: b.reservers.map(reserverJson),
      rolls: R.rollsFor(db, raid, b.item_id).map(rollJson),
    }));
    return {
      raid: raidJson(raid),
      board,
      items: R.itemsForInstance(db, raid.guild_id, raid.instance),
      attending: q.attending.all(raid.guild_id, raid.id),
      awarded: q.lootDesc.all(raid.id),
    };
  }

  app.get('/api/raids/:id/loot', needOfficer, (req, res) => {
    res.json(lootScreen(raidOr404(req)));
  });

  app.post('/api/raids/:id/roll', needOfficer, (req, res) => {
    const raid = raidOr404(req);
    if (raid.status === 'cancelled') throw new HttpError(409, 'This raid was cancelled.');
    const itemId = posId((req.body || {}).item_id);
    const item = itemId ? q.lootItem.get(itemId, raid.guild_id) : null;
    if (!item) throw new HttpError(404, 'That item isn’t on this raid’s loot list.');
    const rolls = R.rollItem(db, raid, item.id).map(rollJson);
    const top = rolls[0];
    res.json({
      item_id: item.id,
      rolls,
      message: top
        ? `${top.character || top.name} has the highest roll for ${item.name}: ${top.roll}${top.bonus ? ` + ${top.bonus}` : ''} = ${top.total}.`
        : `Nobody in the raid reserved ${item.name}. Give it as main spec, off spec or a free roll.`,
    });
  });

  app.post('/api/raids/:id/award', needOfficer, async (req, res) => {
    const raid = raidOr404(req);
    if (raid.status === 'cancelled') throw new HttpError(409, 'This raid was cancelled.');
    const b = req.body || {};
    const g = req.guild;
    const kind = oneOf(b.kind, AWARD_KINDS, 'ms');

    // Who: a member (user_id) or a character name (a sign-up, a guild character, or anyone typed in).
    let userId = posId(b.user_id);
    let character = str(b.character, 40);
    if (userId) {
      if (!q.isMember.get(g.id, userId)) throw new HttpError(400, 'That person isn’t in the guild.');
      const signup = q.mySignup.get(raid.id, userId);
      if (signup) character = signup.character;
      else if (!character) {
        const main = q.mainOf.get(g.id, userId);
        const u = q.userName.get(userId);
        character = main ? main.name : shortName(u && u.battletag) || null;
      }
    } else if (character) {
      const signup = q.signupByCharacter.get(raid.id, character);
      const known = signup ? null : q.characterByName.get(g.id, character);
      if (signup) { userId = signup.user_id; character = signup.character; } else if (known) { userId = known.user_id || null; character = known.name; }
    }
    if (!userId && !character) throw new HttpError(400, 'Pick who gets it.');

    // What: a loot list item (item_id), or a name, matched to this instance's list when it can be.
    let itemId = posId(b.item_id);
    if (itemId && !q.lootItem.get(itemId, g.id)) throw new HttpError(404, 'That item isn’t on this raid’s loot list.');
    const itemName = str(b.item_name, 100);
    if (!itemId && itemName) {
      const match = q.itemByName.get(g.id, raid.instance, itemName);
      if (match) itemId = match.id;
    }
    const name = R.awardItem(db, raid, { itemId, itemName, userId, character, kind }); // 400 "Pick an item."
    const award = q.lastAward.get(raid.id);
    ctx.activity(g.id, 'loot', `${character || 'Someone'} received ${name}`);
    ctx.audit(req, 'loot given', `${name} → ${character || '?'} (${kind})`);
    await ctx.discord(g, `💎 **${name}** → ${character || 'someone'} (${kind.toUpperCase()}, ${raid.title})`);
    res.json({ ok: true, award, message: `${name} given to ${character || 'them'}.` });
  });

  // ---------- loot lists and history ----------

  app.get('/api/loot', needGuild, (req, res) => {
    const gid = req.guild.id;
    const byInstance = new Map();
    for (const item of q.catalog.all(gid)) {
      if (!byInstance.has(item.instance)) byInstance.set(item.instance, []);
      byInstance.get(item.instance).push(item);
    }
    res.json({
      lists: [...byInstance].map(([instance, items]) => ({ instance, items })),
      history: q.history.all(gid),
      myLoyalty: q.myLoyalty.all(gid, req.user.id),
    });
  });

  app.post('/api/loot/items', needOfficer, (req, res) => {
    const b = req.body || {};
    const instance = str(b.instance, 60);
    if (!instance) throw new HttpError(400, 'Name the instance.');
    const text = typeof b.text === 'string' ? b.text : typeof b.items === 'string' ? b.items : '';
    if (!text.trim()) throw new HttpError(400, 'Paste at least one item, one per line.');
    if (text.length > 100000) throw new HttpError(400, 'That list is too long. Add up to a few hundred items at a time.');
    const added = R.importItems(db, req.guild.id, instance, text);
    if (added) ctx.audit(req, 'loot list items added', `${added} to ${instance}`);
    res.json({
      added,
      instance,
      items: R.itemsForInstance(db, req.guild.id, instance),
      message: `${plural(added, 'item')} added to ${instance}.`,
    });
  });

  app.delete('/api/loot/items/:id', needOfficer, (req, res) => {
    const id = /^\d{1,12}$/.test(String(req.params.id)) ? Number(req.params.id) : null;
    const item = id ? q.lootItem.get(id, req.guild.id) : null;
    if (!item) throw new HttpError(404, 'That item isn’t on a loot list any more.');
    q.deleteItem.run(item.id); // reserves, bonuses and rolls for it go too; loot history keeps the name
    ctx.audit(req, 'loot list item removed', `${item.name} (${item.instance})`);
    res.json({ ok: true, message: `${item.name} removed.` });
  });

  // ---------- Discord links ----------
  // Discord posts, slash command answers and scheduled events link to <BASE_URL>/raids/<id>. Someone
  // opening that in a browser gets a small page pointing them at the app. It shows no raid details.
  app.get('/raids/:id', (req, res) => {
    const id = /^\d{1,12}$/.test(String(req.params.id)) ? req.params.id : null;
    if (!id) {
      return sendHtml(res, 404, htmlPage({ title: 'Not found', heading: 'That raid link doesn’t work', tone: 'error',
        body: '<p>Open Guild Camp and look under Raids.</p>' }));
    }
    sendHtml(res, 200, htmlPage({
      title: 'Raid sign-up',
      heading: 'Sign up in Guild Camp',
      body: `<p>Raid sign-ups and loot reserves live in the Guild Camp app.</p>
        <p><a href="guildcamp://raids/${esc(id)}"><strong>Open this raid in Guild Camp</strong></a></p>
        <p class="muted">Don’t have the app yet? <a href="/get">Get Guild Camp</a>.</p>`,
    }));
  });

  // ---------- one-hour reminders ----------
  // services/raids.js picks the raids and writes the messages. Only people signed up for a raid
  // (coming, maybe or bench) get the app notification; the Discord post is for everyone.
  function remindNow() {
    return R.remind(db, cfg, {
      notify: (guildId, kind, opts) => {
        const m = /^\/raids\/(\d+)$/.exec((opts && opts.route) || '');
        const userIds = m ? q.remindIds.all(Number(m[1])).map((r) => r.user_id) : [];
        return ctx.emit(guildId, kind, { ...opts, userIds });
      },
      discord: (guild, content) => ctx.discord(guild, content),
    });
  }
  ctx.services.raids = { remind: remindNow };
  if (cfg.timers) {
    const timer = setInterval(() => {
      remindNow().catch((e) => ctx.log.warn(`Raid reminders failed: ${e.message}`));
    }, REMINDER_EVERY_MS);
    if (typeof timer.unref === 'function') timer.unref();
    ctx.timers.push(timer);
  }
}

module.exports = { register, startFrom, readinessFlags, utcLabel };
