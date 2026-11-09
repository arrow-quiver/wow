'use strict';
// Auctionator keeps its scan results in its own SavedVariables file (Auctionator.lua) next to
// ours, under AUCTIONATOR_PRICE_DATABASE. We send the newest price per item, for items seen in
// the last two weeks. Port of the old companion's extractPrices.
// Zero dependencies: shared by the app, the server and the release scripts.

const EPOCH = Date.UTC(2020, 0, 1); // Auctionator counts days from 1 January 2020
const MAX_AGE_DAYS = 14;

// db: { "<realm> <faction>": { "<itemId>" | "g:<itemId>:..": { m: price, h: { [day]: price } } }, __dbversion }
// → { items: [[itemId, copper, day]] }. For each item, the most recent day wins; on the same
// day, the cheapest realm wins. Pet cages ("p:") and records older than 14 days are skipped.
function extractPrices(db, now = Date.now()) {
  const today = Math.floor((now - EPOCH) / 86400000);
  const best = new Map(); // itemId → [price, day]
  if (!db || typeof db !== 'object') return { items: [] };
  for (const [realm, items] of Object.entries(db)) {
    if (realm.startsWith('__') || !items || typeof items !== 'object') continue;
    for (const [key, rec] of Object.entries(items)) {
      const m = /^(?:g:)?(\d+)/.exec(key);
      if (!m || !rec || typeof rec !== 'object') continue;
      const days = rec.h && typeof rec.h === 'object' ? Object.keys(rec.h).map(Number).filter(Number.isFinite) : [];
      const day = days.length ? Math.max(...days) : null;
      const price = Number(rec.m) || (day != null ? Number(rec.h[String(day)]) : 0);
      if (!price || day == null || today - day > MAX_AGE_DAYS) continue;
      const id = Number(m[1]);
      const prev = best.get(id);
      if (!prev || day > prev[1] || (day === prev[1] && price < prev[0])) best.set(id, [price, day]);
    }
  }
  return { items: [...best].map(([id, [price, day]]) => [id, price, day]) };
}

// Market history for the Deal hunter: for each realm Auctionator has scanned, every item's current lowest
// buyout and its daily prices for the last `days` days.
// Auctionator keeps, per item: m = the lowest buyout in the latest scan; h = { [day]: price } (the day's
// highest lowest-buyout); l = { [day]: price } (the day's lowest); a = { [day]: count listed } in newer
// versions. We use l when it has the day, else h, and a when present.
// → { realms: [{ key, newest, items: [[itemId, current, currentDay, [[day, price, qty|null], …]]] }] }
// Realms are sorted newest scan first. At most `maxItems` items per realm (the most recently seen).
function extractMarket(db, now = Date.now(), { days = 30, maxItems = 15000, maxRealms = 4 } = {}) {
  const today = Math.floor((now - EPOCH) / 86400000);
  const out = [];
  if (!db || typeof db !== 'object') return { realms: out };
  for (const [realm, items] of Object.entries(db)) {
    if (realm.startsWith('__') || !items || typeof items !== 'object') continue;
    const rows = [];
    let newest = -1;
    for (const [key, rec] of Object.entries(items)) {
      const m = /^(?:g:)?(\d+)/.exec(key);
      if (!m || !rec || typeof rec !== 'object') continue;
      const lows = rec.l && typeof rec.l === 'object' ? rec.l : {};
      const highs = rec.h && typeof rec.h === 'object' ? rec.h : {};
      const avail = rec.a && typeof rec.a === 'object' ? rec.a : {};
      const dayKeys = new Set([...Object.keys(lows), ...Object.keys(highs)].map(Number).filter((d) => Number.isFinite(d) && today - d <= days && d <= today));
      if (!dayKeys.size) continue;
      const hist = [...dayKeys].sort((x, y) => x - y).map((d) => {
        const price = Number(lows[String(d)]) || Number(highs[String(d)]) || 0;
        const qty = Number(avail[String(d)]);
        return [d, Math.round(price), Number.isFinite(qty) && qty >= 0 ? Math.round(qty) : null];
      }).filter((x) => x[1] > 0);
      if (!hist.length) continue;
      const currentDay = hist[hist.length - 1][0];
      const current = Math.round(Number(rec.m)) || hist[hist.length - 1][1];
      if (currentDay > newest) newest = currentDay;
      rows.push([Number(m[1]), current, currentDay, hist]);
    }
    if (!rows.length) continue;
    rows.sort((x, y) => y[2] - x[2]);
    // One row per item id (several keys can share an id, e.g. gear with different bonuses): keep the newest.
    const seen = new Set();
    const unique = rows.filter((r) => (seen.has(r[0]) ? false : (seen.add(r[0]), true))).slice(0, maxItems);
    out.push({ key: realm.slice(0, 80), newest, items: unique });
  }
  // Realms scanned in the last two weeks, newest first (the size of one upload stays well under the core's limit).
  out.sort((x, y) => y.newest - x.newest);
  return { realms: out.filter((r) => today - r.newest <= 14).slice(0, maxRealms) };
}

// The market split into uploads that each fit under the core's request limit (express.json 15mb): one realm per
// upload, and a realm too big on its own keeps only its most recently seen items (they come newest first).
// → [{ realms: [realm] }, …]
function marketParts(market, maxBytes = 12 * 1024 * 1024) {
  const parts = [];
  for (const realm of (market && Array.isArray(market.realms) ? market.realms : [])) {
    let items = realm.items;
    let size = JSON.stringify({ realms: [{ ...realm, items }] }).length;
    while (size > maxBytes && items.length > 1) {
      items = items.slice(0, Math.max(1, Math.floor(items.length * (maxBytes / size) * 0.95)));
      size = JSON.stringify({ realms: [{ ...realm, items }] }).length;
    }
    if (size <= maxBytes) parts.push({ realms: [{ ...realm, items }] });
  }
  return parts;
}

module.exports = { extractPrices, extractMarket, marketParts };
