// Preview sample data for the raids pages (used only when the renderer runs in a plain browser without window.gc).
// Shapes match docs/api/raids.md. A small in-memory world so signing up, reserving, rolling and awarding work.
import { addMockRoutes } from '../mock.js';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const iso = (msFromNow) => new Date(Date.now() + msFromNow).toISOString();
const sqlTime = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString().replace('T', ' ').slice(0, 19);
const nowSeconds = () => Math.floor(Date.now() / 1000);

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// People in the base mock (lib/mock.js MEMBERS) and their characters.
const PEOPLE = {
  1: { battletag: 'Calvin#1234', chars: [{ name: 'Grimtusk', class: 'WARRIOR', level: 60, is_main: 1 }, { name: 'Shadowfen', class: 'WARLOCK', level: 42, is_main: 0 }] },
  2: { battletag: 'Velanne#2210', chars: [{ name: 'Velanne', class: 'PRIEST', level: 60, is_main: 1 }] },
  3: { battletag: 'Mokra#9031', chars: [{ name: 'Mokra', class: 'SHAMAN', level: 58, is_main: 1 }] },
  4: { battletag: 'Tazrik#4410', chars: [{ name: 'Tazrik', class: 'ROGUE', level: 60, is_main: 1 }] },
  5: { battletag: 'Ilyra#7777', chars: [{ name: 'Ilyra', class: 'MAGE', level: 60, is_main: 1 }] },
  6: { battletag: 'Hrogar#3301', chars: [{ name: 'Hrogar', class: 'HUNTER', level: 60, is_main: 1 }] },
  7: { battletag: 'Brannoc#5120', chars: [{ name: 'Brannoc', class: 'DRUID', level: 60, is_main: 1 }] },
  8: { battletag: 'Seraphel#8080', chars: [{ name: 'Seraphel', class: 'PRIEST', level: 60, is_main: 1 }] },
};
const charOf = (name) => {
  for (const p of Object.values(PEOPLE)) { const c = p.chars.find((x) => x.name === name); if (c) return c; }
  return null;
};
const READY = {
  Grimtusk: { ilvl: 61.4, durability: 88, consumables: { flask: 2, potion: 8, food: 20 }, at: nowSeconds() - 3 * HOUR / 1000 },
  Velanne: { ilvl: 63, durability: 95, consumables: { potion: 10, elixir: 4 }, at: nowSeconds() - 50 * MIN / 1000 },
  Mokra: { ilvl: 52.8, durability: 21, consumables: { bandage: 10 }, at: nowSeconds() - 2 * DAY / 1000 },
  Tazrik: { ilvl: 57.1, durability: 64, consumables: {}, at: nowSeconds() - 6 * HOUR / 1000 },
  Ilyra: { ilvl: 59, durability: 100, consumables: { food: 12, potion: 3 }, at: nowSeconds() - 30 * MIN / 1000 },
  Brannoc: { ilvl: 55.5, durability: 47, consumables: { potion: 2 }, at: nowSeconds() - 20 * HOUR / 1000 },
};

let nextItem = 1;
const LISTS = [];
function addItem(instance, boss, name, itemId = null) {
  const it = { id: nextItem++, guild_id: 1, instance, boss, name, item_id: itemId, wh_id: itemId };
  LISTS.push(it);
  return it;
}
[
  ['Molten Core', 'Lucifron', 'Felheart Gloves', 16805], ['Molten Core', 'Lucifron', 'Arcanist Boots', 16800],
  ['Molten Core', 'Magmadar', "Striker's Mark", 17069], ['Molten Core', 'Magmadar', 'Earthshaker', 17073],
  ['Molten Core', 'Magmadar', 'Medallion of Steadfast Might', 17065], ['Molten Core', 'Garr', 'Aurastone Hammer', 17105],
  ['Molten Core', 'Garr', 'Drillborer Disk', 17066], ['Molten Core', 'Baron Geddon', 'Seal of the Archmagus', 17110],
  ['Molten Core', 'Ragnaros', 'Band of Accuria', 17063], ['Molten Core', 'Ragnaros', 'Onslaught Girdle', 19137],
  ['Molten Core', 'Ragnaros', "Perdition's Blade", 18816], ['Molten Core', null, 'Core Leather', 17012],
  ['Blackwing Lair', 'Razorgore the Untamed', 'Arcane Infused Gem', 19336], ['Blackwing Lair', 'Vaelastrasz the Corrupt', 'Mind Quickening Gem', 19339],
  ['Blackwing Lair', 'Broodlord Lashlayer', 'Lifegiving Gem', 19341], ['Blackwing Lair', 'Nefarian', 'Ashkandi, Greatsword of the Brotherhood', 19364],
].forEach((r) => addItem(...r));
const item = (name) => LISTS.find((i) => i.name === name);

// Raids
let nextRaid = 20;
const RAIDS = [];
function addRaid(r) {
  const raid = { kind: 'raid', duration_min: 180, size: 20, sr_limit: 2, notes: null, status: 'open', reminded: 0, created_by: 2, created_at: sqlTime(3 * DAY), ...r };
  raid.signups = raid.signups || [];
  raid.reserves = raid.reserves || []; // [{ user_id, item_id }]
  raid.rolls = raid.rolls || {}; // item_id → [{ user_id, roll, bonus }]
  raid.loot = raid.loot || [];
  raid.attended = raid.attended || [];
  RAIDS.push(raid);
  return raid;
}
const LOYALTY = new Map(); // `${userId}:${itemId}` → bonus
const bonusOf = (uid, itemId) => LOYALTY.get(`${uid}:${itemId}`) || 0;
LOYALTY.set(`1:${item('Onslaught Girdle').id}`, 30);
LOYALTY.set(`3:${item('Band of Accuria').id}`, 20);
LOYALTY.set(`4:${item("Perdition's Blade").id}`, 10);
LOYALTY.set(`2:${item('Band of Accuria').id}`, 10);

const signup = (user_id, character, role, status, note = null) => ({ user_id, character, role, status, note, updated_at: sqlTime(5 * HOUR) });
addRaid({
  id: 12, title: 'Molten Core', instance: 'Molten Core', starts_at: iso(2 * DAY + 3 * HOUR), notes: 'Bring fire resistance gear. Flasks for Ragnaros.',
  signups: [
    signup(1, 'Grimtusk', 'tank', 'yes'), signup(2, 'Velanne', 'healer', 'yes'), signup(3, 'Mokra', 'healer', 'yes', 'Might be 15 min late'),
    signup(4, 'Tazrik', 'dps', 'yes'), signup(5, 'Ilyra', 'dps', 'tentative'), signup(7, 'Brannoc', 'tank', 'bench'),
    signup(6, 'Hrogar', 'dps', 'no'),
  ],
  reserves: [
    { user_id: 1, item_id: item('Onslaught Girdle').id }, { user_id: 1, item_id: item('Drillborer Disk').id },
    { user_id: 3, item_id: item('Band of Accuria').id }, { user_id: 2, item_id: item('Band of Accuria').id },
    { user_id: 4, item_id: item("Perdition's Blade").id }, { user_id: 5, item_id: item('Arcanist Boots').id },
  ],
  rolls: { [item('Band of Accuria').id]: [{ user_id: 3, roll: 44, bonus: 20 }, { user_id: 2, roll: 71, bonus: 10 }] },
  loot: [],
});
addRaid({ id: 13, kind: 'pvp', title: 'Tarren Mill premade', instance: 'Tarren Mill', starts_at: iso(4 * DAY - 2 * HOUR), size: 15, sr_limit: 0, duration_min: 120,
  signups: [signup(4, 'Tazrik', 'dps', 'yes'), signup(6, 'Hrogar', 'dps', 'yes'), signup(2, 'Velanne', 'healer', 'tentative')] });
addRaid({ id: 14, kind: 'event', title: 'Fishing contest', instance: 'Booty Bay', starts_at: iso(6 * DAY), size: null, sr_limit: 0, duration_min: 90, created_by: 1 });
addRaid({ id: 15, title: 'Blackwing Lair', instance: 'Blackwing Lair', starts_at: iso(9 * DAY + 4 * HOUR), status: 'locked', size: 40, sr_limit: 1,
  signups: [signup(1, 'Grimtusk', 'tank', 'yes'), signup(2, 'Velanne', 'healer', 'yes')] });
addRaid({ id: 9, title: 'Molten Core', instance: 'Molten Core', starts_at: iso(-5 * DAY), status: 'done',
  signups: [signup(1, 'Grimtusk', 'tank', 'yes'), signup(3, 'Mokra', 'healer', 'yes'), signup(4, 'Tazrik', 'dps', 'yes')], attended: [1, 3, 4],
  loot: [
    { id: 3, item_id: item('Earthshaker').id, item_name: 'Earthshaker', user_id: 4, character: 'Tazrik', kind: 'ms', roll: null, bonus: 0, created_at: sqlTime(5 * DAY - 2 * HOUR) },
    { id: 2, item_id: item('Felheart Gloves').id, item_name: 'Felheart Gloves', user_id: 1, character: 'Grimtusk', kind: 'sr', roll: 87, bonus: 20, created_at: sqlTime(5 * DAY - HOUR) },
  ] });
addRaid({ id: 8, kind: 'pvp', title: 'Southshore raid', instance: 'Hillsbrad Foothills', starts_at: iso(-8 * DAY), status: 'cancelled', sr_limit: 0 });
addRaid({ id: 7, title: 'Molten Core', instance: 'Molten Core', starts_at: iso(-12 * DAY), status: 'done', signups: [signup(1, 'Grimtusk', 'tank', 'yes')],
  loot: [{ id: 1, item_id: null, item_name: 'Fiery Core', user_id: 2, character: 'Velanne', kind: 'free', roll: null, bonus: 0, created_at: sqlTime(12 * DAY) }] });

// ---------- helpers ----------

const roleOf = (state) => (state.members.find((m) => m.id === state.userId) || {}).role || null;
const needGuild = (state) => { if (!state.signedIn) throw httpError(401, 'Sign in first.'); if (!state.inGuild) throw httpError(403, 'Join a guild first.'); };
const needOfficer = (state) => { needGuild(state); if (!['owner', 'officer'].includes(roleOf(state))) throw httpError(403, 'Officers only.'); };
const raidOr404 = (id) => {
  const r = RAIDS.find((x) => String(x.id) === String(id));
  if (!r) throw httpError(404, 'That raid was not found. It may have been removed.');
  return r;
};
const shortName = (bt) => String(bt || '').split('#')[0];
const battletag = (uid) => (PEOPLE[uid] || {}).battletag || `Player#${uid}`;

function raidJson(r) {
  const { signups, reserves, rolls, loot, attended, ...row } = r;
  return { ...row };
}
function countsOf(signups) {
  const c = { tank: 0, healer: 0, dps: 0, tentative: 0, bench: 0, no: 0 };
  for (const s of signups) {
    if (s.status === 'yes') c[s.role] += 1;
    else c[s.status] += 1;
  }
  return c;
}
function flagsOf(ready) {
  if (!ready) return { noData: true, lowRepair: false, noConsumables: false };
  const total = Object.values(ready.consumables || {}).reduce((a, b) => a + b, 0);
  return { noData: false, lowRepair: ready.durability != null && ready.durability < 30, noConsumables: total === 0 };
}
const ROLE_ORDER = { tank: 0, healer: 1, dps: 2 };
function signupsJson(r, me) {
  return r.signups.map((s) => {
    const c = charOf(s.character);
    const ready = READY[s.character] || null;
    return { ...s, battletag: battletag(s.user_id), name: shortName(battletag(s.user_id)), class: c ? c.class : null, level: c ? c.level : null,
      readiness: ready, flags: flagsOf(ready), mine: s.user_id === me };
  }).sort((a, b) => (ROLE_ORDER[a.role] - ROLE_ORDER[b.role]) || a.character.localeCompare(b.character));
}
const itemsFor = (instance) => LISTS.filter((i) => i.instance === instance)
  .sort((a, b) => String(a.boss ?? '').localeCompare(String(b.boss ?? '')) || a.name.localeCompare(b.name));
function boardOf(r) {
  const out = [];
  for (const it of itemsFor(r.instance)) {
    const res = r.reserves.filter((x) => x.item_id === it.id);
    if (!res.length) continue;
    out.push({
      item_id: it.id, item: it.name, boss: it.boss, wh_id: it.wh_id,
      reservers: res.map((x) => {
        const s = r.signups.find((y) => y.user_id === x.user_id);
        return { user_id: x.user_id, battletag: battletag(x.user_id), name: shortName(battletag(x.user_id)), character: s ? s.character : null,
          bonus: bonusOf(x.user_id, it.id), signup: s ? s.status : null, inRaid: !!s && (s.status === 'yes' || s.status === 'bench') };
      }).sort((a, b) => b.bonus - a.bonus),
    });
  }
  return out;
}
function rollsOf(r, itemId) {
  return (r.rolls[itemId] || []).map((x) => {
    const s = r.signups.find((y) => y.user_id === x.user_id);
    return { user_id: x.user_id, battletag: battletag(x.user_id), name: shortName(battletag(x.user_id)), character: s ? s.character : null,
      roll: x.roll, bonus: x.bonus, total: x.roll + x.bonus, created_at: sqlTime(2 * MIN) };
  }).sort((a, b) => b.total - a.total || b.roll - a.roll);
}
function myReserves(r, me) {
  return r.reserves.filter((x) => x.user_id === me).map((x) => ({ ...LISTS.find((i) => i.id === x.item_id), bonus: bonusOf(me, x.item_id) }));
}
function summary(r, me) {
  const mine = r.signups.find((s) => s.user_id === me);
  return { ...raidJson(r), counts: countsOf(r.signups), mySignup: mine ? { status: mine.status, role: mine.role, character: mine.character } : null,
    myReserves: r.reserves.filter((x) => x.user_id === me).length };
}
const withWh = (l) => ({ ...l, wh_id: l.item_id ? (LISTS.find((i) => i.id === l.item_id) || {}).wh_id ?? null : null });

addMockRoutes({
  'GET /api/raids': ({ state }) => {
    needGuild(state);
    const cutoff = Date.now() - 6 * HOUR;
    const t = (r) => new Date(r.starts_at).getTime();
    const upcoming = RAIDS.filter((r) => t(r) >= cutoff && r.status !== 'done').sort((a, b) => t(a) - t(b));
    const past = RAIDS.filter((r) => t(r) < cutoff || r.status === 'done').sort((a, b) => t(b) - t(a));
    const instances = [...new Set([...LISTS.map((i) => i.instance), ...RAIDS.map((r) => r.instance)])].sort();
    return { upcoming: upcoming.map((r) => summary(r, state.userId)), past: past.map((r) => summary(r, state.userId)), instances };
  },
  'POST /api/raids': ({ state, body = {} }) => {
    needOfficer(state);
    const kind = ['raid', 'pvp', 'event'].includes(body.kind) ? body.kind : 'raid';
    const title = String(body.title || '').trim().slice(0, 60);
    const instance = String(body.instance || '').trim().slice(0, 60);
    if (!title || !instance || !body.starts_at || Number.isNaN(Date.parse(body.starts_at))) throw httpError(400, 'Fill in the name, instance and start time.');
    const sr = Number.isFinite(Number(body.sr_limit)) && body.sr_limit !== '' ? Math.min(5, Math.max(0, Math.trunc(Number(body.sr_limit)))) : 2;
    const raid = addRaid({
      id: nextRaid++, kind, title, instance, starts_at: new Date(body.starts_at).toISOString(),
      duration_min: Number(body.duration_min) || 180, size: Math.min(40, Math.max(0, Number(body.size) || 0)) || null,
      sr_limit: kind === 'raid' ? sr : 0, notes: String(body.notes || '').trim().slice(0, 300) || null, created_by: state.userId, created_at: sqlTime(),
    });
    return { raid: raidJson(raid), message: `${{ raid: 'Raid', pvp: 'PvP', event: 'Event' }[kind]} scheduled and posted to Discord.` };
  },
  'GET /api/raids/:id': ({ params, state }) => {
    needGuild(state);
    const r = raidOr404(params.id);
    const me = state.userId;
    const signups = signupsJson(r, me);
    const items = itemsFor(r.instance).map((i) => ({ ...i, bonus: bonusOf(me, i.id), reserved: r.reserves.filter((x) => x.item_id === i.id).length,
      mine: r.reserves.some((x) => x.item_id === i.id && x.user_id === me) }));
    const creator = PEOPLE[r.created_by];
    return {
      raid: { ...raidJson(r), scheduledBy: creator ? shortName(creator.battletag) : null },
      signups,
      counts: countsOf(r.signups),
      mySignup: signups.find((s) => s.user_id === me) || null,
      myCharacters: (PEOPLE[me] || { chars: [] }).chars,
      items,
      myReserves: myReserves(r, me),
      board: boardOf(r),
      loot: r.loot.slice().sort((a, b) => a.id - b.id).map(withWh),
      attended: r.attended,
      canSignUp: r.status === 'open' || r.status === 'locked',
      canReserve: r.status === 'open' && r.kind === 'raid' && r.sr_limit > 0 && items.length > 0,
      isOfficer: ['owner', 'officer'].includes(roleOf(state)),
    };
  },
  'POST /api/raids/:id/signup': ({ params, state, body = {} }) => {
    needGuild(state);
    const r = raidOr404(params.id);
    if (r.status !== 'open' && r.status !== 'locked') throw httpError(409, 'Sign-ups are closed for this raid.');
    const character = String(body.character || '').trim().slice(0, 40);
    if (!character) throw httpError(400, 'Pick a character.');
    const role = ['tank', 'healer', 'dps'].includes(body.role) ? body.role : 'dps';
    const status = ['yes', 'tentative', 'no', 'bench'].includes(body.status) ? body.status : 'yes';
    const before = r.signups.find((s) => s.user_id === state.userId);
    r.signups = r.signups.filter((s) => s.user_id !== state.userId);
    r.signups.push(signup(state.userId, character, role, status, String(body.note || '').trim().slice(0, 120) || null));
    const mine = signupsJson(r, state.userId).find((s) => s.user_id === state.userId);
    return { ok: true, signup: mine, counts: countsOf(r.signups), message: status === 'no' ? 'Marked as can’t make it.' : before ? 'Sign-up updated.' : 'You’re signed up.' };
  },
  'POST /api/raids/:id/reserves': ({ params, state, body = {} }) => {
    needGuild(state);
    const r = raidOr404(params.id);
    if (r.status !== 'open') throw httpError(409, 'Reserves are locked for this raid.');
    const ids = [...new Set((body.item_ids || []).map(Number).filter(Boolean))];
    if (ids.length > r.sr_limit) throw httpError(400, `You can reserve up to ${r.sr_limit} item${r.sr_limit === 1 ? '' : 's'}.`);
    const valid = new Set(itemsFor(r.instance).map((i) => i.id));
    if (ids.some((id) => !valid.has(id))) throw httpError(400, 'That item isn’t on this raid’s loot list.');
    r.reserves = r.reserves.filter((x) => x.user_id !== state.userId).concat(ids.map((item_id) => ({ user_id: state.userId, item_id })));
    return { ok: true, myReserves: myReserves(r, state.userId), message: ids.length ? 'Reserves saved.' : 'Reserves cleared.' };
  },
  'POST /api/raids/:id/lock': ({ params, state }) => {
    needOfficer(state);
    const r = raidOr404(params.id);
    if (r.status !== 'open') throw httpError(409, 'Only raids with open reserves can be locked.');
    r.status = 'locked';
    return { ok: true, raid: raidJson(r), message: 'Reserves locked.' };
  },
  'POST /api/raids/:id/unlock': ({ params, state }) => {
    needOfficer(state);
    const r = raidOr404(params.id);
    if (r.status !== 'locked') throw httpError(409, 'Reserves aren’t locked for this raid.');
    r.status = 'open';
    return { ok: true, raid: raidJson(r), message: 'Reserves reopened.' };
  },
  'POST /api/raids/:id/cancel': ({ params, state }) => {
    needOfficer(state);
    const r = raidOr404(params.id);
    if (r.status !== 'open' && r.status !== 'locked') throw httpError(409, 'Only upcoming raids can be cancelled.');
    r.status = 'cancelled';
    return { ok: true, raid: raidJson(r), message: `${{ raid: 'Raid', pvp: 'PvP', event: 'Event' }[r.kind]} cancelled.` };
  },
  'POST /api/raids/:id/close': ({ params, state, body = {} }) => {
    needOfficer(state);
    const r = raidOr404(params.id);
    if (r.status === 'done') throw httpError(409, 'This raid is already closed.');
    if (r.status === 'cancelled') throw httpError(409, 'Cancelled raids can’t be closed.');
    const attended = [...new Set((body.attendee_user_ids || []).map(Number).filter(Boolean))];
    const items = itemsFor(r.instance).map((i) => i.id);
    for (const uid of attended) {
      const mine = new Set(r.reserves.filter((x) => x.user_id === uid).map((x) => x.item_id));
      for (const id of items) {
        if (mine.has(id)) LOYALTY.set(`${uid}:${id}`, bonusOf(uid, id) + 10);
        else LOYALTY.delete(`${uid}:${id}`);
      }
    }
    const noShows = r.signups.filter((s) => s.status === 'yes' && !attended.includes(s.user_id));
    for (const s of noShows) for (const id of items) LOYALTY.delete(`${s.user_id}:${id}`);
    r.attended = attended;
    r.status = 'done';
    return { ok: true, raid: raidJson(r), attended: attended.length, noShows: noShows.length,
      message: `Raid closed. ${attended.length} attended${noShows.length ? `, ${noShows.length} no-show${noShows.length === 1 ? '' : 's'}` : ''}. Bonuses updated.` };
  },
  'GET /api/raids/:id/loot': ({ params, state }) => {
    needOfficer(state);
    const r = raidOr404(params.id);
    return {
      raid: raidJson(r),
      board: boardOf(r).map((b) => ({ ...b, rolls: rollsOf(r, b.item_id) })),
      items: itemsFor(r.instance),
      attending: r.signups.filter((s) => s.status === 'yes' || s.status === 'bench')
        .map((s) => ({ user_id: s.user_id, character: s.character, role: s.role, status: s.status, class: (charOf(s.character) || {}).class || null }))
        .sort((a, b) => a.character.localeCompare(b.character)),
      awarded: r.loot.slice().sort((a, b) => b.id - a.id).map(withWh),
    };
  },
  'POST /api/raids/:id/roll': ({ params, state, body = {} }) => {
    needOfficer(state);
    const r = raidOr404(params.id);
    const it = LISTS.find((i) => i.id === Number(body.item_id));
    if (!it) throw httpError(404, 'That item isn’t on this raid’s loot list.');
    const inRaid = r.reserves.filter((x) => x.item_id === it.id).filter((x) => {
      const s = r.signups.find((y) => y.user_id === x.user_id);
      return s && (s.status === 'yes' || s.status === 'bench');
    });
    r.rolls[it.id] = inRaid.map((x) => ({ user_id: x.user_id, roll: 1 + Math.floor(Math.random() * 100), bonus: bonusOf(x.user_id, it.id) }));
    const rolls = rollsOf(r, it.id);
    const top = rolls[0];
    return { item_id: it.id, rolls, message: top ? `${top.character || top.name} has the highest roll for ${it.name}: ${top.roll}${top.bonus ? ` + ${top.bonus}` : ''} = ${top.total}.`
      : `Nobody in the raid reserved ${it.name}. Give it as main spec, off spec or a free roll.` };
  },
  'POST /api/raids/:id/award': ({ params, state, body = {} }) => {
    needOfficer(state);
    const r = raidOr404(params.id);
    if (r.status === 'cancelled') throw httpError(409, 'This raid was cancelled.');
    const kind = ['sr', 'ms', 'os', 'free'].includes(body.kind) ? body.kind : 'ms';
    let userId = Number(body.user_id) || null;
    let character = String(body.character || '').trim() || null;
    if (userId) {
      const s = r.signups.find((x) => x.user_id === userId);
      character = s ? s.character : ((PEOPLE[userId] || {}).chars || [])[0]?.name || shortName(battletag(userId));
    } else if (character) {
      const s = r.signups.find((x) => x.character.toLowerCase() === character.toLowerCase());
      if (s) { userId = s.user_id; character = s.character; }
    }
    if (!userId && !character) throw httpError(400, 'Pick who gets it.');
    let it = body.item_id ? LISTS.find((i) => i.id === Number(body.item_id)) : null;
    const typed = String(body.item_name || '').trim();
    if (!it && typed) it = itemsFor(r.instance).find((i) => i.name.toLowerCase() === typed.toLowerCase()) || null;
    const name = it ? it.name : typed;
    if (!name) throw httpError(400, 'Pick an item.');
    const roll = it && userId ? (r.rolls[it.id] || []).find((x) => x.user_id === userId) : null;
    const award = { id: Math.max(0, ...RAIDS.flatMap((x) => x.loot.map((l) => l.id))) + 1, guild_id: 1, raid_id: r.id, item_id: it ? it.id : null, item_name: name,
      user_id: userId, character, kind, roll: roll ? roll.roll : null, bonus: roll ? roll.bonus : 0, created_at: sqlTime() };
    r.loot.push(award);
    if (it && userId) {
      LOYALTY.delete(`${userId}:${it.id}`);
      r.reserves = r.reserves.filter((x) => !(x.user_id === userId && x.item_id === it.id));
      delete r.rolls[it.id];
    }
    return { ok: true, award: withWh(award), message: `${name} given to ${character || 'them'}.` };
  },
  'GET /api/loot': ({ state }) => {
    needGuild(state);
    const instances = [...new Set(LISTS.map((i) => i.instance))].sort();
    const history = RAIDS.flatMap((r) => r.loot.map((l) => ({ ...withWh(l), title: r.title, raid_kind: r.kind }))).sort((a, b) => b.id - a.id).slice(0, 100);
    const myLoyalty = [...LOYALTY].filter(([k, v]) => k.startsWith(`${state.userId}:`) && v > 0).map(([k, bonus]) => {
      const it = LISTS.find((i) => i.id === Number(k.split(':')[1]));
      return it ? { item_id: it.id, name: it.name, instance: it.instance, boss: it.boss, wh_id: it.wh_id, bonus } : null;
    }).filter(Boolean).sort((a, b) => b.bonus - a.bonus);
    return { lists: instances.map((instance) => ({ instance, items: itemsFor(instance) })), history, myLoyalty };
  },
  'POST /api/loot/items': ({ state, body = {} }) => {
    needOfficer(state);
    const instance = String(body.instance || '').trim().slice(0, 60);
    if (!instance) throw httpError(400, 'Name the instance.');
    const text = String(body.text || '');
    if (!text.trim()) throw httpError(400, 'Paste at least one item, one per line.');
    let added = 0;
    for (const line of text.split(/\r?\n/)) {
      let parts = line.split('|').map((s) => s.trim()).filter(Boolean);
      if (!parts.length) continue;
      let itemId = null;
      const m = /item=(\d+)/.exec(parts[parts.length - 1]) || /^(\d{2,7})$/.exec(parts[parts.length - 1]);
      if (m && parts.length > 1) { itemId = Number(m[1]); parts = parts.slice(0, -1); }
      const [boss, name] = parts.length > 1 ? [parts[0], parts.slice(1).join(' | ')] : [null, parts[0]];
      const existing = LISTS.find((i) => i.instance === instance && i.name === name);
      if (existing) { existing.boss = boss || existing.boss; existing.item_id = itemId || existing.item_id; existing.wh_id = existing.item_id; continue; }
      addItem(instance, boss, name, itemId);
      added += 1;
    }
    return { added, instance, items: itemsFor(instance), message: `${added} item${added === 1 ? '' : 's'} added to ${instance}.` };
  },
  'DELETE /api/loot/items/:id': ({ params, state }) => {
    needOfficer(state);
    const i = LISTS.findIndex((x) => String(x.id) === params.id);
    if (i < 0) throw httpError(404, 'That item isn’t on a loot list any more.');
    const [it] = LISTS.splice(i, 1);
    for (const r of RAIDS) r.reserves = r.reserves.filter((x) => x.item_id !== it.id);
    return { ok: true, message: `${it.name} removed.` };
  },
});
