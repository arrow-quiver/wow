// DEV MOCK of window.gc, used only when the renderer is opened in a plain browser (no Electron preload).
// It returns sample data for every IPC method and for the local core's endpoints (app/src/core), so pages can be
// previewed. There are no accounts: "me" is the player on this PC, the guild is the one the addon reports, and
// roles come from in-game ranks (rank 0 = Guild Master; rank ≤ officer_rank_max = officer).
//
// Pick a scenario with ?mock=<name> in the page URL (before the #):
//   owner (default, the Guild Master) · officer · member
//   setup (first run: no game folder found yet, no guild) · noguild (game and addon found, no guild synced yet)
// Other switches:
//   &bnet=in|out|none   Battle.net signed in (default for owner/officer/member), signed out, or not built in
//   &blizzard=0         no Blizzard game data (this copy has no Battle.net app)
//   &key=0              no Anthropic API key for the Coach
//   &publish=1|0        whether this PC can publish releases (default: only the owner scenario)
//   &match=later|never  in "setup" and "noguild", the first sync finds the guild about 7 s after the addon is in
//                       place (later, the default) or never
//   &share=full|empty|off  sharing in game (GET /api/share/status, mocks/share.js): full (default) has a change
//                       waiting for an officer character, one ready to go, one the game refused as stale, one
//                       sent, a change in my name this PC didn't make and (officers) a shared Discord webhook;
//                       empty has sharing on with nothing waiting; off has the addon not sharing yet
//   &restart=1          the game was running when Guild Camp made its news folder in WoW Forever: sharing waits for a
//                       game restart, not a /reload (sync status restartNeeded and restartFolders)
//   &latency=0          answer instantly · &fail=1 makes every core call fail
//
// Other modules add sample endpoints with addMockRoutes({ 'GET /api/thing/:id': ({ params, query, body, state }) => ... })
// and use the shared guards below (needGuild, needOfficer, roleOf).

const params = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
const SCENARIO = ['owner', 'officer', 'member', 'setup', 'noguild'].includes(params.get('mock')) ? params.get('mock') : 'owner';
// A little delay in a browser preview so loading states show; none in Node (the renderer tests).
const LATENCY = params.has('latency') ? Number(params.get('latency')) || 0 : typeof location === 'undefined' ? 0 : 220;
const FAIL_ALL = params.get('fail') === '1';
const MATCH = params.get('match') === 'never' ? 'never' : 'later';
const BNET = ['in', 'out', 'none'].includes(params.get('bnet')) ? params.get('bnet') : (['setup', 'noguild'].includes(SCENARIO) ? 'out' : 'in');
const BLIZZARD = params.get('blizzard') !== '0';
const HAS_KEY = params.get('key') !== '0';
const CAN_PUBLISH = params.has('publish') ? params.get('publish') === '1' : SCENARIO === 'owner';
// Flavors the bundled addon supports (the main process reads them from the toc's ## Interface: list).
const SUPPORTED_FLAVORS = new Set(['_forever_', '_retail_', '_classic_era_']);
const GUILD_FOUND_MS = 7000;
const RESTART = params.get('restart') === '1';

const now = () => Date.now();
const iso = (msAgo = 0) => new Date(now() - msAgo).toISOString();
const sqlTime = (msAgo = 0) => iso(msAgo).replace('T', ' ').slice(0, 19); // "YYYY-MM-DD HH:MM:SS" UTC
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (bt) => String(bt || '').split('#')[0];

export function httpError(status, message, code) {
  const e = new Error(message);
  e.status = status;
  if (code) e.code = code;
  return e;
}

// The core's words (app/src/core/http.js, routes/sync.js, routes/coach.js).
export const NO_GUILD = "Guild Camp hasn't seen your guild yet. Log in to World of Warcraft with the Guild Camp addon on a character in your guild, then log out or type /reload.";
const NO_GUILD_UPLOAD = 'None of your characters is in a guild yet. Guild Camp starts working as soon as you log in to a character in your guild.';
const NO_BNET_APP = 'Blizzard game data is off: this copy of Guild Camp has no Battle.net app built in.';

// ---------- sample world ----------

const GUILD = {
  id: 1, name: 'Just Now WoW', faction: 'Horde', ruleset: 'PvP', wowhead_game: 'classic', realm: 'Mirage Raceway', game_guild: 'Just Now WoW',
  realm_status: { found: true, slug: 'mirage-raceway', name: 'Mirage Raceway', up: true, queue: false, population: 'High', checkedAt: iso(4 * MIN) },
  official_roster_at: null, official_roster_note: null, roster_scanned_at: sqlTime(4 * MIN), bank_money: 12_345_678, bank_scanned_at: sqlTime(20 * HOUR),
  coach_enabled: 1, coach_budget_usd: 15, officer_rank_max: 1, relay_rank_max: null, reset_at: null, created_at: sqlTime(90 * DAY),
};

// Players this PC knows: me, and guildmates whose addon shared with mine. rank_index is their best character's rank.
const MEMBERS = [
  { id: 1, battletag: 'Calvin#1234', rank_index: 0, joined_at: sqlTime(90 * DAY), last_sync_at: sqlTime(3 * MIN), addon_version: '0.11.0', app_version: '0.11.0', main: 'Grimtusk', characters: 3 },
  { id: 2, battletag: 'Velanne#2210', rank_index: 1, joined_at: sqlTime(80 * DAY), last_sync_at: sqlTime(40 * MIN), addon_version: '0.11.1', app_version: '0.11.1', main: 'Velanne', characters: 1 },
  { id: 3, battletag: 'Mokra#9031', rank_index: 2, joined_at: sqlTime(30 * DAY), last_sync_at: sqlTime(2 * DAY), addon_version: '0.10.2', app_version: '0.11.0', main: 'Mokra', characters: 1 },
  { id: 4, battletag: 'Tazrik#4410', rank_index: 3, joined_at: sqlTime(12 * DAY), last_sync_at: sqlTime(9 * DAY), addon_version: '0.9.0', app_version: null, main: 'Tazrik', characters: 1 },
  { id: 5, battletag: 'Ilyra#7777', rank_index: 4, joined_at: sqlTime(4 * DAY), last_sync_at: null, addon_version: null, app_version: null, main: 'Ilyra', characters: 1 },
];
const MAIN_INFO = { Grimtusk: ['WARRIOR', 60], Velanne: ['PRIEST', 60], Mokra: ['SHAMAN', 58], Tazrik: ['ROGUE', 35], Ilyra: ['MAGE', 19] };
// What each player's addon reports about its characters (WowGuildDB.characters), for wow.detectGuild.
const ADDON_CHARS = {
  1: [{ name: 'Grimtusk', level: 60, class: 'WARRIOR' }, { name: 'Shadowfen', level: 42, class: 'WARLOCK' }],
  2: [{ name: 'Velanne', level: 60, class: 'PRIEST' }],
  3: [{ name: 'Mokra', level: 58, class: 'SHAMAN' }],
};
const LATEST = { app: '0.11.1', addon: '0.11.1' };

function initialState() {
  const s = {
    settings: {
      extraWowFolders: [], syncEnabled: true, closeToTray: true, startWithWindows: false, addonAutoUpdate: true, addonAutoInstall: true,
      appAutoUpdate: true, notifications: true, theme: 'system', repoDir: null, windowBounds: null, onboarded: true, startupDefaulted: false,
      addonOptOut: [], discordWebhook: null, bnetRegion: 'eu', inboxRestart: {},
    },
    guild: clone(GUILD), // the local guild: null until the first sync finds one
    userId: 1,
    members: clone(MEMBERS),
    bnet: { available: BNET !== 'none', signedIn: BNET === 'in', signingIn: false, region: 'eu', error: null },
    secrets: { anthropicKey: HAS_KEY },
    notifyPrefs: { cta: true, raids: true, notices: true, requests: true, bank: true, coach: true, drives: true },
    installs: [
      { dir: 'C:\\Program Files (x86)\\World of Warcraft\\_forever_', root: 'C:\\Program Files (x86)\\World of Warcraft', flavor: '_forever_', label: 'WoW Forever',
        addonsDir: 'C:\\Program Files (x86)\\World of Warcraft\\_forever_\\Interface\\AddOns', wtfDir: 'C:\\Program Files (x86)\\World of Warcraft\\_forever_\\WTF',
        accounts: ['C:\\Program Files (x86)\\World of Warcraft\\_forever_\\WTF\\Account\\CALVIN\\SavedVariables\\WowGuild.lua'], addon: '0.11.0' },
      { dir: 'C:\\Program Files (x86)\\World of Warcraft\\_retail_', root: 'C:\\Program Files (x86)\\World of Warcraft', flavor: '_retail_', label: 'Retail',
        addonsDir: 'C:\\Program Files (x86)\\World of Warcraft\\_retail_\\Interface\\AddOns', wtfDir: 'C:\\Program Files (x86)\\World of Warcraft\\_retail_\\WTF',
        accounts: [], addon: null },
    ],
    addon: {
      bundled: { version: '0.11.0' },
      remote: { version: '0.11.1', notes: 'Shopping list shows guild bank stock.\nFixes a Lua error when opening the Coach in combat.', publishedAt: iso(2 * DAY), size: 148_220, url: 'https://github.com/arrow-quiver/wow/releases/tag/addon-v0.11.1' },
      checking: false, lastCheckAt: iso(20 * MIN), error: null, busy: {},
    },
    sync: {
      state: 'idle', running: true, lastSyncAt: iso(3 * MIN), lastError: null, nextRetryAt: null, guildNote: null, coachWaiting: 0,
      // A news folder made while the game ran waits for a game restart (main/sync.js status); ?restart=1 shows it.
      restartNeeded: false, restartFolders: [],
      lastResult: { characters: 2, roster: 11, recipes: 141, ctas: 0, inventory: 86, bank: 0, prices: 812, coachPending: 0, account: 'CALVIN', label: 'WoW Forever', guild: { name: GUILD.name, role: 'owner' } },
      recent: [
        { at: iso(3 * MIN), kind: 'upload', ok: true, message: 'Read 2 characters, 11 roster rows and 141 recipes.', account: 'CALVIN', label: 'WoW Forever' },
        { at: iso(3 * MIN - 1500), kind: 'inbox', ok: true, message: 'Saved the guild news for the addon.', label: 'WoW Forever' },
        { at: iso(2 * HOUR), kind: 'upload', ok: false, message: 'The saved file was still being written. Trying again in 5 seconds.', account: 'CALVIN', label: 'WoW Forever' },
      ],
    },
    updater: { state: 'available', current: '0.11.0', available: { version: '0.11.1', notes: 'Faster sync after /reload.\nNew Updates page.', date: iso(1 * DAY) }, progress: null, error: null, lastCheckAt: iso(12 * MIN) },
    releases: {
      app: { kind: 'app', version: '0.11.1', tag: 'v0.11.1', notes: 'Faster sync after /reload.\nNew Updates page.', publishedAt: iso(1 * DAY), url: 'https://github.com/arrow-quiver/wow/releases/tag/v0.11.1' },
      history: [
        { kind: 'app', version: '0.11.1', tag: 'v0.11.1', notes: 'Faster sync after /reload.', publishedAt: iso(1 * DAY), url: 'https://github.com/arrow-quiver/wow/releases/tag/v0.11.1' },
        { kind: 'addon', version: '0.11.1', tag: 'addon-v0.11.1', notes: 'Shopping list shows guild bank stock.', publishedAt: iso(2 * DAY), url: 'https://github.com/arrow-quiver/wow/releases/tag/addon-v0.11.1' },
        { kind: 'app', version: '0.11.0', tag: 'v0.11.0', notes: 'First Guild Camp desktop release.', publishedAt: iso(9 * DAY), url: 'https://github.com/arrow-quiver/wow/releases/tag/v0.11.0' },
      ],
      checkedAt: iso(20 * MIN),
    },
    events: [],
    rendererReady: null,
    // Sharing in game (GET /api/share/status): filled by mocks/share.js; mockQueue() adds my changes to it.
    share: { outbox: [], refused: [], authorChecks: [], webhook: null, seq: 0 },
  };
  switch (SCENARIO) {
    case 'officer': s.userId = 2; break;
    case 'member': s.userId = 3; break;
    case 'setup':
      s.settings.onboarded = false;
      s.guild = null;
      s.installs = [];
      break;
    case 'noguild':
      s.settings.onboarded = false;
      s.guild = null;
      break;
    default:
      s.settings.discordWebhook = 'https://discord.com/api/webhooks/123456789012345678/preview-sample-token';
      break;
  }
  if (RESTART && s.installs.length) {
    s.sync.restartNeeded = true;
    s.sync.restartFolders = [{ install: s.installs[0].dir, label: s.installs[0].label, since: iso(10 * MIN) }];
  }
  if (!s.guild) {
    s.sync.lastResult = null;
    s.sync.recent = [];
    s.sync.lastSyncAt = null;
  }
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

// ---------- roles from in-game ranks (the core's identity.roleFromRank) ----------

function roleFromRank(rank, max) {
  if (rank === 0) return 'owner';
  if (rank != null && max != null && rank <= max) return 'officer';
  return 'member';
}

function syncRanks() {
  const max = state.guild ? state.guild.officer_rank_max : null;
  for (const m of state.members) m.role = roleFromRank(m.rank_index, max);
}
syncRanks();

export function meOf(s = state) { return s.members.find((m) => m.id === s.userId) || null; }
export function roleOf(s = state) { return s.guild ? meOf(s)?.role || null : null; }
export function isOfficerIn(s = state) { return ['owner', 'officer'].includes(roleOf(s)); }
export function needGuild(s = state) { if (!s.guild) throw httpError(403, NO_GUILD, 'NO_GUILD'); }
export function needOfficer(s = state) {
  needGuild(s);
  if (!isOfficerIn(s)) throw httpError(403, 'Only officers can do that. Your rank in the in-game guild decides who is an officer.');
}
export function needOwner(s = state) { needGuild(s); if (roleOf(s) !== 'owner') throw httpError(403, 'Only the Guild Master can do that.'); }

// ---------- sharing: my changes waiting to go out (the core's sharing.queue) ----------

// The core's plain lines (app/src/core/share/text.js LINES, docs/SHARING.md §2).
export const SHARE_SAVED = 'Saved. It goes to your guild the next time you log in or type /reload.';

/**
 * Adds a change of mine to the outbox, as the core's sharing.queue() does: a new entry for a record already
 * waiting replaces it. Returns the entry. id is the record id ("CFG:1"), summary the plain line shown for it.
 */
export function mockQueue({ id, summary }) {
  const sh = state.share;
  sh.seq += 1;
  const entry = {
    op: `o${(1000 + sh.seq).toString(36)}m`, id, type: id.slice(0, id.indexOf(':')), summary, state: 'queued',
    note: SHARE_SAVED, createdAt: sqlTime(), sentAt: null,
  };
  sh.outbox = [entry, ...sh.outbox.filter((e) => !(e.id === id && (e.state === 'queued' || e.state === 'waiting')))];
  return entry;
}

// ---------- derived views (the core's JSON shapes) ----------

// The name Guild Camp knows me by: the BattleTag, else my main's name, else "You".
function myName() {
  const m = meOf();
  if (state.bnet.signedIn && m) return m.battletag;
  if (state.guild && m && m.main) return m.main;
  return 'You';
}

function userJson() {
  const m = meOf();
  const battletag = myName();
  return {
    id: state.userId, battletag, name: short(battletag),
    addon_version: state.guild ? m?.addon_version ?? null : null, app_version: '0.11.0',
    last_sync_at: state.guild ? m?.last_sync_at ?? null : null, created_at: sqlTime(90 * DAY),
  };
}

export function guildJson(s = state) {
  const g = s.guild;
  if (!g) return null;
  const role = roleOf(s);
  const out = { ...clone(g), role };
  if (role === 'owner' || role === 'officer') out.discord_webhook = s.settings.discordWebhook || null;
  return out;
}

function bnetCharacters() {
  if (!state.bnet.signedIn) return [];
  return (ADDON_CHARS[state.userId] || ADDON_CHARS[1]).map((c) => ({
    ...c, realm: GUILD.realm, realm_slug: 'mirage-raceway', race: 'Orc', faction: 'Horde', namespace: 'profile-classic1x-eu', guild: GUILD.name,
  }));
}

function bnetState() {
  const b = state.bnet;
  const signedIn = b.available && b.signedIn;
  return {
    available: b.available, signedIn, signingIn: b.signingIn, battletag: signedIn ? meOf()?.battletag || null : null, region: state.settings.bnetRegion || 'eu',
    characters: bnetCharacters(), profileAt: signedIn ? iso(2 * MIN) : null, canRefresh: signedIn, error: b.error,
  };
}

// auth.state(): the Battle.net state plus who I am in the local core (same shapes as GET /api/me).
function authState() {
  return { ...bnetState(), user: userJson(), guild: guildJson(), role: roleOf() };
}

function compareVersions(a, b) {
  const pa = String(a || '0').split(/[.-]/).map((x) => Number(x) || 0);
  const pb = String(b || '0').split(/[.-]/).map((x) => Number(x) || 0);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
  return 0;
}

function addonStatus() {
  const a = state.addon;
  const latest = a.remote && compareVersions(a.remote.version, a.bundled.version) >= 0
    ? { version: a.remote.version, source: 'remote' } : { version: a.bundled.version, source: 'bundled' };
  return {
    bundled: a.bundled, remote: a.remote, latest, releases: clone(state.releases),
    autoUpdate: state.settings.addonAutoUpdate, autoInstall: state.settings.addonAutoInstall !== false,
    supportedFlavors: [...SUPPORTED_FLAVORS], checking: a.checking, lastCheckAt: a.lastCheckAt, error: a.error,
    installs: state.installs.map((i) => {
      const installed = i.addon ? { version: i.addon } : null;
      let st = 'missing';
      if (installed) {
        const c = compareVersions(installed.version, latest.version);
        st = c < 0 ? 'outdated' : c > 0 ? 'newer' : 'current';
      }
      return {
        dir: i.dir, root: i.root, flavor: i.flavor, label: i.label, addonsDir: i.addonsDir, installed, state: st, damaged: false,
        supported: SUPPORTED_FLAVORS.has(i.flavor), optedOut: false, busy: !!a.busy[i.dir], action: null, error: null,
        waitingForGame: false, // the preview's game is never running
      };
    }),
  };
}

function syncStatus() {
  const files = state.installs.flatMap((i) => i.accounts.map((file) => ({
    file, account: file.split('\\').slice(-3, -2)[0], install: i.dir, label: i.label, flavor: i.flavor,
    lastUploadAt: state.sync.lastSyncAt, lastError: null, nextRetryAt: null,
  })));
  const base = { ...clone(state.sync), enabled: state.settings.syncEnabled, files, installCount: state.installs.length };
  if (base.state !== 'syncing') {
    if (!state.settings.syncEnabled) base.state = 'off';
    else if (!state.installs.length) base.state = 'no-game';
  }
  return base;
}

// ---------- the first sync finds the guild ("setup" and "noguild") ----------

let guildTimer = null;
function maybeFindGuild() {
  if (state.guild || MATCH === 'never' || guildTimer) return;
  const ready = state.installs.some((i) => i.addon && i.accounts.length);
  if (!ready) {
    // The addon is in place but the game hasn't saved anything yet: say why nothing is stored.
    return;
  }
  if (!state.sync.guildNote && state.installs.some((i) => i.accounts.length)) {
    Object.assign(state.sync, { guildNote: NO_GUILD_UPLOAD, lastSyncAt: iso() });
    state.sync.recent.unshift({ at: iso(), kind: 'guild', ok: false, message: NO_GUILD_UPLOAD, account: 'CALVIN', label: 'WoW Forever' });
    emit('sync', syncStatus());
  }
  guildTimer = setTimeout(() => {
    guildTimer = null;
    state.guild = clone(GUILD);
    syncRanks();
    const message = `Guild Camp set up ${GUILD.name}.`;
    Object.assign(state.sync, {
      guildNote: null, lastSyncAt: iso(),
      lastResult: { characters: 2, roster: 11, recipes: 141, ctas: 0, inventory: 86, bank: 0, prices: 812, coachPending: 0, account: 'CALVIN', label: 'WoW Forever', guild: { name: GUILD.name, role: roleOf() } },
    });
    state.sync.recent.unshift({ at: iso(), kind: 'guild', ok: true, message, account: 'CALVIN', label: 'WoW Forever' });
    emit('sync', syncStatus());
    emit('auth', authState());
    emit('server-event', { id: state.events.length + 1, kind: 'guild', title: message, body: '', route: '/', created_at: sqlTime() });
  }, GUILD_FOUND_MS);
  guildTimer?.unref?.(); // never keeps a Node test run alive
}

function installsView() { return state.installs.map(({ addon, ...rest }) => rest); }

// What wow.detectGuild reads from the addon's SavedVariables (WowGuildDB.characters) on this PC.
function addonCharacters() {
  const forever = state.installs.find((i) => i.flavor === '_forever_') || state.installs[0];
  if (!forever) return [];
  const where = { install: forever.dir, account: 'CALVIN' };
  const updated = Math.floor(now() / 1000) - 2 * 3600;
  const inGuild = Boolean(state.guild) || guildTimer !== null;
  return (ADDON_CHARS[state.userId] || ADDON_CHARS[1]).map((c, i) => ({
    name: c.name, realm: GUILD.realm, guild: inGuild ? GUILD.name : null, faction: 'Horde', level: c.level, class: c.class, updated: updated - i * 3600, ...where,
  }));
}

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

const WOWHEAD_GAMES = [{ value: 'forever', label: 'WoW: Forever' }, { value: 'retail', label: 'Retail' }, { value: 'classic', label: 'Classic' }];
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

addMockRoutes({
  'GET /api/meta': () => ({
    app: 'guild-camp', version: '0.11.0',
    guild: state.guild ? { name: state.guild.name, faction: state.guild.faction } : null,
    blizzard: BLIZZARD,
    latest: { app: { version: LATEST.app }, addon: { version: LATEST.addon } },
  }),
  'GET /api/me': () => {
    const chars = bnetCharacters().length;
    return {
      user: userJson(), guild: guildJson(), role: roleOf(), notifyPrefs: state.notifyPrefs,
      bnet: {
        characters: chars, profile_at: state.bnet.signedIn ? sqlTime(2 * MIN) : null,
        note: state.bnet.signedIn ? (chars ? `Read ${chars} characters from Battle.net.` : 'Battle.net listed no characters.') : null,
      },
    };
  },
  'PUT /api/me/notifications': ({ body }) => {
    const patch = body && typeof body.notifyPrefs === 'object' ? body.notifyPrefs : body || {};
    for (const [k, v] of Object.entries(patch)) if (k in state.notifyPrefs) state.notifyPrefs[k] = !!v;
    return { notifyPrefs: state.notifyPrefs };
  },
  'GET /api/guild': () => {
    needGuild();
    return { guild: guildJson(), memberCount: state.members.length, options: { wowheadGames: WOWHEAD_GAMES } };
  },
  // Same rules as the core (routes/core.js): each field has its own rule; everything is checked before saving.
  'PUT /api/guild/settings': ({ body }) => {
    needGuild();
    const b = body && typeof body === 'object' ? body : {};
    const g = state.guild;
    const next = {};
    const messages = [];
    if (has(b, 'discord_webhook')) throw httpError(400, 'The Discord webhook is set in Settings now, on this computer only.');
    if (has(b, 'wowhead_game')) {
      const game = WOWHEAD_GAMES.find((x) => x.value === b.wowhead_game);
      if (!game) throw httpError(400, 'Pick WoW: Forever, Retail or Classic for item tooltips.');
      next.wowhead_game = game.value;
      messages.push(`Item tooltips now use Wowhead's ${game.value === 'forever' ? 'Forever' : game.label} database.`);
    }
    if (has(b, 'realm') || has(b, 'game_guild')) {
      if (!isOfficerIn()) throw httpError(403, 'Only officers can change the realm and guild name.');
      if (has(b, 'realm')) next.realm = String(b.realm || '').trim().slice(0, 60) || null;
      if (has(b, 'game_guild')) next.game_guild = String(b.game_guild || '').trim().slice(0, 60) || null;
      next.realm_status = null;
      messages.push('Realm saved. Use "Refresh now" to fetch realm status and the official roster.');
    }
    if (has(b, 'coach_enabled') || has(b, 'coach_budget_usd')) {
      if (has(b, 'coach_budget_usd')) {
        const n = Number(b.coach_budget_usd);
        if (b.coach_budget_usd === '' || b.coach_budget_usd === null || !Number.isFinite(n)) throw httpError(400, 'Set a monthly Coach budget between $0 and $500.');
        next.coach_budget_usd = Math.round(Math.min(500, Math.max(0, n)) * 100) / 100;
      }
      if (has(b, 'coach_enabled')) next.coach_enabled = b.coach_enabled ? 1 : 0;
      messages.push('Coach settings saved.');
    }
    let ranks = false;
    if (has(b, 'officer_rank_max')) {
      if (roleOf() !== 'owner') throw httpError(403, 'Only the Guild Master can choose which ranks are officers.');
      const v = b.officer_rank_max;
      const max = v === null || v === '' ? null : Number.isInteger(v) ? v : (typeof v === 'string' && /^\d$/.test(v.trim()) ? Number(v) : NaN);
      if (max !== null && !(Number.isInteger(max) && max >= 0 && max <= 9)) throw httpError(400, 'Pick Off, or an in-game rank from 0 to 9, for officers.');
      ranks = max !== g.officer_rank_max;
      next.officer_rank_max = max;
      messages.push(max == null ? 'In-game ranks no longer make anyone an officer here.'
        : `Officers now follow in-game ranks: ${max === 0 ? 'Guild Master only' : `Guild Master + ${max} rank${max === 1 ? '' : 's'} below`}.`);
    }
    // Who passes on officer changes (docs/SHARING.md §5): null = officers only.
    if (has(b, 'relay_rank_max')) {
      if (roleOf() !== 'owner') throw httpError(403, 'Only the Guild Master can choose who passes on officer changes.');
      const v = b.relay_rank_max;
      const relay = v === null || v === '' ? null : Number.isInteger(v) ? v : (typeof v === 'string' && /^\d$/.test(v.trim()) ? Number(v) : NaN);
      if (relay !== null && !(Number.isInteger(relay) && relay >= 0 && relay <= 9)) throw httpError(400, 'Pick officers only, or an in-game rank from 0 to 9.');
      next.relay_rank_max = relay;
      messages.push(relay == null ? 'Only officers pass on officer changes now.' : `Ranks down to rank ${relay} now pass on officer changes too.`);
    }
    if (!messages.length) throw httpError(400, 'Nothing to save.');
    Object.assign(g, next);
    if (ranks) { syncRanks(); emit('auth', authState()); }
    // The Guild Master's settings travel as one CFG record.
    if (has(b, 'officer_rank_max') || has(b, 'relay_rank_max')) {
      mockQueue({ id: 'CFG:1', summary: `Guild settings: officers up to rank ${g.officer_rank_max == null ? 0 : g.officer_rank_max}` });
      messages.push(SHARE_SAVED);
    }
    return { guild: guildJson(), messages };
  },
  'GET /api/members': () => {
    needGuild();
    const order = { owner: 0, officer: 1, member: 2 };
    const members = state.members.map((m) => {
      const [cls, level] = MAIN_INFO[m.main] || [null, null];
      return {
        id: m.id, battletag: m.battletag, name: short(m.battletag), role: m.role, rank_index: m.rank_index, joined_at: m.joined_at,
        characters: m.characters, main: m.main ? { name: m.main, class: cls, level, is_main: 1 } : null,
        addon_version: m.addon_version, app_version: m.app_version, last_sync_at: m.last_sync_at, isMe: m.id === state.userId,
      };
    }).sort((a, b) => order[a.role] - order[b.role] || a.battletag.localeCompare(b.battletag));
    return { members };
  },
  'GET /api/inbox': () => ({ latestAddon: LATEST.addon, notices: [] }),
  'GET /api/calendar.ics': () => { needGuild(); return 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Guild Camp//raids//EN\r\nEND:VCALENDAR\r\n'; },
});

async function apiRequest(method, path, body) {
  const m = String(method || 'GET').toUpperCase();
  if (!/^\/api\//.test(path)) throw httpError(400, 'Paths start with /api/.');
  if (FAIL_ALL) throw httpError(500, "Guild Camp's data isn't answering. Restart Guild Camp.");
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
  throw httpError(404, 'Not found.');
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
  // A freshly installed addon saves its file the first time the game runs ("setup").
  if (inst.addon && !inst.accounts.length && SCENARIO === 'setup') {
    inst.accounts.push(`${inst.wtfDir}\\Account\\CALVIN\\SavedVariables\\WowGuild.lua`);
  }
  maybeFindGuild();
  // The main process adds restartNeeded when the game may be running; the preview's game never is.
  return { ...addonStatus(), restartNeeded: false };
}

function publisherStatus() {
  const steps = [
    { id: 'repo', done: true, title: 'Get the Guild Camp source code', detail: 'Found at C:\\code\\wow.', command: null },
    { id: 'gh', done: true, title: 'Install GitHub CLI', detail: 'GitHub CLI 2.62.0 is installed.', command: null },
    { id: 'login', done: CAN_PUBLISH, title: 'Sign in to GitHub', detail: CAN_PUBLISH ? 'Signed in as calvin.' : 'Run this in a terminal, choose GitHub.com, and sign in.', command: CAN_PUBLISH ? null : 'gh auth login' },
    { id: 'push', done: CAN_PUBLISH, title: 'Have push access to arrow-quiver/wow', detail: CAN_PUBLISH ? 'You can publish releases.' : 'Ask the owner of the repository for write access.', command: null },
  ];
  return {
    canPublish: CAN_PUBLISH, reason: CAN_PUBLISH ? null : 'Sign in to GitHub first (gh auth login).',
    setup: { steps, gh: { installed: true, version: '2.62.0', loggedIn: CAN_PUBLISH, account: CAN_PUBLISH ? 'calvin' : null, push: CAN_PUBLISH, problem: null, note: null } },
    repo: 'arrow-quiver/wow', releasesUrl: 'https://github.com/arrow-quiver/wow/releases', repoPrivate: false, isPackaged: false,
    runningVersion: '0.11.0', repoDir: state.settings.repoDir || 'C:\\code\\wow', repoSource: 'detected', repoProblem: null, hasGit: true,
    addonSource: { dir: 'C:\\code\\wow\\addon\\WowGuild', version: '0.11.1' }, appSource: { version: '0.11.1' }, appVersion: '0.11.1',
    published: { app: state.releases.app, addon: state.releases.history.find((r) => r.kind === 'addon') || null, history: state.releases.history },
    publishedError: null, bnet: { ready: false, from: null, problem: null }, building: false, job: null, canCancel: false,
    changelog: { app: '', addon: '' }, log: [], lastResult: null, lastError: null,
  };
}

const methods = {
  'app.info': () => ({
    version: '0.11.0', isPackaged: false, platform: 'win32', arch: 'x64', electron: '45.0.0',
    logFile: 'C:\\Users\\you\\AppData\\Roaming\\Guild Camp\\logs\\guildcamp.log', userData: 'C:\\Users\\you\\AppData\\Roaming\\Guild Camp',
    dataFile: 'C:\\Users\\you\\AppData\\Roaming\\Guild Camp\\guildcamp.db', repoDir: 'C:\\code\\wow', bnetAvailable: BNET !== 'none',
    secretsEncrypted: true, startWithWindowsSupported: true, smoke: false, mock: SCENARIO,
  }),
  'app.openExternal': (url) => { window.open(String(url), '_blank', 'noopener'); return true; },
  'app.openPath': (p) => { console.info('[mock] open', p); return true; },
  'app.showItemInFolder': (p) => { console.info('[mock] show in folder', p); return true; },
  'app.pickFolder': () => 'D:\\Games\\World of Warcraft',
  'app.quit': () => { console.info('[mock] quit'); return true; },
  'app.relaunch': () => { location.reload(); return true; },
  'app.rendererReady': (info) => { state.rendererReady = info; console.info('[mock] renderer ready', info); return true; },
  'log.recent': () => [
    { t: iso(4 * MIN), level: 'info', scope: 'sync', msg: 'Read WowGuild.lua for CALVIN (2 characters, 11 roster rows).' },
    { t: iso(4 * MIN - 2000), level: 'info', scope: 'sync', msg: 'Wrote WowGuild_Inbox for WoW Forever.' },
    { t: iso(20 * MIN), level: 'info', scope: 'addon', msg: 'GitHub has addon 0.11.1.' },
    { t: iso(2 * HOUR), level: 'warn', scope: 'sync', msg: 'The saved file was still being written. Trying again in 5 seconds.' },
  ],
  'settings.get': () => clone(state.settings),
  'settings.set': (patch) => {
    const p = patch && typeof patch === 'object' ? patch : {};
    if ('serverUrl' in p) throw httpError(400, 'Guild Camp has no server address any more.');
    if ('discordWebhook' in p) {
      const url = String(p.discordWebhook || '').trim();
      if (url && !/^https:\/\/(discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]+$/.test(url)) throw httpError(400, "That isn't a Discord webhook address. Copy it from the channel's Integrations settings.");
      p.discordWebhook = url || null;
    }
    for (const k of ['windowBounds', 'startupDefaulted', 'addonOptOut']) delete p[k];
    Object.assign(state.settings, p);
    emit('settings', state.settings);
    return clone(state.settings);
  },
  'auth.state': () => authState(),
  'auth.signIn': async () => {
    if (!state.bnet.available) throw httpError(400, "Battle.net sign-in isn't part of this copy of Guild Camp.");
    state.bnet.signingIn = true;
    emit('auth', authState());
    await sleep(900);
    Object.assign(state.bnet, { signingIn: false, signedIn: true, error: null });
    emit('auth', authState());
    return authState();
  },
  'auth.signOut': () => { state.bnet.signedIn = false; emit('auth', authState()); return authState(); },
  'api.request': (method, path, body) => apiRequest(method, path, body),
  'api.download': (path, suggestedName) => `C:\\Users\\you\\Downloads\\${suggestedName || path.split('/').pop()}`,
  'calendar.export': async () => {
    needGuild();
    await sleep(300);
    return `C:\\Users\\you\\Documents\\${state.guild.name} raids.ics`;
  },
  'secrets.set': (name, value) => {
    if (name !== 'anthropicKey') throw httpError(400, 'Guild Camp only keeps your Anthropic API key here.');
    state.secrets.anthropicKey = Boolean(value);
    return { name, set: Boolean(value), encrypted: true };
  },
  'secrets.has': (name) => (name === 'anthropicKey' ? Boolean(state.secrets.anthropicKey) : false),
  'wow.installs': () => installsView(),
  'wow.addFolder': (dir) => {
    const d = String(dir || '');
    if (!d) throw httpError(400, 'Choose a folder.');
    if (!state.installs.some((i) => i.root === d)) {
      state.installs.push({ dir: `${d}\\_forever_`, root: d, flavor: '_forever_', label: 'WoW Forever', addonsDir: `${d}\\_forever_\\Interface\\AddOns`, wtfDir: `${d}\\_forever_\\WTF`, accounts: [], addon: null });
      state.settings.extraWowFolders = [...state.settings.extraWowFolders, d];
    }
    addonChanged();
    emit('sync', syncStatus());
    return installsView();
  },
  'wow.removeFolder': (dir) => {
    state.settings.extraWowFolders = state.settings.extraWowFolders.filter((f) => f !== dir);
    state.installs = state.installs.filter((i) => i.root !== dir && i.dir !== dir);
    addonChanged();
    emit('sync', syncStatus());
    return installsView();
  },
  'wow.detectGuild': () => {
    const characters = addonCharacters();
    const c = characters.filter((x) => x.guild).sort((a, b) => b.updated - a.updated)[0];
    return { characters, guild: c ? { name: c.guild, realm: c.realm, faction: c.faction } : null };
  },
  'sync.status': () => syncStatus(),
  'sync.now': async () => {
    if (!state.settings.syncEnabled) return syncStatus();
    setSync({ state: 'syncing' });
    await sleep(1200);
    setSync({ state: 'idle', lastSyncAt: state.guild ? iso() : state.sync.lastSyncAt, lastError: null });
    maybeFindGuild();
    return syncStatus();
  },
  'sync.setEnabled': (on) => {
    state.settings.syncEnabled = !!on;
    emit('settings', state.settings);
    setSync({ enabled: !!on, state: 'idle' });
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
    return { ...addonStatus(), restartNeeded: false };
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
  'publisher.status': () => publisherStatus(),
  'publisher.publishAddon': async ({ bump = 'patch', notes = '' } = {}) => {
    if (!CAN_PUBLISH) throw httpError(403, 'Sign in to GitHub first (gh auth login).', 'cannot-publish');
    const lines = ['Reading WowGuild.toc', `Bumping version (${bump})`, 'Zipping WowGuild (14 files)', 'gh release create addon-v0.11.2', 'Published addon 0.11.2 on GitHub.'];
    for (const line of lines) { emit('publisher:log', { t: iso(), kind: 'addon', level: 'info', line }); await sleep(300); }
    return { version: '0.11.2', notes };
  },
  'publisher.publishApp': async ({ bump = 'patch', notes = '' } = {}) => {
    if (!CAN_PUBLISH) throw httpError(403, 'Sign in to GitHub first (gh auth login).', 'cannot-publish');
    const lines = [`Bumping app version (${bump})`, 'npm run dist', '  • electron-builder  version=26', '  • building target=nsis arch=x64', 'gh release create v0.11.2', 'Published Guild Camp 0.11.2 on GitHub.'];
    for (const line of lines) { emit('publisher:log', { t: iso(), kind: 'app', level: 'info', line }); await sleep(400); }
    return { version: '0.11.2', notes };
  },
  'publisher.setRepoDir': (dir) => { state.settings.repoDir = dir; return publisherStatus(); },
  'publisher.cancel': () => publisherStatus(),
  'notify.test': () => {
    try {
      if ('Notification' in window && Notification.permission === 'granted') new Notification('Guild Camp', { body: 'Notifications are working.' });
    } catch { /* ignore */ }
    return true;
  },
};

// The channels the real preload knows (src/preload/preload.js). Like the real bridge, others throw.
const CHANNELS = new Set(['auth', 'sync', 'addon', 'updater', 'publisher:log', 'server-event', 'navigate', 'log', 'settings']);

export function createMock() {
  console.info(`[mock] Guild Camp preview mode, scenario "${SCENARIO}". Use ?mock=owner|officer|member|setup|noguild (&bnet=in|out|none, &blizzard=0, &key=0, &publish=1|0, &match=never).`);
  const mock = {
    async invoke(method, ...args) {
      const fn = methods[method];
      if (!fn) throw httpError(501, `The preview does not support ${method}.`);
      if (LATENCY && method !== 'app.rendererReady') await sleep(LATENCY * (0.6 + Math.random() * 0.8));
      return clone(await fn(...args));
    },
    on(channel, cb) {
      if (!CHANNELS.has(channel)) throw new Error(`Unknown event channel: ${channel}`);
      if (!listeners.has(channel)) listeners.set(channel, new Set());
      listeners.get(channel).add(cb);
      return () => listeners.get(channel)?.delete(cb);
    },
    // Preview helpers (not part of window.gc): fire a core event or any channel by hand from DevTools.
    emit,
    serverEvent(kind, title = 'Test event', route = '/') {
      const ev = { id: state.events.length + 1, kind, title, body: '', route, created_at: sqlTime() };
      state.events.push(ev);
      emit('server-event', ev);
      return ev;
    },
    state,
  };
  // "noguild": the addon is in place, so the first sync finds the guild shortly.
  maybeFindGuild();
  // Handy in DevTools: gcMock.serverEvent('raid', 'Raid tonight', '/raids/12')
  if (typeof window !== 'undefined') window.gcMock = mock;
  return mock;
}

export { SCENARIO, LATEST, BLIZZARD, NO_BNET_APP };
