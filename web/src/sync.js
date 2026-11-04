const { applyEconomy, latestPrices } = require('./economy');

// Applies a companion upload (the addon's SavedVariables, converted to JSON)
// and builds the "inbox" the companion writes back into the addon.

const str = (v, max = 80) => (typeof v === 'string' ? v.slice(0, max) : v == null ? null : String(v).slice(0, max));
const int = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : null);
const list = (v) => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : []);

// Readiness from the addon: item level, repair %, consumables in bags.
function cleanReadiness(r) {
  if (!r || typeof r !== 'object') return null;
  const num = (v, lo, hi) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : null);
  const consumables = {};
  for (const k of ['flask', 'elixir', 'potion', 'food', 'bandage', 'other']) {
    const n = num(r.consumables && r.consumables[k], 0, 9999);
    if (n) consumables[k] = Math.round(n);
  }
  return JSON.stringify({ ilvl: num(r.ilvl, 0, 1000), durability: num(r.durability, 0, 100), consumables, at: num(r.at, 0, 4e9) });
}

// PvP, reputations and currencies. Stored as reported; the site only displays them.
function cleanExtras(c) {
  const out = {};
  const num = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : null);
  if (c.pvp && typeof c.pvp === 'object') {
    const p = {};
    for (const k of ['rank', 'honor', 'honorLevel', 'hk', 'weekHk', 'weekContribution', 'lastWeekHk', 'lastWeekContribution', 'lastWeekRank', 'highestRank']) {
      const v = num(c.pvp[k]); if (v != null) p[k] = v;
    }
    if (typeof c.pvp.rankName === 'string') p.rankName = c.pvp.rankName.slice(0, 40);
    if (Object.keys(p).length) out.pvp = p;
  }
  const reps = list(c.reputations).slice(0, 120).map((r) => ({
    name: str(r && r.name, 60), standing: num(r && r.standing), value: num(r && r.value), max: num(r && r.max), header: str(r && r.header, 60),
  })).filter((r) => r.name);
  if (reps.length) out.reputations = reps;
  const cur = list(c.currencies).slice(0, 100).map((x) => ({ id: num(x && x.id), name: str(x && x.name, 60), qty: num(x && x.qty), max: num(x && x.max) }))
    .filter((x) => x.name && x.qty != null);
  if (cur.length) out.currencies = cur;
  if (c.addonVersion) out.addonVersion = str(c.addonVersion, 20);
  return Object.keys(out).length ? JSON.stringify(out) : null;
}

// Drop data that doesn't belong to the guild's game: anything from before a "fresh start"
// reset, characters on another realm (e.g. Retail test characters), and the guild bank,
// roster and auction prices from an upload that has no character on the guild's realm.
function freshOnly(db, guildId, payload) {
  const g = db.prepare('SELECT realm, game_guild, reset_at FROM guilds WHERE id = ?').get(guildId) || {};
  const cutoff = g.reset_at ? Math.floor(Date.parse(g.reset_at) / 1000) : 0;
  const p = { ...payload };
  const chars = list(p.characters);
  const keep = chars.filter((c) => c && !(cutoff && int(c.updated) && int(c.updated) < cutoff) && !(g.realm && c.realm && c.realm !== g.realm));
  if (keep.length !== chars.length) p.characters = keep;
  const onRealm = !g.realm || !chars.length || chars.some((c) => c && (!c.realm || c.realm === g.realm));
  const old = (t) => cutoff && int(t) && int(t) < cutoff;
  const otherGuild = (name) => g.game_guild && name && name !== g.game_guild;
  if (!onRealm || (p.roster && (old(p.roster.scannedAt) || otherGuild(p.roster.guild)))) delete p.roster;
  if (!onRealm || (p.guildBank && (old(p.guildBank.scannedAt) || otherGuild(p.guildBank.guild)))) delete p.guildBank;
  if (!onRealm) delete p.prices;
  else if (cutoff && p.prices && Array.isArray(p.prices.items)) {
    const cutoffDay = Math.floor((cutoff * 1000 - Date.UTC(2020, 0, 1)) / 86400000);
    p.prices = { ...p.prices, items: p.prices.items.filter((r) => Array.isArray(r) && int(r[2]) >= cutoffDay) };
  }
  if (cutoff) p.ctaQueue = list(p.ctaQueue).filter((q) => q && !old(q.at));
  return p;
}

function applyPayload(db, guildId, userId, payload) {
  if (!payload || typeof payload !== 'object') throw new Error('Payload must be an object');
  payload = freshOnly(db, guildId, payload);
  const stats = { characters: 0, roster: 0, recipes: 0, ctas: [] };
  const now = new Date().toISOString();

  const upsertChar = db.prepare(`
    INSERT INTO characters (guild_id, user_id, name, class, race, level, faction, zone, money, online, last_seen, updated_at, readiness, extras)
    VALUES (@guild_id, @user_id, @name, @class, @race, @level, @faction, @zone, @money, 0, @last_seen, @now, @readiness, @extras)
    ON CONFLICT (guild_id, name) DO UPDATE SET
      user_id = excluded.user_id, class = COALESCE(excluded.class, class), race = COALESCE(excluded.race, race),
      level = COALESCE(excluded.level, level), faction = COALESCE(excluded.faction, faction),
      zone = COALESCE(excluded.zone, zone), money = COALESCE(excluded.money, money),
      last_seen = COALESCE(excluded.last_seen, last_seen), updated_at = excluded.updated_at,
      readiness = COALESCE(excluded.readiness, readiness), extras = COALESCE(excluded.extras, extras)`);
  const charId = db.prepare('SELECT id FROM characters WHERE guild_id = ? AND name = ?');
  const delProf = db.prepare('DELETE FROM professions WHERE character_id = ?');
  const insProf = db.prepare('INSERT OR REPLACE INTO professions (character_id, name, skill, max_skill) VALUES (?,?,?,?)');
  const delRecipes = db.prepare('DELETE FROM recipes WHERE character_id = ? AND profession = ?');
  const insRecipe = db.prepare('INSERT OR IGNORE INTO recipes (character_id, profession, recipe_id, name) VALUES (?,?,?,?)');

  // Roster rows never steal ownership: user_id stays whatever it was.
  const upsertRoster = db.prepare(`
    INSERT INTO characters (guild_id, name, class, level, rank, zone, online, last_seen, updated_at)
    VALUES (@guild_id, @name, @class, @level, @rank, @zone, @online, @last_seen, @now)
    ON CONFLICT (guild_id, name) DO UPDATE SET
      class = CASE WHEN user_id IS NOT NULL AND class IS NOT NULL THEN class ELSE COALESCE(excluded.class, class) END,
      level = CASE WHEN user_id IS NOT NULL AND updated_at > excluded.updated_at THEN level ELSE COALESCE(excluded.level, level) END,
      rank = excluded.rank, zone = COALESCE(excluded.zone, zone), online = excluded.online,
      last_seen = CASE WHEN excluded.online = 1 THEN excluded.last_seen ELSE last_seen END,
      updated_at = excluded.updated_at`);
  const claimed = db.prepare('SELECT user_id FROM characters WHERE guild_id = ? AND name = ?');
  const insCta = db.prepare(`INSERT OR IGNORE INTO ctas (guild_id, user_id, character, zone, message, needed, source, client_ref)
    VALUES (?,?,?,?,?,?, 'addon', ?)`);
  const activity = db.prepare('INSERT INTO activity (guild_id, kind, text) VALUES (?,?,?)');

  db.transaction(() => {
    // 1. Characters on this account
    for (const c of list(payload.characters)) {
      const name = str(c && c.name, 40);
      if (!name) continue;
      // A character owned by someone else is never overwritten.
      const owner = claimed.get(guildId, name);
      if (owner && owner.user_id && owner.user_id !== userId) continue;
      const before = charId.get(guildId, name);
      upsertChar.run({
        guild_id: guildId, user_id: userId, name,
        class: str(c.class, 20), race: str(c.race, 30), level: int(c.level),
        faction: str(c.faction, 10), zone: str(c.zone, 60), money: int(c.money),
        last_seen: c.updated ? new Date(int(c.updated) * 1000).toISOString() : now, now,
        readiness: cleanReadiness(c.readiness),
        extras: cleanExtras(c),
      });
      const { id } = charId.get(guildId, name);
      // The first synced character in the guild tells us the realm and the in-game guild name.
      if (c.realm && c.guild) db.prepare('UPDATE guilds SET realm = COALESCE(realm, ?), game_guild = COALESCE(game_guild, ?) WHERE id = ?').run(str(c.realm, 60), str(c.guild, 60), guildId);
      if (!before) activity.run(guildId, 'character', `${name} linked their character`);
      stats.characters += 1;

      const profs = list(c.professions);
      if (profs.length) {
        delProf.run(id);
        for (const p of profs) if (p && p.name) insProf.run(id, str(p.name, 40), int(p.skill), int(p.max));
      }
      const recipesByProf = c.recipes && typeof c.recipes === 'object' ? c.recipes : {};
      for (const [prof, recs] of Object.entries(recipesByProf)) {
        const rows = list(recs).slice(0, 2000);
        if (!rows.length) continue;
        delRecipes.run(id, str(prof, 40));
        for (const r of rows) {
          const rname = str(r && (r.name || r), 100);
          if (rname) { insRecipe.run(id, str(prof, 40), int(r.id), rname); stats.recipes += 1; }
        }
      }
    }

    // 1b. Inventory, guild bank and auction prices (economy.js)
    const owned = db.prepare('SELECT id FROM characters WHERE guild_id = ? AND name = ? AND user_id = ?');
    const eco = applyEconomy(db, guildId, userId, payload, (name) => { const r = owned.get(guildId, String(name).slice(0, 40), userId); return r && r.id; });
    Object.assign(stats, eco);

    // 1c. Profession helper: reagents to price, and the shopping list
    const ids = list(payload.reagentIds).map(int).filter((x) => x > 0).slice(0, 2000);
    if (ids.length) {
      db.prepare('DELETE FROM wanted_items WHERE user_id = ?').run(userId);
      const ins = db.prepare('INSERT OR IGNORE INTO wanted_items (user_id, item_id) VALUES (?,?)');
      for (const id of ids) ins.run(userId, id);
    }
    if (payload.shopping !== undefined) {
      const items = list(payload.shopping).slice(0, 50).map((e) => ({
        name: str(e && e.name, 100), qty: int(e && e.qty) || 1, prof: str(e && e.prof, 40),
        reagents: list(e && e.reagents).slice(0, 12).map((g) => ({ id: int(g && g.id), name: str(g && g.name, 100), qty: int(g && g.qty) || 1 })).filter((g) => g.id),
      })).filter((e) => e.name);
      db.prepare(`INSERT INTO shopping_lists (user_id, items, updated_at) VALUES (?,?, datetime('now'))
        ON CONFLICT (user_id) DO UPDATE SET items = excluded.items, updated_at = excluded.updated_at`).run(userId, JSON.stringify(items));
      // Shopping-list reagents also count as wanted.
      const ins = db.prepare('INSERT OR IGNORE INTO wanted_items (user_id, item_id) VALUES (?,?)');
      for (const e of items) for (const g of e.reagents) ins.run(userId, g.id);
    }

    // 2. Guild roster snapshot (one member's scan updates everyone's online status)
    const roster = payload.roster;
    if (roster && Array.isArray(roster.members) && roster.members.length) {
      const scanned = roster.scannedAt ? new Date(int(roster.scannedAt) * 1000).toISOString() : now;
      const last = db.prepare('SELECT roster_scanned_at AS t FROM guilds WHERE id = ?').get(guildId);
      // Ignore a scan older than the one we already have.
      if (!last.t || scanned >= last.t) {
        db.prepare('UPDATE guilds SET roster_scanned_at = ? WHERE id = ?').run(scanned, guildId);
        db.prepare('UPDATE characters SET online = 0 WHERE guild_id = ?').run(guildId);
        for (const m of roster.members.slice(0, 1000)) {
          const name = str(m && m.name, 40);
          if (!name) continue;
          upsertRoster.run({
            guild_id: guildId, name, class: str(m.class, 20), level: int(m.level), rank: str(m.rank, 40),
            zone: str(m.zone, 60), online: m.online ? 1 : 0, last_seen: scanned, now: scanned,
          });
          stats.roster += 1;
        }
      }
    }

    // 3. Calls to arms queued in game with /wow cta
    for (const q of list(payload.ctaQueue).slice(0, 20)) {
      const zone = str(q && q.zone, 60);
      if (!zone) continue;
      const ref = `${int(q.at)}:${str(q.character, 40)}`;
      const r = insCta.run(guildId, userId, str(q.character, 40), zone, str(q.msg, 200), int(q.needed), ref);
      if (r.changes) stats.ctas.push({ id: r.lastInsertRowid, zone, character: q.character, message: q.msg, needed: int(q.needed) });
    }
  })();
  return stats;
}

function buildInbox(db, guildId, userId) {
  const guild = db.prepare('SELECT name FROM guilds WHERE id = ?').get(guildId);
  const announcements = db.prepare(`SELECT a.body, a.created_at AS at, u.battletag AS by FROM announcements a
    JOIN users u ON u.id = a.user_id WHERE a.guild_id = ? ORDER BY a.id DESC LIMIT 5`).all(guildId);
  // Open requests this user's characters can actually craft.
  const canCraft = db.prepare(`SELECT DISTINCT cr.id, cr.item, cr.notes, u.battletag AS requester FROM craft_requests cr
    JOIN users u ON u.id = cr.requester_id
    JOIN recipes r ON lower(r.name) = lower(cr.item)
    JOIN characters c ON c.id = r.character_id AND c.user_id = ? AND c.guild_id = cr.guild_id
    WHERE cr.guild_id = ? AND cr.status = 'open' AND cr.requester_id != ? ORDER BY cr.id DESC LIMIT 20`).all(userId, guildId, userId);
  const mine = db.prepare(`SELECT cr.item, cr.status, cu.battletag AS crafter FROM craft_requests cr
    LEFT JOIN users cu ON cu.id = cr.crafter_id
    WHERE cr.guild_id = ? AND cr.requester_id = ? AND cr.status IN ('open','claimed') ORDER BY cr.id DESC LIMIT 10`).all(guildId, userId);
  const buddies = db.prepare(`SELECT b.character, b.level, b.zone, b.when_text AS whenText, b.note FROM buddy_posts b
    WHERE b.guild_id = ? AND b.active = 1 AND b.user_id != ? ORDER BY b.id DESC LIMIT 10`).all(guildId, userId);
  const raids = db.prepare(`SELECT r.id, r.title, r.instance, r.starts_at, r.status, s.status AS signup, s.role, s.character,
      (SELECT COUNT(*) FROM signups x WHERE x.raid_id = r.id AND x.status = 'yes') AS coming
    FROM raids r LEFT JOIN signups s ON s.raid_id = r.id AND s.user_id = ?
    WHERE r.guild_id = ? AND r.status IN ('open','locked') AND r.starts_at > ? ORDER BY r.starts_at LIMIT 5`)
    .all(userId, guildId, new Date(Date.now() - 3 * 3600 * 1000).toISOString());
  const resv = db.prepare(`SELECT li.name, COALESCE(l.bonus, 0) AS bonus FROM reserves rs JOIN loot_items li ON li.id = rs.item_id
    LEFT JOIN loyalty l ON l.guild_id = li.guild_id AND l.user_id = rs.user_id AND l.item_id = li.id WHERE rs.raid_id = ? AND rs.user_id = ?`);
  for (const r of raids) {
    r.startsAt = Math.floor(new Date(r.starts_at).getTime() / 1000);
    delete r.starts_at;
    r.reserves = resv.all(r.id, userId);
  }
  // Profession helper: guild prices for reagents, and where else you have shopping-list mats.
  const wanted = db.prepare('SELECT item_id FROM wanted_items WHERE user_id = ?').all(userId).map((r) => r.item_id);
  const priceMap = latestPrices(db, guildId, wanted);
  const prices = Object.entries(priceMap).map(([id, p]) => ({ id: Number(id), price: p.price }));
  const shop = db.prepare('SELECT items FROM shopping_lists WHERE user_id = ?').get(userId);
  const shopIds = [...new Set((shop ? JSON.parse(shop.items) : []).flatMap((e) => e.reagents.map((g) => g.id)))];
  const charsQ = db.prepare(`SELECT c.name, SUM(i.count) AS count FROM inventory i JOIN characters c ON c.id = i.character_id
    WHERE c.guild_id = ? AND c.user_id = ? AND i.item_id = ? GROUP BY c.name`);
  const gbQ = db.prepare(`SELECT COALESCE((SELECT SUM(count) FROM guild_bank WHERE guild_id = ? AND item_id = ?), 0)
    + COALESCE((SELECT SUM(i.count) FROM inventory i JOIN characters c ON c.id = i.character_id WHERE c.guild_id = ? AND c.is_bank = 1 AND i.item_id = ?), 0) AS n`);
  const stock = shopIds.map((id) => ({ id, chars: charsQ.all(guildId, userId, id), guildBank: gbQ.get(guildId, id, guildId, id).n }));

  // For item tooltips in game: what you hold on each character, what the guild bank holds,
  // and which guild characters can craft each recipe.
  const holdMap = new Map();
  const hold = (id) => { if (!holdMap.has(id)) holdMap.set(id, { id, chars: [], guildBank: 0 }); return holdMap.get(id); };
  for (const r of db.prepare(`SELECT i.item_id, c.name, SUM(i.count) AS count FROM inventory i JOIN characters c ON c.id = i.character_id
      WHERE c.guild_id = ? AND c.user_id = ? GROUP BY i.item_id, c.name`).all(guildId, userId)) hold(r.item_id).chars.push({ name: r.name, count: r.count });
  for (const r of db.prepare(`SELECT item_id, SUM(n) AS n FROM (
        SELECT item_id, count AS n FROM guild_bank WHERE guild_id = ?
        UNION ALL SELECT i.item_id, i.count FROM inventory i JOIN characters c ON c.id = i.character_id WHERE c.guild_id = ? AND c.is_bank = 1)
      GROUP BY item_id`).all(guildId, guildId)) hold(r.item_id).guildBank = r.n;
  const holdings = [...holdMap.values()].slice(0, 2500);
  const crafters = db.prepare(`SELECT r.name, group_concat(DISTINCT c.name) AS who FROM recipes r JOIN characters c ON c.id = r.character_id
    WHERE c.guild_id = ? GROUP BY r.name ORDER BY r.name LIMIT 4000`).all(guildId);
  for (const [id, p] of Object.entries(latestPrices(db, guildId, holdings.map((h) => h.id)))) {
    if (!priceMap[id]) prices.push({ id: Number(id), price: p.price });
  }
  return {
    guild: guild ? guild.name : '',
    prices, stock, holdings, crafters,
    raids,
    generatedAt: Math.floor(Date.now() / 1000),
    announcements, canCraft, myRequests: mine, buddies,
  };
}

// Lua serialiser used by the companion to write Data/Inbox.lua (kept here so
// the server can also offer it for download if the companion is not running).
function toLua(value, indent = '') {
  if (value === null || value === undefined) return 'nil';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'nil';
  if (typeof value === 'string') return JSON.stringify(value).replace(/\\u([0-9a-fA-F]{4})/g, (m, h) => {
    const n = parseInt(h, 16); return n < 128 ? '\\' + n : m;
  });
  const next = indent + '  ';
  if (Array.isArray(value)) {
    if (!value.length) return '{}';
    return '{\n' + value.map((v) => next + toLua(v, next) + ',').join('\n') + '\n' + indent + '}';
  }
  const keys = Object.keys(value);
  if (!keys.length) return '{}';
  return '{\n' + keys.map((k) => {
    const key = /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ? k : `[${JSON.stringify(k)}]`;
    return `${next}${key} = ${toLua(value[k], next)},`;
  }).join('\n') + '\n' + indent + '}';
}

module.exports = { applyPayload, buildInbox, toLua };
