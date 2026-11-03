// Inventory, guild bank and the guild price index.
// Data arrives with each companion upload (see sync.js) and is stored per guild.

const int = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : null);
const str = (v, max = 100) => (typeof v === 'string' ? v.slice(0, max) : null);
const list = (v) => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : []);

// Auctionator counts scan days from 1 Jan 2020 (the player's local midnight; we treat it as UTC).
const SCAN_DAY_0 = Date.UTC(2020, 0, 1);
const dayToDate = (d) => new Date(SCAN_DAY_0 + d * 86400000).toISOString().slice(0, 10);

function rememberNames(db, items) {
  const up = db.prepare(`INSERT INTO item_names (item_id, name, updated_at) VALUES (?,?, datetime('now'))
    ON CONFLICT (item_id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`);
  for (const it of items) {
    const id = int(it && it.id);
    const name = str(it && it.name, 100);
    if (id && name) up.run(id, name);
  }
}

// Called inside applyPayload's transaction.
function applyEconomy(db, guildId, userId, payload, charIdByName) {
  const stats = { inventory: 0, bank: 0, prices: 0 };

  // 1. Each character's bags and bank
  const delInv = db.prepare('DELETE FROM inventory WHERE character_id = ? AND location = ?');
  const insInv = db.prepare('INSERT OR REPLACE INTO inventory (character_id, location, item_id, count) VALUES (?,?,?,?)');
  for (const c of list(payload.characters)) {
    const id = c && c.name && charIdByName(c.name);
    if (!id || !c.inventory) continue;
    for (const loc of ['bags', 'bank']) {
      const items = list(c.inventory[loc]);
      if (!c.inventory[loc]) continue; // bank only refreshes when the player opens it
      rememberNames(db, items);
      delInv.run(id, loc);
      for (const it of items.slice(0, 2000)) {
        const iid = int(it && it.id); const n = int(it && it.count);
        if (iid && n > 0) { insInv.run(id, loc, iid, n); stats.inventory += 1; }
      }
    }
  }

  // 2. Guild bank snapshot + log (only the newest scan wins)
  const gb = payload.guildBank;
  if (gb && Array.isArray(gb.tabs)) {
    const scanned = new Date((int(gb.scannedAt) || Date.now() / 1000) * 1000).toISOString();
    const last = db.prepare('SELECT bank_scanned_at AS t FROM guilds WHERE id = ?').get(guildId);
    if (!last.t || scanned > last.t) {
      db.prepare('UPDATE guilds SET bank_money = ?, bank_scanned_at = ? WHERE id = ?').run(int(gb.money), scanned, guildId);
      db.prepare('DELETE FROM guild_bank WHERE guild_id = ?').run(guildId);
      const ins = db.prepare(`INSERT INTO guild_bank (guild_id, tab, item_id, count) VALUES (?,?,?,?)
        ON CONFLICT (guild_id, tab, item_id) DO UPDATE SET count = count + excluded.count`);
      for (const tab of gb.tabs.slice(0, 20)) {
        const items = list(tab && tab.items);
        rememberNames(db, items);
        for (const it of items.slice(0, 200)) {
          const iid = int(it && it.id); const n = int(it && it.count);
          if (iid && n > 0) { ins.run(guildId, str(tab.name, 40) || 'Tab', iid, n); stats.bank += 1; }
        }
      }
    }
    // The game only shows "x hours ago", so the dedupe key buckets times into 6-hour windows.
    const insLog = db.prepare(`INSERT OR IGNORE INTO bank_log (guild_id, kind, who, item_id, count, amount, at, dedupe) VALUES (?,?,?,?,?,?,?,?)`);
    for (const e of list(gb.log).slice(0, 500)) {
      const at = int(e && e.at);
      if (!at) continue;
      const kind = str(e.kind, 20) || 'unknown';
      const who = str(e.who, 40);
      const iid = int(e.id);
      if (iid && e.name) rememberNames(db, [e]);
      const key = [kind, who, iid || '', int(e.count) || '', int(e.amount) || '', Math.floor(at / 21600)].join('|');
      insLog.run(guildId, kind, who, iid, int(e.count), int(e.amount), new Date(at * 1000).toISOString(), key);
    }
  }

  // 3. Auction prices from Auctionator (uploaded by the companion)
  if (payload.prices && Array.isArray(payload.prices.items)) {
    const up = db.prepare(`INSERT INTO prices (guild_id, item_id, day, price) VALUES (?,?,?,?)
      ON CONFLICT (guild_id, item_id, day) DO UPDATE SET price = MIN(price, excluded.price)`);
    for (const row of payload.prices.items.slice(0, 100000)) {
      const [iid, price, day] = Array.isArray(row) ? row : [];
      if (int(iid) > 0 && int(price) > 0 && int(day) >= 0) { up.run(guildId, int(iid), dayToDate(int(day)), int(price)); stats.prices += 1; }
    }
  }
  return stats;
}

// Latest known price per item (copper), within the last `days` days.
function latestPrices(db, guildId, itemIds, days = 30) {
  if (!itemIds.length) return {};
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const out = {};
  const q = db.prepare(`SELECT price, day FROM prices WHERE guild_id = ? AND item_id = ? AND day >= ? ORDER BY day DESC LIMIT 1`);
  for (const id of itemIds) { const r = q.get(guildId, id, since); if (r) out[id] = r; }
  return out;
}

function searchPrices(db, guildId, query, limit = 50) {
  const q = String(query || '').trim();
  const rows = /^\d+$/.test(q)
    ? db.prepare(`SELECT DISTINCT p.item_id, n.name FROM prices p LEFT JOIN item_names n ON n.item_id = p.item_id WHERE p.guild_id = ? AND p.item_id = ?`).all(guildId, Number(q))
    : db.prepare(`SELECT DISTINCT p.item_id, n.name FROM prices p JOIN item_names n ON n.item_id = p.item_id
        WHERE p.guild_id = ? AND n.name LIKE ? ESCAPE '\\' ORDER BY n.name LIMIT ?`).all(guildId, `%${q.replace(/[\\%_]/g, (m) => '\\' + m)}%`, limit);
  return rows.map((r) => ({ ...r, ...priceHistory(db, guildId, r.item_id) }));
}

function priceHistory(db, guildId, itemId) {
  const h = db.prepare('SELECT day, price FROM prices WHERE guild_id = ? AND item_id = ? ORDER BY day DESC LIMIT 14').all(guildId, itemId);
  return { latest: h[0] || null, history: h.reverse() };
}

// 1234567 copper → "123g 45s 67c"
function money(copper) {
  if (copper == null) return '';
  const c = Math.abs(Math.round(copper));
  const g = Math.floor(c / 10000); const s = Math.floor((c % 10000) / 100); const cc = c % 100;
  return `${copper < 0 ? '-' : ''}${g ? `${g.toLocaleString('en')}g ` : ''}${g || s ? `${s}s ` : ''}${cc}c`.replace(/ 0c$/, '').trim();
}

module.exports = { applyEconomy, latestPrices, searchPrices, priceHistory, money, dayToDate, rememberNames };
