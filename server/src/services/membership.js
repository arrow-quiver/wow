// Joining the guild by itself, and officer roles that follow in-game ranks.
//
// Members no longer need an invite link: Battle.net sign-in reads the player's WoW characters, the app
// sends the characters the addon saved, and a character found in the guild roster joins its player to
// the guild. Invite links stay as a fallback. Shapes are documented in docs/api/core.md ("Joining by itself").
//
// Exports
//   tryAutoJoin(ctx, user, { reported }) → result (never throws for "no match"; see RESULT below)
//       user = users row ({ id, battletag }). reported = characters from the addon's SavedVariables
//       (any shape cleanReported accepts). Battle.net characters come from bnet_characters.
//   syncRanks(ctx, guildId, actor?) → { promoted: [battletag], demoted: [battletag] }
//       Officer or member for every membership with role_source 'rank' (never the owner), from the
//       best rank_index among the member's characters and guilds.officer_rank_max. Audits each change.
//       ctx needs .db; ctx.audit is used when present (gamedata.js passes { db } only).
//   refreshBnetProfile(ctx, userId, accessToken, { timeoutMs }) → { ok, characters, note }
//       Reads the player's WoW characters with their Battle.net token and stores them. Never throws.
//   fetchBnetCharacters(cfg, accessToken, { preferRealm, timeoutMs }) → { ok, characters, note }
//   cleanReported(listOrMap) → [{ name, realm, guild, faction, level, class, updated }] (≤ 50)
//   bnetSummary(db, userId) → { characters, profile_at, note }   (GET /api/me)
//   AUTO_JOIN_MODES   ['roster', 'verified', 'off']
//
// RESULT = { status: 'joined'|'already'|'no-guild-on-server'|'no-match'|'disabled',
//            guild: { id, name, faction }|null, role: 'owner'|'officer'|'member'|null,
//            via: 'battlenet'|'roster'|null, character: string|null, reason: string,
//            detected: { guild, realm, faction }|null }
//
// Injected dependencies: ctx.db, ctx.cfg (bnetRegion, fetch, bnetProfileTimeoutMs), ctx.audit,
// ctx.activity, ctx.emit, ctx.log. All outside HTTP goes through cfg.fetch.
const { FOREVER_GUESSES } = require('./blizzard');
const { CLASS_TOKENS } = require('./gamedata');

const AUTO_JOIN_MODES = ['roster', 'verified', 'off'];
const MAX_REPORTED = 50;
const MAX_BNET_CHARACTERS = 200;
const SUMMARY_LIMIT = 10;
const PROFILE_TIMEOUT_MS = 6000;

// ---- small helpers ----
const s = (v, max) => (typeof v === 'string' || typeof v === 'number' ? String(v).trim().slice(0, max) || null : null);
const n = (v, lo, hi) => {
  if (v == null || v === '' || typeof v === 'boolean' || typeof v === 'object') return null;
  const x = Number(v);
  return Number.isFinite(x) ? Math.min(hi, Math.max(lo, Math.trunc(x))) : null;
};
const lower = (v) => String(v || '').toLocaleLowerCase('en');
// Realm names compare without case, spaces, accents or punctuation ("Mirage Raceway" = "mirage-raceway").
const realmKey = (v) => String(v || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLocaleLowerCase('en').replace(/[^\p{L}\p{N}]/gu, '');
const sameRealm = (a, b) => Boolean(realmKey(a)) && realmKey(a) === realmKey(b);
const realmSlug = (v) => String(v || '').trim().toLocaleLowerCase('en').replace(/['’]/g, '').replace(/\s+/g, '-');
const faction = (v) => {
  const x = lower(v && typeof v === 'object' ? v.type || v.name : v);
  return x === 'horde' ? 'Horde' : x === 'alliance' ? 'Alliance' : null;
};
// With locale=en_GB names are strings; without it Blizzard sends { en_GB: '…', … }.
const text = (v) => {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') return v.en_GB || v.en_US || Object.values(v).find((x) => typeof x === 'string') || null;
  return null;
};

// Characters as the app reports them (from the addon's WowGuildDB.characters). Accepts an array or the
// addon's map keyed by name. Entries without a name are skipped. Strings are capped, the list too.
function cleanReported(input) {
  let entries = [];
  if (Array.isArray(input)) entries = input.map((c) => [null, c]);
  else if (input && typeof input === 'object') entries = Object.entries(input);
  const out = [];
  for (const [key, c] of entries) {
    if (out.length >= MAX_REPORTED) break;
    if (!c || typeof c !== 'object' || Array.isArray(c)) continue;
    const name = s(c.name, 40) || (key && !/^\d+$/.test(key) ? s(key, 40) : null);
    if (!name) continue;
    out.push({
      name,
      realm: s(c.realm, 60),
      guild: s(c.guild, 60),
      faction: s(c.faction, 10),
      level: n(c.level, 0, 1000),
      class: s(c.class, 20),
      updated: n(c.updated, 0, 1e11),
    });
  }
  return out;
}

// Which in-game guild the player seems to be in: the most recently updated reported character with a
// guild, else a Battle.net character with a guild (WoW: Forever first, then the highest level).
function detectGuild(reported, bnet) {
  const rep = reported.filter((c) => c.guild).sort((a, b) => (b.updated || 0) - (a.updated || 0));
  if (rep.length) return { guild: rep[0].guild, realm: rep[0].realm || null, faction: faction(rep[0].faction) };
  const rank = (ns) => (FOREVER_GUESSES.some((g) => String(ns).startsWith(`profile-${g}-`)) ? 0 : /^profile-classic1x-/.test(ns) ? 1 : /^profile-classic-/.test(ns) ? 2 : 3);
  const bn = bnet.filter((c) => c.guild).sort((a, b) => rank(a.namespace) - rank(b.namespace) || (b.level || 0) - (a.level || 0));
  if (bn.length) return { guild: bn[0].guild, realm: bn[0].realm || null, faction: faction(bn[0].faction) };
  return null;
}

// The guild roster: characters of this guild that came from a roster scan (rank set) or Blizzard's
// official roster. Keyed by lower-case name.
function rosterOf(db, guildId) {
  const map = new Map();
  for (const r of db.prepare('SELECT name, user_id FROM characters WHERE guild_id = ? AND (rank IS NOT NULL OR in_official_roster = 1)').all(guildId)) {
    map.set(lower(r.name), r);
  }
  return map;
}

const guildBrief = (g) => (g ? { id: g.id, name: g.name, faction: g.faction } : null);

// ---------------------------------------------------------------- rank mapping

function syncRanks(ctx, guildId, actor = null) {
  const { db } = ctx;
  const out = { promoted: [], demoted: [] };
  const g = db.prepare('SELECT id, officer_rank_max FROM guilds WHERE id = ?').get(guildId);
  if (!g) return out;
  const max = g.officer_rank_max;
  const audit = (action, detail) => {
    if (typeof ctx.audit === 'function') return ctx.audit({ guild: { id: guildId }, user: actor }, action, detail);
    db.prepare('INSERT INTO audit_log (guild_id, user_id, action, detail) VALUES (?,?,?,?)').run(guildId, actor ? actor.id : null, action, String(detail).slice(0, 300));
  };
  const setRole = db.prepare("UPDATE memberships SET role = ? WHERE user_id = ? AND guild_id = ? AND role_source = 'rank' AND role != 'owner'");
  db.transaction(() => {
    const rows = db.prepare(`SELECT m.user_id, m.role, u.battletag,
        (SELECT MIN(c.rank_index) FROM characters c WHERE c.guild_id = m.guild_id AND c.user_id = m.user_id) AS best
      FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.guild_id = ? AND m.role_source = 'rank' AND m.role != 'owner'`).all(guildId);
    for (const r of rows) {
      const want = max != null && r.best != null && r.best <= max ? 'officer' : 'member';
      if (want === r.role) continue;
      setRole.run(want, r.user_id, guildId);
      if (want === 'officer') { out.promoted.push(r.battletag); audit('rank promote', `${r.battletag} (rank ${r.best})`); }
      else { out.demoted.push(r.battletag); audit('rank demote', r.best == null ? r.battletag : `${r.battletag} (rank ${r.best})`); }
    }
  })();
  return out;
}

// ---------------------------------------------------------------- auto join

function tryAutoJoin(ctx, user, { reported = [] } = {}) {
  const { db } = ctx;
  const rep = cleanReported(reported);
  const bnet = db.prepare('SELECT * FROM bnet_characters WHERE user_id = ?').all(user.id);
  const detected = detectGuild(rep, bnet);
  const result = (status, extra) => ({ status, guild: null, role: null, via: null, character: null, reason: '', detected, ...extra });

  const mem = db.prepare(`SELECT g.*, m.role FROM memberships m JOIN guilds g ON g.id = m.guild_id
    WHERE m.user_id = ? ORDER BY m.joined_at, m.guild_id LIMIT 1`).get(user.id);
  const guild = db.prepare('SELECT * FROM guilds ORDER BY id LIMIT 1').get();
  if (!guild && !mem) {
    return result('no-guild-on-server', {
      reason: detected
        ? `${detected.guild} isn't set up on this server yet. Whoever sets it up runs it in Guild Camp.`
        : 'Nobody has set up a guild on this server yet.',
    });
  }
  if (mem) return result('already', { guild: guildBrief(mem), role: mem.role, reason: `You're already in ${mem.name}.` });

  const mode = AUTO_JOIN_MODES.includes(guild.auto_join) ? guild.auto_join : 'roster';
  const gameName = guild.game_guild || guild.name;
  if (mode === 'off') {
    return result('disabled', { guild: guildBrief(guild), reason: `${guild.name} only lets people in with an invite link. Ask an officer for one.` });
  }

  const roster = rosterOf(db, guild.id);
  const realmOk = (realm) => !guild.realm || !realm || sameRealm(realm, guild.realm);

  // 1. Battle.net: the player's own account shows the character, so it is trusted.
  const verified = bnet
    .filter((c) => realmOk(c.realm) && (roster.has(lower(c.name)) || (c.guild && guild.game_guild && lower(c.guild) === lower(guild.game_guild))))
    .sort((a, b) => Number(roster.has(lower(b.name))) - Number(roster.has(lower(a.name))) || (b.level || 0) - (a.level || 0));
  if (verified.length) {
    const c = verified[0];
    const row = roster.get(lower(c.name));
    return join(ctx, user, guild, { via: 'battlenet', character: row ? row.name : c.name, claim: row || null, detected });
  }

  // 2. Reported by the app from the addon's saved data: only in 'roster' mode, only for a name the guild
  //    roster already has, and never one another member owns.
  const failures = [];
  if (mode === 'roster') {
    const matches = [];
    for (const c of rep) {
      if (!guild.game_guild) { failures.push({ code: 'no-game-guild', c }); continue; }
      if (!c.guild || lower(c.guild) !== lower(guild.game_guild)) { failures.push({ code: 'other-guild', c }); continue; }
      if (guild.realm && !sameRealm(c.realm, guild.realm)) { failures.push({ code: 'other-realm', c }); continue; }
      const row = roster.get(lower(c.name));
      if (!row) { failures.push({ code: 'not-in-roster', c }); continue; }
      if (row.user_id && row.user_id !== user.id) { failures.push({ code: 'owned', c, row }); continue; }
      matches.push({ c, row });
    }
    if (matches.length) {
      matches.sort((a, b) => (b.c.updated || 0) - (a.c.updated || 0) || (b.c.level || 0) - (a.c.level || 0));
      const { row } = matches[0];
      return join(ctx, user, guild, { via: 'roster', character: row.name, claim: row, detected });
    }
  }

  return result('no-match', { guild: guildBrief(guild), reason: noMatchReason({ guild, gameName, mode, failures, bnet, rep }) });
}

// A plain sentence that tells the person what to do next.
function noMatchReason({ guild, gameName, mode, failures, bnet, rep }) {
  if (mode === 'verified') {
    if (!bnet.length) return `${guild.name} only adds people when Battle.net shows their character in the guild. Sign in with Battle.net again after you play, or use an invite link.`;
    return `None of your Battle.net characters are in ${gameName}'s roster yet. Ask someone in the guild to open the guild roster in game, or use an invite link.`;
  }
  const first = (code) => failures.find((f) => f.code === code);
  const owned = first('owned');
  if (owned) return `${owned.row.name} is already linked to someone else in Guild Camp. Ask an officer for an invite link.`;
  if (first('not-in-roster')) return `None of your characters are in ${gameName}'s roster yet. Ask someone in the guild to open the guild roster in game, or use an invite link.`;
  const otherRealm = first('other-realm');
  if (otherRealm) {
    const where = otherRealm.c.realm ? `on ${otherRealm.c.realm}` : 'on another realm';
    return `${otherRealm.c.name} is ${where}, but ${gameName} plays on ${guild.realm}. Log in to a character in ${gameName}, then Guild Camp will add you.`;
  }
  if (first('no-game-guild') || (!guild.game_guild && !rep.length && bnet.length)) {
    return `Guild Camp doesn't know which in-game guild ${guild.name} is yet. An officer can set it in Guild settings. Until then, use an invite link.`;
  }
  return `Log in to World of Warcraft once with the Guild Camp addon on a character in ${gameName}, then Guild Camp will add you.`;
}

function join(ctx, user, guild, { via, character, claim, detected }) {
  const { db } = ctx;
  let added = false;
  db.transaction(() => {
    const r = db.prepare("INSERT OR IGNORE INTO memberships (user_id, guild_id, role, role_source) VALUES (?,?, 'member', 'rank')").run(user.id, guild.id);
    added = r.changes > 0;
    if (!added) return;
    db.prepare('UPDATE devices SET guild_id = ? WHERE user_id = ?').run(guild.id, user.id);
    // The matched character becomes theirs when nobody owns it yet.
    if (claim && !claim.user_id) db.prepare('UPDATE characters SET user_id = ? WHERE guild_id = ? AND name = ? AND user_id IS NULL').run(user.id, guild.id, claim.name);
    ctx.activity(guild.id, 'member', `${user.battletag} joined (matched ${character})`);
    // A matched officer becomes an officer here straight away.
    syncRanks(ctx, guild.id);
  })();
  const role = (db.prepare('SELECT role FROM memberships WHERE user_id = ? AND guild_id = ?').get(user.id, guild.id) || {}).role || null;
  const base = { guild: guildBrief(guild), role, via: null, character: null, detected };
  if (!added) return { status: 'already', ...base, reason: `You're already in ${guild.name}.` };
  ctx.audit({ guild: { id: guild.id }, user }, 'auto join', `${character} (${via === 'battlenet' ? 'Battle.net' : 'guild roster'})`);
  ctx.emit(guild.id, 'notice', {
    title: `${user.battletag} joined the guild`,
    body: `Matched ${character} in the guild roster.`,
    route: '/guild-settings',
    officersOnly: true,
  });
  return {
    status: 'joined', ...base, via, character,
    reason: `You're in ${guild.name}. Guild Camp matched ${character}${via === 'battlenet' ? ' on your Battle.net account' : ''}.`,
  };
}

// ---------------------------------------------------------------- Battle.net characters

// The profile namespaces to read, with a plain label for each.
function profileNamespaces(region) {
  return [
    { ns: `profile-${region}`, label: 'Retail' },
    { ns: `profile-classic-${region}`, label: 'Classic' },
    { ns: `profile-classic1x-${region}`, label: 'Classic Era' },
    ...FOREVER_GUESSES.map((g) => ({ ns: `profile-${g}-${region}`, label: 'WoW: Forever' })),
  ];
}

// Settles with whatever finished before the deadline; the rest is left behind.
function settleBy(promises, ms) {
  return new Promise((resolve) => {
    const done = new Array(promises.length).fill(undefined);
    let left = promises.length;
    let timer = null;
    const finish = () => { if (timer) clearTimeout(timer); resolve(done); };
    if (!left) return finish();
    timer = setTimeout(finish, Math.max(0, ms));
    if (timer.unref) timer.unref();
    promises.forEach((p, i) => {
      Promise.resolve(p).then((value) => ({ ok: true, value }), (error) => ({ ok: false, error })).then((r) => {
        done[i] = r;
        left -= 1;
        if (!left) finish();
      });
    });
  });
}

async function fetchBnetCharacters(cfg, accessToken, { preferRealm = null, timeoutMs = PROFILE_TIMEOUT_MS } = {}) {
  const f = cfg.fetch || globalThis.fetch;
  const region = cfg.bnetRegion || 'eu';
  const host = `https://${region}.api.blizzard.com`;
  const deadline = Date.now() + timeoutMs;
  const left = () => Math.max(1, deadline - Date.now());
  const get = async (path, ns) => {
    const res = await f(`${host}${path}?namespace=${encodeURIComponent(ns)}&locale=en_GB`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(left()),
    });
    if (res.status === 404 || res.status === 403) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  };

  // 1. The account profile in every namespace, in parallel.
  const spaces = profileNamespaces(region);
  const answers = await settleBy(spaces.map((sp) => get('/profile/user/wow', sp.ns)), left());
  const characters = [];
  const seen = new Set();
  const found = new Map(); // label → count
  let answered = 0;
  let late = 0;
  answers.forEach((a, i) => {
    // No answer before the deadline (or the request was cut off by it).
    if (!a || (!a.ok && a.error && ['TimeoutError', 'AbortError'].includes(a.error.name))) { late += 1; return; }
    if (!a.ok) return; // an error other than 404/403
    answered += 1;
    const data = a.value;
    if (!data) return;
    for (const acct of Array.isArray(data.wow_accounts) ? data.wow_accounts : []) {
      for (const c of Array.isArray(acct && acct.characters) ? acct.characters : []) {
        if (!c || characters.length >= MAX_BNET_CHARACTERS) continue;
        const name = s(text(c.name), 40);
        const realm = s(text(c.realm && c.realm.name), 60);
        const slug = s((c.realm && c.realm.slug) || realmSlug(realm), 60);
        if (!name || !slug) continue;
        const key = `${spaces[i].ns}|${slug}|${lower(name)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const cls = c.playable_class || {};
        characters.push({
          namespace: spaces[i].ns, name, realm, realm_slug: slug,
          level: n(c.level, 0, 1000),
          class: CLASS_TOKENS[cls.id] || s(text(cls.name), 20)?.toUpperCase().replace(/\s+/g, '') || null,
          faction: faction(c.faction),
          guild: null,
        });
        found.set(spaces[i].label, (found.get(spaces[i].label) || 0) + 1);
      }
    }
  });

  // 2. The guild of the highest-level characters (those on the guild's realm first).
  const picks = [...characters]
    .sort((a, b) => Number(sameRealm(b.realm, preferRealm)) - Number(sameRealm(a.realm, preferRealm)) || (b.level || 0) - (a.level || 0))
    .slice(0, SUMMARY_LIMIT);
  if (picks.length && Date.now() < deadline) {
    const sums = await settleBy(picks.map((c) => get(`/profile/wow/character/${encodeURIComponent(c.realm_slug)}/${encodeURIComponent(lower(c.name))}`, c.namespace)), left());
    sums.forEach((r, i) => {
      if (!r || !r.ok || !r.value) return;
      const g = r.value.guild;
      picks[i].guild = s(text(g && g.name), 60);
      if (!picks[i].faction) picks[i].faction = faction(r.value.faction);
    });
  }

  const ok = answered > 0;
  let note;
  if (characters.length) {
    const parts = [...found.entries()].map(([label, count]) => `${label} ${count}`).join(', ');
    note = `Read ${characters.length} character${characters.length === 1 ? '' : 's'} from Battle.net (${parts}).`;
  } else if (ok) {
    note = 'Battle.net shows no World of Warcraft characters on this account yet.';
  } else {
    note = `Couldn't read your characters from Battle.net (${late ? 'it did not answer in time' : 'it had a problem'}). Guild Camp uses the addon instead.`;
  }
  return { ok, characters, note };
}

// Reads and stores the player's characters. Never throws: sign-in must not fail because of this.
async function refreshBnetProfile(ctx, userId, accessToken, { timeoutMs } = {}) {
  const { db, cfg } = ctx;
  const ms = timeoutMs || cfg.bnetProfileTimeoutMs || PROFILE_TIMEOUT_MS;
  let res;
  try {
    const g = db.prepare('SELECT realm FROM guilds ORDER BY id LIMIT 1').get();
    res = await fetchBnetCharacters(cfg, accessToken, { preferRealm: g && g.realm, timeoutMs: ms });
  } catch (e) {
    if (ctx.log) ctx.log.warn('Reading Battle.net characters failed:', e.message);
    res = { ok: false, characters: [], note: "Couldn't read your characters from Battle.net. Guild Camp uses the addon instead." };
  }
  try {
    db.transaction(() => {
      if (res.ok) {
        // Replace the player's rows: characters deleted or moved in game disappear here too.
        db.prepare('DELETE FROM bnet_characters WHERE user_id = ?').run(userId);
        const ins = db.prepare(`INSERT OR REPLACE INTO bnet_characters (user_id, namespace, name, realm, realm_slug, level, class, faction, guild, fetched_at)
          VALUES (?,?,?,?,?,?,?,?,?, datetime('now'))`);
        for (const c of res.characters) ins.run(userId, c.namespace, c.name, c.realm, c.realm_slug, c.level, c.class, c.faction, c.guild);
        db.prepare("UPDATE users SET bnet_profile_at = datetime('now'), bnet_profile_note = ? WHERE id = ?").run(res.note, userId);
      } else {
        // Battle.net trouble: keep what we read last time.
        db.prepare('UPDATE users SET bnet_profile_note = ? WHERE id = ?').run(res.note, userId);
      }
    })();
  } catch (e) {
    if (ctx.log) ctx.log.warn('Saving Battle.net characters failed:', e.message);
  }
  return { ok: res.ok, characters: res.characters.length, note: res.note };
}

function bnetSummary(db, userId) {
  const u = db.prepare('SELECT bnet_profile_at, bnet_profile_note FROM users WHERE id = ?').get(userId) || {};
  const count = db.prepare('SELECT COUNT(*) AS n FROM bnet_characters WHERE user_id = ?').get(userId).n;
  return { characters: count, profile_at: u.bnet_profile_at ?? null, note: u.bnet_profile_note ?? null };
}

module.exports = {
  tryAutoJoin, syncRanks, refreshBnetProfile, fetchBnetCharacters, cleanReported, bnetSummary, detectGuild,
  AUTO_JOIN_MODES, sameRealm,
};
