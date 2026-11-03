// Raid and soft-reserve (SR+) rules.
//
// SR+ in one paragraph: each raider reserves up to `sr_limit` items per raid.
// When an item drops, only the people who reserved it roll, and each adds their
// loyalty bonus. Bonus grows by +10 for every raid you attend with that item
// reserved and don't win it. Winning it resets it. Signing up "yes" and not
// showing resets your bonus for that raid's instance. Skipping a raid you
// didn't sign up for leaves it alone.

const BONUS_STEP = 10;

function raidFor(db, guildId, raidId) {
  return db.prepare('SELECT * FROM raids WHERE id = ? AND guild_id = ?').get(raidId, guildId);
}

function itemsForInstance(db, guildId, instance) {
  return db.prepare('SELECT * FROM loot_items WHERE guild_id = ? AND instance = ? ORDER BY boss, name').all(guildId, instance);
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
  const rows = db.prepare(`SELECT li.id AS item_id, li.name AS item, li.boss, r.user_id, u.battletag,
      COALESCE(s.character, '') AS character, COALESCE(l.bonus, 0) AS bonus, s.status AS signup
    FROM reserves r JOIN loot_items li ON li.id = r.item_id JOIN users u ON u.id = r.user_id
    LEFT JOIN signups s ON s.raid_id = r.raid_id AND s.user_id = r.user_id
    LEFT JOIN loyalty l ON l.guild_id = ? AND l.user_id = r.user_id AND l.item_id = r.item_id
    WHERE r.raid_id = ? ORDER BY li.boss, li.name, bonus DESC`).all(raid.guild_id, raid.id);
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.item_id)) map.set(r.item_id, { item_id: r.item_id, item: r.item, boss: r.boss, reservers: [] });
    map.get(r.item_id).reservers.push(r);
  }
  return [...map.values()];
}

function setReserves(db, raid, userId, itemIds) {
  if (raid.status !== 'open') throw new Error('Reserves are locked for this raid.');
  const ids = [...new Set(itemIds.map(Number).filter(Boolean))];
  if (ids.length > raid.sr_limit) throw new Error(`You can reserve up to ${raid.sr_limit} item${raid.sr_limit === 1 ? '' : 's'}.`);
  const valid = new Set(itemsForInstance(db, raid.guild_id, raid.instance).map((i) => i.id));
  for (const id of ids) if (!valid.has(id)) throw new Error('That item isn’t on this raid’s loot list.');
  db.transaction(() => {
    db.prepare('DELETE FROM reserves WHERE raid_id = ? AND user_id = ?').run(raid.id, userId);
    const ins = db.prepare('INSERT INTO reserves (raid_id, user_id, item_id) VALUES (?,?,?)');
    for (const id of ids) ins.run(raid.id, userId, id);
  })();
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

function awardItem(db, raid, { itemId, itemName, userId, character, kind }) {
  const item = itemId ? db.prepare('SELECT * FROM loot_items WHERE id = ? AND guild_id = ?').get(itemId, raid.guild_id) : null;
  const name = item ? item.name : String(itemName || '').trim();
  if (!name) throw new Error('Pick an item.');
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

// Close the raid: record who attended and settle loyalty bonuses.
function closeRaid(db, raid, attendeeIds) {
  if (raid.status === 'done') throw new Error('This raid is already closed.');
  const attendees = new Set(attendeeIds.map(Number).filter(Boolean));
  const instanceItems = db.prepare('SELECT id FROM loot_items WHERE guild_id = ? AND instance = ?').all(raid.guild_id, raid.instance).map((r) => r.id);
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

// "Boss | Item" per line (boss optional) → rows added to the catalog.
function importItems(db, guildId, instance, text) {
  const ins = db.prepare('INSERT OR IGNORE INTO loot_items (guild_id, instance, boss, name) VALUES (?,?,?,?)');
  let added = 0;
  db.transaction(() => {
    for (const line of String(text || '').split(/\r?\n/)) {
      const parts = line.split('|').map((s) => s.trim()).filter(Boolean);
      if (!parts.length) continue;
      const [boss, name] = parts.length > 1 ? [parts[0], parts.slice(1).join(' | ')] : [null, parts[0]];
      if (name.length > 100) continue;
      added += ins.run(guildId, instance, boss ? boss.slice(0, 60) : null, name).changes;
    }
  })();
  return added;
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

module.exports = {
  BONUS_STEP, raidFor, itemsForInstance, bonusOf, myReserves, reserveBoard, setReserves,
  rollItem, rollsFor, awardItem, closeRaid, importItems, signupsFor,
};
