// Official game data from Blizzard's free Game Data and Profile APIs. Ported from the old web/src/gamedata.js.
// WoW: Forever isn't in the API yet. Until it is, item details come from Classic Era (same item IDs),
// and realm status / the official roster wait. The day blizzard.check() finds a Forever namespace,
// everything here switches over by itself.
//
// Exports
//   namespaces(blizzardStatus, wowheadGame, region) → { static, dynamic, profile, label }
//   client(cfg, fetchImpl?) → { get(pathOrHref, namespace) → JSON|null (404 → null), region, enabled }
//   missingItemIds(db, limit = 300) → item ids seen by the guild with no item_info row yet
//   fillItems(db, api, ns, ids) → how many were found (unknown ids are stored with found = 0)
//   realmStatus(api, ns, realmName) → { found, slug, name, up, queue, population, checkedAt }
//   guildRoster(api, ns, realmSlug, guildName) → [{ name, level, class, rank }] | null
//   applyRoster(db, guildId, members)   marks in_official_roster, adds missing characters, levels only go up,
//       sets rank_index from Blizzard's rank (0 = Guild Master; trusted), then identity.syncRanks
//   realmStatus also gives connectedRealm (id), which the auction house needs.
//   auctions(api, ns, connectedRealmId, faction) → { house, items: Map(itemId → { price (copper/unit), quantity }) } | null
//   applyAuctions(db, guildId, items)   replaces the guild's ah_prices rows
//   run(db, cfg, { fetchImpl, notify, only: 'items'|'realm'|'auctions'|'roster'|undefined }) → [log line, ...]
//       One pass over every guild. Without only: items, realm status, the auction house (not Retail; once realm
//       status has found the connected realm; when an hour old) and the roster when 12+ hours old.
//   slug(name) → Blizzard realm/guild slug      CLASS_TOKENS { classId: 'WARRIOR', ... }
//
// Injected dependencies
//   cfg: bnetClientId, bnetClientSecret, bnetRegion, fetch (outside HTTP; fetchImpl wins).
//   run's notify(guildId, kind, opts) has the ctx.emit shape. Called when a realm comes back up:
//     notify(guildId, 'notice', { title: '✅ <realm> is back up', body: 'Log in!' | 'There is a login queue.', route: '/' })
//   Timers (cfg.timers only): run() hourly and run({ only: 'realm' }) every 5 minutes, as the old server did.
const blizzard = require('./blizzard');

const NO_BNET_APP = 'Blizzard game data is off: this copy of Guild Camp has no Battle.net app built in.';

const CLASS_TOKENS = { 1: 'WARRIOR', 2: 'PALADIN', 3: 'HUNTER', 4: 'ROGUE', 5: 'PRIEST', 6: 'DEATHKNIGHT', 7: 'SHAMAN', 8: 'MAGE', 9: 'WARLOCK', 10: 'MONK', 11: 'DRUID', 12: 'DEMONHUNTER', 13: 'EVOKER' };
const slug = (s) => String(s || '').trim().toLowerCase().replace(/['’]/g, '').replace(/\s+/g, '-');

// Which namespaces to use for a guild. `game` is the guild's Wowhead setting (forever | classic | retail).
function namespaces(status, game, region) {
  const r = region || (status && status.region) || 'eu';
  if (game === 'retail') return { static: `static-${r}`, dynamic: `dynamic-${r}`, profile: `profile-${r}`, label: 'Retail' };
  if (game === 'classic') return { static: `static-classic1x-${r}`, dynamic: `dynamic-classic1x-${r}`, profile: `profile-classic1x-${r}`, label: 'Classic Era' };
  const key = status && status.foreverKey;
  if (key) return { static: `static-${key}-${r}`, dynamic: `dynamic-${key}-${r}`, profile: `profile-${key}-${r}`, label: 'WoW: Forever' };
  return { static: `static-classic1x-${r}`, dynamic: null, profile: null, label: 'Classic Era item data (Forever not in the API yet)' };
}

function client(cfg, fetchImpl) {
  const f = fetchImpl || cfg.fetch || globalThis.fetch;
  let tok = null; let until = 0;
  const region = cfg.bnetRegion || 'eu';
  function bearer() {
    // Share one token request between parallel calls.
    if (!tok || Date.now() >= until) {
      until = Date.now() + 20 * 3600 * 1000;
      tok = blizzard.token(cfg, f).catch((e) => { tok = null; throw e; });
    }
    return tok;
  }
  // path may be a full href from a previous response (those already carry ?namespace=).
  async function get(path, ns) {
    const url = path.startsWith('https://') ? path : `https://${region}.api.blizzard.com${path}?namespace=${ns}&locale=en_GB`;
    const res = await f(url, { headers: { Authorization: `Bearer ${await bearer()}` }, signal: AbortSignal.timeout(10000) });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`${res.status} for ${path}`);
    return res.json();
  }
  return { get, region, enabled: Boolean(cfg.bnetClientId && cfg.bnetClientSecret) };
}

// ---- Items: fill in names and details for every item the guild has seen ----
function missingItemIds(db, limit = 300) {
  return db.prepare(`SELECT id FROM (
      SELECT item_id AS id FROM inventory UNION SELECT item_id FROM guild_bank UNION SELECT item_id FROM prices
      UNION SELECT item_id FROM loot_items WHERE item_id IS NOT NULL UNION SELECT item_id FROM item_names
      UNION SELECT item_id FROM ah_items)
    WHERE id > 0 AND id NOT IN (SELECT item_id FROM item_info) LIMIT ?`).all(limit).map((r) => r.id);
}

async function fillItems(db, api, ns, ids) {
  const save = db.prepare(`INSERT OR REPLACE INTO item_info (item_id, name, quality, ilvl, req_level, item_class, item_subclass, slot, namespace, found, sell_price, fetched_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?, datetime('now'))`);
  const name = db.prepare("INSERT INTO item_names (item_id, name, updated_at) VALUES (?,?, datetime('now')) ON CONFLICT (item_id) DO NOTHING");
  let found = 0;
  for (let i = 0; i < ids.length; i += 5) {
    await Promise.all(ids.slice(i, i + 5).map(async (id) => {
      try {
        const it = await api.get(`/data/wow/item/${id}`, ns.static);
        if (!it) { save.run(id, null, null, null, null, null, null, null, ns.static, 0, null); return; }
        save.run(id, it.name || null, it.quality && it.quality.type, it.level ?? null, it.required_level ?? null,
          it.item_class && it.item_class.name, it.item_subclass && it.item_subclass.name, it.inventory_type && it.inventory_type.name, ns.static, 1,
          Number.isFinite(it.sell_price) ? it.sell_price : null);
        if (it.name) name.run(id, it.name);
        found += 1;
      } catch (e) { /* try again next run */ }
    }));
  }
  return found;
}

// ---- Realm status: up, down, queue ----
async function realmStatus(api, ns, realmName) {
  const index = await api.get('/data/wow/realm/index', ns.dynamic);
  const want = String(realmName).toLowerCase();
  const realm = index && (index.realms || []).find((r) => String(r.name).toLowerCase() === want || r.slug === slug(realmName));
  if (!realm) return { found: false };
  const detail = await api.get(`/data/wow/realm/${realm.slug}`, ns.dynamic);
  const cr = detail && detail.connected_realm && (await api.get(detail.connected_realm.href));
  return {
    found: true, slug: realm.slug, name: realm.name,
    up: cr ? cr.status && cr.status.type === 'UP' : null,
    queue: cr ? Boolean(cr.has_queue) : null,
    population: cr && cr.population && cr.population.name,
    connectedRealm: connectedRealmId(detail),
    checkedAt: new Date().toISOString(),
  };
}

// ---- Official guild roster ----
async function guildRoster(api, ns, realmSlug, guildName) {
  const data = await api.get(`/data/wow/guild/${realmSlug}/${encodeURIComponent(slug(guildName))}/roster`, ns.profile);
  if (!data) return null;
  return (data.members || []).map((m) => ({
    name: m.character && m.character.name,
    level: m.character && m.character.level,
    class: m.character && m.character.playable_class && CLASS_TOKENS[m.character.playable_class.id],
    rank: m.rank,
  })).filter((m) => m.name);
}

function connectedRealmId(detail) {
  const m = /connected-realm\/(\d+)/.exec((detail && detail.connected_realm && detail.connected_realm.href) || '');
  return m ? Number(m[1]) : null;
}

// ---- Auction house (Classic namespaces: one house per faction plus a neutral one) ----
// Classic house ids: 2 Alliance, 6 Horde, 7 neutral. Matched by name first, then by id.
async function auctions(api, ns, connectedRealm, faction) {
  const base = `/data/wow/connected-realm/${connectedRealm}/auctions`;
  const index = await api.get(`${base}/index`, ns.dynamic);
  const houses = (index && index.auctions) || [];
  if (!houses.length) return null;
  const want = String(faction || '').toLowerCase();
  const house = houses.find((h) => want && String(h.name || '').toLowerCase().includes(want))
    || houses.find((h) => h.id === (want === 'horde' ? 6 : 2)) || houses[0];
  const data = await api.get(`${base}/${house.id}`, ns.dynamic);
  if (!data) return null;
  const best = new Map(); // itemId → { price, quantity }
  for (const a of data.auctions || []) {
    const id = a && a.item && a.item.id;
    const qty = Number(a && a.quantity) || 1;
    if (!id || !(a.buyout > 0)) continue;
    const unit = Math.round(a.buyout / qty);
    const b = best.get(id);
    if (!b) best.set(id, { price: unit, quantity: qty });
    else { b.quantity += qty; if (unit < b.price) b.price = unit; }
  }
  return { house: house.name || String(house.id), items: best };
}

function applyAuctions(db, guildId, items) {
  const ins = db.prepare("INSERT INTO ah_prices (guild_id, item_id, price, quantity, fetched_at) VALUES (?,?,?,?, datetime('now'))");
  db.transaction(() => {
    db.prepare('DELETE FROM ah_prices WHERE guild_id = ?').run(guildId);
    for (const [id, b] of items) ins.run(guildId, id, b.price, b.quantity);
  })();
}

// Blizzard's rank: 0 = Guild Master, then each rank below. Anything else is ignored.
const rankIndex = (v) => (Number.isInteger(v) && v >= 0 && v <= 20 ? v : null);

function applyRoster(db, guildId, members) {
  const up = db.prepare(`INSERT INTO characters (guild_id, name, class, level, in_official_roster, rank_index, updated_at)
    VALUES (?,?,?,?,1,?, datetime('now'))
    ON CONFLICT (guild_id, name) DO UPDATE SET class = COALESCE(class, excluded.class),
      level = MAX(COALESCE(level, 0), COALESCE(excluded.level, 0)), in_official_roster = 1,
      rank_index = COALESCE(excluded.rank_index, rank_index)`);
  db.transaction(() => {
    db.prepare('UPDATE characters SET in_official_roster = 0 WHERE guild_id = ?').run(guildId);
    for (const m of members.slice(0, 1000)) up.run(guildId, String(m.name).slice(0, 40), m.class || null, m.level || null, rankIndex(m.rank));
    db.prepare("UPDATE guilds SET official_roster_at = datetime('now'), official_roster_note = ? WHERE id = ?").run(`${members.length} members`, guildId);
    // The official roster is trusted: officer roles follow in-game ranks for members who follow them.
    require('../identity').syncRanks(db, guildId);
  })();
}

// SQLite datetime('now') text is UTC without a zone marker.
const hoursSince = (t) => (t ? (Date.now() - Date.parse(`${t.replace(' ', 'T')}Z`)) / 3600000 : Infinity);

// One pass over everything.
async function run(db, cfg, { fetchImpl, notify, only } = {}) {
  const api = client(cfg, fetchImpl);
  const log = [];
  if (!api.enabled) return [NO_BNET_APP];
  const status = blizzard.load(db);
  for (const g of db.prepare('SELECT * FROM guilds').all()) {
    const ns = namespaces(status, g.wowhead_game, api.region);
    if (!only || only === 'items') {
      const ids = missingItemIds(db);
      if (ids.length) log.push(`Item data: ${await fillItems(db, api, ns, ids)} of ${ids.length} items filled from ${ns.static}`);
    }
    if (!g.realm || !ns.dynamic) continue;
    if (!only || only === 'realm') {
      try {
        let before = null;
        try { before = g.realm_status ? JSON.parse(g.realm_status) : null; } catch { before = null; }
        const s = await realmStatus(api, ns, g.realm);
        db.prepare('UPDATE guilds SET realm_status = ? WHERE id = ?').run(JSON.stringify(s), g.id);
        if (s.found && before && before.up === false && s.up === true && notify) {
          notify(g.id, 'notice', { title: `✅ ${s.name} is back up`, body: s.queue ? 'There is a login queue.' : 'Log in!', route: '/' });
        }
        if (!s.found) log.push(`Realm "${g.realm}" not found in ${ns.dynamic}`);
      } catch (e) { log.push(`Realm status failed: ${e.message}`); }
    }
    // Classic and Forever namespaces only (Retail's auction API is shaped differently); at most hourly.
    const lastAh = db.prepare('SELECT MAX(fetched_at) AS t FROM ah_prices WHERE guild_id = ?').get(g.id).t;
    if (g.wowhead_game !== 'retail' && ((!only && hoursSince(lastAh) >= 1) || only === 'auctions')) {
      try {
        let rs = null;
        try { rs = JSON.parse(db.prepare('SELECT realm_status FROM guilds WHERE id = ?').get(g.id).realm_status || 'null'); } catch { rs = null; }
        const ah = rs && rs.connectedRealm ? await auctions(api, ns, rs.connectedRealm, g.faction) : null;
        if (ah) { applyAuctions(db, g.id, ah.items); log.push(`Auction house: ${ah.items.size} items from ${ah.house}`); }
      } catch (e) { log.push(`Auction house failed: ${e.message}`); }
    }
    if ((!only && hoursSince(g.official_roster_at) >= 12) || only === 'roster') {
      try {
        let rs = null;
        try { rs = g.realm_status ? JSON.parse(g.realm_status) : null; } catch { rs = null; }
        const realmSlug = (rs && rs.slug) || slug(g.realm);
        const members = g.game_guild ? await guildRoster(api, ns, realmSlug, g.game_guild) : null;
        if (members) { applyRoster(db, g.id, members); log.push(`Official roster: ${members.length} members`); }
        else db.prepare("UPDATE guilds SET official_roster_at = datetime('now'), official_roster_note = ? WHERE id = ?").run(`Guild "${g.game_guild}" not found on ${g.realm}`, g.id);
      } catch (e) { log.push(`Official roster failed: ${e.message}`); }
    }
  }
  return log;
}

module.exports = { namespaces, client, missingItemIds, fillItems, realmStatus, guildRoster, applyRoster, auctions, applyAuctions, run, slug, CLASS_TOKENS };
