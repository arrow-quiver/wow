'use strict';
// Demo data for screenshot runs (`--smoke --smoke-seed`): a realistic guild so every page has something
// to show. Never used outside smoke runs.
//
//   const auth = createDemoAuth();          // stands in for Battle.net: signed in as the demo player
//   await loadDemo(core);                   // fills a fresh local core (createCore result)
//
// The demo player is Calvin#1234 playing Grimtusk, Guild Master of "Just Now WoW" on Mirage Raceway.
// Their own data goes in the way real data does: a sync upload (POST /api/sync) and the app's own API
// calls. Guildmates are players as sharing stores them (a 'pid:<player id>' users row + membership, their
// characters through the same applyPayload the sync uses). Their sign-ups and reserves arrive as shared
// records (su) through sharing.importShared, the way an upload brings them, so the raid rows the app
// remakes from records keep them. Their other rows (calls to arms, notices, requests, posts, bank
// requests, hand-ins) are written as rows from before sharing, which the pages show as they are.
const { EventEmitter } = require('events');
const { applyPayload } = require('./services/sync');
const identity = require('./identity');
const sharing = require('./sharing');
const S = require('../shared/sharing');
const R = require('./services/raids');

const GUILD = 'Just Now WoW';
const REALM = 'Mirage Raceway';
const DAY0 = Date.UTC(2020, 0, 1);

const DEMO_IDENTITY = Object.freeze({
  battletag: 'Calvin#1234',
  characters: [
    { name: 'Grimtusk', realm: REALM, realm_slug: 'mirage-raceway', level: 60, class: 'WARRIOR', race: 'Orc', faction: 'Horde', namespace: 'profile-classic1x-eu', guild: GUILD },
    { name: 'Shadowfen', realm: REALM, realm_slug: 'mirage-raceway', level: 42, class: 'WARLOCK', race: 'Undead', faction: 'Horde', namespace: 'profile-classic1x-eu', guild: GUILD },
  ],
});

// A stand-in for auth.js: always signed in as the demo player, never talks to Battle.net.
function createDemoAuth(id = DEMO_IDENTITY) {
  const emitter = new EventEmitter();
  const profileAt = new Date().toISOString(); // fixed at start: the demo state never changes
  const state = () => ({
    available: true, signedIn: true, signingIn: false, battletag: id.battletag, region: 'eu',
    characters: id.characters.map((c) => ({ ...c })), profileAt, canRefresh: false, error: null, demo: true,
  });
  const same = async () => state();
  return Object.assign(emitter, { state, signIn: same, signOut: same, refresh: same, cancel: state });
}

// A wobbly two-week price history for one item ending at `price`.
function history(id, price, drift, today) {
  let seed = id;
  const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
  const out = [];
  for (let d = 13; d >= 0; d--) {
    if (d > 0 && rnd() < 0.2) continue;
    const p = d === 0 ? price : Math.max(1, Math.round(price * (1 - drift * (d / 13)) * (0.94 + rnd() * 0.12)));
    out.push([id, p, today - d]);
  }
  return out;
}

const ITEMS = {
  14047: ['Runecloth', 118, 0.2], 12359: ['Thorium Bar', 2650, -0.1], 12363: ['Arcane Crystal', 41000, 0.15], 13444: ['Major Mana Potion', 4200, -0.05],
  13446: ['Major Healing Potion', 2300, 0.08], 13457: ['Greater Fire Protection Potion', 9800, 0.3], 13452: ['Elixir of the Mongoose', 31000, -0.12],
  13510: ['Flask of the Titans', 412000, 0.05], 13468: ['Black Lotus', 690000, -0.2], 14530: ['Heavy Runecloth Bandage', 1850, 0],
  7068: ['Elemental Fire', 6100, 0.1], 12808: ['Essence of Undeath', 19500, -0.08], 12811: ['Righteous Orb', 8900, 0.02], 14342: ['Mooncloth', 52000, 0.1],
  14344: ['Large Brilliant Shard', 15500, -0.15], 11370: ['Dark Iron Ore', null, 0], 4338: ['Mageweave Cloth', 95, 0.1], 8170: ['Rugged Leather', 1350, -0.05],
  13463: ['Dreamfoil', 3200, 0.12], 13466: ['Plaguebloom', 3900, -0.02], 13465: ['Mountain Silversage', 4400, 0.06], 8846: ['Gromsblood', 2100, 0.2],
  2589: ['Linen Cloth', 12, 0], 12365: ['Dense Stone', 1850, 0.04], 7077: ['Heart of Fire', 2400, -0.03], 14341: ['Rune Thread', 5000, 0], 8925: ['Crystal Vial', 160, 0],
};
const it = (id, count) => ({ id: Number(id), name: ITEMS[id][0], count });

const PLAN = {
  headline: 'Protection for raids, Arms for the open world',
  summary: 'You tank Molten Core and like to start fights outside it. Keep a raid tanking build and a cheap respec plan for PvP weekends.',
  spec: 'Protection', split: '14/5/32',
  talents: [
    { name: 'Shield Specialization', tree: 'Protection', points: 5, why: 'More blocks, more rage' },
    { name: 'Defiance', tree: 'Protection', points: 5, why: 'Holds threat on Ragnaros adds' },
    { name: 'Improved Rend', tree: 'Arms', points: 3, why: 'Cheap points on the way down' },
  ],
  stats: ['Defense to 440', 'Stamina', 'Fire resistance for Ragnaros'],
  gear: [{ slot: 'Shield', advice: 'Drillborer Disk from Garr is your next big upgrade' }],
  next_steps: [{ title: 'Farm fire resistance', detail: 'Aim for 200 fire resistance before Ragnaros' }],
  tips: ['Use Shield Block before every Lava Burst wave'], confidence: 'classic', level: 60, model: 'demo',
};

/**
 * Fills a fresh core with the demo guild.
 * @param {object} core   createCore() result ({ url, token, db })
 * @param {object} [opts] { now: ms }
 * @returns {Promise<{ guildId: number, me: number }>}
 */
async function loadDemo(core, { now: nowMs = Date.now() } = {}) {
  const { db } = core;
  const call = async (method, path, body) => {
    const res = await fetch(core.url + path, {
      method,
      headers: { Authorization: `Bearer ${core.token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    if (!res.ok) throw new Error(`Demo data: ${method} ${path} → ${res.status} ${typeof data === 'object' ? data.error : data}`);
    return data;
  };
  const now = Math.floor(nowMs / 1000);
  const today = Math.floor((nowMs - DAY0) / 86400000);
  const at = (ms) => new Date(nowMs + ms).toISOString();
  const H = 3600 * 1000;
  const D = 24 * H;

  core.setIdentity(DEMO_IDENTITY);

  // ---- my own upload: characters, the roster scan, guild bank, prices, shopping list, the Coach ----
  const prices = Object.entries(ITEMS).filter(([, v]) => v[1]).flatMap(([id, v]) => history(Number(id), v[1], v[2], today));
  const roster = [
    ['Grimtusk', 'WARRIOR', 60, 'Guild Master', 0, 'Orgrimmar', true], ['Velanne', 'PRIEST', 60, 'Officer', 1, 'Blackrock Mountain', true],
    ['Mokra', 'SHAMAN', 58, 'Member', 3, 'Winterspring', true], ['Ilyra', 'MAGE', 19, 'Initiate', 4, 'The Barrens', true],
    ['Kazgul', 'PALADIN', 24, 'Member', 3, 'Ashenvale', true], ['Hrogar', 'HUNTER', 60, 'Veteran', 2, 'Undercity', true],
    ['Zuljinne', 'HUNTER', 18, 'Initiate', 4, 'Stonetalon Mountains', true], ['Shadowfen', 'WARLOCK', 42, 'Alt', 3, 'Desolace', false],
    ['Tazrik', 'ROGUE', 35, 'Member', 3, 'Stranglethorn Vale', false], ['Brannoc', 'DRUID', 47, 'Member', 3, 'Feralas', false],
    ['Seraphel', 'PRIEST', 12, 'Initiate', 4, 'Tirisfal Glades', false], ['Morgath', 'WARLOCK', 60, 'Veteran', 2, 'Orgrimmar', false],
    ['Thrakk', 'WARRIOR', 54, 'Member', 3, 'Eastern Plaguelands', false], ['Stashwick', 'MAGE', 14, 'Bank', 3, 'Orgrimmar', false],
  ].map(([name, cls, level, rank, rankIndex, zone, online]) => ({ name, class: cls, level, rank, rankIndex, zone, online }));
  const scannedAt = now - 3 * 3600;
  await call('POST', '/api/sync', {
    addonVersion: '0.11.0',
    characters: {
      Grimtusk: {
        name: 'Grimtusk', class: 'WARRIOR', race: 'Orc', level: 60, faction: 'Horde', zone: 'Orgrimmar', money: 4235190, realm: REALM, guild: GUILD, updated: now - 120,
        professions: [{ name: 'Blacksmithing', skill: 300, max: 300 }, { name: 'Mining', skill: 285, max: 300 }],
        recipes: {
          Blacksmithing: [{ name: 'Arcanite Reaper', id: 16994 }, { name: 'Copper Chain Vest', id: 2661 }, { name: 'Dense Sharpening Stone', id: 16641 },
            { name: 'Thorium Belt', id: 16643 }, { name: 'Imperial Plate Chest', id: 16731 }, { name: 'Thorium Armor', id: 16642 }, { name: 'Dense Weightstone', id: 16640 }],
          Mining: [{ name: 'Smelt Thorium', id: 16153 }, { name: 'Smelt Mithril', id: 10097 }],
        },
        readiness: { ilvl: 61.2, durability: 88, consumables: { flask: 2, potion: 14, food: 20 }, at: now - 600 },
        pvp: { rank: 8, rankName: 'Blood Guard', honor: 18450, hk: 2210, weekHk: 64, weekContribution: 5400, lastWeekRank: 7, highestRank: 8 },
        reputations: [{ name: 'Orgrimmar', standing: 7, value: 9200, max: 21000, header: 'Horde' }, { name: 'Argent Dawn', standing: 6, value: 3100, max: 12000 },
          { name: 'Timbermaw Hold', standing: 5, value: 1400, max: 6000 }, { name: 'Thorium Brotherhood', standing: 4, value: 1500, max: 3000 }],
        currencies: [{ id: 3001, name: "Merchant's Favor", qty: 12, max: 50 }],
        inventory: { bags: [it(14047, 34), it(13446, 6), it(13444, 4), it(12365, 8)], bank: [it(12359, 12), it(7068, 8)] },
      },
      Shadowfen: {
        name: 'Shadowfen', class: 'WARLOCK', race: 'Undead', level: 42, faction: 'Horde', zone: 'Desolace', money: 150230, realm: REALM, guild: GUILD, updated: now - 3 * 86400,
        professions: [{ name: 'Tailoring', skill: 180, max: 225 }],
        recipes: { Tailoring: [{ name: 'Heavy Silk Bandage', id: 7929 }, { name: 'Bolt of Silk Cloth', id: 3839 }] },
        inventory: { bags: [it(4338, 20)], bank: [it(14047, 160), it(4338, 220), it(7077, 1)] },
      },
    },
    roster: { scannedAt: now - 240, guild: GUILD, members: roster },
    guildBank: {
      scannedAt, guild: GUILD, money: 18734215,
      tabs: [
        { name: 'Raid consumables', items: [it(13444, 40), it(13446, 60), it(13457, 24), it(13452, 8), it(13510, 2), it(14530, 120)] },
        { name: 'Mats', items: [it(14047, 860), it(12359, 140), it(12363, 12), it(7068, 35), it(12808, 18), it(12811, 6), it(14342, 9), it(14344, 22), it(11370, 30)] },
        { name: 'Herbs', items: [it(13468, 3), it(13463, 44), it(13466, 26), it(13465, 31), it(8846, 18)] },
        { name: 'Leveling gear', items: [it(4338, 300), it(8170, 80), it(2589, 140)] },
      ],
      log: [
        { kind: 'deposit', who: 'Mokra', id: 14047, name: 'Runecloth', count: 120, at: scannedAt - 3600 },
        { kind: 'withdraw', who: 'Velanne', id: 13457, name: 'Greater Fire Protection Potion', count: 5, at: scannedAt - 2 * 3600 },
        { kind: 'deposit', who: 'Grimtusk', amount: 1500000, at: scannedAt - 4 * 3600 },
        { kind: 'repair', who: 'Velanne', amount: 84211, at: scannedAt - 9 * 3600 },
        { kind: 'withdraw', who: 'Tazrik', id: 12359, name: 'Thorium Bar', count: 20, at: scannedAt - 30 * 3600 },
        { kind: 'deposit', who: 'Ilyra', id: 4338, name: 'Mageweave Cloth', count: 60, at: scannedAt - 50 * 3600 },
      ],
    },
    prices: { items: prices },
    reagentIds: [12365, 12359, 7077],
    shopping: [
      { name: 'Dense Sharpening Stone', qty: 20, prof: 'Blacksmithing', reagents: [{ id: 12365, name: 'Dense Stone', qty: 1 }] },
      { name: 'Thorium Belt', qty: 2, prof: 'Blacksmithing', reagents: [{ id: 12359, name: 'Thorium Bar', qty: 10 }, { id: 7077, name: 'Heart of Fire', qty: 1 }] },
    ],
    coach: {
      chars: {
        Grimtusk: {
          name: 'Grimtusk', class: 'WARRIOR', level: 60, realm: REALM,
          profile: { scores: { aggression: 78, risk: 45, social: 70, pvp: 66, pace: 55 }, archetype: 'Shield of the guild', blurb: 'You take the hits so others can play.', minutes: 5400, quiz: true },
          stats: { pullsPerHour: 38, deathsPerHour: 0.4 }, quiz: { aggression: 4, pvp: 3 },
          talents: { trees: [{ name: 'Arms', points: 14 }, { name: 'Fury', points: 5 }, { name: 'Protection', points: 32 }], unspent: 0,
            picked: [{ name: 'Shield Specialization', rank: 5, max: 5 }, { name: 'Improved Rend', rank: 3, max: 3 }] },
          gear: { items: [{ slot: 'MainHand', name: 'Quel\'Serrar', ilvl: 63 }], lowestDurability: 88, freeSlots: 14 },
        },
      },
    },
  });

  const g = identity.currentGuild(db);
  const me = identity.meId(db);
  const gid = g.id;
  db.prepare('UPDATE guilds SET realm_status = ? WHERE id = ?').run(JSON.stringify({
    found: true, slug: 'mirage-raceway', name: REALM, up: true, queue: false, population: 'High', checkedAt: new Date(nowMs - 4 * 60000).toISOString(),
  }), gid);
  db.prepare("UPDATE coach_chars SET plan = ?, plan_level = 60, plan_at = datetime('now') WHERE guild_id = ? AND name = 'Grimtusk'").run(JSON.stringify(PLAN), gid);
  await call('POST', '/api/characters/Grimtusk/main');

  // ---- guildmates (as the sharing wave will store them) ----
  const players = {};
  const pids = {};
  const addPlayer = (battletag, payload, addonVersion = '0.11.0') => {
    // Player id: <first character>.<4 base36>, as an addon or app would make it.
    const pid = `${payload.characters[0].name}.${S.toB36(S.djb2(battletag) % 1679616).padStart(4, '0')}`;
    db.prepare('INSERT OR IGNORE INTO users (bnet_id, battletag, addon_version, app_version, last_sync_at) VALUES (?,?,?,?, datetime(\'now\', ?))')
      .run(`pid:${pid}`, battletag, addonVersion, '0.11.0', `-${Object.keys(players).length * 5 + 2} hours`);
    const id = db.prepare('SELECT id FROM users WHERE bnet_id = ?').get(`pid:${pid}`).id;
    pids[battletag] = pid;
    db.prepare("INSERT OR IGNORE INTO memberships (user_id, guild_id, role, role_source) VALUES (?,?, 'member', 'rank')").run(id, gid);
    applyPayload(db, gid, id, payload, { trustedRanks: false });
    players[battletag] = id;
    return id;
  };
  const char = (name, cls, race, level, extra = {}) => ({ name, class: cls, race, level, faction: 'Horde', realm: REALM, guild: GUILD, updated: now - 600, ...extra });
  addPlayer('Velanne#2210', {
    characters: [
      char('Velanne', 'PRIEST', 'Troll', 60, {
        zone: 'Blackrock Mountain',
        professions: [{ name: 'Tailoring', skill: 290, max: 300 }, { name: 'Enchanting', skill: 240, max: 300 }],
        recipes: { Tailoring: [{ name: 'Runecloth Bag', id: 18405 }, { name: 'Mooncloth', id: 18560 }, { name: 'Bolt of Runecloth', id: 18401 }],
          Enchanting: [{ name: 'Enchant Weapon - Crusader', id: 20034 }] },
        readiness: { ilvl: 63, durability: 95, consumables: { flask: 1, potion: 8, elixir: 4 }, at: now - 900 },
        inventory: { bags: [it(14530, 40), it(13444, 10)] },
      }),
      char('Stashwick', 'MAGE', 'Undead', 14, { inventory: { bags: [it(13468, 2)], bank: [it(14047, 400), it(12363, 6)] } }),
    ],
    shopping: [{ name: 'Runecloth Bag', qty: 4, prof: 'Tailoring', reagents: [{ id: 14047, name: 'Runecloth', qty: 5 }, { id: 8170, name: 'Rugged Leather', qty: 2 }, { id: 14341, name: 'Rune Thread', qty: 1 }] }],
  });
  addPlayer('Mokra#9031', {
    characters: [char('Mokra', 'SHAMAN', 'Tauren', 58, {
      zone: 'Winterspring',
      professions: [{ name: 'Alchemy', skill: 250, max: 300 }, { name: 'Herbalism', skill: 225, max: 300 }],
      recipes: { Alchemy: [{ name: 'Major Healing Potion', id: 17556 }, { name: 'Flask of the Titans', id: 17635 }, { name: 'Greater Fire Protection Potion', id: 17574 }] },
      readiness: { ilvl: 50.4, durability: 22, consumables: {}, at: now - 7200 },
      inventory: { bags: [it(14047, 22), it(8846, 5)] },
    })],
    shopping: [{ name: 'Major Healing Potion', qty: 10, prof: 'Alchemy', reagents: [{ id: 13465, name: 'Mountain Silversage', qty: 1 }, { id: 8925, name: 'Crystal Vial', qty: 1 }] }],
  }, '0.10.2');
  addPlayer('Tazrik#4410', { characters: [char('Tazrik', 'ROGUE', 'Troll', 35, { zone: 'Stranglethorn Vale', updated: now - 9 * 86400, readiness: { ilvl: 57.1, durability: 64, consumables: {}, at: now - 6 * 3600 } })] });
  addPlayer('Ilyra#7777', { characters: [char('Ilyra', 'MAGE', 'Undead', 19, { zone: 'The Barrens', readiness: { ilvl: 59, durability: 100, consumables: { food: 12, potion: 3 }, at: now - 1800 } })] });
  addPlayer('Hrogar#3301', { characters: [char('Hrogar', 'HUNTER', 'Orc', 60, { zone: 'Undercity', readiness: { ilvl: 58, durability: 77, consumables: { potion: 4 }, at: now - 7200 } })] });
  addPlayer('Brannoc#5120', { characters: [char('Brannoc', 'DRUID', 'Tauren', 47, { zone: 'Feralas', readiness: { ilvl: 55.5, durability: 47, consumables: { potion: 2 }, at: now - 20 * 3600 } })] });
  for (const [tag, name] of [['Velanne#2210', 'Velanne'], ['Mokra#9031', 'Mokra'], ['Tazrik#4410', 'Tazrik']]) {
    db.prepare('UPDATE characters SET is_main = 1 WHERE guild_id = ? AND user_id = ? AND name = ?').run(gid, players[tag], name);
  }
  identity.syncRanks(db, gid);
  const P = (tag) => players[tag];

  // ---- loot lists and raids ----
  await call('POST', '/api/loot/items', { instance: 'Molten Core', text: [
    'Lucifron | Felheart Gloves | 16805', 'Lucifron | Arcanist Boots | 16800', "Magmadar | Striker's Mark | 17069", 'Magmadar | Earthshaker | 17073',
    'Garr | Aurastone Hammer | 17105', 'Garr | Drillborer Disk | 17066', 'Baron Geddon | Seal of the Archmagus | 17110',
    'Ragnaros | Band of Accuria | 17063', 'Ragnaros | Onslaught Girdle | 19137', "Ragnaros | Perdition's Blade | 18816"].join('\n') });
  await call('POST', '/api/loot/items', { instance: 'Blackwing Lair', text: [
    'Razorgore the Untamed | Arcane Infused Gem | 19336', 'Broodlord Lashlayer | Lifegiving Gem | 19341',
    'Nefarian | Ashkandi, Greatsword of the Brotherhood | 19364'].join('\n') });
  const lists = (await call('GET', '/api/loot')).lists;
  const item = (name) => lists.flatMap((l) => l.items).find((i) => i.name === name).id;
  // Guildmates' sign-ups (with their reserves) for one raid, as their addons share them (su records).
  const ROLE = { tank: 't', healer: 'h', dps: 'd' };
  const STATUS = { yes: 'y', tentative: 't', no: 'n', bench: 'b' };
  const partition = sharing.partitionOf(db, identity.currentGuild(db));
  const signups = (raid, list) => {
    const key = db.prepare('SELECT share_id FROM raids WHERE id = ?').get(raid.id).share_id;
    const t = sharing.serverNow(db) - 3600;
    const recs = {};
    const via = {};
    for (const [tag, character, role, status, note, items = []] of list) {
      const reserves = items.map((name) => R.itemKeyOf(db.prepare('SELECT * FROM loot_items WHERE id = ?').get(item(name))));
      const id = `su:${key}:${pids[tag]}`;
      recs[id] = S.encode({ type: 'su', key: `${key}:${pids[tag]}`, v: S.makeVersion(t, character, false), author: character, del: false,
        fields: { character, role: ROLE[role], status: STATUS[status], note: note || '', reserves, reservesAt: reserves.length ? t : null } });
      via[id] = `${character},${t},d`;
    }
    const shared = { v: 1, guilds: { [partition]: { recs, via, sent: {}, names: {}, stats: { peers: 6, lastHello: t + 3000, lastExchange: t + 3100 } } } };
    db.transaction(() => sharing.importShared(db, core.ctx, shared, { file: { account: 'DEMO', install: 'demo' } }))();
  };

  const past = (await call('POST', '/api/raids', { title: 'Molten Core, week 1', instance: 'Molten Core', starts_at: at(2 * H - 7 * D), size: 20, sr_limit: 2, duration_min: 180 })).raid;
  await call('POST', `/api/raids/${past.id}/signup`, { character: 'Grimtusk', role: 'tank', status: 'yes' });
  signups(past, [
    ['Mokra#9031', 'Mokra', 'healer', 'yes', null, ['Band of Accuria']],
    ['Tazrik#4410', 'Tazrik', 'dps', 'yes', null, ["Perdition's Blade"]],
    ['Velanne#2210', 'Velanne', 'healer', 'yes', null, ['Band of Accuria']],
  ]);
  await call('POST', `/api/raids/${past.id}/reserves`, { item_ids: [item('Onslaught Girdle'), item('Felheart Gloves')] });
  await call('POST', `/api/raids/${past.id}/roll`, { item_id: item('Felheart Gloves') });
  await call('POST', `/api/raids/${past.id}/award`, { item_id: item('Felheart Gloves'), user_id: me, kind: 'sr' });
  await call('POST', `/api/raids/${past.id}/award`, { item_name: 'Earthshaker', user_id: P('Tazrik#4410'), kind: 'ms' });
  await call('POST', `/api/raids/${past.id}/close`, { attendee_user_ids: [me, P('Mokra#9031'), P('Tazrik#4410'), P('Velanne#2210')] });

  const mc = (await call('POST', '/api/raids', { title: 'Molten Core, week 2', instance: 'Molten Core', starts_at: at(2 * D + 3 * H), size: 20, sr_limit: 2, duration_min: 180,
    notes: 'Bring fire resistance gear. Flasks for Ragnaros.' })).raid;
  await call('POST', `/api/raids/${mc.id}/signup`, { character: 'Grimtusk', role: 'tank', status: 'yes' });
  signups(mc, [
    ['Velanne#2210', 'Velanne', 'healer', 'yes', null, ['Band of Accuria', 'Seal of the Archmagus']],
    ['Mokra#9031', 'Mokra', 'healer', 'yes', 'Might be 15 min late', ['Band of Accuria']],
    ['Tazrik#4410', 'Tazrik', 'dps', 'yes', null, ["Perdition's Blade"]],
    ['Ilyra#7777', 'Ilyra', 'dps', 'tentative', null],
    ['Brannoc#5120', 'Brannoc', 'tank', 'bench', null],
    ['Hrogar#3301', 'Hrogar', 'dps', 'no', null],
  ]);
  await call('POST', `/api/raids/${mc.id}/reserves`, { item_ids: [item('Onslaught Girdle'), item('Drillborer Disk')] });
  await call('POST', `/api/raids/${mc.id}/roll`, { item_id: item('Band of Accuria') });

  const pvp = (await call('POST', '/api/raids', { kind: 'pvp', title: 'Tarren Mill premade', instance: 'Tarren Mill', starts_at: at(4 * D - 2 * H), size: 15, duration_min: 120 })).raid;
  signups(pvp, [
    ['Tazrik#4410', 'Tazrik', 'dps', 'yes', null],
    ['Hrogar#3301', 'Hrogar', 'dps', 'yes', null],
    ['Velanne#2210', 'Velanne', 'healer', 'tentative', null],
  ]);
  await call('POST', '/api/raids', { kind: 'event', title: 'Fishing contest', instance: 'Booty Bay', starts_at: at(6 * D), duration_min: 90, notes: 'Biggest fish wins 50 gold.' });
  const bwl = (await call('POST', '/api/raids', { title: 'Blackwing Lair', instance: 'Blackwing Lair', starts_at: at(9 * D + 4 * H), size: 40, sr_limit: 1 })).raid;
  await call('POST', `/api/raids/${bwl.id}/signup`, { character: 'Grimtusk', role: 'tank', status: 'yes' });
  await call('POST', `/api/raids/${bwl.id}/lock`);
  const off = (await call('POST', '/api/raids', { kind: 'pvp', title: 'Southshore raid', instance: 'Hillsbrad Foothills', starts_at: at(1 * D) })).raid;
  await call('POST', `/api/raids/${off.id}/cancel`);

  // ---- camp: calls to arms, notices, requests, leveling partners ----
  const cta = db.prepare("INSERT INTO ctas (guild_id, user_id, character, zone, message, needed, source, created_at) VALUES (?,?,?,?,?,?, 'app', datetime('now', ?))");
  cta.run(gid, P('Velanne#2210'), 'Velanne', 'Tarren Mill', 'Alliance raid incoming from Southshore!', 10, '-25 minutes');
  cta.run(gid, P('Mokra#9031'), 'Mokra', 'Crossroads', 'Ganker camping the flight master', 5, '-70 minutes');
  db.prepare("INSERT INTO announcements (guild_id, user_id, body, created_at) VALUES (?,?,?, datetime('now', '-1 day'))")
    .run(gid, P('Velanne#2210'), 'Guild bank now has a tab for raid consumables. Ask an officer if you need flasks for Molten Core.');
  await call('POST', '/api/announcements', { body: 'Molten Core on Friday 20:00 server time. Bring fire resistance gear and potions. Sign up in Raids so we can plan the groups.' });
  const request = db.prepare("INSERT INTO craft_requests (guild_id, requester_id, item, notes, status, crafter_id) VALUES (?,?,?,?,?,?)");
  request.run(gid, P('Ilyra#7777'), 'Runecloth Bag', 'I have 5 runecloth, will mail', 'claimed', P('Velanne#2210'));
  request.run(gid, P('Velanne#2210'), 'Flask of the Titans', 'For MC on Friday. Paying 20g on top.', 'open', null);
  request.run(gid, P('Tazrik#4410'), 'Arcanite Reaper', '', 'open', null);
  request.run(gid, P('Mokra#9031'), 'Thorium Belt', 'Happy to wait', 'open', null);
  const mine = (await call('POST', '/api/requests', { item: 'Major Healing Potion', notes: 'x20 please' })).request;
  db.prepare("UPDATE craft_requests SET status = 'done', crafter_id = ?, updated_at = datetime('now') WHERE id = ?").run(P('Mokra#9031'), mine.id);
  const partner = db.prepare('INSERT INTO buddy_posts (guild_id, user_id, character, level, zone, when_text, note) VALUES (?,?,?,?,?,?,?)');
  partner.run(gid, P('Ilyra#7777'), 'Ilyra', 19, 'The Barrens', 'Tonight after 19:00', 'Doing the Wailing Caverns quests, need a tank.');
  partner.run(gid, P('Tazrik#4410'), 'Tazrik', 35, 'Stranglethorn Vale', 'Weekend', 'Nesingwary chain. Happy to group with anyone 32-38.');
  await call('POST', '/api/partners', { character: 'Shadowfen', zone: 'Desolace', when_text: 'Sunday afternoon', note: 'Centaur rep and Maraudon runs.' });

  // ---- bank characters, bank requests, supply drives ----
  await call('PUT', '/api/bank/alts', { names: ['Stashwick'] });
  const bankReq = db.prepare('INSERT INTO bank_requests (guild_id, requester_id, item, count, note, status) VALUES (?,?,?,?,?,?)');
  bankReq.run(gid, P('Tazrik#4410'), 'Thorium Bar', 20, 'Leveling blacksmithing to 275', 'open');
  bankReq.run(gid, P('Mokra#9031'), 'Greater Fire Protection Potion', 5, 'Ragnaros on Friday', 'open');
  bankReq.run(gid, P('Mokra#9031'), 'Black Lotus', 4, 'Flasks for me', 'declined');
  await call('POST', '/api/bank/requests', { item: 'Heavy Runecloth Bandage', count: 20 });
  const d1 = (await call('POST', '/api/drives', { title: 'Durotar supply crates', unit: 'crates', goal: 200, notes: 'Hand them in at the Razor Hill camp, then log them here.' })).drive;
  const d2 = (await call('POST', '/api/drives', { title: 'Fire resistance for Molten Core', unit: 'potions', goal: 60, notes: 'Greater Fire Protection Potions into the Raid consumables tab.' })).drive;
  const d3 = (await call('POST', '/api/drives', { title: 'Thorium for the guild blacksmith', unit: 'bars', goal: 400 })).drive;
  const give = db.prepare('INSERT INTO drive_contribs (drive_id, user_id, character, amount, note) VALUES (?,?,?,?,?)');
  give.run(d1.id, P('Mokra#9031'), 'Mokra', 46, '');
  give.run(d1.id, P('Velanne#2210'), 'Velanne', 30, '');
  give.run(d1.id, P('Tazrik#4410'), 'Tazrik', 12, '');
  give.run(d2.id, P('Velanne#2210'), 'Velanne', 18, '');
  give.run(d3.id, P('Mokra#9031'), 'Mokra', 120, '');
  await call('POST', `/api/drives/${d1.id}/give`, { amount: 38, character: 'Grimtusk' });
  await call('POST', `/api/drives/${d2.id}/give`, { amount: 10, character: 'Grimtusk' });
  await call('POST', `/api/drives/${d3.id}/close`);

  return { guildId: gid, me };
}

module.exports = { createDemoAuth, loadDemo, DEMO_IDENTITY };
