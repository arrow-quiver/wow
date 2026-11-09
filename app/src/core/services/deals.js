'use strict';
// Deal hunter: which auction house items to buy now and sell again for more, from my own Auctionator scans.
// API: docs/api/economy.md (GET /api/deals).
//
//   applyMarket(db, market) → { realms, items }   store an upload's market history (shared/auctionator.js extractMarket)
//   findDeals(db, opts)      → { realm, realms, scan, deals, vendor, plan, notes }
//
// How an item is judged (all prices are the lowest buyout of the day, in copper):
//   worth   = the lower of the 30-day and 7-day medians of the days before the current scan (so a falling price
//             isn't over-valued)
//   resale  = worth less the auction house's 5% cut
//   profit  = resale − current lowest buyout; a deal needs profit ≥ minProfit and a discount of at least 20%
//   sorted by profit × (confidence/100)²; confidence (0-100): enough history (10+ days is full marks), listed on most days (sells often), steady price
// Only items in the newest scan count: anything older may be gone already. A vendor flip is an item listed below
// what a vendor pays for it (item_info.sell_price): the only profit that's certain.

const EPOCH = Date.UTC(2020, 0, 1);
const AH_CUT = 0.05;
const MIN_DISCOUNT = 0.2;
const MIN_HISTORY = 4;

const dayToDate = (d) => new Date(EPOCH + d * 86400000).toISOString().slice(0, 10);
const todayNumber = (now = Date.now()) => Math.floor((now - EPOCH) / 86400000);

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

// ---------- storing ----------

function applyMarket(db, market) {
  const out = { realms: 0, items: 0 };
  if (!market || !Array.isArray(market.realms)) return out;
  const delItems = db.prepare('DELETE FROM ah_items WHERE realm = ?');
  const delDays = db.prepare('DELETE FROM ah_days WHERE realm = ?');
  const insItem = db.prepare('INSERT OR REPLACE INTO ah_items (realm, item_id, current, current_day) VALUES (?,?,?,?)');
  const insDay = db.prepare('INSERT OR REPLACE INTO ah_days (realm, item_id, day, price, qty) VALUES (?,?,?,?,?)');
  const realmRow = db.prepare(`INSERT INTO ah_realms (realm, newest, items, uploaded_at) VALUES (?,?,?, datetime('now'))
    ON CONFLICT (realm) DO UPDATE SET newest = excluded.newest, items = excluded.items, uploaded_at = excluded.uploaded_at`);
  const n = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : null);
  db.transaction(() => {
    for (const r of market.realms.slice(0, 20)) {
      const realm = typeof r.key === 'string' ? r.key.slice(0, 80) : null;
      if (!realm || !Array.isArray(r.items)) continue;
      delItems.run(realm); delDays.run(realm);
      let count = 0; let newest = -1;
      for (const row of r.items.slice(0, 30000)) {
        if (!Array.isArray(row)) continue;
        const [id, current, currentDay, days] = row;
        if (!(n(id) > 0) || !(n(current) > 0) || !(n(currentDay) >= 0)) continue;
        insItem.run(realm, n(id), n(current), n(currentDay));
        for (const d of (Array.isArray(days) ? days : []).slice(-40)) {
          if (Array.isArray(d) && n(d[0]) >= 0 && n(d[1]) > 0) insDay.run(realm, n(id), n(d[0]), n(d[1]), d[2] == null ? null : n(d[2]));
        }
        if (n(currentDay) > newest) newest = n(currentDay);
        count += 1;
      }
      if (!count) continue;
      realmRow.run(realm, newest, count);
      out.realms += 1; out.items += count;
    }
  })();
  return out;
}

// ---------- judging ----------

// One item: its history (days before the current scan, within 30 days) → the numbers a deal is judged on.
function judge(item, history, sellPrice, today) {
  const hist = history.filter((h) => h.day < item.current_day && item.current_day - h.day <= 30);
  const prices = hist.map((h) => h.price);
  const m30 = median(prices);
  const m7 = median(hist.filter((h) => item.current_day - h.day <= 7).map((h) => h.price));
  const worth = m30 == null ? null : (m7 == null ? m30 : Math.min(m30, m7));
  const listedDays = new Set(hist.filter((h) => item.current_day - h.day <= 14).map((h) => h.day)).size;
  const liquidity = Math.min(1, listedDays / 14);
  const vol = m30 ? median(prices.map((p) => Math.abs(p - m30))) / m30 : 1;
  const qtys = hist.map((h) => h.qty).filter((q) => q != null);
  const resale = worth == null ? null : Math.floor(worth * (1 - AH_CUT));
  const profit = resale == null ? null : resale - item.current;
  const discount = worth ? 1 - item.current / worth : 0;
  const confidence = Math.round(100 * (0.4 * Math.min(1, prices.length / 10) + 0.35 * liquidity + 0.25 * (1 - Math.min(1, vol / 0.5))));
  const flags = [];
  if (prices.length && item.current < Math.min(...prices)) flags.push({ kind: 'low', text: 'Lowest price in 30 days' });
  if (m7 != null && m30 != null && m7 < m30 * 0.85) flags.push({ kind: 'falling', text: 'Price has been falling this week' });
  if (liquidity < 0.4) flags.push({ kind: 'slow', text: `Listed on only ${listedDays} of the last 14 days: may take a while to sell` });
  if (vol > 0.35) flags.push({ kind: 'swingy', text: 'The price swings a lot' });
  return {
    item_id: item.item_id, buy: item.current, worth, resale, profit,
    roi: profit != null && item.current ? Math.round((profit / item.current) * 1000) / 10 : null,
    discount: Math.round(discount * 1000) / 10,
    confidence, sure: confidence >= 70 ? 'high' : confidence >= 45 ? 'medium' : 'low',
    history_days: prices.length, listed_days: listedDays,
    listed: qtys.length ? Math.round(qtys.reduce((a, b) => a + b, 0) / qtys.length) : null,
    sell_price: sellPrice,
    history: history.filter((h) => item.current_day - h.day <= 14).map((h) => ({ day: dayToDate(h.day), price: h.price })),
    flags,
    seen: dayToDate(item.current_day),
    age_days: today - item.current_day,
  };
}

function findDeals(db, { realm, minProfit = 5000, maxPrice = null, budget = null, limit = 50, now = Date.now(), preferRealms = [] } = {}) {
  const realms = db.prepare('SELECT realm, newest, items, uploaded_at FROM ah_realms ORDER BY newest DESC, uploaded_at DESC').all();
  const today = todayNumber(now);
  const pick = realms.find((r) => r.realm === realm)
    || realms.find((r) => preferRealms.some((p) => p && r.realm.toLowerCase().startsWith(String(p).toLowerCase())))
    || realms[0];
  const base = { realms: realms.map((r) => ({ key: r.realm, newest: dayToDate(r.newest), items: r.items })), deals: [], vendor: [], plan: null };
  if (!pick) return { ...base, realm: null, scan: null, notes: [] };

  const items = db.prepare(`SELECT a.item_id, a.current, a.current_day, n.name, i.quality, i.sell_price, i.item_class
      FROM ah_items a LEFT JOIN item_names n ON n.item_id = a.item_id LEFT JOIN item_info i ON i.item_id = a.item_id
      WHERE a.realm = ? AND a.current_day = ?`).all(pick.realm, pick.newest);
  // Every item's daily prices in one query, not one per item (a realm can have 15,000 items).
  const daysOf = new Map();
  for (const h of db.prepare('SELECT item_id, day, price, qty FROM ah_days WHERE realm = ? ORDER BY item_id, day').iterate(pick.realm)) {
    let list = daysOf.get(h.item_id);
    if (!list) daysOf.set(h.item_id, (list = []));
    list.push({ day: h.day, price: h.price, qty: h.qty });
  }
  const deals = []; const vendor = [];
  for (const it of items) {
    if (maxPrice && it.current > maxPrice) continue;
    const j = judge(it, daysOf.get(it.item_id) || [], it.sell_price ?? null, today);
    const row = { ...j, name: it.name || null, quality: it.quality ? String(it.quality).toLowerCase() : null, category: it.item_class || null };
    if (it.sell_price && it.current < it.sell_price && it.sell_price - it.current >= 100) {
      vendor.push({ ...row, profit: it.sell_price - it.current, roi: Math.round(((it.sell_price - it.current) / it.current) * 1000) / 10, confidence: 100, sure: 'certain' });
      continue;
    }
    if (j.history_days < MIN_HISTORY || j.profit == null || j.profit < minProfit || j.discount < MIN_DISCOUNT * 100) continue;
    deals.push(row);
  }
  // Sure profits first: confidence counts twice, so a risky big number doesn't push out a safe good one.
  const score = (d) => d.profit * (d.confidence / 100) ** 2;
  deals.sort((a, b) => score(b) - score(a));
  vendor.sort((a, b) => b.profit - a.profit);
  const shownDeals = deals.slice(0, limit);
  const shownVendor = vendor.slice(0, 20);

  // With a budget: the best deals that fit, one of each, best first. Only from the deals returned, so every
  // planned item is on the page.
  let plan = null;
  if (budget && budget > 0) {
    const chosen = []; let spend = 0; let profit = 0;
    for (const d of [...shownVendor, ...shownDeals]) {
      if (spend + d.buy > budget) continue;
      chosen.push(d.item_id); spend += d.buy; profit += d.profit;
    }
    plan = { budget, items: chosen, spend, profit };
  }

  const notes = [];
  const age = today - pick.newest;
  if (age >= 1) notes.push(`Your newest scan of ${pick.realm} is from ${age === 1 ? 'yesterday' : `${age} days ago`}. Prices move fast: scan again before you buy.`);
  if (items.length && items.every((i) => i.name == null)) notes.push('Item names fill in as Guild Camp looks them up. Hover an item for its tooltip.');
  return {
    ...base, realm: pick.realm, scan: { day: dayToDate(pick.newest), age_days: age, items: items.length },
    deals: shownDeals, vendor: shownVendor, plan, notes,
    rules: { ah_cut: AH_CUT, min_discount: MIN_DISCOUNT, min_history_days: MIN_HISTORY, min_profit: minProfit },
  };
}

module.exports = { applyMarket, findDeals, judge, median, dayToDate };
