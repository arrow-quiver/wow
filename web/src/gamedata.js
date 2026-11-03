// Official game data from Blizzard's free Game Data and Profile APIs.
// WoW: Forever isn't in the API yet. Until it is, item details come from Classic Era (same item IDs),
// and realm status / the official roster wait. The day blizzard.check() finds a Forever namespace,
// everything here switches over by itself.
const blizzard = require('./blizzard');

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

function client(cfg, fetchImpl = fetch) {
  let tok = null; let until = 0;
  const region = cfg.bnetRegion || 'eu';
  function bearer() {
    // Share one token request between parallel calls.
    if (!tok || Date.now() >= until) {
      until = Date.now() + 20 * 3600 * 1000;
      tok = blizzard.token(cfg, fetchImpl).catch((e) => { tok = null; throw e; });
    }
    return tok;
  }
  // path may be a full href from a previous response (those already carry ?namespace=).
  async function get(path, ns) {
    const url = path.startsWith('https://') ? path : `https://${region}.api.blizzard.com${path}?namespace=${ns}&locale=en_GB`;
    const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${await bearer()}` }, signal: AbortSignal.timeout(10000) });
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
      UNION SELECT item_id FROM loot_items WHERE item_id IS NOT NULL UNION SELECT item_id FROM item_names)
    WHERE id > 0 AND id NOT IN (SELECT item_id FROM item_info) LIMIT ?`).all(limit).map((r) => r.id);
}

async function fillItems(db, api, ns, ids) {
  const save = db.prepare(`INSERT OR REPLACE INTO item_info (item_id, name, quality, ilvl, req_level, item_class, item_subclass, slot, namespace, found, fetched_at)
    VALUES (?,?,?,?,?,?,?,?,?,?, datetime('now'))`);
  const name = db.prepare(`INSERT INTO item_names (item_id, name, updated_at) VALUES (?,?, datetime('now')) ON CONFLICT (item_id) DO NOTHING`);
  let found = 0;
  for (let i = 0; i < ids.length; i += 5) {
    await Promise.all(ids.slice(i, i + 5).map(async (id) => {
      try {
        const it = await api.get(`/data/wow/item/${id}`, ns.static);
        if (!it) { save.run(id, null, null, null, null, null, null, null, ns.static, 0); return; }
        save.run(id, it.name || null, it.quality && it.quality.type, it.level ?? null, it.required_level ?? null,
          it.item_class && it.item_class.name, it.item_subclass && it.item_subclass.name, it.inventory_type && it.inventory_type.name, ns.static, 1);
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

function applyRoster(db, guildId, members) {
  const up = db.prepare(`INSERT INTO characters (guild_id, name, class, level, in_official_roster, updated_at)
    VALUES (?,?,?,?,1, datetime('now'))
    ON CONFLICT (guild_id, name) DO UPDATE SET class = COALESCE(class, excluded.class),
      level = MAX(COALESCE(level, 0), COALESCE(excluded.level, 0)), in_official_roster = 1`);
  db.transaction(() => {
    db.prepare('UPDATE characters SET in_official_roster = 0 WHERE guild_id = ?').run(guildId);
    for (const m of members.slice(0, 1000)) up.run(guildId, String(m.name).slice(0, 40), m.class || null, m.level || null);
    db.prepare("UPDATE guilds SET official_roster_at = datetime('now'), official_roster_note = ? WHERE id = ?").run(`${members.length} members`, guildId);
  })();
}

// One pass over everything. notify(guildId, kind, msg) is the push helper.
async function run(db, cfg, { fetchImpl, notify, only } = {}) {
  const api = client(cfg, fetchImpl);
  const log = [];
  if (!api.enabled) return ['No Battle.net app configured.'];
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
        const before = g.realm_status ? JSON.parse(g.realm_status) : null;
        const s = await realmStatus(api, ns, g.realm);
        db.prepare('UPDATE guilds SET realm_status = ? WHERE id = ?').run(JSON.stringify(s), g.id);
        if (s.found && before && before.up === false && s.up === true && notify) {
          notify(g.id, 'notices', { title: `✅ ${s.name} is back up`, body: s.queue ? 'There is a login queue.' : 'Log in!', url: '/', tag: 'realm' });
        }
        if (!s.found) log.push(`Realm "${g.realm}" not found in ${ns.dynamic}`);
      } catch (e) { log.push(`Realm status failed: ${e.message}`); }
    }
    if ((!only && hoursSince(g.official_roster_at) >= 12) || only === 'roster') {
      try {
        const rs = g.realm_status ? JSON.parse(g.realm_status) : null;
        const realmSlug = (rs && rs.slug) || slug(g.realm);
        const members = g.game_guild ? await guildRoster(api, ns, realmSlug, g.game_guild) : null;
        if (members) { applyRoster(db, g.id, members); log.push(`Official roster: ${members.length} members`); }
        else db.prepare("UPDATE guilds SET official_roster_at = datetime('now'), official_roster_note = ? WHERE id = ?").run(`Guild "${g.game_guild}" not found on ${g.realm}`, g.id);
      } catch (e) { log.push(`Official roster failed: ${e.message}`); }
    }
  }
  return log;
}
const hoursSince = (t) => (t ? (Date.now() - Date.parse(`${t.replace(' ', 'T')}Z`)) / 3600000 : Infinity);

module.exports = { namespaces, client, missingItemIds, fillItems, realmStatus, guildRoster, applyRoster, run, slug, CLASS_TOKENS };
