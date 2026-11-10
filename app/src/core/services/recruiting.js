// Recruiting: who the guild has been in touch with (recruits, from "rk" records), how each recruiter is doing, the
// officers' ad and message ("RA"), and season points for a recruit who stays. API: docs/api/community.md
// ("Recruiting").
//
// A recruiter earns RECRUIT_POINTS when someone they found joins and is still in the guild STAY_DAYS later (the
// roster still has the character, here in this guild). The points land on that day. The character must have
// first shown up on the roster after they were contacted (characters.first_seen), so marking an old guildie as a
// recruit earns nothing. Times are this app's own (contacted_at, joined_at), not the writer's.
const identity = require('../identity');

const RECRUIT_POINTS = 25;
const STAY_DAYS = 7;
const DAY = 86400;
const STATES = { c: 'contacted', i: 'interested', n: 'no thanks', j: 'joined' };
const DEFAULTS = {
  ad: 'wow is recruiting! A friendly Horde PvP guild: war parties, raids and a guild bank. All levels welcome. /w me',
  msg: 'Hey {name}! I saw you\'re not in a guild. We\'re a friendly Horde PvP guild with raids, war parties and a guild bank. Want an invite?',
  classes: '', minLevel: 10, maxLevel: 60,
};

function settings(db, gid) {
  const r = db.prepare('SELECT * FROM recruit_settings WHERE guild_id = ?').get(gid);
  if (!r) return { ...DEFAULTS, custom: false };
  return { ad: r.ad || DEFAULTS.ad, msg: r.msg || DEFAULTS.msg, classes: r.classes || '', minLevel: r.min_level ?? DEFAULTS.minLevel, maxLevel: r.max_level ?? DEFAULTS.maxLevel, custom: true };
}

function nameOf(db, gid) {
  const rows = db.prepare(`SELECT u.id, (SELECT name FROM characters c WHERE c.user_id = u.id AND c.guild_id = ? AND c.is_bank = 0
      ORDER BY c.is_main DESC, c.level DESC LIMIT 1) AS name FROM users u`).all(gid);
  const m = new Map(rows.map((r) => [r.id, r.name]));
  return (id) => (id ? m.get(id) || null : null);
}

const unix = (s) => Math.floor(Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(String(s)) ? s : `${String(s).replace(' ', 'T')}Z`) / 1000);

// Still in the guild: the roster has the character here. → its first_seen (unix), or 0.
function stillHere(db, gid) {
  const here = identity.notElsewhere('c');
  const q = db.prepare(`SELECT c.first_seen FROM characters c WHERE c.guild_id = ? AND lower(c.name) = lower(?) AND (c.in_official_roster IS NULL OR c.in_official_roster = 1) AND ${here}`);
  return (name) => { const r = q.get(gid, name); return r ? unix(r.first_seen) || 1 : 0; };
}

// A real recruit: on the roster now, and first seen there after they were contacted (an hour's slack).
function counts(r, here) {
  const first = here(r.name);
  return Boolean(first) && first >= r.contacted_at - 3600;
}

function list(db, gid, { now = Math.floor(Date.now() / 1000) } = {}) {
  const who = nameOf(db, gid);
  const here = stillHere(db, gid);
  return db.prepare('SELECT * FROM recruits WHERE guild_id = ? ORDER BY at DESC').all(gid).map((r) => {
    const stays = r.state === 'j' && r.joined_at && counts(r, here);
    return {
      name: r.name, level: r.level, class: r.class, zone: r.zone, state: r.state, stateLabel: STATES[r.state], at: r.at,
      recruiter: who(r.recruiter), joinedAt: r.joined_at,
      stayed: Boolean(stays && now - r.joined_at >= STAY_DAYS * DAY), left: r.state === 'j' && r.joined_at && !here(r.name),
    };
  });
}

// Season events (ms): a recruit who stayed a week, for whoever found them.
function events(db, gid, from, to) {
  const here = stillHere(db, gid);
  const out = [];
  for (const r of db.prepare("SELECT name, recruiter, contacted_at, joined_at FROM recruits WHERE guild_id = ? AND state = 'j' AND recruiter IS NOT NULL AND joined_at IS NOT NULL").all(gid)) {
    const at = (r.joined_at + STAY_DAYS * DAY) * 1000;
    if (at >= from && at < to && at <= Date.now() && counts(r, here)) out.push({ userId: r.recruiter, kind: 'recruit', n: 1, at });
  }
  return out;
}

function stats(db, gid) {
  const who = nameOf(db, gid);
  const rows = list(db, gid);
  const by = new Map();
  for (const r of db.prepare('SELECT recruiter, state, name, contacted_at, joined_at FROM recruits WHERE guild_id = ? AND recruiter IS NOT NULL').all(gid)) {
    const s = by.get(r.recruiter) || { name: who(r.recruiter), contacted: 0, interested: 0, joined: 0, stayed: 0 };
    s.contacted += 1;
    if (r.state === 'i') s.interested += 1;
    if (r.state === 'j') s.joined += 1;
    if (rows.find((x) => x.name === r.name && x.stayed)) s.stayed += 1;
    by.set(r.recruiter, s);
  }
  const counts = { c: 0, i: 0, n: 0, j: 0 };
  for (const r of rows) counts[r.state] += 1;
  return { counts, recruiters: [...by.values()].filter((s) => s.name).sort((a, b) => b.stayed - a.stayed || b.joined - a.joined || b.contacted - a.contacted) };
}

module.exports = { RECRUIT_POINTS, STAY_DAYS, DEFAULTS, STATES, settings, list, events, stats };
