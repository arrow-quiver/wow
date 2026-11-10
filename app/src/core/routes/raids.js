// Raids and other scheduled events (PvP premades, guild events), sign-ups, soft reserves with the
// SR+ loyalty bonus, the officer loot screen (rolls and awards), loot lists and loot history, and the
// one-hour reminder. Ported from the old web/src/routes/raids.js. Shapes: docs/api/raids.md.
//
// The rules themselves live in services/raids.js (shared with tests and the inbox). This file adds
// validation, permissions, audit entries and activity lines.
//
// Raids are guild data shared through the addon (docs/SHARING.md §10). Every change here queues a record
// with sharing.queue(), which also remakes the rows (raids, signups, reserves, attendance, loot_items,
// loot_log, loyalty) at once, so the page shows the change straight away:
//   schedule → RD; lock / unlock / cancel / close → RT (compare-and-set on the stored version; the close
//   carries each attendee's reserves minus what they won, and the no-shows); sign-up and reserves → su;
//   award → LA; loot list edits → LL. Rolls stay on this computer; only the award travels.
// Guildmates are told by their own apps when the records reach them, and the Discord post for a new raid,
// a cancel or an award goes out when the game confirms the change (sharing.afterImport).
//
// Instance names match the way loot lists are keyed (S.instanceKey): "molten core" is the "Molten Core" list.
// A new raid takes the list's spelling when that list exists.
const S = require('../../shared/sharing');
const R = require('../services/raids');
const sharing = require('../sharing');
const { notElsewhere, looseLast } = require('../identity');
const {
  HttpError, str, int, oneOf, list, isOfficer, needGuild, needOfficer,
} = require('../http');
const { resistFor, ENCHANT_SLOTS } = require('../readiness');

const KINDS = ['raid', 'pvp', 'event'];
const ROLES = ['tank', 'healer', 'dps'];
const STATUSES = ['yes', 'tentative', 'no', 'bench'];
const AWARD_KINDS = ['sr', 'ms', 'os', 'free'];
const KIND_NAME = { raid: 'Raid', pvp: 'PvP', event: 'Event' };
// Readiness: below this repair percentage a sign-up is flagged (same line the old sign-up list drew).
const LOW_REPAIR = 30;
// A raid stays under "Coming up" for 6 hours after it starts, unless it was closed.
const UPCOMING_GRACE_MS = 6 * 3600 * 1000;
const REMINDER_EVERY_MS = 60 * 1000;
// A raid close records at most this many attendees and no-shows (docs/SHARING.md Appendix A, RT).
const CLOSE_MAX_PEOPLE = 60;
// Rows made before guild data was shared (no share_id) can be read but not changed.
const OLD_ROW = 'This was made with an older Guild Camp and can’t be changed. Make it again.';
const NO_CHARACTER = 'Log in to World of Warcraft on a character in your guild first, then log out or type /reload.';

const shortName = (battletag) => String(battletag || '').split('#')[0];
// A row id from a request (positive whole number), or null. (int() clamps, so 0 would become 1.)
const posId = (v) => { const n = int(v); return n && n > 0 ? n : null; };
const unix = (iso) => Math.floor(new Date(iso).getTime() / 1000);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// The start time from a request body, as ISO 8601 UTC, or null.
//   starts_at: "2026-12-09T18:00:00.000Z" (or any ISO time with a zone), what the app sends.
//   starts_at / starts without a zone ("2026-12-09T20:00") + tz_offset (getTimezoneOffset() minutes), like
//   the old form; without tz_offset this computer's time zone applies (cfg.defaultTzOffset).
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
    resist: resistFor(r.instance),
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

// Readiness flags shown next to a sign-up: no addon data, low repair, no consumables in bags, unspent talent
// points, and gear the Enchanting profession could enchant but hasn't (null = an older addon that doesn’t check).
function readinessFlags(ready) {
  if (!ready) return { noData: true, lowRepair: false, noConsumables: false, unspent: false, unenchanted: null };
  const total = Object.values(ready.consumables || {}).reduce((a, b) => a + (Number(b) || 0), 0);
  return {
    noData: false,
    lowRepair: ready.durability != null && Number(ready.durability) < LOW_REPAIR,
    noConsumables: total === 0,
    unspent: Boolean(ready.talents && ready.talents.unspent > 0),
    unenchanted: Array.isArray(ready.unenchanted) ? ready.unenchanted.map((id) => ENCHANT_SLOTS[id]).filter(Boolean) : null,
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
    // Loot list spellings first, so each instance is offered once, as its list spells it.
    instances: db.prepare(`SELECT instance, MIN(p) AS p FROM (SELECT instance, 0 AS p FROM loot_items WHERE guild_id = ?
      UNION ALL SELECT instance, 1 AS p FROM raids WHERE guild_id = ?) GROUP BY instance ORDER BY p, instance COLLATE NOCASE`),
    mySignup: db.prepare('SELECT * FROM signups WHERE raid_id = ? AND user_id = ?'),
    myCharacters: db.prepare(`SELECT name, class, level, is_main FROM characters WHERE guild_id = ? AND user_id = ? AND ${notElsewhere()} ORDER BY is_main DESC, level DESC, name`),
    raidItems: db.prepare(`SELECT li.*, ${WH_ID('li', 'li.name')} AS wh_id, COALESCE(l.bonus, 0) AS bonus,
        (SELECT COUNT(*) FROM reserves rv WHERE rv.raid_id = @raidId AND rv.item_id = li.id) AS reserved,
        EXISTS (SELECT 1 FROM reserves rv WHERE rv.raid_id = @raidId AND rv.item_id = li.id AND rv.user_id = @userId) AS mine
      FROM loot_items li LEFT JOIN loyalty l ON l.guild_id = li.guild_id AND l.item_id = li.id AND l.user_id = @userId
      WHERE li.guild_id = @guildId AND ${R.sameInstance('li.instance', '@instance')} ORDER BY li.boss, li.name`),
    raidLoot: (order) => `SELECT lg.*, ${WH_ID('li', 'lg.item_name')} AS wh_id FROM loot_log lg
      LEFT JOIN loot_items li ON li.id = lg.item_id WHERE lg.raid_id = ? ORDER BY lg.id ${order}`,
    attended: db.prepare('SELECT user_id FROM attendance WHERE raid_id = ?'),
    userName: db.prepare('SELECT battletag FROM users WHERE id = ?'),
    remindIds: db.prepare("SELECT user_id FROM signups WHERE raid_id = ? AND status IN ('yes','tentative','bench')"),
    memberIds: db.prepare('SELECT user_id FROM memberships WHERE guild_id = ?'),
    isMember: db.prepare('SELECT 1 FROM memberships WHERE guild_id = ? AND user_id = ?'),
    attending: db.prepare(`SELECT s.user_id, s.character, s.role, s.status, c.class FROM signups s
      LEFT JOIN characters c ON c.guild_id = ? AND c.name = s.character
      WHERE s.raid_id = ? AND s.status IN ('yes','bench') ORDER BY s.character COLLATE NOCASE`),
    lootItem: db.prepare('SELECT * FROM loot_items WHERE id = ? AND guild_id = ?'),
    itemByName: db.prepare(`SELECT id FROM loot_items WHERE guild_id = ? AND ${R.sameInstance('instance', '?')} AND lower(name) = lower(?)`),
    signupByCharacter: db.prepare('SELECT user_id, character FROM signups WHERE raid_id = ? AND lower(character) = lower(?)'),
    characterByName: db.prepare('SELECT user_id, name FROM characters WHERE guild_id = ? AND lower(name) = lower(?)'),
    mainOf: db.prepare(`SELECT name FROM characters WHERE guild_id = ? AND user_id = ? AND ${notElsewhere()} ORDER BY ${looseLast()}, is_main DESC, level DESC LIMIT 1`),
    award: db.prepare(`SELECT lg.*, ${WH_ID('li', 'lg.item_name')} AS wh_id FROM loot_log lg
      LEFT JOIN loot_items li ON li.id = lg.item_id WHERE lg.guild_id = ? AND lg.share_id = ?`),
    catalog: db.prepare(`SELECT li.*, ${WH_ID('li', 'li.name')} AS wh_id FROM loot_items li WHERE li.guild_id = ?
      ORDER BY li.instance COLLATE NOCASE, li.boss, li.name`),
    history: db.prepare(`SELECT l.*, r.title, r.kind AS raid_kind, ${WH_ID('li', 'l.item_name')} AS wh_id FROM loot_log l
      LEFT JOIN raids r ON r.id = l.raid_id LEFT JOIN loot_items li ON li.id = l.item_id
      WHERE l.guild_id = ? ORDER BY l.id DESC LIMIT 100`),
    myLoyalty: db.prepare(`SELECT li.id AS item_id, li.name, li.instance, li.boss, ${WH_ID('li', 'li.name')} AS wh_id, l.bonus
      FROM loyalty l JOIN loot_items li ON li.id = l.item_id
      WHERE l.guild_id = ? AND l.user_id = ? AND l.bonus > 0 ORDER BY l.bonus DESC, li.name`),
  };
  // Statements built from the SQL templates above.
  q.upcoming = db.prepare(q.listRaids("r.starts_at >= @cutoff AND r.status != 'done'", 'ASC', 20));
  q.past = db.prepare(q.listRaids("(r.starts_at < @cutoff OR r.status = 'done')", 'DESC', 20));
  q.lootAsc = db.prepare(q.raidLoot('ASC'));
  q.lootDesc = db.prepare(q.raidLoot('DESC'));

  const who = (req) => shortName(req.user.battletag);

  function raidOr404(req) {
    const id = /^\d{1,12}$/.test(String(req.params.id)) ? Number(req.params.id) : null;
    const raid = id ? R.raidFor(db, req.guild.id, id) : null;
    if (!raid) throw new HttpError(404, 'That raid was not found. It may have been removed.');
    return raid;
  }

  // The record key of a raid (its RD, RT and sign-ups). Rows from before sharing have none.
  function keyOf(raid) {
    if (!raid.share_id) throw new HttpError(409, OLD_ROW);
    return raid.share_id;
  }

  // My player id (made on my main character the first time): the key of my sign-ups.
  function myPid() {
    const pid = sharing.myPid(db);
    if (!pid) throw new HttpError(409, NO_CHARACTER);
    return pid;
  }
  // The player id of a member for a loot award (null for someone Guild Camp has no player for).
  const pidOfUser = (userId) => (userId === ctx.me().id ? sharing.myPid(db) : sharing.pidOf(db, userId));

  function summaryJson(r) {
    return {
      ...raidJson(r),
      counts: { tank: r.c_tank, healer: r.c_healer, dps: r.c_dps, tentative: r.c_tentative, bench: r.c_bench, no: r.c_no },
      mySignup: r.my_status ? { status: r.my_status, role: r.my_role, character: r.my_character } : null,
      myReserves: r.my_reserves,
    };
  }

  // ---------- list + schedule ----------

  // Each instance once (the loot list's spelling, else a raid's), in name order.
  function instanceList(guildId) {
    const seen = new Set();
    const out = [];
    for (const { instance } of q.instances.all(guildId, guildId)) {
      const k = S.instanceKey(instance);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      out.push(instance);
    }
    const low = (s) => s.toLowerCase();
    return out.sort((a, b) => (low(a) < low(b) ? -1 : low(a) > low(b) ? 1 : 0));
  }

  app.get('/api/raids', needGuild, (req, res) => {
    const params = { guildId: req.guild.id, userId: req.user.id, cutoff: new Date(Date.now() - UPCOMING_GRACE_MS).toISOString() };
    const upcoming = q.upcoming.all(params);
    const past = q.past.all(params);
    res.json({
      upcoming: upcoming.map(summaryJson),
      past: past.map(summaryJson),
      instances: instanceList(req.guild.id),
    });
  });

  app.post('/api/raids', needOfficer, (req, res) => {
    const b = req.body || {};
    const g = req.guild;
    const kind = oneOf(b.kind, KINDS, 'raid');
    const title = str(b.title, 60);
    const typed = str(b.instance, 60);
    // "molten core" when the guild has a "Molten Core" loot list: the raid takes the list's spelling.
    const instance = typed ? R.lootListOf(db, g.id, typed).name : null;
    const startsAt = startFrom(b, cfg.defaultTzOffset);
    if (!title || !instance || !startsAt) throw new HttpError(400, 'Fill in the name, instance and start time.');
    const size = int(b.size, 0, 40) || null;
    const sr = int(b.sr_limit, 0, 5);
    const srLimit = kind === 'raid' ? (sr === null ? 2 : sr) : 0; // only raids have reserves
    const duration = int(b.duration_min, 15, 24 * 60) ?? 180;
    const notes = str(b.notes, 300);

    const key = sharing.newKey();
    sharing.queue(db, ctx, {
      type: 'RD', key, need: 'o',
      fields: { kind: R.KIND_CODE[kind], title, instance, startsAt: unix(startsAt), minutes: duration, size, srLimit, notes: notes || '' },
    });
    const raid = R.raidByKey(db, g.id, key);
    ctx.activity(g.id, 'raid', `${who(req)} scheduled ${title}`);
    ctx.audit(req, `scheduled ${kind}`, `${title} (${startsAt})`);
    res.status(201).json({ raid: raidJson(raid), message: `${KIND_NAME[kind]} scheduled.` });
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
    // Reserves travel on my sign-up record: while I have none, the page asks me to sign up first.
    const reservable = raid.status === 'open' && (raid.kind || 'raid') === 'raid' && raid.sr_limit > 0 && items.length > 0;
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
      bossKills: require('../services/bosskills').forRaid(db, raid.guild_id, raid.id),
      canSignUp: open,
      canReserve: reservable && Boolean(mine),
      needsSignup: reservable && !mine,
      isOfficer: isOfficer(req),
    });
  });

  // My sign-up (su:<raid>:<my pid>). The reserves on it stay as they are.
  app.post('/api/raids/:id/signup', needGuild, (req, res) => {
    const raid = raidOr404(req);
    if (raid.status !== 'open' && raid.status !== 'locked') throw new HttpError(409, 'Sign-ups are closed for this raid.');
    const key = keyOf(raid);
    const b = req.body || {};
    const character = str(b.character, 40);
    if (!character) throw new HttpError(400, 'Pick a character.');
    const role = oneOf(b.role, ROLES, 'dps');
    const status = oneOf(b.status, STATUSES, 'yes');
    const note = str(b.note, 120);
    const pid = myPid();
    const before = q.mySignup.get(raid.id, req.user.id);
    const current = sharing.recordOf(db, req.guild.id, `su:${key}:${pid}`);
    sharing.queue(db, ctx, { type: 'su', key: `${key}:${pid}`, fields: R.signupFields(current, { character, role, status, note }) });
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

  // My reserves travel on my sign-up record, so reserving needs a sign-up first.
  app.post('/api/raids/:id/reserves', needGuild, (req, res) => {
    const raid = raidOr404(req);
    const key = keyOf(raid);
    const b = req.body || {};
    const picked = list(b.item_ids ?? b.items ?? b.item, 50);
    const keys = R.reserveKeys(db, raid, picked); // throws 409 locked / 400 too many or not on the list
    const pid = myPid();
    const current = sharing.recordOf(db, req.guild.id, `su:${key}:${pid}`);
    if (!current || current.del || !current.fields) throw new HttpError(409, 'Sign up for this raid first, then pick your reserves.');
    const fields = R.reserveFields(db, req.guild.id, current, keys, sharing.serverNow(db));
    if (fields) sharing.queue(db, ctx, { type: 'su', key: `${key}:${pid}`, fields });
    res.json({
      ok: true,
      myReserves: R.myReserves(db, raid, req.user.id),
      message: picked.length ? 'Reserves saved.' : 'Reserves cleared.',
    });
  });

  // ---------- officer actions ----------

  // The raid's status record (RT): an edit of what this computer holds (compare-and-set on the stored version).
  function queueStatus(raid, fields) {
    const key = keyOf(raid);
    sharing.queue(db, ctx, { type: 'RT', key, fields, need: 'o', base: sharing.baseOf(db, raid.guild_id, `RT:${key}`) });
  }

  const TRANSITIONS = {
    lock: {
      from: ['open'], audit: 'raid locked', done: () => 'Reserves locked.', refuse: 'Only raids with open reserves can be locked.',
      fields: () => ({ status: 'l', lockedAt: sharing.serverNow(db) }),
    },
    unlock: {
      from: ['locked'], audit: 'raid reopened', done: () => 'Reserves reopened.', refuse: 'Reserves aren’t locked for this raid.',
      fields: () => ({ status: 'o' }),
    },
    cancel: {
      from: ['open', 'locked'], audit: 'raid cancelled', done: (r) => `${KIND_NAME[r.kind] || 'Raid'} cancelled.`, refuse: 'Only upcoming raids can be cancelled.',
      fields: (r) => ({ status: 'x', lockedAt: r.locked_at ?? null }),
    },
  };
  for (const [verb, t] of Object.entries(TRANSITIONS)) {
    app.post(`/api/raids/:id/${verb}`, needOfficer, (req, res) => {
      const raid = raidOr404(req);
      if (!t.from.includes(raid.status)) throw new HttpError(409, t.refuse);
      queueStatus(raid, t.fields(raid));
      ctx.audit(req, t.audit, raid.title);
      res.json({ ok: true, raid: raidJson(R.raidFor(db, req.guild.id, raid.id)), message: t.done(raid) });
    });
  }

  app.post('/api/raids/:id/close', needOfficer, (req, res) => {
    const raid = raidOr404(req);
    if (raid.status === 'cancelled') throw new HttpError(409, 'Cancelled raids can’t be closed.');
    if (raid.status === 'done') throw new HttpError(409, 'This raid is already closed.');
    const key = keyOf(raid);
    const b = req.body || {};
    // Only people in the guild can be marked as attending.
    const members = new Set(q.memberIds.all(req.guild.id).map((r) => r.user_id));
    const attendees = [...new Set(list(b.attendee_user_ids ?? b.attended, 200).map(posId).filter((id) => id && members.has(id)))];
    myPid(); // the officer closing the raid has a player id, so they can be on the list
    const fields = sharing.raidCloseFields(db, req.guild.id, key, attendees);
    if (fields.attendees.length > CLOSE_MAX_PEOPLE || fields.noShows.length > CLOSE_MAX_PEOPLE) {
      throw new HttpError(400, `A raid can record up to ${CLOSE_MAX_PEOPLE} people who came and ${CLOSE_MAX_PEOPLE} who didn’t.`);
    }
    queueStatus(raid, fields);
    const attended = fields.attendees.length;
    const noShows = fields.noShows.length;
    ctx.activity(req.guild.id, 'raid', `${raid.title} finished with ${attended} raiders`);
    ctx.audit(req, 'raid closed', `${raid.title}: ${attended} attended, ${noShows} no-shows`);
    res.json({
      ok: true,
      raid: raidJson(R.raidFor(db, req.guild.id, raid.id)),
      attended,
      noShows,
      message: `${KIND_NAME[raid.kind] || 'Raid'} closed. ${attended} attended${noShows ? `, ${plural(noShows, 'no-show')}` : ''}.${(raid.kind || 'raid') === 'raid' ? ' Bonuses updated.' : ''}`,
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

  // Rolls stay on this computer: only the award that follows is shared.
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

  app.post('/api/raids/:id/award', needOfficer, (req, res) => {
    const raid = raidOr404(req);
    if (raid.status === 'cancelled') throw new HttpError(409, 'This raid was cancelled.');
    keyOf(raid);
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
    const { name, item, fields } = R.awardFields(db, raid, { itemId, itemName, userId, character, kind, pid: userId ? pidOfUser(userId) : null }); // 400 "Pick an item."
    const key = sharing.newKey();
    db.transaction(() => {
      sharing.queue(db, ctx, { type: 'LA', key, fields, need: 'o' });
      // Given out: the rolls for it are done (the reserve and the bonus follow from the award).
      if (item && userId) R.clearRolls(db, raid, item.id);
    })();
    const award = q.award.get(g.id, key);
    ctx.activity(g.id, 'loot', `${character || 'Someone'} received ${name}`);
    ctx.audit(req, 'loot given', `${name} → ${character || '?'} (${kind})`);
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

  // A loot list is one record per instance (LL), edited on top of the version this computer holds.
  function queueList(guildId, list) {
    sharing.queue(db, ctx, { type: 'LL', key: list.key, fields: R.lootListFields(list), need: 'o', base: sharing.baseOf(db, guildId, `LL:${list.key}`) });
  }

  app.post('/api/loot/items', needOfficer, (req, res) => {
    const b = req.body || {};
    const instance = str(b.instance, 60);
    if (!instance) throw new HttpError(400, 'Name the instance.');
    const text = typeof b.text === 'string' ? b.text : typeof b.items === 'string' ? b.items : '';
    if (!text.trim()) throw new HttpError(400, 'Paste at least one item, one per line.');
    if (text.length > 100000) throw new HttpError(400, 'That list is too long. Add up to a few hundred items at a time.');
    const gid = req.guild.id;
    const list = R.lootListOf(db, gid, instance);
    const before = JSON.stringify(list.items);
    const added = R.mergeLootLines(list, R.parseLootLines(text));
    if (JSON.stringify(list.items) !== before) queueList(gid, list);
    if (added) ctx.audit(req, 'loot list items added', `${added} to ${list.name}`);
    res.json({
      added,
      instance: list.name,
      items: R.itemsForInstance(db, gid, list.name),
      message: `${plural(added, 'item')} added to ${list.name}.`,
    });
  });

  app.delete('/api/loot/items/:id', needOfficer, (req, res) => {
    const id = /^\d{1,12}$/.test(String(req.params.id)) ? Number(req.params.id) : null;
    const item = id ? q.lootItem.get(id, req.guild.id) : null;
    if (!item) throw new HttpError(404, 'That item isn’t on a loot list any more.');
    const list = R.lootListOf(db, req.guild.id, item.instance);
    const key = R.itemKeyOf(item);
    const lower = item.name.toLowerCase();
    list.items = list.items.filter((it) => it.key !== key && it.name.toLowerCase() !== lower);
    queueList(req.guild.id, list); // reserves and bonuses for it go too; loot history keeps the name
    ctx.audit(req, 'loot list item removed', `${item.name} (${item.instance})`);
    res.json({ ok: true, message: `${item.name} removed.` });
  });

  // ---------- one-hour reminders ----------
  // services/raids.js picks the raids and writes the messages. Only people signed up for a raid
  // (coming, maybe or bench) get the app notification; the Discord post goes out only for raids I made.
  function remindNow() {
    return R.remind(db, cfg, {
      notify: (guildId, kind, opts) => {
        const m = /^\/raids\/(\d+)$/.exec((opts && opts.route) || '');
        const userIds = m ? q.remindIds.all(Number(m[1])).map((r) => r.user_id) : [];
        return ctx.emit(guildId, kind, { ...opts, userIds });
      },
      discord: (guild, content) => ctx.discord(guild, content),
      meId: ctx.me().id,
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

module.exports = { register, startFrom, readinessFlags };
