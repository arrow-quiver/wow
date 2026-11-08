// Preview sample data for the community pages (used only when the renderer runs in a plain browser without window.gc).
// Shapes match docs/api/community.md (the local core's routes/community.js). A small in-memory world so posting
// calls to arms, notices, requests and partner posts, claiming and delivering, and choosing a main all work in the
// preview. Ranks: 0 Warchief (Guild Master), 1 Officer, 2 Veteran, 3 Member, 4 Initiate, 5 Alt, 6 Bank.
import { addMockRoutes, httpError, needGuild, isOfficerIn } from '../mock.js';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const sqlTime = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString().replace('T', ' ').slice(0, 19);
const iso = (msFromNow) => new Date(Date.now() + msFromNow).toISOString();
const short = (bt) => String(bt || '').split('#')[0];

// Players of the base mock (lib/mock.js MEMBERS).
const USERS = { 1: 'Calvin#1234', 2: 'Velanne#2210', 3: 'Mokra#9031', 4: 'Tazrik#4410', 5: 'Ilyra#7777' };

export const CHARS = [
  { id: 1, name: 'Grimtusk', class: 'WARRIOR', race: 'Orc', level: 60, rank: 'Warchief', rank_index: 0, zone: 'Orgrimmar', online: 1, last_seen: sqlTime(2 * MIN), is_main: 1, is_bank: 0, in_official_roster: 1, user_id: 1, faction: 'Horde', money: 4235190,
    readiness: { ilvl: 61.2, durability: 88, consumables: { flask: 2, potion: 14, food: 20 }, at: Math.floor((Date.now() - 20 * MIN) / 1000) },
    extras: { pvp: { rank: 8, rankName: 'Blood Guard', honor: 18450, hk: 2210, weekHk: 64, weekContribution: 5400, lastWeekRank: 'Stone Guard', highestRank: 8 },
      reputations: [{ name: 'Orgrimmar', standing: 7, value: 9200, max: 21000 }, { name: 'Argent Dawn', standing: 6, value: 3100, max: 12000 }, { name: 'Timbermaw Hold', standing: 5, value: 1400, max: 6000 }, { name: 'Gelkis Clan Centaur', standing: 4, value: 0, max: 3000 }],
      currencies: [{ id: 3001, name: "Merchant's Favor", qty: 12, max: 50 }, { id: 3002, name: 'Honor Token', qty: 4 }] } },
  { id: 2, name: 'Shadowfen', class: 'WARLOCK', race: 'Undead', level: 42, rank: 'Alt', rank_index: 5, zone: 'Desolace', online: 0, last_seen: sqlTime(3 * DAY), is_main: 0, is_bank: 0, in_official_roster: 1, user_id: 1, faction: 'Horde', money: 150230 },
  { id: 3, name: 'Velanne', class: 'PRIEST', race: 'Troll', level: 60, rank: 'Officer', rank_index: 1, zone: 'Blackrock Mountain', online: 1, last_seen: sqlTime(5 * MIN), is_main: 1, is_bank: 0, in_official_roster: 1, user_id: 2, faction: 'Horde' },
  { id: 4, name: 'Mokra', class: 'SHAMAN', race: 'Tauren', level: 58, rank: 'Veteran', rank_index: 2, zone: 'Winterspring', online: 1, last_seen: sqlTime(1 * MIN), is_main: 0, is_bank: 0, in_official_roster: 1, user_id: 3, faction: 'Horde',
    readiness: { ilvl: 50.4, durability: 22, consumables: {}, at: Math.floor((Date.now() - 2 * HOUR) / 1000) } },
  { id: 5, name: 'Tazrik', class: 'ROGUE', race: 'Troll', level: 35, rank: 'Member', rank_index: 3, zone: 'Stranglethorn Vale', online: 0, last_seen: sqlTime(9 * DAY), is_main: 1, is_bank: 0, in_official_roster: 1, user_id: 4, faction: 'Horde' },
  { id: 6, name: 'Hrogar', class: 'HUNTER', race: 'Orc', level: 60, rank: 'Veteran', rank_index: 2, zone: 'Undercity', online: 0, last_seen: sqlTime(20 * HOUR), is_main: 0, is_bank: 0, in_official_roster: 1, user_id: null },
  { id: 7, name: 'Ilyra', class: 'MAGE', race: 'Undead', level: 19, rank: 'Initiate', rank_index: 4, zone: 'The Barrens', online: 1, last_seen: sqlTime(30 * 1000), is_main: 1, is_bank: 0, in_official_roster: 0, user_id: 5, faction: 'Horde' },
  { id: 8, name: 'Brannoc', class: 'DRUID', race: 'Tauren', level: 47, rank: 'Member', rank_index: 3, zone: 'Feralas', online: 0, last_seen: sqlTime(2 * DAY), is_main: 0, is_bank: 0, in_official_roster: 1, user_id: null },
  { id: 9, name: 'Seraphel', class: 'PRIEST', race: 'Undead', level: 12, rank: 'Initiate', rank_index: 4, zone: 'Tirisfal Glades', online: 0, last_seen: null, is_main: 0, is_bank: 0, in_official_roster: 1, user_id: null },
  { id: 10, name: 'Vaultkeep', class: 'WARRIOR', race: 'Orc', level: 5, rank: 'Bank', rank_index: 6, zone: 'Orgrimmar', online: 0, last_seen: sqlTime(4 * DAY), is_main: 0, is_bank: 1, in_official_roster: 1, user_id: 1 },
  { id: 11, name: 'Kazgul', class: 'PALADIN', race: 'Orc', level: 24, rank: 'Member', rank_index: 3, zone: "Ashenvale", online: 1, last_seen: sqlTime(3 * MIN), is_main: 0, is_bank: 0, in_official_roster: 1, user_id: null },
];

const PROFS = {
  Grimtusk: [{ name: 'Blacksmithing', skill: 300, max_skill: 300 }, { name: 'Mining', skill: 285, max_skill: 300 }],
  Velanne: [{ name: 'Tailoring', skill: 290, max_skill: 300 }, { name: 'Enchanting', skill: 240, max_skill: 300 }],
  Mokra: [{ name: 'Alchemy', skill: 250, max_skill: 300 }, { name: 'Herbalism', skill: 225, max_skill: 300 }],
  Shadowfen: [{ name: 'Tailoring', skill: 180, max_skill: 225 }],
  Hrogar: [{ name: 'Leatherworking', skill: 260, max_skill: 300 }, { name: 'Skinning', skill: 300, max_skill: 300 }],
  Brannoc: [{ name: 'Alchemy', skill: 205, max_skill: 225 }],
};
const RECIPES = {
  Grimtusk: { Blacksmithing: [['Arcanite Reaper', 16994], ['Copper Chain Vest', 2661], ['Dense Sharpening Stone', 16641], ['Thorium Belt', 16643], ['Imperial Plate Chest', 16731], ['Heavy Grinding Stone', 3337]] },
  Velanne: { Tailoring: [['Runecloth Bag', 18405], ['Mooncloth', 18560], ['Heavy Silk Bandage', 7929], ['Bolt of Runecloth', 18401]], Enchanting: [['Enchant Bracer - Superior Stamina', 20011], ['Enchant Weapon - Crusader', 20034]] },
  Mokra: { Alchemy: [['Major Healing Potion', 17556], ['Elixir of Fortitude', 3450], ['Flask of the Titans', 17635], ['Greater Fire Protection Potion', 17574]] },
  Shadowfen: { Tailoring: [['Heavy Silk Bandage', 7929], ['Bolt of Silk Cloth', 3839]] },
  Hrogar: { Leatherworking: [['Rugged Armor Kit', 19058], ['Devilsaur Gauntlets', 19084]] },
  Brannoc: { Alchemy: [['Major Healing Potion', 17556], ['Free Action Potion', 6624]] },
};

const world = {
  ctas: [
    { id: 3, zone: 'Tarren Mill', needed: 10, message: 'Alliance raid incoming from Southshore!', character: 'Velanne', class: 'PRIEST', source: 'app', created_at: sqlTime(12 * MIN), user_id: 2, battletag: USERS[2] },
    { id: 2, zone: 'Crossroads', needed: 5, message: 'Ganker at the flight master', character: 'Mokra', class: 'SHAMAN', source: 'addon', created_at: sqlTime(4 * HOUR), user_id: 3, battletag: USERS[3] },
  ],
  announcements: [
    { id: 3, body: 'Molten Core on Friday 20:00 server time. Bring fire resistance gear and potions.', user_id: 1, battletag: USERS[1], created_at: sqlTime(5 * HOUR) },
    { id: 2, body: 'Guild bank now has a tab for raid consumables. Ask an officer if you need flasks.', user_id: 2, battletag: USERS[2], created_at: sqlTime(3 * DAY) },
  ],
  activity: [
    { id: 30, kind: 'craft', text: 'Velanne is making Runecloth Bag', created_at: sqlTime(20 * MIN) },
    { id: 29, kind: 'buddy', text: 'Ilyra is looking for leveling partners in The Barrens', created_at: sqlTime(50 * MIN) },
    { id: 28, kind: 'craft', text: 'Ilyra asked for Runecloth Bag', created_at: sqlTime(2 * HOUR) },
    { id: 27, kind: 'character', text: 'Kazgul reached level 24', created_at: sqlTime(6 * HOUR) },
    { id: 26, kind: 'craft', text: 'Major Healing Potion delivered', created_at: sqlTime(26 * HOUR) },
    { id: 25, kind: 'member', text: 'Ilyra joined the guild', created_at: sqlTime(4 * DAY) },
  ],
  requests: [
    { id: 14, item: 'Runecloth Bag', notes: 'I have 5 runecloth, will mail', status: 'claimed', requester_id: 5, crafter_id: 2, created_at: sqlTime(2 * HOUR), updated_at: sqlTime(20 * MIN) },
    { id: 13, item: 'Flask of the Titans', notes: 'For MC on Friday. Paying 20g on top.', status: 'open', requester_id: 2, crafter_id: null, created_at: sqlTime(5 * HOUR), updated_at: sqlTime(5 * HOUR) },
    { id: 12, item: 'Arcanite Reaper', notes: '', status: 'open', requester_id: 4, crafter_id: null, created_at: sqlTime(1 * DAY), updated_at: sqlTime(1 * DAY) },
    { id: 11, item: 'Truesilver Champion', notes: 'Long shot', status: 'open', requester_id: 3, crafter_id: null, created_at: sqlTime(2 * DAY), updated_at: sqlTime(2 * DAY) },
    { id: 10, item: 'Major Healing Potion', notes: 'x20 please', status: 'done', requester_id: 1, crafter_id: 3, created_at: sqlTime(3 * DAY), updated_at: sqlTime(26 * HOUR) },
  ],
  partners: [
    { id: 6, user_id: 5, character: 'Ilyra', zone: 'The Barrens', when_text: 'Tonight after 19:00', note: 'Doing the Wailing Caverns quests, need a tank.', created_at: sqlTime(50 * MIN) },
    { id: 5, user_id: 4, character: 'Tazrik', zone: 'Stranglethorn Vale', when_text: 'Weekend', note: 'Nesingwary chain. Happy to group with anyone 32-38.', created_at: sqlTime(20 * HOUR) },
    { id: 4, user_id: 1, character: 'Shadowfen', zone: 'Desolace', when_text: 'Sunday afternoon', note: 'Centaur rep and Maraudon runs.', created_at: sqlTime(1 * DAY) },
  ],
  shopping: {
    1: { updatedAt: sqlTime(40 * MIN), items: [{ name: 'Dense Sharpening Stone', qty: 20, prof: 'Blacksmithing' }, { name: 'Thorium Belt', qty: 2, prof: 'Blacksmithing' }],
      mats: [
        { id: 12365, name: 'Dense Stone', need: 20, chars: [{ name: 'Grimtusk', n: 8 }], guildBank: 40, price: 1850 },
        { id: 12359, name: 'Thorium Bar', need: 20, chars: [], guildBank: 12, price: 9500 },
        { id: 7077, name: 'Heart of Fire', need: 2, chars: [{ name: 'Shadowfen', n: 1 }], guildBank: 0, price: null },
      ] },
    2: { updatedAt: sqlTime(3 * HOUR), items: [{ name: 'Runecloth Bag', qty: 4, prof: 'Tailoring' }],
      mats: [{ id: 14047, name: 'Runecloth', need: 20, price: 1200 }, { id: 8170, name: 'Rugged Leather', need: 8, price: 2600 }, { id: 14341, name: 'Rune Thread', need: 4, price: 5000 }] },
    3: { updatedAt: sqlTime(2 * DAY), items: [{ name: 'Major Healing Potion', qty: 10, prof: 'Alchemy' }],
      mats: [{ id: 13464, name: 'Golden Sansam', need: 20, price: 3500 }, { id: 13465, name: 'Mountain Silversage', need: 10, price: 4200 }, { id: 8925, name: 'Crystal Vial', need: 10, price: null }] },
  },
  nextId: 100,
};

// ---------- helpers ----------

const me = (state) => state.userId;
const isOfficer = (state) => isOfficerIn(state);
const charByName = (name) => CHARS.find((c) => c.name.toLowerCase() === String(name).toLowerCase()) || null;
const myChars = (uid) => CHARS.filter((c) => c.user_id === uid).sort((a, b) => b.is_main - a.is_main || b.level - a.level);
const mainOf = (uid) => myChars(uid)[0] || null;
const battletag = (uid) => USERS[uid] || 'Someone#0000';
const stamp = (kind, text) => world.activity.unshift({ id: ++world.nextId, kind, text, created_at: sqlTime() });

function crafterChars(item) {
  const k = String(item).toLowerCase();
  return CHARS.filter((c) => Object.values(RECIPES[c.name] || {}).some((list) => list.some(([n]) => n.toLowerCase() === k)));
}
const crafterJson = (c) => ({ name: c.name, class: c.class, online: c.online });
function requestJson(r, uid) {
  const crafters = r.status === 'open' ? crafterChars(r.item).map(crafterJson) : [];
  return {
    ...r, requester: battletag(r.requester_id), crafter: r.crafter_id ? battletag(r.crafter_id) : null, crafters,
    mine: r.requester_id === uid, i_can_craft: crafterChars(r.item).some((c) => c.user_id === uid),
    canClaim: r.status === 'open' && r.requester_id !== uid,
    canDone: r.status === 'claimed' && (r.crafter_id === uid || r.requester_id === uid),
    canCancel: r.requester_id === uid && (r.status === 'open' || r.status === 'claimed'),
    canWithdraw: r.status === 'claimed' && r.crafter_id === uid,
  };
}
function onboarding(uid) {
  const chars = myChars(uid);
  const steps = [
    { key: 'synced', done: chars.length > 0, label: 'Install the addon, then log in to the game once', href: '/addon' },
    { key: 'professions', done: chars.some((c) => PROFS[c.name]), label: 'Open each profession window in game, then /reload', href: '/crafters' },
    { key: 'main', done: chars.some((c) => c.is_main), label: 'Pick your main character', href: chars[0] ? `/characters/${encodeURIComponent(chars[0].name)}` : '/roster' },
    { key: 'signup', done: uid === 1, label: 'Sign up for Molten Core', href: '/raids/12' },
  ];
  return { steps, done: steps.filter((s) => s.done).length, total: steps.length };
}
function totals(mats) {
  let total = 0;
  let unpriced = 0;
  for (const m of mats) { if (m.price == null) unpriced += 1; else total += m.price * m.need; }
  return { total, unpriced };
}

// ---------- routes ----------

addMockRoutes({
  'GET /api/camp': ({ state }) => {
    needGuild(state);
    const uid = me(state);
    const main = mainOf(uid);
    const recent = myChars(uid).filter((c) => c.zone).sort((a, b) => String(b.last_seen || '').localeCompare(String(a.last_seen || '')))[0];
    return {
      guild: { id: 1, name: state.guild.name, faction: state.guild.faction, realm: state.guild.realm ?? null },
      realm: { found: true, name: 'Mirage Raceway', up: true, queue: false, population: 'High', checkedAt: iso(-4 * MIN) },
      rosterScannedAt: sqlTime(4 * MIN),
      online: CHARS.filter((c) => c.online).sort((a, b) => b.level - a.level || a.name.localeCompare(b.name))
        .map(({ id, name, class: cls, race, level, zone, rank, is_main, user_id }) => ({ id, name, class: cls, race, level, zone, rank, is_main, user_id, battletag: user_id ? battletag(user_id) : null })),
      ctas: world.ctas.slice(0, 8),
      announcements: world.announcements.slice(0, 5).map((a) => ({ ...a, canDelete: isOfficer(state) })),
      activity: world.activity.slice(0, 12),
      raids: [
        { id: 12, kind: 'raid', title: 'Molten Core', instance: 'Molten Core', starts_at: iso(2 * DAY + 3 * HOUR), status: 'open', size: 40, coming: 18, maybe: 3,
          mySignup: uid === 1 ? { status: 'yes', role: 'tank', character: 'Grimtusk' } : null },
        { id: 13, kind: 'pvp', title: 'Tarren Mill premade', instance: 'Alterac Mountains', starts_at: iso(4 * DAY - 2 * HOUR), status: 'open', size: 15, coming: 9, maybe: 4,
          mySignup: uid === 1 ? { status: 'tentative', role: 'dps', character: 'Grimtusk' } : null },
        { id: 14, kind: 'event', title: 'Fishing contest', instance: 'Stranglethorn Vale', starts_at: iso(6 * DAY), status: 'open', size: null, coming: 5, maybe: 1, mySignup: null },
      ],
      mySync: uid === 5 ? null : sqlTime(3 * MIN),
      onboarding: onboarding(uid),
      me: { main: main ? { name: main.name, class: main.class, level: main.level, zone: main.zone } : null, lastZone: recent ? recent.zone : null, lastZoneCharacter: recent ? recent.name : null },
      isOfficer: isOfficer(state),
    };
  },

  'GET /api/activity': ({ state, query }) => {
    needGuild(state);
    const before = Number(query.before) || Infinity;
    const limit = Math.min(100, Number(query.limit) || 30);
    const rows = world.activity.filter((a) => a.id < before);
    return { activity: rows.slice(0, limit), more: rows.length > limit };
  },

  'POST /api/ctas': ({ state, body }) => {
    needGuild(state);
    const zone = String(body?.zone || '').trim().slice(0, 60);
    if (!zone) throw httpError(400, 'Say where the fight is.');
    const n = body?.needed == null || body.needed === '' ? null : Math.min(40, Math.max(1, Math.trunc(Number(body.needed)) || 1));
    const main = mainOf(me(state));
    const cta = { id: ++world.nextId, zone, needed: n, message: String(body?.message || '').trim().slice(0, 200), character: main ? main.name : null,
      class: main ? main.class : null, source: 'app', created_at: sqlTime(), user_id: me(state), battletag: battletag(me(state)) };
    world.ctas.unshift(cta);
    return { cta, message: 'Horn sounded.' };
  },

  'POST /api/announcements': ({ state, body }) => {
    needGuild(state);
    if (!isOfficer(state)) throw httpError(403, 'Officers only.');
    const text = String(body?.body || '').trim().slice(0, 500);
    if (!text) throw httpError(400, 'Write the notice first.');
    const a = { id: ++world.nextId, body: text, user_id: me(state), battletag: battletag(me(state)), created_at: sqlTime() };
    world.announcements.unshift(a);
    return { announcement: { ...a, canDelete: true }, message: 'Notice posted.' };
  },

  'DELETE /api/announcements/:id': ({ state, params }) => {
    needGuild(state);
    if (!isOfficer(state)) throw httpError(403, 'Officers only.');
    const before = world.announcements.length;
    world.announcements = world.announcements.filter((a) => String(a.id) !== params.id);
    if (world.announcements.length === before) throw httpError(404, 'That notice was already removed.');
    return { ok: true, message: 'Notice removed.' };
  },

  'GET /api/roster': ({ state }) => {
    needGuild(state);
    const characters = [...CHARS].sort((a, b) => b.online - a.online || b.level - a.level || a.name.localeCompare(b.name))
      .map(({ id, name, class: cls, race, level, rank, rank_index, zone, online, last_seen, is_main, is_bank, in_official_roster, user_id }) => ({
        id, name, class: cls, race, level, rank, rank_index, zone, online, last_seen, is_main, is_bank, in_official_roster, user_id,
        updated_at: last_seen, battletag: user_id ? battletag(user_id) : null,
      }));
    return {
      characters, scannedAt: sqlTime(4 * MIN), officialRosterAt: sqlTime(6 * HOUR),
      counts: { total: characters.length, online: characters.filter((c) => c.online).length, linked: characters.filter((c) => c.user_id).length, mains: characters.filter((c) => c.is_main).length },
    };
  },

  'GET /api/characters/:name': ({ state, params }) => {
    needGuild(state);
    const c = charByName(params.name);
    if (!c) throw httpError(404, "That character isn't on the guild roster yet.");
    const uid = me(state);
    const mine = c.user_id === uid;
    const recipes = Object.entries(RECIPES[c.name] || {}).flatMap(([profession, list]) => list.map(([name, id]) => ({ profession, name, recipe_id: id })))
      .sort((a, b) => a.profession.localeCompare(b.profession) || a.name.localeCompare(b.name));
    return {
      character: {
        id: c.id, name: c.name, class: c.class, race: c.race, level: c.level, faction: c.faction || null, rank: c.rank, zone: c.zone, online: c.online,
        last_seen: c.last_seen, is_main: c.is_main, is_bank: c.is_bank, in_official_roster: c.in_official_roster, user_id: c.user_id,
        battletag: c.user_id ? battletag(c.user_id) : null, updated_at: c.last_seen, money: mine ? c.money ?? null : null,
        readiness: c.readiness || null, extras: c.extras || null,
      },
      professions: PROFS[c.name] || [],
      recipes,
      alts: c.user_id ? myChars(c.user_id).filter((x) => x !== c).map(({ name, class: cls, level, is_main, online, zone }) => ({ name, class: cls, level, is_main, online, zone })) : [],
      isMine: mine,
      canMakeMain: mine && !c.is_main,
    };
  },

  'POST /api/characters/:name/main': ({ state, params }) => {
    needGuild(state);
    const c = charByName(params.name);
    if (!c || c.user_id !== me(state)) throw httpError(404, "That isn't one of your characters.");
    for (const x of CHARS) if (x.user_id === c.user_id) x.is_main = 0;
    c.is_main = 1;
    return { ok: true, character: { name: c.name, is_main: 1 }, message: `${c.name} is now your main.` };
  },

  'GET /api/crafters': ({ state, query }) => {
    needGuild(state);
    const q = String(query.q || '').trim().slice(0, 60);
    const uid = me(state);
    let results = [];
    if (q) {
      const map = new Map();
      for (const c of CHARS) {
        for (const [profession, list] of Object.entries(RECIPES[c.name] || {})) {
          for (const [name, id] of list) {
            if (!name.toLowerCase().includes(q.toLowerCase())) continue;
            const key = name.toLowerCase();
            if (!map.has(key)) map.set(key, { recipe: name, recipeId: id, profession, crafters: [] });
            map.get(key).crafters.push({ name: c.name, class: c.class, level: c.level, online: c.online, user_id: c.user_id });
          }
        }
      }
      results = [...map.values()].sort((a, b) => a.recipe.localeCompare(b.recipe));
      for (const r of results) r.crafters.sort((a, b) => b.online - a.online || a.name.localeCompare(b.name));
    }
    const profMap = new Map();
    for (const [name, list] of Object.entries(PROFS)) {
      const c = charByName(name);
      for (const p of list) {
        if (!profMap.has(p.name)) profMap.set(p.name, []);
        profMap.get(p.name).push({ name, class: c.class, level: c.level, online: c.online, skill: p.skill, max_skill: p.max_skill });
      }
    }
    const professions = [...profMap].sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name, crafters]) => ({ name, count: crafters.length, crafters: crafters.sort((a, b) => b.skill - a.skill) }));
    const mineShop = world.shopping[uid];
    const shopping = mineShop ? { items: mineShop.items, updatedAt: mineShop.updatedAt, mats: mineShop.mats.map((m) => ({ chars: [], guildBank: 0, ...m })), ...totals(mineShop.mats) } : null;
    const lists = Object.entries(world.shopping).filter(([id]) => Number(id) !== uid).map(([id, l]) => {
      const main = mainOf(Number(id));
      return { user_id: Number(id), battletag: battletag(Number(id)), main: main ? { name: main.name, class: main.class, level: main.level } : null,
        updatedAt: l.updatedAt, items: l.items, mats: l.mats.map(({ id: mid, name, need, price }) => ({ id: mid, name, need, price })), ...totals(l.mats) };
    });
    return { q, results, professions, shopping, lists };
  },

  'GET /api/requests': ({ state }) => {
    needGuild(state);
    const uid = me(state);
    const requests = world.requests.filter((r) => r.status !== 'cancelled').map((r) => requestJson(r, uid));
    const count = (s) => requests.filter((r) => r.status === s).length;
    return { requests, counts: { open: count('open'), claimed: count('claimed'), done: count('done') } };
  },

  'POST /api/requests': ({ state, body }) => {
    needGuild(state);
    const item = String(body?.item || '').trim().slice(0, 100);
    if (!item) throw httpError(400, 'Name the item you need.');
    const uid = me(state);
    const r = { id: ++world.nextId, item, notes: String(body?.notes || '').trim().slice(0, 200), status: 'open', requester_id: uid, crafter_id: null, created_at: sqlTime(), updated_at: sqlTime() };
    world.requests.unshift(r);
    stamp('craft', `${short(battletag(uid))} asked for ${item}`);
    // Crafters hear about it from their own apps once it reaches them in game (the core says just this).
    return { request: requestJson(r, uid), message: 'Request posted.' };
  },

  'POST /api/requests/:id/:verb': ({ state, params }) => {
    needGuild(state);
    const r = world.requests.find((x) => String(x.id) === params.id);
    if (!r) throw httpError(404, 'That request no longer exists.');
    const uid = me(state);
    const can = requestJson(r, uid);
    let message;
    if (params.verb === 'claim' && can.canClaim) {
      Object.assign(r, { status: 'claimed', crafter_id: uid, updated_at: sqlTime() });
      stamp('craft', `${short(battletag(uid))} is making ${r.item}`);
      message = `You're making ${r.item}.`;
    } else if (params.verb === 'withdraw' && can.canWithdraw) {
      // The crafter gives it back: open again for other crafters.
      Object.assign(r, { status: 'open', crafter_id: null, updated_at: sqlTime() });
      message = `You're no longer making ${r.item}.`;
    } else if (params.verb === 'done' && can.canDone) {
      Object.assign(r, { status: 'done', updated_at: sqlTime() });
      stamp('craft', `${r.item} delivered`);
      message = 'Marked as delivered.';
    } else if (params.verb === 'cancel' && can.canCancel) {
      Object.assign(r, { status: 'cancelled', updated_at: sqlTime() });
      message = 'Request cancelled.';
    } else {
      throw httpError(409, 'That request has already moved on.');
    }
    return { ok: true, request: requestJson(r, uid), message };
  },

  'GET /api/partners': ({ state }) => {
    needGuild(state);
    const uid = me(state);
    return {
      posts: world.partners.map((p) => {
        const c = charByName(p.character);
        return { ...p, level: c ? c.level : p.level ?? null, class: c ? c.class : null, battletag: battletag(p.user_id), mine: p.user_id === uid };
      }),
      myCharacters: myChars(uid).map(({ name, class: cls, level, zone, is_main }) => ({ name, class: cls, level, zone, is_main })),
    };
  },

  'POST /api/partners': ({ state, body }) => {
    needGuild(state);
    const character = String(body?.character || '').trim().slice(0, 40);
    if (!character) throw httpError(400, 'Pick the character you are leveling.');
    const uid = me(state);
    world.partners = world.partners.filter((p) => !(p.user_id === uid && p.character === character));
    const c = charByName(character);
    const zone = String(body?.zone || '').trim().slice(0, 60);
    const post = { id: ++world.nextId, user_id: uid, character, zone, when_text: String(body?.when_text || '').trim().slice(0, 60),
      note: String(body?.note || '').trim().slice(0, 140), created_at: sqlTime(), level: c ? c.level : null };
    world.partners.unshift(post);
    stamp('buddy', `${character} is looking for leveling partners${zone ? ` in ${zone}` : ''}`);
    return { post: { ...post, class: c ? c.class : null, battletag: battletag(uid), mine: true }, message: 'Posted. It stays up for 3 days.' };
  },

  'POST /api/partners/:id/close': ({ state, params }) => {
    needGuild(state);
    const p = world.partners.find((x) => String(x.id) === params.id);
    if (!p) throw httpError(404, 'That post no longer exists.');
    if (p.user_id !== me(state)) throw httpError(403, 'You can only remove your own posts.');
    world.partners = world.partners.filter((x) => x !== p);
    return { ok: true, message: 'Post removed.' };
  },
});
