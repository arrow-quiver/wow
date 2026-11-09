// War alerts and the war map (routes/war.js), and the "wm" record's rows (share/project.js).
//
//   alertText(death) → the Discord line for a death to players
//   helpText({ character, zone, enemies, message }) → the Discord line for "Call for help"
//   overview(db, { guildId, userId, days, now, alerts }) → the War page (docs/api/war.md)
//   applyMarks(db, guildId, pid, userId, fields)   replaces one player's war_marks from their "wm" record (null = gone)
const DAY_MS = 86400000;
const CELL = 50; // hotspot cells: 5% of the map each way

const bold = (s) => `**${String(s).replace(/[*_~`|>]/g, '')}**`;

function others(enemies, killer) {
  const rest = (enemies || []).filter((n) => n && n !== killer);
  if (!rest.length) return '';
  return ` and ${rest.length === 1 ? bold(rest[0]) : `${rest.length} more`}`;
}

function alertText(d) {
  const killer = d.killer ? ` to ${bold(d.killer)}${others(d.enemies, d.killer)}` : ' to players';
  const where = d.zone ? ` in ${bold(d.zone)}` : '';
  const blow = d.spell ? ` (${d.spell}${d.amount ? ` for ${d.amount}` : ''})` : '';
  return `⚔️ ${bold(d.character)} died${killer}${where}${blow}. Anyone near?`;
}

function helpText({ character, zone, enemies, message }) {
  const n = (enemies || []).length;
  const foes = n ? `: ${n} enem${n === 1 ? 'y' : 'ies'} (${enemies.slice(0, 4).join(', ')}${n > 4 ? ', …' : ''})` : '';
  return `🆘 ${bold(character)} needs help${zone ? ` in ${bold(zone)}` : ''}${foes}.${message ? ` ${message}` : ''}`;
}

// The guild's marks from "wm" records: the account's list replaces the old one.
function applyMarks(db, guildId, pid, userId, fields) {
  db.prepare('DELETE FROM war_marks WHERE guild_id = ? AND pid = ?').run(guildId, pid);
  if (!fields) return 0;
  const names = db.prepare('INSERT INTO war_maps (map_id, name) VALUES (?, ?) ON CONFLICT(map_id) DO UPDATE SET name = excluded.name');
  for (const m of Array.isArray(fields.maps) ? fields.maps : []) {
    if (m && Number.isInteger(m.id) && m.id > 0 && m.name) names.run(m.id, String(m.name).slice(0, 60));
  }
  const put = db.prepare('INSERT OR IGNORE INTO war_marks (guild_id, pid, user_id, map_id, x, y, at, kind, n) VALUES (?,?,?,?,?,?,?,?,?)');
  let n = 0;
  for (const m of Array.isArray(fields.marks) ? fields.marks : []) {
    if (!m || !Number.isInteger(m.map) || !Number.isInteger(m.at) || !['d', 'k'].includes(m.kind)) continue;
    const c = (v) => Math.max(0, Math.min(1000, Number.isInteger(v) ? v : 0));
    put.run(guildId, pid, userId || null, m.map, c(m.x), c(m.y), m.at, m.kind, Number.isInteger(m.n) ? m.n : null);
    n += 1;
  }
  return n;
}

function overview(db, { guildId, userId, days = 7, now = Date.now(), alerts = false }) {
  const since = now - days * DAY_MS;
  const marks = guildId == null ? [] : db.prepare(`SELECT wm.*, mp.name AS zone,
      COALESCE((SELECT name FROM characters c WHERE c.user_id = wm.user_id AND c.guild_id = wm.guild_id ORDER BY c.is_main DESC, c.level DESC LIMIT 1),
        (SELECT battletag FROM users u WHERE u.id = wm.user_id)) AS who
    FROM war_marks wm LEFT JOIN war_maps mp ON mp.map_id = wm.map_id
    WHERE wm.guild_id = ? AND wm.at >= ? ORDER BY wm.at DESC`).all(guildId, Math.floor(since / 1000));

  const zones = new Map();
  const cells = new Map();
  const players = new Set();
  for (const m of marks) {
    const who = m.who ? String(m.who).split('#')[0] : null;
    if (m.user_id) players.add(m.user_id);
    const z = zones.get(m.map_id) || { mapId: m.map_id, zone: m.zone || `Map ${m.map_id}`, deaths: 0, kills: 0, marks: [] };
    z[m.kind === 'd' ? 'deaths' : 'kills'] += 1;
    z.marks.push({ x: m.x, y: m.y, at: m.at, kind: m.kind, who, n: m.n });
    zones.set(m.map_id, z);
    const key = `${m.map_id}:${Math.floor(m.x / CELL)}:${Math.floor(m.y / CELL)}`;
    const c = cells.get(key) || { mapId: m.map_id, zone: z.zone, sx: 0, sy: 0, deaths: 0, kills: 0, last: 0, n: 0 };
    c.sx += m.x; c.sy += m.y; c.n += 1; c[m.kind === 'd' ? 'deaths' : 'kills'] += 1; c.last = Math.max(c.last, m.at);
    cells.set(key, c);
  }
  const hotspots = [...cells.values()].filter((c) => c.n >= 2)
    .sort((a, b) => b.n - a.n || b.last - a.last).slice(0, 6)
    .map((c) => ({ mapId: c.mapId, zone: c.zone, x: Math.round(c.sx / c.n), y: Math.round(c.sy / c.n), deaths: c.deaths, kills: c.kills, last: c.last }));

  const mine = db.prepare('SELECT * FROM pvp_deaths WHERE user_id = ? AND at >= ? ORDER BY at DESC').all(userId, since);
  const pvp = mine.filter((d) => d.pvp);
  const nem = new Map();
  for (const d of pvp) if (d.killer) nem.set(d.killer, (nem.get(d.killer) || 0) + 1);
  return {
    days, alerts,
    guild: { deaths: marks.filter((m) => m.kind === 'd').length, kills: marks.filter((m) => m.kind === 'k').length, players: players.size },
    zones: [...zones.values()].sort((a, b) => (b.deaths + b.kills) - (a.deaths + a.kills)),
    hotspots,
    mine: {
      deaths: mine.length, pvpDeaths: pvp.length,
      recent: mine.slice(0, 10).map((d) => ({
        character: d.character, at: d.at, pvp: Boolean(d.pvp), killer: d.killer, enemies: JSON.parse(d.enemies || '[]'),
        zone: d.zone, spell: d.spell, amount: d.amount, posted: Boolean(d.posted),
      })),
      nemeses: [...nem.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, kills]) => ({ name, kills })),
    },
  };
}

module.exports = { alertText, helpText, overview, applyMarks };
