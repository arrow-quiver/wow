// Community data that more than one route needs: the onboarding checklist, recipe search,
// the professions summary and shopping lists priced from the guild price index.
// Ported from the old web/src/server.js (onboardingFor, GET /crafters).
//
// Exports
//   onboardingFor(db, cfg, guildId, user) → { steps: [{ key, label, done, href }], done, total }
//       Synced, professions opened, main chosen, Discord linked (only when the server has a Discord app),
//       signed up for the next raid (only when one is scheduled). href is an app route.
//   searchRecipes(db, guildId, query, { limit = 300 }) → [{ recipe, recipeId, profession, crafters: [...] }]
//       Case-insensitive "contains" match on the recipe name; online crafters first.
//   professionSummary(db, guildId) → [{ name, count, crafters: [{ name, class, level, online, skill, max_skill }] }]
//   whoCanCraft(db, guildId, item) → [{ name, class, online, user_id }]   exact name, case-insensitive
//   shoppingFor(db, guildId, userId) → { items, updatedAt, mats, total, unpriced } | null
//       mats: [{ id, name, need, chars: [{ name, n }], guildBank, price }] sorted by name.
//   guildShoppingLists(db, guildId, { exceptUserId }) → [{ user_id, battletag, main, updatedAt, items, mats, total, unpriced }]
// Injected dependencies: none (pure database code). Prices come from services/economy.js.
const { latestPrices } = require('./economy');

const list = (v) => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : []);
const likeContains = (q) => `%${String(q).replace(/[\\%_]/g, (m) => `\\${m}`)}%`;

// ---- Onboarding ----

function onboardingFor(db, cfg, guildId, user) {
  const uid = user.id;
  const synced = db.prepare('SELECT 1 FROM sync_log WHERE guild_id = ? AND user_id = ? LIMIT 1').get(guildId, uid);
  const chars = db.prepare('SELECT COUNT(*) AS n, MAX(is_main) AS main FROM characters WHERE guild_id = ? AND user_id = ?').get(guildId, uid);
  const profs = db.prepare(`SELECT 1 FROM professions p JOIN characters c ON c.id = p.character_id
    WHERE c.guild_id = ? AND c.user_id = ? LIMIT 1`).get(guildId, uid);
  const nextRaid = db.prepare(`SELECT id, title FROM raids WHERE guild_id = ? AND status IN ('open','locked') AND starts_at > ?
    ORDER BY starts_at LIMIT 1`).get(guildId, new Date().toISOString());
  const myChar = db.prepare('SELECT name FROM characters WHERE guild_id = ? AND user_id = ? ORDER BY level DESC LIMIT 1').get(guildId, uid);

  const steps = [
    { key: 'synced', done: Boolean(synced), label: 'Install the addon, then log in to the game once', href: '/addon' },
    { key: 'professions', done: Boolean(profs), label: 'Open each profession window in game, then /reload', href: '/crafters' },
    // "Make this my main" lives on the character page.
    { key: 'main', done: Boolean(chars.main), label: 'Pick your main character', href: myChar ? `/characters/${encodeURIComponent(myChar.name)}` : '/roster' },
  ];
  // Settings deep link: jumps to the Discord card and makes a link code straight away.
  if (cfg.discordPublicKey) steps.push({ key: 'discord', done: Boolean(user.discord_id), label: 'Link your Discord', href: '/settings?section=discord&link=1' });
  if (nextRaid) {
    const signed = db.prepare('SELECT 1 FROM signups WHERE raid_id = ? AND user_id = ?').get(nextRaid.id, uid);
    steps.push({ key: 'signup', done: Boolean(signed), label: `Sign up for ${nextRaid.title}`, href: `/raids/${nextRaid.id}` });
  }
  return { steps, done: steps.filter((s) => s.done).length, total: steps.length };
}

// ---- Crafters ----

function searchRecipes(db, guildId, query, { limit = 300 } = {}) {
  const rows = db.prepare(`SELECT r.name AS recipe, r.recipe_id, r.profession, c.name, c.class, c.level, c.online, c.user_id
    FROM recipes r JOIN characters c ON c.id = r.character_id
    WHERE c.guild_id = ? AND r.name LIKE ? ESCAPE '\\'
    ORDER BY r.name COLLATE NOCASE, c.online DESC, c.name LIMIT ?`).all(guildId, likeContains(query), limit);
  const map = new Map();
  for (const r of rows) {
    // Two characters can store the same recipe with different capitalisation; group them together.
    const key = r.recipe.toLowerCase();
    if (!map.has(key)) map.set(key, { recipe: r.recipe, recipeId: null, profession: r.profession, crafters: [] });
    const g = map.get(key);
    if (!g.recipeId && r.recipe_id) g.recipeId = r.recipe_id;
    if (!g.crafters.some((c) => c.name === r.name)) {
      g.crafters.push({ name: r.name, class: r.class, level: r.level, online: r.online, user_id: r.user_id });
    }
  }
  return [...map.values()];
}

function professionSummary(db, guildId) {
  const rows = db.prepare(`SELECT p.name AS prof, p.skill, p.max_skill, c.name, c.class, c.level, c.online
    FROM professions p JOIN characters c ON c.id = p.character_id
    WHERE c.guild_id = ? ORDER BY p.name, p.skill DESC, c.name`).all(guildId);
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.prof)) map.set(r.prof, []);
    map.get(r.prof).push({ name: r.name, class: r.class, level: r.level, online: r.online, skill: r.skill, max_skill: r.max_skill });
  }
  return [...map].map(([name, crafters]) => ({ name, count: crafters.length, crafters }));
}

// Characters in the guild that know `item` (exact recipe name, any capitalisation).
function whoCanCraft(db, guildId, item) {
  return db.prepare(`SELECT DISTINCT c.name, c.class, c.online, c.user_id FROM recipes r JOIN characters c ON c.id = r.character_id
    WHERE c.guild_id = ? AND lower(r.name) = lower(?) ORDER BY c.online DESC, c.name`).all(guildId, item);
}

// ---- Shopping lists (from the addon's profession helper, stored by services/sync.js) ----

function parseItems(text) {
  try {
    return list(JSON.parse(text)).filter((e) => e && e.name);
  } catch {
    return [];
  }
}

// Total of every mat on a list, each mat counted once per crafted item.
function matsNeeded(items) {
  const need = new Map();
  for (const e of items) {
    for (const g of list(e.reagents)) {
      if (!g || !g.id) continue;
      const cur = need.get(g.id) || { id: g.id, name: g.name || `Item ${g.id}`, need: 0 };
      cur.need += (Number(g.qty) || 1) * (Number(e.qty) || 1);
      need.set(g.id, cur);
    }
  }
  return need;
}

function priced(db, guildId, need) {
  const prices = latestPrices(db, guildId, [...need.keys()]);
  let total = 0;
  let unpriced = 0;
  const mats = [...need.values()].map((m) => {
    const price = prices[m.id] ? prices[m.id].price : null;
    if (price == null) unpriced += 1;
    else total += price * m.need;
    return { ...m, price };
  });
  return { mats, total, unpriced };
}

function shoppingFor(db, guildId, userId) {
  const row = db.prepare('SELECT items, updated_at FROM shopping_lists WHERE user_id = ?').get(userId);
  if (!row) return null;
  const items = parseItems(row.items);
  if (!items.length) return null;
  const { mats, total, unpriced } = priced(db, guildId, matsNeeded(items));
  // Where the player already has each mat, and what the guild holds (guild bank plus bank characters).
  const mine = db.prepare(`SELECT c.name, SUM(i.count) AS n FROM inventory i JOIN characters c ON c.id = i.character_id
    WHERE c.guild_id = ? AND c.user_id = ? AND i.item_id = ? GROUP BY c.name ORDER BY c.name`);
  const bank = db.prepare(`SELECT COALESCE((SELECT SUM(count) FROM guild_bank WHERE guild_id = ? AND item_id = ?), 0)
    + COALESCE((SELECT SUM(i.count) FROM inventory i JOIN characters c ON c.id = i.character_id
        WHERE c.guild_id = ? AND c.is_bank = 1 AND i.item_id = ?), 0) AS n`);
  return {
    items: items.map((e) => ({ name: e.name, qty: Number(e.qty) || 1, prof: e.prof || null })),
    updatedAt: row.updated_at,
    mats: mats.map((m) => ({ ...m, chars: mine.all(guildId, userId, m.id), guildBank: bank.get(guildId, m.id, guildId, m.id).n }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name))),
    total,
    unpriced,
  };
}

function guildShoppingLists(db, guildId, { exceptUserId = null } = {}) {
  const rows = db.prepare(`SELECT s.user_id, s.items, s.updated_at, u.battletag FROM shopping_lists s
    JOIN memberships m ON m.user_id = s.user_id AND m.guild_id = ?
    JOIN users u ON u.id = s.user_id ORDER BY s.updated_at DESC`).all(guildId);
  const mainQ = db.prepare(`SELECT name, class, level FROM characters WHERE guild_id = ? AND user_id = ?
    ORDER BY is_main DESC, level DESC, name LIMIT 1`);
  const out = [];
  for (const r of rows) {
    if (exceptUserId && r.user_id === exceptUserId) continue;
    const items = parseItems(r.items);
    if (!items.length) continue;
    const { mats, total, unpriced } = priced(db, guildId, matsNeeded(items));
    out.push({
      user_id: r.user_id,
      battletag: r.battletag,
      main: mainQ.get(guildId, r.user_id) || null,
      updatedAt: r.updated_at,
      items: items.map((e) => ({ name: e.name, qty: Number(e.qty) || 1, prof: e.prof || null })),
      mats: mats.sort((a, b) => String(a.name).localeCompare(String(b.name))),
      total,
      unpriced,
    });
  }
  return out;
}

module.exports = { onboardingFor, searchRecipes, professionSummary, whoCanCraft, shoppingFor, guildShoppingLists, matsNeeded };
