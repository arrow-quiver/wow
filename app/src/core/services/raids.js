// Raid and soft-reserve (SR+) rules. Ported from the old web/src/raids.js, plus toUtc and the
// one-hour reminder job from the old routes/raids.js and roleCounts from the old views.
//
// SR+ in one paragraph: each raider reserves up to `sr_limit` items per raid.
// When an item drops, only the people who reserved it roll, and each adds their
// loyalty bonus. Bonus grows by +10 for every raid you attend with that item
// reserved and don't win it. Winning it resets it. Signing up "yes" and not
// showing resets your bonus for that raid's instance. Skipping a raid you
// didn't sign up for leaves it alone.
//
// Guild data is shared through the addon (docs/SHARING.md). Raids, sign-ups, reserves, loot lists, awards,
// attendance and loyalty are rows made from shared records (core/share/project.js); the routes change them
// by queueing records (core/sharing.js queue()). This file reads the rows and builds the records' fields.
// Rolls stay on the officer's computer (loot_rolls); only the award travels.
//
// Exports: reading rows
//   BONUS_STEP (10)
//   sameInstance(column, param) → SQL condition: the instance names match by the loot lists' rule (S.instanceKey:
//       letters A–Z in any case, blanks around the name ignored), so "molten core" finds the "Molten Core" list
//   raidFor(db, guildId, raidId) → raids row | undefined          raidByKey(db, guildId, shareId) → raids row | undefined
//   itemsForInstance(db, guildId, instance) → loot_items rows + wh_id (Wowhead item id, from item_names when unset)
//   bonusOf(db, guildId, userId, lootItemId) → number
//   myReserves(db, raid, userId) → loot_items rows + bonus
//   reserveBoard(db, raid) → [{ item_id, item, boss, wh_id, reservers: [{ user_id, battletag, character, bonus, signup, ... }] }]
//   rollItem(db, raid, lootItemId, rng = Math.random) → rollsFor(...)   1–100 + bonus for reservers who are 'yes' or 'bench'
//   rollsFor(db, raid, lootItemId) → loot_rolls rows + total, battletag, character (highest total first)
//   clearRolls(db, raid, lootItemId)                     the item was given out: its rolls are done
//   signupsFor(db, raid) → signups + battletag, class, level, readiness, ready (parsed), sorted tank/healer/dps
//   roleCounts(signups) → { tank, healer, dps } counting status 'yes'
//   toUtc(local 'YYYY-MM-DDTHH:MM', tzOffsetMinutes, fallbackOffset) → ISO UTC string | null
//       tzOffset is JavaScript's getTimezoneOffset() (minutes, UTC+2 → -120); '' or missing uses the fallback.
//   remind(db, cfg, { notify, discord, meId }) → Promise<number of raids reminded>
//       Once per raid, for open/locked raids starting within the next hour.
// Exports: record fields (names as in shared/sharing.js TYPES)
//   KIND_CODE, ROLE_CODE, STATUS_CODE, AWARD_CODE   app words → record letters
//   itemKeyOf(lootItemRow) → item key ('d72' for item 17102, else 'h' + a hash of the name)
//   reserveKeys(db, raid, lootItemIds) → [itemKey]   throws HttpError 409 (locked) / 400 (too many, not on the list)
//   signupFields(currentSu, { character, role, status, note }) → su fields (the reserves stay as they are)
//   reserveFields(db, guildId, currentSu, itemKeys, now) → su fields | null (null: the same picks as now)
//   parseLootLines(text) → [{ boss, name, itemId }]  ("Boss | Item", "Item", optionally "| 12345" or a Wowhead link)
//   lootListOf(db, guildId, instance) → { key, name, items: [{ key, boss, name }] }   the shared list, else the rows
//   mergeLootLines(list, lines) → number of new items (list changes in place)
//   lootListFields(list) → LL fields { name, bosses, items }   throws HttpError 400 when over the shared limits
//   awardFields(db, raid, { itemId, itemName, character, kind, pid }) → { name, item, fields }   throws 400 "Pick an item."
// The old server's direct-write rules (setReserves, awardItem, closeRaid, importItems) are kept at the end
// as the reference the shared SR+ fold is tested against (test/sharing-derived.test.js); the app never calls them.
// Injected dependencies (remind only; routes pass ctx's helpers):
//   notify(guildId, kind, opts)  ctx.emit shape → notify(guildId, 'raid', { title, body, route: '/raids/<id>' })
//   discord(raidRow, content)    ctx.discord shape. Awaited; must not throw. Only for raids that meId created:
//                                each app posts only what its own player does.
const S = require('../../shared/sharing');
const sharing = require('../sharing');
const { HttpError } = require('../http');

const BONUS_STEP = 10;
const KIND_CODE = Object.freeze({ raid: 'r', pvp: 'p', event: 'e' });
const ROLE_CODE = Object.freeze({ tank: 't', healer: 'h', dps: 'd' });
const STATUS_CODE = Object.freeze({ yes: 'y', tentative: 't', no: 'n', bench: 'b' });
const AWARD_CODE = Object.freeze({ sr: 's', ms: 'm', os: 'o', free: 'f' });
// What a shared loot list can hold (docs/SHARING.md Appendix A, LL).
const LIST_MAX_ITEMS = 150;
const LIST_MAX_BOSSES = 40;

// S.instanceKey compares names lower-cased (ASCII letters only, as SQLite's lower()) and trimmed of blanks.
const BLANKS = 'char(32, 9, 13, 10)';
const sameInstance = (column, param) => `lower(trim(${column}, ${BLANKS})) = lower(trim(${param}, ${BLANKS}))`;

function raidFor(db, guildId, raidId) {
  return db.prepare('SELECT * FROM raids WHERE id = ? AND guild_id = ?').get(raidId, guildId);
}

function raidByKey(db, guildId, key) {
  return db.prepare('SELECT * FROM raids WHERE guild_id = ? AND share_id = ?').get(guildId, key);
}

function itemsForInstance(db, guildId, instance) {
  return db.prepare(`SELECT li.*, COALESCE(li.item_id, (SELECT n.item_id FROM item_names n WHERE n.name = li.name LIMIT 1)) AS wh_id
    FROM loot_items li WHERE li.guild_id = ? AND ${sameInstance('li.instance', '?')} ORDER BY li.boss, li.name`).all(guildId, instance);
}

function bonusOf(db, guildId, userId, itemId) {
  const r = db.prepare('SELECT bonus FROM loyalty WHERE guild_id = ? AND user_id = ? AND item_id = ?').get(guildId, userId, itemId);
  return r ? r.bonus : 0;
}

function myReserves(db, raid, userId) {
  return db.prepare(`SELECT li.*, COALESCE(l.bonus, 0) AS bonus FROM reserves r JOIN loot_items li ON li.id = r.item_id
    LEFT JOIN loyalty l ON l.guild_id = ? AND l.user_id = r.user_id AND l.item_id = r.item_id
    WHERE r.raid_id = ? AND r.user_id = ? ORDER BY li.boss, li.name`).all(raid.guild_id, raid.id, userId);
}

// Every item with at least one reserve, with who reserved it and their bonus.
function reserveBoard(db, raid) {
  const rows = db.prepare(`SELECT li.id AS item_id, li.name AS item, li.boss, COALESCE(li.item_id, (SELECT n.item_id FROM item_names n WHERE n.name = li.name LIMIT 1)) AS wh_id, r.user_id, u.battletag,
      COALESCE(s.character, '') AS character, COALESCE(l.bonus, 0) AS bonus, s.status AS signup
    FROM reserves r JOIN loot_items li ON li.id = r.item_id JOIN users u ON u.id = r.user_id
    LEFT JOIN signups s ON s.raid_id = r.raid_id AND s.user_id = r.user_id
    LEFT JOIN loyalty l ON l.guild_id = ? AND l.user_id = r.user_id AND l.item_id = r.item_id
    WHERE r.raid_id = ? ORDER BY li.boss, li.name, bonus DESC`).all(raid.guild_id, raid.id);
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.item_id)) map.set(r.item_id, { item_id: r.item_id, item: r.item, boss: r.boss, wh_id: r.wh_id, reservers: [] });
    map.get(r.item_id).reservers.push(r);
  }
  return [...map.values()];
}

// Roll 1–100 for everyone who reserved the item and is in the raid (yes or bench).
function rollItem(db, raid, itemId, rng = Math.random) {
  const reservers = db.prepare(`SELECT r.user_id FROM reserves r JOIN signups s ON s.raid_id = r.raid_id AND s.user_id = r.user_id
    WHERE r.raid_id = ? AND r.item_id = ? AND s.status IN ('yes','bench')`).all(raid.id, itemId);
  db.transaction(() => {
    db.prepare('DELETE FROM loot_rolls WHERE raid_id = ? AND item_id = ?').run(raid.id, itemId);
    const ins = db.prepare('INSERT INTO loot_rolls (raid_id, item_id, user_id, roll, bonus) VALUES (?,?,?,?,?)');
    for (const r of reservers) ins.run(raid.id, itemId, r.user_id, 1 + Math.floor(rng() * 100), bonusOf(db, raid.guild_id, r.user_id, itemId));
  })();
  return rollsFor(db, raid, itemId);
}

function rollsFor(db, raid, itemId) {
  return db.prepare(`SELECT lr.*, lr.roll + lr.bonus AS total, u.battletag, s.character FROM loot_rolls lr
    JOIN users u ON u.id = lr.user_id LEFT JOIN signups s ON s.raid_id = lr.raid_id AND s.user_id = lr.user_id
    WHERE lr.raid_id = ? AND lr.item_id = ? ORDER BY total DESC, lr.roll DESC`).all(raid.id, itemId);
}

function clearRolls(db, raid, itemId) {
  db.prepare('DELETE FROM loot_rolls WHERE raid_id = ? AND item_id = ?').run(raid.id, itemId);
}

const ROLE_ORDER = { tank: 0, healer: 1, dps: 2 };

function signupsFor(db, raid) {
  const rows = db.prepare(`SELECT s.*, u.battletag, c.class, c.level, c.readiness FROM signups s JOIN users u ON u.id = s.user_id
    LEFT JOIN characters c ON c.guild_id = ? AND c.name = s.character
    WHERE s.raid_id = ? ORDER BY s.status, s.role, s.character`).all(raid.guild_id, raid.id);
  for (const r of rows) {
    try { r.ready = r.readiness ? JSON.parse(r.readiness) : null; } catch { r.ready = null; }
  }
  return rows.sort((a, b) => (ROLE_ORDER[a.role] - ROLE_ORDER[b.role]) || a.character.localeCompare(b.character));
}

// Sign-ups with status 'yes', per role.
function roleCounts(signups) {
  const c = { tank: 0, healer: 0, dps: 0 };
  for (const s of signups) if (s.status === 'yes' && s.role in c) c[s.role] += 1;
  return c;
}

// Local date/time ("2026-12-09T20:00", as an <input type="datetime-local"> gives it) plus the
// client's getTimezoneOffset() → ISO UTC. The fallback offset is cfg.defaultTzOffset.
function toUtc(local, tzOffset, fallbackOffset) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(local || ''));
  if (!m) return null;
  const off = Number.isFinite(Number(tzOffset)) && tzOffset !== null && String(tzOffset) !== '' ? Number(tzOffset) : fallbackOffset;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) + (Number(off) || 0) * 60000;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const unix = (iso) => Math.floor(new Date(iso).getTime() / 1000);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// One-hour reminders: an app notification for the guild and a Discord post, once per raid.
async function remind(db, cfg, { notify, discord, meId = null } = {}) {
  const soon = db.prepare(`SELECT r.* FROM raids r
    WHERE r.reminded = 0 AND r.status IN ('open','locked') AND r.starts_at <= ? AND r.starts_at > ?`)
    .all(new Date(Date.now() + 3600 * 1000).toISOString(), new Date().toISOString());
  const counts = db.prepare('SELECT role, status FROM signups WHERE raid_id = ?');
  for (const r of soon) {
    db.prepare('UPDATE raids SET reminded = 1 WHERE id = ?').run(r.id);
    const c = roleCounts(counts.all(r.id));
    if (notify) notify(r.guild_id, 'raid', { title: `⏰ ${r.title} starts in an hour`, body: `${c.tank} tanks, ${c.healer} healers, ${c.dps} damage signed up.`, route: `/raids/${r.id}` });
    if (discord && (meId == null || r.created_by === meId)) {
      await discord(r, `⏰ **${r.title}** starts <t:${unix(r.starts_at)}:R>. ${plural(c.tank, 'tank')}, ${plural(c.healer, 'healer')}, ${c.dps} damage signed up. Sign up in Guild Camp.`);
    }
  }
  return soon.length;
}

// ---------------------------------------------------------------------------------------------
// Record fields

// The item key of a loot_items row, the way the loot list projection matches rows (share/project.js itemMap).
function itemKeyOf(row) {
  if (!row) return '';
  if (row.item_key) return row.item_key;
  return row.item_id ? S.itemKey(Number(row.item_id)) : S.itemKey(String(row.name || ''));
}

const sameList = (a, b) => {
  const x = [...new Set(a || [])].sort();
  const y = [...new Set(b || [])].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

// A member's picks (loot_items ids) checked against the raid, in the old order: locked, too many, not listed.
function reserveKeys(db, raid, itemIds) {
  if (raid.status !== 'open') throw new HttpError(409, 'Reserves are locked for this raid.');
  const ids = [...new Set(itemIds.map(Number).filter(Boolean))];
  if (ids.length > raid.sr_limit) throw new HttpError(400, `You can reserve up to ${raid.sr_limit} item${raid.sr_limit === 1 ? '' : 's'}.`);
  const byId = new Map(itemsForInstance(db, raid.guild_id, raid.instance).map((i) => [i.id, i]));
  const keys = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) throw new HttpError(400, 'That item isn’t on this raid’s loot list.');
    keys.push(itemKeyOf(row));
  }
  return [...new Set(keys)];
}

const liveFields = (rec) => (rec && !rec.del && rec.fields ? rec.fields : null);

// A changed sign-up (character, role, coming?, note). Reserves, and when they were picked, stay as they are.
function signupFields(current, { character, role, status, note }) {
  const f = liveFields(current) || {};
  return {
    character,
    role: ROLE_CODE[role] || 'd',
    status: STATUS_CODE[status] || 'y',
    note: note || '',
    reserves: Array.isArray(f.reserves) ? f.reserves : [],
    reservesAt: f.reservesAt ?? null,
    prev: Array.isArray(f.prev) ? f.prev : [],
    prevAt: f.prevAt ?? null,
  };
}

// New reserve picks (§4.4): the list they replace goes into prev, so picks made before a lock still count
// when this change reaches the guild after the lock. When the replaced list never left this computer (it is
// only in a change still waiting to be sent), that change's own prev is kept instead.
function reserveFields(db, guildId, current, keys, now) {
  const f = liveFields(current);
  if (!f) return null;
  const cur = Array.isArray(f.reserves) ? f.reserves : [];
  if (sameList(cur, keys)) return null;
  let shared = !current.pending;
  if (!shared) {
    const row = db.prepare("SELECT body FROM shared_records WHERE guild_id = ? AND id = ? AND state = 'ok'").get(guildId, current.id);
    const stored = liveFields(row ? S.decode(row.body) : null);
    shared = Boolean(stored && sameList(stored.reserves, cur) && (stored.reservesAt ?? null) === (f.reservesAt ?? null));
  }
  const fields = { ...f, reserves: keys, reservesAt: now };
  if (shared) {
    fields.prev = cur;
    fields.prevAt = cur.length ? (f.reservesAt ?? current.t) : (f.reservesAt ?? null);
  }
  return fields;
}

// "Boss | Item" per line (boss optional), optionally followed by "| 12345" or a Wowhead link for the tooltip.
function parseLootLines(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    let parts = line.split('|').map((s) => s.trim()).filter(Boolean);
    if (!parts.length) continue;
    let itemId = null;
    const last = parts[parts.length - 1];
    const m = /item=(\d+)/.exec(last) || /^(\d{2,7})$/.exec(last);
    if (m && parts.length > 1) { itemId = Number(m[1]); parts = parts.slice(0, -1); }
    const [boss, name] = parts.length > 1 ? [parts[0], parts.slice(1).join(' | ')] : [null, parts[0]];
    if (!name || name.length > 100) continue;
    out.push({ boss: boss ? boss.slice(0, 60) : null, name, itemId });
  }
  return out;
}

// The loot list of an instance as the guild shares it (the LL record, my own pending change included), else
// the rows typed in before sharing, so the first shared edit carries the whole list.
function lootListOf(db, guildId, instance) {
  const key = S.instanceKey(instance);
  const rec = sharing.recordOf(db, guildId, `LL:${key}`);
  const f = liveFields(rec);
  if (f) {
    const bosses = Array.isArray(f.bosses) ? f.bosses : [];
    const items = (Array.isArray(f.items) ? f.items : []).filter((it) => it && it.item)
      .map((it) => ({ key: it.item, boss: it.boss ? bosses[it.boss - 1] || null : null, name: it.name || `Item ${it.item}` }));
    return { key, name: f.name || instance, items };
  }
  const rows = db.prepare('SELECT * FROM loot_items WHERE guild_id = ? ORDER BY boss, name, id').all(guildId)
    .filter((r) => S.instanceKey(r.instance) === key);
  const exact = rows.find((r) => r.instance === instance);
  return {
    key,
    name: (exact || rows[0] || { instance }).instance,
    items: rows.map((r) => ({ key: itemKeyOf(r), boss: r.boss || null, name: r.name })),
  };
}

// Adds pasted lines to a list. An item already on it (same name in any capitalisation, or the same game item)
// keeps its key, so reserves and bonuses on it stay; a boss given on the line moves it to that boss.
function mergeLootLines(list, lines) {
  let added = 0;
  for (const line of lines) {
    const key = line.itemId ? S.itemKey(line.itemId) : S.itemKey(line.name);
    if (!key) continue;
    const lower = line.name.toLowerCase();
    const have = list.items.find((it) => it.name.toLowerCase() === lower) || list.items.find((it) => it.key === key);
    if (have) {
      if (line.boss) have.boss = line.boss;
      continue;
    }
    list.items.push({ key, boss: line.boss || null, name: line.name });
    added += 1;
  }
  return added;
}

function lootListFields(list) {
  if (list.items.length > LIST_MAX_ITEMS) throw new HttpError(400, `A loot list can hold up to ${LIST_MAX_ITEMS} items. Remove some first.`);
  const bosses = [];
  const items = list.items.map((it) => {
    let boss = 0;
    if (it.boss) {
      let i = bosses.indexOf(it.boss);
      if (i < 0) { bosses.push(it.boss); i = bosses.length - 1; }
      boss = i + 1;
    }
    return { item: it.key, boss, name: it.name };
  });
  if (bosses.length > LIST_MAX_BOSSES) throw new HttpError(400, `A loot list can name up to ${LIST_MAX_BOSSES} bosses.`);
  return { name: list.name, bosses, items };
}

// An LA record's fields. The roll and bonus come from the rolls made on this computer.
function awardFields(db, raid, { itemId, itemName, character, kind, pid, userId }) {
  const item = itemId ? db.prepare('SELECT * FROM loot_items WHERE id = ? AND guild_id = ?').get(itemId, raid.guild_id) : null;
  const name = item ? item.name : String(itemName || '').trim();
  if (!name) throw new HttpError(400, 'Pick an item.');
  const roll = item && userId ? db.prepare('SELECT roll, bonus FROM loot_rolls WHERE raid_id = ? AND item_id = ? AND user_id = ?').get(raid.id, item.id, userId) : null;
  return {
    name,
    item,
    fields: {
      raid: raid.share_id,
      instance: S.instanceKey(raid.instance),
      item: item ? itemKeyOf(item) : S.itemKey(name),
      itemName: name,
      character: character || '',
      pid: pid || '',
      kind: AWARD_CODE[kind] || 'm',
      roll: roll ? roll.roll : null,
      bonus: roll ? roll.bonus : 0,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The old server's direct-write rules. The app no longer calls these: shared rows change only through
// records (routes/raids.js → sharing.queue()). They stay as the reference that the shared SR+ fold
// (shared/sharing.js loyaltyFold) is checked against, and for tests that build a database by hand.

function setReserves(db, raid, userId, itemIds) {
  if (raid.status !== 'open') throw new HttpError(409, 'Reserves are locked for this raid.');
  const ids = [...new Set(itemIds.map(Number).filter(Boolean))];
  if (ids.length > raid.sr_limit) throw new HttpError(400, `You can reserve up to ${raid.sr_limit} item${raid.sr_limit === 1 ? '' : 's'}.`);
  const valid = new Set(itemsForInstance(db, raid.guild_id, raid.instance).map((i) => i.id));
  for (const id of ids) if (!valid.has(id)) throw new HttpError(400, 'That item isn’t on this raid’s loot list.');
  db.transaction(() => {
    db.prepare('DELETE FROM reserves WHERE raid_id = ? AND user_id = ?').run(raid.id, userId);
    const ins = db.prepare('INSERT INTO reserves (raid_id, user_id, item_id) VALUES (?,?,?)');
    for (const id of ids) ins.run(raid.id, userId, id);
  })();
}

function awardItem(db, raid, { itemId, itemName, userId, character, kind }) {
  const item = itemId ? db.prepare('SELECT * FROM loot_items WHERE id = ? AND guild_id = ?').get(itemId, raid.guild_id) : null;
  const name = item ? item.name : String(itemName || '').trim();
  if (!name) throw new HttpError(400, 'Pick an item.');
  const roll = item && userId ? db.prepare('SELECT roll, bonus FROM loot_rolls WHERE raid_id = ? AND item_id = ? AND user_id = ?').get(raid.id, item.id, userId) : null;
  db.transaction(() => {
    db.prepare(`INSERT INTO loot_log (guild_id, raid_id, item_id, item_name, user_id, character, kind, roll, bonus)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(raid.guild_id, raid.id, item ? item.id : null, name, userId || null, character || null,
      kind, roll ? roll.roll : null, roll ? roll.bonus : 0);
    if (item && userId) {
      // Won it: the reserve is fulfilled and the loyalty bonus resets.
      db.prepare('DELETE FROM loyalty WHERE guild_id = ? AND user_id = ? AND item_id = ?').run(raid.guild_id, userId, item.id);
      db.prepare('DELETE FROM reserves WHERE raid_id = ? AND user_id = ? AND item_id = ?').run(raid.id, userId, item.id);
      db.prepare('DELETE FROM loot_rolls WHERE raid_id = ? AND item_id = ?').run(raid.id, item.id);
    }
  })();
  return name;
}

// Close the raid: record who attended and settle loyalty bonuses. Only raids settle SR+ loyalty: PvP premades
// and guild events have no reserves, so closing one must leave the instance's bonuses alone.
function closeRaid(db, raid, attendeeIds) {
  if (raid.status === 'done') throw new HttpError(409, 'This raid is already closed.');
  const attendees = new Set(attendeeIds.map(Number).filter(Boolean));
  const settles = (raid.kind || 'raid') === 'raid';
  const instanceItems = settles ? itemsForInstance(db, raid.guild_id, raid.instance).map((r) => r.id) : [];
  let noShowCount = 0;
  db.transaction(() => {
    const insAtt = db.prepare('INSERT OR IGNORE INTO attendance (raid_id, user_id) VALUES (?,?)');
    const bump = db.prepare(`INSERT INTO loyalty (guild_id, user_id, item_id, bonus) VALUES (?,?,?,?)
      ON CONFLICT (guild_id, user_id, item_id) DO UPDATE SET bonus = bonus + ?`);
    const drop = db.prepare('DELETE FROM loyalty WHERE guild_id = ? AND user_id = ? AND item_id = ?');
    const reservedBy = (uid) => new Set(db.prepare('SELECT item_id FROM reserves WHERE raid_id = ? AND user_id = ?').all(raid.id, uid).map((r) => r.item_id));

    for (const uid of attendees) {
      insAtt.run(raid.id, uid);
      const mine = reservedBy(uid);
      for (const itemId of instanceItems) {
        if (mine.has(itemId)) bump.run(raid.guild_id, uid, itemId, BONUS_STEP, BONUS_STEP);
        else drop.run(raid.guild_id, uid, itemId); // switched reserve: streak ends
      }
    }
    // Signed up "yes" but didn't come: bonus for this instance resets.
    const noShows = db.prepare("SELECT user_id FROM signups WHERE raid_id = ? AND status = 'yes'").all(raid.id).map((r) => r.user_id).filter((u) => !attendees.has(u));
    noShowCount = noShows.length;
    for (const uid of noShows) for (const itemId of instanceItems) drop.run(raid.guild_id, uid, itemId);
    db.prepare("UPDATE raids SET status = 'done' WHERE id = ?").run(raid.id);
  })();
  return { attended: attendees.size, noShows: noShowCount };
}

function importItems(db, guildId, instance, text) {
  const ins = db.prepare(`INSERT INTO loot_items (guild_id, instance, boss, name, item_id) VALUES (?,?,?,?,?)
    ON CONFLICT (guild_id, instance, name) DO UPDATE SET item_id = COALESCE(excluded.item_id, item_id), boss = COALESCE(excluded.boss, boss)`);
  const exists = db.prepare('SELECT 1 FROM loot_items WHERE guild_id = ? AND instance = ? AND name = ?');
  let added = 0;
  db.transaction(() => {
    for (const { boss, name, itemId } of parseLootLines(text)) {
      const isNew = !exists.get(guildId, instance, name);
      ins.run(guildId, instance, boss, name, itemId);
      if (isNew) added += 1;
    }
  })();
  return added;
}

module.exports = {
  BONUS_STEP, KIND_CODE, ROLE_CODE, STATUS_CODE, AWARD_CODE, sameInstance,
  raidFor, raidByKey, itemsForInstance, bonusOf, myReserves, reserveBoard,
  rollItem, rollsFor, clearRolls, signupsFor, roleCounts, toUtc, remind,
  itemKeyOf, reserveKeys, signupFields, reserveFields, parseLootLines, lootListOf, mergeLootLines, lootListFields, awardFields,
  setReserves, awardItem, closeRaid, importItems,
};
