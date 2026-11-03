// Applies a companion upload (the addon's SavedVariables, converted to JSON)
// and builds the "inbox" the companion writes back into the addon.

const str = (v, max = 80) => (typeof v === 'string' ? v.slice(0, max) : v == null ? null : String(v).slice(0, max));
const int = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : null);
const list = (v) => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : []);

function applyPayload(db, guildId, userId, payload) {
  if (!payload || typeof payload !== 'object') throw new Error('Payload must be an object');
  const stats = { characters: 0, roster: 0, recipes: 0, ctas: [] };
  const now = new Date().toISOString();

  const upsertChar = db.prepare(`
    INSERT INTO characters (guild_id, user_id, name, class, race, level, faction, zone, money, online, last_seen, updated_at)
    VALUES (@guild_id, @user_id, @name, @class, @race, @level, @faction, @zone, @money, 0, @last_seen, @now)
    ON CONFLICT (guild_id, name) DO UPDATE SET
      user_id = excluded.user_id, class = COALESCE(excluded.class, class), race = COALESCE(excluded.race, race),
      level = COALESCE(excluded.level, level), faction = COALESCE(excluded.faction, faction),
      zone = COALESCE(excluded.zone, zone), money = COALESCE(excluded.money, money),
      last_seen = COALESCE(excluded.last_seen, last_seen), updated_at = excluded.updated_at`);
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
      });
      const { id } = charId.get(guildId, name);
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
  return {
    guild: guild ? guild.name : '',
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
