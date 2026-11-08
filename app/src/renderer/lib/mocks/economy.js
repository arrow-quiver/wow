// Preview sample data for the economy pages (Bank, Prices, Drives). Used only when the renderer runs in a plain
// browser without window.gc. Shapes match docs/api/economy.md (the local core's routes/economy.js).
import { addMockRoutes, httpError, needGuild, needOfficer } from '../mock.js';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString();
const sqlTime = (msAgo = 0) => iso(msAgo).replace('T', ' ').slice(0, 19);
const dayStr = (daysAgo) => iso(daysAgo * DAY).slice(0, 10);
const short = (tag) => String(tag || '').split('#')[0];

const ITEMS = {
  14047: 'Runecloth', 12359: 'Thorium Bar', 12363: 'Arcane Crystal', 13444: 'Major Mana Potion', 13446: 'Major Healing Potion',
  13457: 'Greater Fire Protection Potion', 13452: 'Elixir of the Mongoose', 13510: 'Flask of the Titans', 13468: 'Black Lotus',
  14530: 'Heavy Runecloth Bandage', 7068: 'Elemental Fire', 12808: 'Essence of Undeath', 12811: 'Righteous Orb', 14342: 'Mooncloth',
  14344: 'Large Brilliant Shard', 11370: 'Dark Iron Ore', 4338: 'Mageweave Cloth', 8170: 'Rugged Leather', 13463: 'Dreamfoil',
  13466: 'Plaguebloom', 13465: 'Mountain Silversage', 8846: 'Gromsblood', 2589: 'Linen Cloth',
};
// Rough auction prices in copper; items without one show "no price".
const PRICE = {
  14047: 118, 12359: 2650, 12363: 41000, 13444: 4200, 13446: 2300, 13457: 9800, 13452: 31000, 13510: 412000, 13468: 690000,
  14530: 1850, 7068: 6100, 12808: 19500, 12811: 8900, 14342: 52000, 14344: 15500, 4338: 95, 8170: 1350, 13463: 3200,
  13466: 3900, 13465: 4400, 8846: 2100,
};

// A deterministic wobbly 14-day price history ending at the current price.
function history(id) {
  const base = PRICE[id];
  if (!base) return [];
  let seed = id;
  const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
  const drift = (rnd() - 0.5) * 0.5; // up to ±25% over two weeks
  const out = [];
  for (let d = 13; d >= 0; d--) {
    if (d > 0 && rnd() < 0.2) continue; // nobody scanned that day
    const p = Math.round(base * (1 - drift * (d / 13)) * (0.94 + rnd() * 0.12));
    out.push({ day: dayStr(d), price: d === 0 ? base : Math.max(1, p) });
  }
  return out;
}

function change(h) {
  if (h.length < 2 || !h[0].price) return null;
  return Math.round(((h[h.length - 1].price - h[0].price) / h[0].price) * 1000) / 10;
}

const priced = (id, count) => {
  const unit = PRICE[id] ?? null;
  return { item_id: Number(id), name: ITEMS[id] || null, count, unit, value: unit != null ? unit * count : null };
};
const byName = (a, b) => String(a.name || '').localeCompare(String(b.name || ''));
const sum = (items) => items.reduce((t, x) => t + (x.value || 0), 0);

const db = {
  money: 18_734_215,
  scanned_at: iso(3 * HOUR + 12 * MIN),
  tabs: [
    { name: 'Raid consumables', items: [[13444, 40], [13446, 60], [13457, 24], [13452, 8], [13510, 2], [14530, 120]] },
    { name: 'Mats', items: [[14047, 860], [12359, 140], [12363, 12], [7068, 35], [12808, 18], [12811, 6], [14342, 9], [14344, 22], [11370, 30]] },
    { name: 'Herbs', items: [[13468, 3], [13463, 44], [13466, 26], [13465, 31], [8846, 18]] },
    { name: 'Leveling gear', items: [[4338, 300], [8170, 80], [2589, 140]] },
  ],
  bankCharacters: [
    { name: 'Stashwick', class: 'MAGE', level: 14, owner: 'Velanne', updated_at: iso(5 * HOUR), items: [[13468, 2], [14047, 400], [12363, 6], [99001, 3]] },
    { name: 'Coinpurse', class: 'ROGUE', level: 8, owner: 'Calvin', updated_at: iso(2 * DAY), items: [] },
  ],
  candidates: [
    { name: 'Coinpurse', class: 'ROGUE', level: 8, owner: 'Calvin', items: 0 },
    { name: 'Grimtusk', class: 'WARRIOR', level: 60, owner: 'Calvin', items: 64 },
    { name: 'Mokra', class: 'SHAMAN', level: 58, owner: 'Mokra', items: 51 },
    { name: 'Shadowfen', class: 'WARLOCK', level: 42, owner: 'Calvin', items: 38 },
    { name: 'Stashwick', class: 'MAGE', level: 14, owner: 'Velanne', items: 4 },
    { name: 'Tazrik', class: 'ROGUE', level: 35, owner: 'Tazrik', items: 22 },
    { name: 'Velanne', class: 'PRIEST', level: 60, owner: 'Velanne', items: 47 },
  ],
  requests: [
    { id: 41, item: 'Greater Fire Protection Potion', count: 5, note: 'Ragnaros on Friday', status: 'open', requester_id: 3, requester_tag: 'Mokra#9031', handled_by: null, handler_tag: null, created_at: sqlTime(40 * MIN), updated_at: sqlTime(40 * MIN) },
    { id: 40, item: 'Heavy Runecloth Bandage', count: 20, note: '', status: 'open', requester_id: 1, requester_tag: 'Calvin#1234', handled_by: null, handler_tag: null, created_at: sqlTime(5 * HOUR), updated_at: sqlTime(5 * HOUR) },
    { id: 38, item: 'Thorium Bar', count: 20, note: 'Leveling blacksmithing to 275', status: 'sent', requester_id: 4, requester_tag: 'Tazrik#4410', handled_by: 2, handler_tag: 'Velanne#2210', created_at: sqlTime(2 * DAY), updated_at: sqlTime(1 * DAY) },
    { id: 36, item: 'Black Lotus', count: 4, note: 'Flasks for me', status: 'declined', requester_id: 3, requester_tag: 'Mokra#9031', handled_by: 1, handler_tag: 'Calvin#1234', created_at: sqlTime(4 * DAY), updated_at: sqlTime(3 * DAY) },
  ],
  log: [
    { id: 90, kind: 'deposit', who: 'Mokra', item_id: 14047, count: 120, amount: null, at: iso(2 * HOUR) },
    { id: 89, kind: 'withdraw', who: 'Velanne', item_id: 13457, count: 5, amount: null, at: iso(3 * HOUR) },
    { id: 88, kind: 'deposit', who: 'Grimtusk', item_id: null, count: null, amount: 1_500_000, at: iso(5 * HOUR) },
    { id: 87, kind: 'repair', who: 'Velanne', item_id: null, count: null, amount: 84_211, at: iso(9 * HOUR) },
    { id: 86, kind: 'move', who: 'Calvin', item_id: 13468, count: 3, amount: null, at: iso(1 * DAY) },
    { id: 85, kind: 'withdraw', who: 'Tazrik', item_id: 12359, count: 20, amount: null, at: iso(1 * DAY + 3 * HOUR) },
    { id: 84, kind: 'deposit', who: 'Ilyra', item_id: 4338, count: 60, amount: null, at: iso(2 * DAY) },
    { id: 83, kind: 'withdraw', who: 'Grimtusk', item_id: null, count: null, amount: 250_000, at: iso(3 * DAY) },
  ],
  myItems: [
    { character: 'Grimtusk', class: 'WARRIOR', location: 'bags', item_id: 14047, count: 34 },
    { character: 'Shadowfen', class: 'WARLOCK', location: 'bank', item_id: 14047, count: 160 },
    { character: 'Grimtusk', class: 'WARRIOR', location: 'bags', item_id: 13446, count: 6 },
    { character: 'Shadowfen', class: 'WARLOCK', location: 'bank', item_id: 4338, count: 220 },
    { character: 'Grimtusk', class: 'WARRIOR', location: 'bank', item_id: 12359, count: 12 },
    { character: 'Shadowfen', class: 'WARLOCK', location: 'bags', item_id: 13444, count: 4 },
  ],
  drives: [
    { id: 7, title: 'Durotar supply crates', unit: 'crates', goal: 200, notes: 'Hand them in at the Razor Hill camp, then log them here.', status: 'open', created_by: 2, creator_tag: 'Velanne#2210', created_at: sqlTime(3 * DAY),
      gifts: [['Mokra', 3, 46], ['Grimtusk', 1, 38], ['Velanne', 2, 30], ['Tazrik', 4, 12], ['Shadowfen', 1, 9]] },
    { id: 6, title: 'Fire resistance for Molten Core', unit: 'potions', goal: 60, notes: 'Greater Fire Protection Potions into the Raid consumables tab.', status: 'open', created_by: 1, creator_tag: 'Calvin#1234', created_at: sqlTime(6 * DAY),
      gifts: [['Velanne', 2, 18], ['Mokra', 3, 10]] },
    { id: 5, title: 'Guild bank tab 5', unit: 'gold', goal: 500, notes: '', status: 'done', created_by: 1, creator_tag: 'Calvin#1234', created_at: sqlTime(20 * DAY),
      gifts: [['Grimtusk', 1, 220], ['Velanne', 2, 180], ['Mokra', 3, 75], ['Tazrik', 4, 40]] },
    { id: 4, title: 'Thorium for the guild blacksmith', unit: 'bars', goal: 400, notes: '', status: 'closed', created_by: 2, creator_tag: 'Velanne#2210', created_at: sqlTime(34 * DAY),
      gifts: [['Mokra', 3, 120], ['Shadowfen', 1, 40]] },
  ],
};

const meOf = (state) => state.members.find((m) => m.id === state.userId) || null;

const requestJson = (r, state) => ({
  id: r.id, item: r.item, count: r.count, note: r.note || null, status: r.status, requester_id: r.requester_id,
  requester: short(r.requester_tag), handled_by: r.handled_by, handler: r.handler_tag ? short(r.handler_tag) : null,
  created_at: r.created_at, updated_at: r.updated_at, mine: r.requester_id === state.userId,
});

function stock() {
  const tabs = db.tabs.map((t) => {
    const items = t.items.map(([id, n]) => priced(id, n)).sort(byName);
    return { name: t.name, items, value: sum(items) };
  });
  const bankCharacters = db.bankCharacters.map((c) => {
    const items = c.items.map(([id, n]) => priced(id, n)).sort(byName);
    return { name: c.name, class: c.class, level: c.level, owner: c.owner, updated_at: c.updated_at, items, value: sum(items) };
  });
  const all = [
    ...tabs.flatMap((t) => t.items.map((x) => ({ ...x, tab: t.name, character: null }))),
    ...bankCharacters.flatMap((c) => c.items.map((x) => ({ ...x, tab: null, character: c.name }))),
  ];
  const value = { guildBank: sum(tabs), bankCharacters: sum(bankCharacters), total: sum(tabs) + sum(bankCharacters) };
  return { tabs, bankCharacters, value, all };
}

function driveJson(d, state) {
  const total = d.gifts.reduce((t, g) => t + g[2], 0);
  const me = meOf(state);
  const board = new Map();
  for (const [who, , amount] of d.gifts) board.set(who, (board.get(who) || 0) + amount);
  return {
    id: d.id, title: d.title, unit: d.unit, goal: d.goal, notes: d.notes || null, status: d.status, created_by: d.created_by,
    creator: short(d.creator_tag), created_at: d.created_at, total, pct: Math.min(100, Math.round((total / d.goal) * 100)),
    contributors: new Set(d.gifts.map((g) => g[1])).size,
    mine: d.gifts.filter((g) => g[1] === me?.id).reduce((t, g) => t + g[2], 0),
    leaderboard: [...board].map(([who, amount]) => ({ who, amount })).sort((a, b) => b.amount - a.amount).slice(0, 10),
  };
}

const priceRow = (id, extra = {}) => {
  const h = history(id);
  return { item_id: Number(id), name: ITEMS[id] || null, ...extra, latest: h[h.length - 1] || null, history: h, change: change(h) };
};

addMockRoutes({
  'GET /api/bank': ({ state }) => {
    needGuild(state);
    const s = stock();
    const requests = db.requests.filter((r) => r.status !== 'cancelled')
      .sort((a, b) => (a.status === 'open') === (b.status === 'open') ? b.id - a.id : a.status === 'open' ? -1 : 1);
    return {
      money: db.money, scanned_at: db.scanned_at, tabs: s.tabs, bankCharacters: s.bankCharacters, value: s.value,
      requests: requests.map((r) => requestJson(r, state)),
      log: db.log.map((l) => ({ ...l, name: l.item_id ? ITEMS[l.item_id] || null : null })),
    };
  },
  'GET /api/bank/search': ({ query, state }) => {
    needGuild(state);
    const q = String(query.q || '').trim().slice(0, 60);
    if (!q) return { q: '', results: [] };
    const results = db.myItems.map((r) => ({ ...r, name: ITEMS[r.item_id] }))
      .filter((r) => r.name && r.name.toLowerCase().includes(q.toLowerCase()))
      .sort((a, b) => byName(a, b) || a.character.localeCompare(b.character));
    return { q, results };
  },
  'POST /api/bank/requests': ({ body, state }) => {
    needGuild(state);
    const item = String(body?.item || '').trim().slice(0, 100);
    if (!item) throw httpError(400, 'Name the item you need.');
    const count = Math.min(1000, Math.max(1, Math.trunc(Number(body?.count)) || 1));
    const me = meOf(state);
    const r = {
      id: Math.max(...db.requests.map((x) => x.id), 0) + 1, item, count, note: String(body?.note || '').trim().slice(0, 200), status: 'open',
      requester_id: me.id, requester_tag: me.battletag, handled_by: null, handler_tag: null, created_at: sqlTime(), updated_at: sqlTime(),
    };
    db.requests.unshift(r);
    return { ok: true, request: requestJson(r, state), message: 'Request sent to the officers.' };
  },
  'POST /api/bank/requests/:id/:verb': ({ params, state }) => {
    needGuild(state);
    const r = db.requests.find((x) => x.id === Number(params.id));
    if (!r || !['sent', 'declined', 'cancel'].includes(params.verb)) throw httpError(404, 'Request not found.');
    if (r.status !== 'open') throw httpError(409, 'That request has already been handled.');
    if (params.verb === 'cancel' && r.requester_id !== state.userId) throw httpError(403, 'Only the person who asked can cancel a request.');
    if (params.verb !== 'cancel') needOfficer(state);
    const me = meOf(state);
    Object.assign(r, { status: params.verb === 'cancel' ? 'cancelled' : params.verb, handled_by: me.id, handler_tag: me.battletag, updated_at: sqlTime() });
    const message = params.verb === 'sent' ? 'Marked as sent.' : params.verb === 'declined' ? 'Request declined.' : 'Request cancelled.';
    return { ok: true, request: requestJson(r, state), message };
  },
  'GET /api/bank/alts': ({ state }) => {
    needOfficer(state);
    const marked = new Set(db.bankCharacters.map((c) => c.name));
    return {
      characters: db.candidates.map((c) => ({ ...c, is_bank: marked.has(c.name) ? 1 : 0 }))
        .sort((a, b) => b.is_bank - a.is_bank || a.name.localeCompare(b.name)),
    };
  },
  'PUT /api/bank/alts': ({ body, state }) => {
    needOfficer(state);
    if (!Array.isArray(body?.names)) throw httpError(400, 'Send the bank characters as a list of names.');
    const wanted = body.names.map((n) => db.candidates.find((c) => c.name.toLowerCase() === String(n).toLowerCase()));
    const missing = body.names.find((n, i) => !wanted[i]);
    if (missing) throw httpError(400, `There is no character called ${missing} in the guild.`);
    const before = new Set(db.bankCharacters.map((c) => c.name));
    const after = new Set(wanted.map((c) => c.name));
    const added = [...after].filter((n) => !before.has(n));
    const removed = [...before].filter((n) => !after.has(n));
    db.bankCharacters = [...after].sort().map((n) => db.bankCharacters.find((c) => c.name === n)
      || { ...db.candidates.find((c) => c.name === n), updated_at: iso(), items: [] });
    let message = 'No changes.';
    if (added.length === 1 && !removed.length) message = `${added[0]} is now a bank character. Its bags and bank show here after its next sync.`;
    else if (removed.length === 1 && !added.length) message = `${removed[0]} is no longer a bank character.`;
    else if (added.length || removed.length) message = 'Bank characters saved. New ones show their bags and bank after their next sync.';
    return { ok: true, bankCharacters: db.bankCharacters.map((c) => c.name), added, removed, message };
  },

  'GET /api/prices': ({ query, state }) => {
    needGuild(state);
    const q = String(query.q || '').trim().slice(0, 60);
    const s = stock();
    const ids = Object.keys(PRICE);
    const results = !q ? [] : /^\d+$/.test(q)
      ? ids.filter((id) => id === q).map((id) => priceRow(id))
      : ids.filter((id) => ITEMS[id].toLowerCase().includes(q.toLowerCase())).map((id) => priceRow(id)).sort(byName);
    const held = q ? [] : ids.map((id, i) => priceRow(id, { holders: ((Number(id) * 7) % 11) + (i < 6 ? 6 : 1) }))
      .sort((a, b) => b.holders - a.holders || byName(a, b)).slice(0, 30);
    return {
      q,
      stats: { items: 812, newest: dayStr(0) },
      results,
      held,
      bank: {
        ...s.value,
        priced: s.all.filter((x) => x.unit != null).length,
        unpriced: s.all.filter((x) => x.unit == null).length,
        top: s.all.filter((x) => x.value).sort((a, b) => b.value - a.value).slice(0, 5),
      },
    };
  },

  'GET /api/drives': ({ state }) => {
    needGuild(state);
    return {
      open: db.drives.filter((d) => d.status === 'open').map((d) => driveJson(d, state)),
      past: db.drives.filter((d) => d.status !== 'open').map((d) => driveJson(d, state)),
      myCharacters: state.userId === 1 ? ['Grimtusk', 'Shadowfen'] : state.userId === 2 ? ['Velanne'] : ['Mokra'],
    };
  },
  'POST /api/drives': ({ body, state }) => {
    needOfficer(state);
    const title = String(body?.title || '').trim().slice(0, 80);
    const unit = String(body?.unit || '').trim().slice(0, 40);
    const goal = Math.trunc(Number(body?.goal));
    if (!title || !unit || !(goal >= 1)) throw httpError(400, 'Give the drive a name, what you’re collecting, and a goal.');
    const me = meOf(state);
    const d = {
      id: Math.max(...db.drives.map((x) => x.id), 0) + 1, title, unit, goal: Math.min(1e7, goal), notes: String(body?.notes || '').trim().slice(0, 300),
      status: 'open', created_by: me.id, creator_tag: me.battletag, created_at: sqlTime(), gifts: [],
    };
    db.drives.unshift(d);
    return { ok: true, drive: driveJson(d, state), message: 'Drive started.' };
  },
  'POST /api/drives/:id/give': ({ params, body, state }) => {
    needGuild(state);
    const d = db.drives.find((x) => x.id === Number(params.id));
    if (!d) throw httpError(404, 'Drive not found.');
    if (d.status !== 'open') throw httpError(409, 'That drive has finished.');
    const amount = Math.trunc(Number(body?.amount));
    if (!(amount >= 1)) throw httpError(400, 'How many did you hand in?');
    const me = meOf(state);
    d.gifts.push([String(body?.character || '').trim().slice(0, 40) || short(me.battletag), me.id, Math.min(1e6, amount)]);
    const reached = driveJson(d, state).total >= d.goal;
    if (reached) d.status = 'done';
    return { ok: true, reached, drive: driveJson(d, state), message: reached ? 'Goal reached. Thank you!' : `Logged ${amount.toLocaleString('en')} ${d.unit}.` };
  },
  'POST /api/drives/:id/close': ({ params, state }) => {
    needOfficer(state);
    const d = db.drives.find((x) => x.id === Number(params.id));
    if (!d) throw httpError(404, 'Drive not found.');
    if (d.status === 'open') d.status = 'closed';
    return { ok: true, drive: driveJson(d, state), message: 'Drive closed.' };
  },
});
