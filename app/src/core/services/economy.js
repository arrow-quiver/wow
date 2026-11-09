// Inventory, guild bank and the guild price index. Ported from the old web/src/economy.js.
// Data arrives with each app upload (POST /api/sync → services/sync.js applyPayload) and is stored per guild.
//
// Exports
//   applyEconomy(db, guildId, userId, payload, charIdByName) → { inventory, bank, prices }
//       Called inside applyPayload's transaction. charIdByName(name) → characters.id owned by this user, or falsy.
//   latestPrices(db, guildId, itemIds, days = 30) → { [itemId]: { price, day } }   newest scan per item in the window
//   searchPrices(db, guildId, query, limit = 50) → [{ item_id, name, latest, history }]   by name (LIKE) or exact item id
//   priceHistory(db, guildId, itemId) → { latest: {day, price}|null, history: [{day, price}] (oldest first, max 14) }
//   money(copper) → "123g 45s 67c"      dayToDate(auctionatorDay) → "YYYY-MM-DD"
//   rememberNames(db, [{ id, name }])   keeps item_names current
//   recordBankLog(db, guildId, lines) → rows added   guild bank log lines, matched against known rows
// Injected dependencies: none (pure database code).

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
    const lines = [];
    for (const e of list(gb.log).slice(0, 500)) {
      const iid = int(e && e.id);
      if (iid && e.name) rememberNames(db, [e]);
      lines.push({ at: int(e && e.at), kind: str(e && e.kind, 20) || 'unknown', who: str(e && e.who, 40), item: iid, count: int(e && e.count), amount: int(e && e.amount) });
    }
    recordBankLog(db, guildId, lines);
  }

  // 3. Auction prices from Auctionator (read by the app from Auctionator's SavedVariables)
  if (payload.prices && Array.isArray(payload.prices.items)) {
    const up = db.prepare(`INSERT INTO prices (guild_id, item_id, day, price) VALUES (?,?,?,?)
      ON CONFLICT (guild_id, item_id, day) DO UPDATE SET price = MIN(price, excluded.price)`);
    for (const row of payload.prices.items.slice(0, 100000)) {
      const [iid, price, day] = Array.isArray(row) ? row : [];
      const d = int(day); // a row without a scan day is skipped (null >= 0 would be true)
      if (int(iid) > 0 && int(price) > 0 && d !== null && d >= 0) { up.run(guildId, int(iid), dayToDate(d), int(price)); stats.prices += 1; }
    }
  }
  return stats;
}

// Guild bank log lines → bank_log, without counting a line twice and without merging identical lines.
// The game only shows "x hours ago", so each scan's time estimate for one line drifts (by up to an hour, and the
// shared gb record rounds to the hour). A line matches an existing row with the same kind, who, item, count and
// amount whose time is within BANK_LOG_MATCH_SECS; each existing row matches at most one line of a scan, so three
// identical deposits seen in one scan stay three rows, and a later scan only adds the lines beyond those already
// known. lines: [{ at (unix seconds), kind, who, item, count, amount }]. Returns how many rows were added.
const BANK_LOG_MATCH_SECS = 2 * 3600;
function recordBankLog(db, guildId, lines) {
  const nz = (v) => (Number.isFinite(Number(v)) && Math.trunc(Number(v)) !== 0 ? Math.trunc(Number(v)) : null);
  const same = db.prepare(`SELECT id, at FROM bank_log WHERE guild_id = ? AND kind = ? AND who IS ?
    AND COALESCE(item_id, 0) = ? AND COALESCE(count, 0) = ? AND COALESCE(amount, 0) = ?`);
  const ins = db.prepare('INSERT OR IGNORE INTO bank_log (guild_id, kind, who, item_id, count, amount, at, dedupe) VALUES (?,?,?,?,?,?,?,?)');
  const groups = new Map();
  for (const l of lines) {
    const at = nz(l && l.at);
    if (!at) continue;
    const row = { at, kind: String(l.kind || 'unknown').slice(0, 20), who: l.who ? String(l.who).slice(0, 40) : null, item: nz(l.item), count: nz(l.count), amount: nz(l.amount) };
    const key = [row.kind, row.who, row.item || '', row.count || '', row.amount || ''].join('|');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  let added = 0;
  for (const [key, rows] of groups) {
    const r0 = rows[0];
    const known = same.all(guildId, r0.kind, r0.who, r0.item || 0, r0.count || 0, r0.amount || 0)
      .map((k) => ({ id: k.id, at: Math.floor(Date.parse(k.at) / 1000) }));
    const used = new Set();
    rows.sort((x, y) => x.at - y.at);
    for (const row of rows) {
      let best = null;
      for (const k of known) {
        const d = Math.abs(k.at - row.at);
        if (!used.has(k.id) && d <= BANK_LOG_MATCH_SECS && (!best || d < best.d)) best = { id: k.id, d };
      }
      if (best) { used.add(best.id); continue; }
      const at = new Date(row.at * 1000).toISOString();
      for (let n = 0; ; n++) {
        const info = ins.run(guildId, row.kind, row.who, row.item, row.count, row.amount, at, `${key}|${row.at}|${n}`);
        if (info.changes) { const id = Number(info.lastInsertRowid); used.add(id); known.push({ id, at: row.at }); break; }
      }
      added += 1;
    }
  }
  return added;
}

// Latest known price per item (copper), within the last `days` days.
function latestPrices(db, guildId, itemIds, days = 30) {
  if (!itemIds.length) return {};
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const out = {};
  const q = db.prepare('SELECT price, day FROM prices WHERE guild_id = ? AND item_id = ? AND day >= ? ORDER BY day DESC LIMIT 1');
  for (const id of itemIds) { const r = q.get(guildId, id, since); if (r) out[id] = r; }
  return out;
}

function searchPrices(db, guildId, query, limit = 50) {
  const q = String(query || '').trim();
  const rows = /^\d+$/.test(q)
    ? db.prepare('SELECT DISTINCT p.item_id, n.name FROM prices p LEFT JOIN item_names n ON n.item_id = p.item_id WHERE p.guild_id = ? AND p.item_id = ?').all(guildId, Number(q))
    : db.prepare(`SELECT DISTINCT p.item_id, n.name FROM prices p JOIN item_names n ON n.item_id = p.item_id
        WHERE p.guild_id = ? AND n.name LIKE ? ESCAPE '\\' ORDER BY n.name LIMIT ?`).all(guildId, `%${q.replace(/[\\%_]/g, (m) => '\\' + m)}%`, limit);
  return rows.map((r) => ({ ...r, ...priceHistory(db, guildId, r.item_id) }));
}

function priceHistory(db, guildId, itemId) {
  const h = db.prepare('SELECT day, price FROM prices WHERE guild_id = ? AND item_id = ? ORDER BY day DESC LIMIT 14').all(guildId, itemId);
  return { latest: h[0] || null, history: h.reverse() };
}

// 1234567 copper → "123g 45s 67c" (used in Discord replies; the app formats money itself).
function money(copper) {
  if (copper == null) return '';
  const c = Math.abs(Math.round(copper));
  const g = Math.floor(c / 10000); const s = Math.floor((c % 10000) / 100); const cc = c % 100;
  return `${copper < 0 ? '-' : ''}${g ? `${g.toLocaleString('en')}g ` : ''}${g || s ? `${s}s ` : ''}${cc}c`.replace(/ 0c$/, '').trim();
}

module.exports = { applyEconomy, recordBankLog, BANK_LOG_MATCH_SECS, latestPrices, searchPrices, priceHistory, money, dayToDate, rememberNames };
