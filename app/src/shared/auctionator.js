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

module.exports = { extractPrices };
