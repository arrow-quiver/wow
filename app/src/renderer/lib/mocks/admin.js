// Preview sample data for Officer tools and the officers' part of Guild settings (used only when the renderer runs
// in a plain browser without window.gc). Shapes match docs/api/admin.md (the local core's routes/admin.js):
// the roster and versions this PC knows, local backups with their full path, the audit log, Blizzard game data.
// The guild, its settings and the members list are in ../mock.js.
import { addMockRoutes, httpError, needOfficer, roleOf, meOf, LATEST, BLIZZARD, NO_BNET_APP } from '../mock.js';
import { CHARS } from './community.js';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString();
const sqlTime = (msAgo = 0) => iso(msAgo).replace('T', ' ').slice(0, 19);
const stamp = (msAgo = 0) => iso(msAgo).replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const short = (bt) => String(bt || '').split('#')[0];
const cmp = (a, b) => {
  const pa = String(a).split(/[.-]/).map(Number); const pb = String(b).split(/[.-]/).map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0) ? -1 : 1;
  return 0;
};
const older = (v, newest) => Boolean(v && newest && cmp(v, newest) < 0);

const BACKUP_DIR = 'C:\\Users\\you\\AppData\\Roaming\\Guild Camp\\backups';
const backup = (msAgo, size) => {
  const file = `guildcamp-${stamp(msAgo)}.db`;
  return { file, path: `${BACKUP_DIR}\\${file}`, size, created: iso(msAgo) };
};
// The addon version each character last reported (my own characters, and guildmates who shared theirs).
const ADDON_VERSIONS = { Grimtusk: '0.11.0', Shadowfen: '0.11.0', Vaultkeep: '0.11.0', Velanne: '0.11.1', Mokra: '0.10.2', Tazrik: '0.9.0' };

// Admin-only sample state, kept for the preview session.
const admin = {
  backups: [0, 1, 2, 3, 4, 5].map((d) => backup(d * DAY + 3 * HOUR, 1_843_200 - d * 20_480)),
  audit: [],
  blizzard: {
    checkedAt: iso(5 * HOUR), region: 'eu', ok: true, forever: null, foreverKey: null, classicEra: true, tokenGold: 248_731,
    notes: ['No WoW: Forever namespace yet (tried static-forever-eu, static-wowforever-eu).'],
  },
  rosterAt: sqlTime(6 * HOUR),
};
const AUDIT_SAMPLE = [
  ['Calvin#1234', 'notice posted', 'Molten Core on Friday 20:00 server time.', 3 * HOUR],
  [null, 'backup made', `guildcamp-${stamp(3 * HOUR)}.db`, 3 * HOUR + 2 * MIN],
  ['Calvin#1234', 'officer ranks set', 'Guild Master + 1 rank below', 26 * HOUR],
  ['Calvin#1234', 'coach settings', 'on, $15/month', 2 * DAY],
  ['Calvin#1234', 'Wowhead tooltips set', 'classic', 3 * DAY],
  ['Velanne#2210', 'drive started', 'Durotar supply crates', 4 * DAY],
  ['Calvin#1234', 'raid scheduled', 'Molten Core', 6 * DAY],
  ['Calvin#1234', 'realm set', 'Mirage Raceway / Just Now WoW', 9 * DAY],
];
for (let i = 0; i < 70; i++) {
  const [who, action, detail, ago] = AUDIT_SAMPLE[i % AUDIT_SAMPLE.length];
  admin.audit.push({ battletag: who, action, detail, created_at: sqlTime(ago + Math.floor(i / AUDIT_SAMPLE.length) * 10 * DAY) });
}
admin.audit = admin.audit.map((a, i) => ({ id: 900 - i, user_id: a.battletag ? 1 : null, name: a.battletag ? short(a.battletag) : 'Guild Camp', ...a }));

// Sync health: what this PC knows about players' last syncs and versions.
function healthJson(m, meId) {
  const synced = m.last_sync_at ? Date.parse(`${m.last_sync_at.replace(' ', 'T')}Z`) : null;
  return {
    id: m.id, battletag: m.battletag, name: short(m.battletag), role: m.role, joined_at: m.joined_at, characters: m.characters,
    last_sync_at: m.last_sync_at ?? null, addon_version: m.addon_version ?? null, app_version: m.app_version ?? null,
    addonOutdated: older(m.addon_version, LATEST.addon), appOutdated: older(m.app_version, LATEST.app),
    neverSynced: !m.last_sync_at, stale: Boolean(synced) && Date.now() - synced > 7 * DAY, isMe: m.id === meId,
  };
}

// The roster as this PC last saw it, online first, then most recently seen.
function rosterJson(state) {
  return CHARS.filter((c) => c.rank || c.user_id)
    .map((c) => ({
      name: c.name, class: c.class, level: c.level, rank: c.rank ?? null, rank_index: c.rank_index ?? null, online: c.online, last_seen: c.last_seen ?? null,
      mine: c.user_id === state.userId, addon_version: ADDON_VERSIONS[c.name] || null, addonOutdated: older(ADDON_VERSIONS[c.name], LATEST.addon),
    }))
    .sort((a, b) => (b.online - a.online) || String(b.last_seen || '').localeCompare(String(a.last_seen || '')) || a.name.localeCompare(b.name));
}

function auditPage(before, limit = 50) {
  const rows = admin.audit.filter((a) => !before || a.id < before);
  const entries = rows.slice(0, limit);
  return { entries, nextBefore: rows.length > limit ? entries[entries.length - 1].id : null };
}

function gameData(state) {
  const g = state.guild;
  return {
    namespaces: { static: 'static-classic1x-eu', dynamic: null, profile: null, label: 'Classic Era item data (Forever not in the API yet)' },
    liveData: false,
    itemsKnown: BLIZZARD ? 1_284 : 0,
    realm: g.realm ?? null, game_guild: g.game_guild ?? null,
    realm_status: g.realm_status ?? null,
    official_roster_at: g.official_roster_at ?? null, official_roster_note: g.official_roster_note ?? null,
    officialRosterMembers: 0,
  };
}
function aiJson(state) {
  const g = state.guild;
  return {
    hasKey: Boolean(state.secrets && state.secrets.anthropicKey), coach_enabled: g.coach_enabled ?? 1, coach_budget_usd: g.coach_budget_usd ?? 15,
    spentUsd: 1.8423, month: iso().slice(0, 7), limits: { questionsPerDay: 30, plansPerDay: 5 },
  };
}
const blizzardJson = () => ({ configured: BLIZZARD, region: 'eu', note: BLIZZARD ? null : NO_BNET_APP, status: BLIZZARD ? admin.blizzard : null });
const audit = (state, action, detail = null) => {
  const m = meOf(state);
  admin.audit.unshift({ id: (admin.audit[0]?.id || 0) + 1, user_id: m?.id ?? null, battletag: m?.battletag ?? null, name: m ? short(m.battletag) : 'Guild Camp', action, detail, created_at: sqlTime() });
};

addMockRoutes({
  'GET /api/admin': ({ state, query }) => {
    needOfficer(state);
    const members = state.members.map((m) => healthJson(m, state.userId))
      .sort((a, b) => (a.last_sync_at ? 0 : 1) - (b.last_sync_at ? 0 : 1) || String(b.last_sync_at).localeCompare(String(a.last_sync_at)));
    return {
      isOwner: roleOf(state) === 'owner', latest: { ...LATEST }, members, roster: rosterJson(state), knownLocally: true,
      backupsEnabled: true, backupDir: BACKUP_DIR, backups: admin.backups,
      audit: auditPage(query.before ? Number(query.before) : null), blizzard: blizzardJson(), gameData: gameData(state), ai: aiJson(state),
    };
  },
  'GET /api/admin/audit': ({ state, query }) => {
    needOfficer(state);
    return auditPage(query.before ? Number(query.before) : null, Math.min(200, Number(query.limit) || 50));
  },
  'GET /api/admin/status': ({ state }) => { needOfficer(state); return { blizzard: blizzardJson(), gameData: gameData(state), ai: aiJson(state) }; },
  'POST /api/admin/backups': ({ state }) => {
    needOfficer(state);
    const b = backup(0, 1_851_392);
    if (!admin.backups.some((x) => x.file === b.file)) admin.backups.unshift(b);
    admin.backups = admin.backups.slice(0, 14);
    audit(state, 'backup made', b.file);
    return { ok: true, backup: b, backups: admin.backups, message: 'Backup made.' };
  },
  'POST /api/admin/reset': ({ state, body }) => {
    needOfficer(state);
    if (roleOf(state) !== 'owner') throw httpError(403, 'Only the Guild Master can wipe the game data on this PC.');
    const name = state.guild.name;
    if (String(body?.confirm || '').trim().toLowerCase() !== name.trim().toLowerCase()) throw httpError(400, `Nothing was wiped. Type the guild name (${name}) to confirm.`);
    const b = backup(0, 1_851_392);
    admin.backups.unshift(b);
    state.guild.reset_at = iso();
    audit(state, 'wiped guild data for a fresh start', `4821 rows, backup ${b.file}`);
    return { ok: true, rows: 4821, removed: { characters: 61, raids: 9 }, backup: b.file,
      message: `Fresh start done: 4821 rows of game data removed from this PC (backup ${b.file} kept). `
        + 'People, settings and your unsent changes stay. Guild data shared in game comes back after you log out or type /reload.' };
  },
  'POST /api/admin/blizzard': ({ state }) => {
    needOfficer(state);
    if (BLIZZARD) admin.blizzard = { ...admin.blizzard, checkedAt: iso() };
    return { ok: true, blizzard: blizzardJson(), gameData: gameData(state), message: 'Blizzard API checked.' };
  },
  'POST /api/admin/gamedata/refresh': ({ state }) => {
    needOfficer(state);
    let message = 'Blizzard’s API doesn’t have WoW: Forever realms yet, so realm status and the official guild list will appear once it does.';
    if (!BLIZZARD) message = `${NO_BNET_APP} There is nothing to refresh.`;
    else if (!state.guild.realm) message = 'Save the realm name first, then refresh.';
    return { ok: true, log: [], message, gameData: gameData(state) };
  },
});
