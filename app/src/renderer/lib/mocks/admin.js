// Preview sample data for the admin pages (used only when the renderer runs in a plain browser without window.gc).
// Shapes match docs/api/admin.md (officer tools, calendar) and docs/api/core.md (guild, settings, members), plus
// the Discord domain's GET /api/discord and POST /api/discord/register used by Guild settings.
import { addMockRoutes } from '../mock.js';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString();
const sqlTime = (msAgo = 0) => iso(msAgo).replace('T', ' ').slice(0, 19);
const stamp = (msAgo = 0) => iso(msAgo).replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

const LATEST = { app: '0.11.1', addon: '0.11.1' };
const MAIN_CLASS = { Grimtusk: 'WARRIOR', Velanne: 'PRIEST', Mokra: 'SHAMAN', Tazrik: 'ROGUE' };
const MAIN_LEVEL = { Grimtusk: 60, Velanne: 60, Mokra: 58, Tazrik: 35 };
const ROLE_ORDER = { owner: 0, officer: 1, member: 2 };
const short = (bt) => String(bt || '').split('#')[0];
const cmp = (a, b) => {
  const pa = String(a).split(/[.-]/).map(Number); const pb = String(b).split(/[.-]/).map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0) ? -1 : 1;
  return 0;
};
const older = (v, newest) => Boolean(v && newest && cmp(v, newest) < 0);

// Admin-only sample state, kept for the preview session.
const admin = {
  backups: [0, 1, 2, 3, 4, 5].map((d) => ({ file: `wow-${stamp(d * DAY + 3 * HOUR)}.db`, size: 1_843_200 - d * 20_480, created: iso(d * DAY + 3 * HOUR) })),
  audit: [],
  blizzard: {
    checkedAt: iso(5 * HOUR), region: 'eu', ok: true, forever: null, foreverKey: null, classicEra: true, tokenGold: 248_731,
    notes: ['No WoW: Forever namespace yet (tried static-forever-eu, static-wowforever-eu).'],
  },
  realmStatus: { found: true, slug: 'mirage-raceway', name: 'Mirage Raceway', up: true, queue: false, population: 'High', checkedAt: iso(4 * MIN) },
  rosterAt: sqlTime(6 * HOUR),
  spent: 6.42,
  calendarToken: 'Q2x1Zl9hYmNkZWZnaGlqa2xt',
  discordLinked: false,
};
const AUDIT_SAMPLE = [
  ['Calvin#1234', 'promoted to officer', 'Velanne#2210', 3 * HOUR],
  [null, 'backup made', `wow-${stamp(3 * HOUR)}.db`, 3 * HOUR + 2 * MIN],
  ['Velanne#2210', 'invite link replaced', null, 26 * HOUR],
  ['Calvin#1234', 'coach settings', 'on, $15/month', 2 * DAY],
  ['Calvin#1234', 'Wowhead tooltips set', 'classic', 3 * DAY],
  ['Velanne#2210', 'removed from guild', 'Gorbash#1180', 4 * DAY],
  ['Calvin#1234', 'Discord webhook set', null, 6 * DAY],
  ['Calvin#1234', 'realm set', 'Mirage Raceway / Just Now WoW', 9 * DAY],
];
for (let i = 0; i < 70; i++) {
  const [who, action, detail, ago] = AUDIT_SAMPLE[i % AUDIT_SAMPLE.length];
  admin.audit.push({ battletag: who, action, detail, created_at: sqlTime(ago + Math.floor(i / AUDIT_SAMPLE.length) * 10 * DAY) });
}
admin.audit = admin.audit.map((a, i) => ({ id: 900 - i, user_id: a.battletag ? 1 : null, name: a.battletag ? short(a.battletag) : 'system', ...a }));

function me(state) { return state.members.find((m) => m.id === state.userId) || null; }
function role(state) { return state.inGuild ? me(state)?.role || null : null; }
function needGuild(state) {
  if (!state.signedIn) throw httpError(401, 'Sign in first.');
  if (!state.inGuild || !state.serverGuild) throw httpError(403, 'Join a guild first.');
}
function needOfficer(state) {
  needGuild(state);
  const r = role(state);
  if (r !== 'owner' && r !== 'officer') throw httpError(403, 'Officers only.');
}

// The full Guild shape from core.md, built from the base mock's guild.
function guildJson(state) {
  const g = state.serverGuild;
  const r = role(state);
  g.coach_enabled ??= 1;
  g.coach_budget_usd ??= 15;
  g.game_guild ??= g.name;
  g.discord_webhook ??= 'https://discord.com/api/webhooks/1234567890/sample';
  g.auto_join ??= 'roster';
  if (g.officer_rank_max === undefined) g.officer_rank_max = 1;
  return {
    id: g.id, name: g.name, faction: g.faction, ruleset: 'PvP', wowhead_game: g.wowhead_game || 'forever',
    realm: g.realm ?? null, game_guild: g.game_guild ?? null, realm_status: g.realm ? admin.realmStatus : null,
    official_roster_at: g.realm ? admin.rosterAt : null, official_roster_note: g.realm ? '42 members' : null,
    roster_scanned_at: sqlTime(4 * MIN), bank_money: 12_345_678, bank_scanned_at: sqlTime(20 * HOUR), discord_server_id: '9988776655',
    coach_enabled: g.coach_enabled, coach_budget_usd: g.coach_budget_usd, reset_at: g.reset_at ?? null, created_at: g.created_at,
    auto_join: g.auto_join, officer_rank_max: g.officer_rank_max,
    role: r, invite_code: g.invite_code, inviteUrl: `${state.settings.serverUrl}/join/${encodeURIComponent(g.invite_code)}`,
    ...(r === 'owner' || r === 'officer' ? { discord_webhook: g.discord_webhook || null } : {}),
  };
}

function memberJson(m) {
  return {
    id: m.id, battletag: m.battletag, name: short(m.battletag), role: m.role, joined_at: m.joined_at,
    characters: m.main ? (m.id === 1 ? 2 : 1) : 0,
    main: m.main ? { name: m.main, class: MAIN_CLASS[m.main] || null, level: MAIN_LEVEL[m.main] || null, is_main: 1 } : null,
    addon_version: m.addon_version ?? null, app_version: m.app_version ?? null,
    companion_version: m.id === 4 ? '0.4.0' : null,
    last_sync_at: m.last_sync_at ?? null, discord_linked: m.id <= 2, devices: m.app_version ? 1 : 0, sync_keys: m.id === 4 ? 1 : 0,
  };
}

function healthJson(m) {
  const j = memberJson(m);
  const synced = j.last_sync_at ? Date.parse(`${j.last_sync_at.replace(' ', 'T')}Z`) : null;
  return {
    ...j,
    addonOutdated: older(j.addon_version, LATEST.addon),
    appOutdated: older(j.app_version, LATEST.app),
    legacyCompanion: Boolean(j.companion_version && !j.app_version),
    neverSynced: !j.last_sync_at,
    stale: Boolean(synced) && Date.now() - synced > 7 * DAY,
  };
}

function auditPage(before, limit = 50) {
  const rows = admin.audit.filter((a) => !before || a.id < before);
  const entries = rows.slice(0, limit);
  return { entries, nextBefore: rows.length > limit ? entries[entries.length - 1].id : null };
}

function gameData(state) {
  const g = state.serverGuild;
  return {
    namespaces: { static: 'static-classic1x-eu', dynamic: null, profile: null, label: 'Classic Era item data (Forever not in the API yet)' },
    liveData: false,
    itemsKnown: 1_284,
    realm: g.realm ?? null, game_guild: g.game_guild ?? null,
    realm_status: g.realm ? admin.realmStatus : null,
    official_roster_at: g.realm ? admin.rosterAt : null, official_roster_note: g.realm ? '42 members' : null,
    officialRosterMembers: g.realm ? 42 : 0,
  };
}
function aiJson(state) {
  const g = state.serverGuild;
  return {
    hasKey: true, coach_enabled: g.coach_enabled ?? 1, coach_budget_usd: g.coach_budget_usd ?? 15, spentUsd: admin.spent,
    month: iso().slice(0, 7), limits: { questionsPerDay: 30, plansPerDay: 5 },
  };
}
const blizzardJson = () => ({ configured: true, region: 'eu', status: admin.blizzard });
const audit = (state, action, detail = null) => {
  const m = me(state);
  admin.audit.unshift({ id: (admin.audit[0]?.id || 0) + 1, user_id: m?.id ?? null, battletag: m?.battletag ?? null, name: m ? short(m.battletag) : 'system', action, detail, created_at: sqlTime() });
};
const calendarLinks = (state) => {
  const url = `${state.settings.serverUrl}/calendar/${admin.calendarToken}.ics`;
  const webcalUrl = url.replace(/^https?:/, 'webcal:');
  return { url, webcalUrl, googleUrl: `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcalUrl)}` };
};

addMockRoutes({
  // ---------- officer tools ----------
  'GET /api/admin': ({ state, query }) => {
    needOfficer(state);
    const isOwner = role(state) === 'owner';
    const members = state.members.filter((m) => m.role).map(healthJson)
      .sort((a, b) => (a.last_sync_at ? 0 : 1) - (b.last_sync_at ? 0 : 1) || String(b.last_sync_at).localeCompare(String(a.last_sync_at)));
    return {
      isOwner, latest: { ...LATEST }, members, backupsEnabled: true, canDownloadBackups: isOwner, backups: admin.backups,
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
    const b = { file: `wow-${stamp()}.db`, size: 1_851_392, created: iso() };
    if (!admin.backups.some((x) => x.file === b.file)) admin.backups.unshift(b);
    admin.backups = admin.backups.slice(0, 14);
    audit(state, 'backup made', b.file);
    return { ok: true, backup: b, backups: admin.backups, message: 'Backup made.' };
  },
  'POST /api/admin/reset': ({ state, body }) => {
    needOfficer(state);
    if (role(state) !== 'owner') throw httpError(403, 'Only the guild owner can wipe the guild’s data.');
    const name = state.serverGuild.name;
    if (String(body?.confirm || '').trim().toLowerCase() !== name.trim().toLowerCase()) throw httpError(400, `Nothing was wiped. Type the guild name (${name}) to confirm.`);
    const b = { file: `wow-${stamp()}.db`, size: 1_851_392, created: iso() };
    admin.backups.unshift(b);
    state.serverGuild.realm = null;
    state.serverGuild.reset_at = iso();
    audit(state, 'wiped guild data for a fresh start', `4821 rows, backup ${b.file}`);
    return { ok: true, rows: 4821, removed: { characters: 61, raids: 9 }, backup: b.file,
      message: `Fresh start done: 4821 rows of game data removed (backup ${b.file} kept). Members, settings, devices and sync keys are untouched.` };
  },
  'POST /api/admin/blizzard': ({ state }) => {
    needOfficer(state);
    admin.blizzard = { ...admin.blizzard, checkedAt: iso() };
    return { ok: true, blizzard: blizzardJson(), gameData: gameData(state), message: 'Blizzard API checked.' };
  },
  'POST /api/admin/gamedata/refresh': ({ state }) => {
    needOfficer(state);
    if (!state.serverGuild.realm) return { ok: true, log: [], message: 'Save the realm name first, then refresh.', gameData: gameData(state) };
    return { ok: true, log: [], message: 'Blizzard’s API doesn’t have WoW: Forever realms yet, so realm status and the official guild list will appear once it does.', gameData: gameData(state) };
  },

  // ---------- calendar ----------
  'GET /api/calendar': ({ state }) => { needGuild(state); return calendarLinks(state); },
  'POST /api/calendar/reset': ({ state }) => {
    needGuild(state);
    admin.calendarToken = Math.random().toString(36).slice(2).padEnd(24, 'x').slice(0, 24);
    audit(state, 'calendar link replaced');
    return { ...calendarLinks(state), message: 'New calendar link made. Add it to your calendar again; the old link stopped working.' };
  },

  // ---------- core shapes used by Guild settings (real shapes from core.md) ----------
  'GET /api/guild': ({ state }) => {
    needGuild(state);
    return {
      guild: guildJson(state), memberCount: state.members.filter((m) => m.role).length,
      options: { wowheadGames: [{ value: 'forever', label: 'WoW: Forever' }, { value: 'retail', label: 'Retail' }, { value: 'classic', label: 'Classic' }] },
    };
  },
  'PUT /api/guild/settings': ({ state, body }) => {
    needOfficer(state);
    const b = body || {};
    const g = state.serverGuild;
    const messages = [];
    if ('discord_webhook' in b) {
      const url = String(b.discord_webhook || '').trim();
      if (url && !/^https:\/\/(discord|discordapp)\.com\/api\/webhooks\/[\w/-]+$/.test(url)) throw httpError(400, "That isn't a Discord webhook URL.");
      g.discord_webhook = url || '';
      messages.push(url ? 'Webhook saved.' : 'Webhook removed.');
      audit(state, url ? 'Discord webhook set' : 'Discord webhook removed');
    }
    if ('wowhead_game' in b) {
      if (!['forever', 'retail', 'classic'].includes(b.wowhead_game)) throw httpError(400, 'Pick WoW: Forever, Retail or Classic for item tooltips.');
      g.wowhead_game = b.wowhead_game;
      messages.push(`Item tooltips now use Wowhead's ${{ forever: 'Forever', retail: 'Retail', classic: 'Classic' }[b.wowhead_game]} database.`);
    }
    if ('realm' in b || 'game_guild' in b) {
      if ('realm' in b) g.realm = String(b.realm || '').trim().slice(0, 60) || null;
      if ('game_guild' in b) g.game_guild = String(b.game_guild || '').trim().slice(0, 60) || null;
      messages.push('Realm saved. Use "Refresh now" to fetch realm status and the official roster.');
    }
    if ('coach_enabled' in b || 'coach_budget_usd' in b) {
      if ('coach_budget_usd' in b) {
        const n = Number(b.coach_budget_usd);
        if (!Number.isFinite(n)) throw httpError(400, 'Set a monthly Coach budget between $0 and $500.');
        g.coach_budget_usd = Math.min(500, Math.max(0, Math.round(n * 100) / 100));
      }
      if ('coach_enabled' in b) g.coach_enabled = b.coach_enabled ? 1 : 0;
      messages.push('Coach settings saved.');
    }
    if ('auto_join' in b) {
      if (!['roster', 'verified', 'off'].includes(b.auto_join)) throw httpError(400, 'Choose how people join: from the roster, Battle.net only, or invite link only.');
      g.auto_join = b.auto_join;
      messages.push({
        roster: 'People now join by themselves when their character is in the guild roster.',
        verified: 'People now join by themselves only when Battle.net confirms their character.',
        off: 'People now join only with an invite link.',
      }[b.auto_join]);
      audit(state, 'auto join', b.auto_join);
    }
    if ('officer_rank_max' in b) {
      const v = b.officer_rank_max;
      if (v !== null && !(Number.isInteger(v) && v >= 0 && v <= 9)) throw httpError(400, 'Pick an in-game rank from 0 to 9, or turn it off.');
      g.officer_rank_max = v;
      messages.push(v === null ? 'Officers no longer follow in-game ranks.'
        : v === 0 ? 'The Guild Master in game is now an officer here.'
          : `The Guild Master and ${v === 1 ? 'the rank' : `${v} ranks`} below are now officers here.`);
      audit(state, 'officer ranks', v === null ? 'off' : v === 0 ? 'rank 0' : `ranks 0–${v}`);
    }
    if (!messages.length) throw httpError(400, 'Nothing to save.');
    return { guild: guildJson(state), messages };
  },
  'POST /api/guild/invite/reset': ({ state }) => {
    needOfficer(state);
    state.serverGuild.invite_code = Math.random().toString(36).slice(2, 10);
    audit(state, 'invite link replaced');
    const g = guildJson(state);
    return { invite_code: g.invite_code, inviteUrl: g.inviteUrl, message: 'New invite link made. The old one no longer works.' };
  },
  'GET /api/members': ({ state }) => {
    needGuild(state);
    const members = state.members.filter((m) => m.role).map(memberJson)
      .sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.battletag.localeCompare(b.battletag));
    return { members };
  },
  'POST /api/members/:id/:action': ({ state, params }) => {
    needOfficer(state);
    const m = state.members.find((x) => String(x.id) === params.id && x.role);
    if (!m) throw httpError(404, "That person isn't in the guild.");
    const mine = role(state);
    const name = short(m.battletag);
    if (params.action === 'promote') {
      if (m.role !== 'member') throw httpError(400, 'Only members can be promoted.');
      m.role = 'officer';
      audit(state, 'promoted to officer', m.battletag);
      return { ok: true, member: { id: m.id, role: 'officer' }, message: `${name} is now an officer.` };
    }
    if (params.action === 'demote') {
      if (mine !== 'owner') throw httpError(403, 'Only the guild owner can demote officers.');
      if (m.role !== 'officer') throw httpError(400, 'Only officers can be demoted.');
      m.role = 'member';
      audit(state, 'demoted to member', m.battletag);
      return { ok: true, member: { id: m.id, role: 'member' }, message: `${name} is now a member.` };
    }
    if (params.action === 'remove') {
      if (m.role === 'owner') throw httpError(403, 'Nobody can remove the guild owner.');
      if (m.id === state.userId) throw httpError(400, "You can't remove yourself.");
      if (m.role === 'officer' && mine !== 'owner') throw httpError(403, 'Only the guild owner can remove officers.');
      state.members = state.members.filter((x) => x !== m);
      audit(state, 'removed from guild', m.battletag);
      return { ok: true, member: { id: m.id, role: null }, message: `${name} was removed. Their devices are signed out.` };
    }
    throw httpError(404, 'Not found.');
  },

  // ---------- Discord (owned by the Discord domain; sample shapes from its brief) ----------
  'GET /api/discord': ({ state }) => {
    needGuild(state);
    return {
      configured: true, app_id: '123456789012345678',
      invite_url: 'https://discord.com/oauth2/authorize?client_id=123456789012345678&scope=bot%20applications.commands&permissions=8589934592',
      linked: admin.discordLinked, server_linked: true,
    };
  },
  'POST /api/discord/register': ({ state }) => { needOfficer(state); return { ok: true, registered: 6, message: '6 slash commands registered. They can take a minute to show up in Discord.' }; },
  'POST /api/discord/link': ({ state }) => {
    needGuild(state);
    return { code: 'K7Q2ZP', expires_at: iso(-10 * MIN), command: '/link K7Q2ZP' };
  },
  'POST /api/discord/unlink': ({ state }) => { needGuild(state); admin.discordLinked = false; return { ok: true }; },
});
