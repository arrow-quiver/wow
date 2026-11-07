// DEV MOCK of window.gc, used only when the renderer is opened in a plain browser (no Electron preload).
// It returns sample data for every IPC method and for the core server endpoints, so pages can be previewed.
//
// Pick a scenario with ?mock=<name> in the page URL (before the #):
//   owner (default) · officer · member · setup (signed in, game not set up yet) · noguild (signed in, not in the guild)
//   signedout (a returning member who is signed out) · fresh (signed out, brand new server without a guild)
// Add &latency=0 to answer instantly, &fail=1 to make every server call fail.
//
// Guild matching (guild.autoJoin, the 'membership' channel): in "noguild" the first check finds no match, then
// a background check about 7 s later joins (an officer "opened the roster in game"). &match=now joins at once,
// &match=never never matches, &match=off shows a guild that only takes invite links. In "fresh" the server has
// no guild, so the addon's guild is offered for setup; &detect=0 hides the addon's characters (name it by hand).
//
// Other modules can add sample endpoints with addMockRoutes({ 'GET /api/thing/:id': ({ params, query, body }) => ... }).

const params = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
const SCENARIO = params.get('mock') || 'owner';
const LATENCY = params.has('latency') ? Number(params.get('latency')) || 0 : 220;
const FAIL_ALL = params.get('fail') === '1';
const MATCH = params.get('match') || (SCENARIO === 'noguild' ? 'later' : 'now'); // now | later | never | off
const DETECT = params.get('detect') !== '0';
// Flavors the bundled addon supports (the main process reads them from the toc's ## Interface: list).
const SUPPORTED_FLAVORS = new Set(['_forever_', '_retail_', '_classic_era_']);

const now = () => Date.now();
const iso = (msAgo = 0) => new Date(now() - msAgo).toISOString();
const sqlTime = (msAgo = 0) => iso(msAgo).replace('T', ' ').slice(0, 19); // "YYYY-MM-DD HH:MM:SS" UTC
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// ---------- sample world ----------

const GUILD = { id: 1, name: 'Just Now WoW', faction: 'Horde', wowhead_game: 'classic', invite_code: 'EMBER-7Q2K', realm: 'Forever', created_at: sqlTime(90 * DAY) };

const MEMBERS = [
  { id: 1, battletag: 'Calvin#1234', role: 'owner', joined_at: sqlTime(90 * DAY), last_sync_at: sqlTime(3 * MIN), addon_version: '0.11.0', app_version: '0.11.0', main: 'Grimtusk' },
  { id: 2, battletag: 'Velanne#2210', role: 'officer', joined_at: sqlTime(80 * DAY), last_sync_at: sqlTime(40 * MIN), addon_version: '0.11.0', app_version: '0.11.0', main: 'Velanne' },
  { id: 3, battletag: 'Mokra#9031', role: 'member', joined_at: sqlTime(30 * DAY), last_sync_at: sqlTime(2 * DAY), addon_version: '0.10.2', app_version: '0.11.0', main: 'Mokra' },
  { id: 4, battletag: 'Tazrik#4410', role: 'member', joined_at: sqlTime(12 * DAY), last_sync_at: sqlTime(9 * DAY), addon_version: '0.9.0', app_version: null, main: 'Tazrik' },
  { id: 5, battletag: 'Ilyra#7777', role: 'member', joined_at: sqlTime(4 * DAY), last_sync_at: null, addon_version: null, app_version: null, main: null },
];

const CHARACTERS = [
  { name: 'Grimtusk', class: 'WARRIOR', race: 'Orc', level: 60, zone: 'Orgrimmar', online: true, user_id: 1, guild_rank: 'Warchief', item_level: 61, last_seen: sqlTime(2 * MIN) },
  { name: 'Shadowfen', class: 'WARLOCK', race: 'Undead', level: 42, zone: 'Desolace', online: false, user_id: 1, guild_rank: 'Alt', item_level: 38, last_seen: sqlTime(3 * DAY) },
  { name: 'Velanne', class: 'PRIEST', race: 'Troll', level: 60, zone: 'Blackrock Mountain', online: true, user_id: 2, guild_rank: 'Officer', item_level: 63, last_seen: sqlTime(5 * MIN) },
  { name: 'Mokra', class: 'SHAMAN', race: 'Tauren', level: 58, zone: 'Winterspring', online: true, user_id: 3, guild_rank: 'Member', item_level: 52, last_seen: sqlTime(1 * MIN) },
  { name: 'Tazrik', class: 'ROGUE', race: 'Troll', level: 35, zone: 'Stranglethorn Vale', online: false, user_id: 4, guild_rank: 'Member', item_level: 31, last_seen: sqlTime(9 * DAY) },
  { name: 'Hrogar', class: 'HUNTER', race: 'Orc', level: 60, zone: 'Undercity', online: false, user_id: null, guild_rank: 'Member', item_level: 57, last_seen: sqlTime(20 * HOUR) },
  { name: 'Ilyra', class: 'MAGE', race: 'Undead', level: 19, zone: 'The Barrens', online: true, user_id: 5, guild_rank: 'Initiate', item_level: 15, last_seen: sqlTime(30 * 1000) },
  { name: 'Brannoc', class: 'DRUID', race: 'Tauren', level: 47, zone: 'Feralas', online: false, user_id: null, guild_rank: 'Member', item_level: 44, last_seen: sqlTime(2 * DAY) },
  { name: 'Seraphel', class: 'PRIEST', race: 'Undead', level: 12, zone: 'Tirisfal Glades', online: false, user_id: null, guild_rank: 'Initiate', item_level: 10, last_seen: sqlTime(6 * DAY) },
];

function initialState() {
  const s = {
    settings: {
      serverUrl: 'https://wow.cjplumbing.co.za', extraWowFolders: [], syncEnabled: true, closeToTray: true,
      startWithWindows: false, addonAutoUpdate: true, addonAutoInstall: true, appAutoUpdate: true, notifications: true,
      theme: 'system', repoDir: null, lastEventId: 0, windowBounds: null, onboarded: true, startupDefaulted: false,
    },
    membership: null, // last guild.autoJoin result
    rosterAdds: [], // character names "scanned into" the guild roster during the preview
    serverGuild: clone(GUILD),
    signedIn: true,
    userId: 1,
    inGuild: true,
    members: clone(MEMBERS),
    devices: [
      { id: 11, name: 'CALVIN-PC', platform: 'win32', app_version: '0.11.0', created_at: sqlTime(20 * DAY), last_seen_at: sqlTime(1 * MIN), current: true },
      { id: 12, name: 'LAPTOP', platform: 'win32', app_version: '0.10.0', created_at: sqlTime(60 * DAY), last_seen_at: sqlTime(8 * DAY), current: false },
    ],
    notifyPrefs: { cta: true, raids: true, notices: true, requests: true, bank: true, coach: true, drives: true },
    installs: [
      { dir: 'C:\\Program Files (x86)\\World of Warcraft\\_forever_', root: 'C:\\Program Files (x86)\\World of Warcraft', flavor: '_forever_', label: 'WoW Forever',
        addonsDir: 'C:\\Program Files (x86)\\World of Warcraft\\_forever_\\Interface\\AddOns', wtfDir: 'C:\\Program Files (x86)\\World of Warcraft\\_forever_\\WTF',
        accounts: ['C:\\Program Files (x86)\\World of Warcraft\\_forever_\\WTF\\Account\\CALVIN\\SavedVariables\\WowGuild.lua'], addon: '0.11.0' },
      { dir: 'C:\\Program Files (x86)\\World of Warcraft\\_retail_', root: 'C:\\Program Files (x86)\\World of Warcraft', flavor: '_retail_', label: 'Retail',
        addonsDir: 'C:\\Program Files (x86)\\World of Warcraft\\_retail_\\Interface\\AddOns', wtfDir: 'C:\\Program Files (x86)\\World of Warcraft\\_retail_\\WTF',
        accounts: [], addon: null },
    ],
    addon: { bundled: { version: '0.11.0' }, remote: { version: '0.11.1', notes: 'Shopping list shows guild bank stock.\nFixes a Lua error when opening the Coach in combat.', publishedAt: iso(2 * DAY) }, autoUpdate: true, checking: false, lastCheckAt: iso(20 * MIN), error: null, busy: {} },
    sync: { enabled: true, state: 'idle', lastSyncAt: iso(3 * MIN), lastResult: { characters: 2, roster: 9, recipes: 141, prices: 812 }, lastError: null, nextRetryAt: null,
      recent: [
        { at: iso(3 * MIN), kind: 'upload', ok: true, message: 'Uploaded 2 characters, 9 roster rows and 141 recipes.', account: 'CALVIN', label: 'WoW Forever' },
        { at: iso(3 * MIN - 1500), kind: 'inbox', ok: true, message: 'Saved the guild news for the addon.', label: 'WoW Forever' },
        { at: iso(2 * HOUR), kind: 'upload', ok: false, message: 'The server did not answer. Trying again in 5 seconds.', account: 'CALVIN', label: 'WoW Forever' },
      ] },
    updater: { state: 'available', current: '0.11.0', available: { version: '0.11.1', notes: 'Faster sync after /reload.\nNew Updates page.', date: iso(1 * DAY) }, progress: null, error: null, lastCheckAt: iso(12 * MIN) },
    releases: {
      app: { version: '0.11.1', notes: 'Faster sync after /reload.\nNew Updates page.', publishedAt: iso(1 * DAY), file: 'Guild-Camp-Setup-0.11.1.exe', url: '/updates/app/Guild-Camp-Setup-0.11.1.exe', size: 92_405_112 },
      addon: { version: '0.11.1', notes: 'Shopping list shows guild bank stock.', publishedAt: iso(2 * DAY), sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', size: 148_220, url: '/updates/addon/WowGuild-0.11.1.zip' },
      history: [
        { kind: 'app', version: '0.11.1', notes: 'Faster sync after /reload.', publishedAt: iso(1 * DAY), by: 'Calvin#1234' },
        { kind: 'addon', version: '0.11.1', notes: 'Shopping list shows guild bank stock.', publishedAt: iso(2 * DAY), by: 'Calvin#1234' },
        { kind: 'app', version: '0.11.0', notes: 'First Guild Camp desktop release.', publishedAt: iso(9 * DAY), by: 'Calvin#1234' },
      ],
    },
    events: [],
    rendererReady: null,
  };
  switch (SCENARIO) {
    case 'officer': s.userId = 2; break;
    case 'member': s.userId = 3; break;
    case 'setup': s.settings.onboarded = false; break;
    case 'noguild': s.inGuild = false; s.userId = 6; s.settings.onboarded = false; break;
    case 'signedout': s.signedIn = false; s.settings.onboarded = false; break;
    case 'fresh': s.signedIn = false; s.serverGuild = null; s.inGuild = false; s.settings.onboarded = false; s.members = []; break;
    default: break;
  }
  if (s.userId === 6) s.members.push({ id: 6, battletag: 'Newcomer#5150', role: null, joined_at: null, last_sync_at: null });
  return s;
}

const state = initialState();

// ---------- event bus ----------

const listeners = new Map();
function emit(channel, payload) {
  const set = listeners.get(channel);
  if (!set) return;
  for (const cb of [...set]) {
    try { cb(clone(payload)); } catch (e) { console.error(e); }
  }
}

// ---------- derived views ----------

function me() { return state.members.find((m) => m.id === state.userId) || null; }

function authState() {
  if (!state.signedIn) return { signedIn: false, server: state.settings.serverUrl, user: null, guild: null, role: null };
  const m = me();
  const user = m ? { id: m.id, battletag: m.battletag } : null;
  const inGuild = state.inGuild && state.serverGuild;
  return {
    signedIn: true,
    server: state.settings.serverUrl,
    user,
    guild: inGuild ? { id: state.serverGuild.id, name: state.serverGuild.name, faction: state.serverGuild.faction, wowhead_game: state.serverGuild.wowhead_game } : null,
    role: inGuild && m ? m.role : null,
  };
}

function needSignedIn() { if (!state.signedIn) throw httpError(401, 'Please sign in again.'); }
function needGuild() { needSignedIn(); if (!state.inGuild || !state.serverGuild) throw httpError(403, 'Join the guild first.'); }
function needOfficer() { needGuild(); const r = me()?.role; if (r !== 'owner' && r !== 'officer') throw httpError(403, 'Only officers can do that.'); }

function compareVersions(a, b) {
  const pa = String(a || '0').split(/[.-]/).map((x) => Number(x) || 0);
  const pb = String(b || '0').split(/[.-]/).map((x) => Number(x) || 0);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
  return 0;
}

function addonStatus() {
  const a = state.addon;
  const latest = a.remote && compareVersions(a.remote.version, a.bundled.version) > 0
    ? { version: a.remote.version, source: 'remote' } : { version: a.bundled.version, source: 'bundled' };
  return {
    bundled: a.bundled, remote: a.remote, latest, autoUpdate: state.settings.addonAutoUpdate, checking: a.checking,
    lastCheckAt: a.lastCheckAt, error: a.error,
    installs: state.installs.map((i) => {
      const installed = i.addon ? { version: i.addon } : null;
      let st = 'missing';
      if (installed) {
        const c = compareVersions(installed.version, latest.version);
        st = c < 0 ? 'outdated' : c > 0 ? 'newer' : 'current';
      }
      return { dir: i.dir, root: i.root, flavor: i.flavor, label: i.label, addonsDir: i.addonsDir, installed, state: st, damaged: false, busy: !!a.busy[i.dir], action: null, error: null };
    }),
  };
}

function syncStatus() {
  const files = state.installs.flatMap((i) => i.accounts.map((file) => ({ file, account: file.split('\\').slice(-3, -2)[0], install: i.dir, label: i.label, flavor: i.flavor, lastUploadAt: state.sync.lastSyncAt, lastError: null, nextRetryAt: null })));
  const base = { ...state.sync, enabled: state.settings.syncEnabled, files };
  if (!state.signedIn) base.state = 'signed-out';
  else if (!state.settings.syncEnabled) base.state = 'off';
  else if (!state.installs.length) base.state = 'no-game';
  else if (!state.inGuild || !state.serverGuild) {
    base.state = 'no-guild';
    base.lastError = state.membership?.reason || 'Waiting to match your guild.';
  }
  return base;
}

// ---------- guild matching (guild.autoJoin) ----------

// What wow.detectGuild reads from the addon's SavedVariables (WowGuildDB.characters) on this PC.
function addonCharacters() {
  if (!DETECT) return [];
  const forever = state.installs.find((i) => i.flavor === '_forever_') || state.installs[0];
  const where = { install: forever ? forever.dir : null, account: state.userId === 6 ? 'NEWCOMER' : 'CALVIN' };
  const updated = Math.floor(now() / 1000) - 2 * 3600;
  if (state.userId === 6 || !state.members.some((m) => m.id === state.userId && m.role)) {
    return [
      { name: 'Zulgar', realm: GUILD.realm, guild: GUILD.name, faction: 'Horde', level: 34, class: 'SHAMAN', updated, ...where },
      { name: 'Zulbank', realm: GUILD.realm, guild: null, faction: 'Horde', level: 5, class: 'MAGE', updated: updated - 86400, ...where },
    ];
  }
  return CHARACTERS.filter((c) => c.user_id === state.userId).map((c, i) => ({
    name: c.name, realm: GUILD.realm, guild: GUILD.name, faction: 'Horde', level: c.level, class: c.class, updated: updated - i * 3600, ...where,
  }));
}

function detectedGuild(chars) {
  const c = [...chars].filter((x) => x && x.guild).sort((a, b) => (b.updated || 0) - (a.updated || 0))[0];
  return c ? { guild: c.guild, realm: c.realm || null, faction: c.faction || null } : null;
}

function membershipResult(fields) {
  const g = state.serverGuild;
  return { status: 'no-match', guild: g ? { id: g.id, name: g.name, faction: g.faction } : null, role: null, via: null, character: null, reason: '', detected: null, ...fields };
}

// Same rules as the server's tryAutoJoin, roughly: no guild → offer the addon's guild; a reported character in
// the roster → join. MATCH bends it so each outcome can be previewed.
function autoJoinResult(reported) {
  if (!state.signedIn) throw httpError(401, 'Sign in first.');
  const g = state.serverGuild;
  const detected = detectedGuild(reported);
  if (!g) {
    return membershipResult({
      status: 'no-guild-on-server', guild: null, detected,
      reason: detected ? `Nobody has set up ${detected.guild} on this server yet.` : 'Nobody has set up a guild on this server yet.',
    });
  }
  const m = me();
  if (state.inGuild && m && m.role) return membershipResult({ status: 'already', role: m.role, reason: `You are already in ${g.name}.` });
  if (MATCH === 'off') {
    return membershipResult({ status: 'disabled', detected, reason: `${g.name} only takes new members with an invite link. Ask an officer for one.` });
  }
  const inRoster = (c) => CHARACTERS.some((x) => x.name.toLowerCase() === String(c.name).toLowerCase()) || state.rosterAdds.includes(String(c.name).toLowerCase());
  const mine = reported.filter((c) => c && c.guild && c.guild.toLowerCase() === g.name.toLowerCase());
  const hit = MATCH === 'now' ? mine[0] || reported[0] || { name: 'Zulgar' } : MATCH === 'never' ? null : mine.find(inRoster);
  if (!hit) {
    return membershipResult({
      detected,
      reason: mine.length
        ? `None of your characters are in ${g.name}'s roster yet. Ask someone in the guild to open the guild roster in game, or use an invite link.`
        : `Log in to World of Warcraft once with the Guild Camp addon on a character in ${g.name}, then Guild Camp will add you.`,
    });
  }
  state.inGuild = true;
  let who = m;
  if (!who) { who = { id: state.userId, battletag: 'Newcomer#5150', role: null, joined_at: null, last_sync_at: null }; state.members.push(who); }
  who.role = 'member';
  who.joined_at = sqlTime();
  emit('auth', authState());
  return membershipResult({ status: 'joined', role: 'member', via: 'roster', character: hit.name, reason: `Matched ${hit.name} in the guild roster.`, detected });
}

// guild.autoJoin as the main process runs it: the result is kept and broadcast on 'membership'.
let laterTimer = null;
function runAutoJoin() {
  const r = autoJoinResult(addonCharacters());
  state.membership = r;
  emit('membership', r);
  emit('sync', syncStatus());
  // "noguild": a guildie opens the roster in game a little later, and the app's background check matches.
  if (r.status === 'no-match' && MATCH === 'later' && !laterTimer) {
    laterTimer = setTimeout(() => {
      state.rosterAdds.push('zulgar');
      try { runAutoJoin(); } catch (e) { console.warn('[mock] background guild check failed', e); }
    }, 7000);
    laterTimer?.unref?.(); // never keeps a Node test run alive
  }
  return r;
}

function installsView() { return state.installs.map(({ addon, ...rest }) => rest); }

function campView() {
  const online = CHARACTERS.filter((c) => c.online);
  return {
    guild: { name: state.serverGuild?.name, faction: state.serverGuild?.faction },
    online, rosterScannedAt: sqlTime(4 * MIN),
    ctas: [{ id: 1, message: 'Horde needed at Tarren Mill, Alliance raid incoming!', character: 'Velanne', battletag: 'Velanne#2210', created_at: sqlTime(12 * MIN) }],
    announcements: [
      { id: 3, body: 'Molten Core on Friday 20:00 server time. Bring fire resistance.', battletag: 'Calvin#1234', created_at: sqlTime(5 * HOUR) },
      { id: 2, body: 'Guild bank now has a tab for raid consumables. Ask an officer.', battletag: 'Velanne#2210', created_at: sqlTime(3 * DAY) },
    ],
    activity: [
      { id: 9, kind: 'loot', text: 'Grimtusk won Onslaught Girdle (SR+ 30).', created_at: sqlTime(26 * HOUR) },
      { id: 8, kind: 'level', text: 'Mokra reached level 58.', created_at: sqlTime(30 * HOUR) },
      { id: 7, kind: 'craft', text: 'Velanne delivered 20 Major Healing Potions to Grimtusk.', created_at: sqlTime(2 * DAY) },
    ],
    onboarding: { show: SCENARIO === 'member', steps: [
      { key: 'synced', label: 'Synced', done: true, href: '/addon' },
      { key: 'professions', label: 'Professions opened', done: true, href: '/addon' },
      { key: 'main', label: 'Main chosen', done: false, href: '/roster' },
      { key: 'discord', label: 'Discord linked', done: false, href: '/settings?section=discord&link=1' },
      { key: 'signup', label: 'Signed up for the next raid', done: false, href: '/raids' },
    ] },
  };
}

const RAIDS = [
  { id: 12, kind: 'raid', title: 'Molten Core', instance: 'Molten Core', starts_at: iso(-2 * DAY - 3 * HOUR), status: 'open', max_reserves: 2, signups: { coming: 18, maybe: 3, notComing: 2 }, mySignup: { status: 'coming', character: 'Grimtusk', role: 'tank' } },
  { id: 13, kind: 'pvp', title: 'Tarren Mill premade', instance: null, starts_at: iso(-4 * DAY + 2 * HOUR), status: 'open', max_reserves: 0, signups: { coming: 9, maybe: 4, notComing: 0 }, mySignup: null },
  { id: 14, kind: 'event', title: 'Fishing contest', instance: null, starts_at: iso(-6 * DAY), status: 'open', max_reserves: 0, signups: { coming: 5, maybe: 1, notComing: 0 }, mySignup: null },
];

// ---------- routes ----------

const routes = [];
export function addMockRoutes(table) {
  for (const [key, handler] of Object.entries(table)) {
    const [method, pattern] = key.split(' ');
    const names = [];
    const re = new RegExp(`^${pattern.replace(/:([A-Za-z_]\w*)/g, (_, n) => { names.push(n); return '([^/]+)'; })}$`);
    routes.unshift({ method: method.toUpperCase(), re, names, handler }); // later additions win
  }
}

addMockRoutes({
  'GET /api/meta': () => ({
    server: 'guild-camp', version: '0.11.0', devLogin: true, bnet: true,
    guild: state.serverGuild ? { name: state.serverGuild.name, faction: state.serverGuild.faction } : null,
    releases: { app: state.releases.app, addon: state.releases.addon },
  }),
  'POST /api/auth/signout': () => ({ ok: true }),
  'GET /api/me': () => {
    needSignedIn();
    const a = authState();
    const bnetChars = state.userId === 6 ? 2 : CHARACTERS.filter((c) => c.user_id === state.userId).length;
    return {
      user: a.user, guild: a.guild ? { ...state.serverGuild } : null, role: a.role, device: state.devices.find((d) => d.current), notifyPrefs: state.notifyPrefs,
      bnet: { characters: bnetChars, profile_at: sqlTime(2 * MIN), note: bnetChars ? 'Characters found in profile-eu.' : 'Battle.net listed no characters.' },
    };
  },
  'POST /api/guild/auto-join': ({ body }) => {
    needSignedIn();
    if (body?.characters !== undefined && !Array.isArray(body.characters)) throw httpError(400, 'characters must be a list.');
    return autoJoinResult((body?.characters || []).slice(0, 50));
  },
  'PUT /api/me/notifications': ({ body }) => { needSignedIn(); Object.assign(state.notifyPrefs, body || {}); return { notifyPrefs: state.notifyPrefs }; },
  'GET /api/devices': () => { needSignedIn(); return { devices: state.devices }; },
  'DELETE /api/devices/:id': ({ params: p }) => {
    needSignedIn();
    state.devices = state.devices.filter((d) => String(d.id) !== p.id);
    return { ok: true };
  },
  'POST /api/guild': ({ body }) => {
    needSignedIn();
    if (state.serverGuild) throw httpError(409, 'This server already has a guild. Join it with an invite code.');
    const name = String(body?.name || '').trim();
    if (!name) throw httpError(400, 'Give the guild a name.');
    if (name.length > 40) throw httpError(400, 'Guild names can be up to 40 characters.');
    if (!['Horde', 'Alliance'].includes(body?.faction)) throw httpError(400, 'Pick Horde or Alliance.');
    state.serverGuild = {
      ...clone(GUILD), name, faction: body.faction,
      realm: String(body.realm || '').trim().slice(0, 60) || null, game_guild: String(body.game_guild || '').trim().slice(0, 60) || null,
    };
    state.inGuild = true;
    const m = me();
    if (m) m.role = 'owner';
    else state.members.push({ id: state.userId, battletag: 'Newcomer#5150', role: 'owner', joined_at: sqlTime(), last_sync_at: null });
    emit('auth', authState());
    return { guild: state.serverGuild };
  },
  'GET /api/guild/invite/:code': ({ params: p }) => {
    if (!state.serverGuild || p.code.toUpperCase() !== state.serverGuild.invite_code) throw httpError(404, 'That invite code does not work. Ask an officer for a new link.');
    return { name: state.serverGuild.name, faction: state.serverGuild.faction };
  },
  'POST /api/guild/join': ({ body }) => {
    needSignedIn();
    const code = String(body?.code || '').trim().toUpperCase();
    if (!state.serverGuild) throw httpError(404, 'There is no guild on this server yet.');
    if (state.inGuild) throw httpError(409, 'You are already in the guild.');
    if (code !== state.serverGuild.invite_code) throw httpError(404, `That invite code does not work. In the preview, use ${state.serverGuild.invite_code}.`);
    state.inGuild = true;
    const m = me();
    if (m) { m.role = 'member'; m.joined_at = sqlTime(); }
    emit('auth', authState());
    return { guild: state.serverGuild, role: 'member' };
  },
  'GET /api/guild': () => { needGuild(); return { guild: { ...state.serverGuild, inviteUrl: `${state.settings.serverUrl}/join/${state.serverGuild.invite_code}` }, role: me()?.role }; },
  'PUT /api/guild/settings': ({ body }) => { needOfficer(); Object.assign(state.serverGuild, body || {}); emit('auth', authState()); return { guild: state.serverGuild }; },
  'POST /api/guild/invite/reset': () => {
    needOfficer();
    state.serverGuild.invite_code = `CAMP-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    return { inviteCode: state.serverGuild.invite_code, inviteUrl: `${state.settings.serverUrl}/join/${state.serverGuild.invite_code}` };
  },
  'GET /api/members': () => { needGuild(); return { members: state.members.filter((m) => m.role) }; },
  'POST /api/members/:id/:action': ({ params: p }) => {
    needOfficer();
    const m = state.members.find((x) => String(x.id) === p.id);
    if (!m) throw httpError(404, 'That member is no longer in the guild.');
    if (p.action === 'promote') m.role = 'officer';
    else if (p.action === 'demote') m.role = 'member';
    else if (p.action === 'remove') state.members = state.members.filter((x) => x !== m);
    else throw httpError(404, 'Unknown action.');
    return { ok: true };
  },
  'GET /api/events': ({ query }) => {
    needSignedIn();
    const after = Number(query.after) || 0;
    return { events: state.events.filter((e) => e.id > after) };
  },
  'GET /api/releases': () => clone(state.releases),
  'GET /api/inbox': () => { needGuild(); return { latestAddon: state.releases.addon.version, site: state.settings.serverUrl, notices: [] }; },

  // Sample domain data so the shell and early pages have something to show. Domain shapes are owned by their
  // engineers (docs/api/<domain>.md); adjust these when the real shapes land.
  'GET /api/camp': () => { needGuild(); return campView(); },
  'GET /api/roster': () => { needGuild(); return { characters: CHARACTERS, scannedAt: sqlTime(4 * MIN) }; },
  'GET /api/characters/:name': ({ params: p }) => {
    needGuild();
    const c = CHARACTERS.find((x) => x.name.toLowerCase() === p.name.toLowerCase());
    if (!c) throw httpError(404, 'No character by that name has synced yet.');
    return { character: c, professions: [{ name: 'Alchemy', skill: 300, max_skill: 300 }, { name: 'Herbalism', skill: 287, max_skill: 300 }], alts: CHARACTERS.filter((x) => x.user_id && x.user_id === c.user_id && x !== c) };
  },
  'GET /api/raids': () => { needGuild(); return { raids: RAIDS }; },
  'GET /api/raids/:id': ({ params: p }) => {
    needGuild();
    const r = RAIDS.find((x) => String(x.id) === p.id);
    if (!r) throw httpError(404, 'That raid was not found. It may have been cancelled.');
    return { raid: r, signups: [], reserves: [] };
  },
});

async function apiRequest(method, path, body) {
  const m = String(method || 'GET').toUpperCase();
  if (!/^\/api\//.test(path)) throw httpError(400, 'Server paths start with /api/.');
  if (FAIL_ALL) throw httpError(503, 'The server is not answering. Check your internet connection and try again.');
  const [pathname, search = ''] = path.split('?');
  const query = Object.fromEntries(new URLSearchParams(search));
  for (const r of routes) {
    if (r.method !== m) continue;
    const match = r.re.exec(pathname);
    if (!match) continue;
    const p = {};
    r.names.forEach((n, i) => { p[n] = decodeURIComponent(match[i + 1]); });
    return clone(await r.handler({ params: p, query, body: clone(body), state }));
  }
  console.warn(`[mock] no sample data for ${m} ${pathname}`);
  throw httpError(404, `The preview has no sample data for ${m} ${pathname} yet.`);
}

// ---------- IPC methods ----------

function setSync(patch) { Object.assign(state.sync, patch); emit('sync', syncStatus()); }
function setUpdater(patch) { Object.assign(state.updater, patch); emit('updater', clone(state.updater)); }
function addonChanged() { emit('addon', addonStatus()); }

async function addonJob(dir, fn) {
  const inst = state.installs.find((i) => i.dir === dir);
  if (!inst) throw httpError(404, 'That game folder is no longer in the list.');
  state.addon.busy[dir] = true;
  addonChanged();
  await sleep(900);
  try { fn(inst); } finally { delete state.addon.busy[dir]; addonChanged(); }
  return addonStatus();
}

const methods = {
  'app.info': () => ({ version: '0.11.0', isPackaged: false, platform: 'win32', logFile: 'C:\\Users\\you\\AppData\\Roaming\\Guild Camp\\logs\\guildcamp.log', userData: 'C:\\Users\\you\\AppData\\Roaming\\Guild Camp', repoDir: 'C:\\code\\wow', mock: SCENARIO }),
  'app.openExternal': (url) => { window.open(String(url), '_blank', 'noopener'); return true; },
  'app.openPath': (p) => { console.info('[mock] open', p); return ''; },
  'app.showItemInFolder': (p) => { console.info('[mock] show in folder', p); return true; },
  'app.pickFolder': () => 'D:\\Games\\World of Warcraft',
  'app.quit': () => { console.info('[mock] quit'); return true; },
  'app.relaunch': () => { location.reload(); return true; },
  'app.rendererReady': (info) => { state.rendererReady = info; console.info('[mock] renderer ready', info); return true; },
  'log.recent': () => [
    { t: iso(4 * MIN), level: 'info', scope: 'sync', msg: 'Uploaded WowGuild.lua for CALVIN (2 characters, 9 roster rows).' },
    { t: iso(4 * MIN - 2000), level: 'info', scope: 'sync', msg: 'Wrote WowGuild_Inbox for WoW Forever.' },
    { t: iso(20 * MIN), level: 'info', scope: 'addon', msg: 'Addon 0.11.1 is available on the server.' },
    { t: iso(2 * HOUR), level: 'warn', scope: 'sync', msg: 'Server did not answer, trying again in 5 seconds.' },
  ],
  'settings.get': () => clone(state.settings),
  'settings.set': (patch) => {
    Object.assign(state.settings, patch || {});
    emit('settings', state.settings);
    return clone(state.settings);
  },
  'auth.state': () => authState(),
  'auth.signIn': async () => {
    await sleep(900);
    state.signedIn = true;
    if (SCENARIO === 'fresh') {
      // A brand new person on a brand new server: not a member until they create the guild.
      // (In the 'signedout' scenario a returning member signs in and lands straight on the game step.)
      if (!state.members.some((m) => m.id === 6)) state.members.push({ id: 6, battletag: 'Newcomer#5150', role: null, joined_at: null, last_sync_at: null });
      state.userId = 6;
    }
    emit('auth', authState());
    emit('sync', syncStatus());
    return authState();
  },
  'auth.devSignIn': async (battletag) => {
    const tag = String(battletag || '').trim();
    if (!/^[^#\s]{2,}#\d{3,6}$/.test(tag)) throw httpError(400, 'Enter a BattleTag like Name#1234.');
    await sleep(300);
    let m = state.members.find((x) => x.battletag.toLowerCase() === tag.toLowerCase());
    if (!m) { m = { id: 100 + state.members.length, battletag: tag, role: null, joined_at: null, last_sync_at: null }; state.members.push(m); }
    state.userId = m.id;
    state.signedIn = true;
    state.inGuild = !!m.role && !!state.serverGuild;
    emit('auth', authState());
    return authState();
  },
  'auth.signOut': () => { state.signedIn = false; state.membership = null; emit('auth', authState()); emit('sync', syncStatus()); return authState(); },
  'api.request': (method, path, body) => apiRequest(method, path, body),
  'api.download': (path, suggestedName) => `C:\\Users\\you\\Downloads\\${suggestedName || path.split('/').pop()}`,
  'wow.installs': () => installsView(),
  'wow.addFolder': (dir) => {
    const d = String(dir || '');
    if (!d) throw httpError(400, 'Choose a folder.');
    if (!state.installs.some((i) => i.root === d)) {
      state.installs.push({ dir: `${d}\\_forever_`, root: d, flavor: '_forever_', label: 'WoW Forever', addonsDir: `${d}\\_forever_\\Interface\\AddOns`, wtfDir: `${d}\\_forever_\\WTF`, accounts: [], addon: null });
      state.settings.extraWowFolders = [...state.settings.extraWowFolders, d];
    }
    addonChanged();
    return installsView();
  },
  'wow.detectGuild': () => {
    const characters = addonCharacters();
    const d = detectedGuild(characters);
    return { characters, guild: d ? { name: d.guild, realm: d.realm, faction: d.faction } : null };
  },
  'guild.autoJoin': () => runAutoJoin(),
  'membership.status': () => clone(state.membership),
  'wow.removeFolder': (dir) => {
    state.settings.extraWowFolders = state.settings.extraWowFolders.filter((f) => f !== dir);
    state.installs = state.installs.filter((i) => i.root !== dir && i.dir !== dir);
    addonChanged();
    return installsView();
  },
  'sync.status': () => syncStatus(),
  'sync.now': async () => {
    if (!state.signedIn) throw httpError(401, 'Sign in to sync.');
    setSync({ state: 'syncing' });
    await sleep(1200);
    setSync({ state: 'idle', lastSyncAt: iso(), lastError: null });
    return syncStatus();
  },
  'sync.setEnabled': (on) => {
    state.settings.syncEnabled = !!on;
    setSync({ enabled: !!on, state: on ? 'idle' : 'off' });
    return syncStatus();
  },
  'addon.status': () => addonStatus(),
  'addon.check': async () => {
    state.addon.checking = true; addonChanged();
    await sleep(700);
    state.addon.checking = false; state.addon.lastCheckAt = iso(); addonChanged();
    // "Install the addon in new game folders automatically": supported flavors that don't have it get it now.
    if (state.settings.addonAutoInstall !== false) {
      for (const i of state.installs.filter((x) => !x.addon && SUPPORTED_FLAVORS.has(x.flavor))) {
        await addonJob(i.dir, (x) => { x.addon = addonStatus().latest.version; });
      }
    }
    return addonStatus();
  },
  'addon.install': (dir) => addonJob(dir, (i) => { i.addon = addonStatus().latest.version; }),
  'addon.update': (dir) => addonJob(dir, (i) => { i.addon = addonStatus().latest.version; }),
  'addon.repair': (dir) => addonJob(dir, (i) => { i.addon = addonStatus().latest.version; }),
  'addon.uninstall': (dir) => addonJob(dir, (i) => { i.addon = null; }),
  'addon.updateAll': async () => {
    for (const i of state.installs) if (i.addon) await addonJob(i.dir, (x) => { x.addon = addonStatus().latest.version; });
    return addonStatus();
  },
  'addon.openFolder': (dir) => { console.info('[mock] open addon folder', dir); return true; },
  'updater.status': () => clone(state.updater),
  'updater.check': async () => {
    setUpdater({ state: 'checking' });
    await sleep(800);
    setUpdater({ state: 'available', lastCheckAt: iso() });
    return clone(state.updater);
  },
  'updater.download': async () => {
    const total = 92_405_112;
    for (let p = 0; p <= 100; p += 20) {
      setUpdater({ state: 'downloading', progress: { percent: p, bytesPerSecond: 6_400_000, transferred: Math.round((total * p) / 100), total } });
      await sleep(350);
    }
    setUpdater({ state: 'downloaded', progress: null });
    return clone(state.updater);
  },
  'updater.install': () => { console.info('[mock] quit and install'); location.reload(); return true; },
  'publisher.status': () => ({
    canPublish: me()?.role === 'owner', repoDir: state.settings.repoDir || 'C:\\code\\wow',
    addonSource: { dir: 'C:\\code\\wow\\addon\\WowGuild', version: '0.11.1' }, appVersion: '0.11.0',
    published: { app: state.releases.app, addon: state.releases.addon },
  }),
  'publisher.publishAddon': async ({ bump = 'patch', notes = '' } = {}) => {
    const lines = ['Reading WowGuild.toc', `Bumping version (${bump})`, 'Zipping WowGuild (14 files)', 'Uploading 148 KB', 'The server accepted the addon.'];
    for (const line of lines) { emit('publisher:log', { kind: 'addon', line }); await sleep(300); }
    return { version: '0.11.2', notes };
  },
  'publisher.publishApp': async ({ bump = 'patch', notes = '' } = {}) => {
    const lines = [`Bumping app version (${bump})`, 'npm run dist', '  • electron-builder  version=26', '  • building target=nsis arch=x64', 'Uploading Guild-Camp-Setup-0.11.2.exe', 'Committing latest.yml', 'Published.'];
    for (const line of lines) { emit('publisher:log', { kind: 'app', line }); await sleep(400); }
    return { version: '0.11.2', notes };
  },
  'publisher.setRepoDir': (dir) => { state.settings.repoDir = dir; return methods['publisher.status'](); },
  'notify.test': () => {
    try {
      if ('Notification' in window && Notification.permission === 'granted') new Notification('Guild Camp', { body: 'Notifications are working.' });
    } catch { /* ignore */ }
    return true;
  },
};

export function createMock() {
  console.info(`[mock] Guild Camp preview mode, scenario "${SCENARIO}". Use ?mock=owner|officer|member|setup|noguild|signedout|fresh (guild matching: &match=now|later|never|off, &detect=0).`);
  const mock = {
    async invoke(method, ...args) {
      const fn = methods[method];
      if (!fn) throw httpError(501, `The preview does not support ${method}.`);
      if (LATENCY && method !== 'app.rendererReady') await sleep(LATENCY * (0.6 + Math.random() * 0.8));
      return clone(await fn(...args));
    },
    on(channel, cb) {
      if (!listeners.has(channel)) listeners.set(channel, new Set());
      listeners.get(channel).add(cb);
      return () => listeners.get(channel)?.delete(cb);
    },
    // Preview helpers (not part of window.gc): fire a server event or any channel by hand from DevTools.
    emit,
    serverEvent(kind, title = 'Test event', route = '/') {
      const ev = { id: state.events.length + 1, kind, title, body: '', route, created_at: sqlTime() };
      state.events.push(ev);
      emit('server-event', ev);
      return ev;
    },
    state,
  };
  // Handy in DevTools: gcMock.serverEvent('raid', 'Raid tonight', '/raids/12')
  if (typeof window !== 'undefined') window.gcMock = mock;
  return mock;
}

export { SCENARIO };
