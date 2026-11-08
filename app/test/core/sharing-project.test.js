'use strict';
// Shared records → domain rows (docs/SHARING.md §10 mapping): every record type becomes the rows the pages
// read, rows keep their ids when a newer version arrives, tombstones remove them, and the result is the same
// whatever order the records arrived in (raids, requests, drives, loyalty: every order, or a sample of them
// unless GUILDCAMP_SIM_HEAVY=1).
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../../src/shared/sharing');
const sharing = require('../../src/core/sharing');
const { setupShare, lightDb, rec, permutations, NOW, D, PIDS, ME_PID } = require('./sharing-helpers');

const HEAVY = process.env.GUILDCAMP_SIM_HEAVY === '1';
const MC = 'Molten Core';
const IK = S.instanceKey(MC);
const CLOAK = S.itemKey(17102);
const GIRDLE = S.itemKey(19137);
const HELM = S.itemKey('Helm of Wrath');
const ch = (name, pid, opts = {}) => rec('ch', name, opts.t || NOW - 3000, name, { pid, alts: opts.alts || [name], main: opts.main, battletag: opts.battletag, class: opts.cls || 'MAGE', level: opts.level || 60, ...opts.extra });
const CHS = Object.entries(PIDS).map(([n, p]) => ch(n, p));
const LL = rec('LL', IK, NOW - 5000, 'Grommash', {
  name: MC, bosses: ['Lucifron', 'Magmadar'],
  items: [{ item: CLOAK, boss: 1, name: 'Cloak of the Shrouded Mists' }, { item: GIRDLE, boss: 2, name: 'Onslaught Girdle' }, { item: HELM, boss: 0, name: 'Helm of Wrath' }],
});

function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// All orders in heavy mode, else a seeded sample (always including the given order and its reverse).
function orders(list, sample) {
  const all = permutations(list);
  if (HEAVY || all.length <= sample) return all;
  const rng = prng(list.length * 7919);
  const out = [all[0], all[all.length - 1]];
  while (out.length < sample) out.push(all[Math.floor(rng() * all.length)]);
  return out;
}

test.before(() => sharing.setClock(() => NOW * 1000));
test.after(() => sharing.setClock());

// ------------------------------------------------------------------------------------------ raids
const RAID = 'k3f9a2';
const RD = rec('RD', RAID, NOW - 4000, 'Grommash', { kind: 'r', title: 'Molten Core Thursday', instance: MC, startsAt: NOW + 2 * D, minutes: 200, size: 40, srLimit: 2, notes: 'Bring fire resist' });
const SU_Z = rec('su', `${RAID}:${PIDS.Zuljinne}`, NOW - 3000, 'Zuljinne', { character: 'Zuljinne', role: 'h', status: 'y', note: 'late 10 min', reserves: [CLOAK, GIRDLE], reservesAt: NOW - 3000 });
// Jaina changed her reserve after the lock: the earlier one counts.
const SU_J = rec('su', `${RAID}:${PIDS.Jaina}`, NOW - 1000, 'Jaina', { character: 'Jaina', role: 'd', status: 't', reserves: [HELM], reservesAt: NOW - 1000, prev: [GIRDLE], prevAt: NOW - 2500 });
const RT_L = rec('RT', RAID, NOW - 2000, 'Varok', { status: 'l', lockedAt: NOW - 2000 });

// The loot log by record keys: which raid and which list item each award points at.
const lootLog = (db) => db.prepare(`SELECT l.share_id, r.share_id AS raid, li.name AS item FROM loot_log l
  LEFT JOIN raids r ON r.id = l.raid_id LEFT JOIN loot_items li ON li.id = l.item_id ORDER BY l.share_id`).all().map((x) => ({ ...x }));

function raidSnapshot(db, gid) {
  const raid = db.prepare('SELECT id, title, instance, starts_at, duration_min, size, sr_limit, notes, kind, status, locked_at, share_id FROM raids WHERE guild_id = ? AND share_id = ?').get(gid, RAID);
  if (!raid) return null;
  const { id, ...rest } = raid;
  return {
    raid: rest,
    signups: db.prepare(`SELECT u.battletag AS who, s.character, s.role, s.status, s.note, s.reserves_at FROM signups s JOIN users u ON u.id = s.user_id
      WHERE s.raid_id = ? ORDER BY who`).all(id),
    reserves: db.prepare(`SELECT u.battletag AS who, li.name FROM reserves r JOIN users u ON u.id = r.user_id JOIN loot_items li ON li.id = r.item_id
      WHERE r.raid_id = ? ORDER BY who, li.name`).all(id),
  };
}

test('a raid: RD + RT + sign-ups + loot list become the raid, its sign-ups and the reserves that count', () => {
  const h = lightDb();
  try {
    h.imp([...CHS, LL, RD, SU_Z, SU_J, RT_L]);
    const snap = raidSnapshot(h.db, h.gid);
    assert.deepEqual(snap.raid, {
      title: 'Molten Core Thursday', instance: MC, starts_at: new Date((NOW + 2 * D) * 1000).toISOString(), duration_min: 200, size: 40, sr_limit: 2,
      notes: 'Bring fire resist', kind: 'raid', status: 'locked', locked_at: NOW - 2000, share_id: RAID,
    });
    assert.deepEqual(snap.signups.map((s) => [s.who, s.character, s.role, s.status, s.note]), [
      ['Jaina', 'Jaina', 'dps', 'tentative', null], ['Zuljinne', 'Zuljinne', 'healer', 'yes', 'late 10 min'],
    ]);
    assert.deepEqual(snap.reserves.map((r) => [r.who, r.name]), [
      ['Jaina', 'Onslaught Girdle'], // the list before the lock
      ['Zuljinne', 'Cloak of the Shrouded Mists'], ['Zuljinne', 'Onslaught Girdle'],
    ]);
    assert.deepEqual(h.db.prepare('SELECT name, boss, item_id, item_key FROM loot_items WHERE guild_id = ? ORDER BY name').all(h.gid), [
      { name: 'Cloak of the Shrouded Mists', boss: 'Lucifron', item_id: 17102, item_key: CLOAK },
      { name: 'Helm of Wrath', boss: null, item_id: null, item_key: HELM },
      { name: 'Onslaught Girdle', boss: 'Magmadar', item_id: 19137, item_key: GIRDLE },
    ]);
    const id = h.db.prepare('SELECT id FROM raids WHERE share_id = ?').get(RAID).id;
    // Unlocked again: the newest reserves count. Same row.
    h.imp([rec('RT', RAID, NOW - 500, 'Varok', { status: 'o' })]);
    const after = raidSnapshot(h.db, h.gid);
    assert.equal(after.raid.status, 'open');
    assert.equal(after.raid.locked_at, null);
    assert.deepEqual(after.reserves.filter((r) => r.who === 'Jaina').map((r) => r.name), ['Helm of Wrath']);
    assert.equal(h.db.prepare('SELECT id FROM raids WHERE share_id = ?').get(RAID).id, id, 'the raid keeps its id');
    // Cancelled (final): a later lock never undoes it.
    h.imp([rec('RT', RAID, NOW - 400, 'Grommash', { status: 'x' }, { final: true })]);
    h.imp([rec('RT', RAID, NOW - 100, 'Varok', { status: 'l', lockedAt: NOW - 100 })]);
    assert.equal(raidSnapshot(h.db, h.gid).raid.status, 'cancelled');
  } finally { h.close(); }
});

test('raids: the same rows whatever order the records arrive in', () => {
  const bundles = [CHS, [LL], [RD], [SU_Z], [SU_J], [RT_L]];
  const h0 = lightDb();
  h0.imp(bundles.flat());
  const want = raidSnapshot(h0.db, h0.gid);
  h0.close();
  assert.ok(want && want.reserves.length === 3);
  for (const order of orders(bundles, 40)) {
    const h = lightDb();
    try {
      for (const b of order) h.imp(b);
      assert.deepEqual(raidSnapshot(h.db, h.gid), want, `order ${order.map((b) => S.parse(b[0]).type).join(',')}`);
    } finally { h.close(); }
  }
});

test('a raid close: attendance from the snapshot, loot awards, and loyalty folded the same in every order', () => {
  const RAID2 = 'm2m2m2';
  const RD2 = rec('RD', RAID2, NOW - 20 * D, 'Grommash', { kind: 'r', title: 'MC week 1', instance: MC, startsAt: NOW - 19 * D, minutes: 180, size: 40, srLimit: 2 });
  const close1 = rec('RT', RAID2, NOW - 19 * D, 'Grommash', {
    status: 'd', lockedAt: NOW - 19 * D - 600, kind: 'r', instance: IK, closedAt: NOW - 19 * D,
    attendees: [{ pid: PIDS.Zuljinne, items: [CLOAK, GIRDLE] }, { pid: PIDS.Jaina, items: [GIRDLE] }], noShows: [PIDS.Varok],
  }, { final: true });
  const award1 = rec('LA', 'a1a1a1', NOW - 19 * D - 300, 'Grommash', { raid: RAID2, instance: IK, item: GIRDLE, itemName: 'Onslaught Girdle', character: 'Jaina', pid: PIDS.Jaina, kind: 's', roll: 77, bonus: 0 });
  const close2 = rec('RT', RAID, NOW - 2 * D, 'Varok', {
    status: 'd', lockedAt: NOW - 2 * D - 600, kind: 'r', instance: IK, closedAt: NOW - 2 * D,
    attendees: [{ pid: PIDS.Zuljinne, items: [CLOAK] }, { pid: PIDS.Jaina, items: [HELM] }], noShows: [],
  }, { final: true });
  const award2 = rec('LA', 'a2a2a2', NOW - 2 * D + 60, 'Varok', { raid: RAID, instance: IK, item: CLOAK, itemName: 'Cloak of the Shrouded Mists', character: 'Zuljinne', pid: PIDS.Zuljinne, kind: 's', roll: 12, bonus: 20 });
  const all = [...CHS, LL, RD, RD2, close1, award1, close2, award2];
  const fold = S.loyaltyFold(IK, [close1, award1, close2, award2]);
  const loyalty = (db) => db.prepare(`SELECT u.battletag AS who, li.name, l.bonus FROM loyalty l JOIN users u ON u.id = l.user_id JOIN loot_items li ON li.id = l.item_id
    ORDER BY who, li.name`).all();
  const expected = [];
  for (const [pid, items] of Object.entries(fold.bonuses)) {
    for (const [key, bonus] of Object.entries(items)) expected.push({ who: pid.split('.')[0], key, bonus });
  }
  assert.ok(expected.length > 0);

  const h0 = lightDb();
  h0.imp(all);
  const want = loyalty(h0.db);
  const names = Object.fromEntries(h0.db.prepare('SELECT item_key, name FROM loot_items').all().map((r) => [r.item_key, r.name]));
  assert.deepEqual(want, expected.map((e) => ({ who: e.who, name: names[e.key], bonus: e.bonus })).sort((a, b) => (a.who < b.who ? -1 : a.who > b.who ? 1 : a.name < b.name ? -1 : 1)));
  // Attendance and the loot log.
  const r1 = h0.db.prepare('SELECT id, status FROM raids WHERE share_id = ?').get(RAID2);
  assert.equal(r1.status, 'done');
  assert.deepEqual(h0.db.prepare('SELECT u.battletag FROM attendance a JOIN users u ON u.id = a.user_id WHERE a.raid_id = ? ORDER BY 1').all(r1.id).map((r) => r.battletag), ['Jaina', 'Zuljinne']);
  assert.deepEqual(h0.db.prepare('SELECT item_name, character, kind, roll, bonus, raid_id, share_id FROM loot_log ORDER BY created_at').all().map((r) => ({ ...r })), [
    { item_name: 'Onslaught Girdle', character: 'Jaina', kind: 'sr', roll: 77, bonus: 0, raid_id: r1.id, share_id: 'a1a1a1' },
    { item_name: 'Cloak of the Shrouded Mists', character: 'Zuljinne', kind: 'sr', roll: 12, bonus: 20, raid_id: h0.db.prepare('SELECT id FROM raids WHERE share_id = ?').get(RAID).id, share_id: 'a2a2a2' },
  ]);
  const wantLog = lootLog(h0.db);
  assert.deepEqual(wantLog.map((r) => [r.share_id, r.raid, r.item]), [['a1a1a1', RAID2, 'Onslaught Girdle'], ['a2a2a2', RAID, 'Cloak of the Shrouded Mists']]);
  h0.close();

  const bundles = [CHS, [LL, RD, RD2], [close1], [award1], [close2], [award2]];
  for (const order of orders(bundles, 30)) {
    const h = lightDb();
    try {
      for (const b of order) h.imp(b);
      assert.deepEqual(loyalty(h.db), want);
      assert.deepEqual(lootLog(h.db), wantLog, 'awards point at their raid and item whatever came first');
    } finally { h.close(); }
  }

  // An LY checkpoint folding the first close gives the same loyalty.
  const ly = rec('LY', IK, NOW - D, 'Grommash', S.loyaltyCheckpoint(IK, [close1, award1], NOW - 10 * D));
  const h = lightDb();
  try {
    h.imp([...all, ly]);
    assert.deepEqual(loyalty(h.db), want);
  } finally { h.close(); }
});

test('a loot award imported before its raid and loot list finds them when they arrive in a later upload (raid page and loot history), and finds its item again after a list edit remakes it', async (t) => {
  const h = await setupShare(t, { role: 'member' });
  const LA = rec('LA', 'a2a2a2', NOW - 2 * 3600, 'Varok', { raid: RAID, instance: IK, item: CLOAK, itemName: 'Cloak of the Shrouded Mists', character: 'Zuljinne', pid: PIDS.Zuljinne, kind: 's', roll: 12, bonus: 20 });
  h.imp(CHS);
  h.imp([LA]); // the store had filled the award's bucket first
  assert.deepEqual(lootLog(h.db), [{ share_id: 'a2a2a2', raid: null, item: null }]);
  h.imp([LL]);
  assert.deepEqual(lootLog(h.db), [{ share_id: 'a2a2a2', raid: null, item: 'Cloak of the Shrouded Mists' }], 'the list alone gives it its item');
  h.imp([RD]);
  assert.deepEqual(lootLog(h.db), [{ share_id: 'a2a2a2', raid: RAID, item: 'Cloak of the Shrouded Mists' }]);
  const raid = h.db.prepare('SELECT id FROM raids WHERE share_id = ?').get(RAID);
  const page = (await h.srv.api.get(`/api/raids/${raid.id}`)).body;
  assert.deepEqual(page.loot.map((l) => [l.item_name, l.character, l.wh_id]), [['Cloak of the Shrouded Mists', 'Zuljinne', 17102]]);
  assert.equal((await h.srv.api.get('/api/loot')).body.history[0].title, 'Molten Core Thursday');

  // The list drops the cloak, then has it again (a new row): the award follows.
  const fields = S.decode(LL).fields;
  h.imp([rec('LL', IK, NOW - 600, 'Grommash', { ...fields, items: fields.items.filter((i) => i.item !== CLOAK) })]);
  assert.deepEqual(lootLog(h.db), [{ share_id: 'a2a2a2', raid: RAID, item: null }]);
  h.imp([rec('LL', IK, NOW - 300, 'Grommash', fields)]);
  assert.deepEqual(lootLog(h.db), [{ share_id: 'a2a2a2', raid: RAID, item: 'Cloak of the Shrouded Mists' }]);

  // The raid removed and scheduled again (a new row): the award follows too.
  h.imp([rec('RD', RAID, NOW - 200, 'Grommash', null, { del: true })]);
  assert.deepEqual(lootLog(h.db), [{ share_id: 'a2a2a2', raid: null, item: 'Cloak of the Shrouded Mists' }]);
  h.imp([rec('RD', RAID, NOW - 100, 'Grommash', S.decode(RD).fields)]);
  assert.deepEqual(lootLog(h.db), [{ share_id: 'a2a2a2', raid: RAID, item: 'Cloak of the Shrouded Mists' }]);
});

// ------------------------------------------------------------------------------------------ requests
test('crafting requests and claims: status and crafter derived, same in every order; tombstone removes', () => {
  const CR = rec('cr', 'r1r1r1', NOW - 900, 'Zuljinne', { pid: PIDS.Zuljinne, item: 'Robe of Power', notes: 'mats in mail', state: 'o' });
  const CL_J = rec('cl', `r1r1r1:${PIDS.Jaina}`, NOW - 800, 'Jaina', { state: 'c', claimedAt: NOW - 800 });
  const CL_V = rec('cl', `r1r1r1:${PIDS.Varok}`, NOW - 700, 'Varok', { state: 'd', claimedAt: NOW - 700 });
  const snap = (db) => db.prepare(`SELECT cr.item, cr.notes, cr.status, r.battletag AS requester, c.battletag AS crafter, cr.share_id FROM craft_requests cr
    JOIN users r ON r.id = cr.requester_id LEFT JOIN users c ON c.id = cr.crafter_id`).all();
  // Jaina claimed first, so she is the crafter; Varok's later "done" does not make it done.
  const want = [{ item: 'Robe of Power', notes: 'mats in mail', status: 'claimed', requester: 'Zuljinne', crafter: 'Jaina', share_id: 'r1r1r1' }];
  for (const order of orders([CHS, [CR], [CL_J], [CL_V]], 24)) {
    const h = lightDb();
    try {
      for (const b of order) h.imp(b);
      assert.deepEqual(snap(h.db), want);
    } finally { h.close(); }
  }
  const h = lightDb();
  try {
    h.imp([...CHS, CR, CL_J]);
    assert.equal(snap(h.db)[0].status, 'claimed');
    h.imp([rec('cl', `r1r1r1:${PIDS.Jaina}`, NOW - 600, 'Jaina', { state: 'd', claimedAt: NOW - 800 })]);
    assert.equal(snap(h.db)[0].status, 'done', 'the claimer marked it done');
    const id = h.db.prepare('SELECT id FROM craft_requests').get().id;
    h.imp([rec('cr', 'r1r1r1', NOW - 100, 'Zuljinne', { pid: PIDS.Zuljinne, item: 'Robe of Power', state: 'x' }, { final: true })]);
    assert.deepEqual([h.db.prepare('SELECT id, status FROM craft_requests').get()].map((r) => ({ ...r })), [{ id, status: 'cancelled' }], 'a cancelled request is cancelled (§4.4), same row');
    h.imp([rec('cr', 'r2r2r2', NOW - 100, 'Zuljinne', { pid: PIDS.Zuljinne, item: 'Gloves', state: 'o' })]);
    h.imp([rec('cr', 'r2r2r2', NOW - 50, 'Zuljinne', null, { del: true })]);
    assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM craft_requests WHERE share_id = 'r2r2r2'").get().n, 0);
  } finally { h.close(); }
});

test('bank requests: the earlier of a cancel and an officer answer wins, in every order', () => {
  const BQ = rec('bq', 'b1b1b1', NOW - 900, 'Zuljinne', { pid: PIDS.Zuljinne, item: 'Runecloth', count: 20, note: 'for bags', state: 'o' });
  const BH = rec('BH', 'b1b1b1', NOW - 800, 'Varok', { state: 's' });
  const X = rec('bq', 'b1b1b1', NOW - 700, 'Zuljinne', { pid: PIDS.Zuljinne, item: 'Runecloth', count: 20, note: 'for bags', state: 'x' }, { final: true });
  const snap = (db) => db.prepare(`SELECT b.item, b.count, b.note, b.status, r.battletag AS requester, hb.battletag AS handler FROM bank_requests b
    JOIN users r ON r.id = b.requester_id LEFT JOIN users hb ON hb.id = b.handled_by`).all().map((r) => ({ ...r }));
  for (const order of orders([CHS, [BQ], [BH], [X]], 24)) {
    const h = lightDb();
    try {
      for (const b of order) h.imp(b);
      assert.deepEqual(snap(h.db), [{ item: 'Runecloth', count: 20, note: 'for bags', status: 'sent', requester: 'Zuljinne', handler: 'Varok' }]);
    } finally { h.close(); }
  }
});

test('supply drives and hand-ins: total, goal reached and closed, in every order; a removed hand-in leaves', () => {
  const DRV = rec('DR', 'd1d1d1', NOW - 900, 'Varok', { title: 'Flasks for Naxx', unit: 'flasks', goal: 10, notes: 'any kind', state: 'o' });
  const DC1 = rec('dc', 'c1c1c1', NOW - 800, 'Zuljinne', { pid: PIDS.Zuljinne, drive: 'd1d1d1', character: 'Zuljinne', amount: 6, note: 'here' });
  const DC2 = rec('dc', 'c2c2c2', NOW - 700, 'Jaina', { pid: PIDS.Jaina, drive: 'd1d1d1', character: 'Jaina', amount: 5 });
  const snap = (db) => ({
    drive: db.prepare('SELECT title, unit, goal, notes, status, share_id FROM drives').all().map((r) => ({ ...r })),
    contribs: db.prepare('SELECT u.battletag AS who, dc.amount, dc.character, dc.share_id FROM drive_contribs dc JOIN users u ON u.id = dc.user_id ORDER BY who').all().map((r) => ({ ...r })),
  });
  const want = {
    drive: [{ title: 'Flasks for Naxx', unit: 'flasks', goal: 10, notes: 'any kind', status: 'done', share_id: 'd1d1d1' }],
    contribs: [{ who: 'Jaina', amount: 5, character: 'Jaina', share_id: 'c2c2c2' }, { who: 'Zuljinne', amount: 6, character: 'Zuljinne', share_id: 'c1c1c1' }],
  };
  for (const order of orders([CHS, [DRV], [DC1], [DC2]], 24)) {
    const h = lightDb();
    try {
      for (const b of order) h.imp(b);
      assert.deepEqual(snap(h.db), want);
    } finally { h.close(); }
  }
  const h = lightDb();
  try {
    h.imp([...CHS, DRV, DC1, DC2]);
    h.imp([rec('dc', 'c2c2c2', NOW - 600, 'Jaina', null, { del: true })]);
    assert.deepEqual(snap(h.db).contribs.map((c) => c.who), ['Zuljinne']);
    assert.equal(snap(h.db).drive[0].status, 'open');
    h.imp([rec('DR', 'd1d1d1', NOW - 500, 'Varok', { title: 'Flasks for Naxx', unit: 'flasks', goal: 10, state: 'c' }, { final: true })]);
    assert.equal(snap(h.db).drive[0].status, 'closed');
  } finally { h.close(); }
});

// ------------------------------------------------------------------------------------------ the rest
test('players and characters: links, BattleTag, main, class, readiness, professions; nobody takes my character', () => {
  const h = lightDb();
  try {
    h.imp([
      ch('Zuljinne', PIDS.Zuljinne, { alts: ['Zuljinne', 'Zulalt'], battletag: 'Zul#1234', main: true, extra: { race: 'Troll', faction: 'Horde', ilvl: 61, repair: 80, consumables: { flask: 2, potion: 5 }, professions: [{ skill: 164, rank: 225, max: 300 }], pvp: { rank: 7, hk: 900 }, addon: '0.12.0' } }),
      ch('Zulalt', PIDS.Zuljinne),
      ch('Jaina', PIDS.Jaina),
      ch('Thrallia', PIDS.Jaina), // a forged claim on my character
    ]);
    const u = h.db.prepare('SELECT id, battletag, addon_version FROM users WHERE bnet_id = ?').get(`pid:${PIDS.Zuljinne}`);
    assert.deepEqual({ ...u, id: 0 }, { id: 0, battletag: 'Zul#1234', addon_version: '0.12.0' });
    const chars = (uid) => h.db.prepare('SELECT name FROM characters WHERE user_id = ? ORDER BY name').all(uid).map((r) => r.name);
    assert.deepEqual(chars(u.id), ['Zulalt', 'Zuljinne'], 'the anchor lists its alt');
    assert.ok(chars(h.me).includes('Thrallia'), 'my character stays mine');
    const z = h.db.prepare("SELECT * FROM characters WHERE name = 'Zuljinne'").get();
    assert.deepEqual([z.class, z.race, z.level, z.faction, z.is_main], ['MAGE', 'Troll', 60, 'Horde', 1]);
    assert.deepEqual(JSON.parse(z.readiness), { ilvl: 61, durability: 80, consumables: { flask: 2, potion: 5 }, at: NOW - 3000 });
    assert.deepEqual(JSON.parse(z.extras), { pvp: { rank: 7, hk: 900 }, addonVersion: '0.12.0' });
    assert.deepEqual(h.db.prepare('SELECT name, skill, max_skill FROM professions WHERE character_id = ?').all(z.id).map((r) => ({ ...r })), [{ name: 'Blacksmithing', skill: 225, max_skill: 300 }]);
    assert.ok(h.db.prepare('SELECT 1 FROM memberships WHERE user_id = ? AND guild_id = ?').get(u.id, h.gid), 'a guildmate is a member');

    // A character the anchor does not list stays unlinked; listing it later links it.
    h.imp([ch('Relayer', PIDS.Zuljinne)]);
    assert.deepEqual(chars(u.id), ['Zulalt', 'Zuljinne']);
    h.imp([ch('Zuljinne', PIDS.Zuljinne, { t: NOW - 100, alts: ['Zuljinne', 'Zulalt', 'Relayer'], battletag: 'Zul#1234' })]);
    assert.deepEqual(chars(u.id), ['Relayer', 'Zulalt', 'Zuljinne']);
    // Dropped from the list: unlinked. The anchor's ch gone (tombstone): the last valid links stay.
    h.imp([ch('Zuljinne', PIDS.Zuljinne, { t: NOW - 50, alts: ['Zuljinne', 'Zulalt'] })]);
    assert.deepEqual(chars(u.id), ['Zulalt', 'Zuljinne']);
    h.imp([rec('ch', 'Zuljinne', NOW - 10, 'Zuljinne', null, { del: true })]);
    assert.deepEqual(chars(u.id), ['Zulalt', 'Zuljinne']);
    // Roles follow ranks: Varok (rank 1) is an officer once his ch makes him a player.
    h.imp([ch('Varok', PIDS.Varok)]);
    const v = h.db.prepare('SELECT m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.bnet_id = ?').get(`pid:${PIDS.Varok}`);
    assert.equal(v.role, 'officer');
  } finally { h.close(); }
});

test('recipes by spell and item id get their names (also when the names arrive later); names lists stay as typed', () => {
  const h = lightDb();
  try {
    h.imp([...CHS, rec('rc', `Zuljinne:${S.toB36(164)}`, NOW - 100, 'Zuljinne', { kind: 's', count: 2, list: [2660, 3115] }),
      rec('rc', `Jaina:${S.toB36(197)}`, NOW - 100, 'Jaina', { kind: 'n', count: 2, list: ['Bolt of Linen Cloth', 'Linen Belt'] })]);
    const recipes = () => h.db.prepare('SELECT c.name AS who, r.profession, r.recipe_id, r.name FROM recipes r JOIN characters c ON c.id = r.character_id ORDER BY who, r.name').all().map((r) => ({ ...r }));
    assert.deepEqual(recipes(), [
      { who: 'Jaina', profession: 'Tailoring', recipe_id: null, name: 'Bolt of Linen Cloth' },
      { who: 'Jaina', profession: 'Tailoring', recipe_id: null, name: 'Linen Belt' },
      { who: 'Zuljinne', profession: 'Blacksmithing', recipe_id: 2660, name: 'Recipe 2660' },
      { who: 'Zuljinne', profession: 'Blacksmithing', recipe_id: 3115, name: 'Recipe 3115' },
    ]);
    // The addon learned the names: the recipes are named now.
    const r = h.db.transaction(() => sharing.importShared(h.db, h.ctx, { guilds: { 'Forever/wow': { recs: {}, names: { s: { 2660: 'Rough Sharpening Stone', 3115: 'Heavy Copper Maul' } } } } }))();
    assert.equal(r.imported, 0);
    assert.deepEqual(recipes().filter((x) => x.who === 'Zuljinne').map((x) => x.name), ['Heavy Copper Maul', 'Rough Sharpening Stone']);
    assert.equal(h.db.prepare('SELECT name FROM spell_names WHERE spell_id = 2660').get().name, 'Rough Sharpening Stone');
  } finally { h.close(); }
});

test('partner posts, calls to arms, notices: rows by key; tombstones close or remove them', () => {
  const h = lightDb();
  try {
    const LP = rec('lp', `${PIDS.Jaina}:Jaina`, NOW - 300, 'Jaina', { character: 'Jaina', level: 22, zone: 'The Barrens', when: 'evenings', note: 'questing' });
    const CA = rec('ca', 'x8k2pq', NOW - 60, 'Zuljinne', { character: 'Zuljinne', zone: 'Crossroads', needed: 5, message: 'Alliance at the flight master' });
    const AN = rec('AN', 'q2w8zz', NOW - 120, 'Grommash', { body: 'Raid on Friday; bring fire resist ~ thanks' });
    h.imp([...CHS, LP, CA, AN]);
    assert.deepEqual({ ...h.db.prepare('SELECT character, level, zone, when_text, note, active, share_id FROM buddy_posts').get() },
      { character: 'Jaina', level: 22, zone: 'The Barrens', when_text: 'evenings', note: 'questing', active: 1, share_id: `${PIDS.Jaina}:Jaina` });
    assert.deepEqual({ ...h.db.prepare('SELECT u.battletag AS who, c.character, c.zone, c.needed, c.message, c.client_ref, c.source FROM ctas c JOIN users u ON u.id = c.user_id').get() },
      { who: 'Zuljinne', character: 'Zuljinne', zone: 'Crossroads', needed: 5, message: 'Alliance at the flight master', client_ref: 'x8k2pq', source: 'addon' });
    assert.deepEqual({ ...h.db.prepare('SELECT u.battletag AS who, a.body FROM announcements a JOIN users u ON u.id = a.user_id').get() },
      { who: 'Grommash', body: 'Raid on Friday; bring fire resist ~ thanks' });
    h.imp([rec('lp', `${PIDS.Jaina}:Jaina`, NOW - 30, 'Jaina', null, { del: true }), rec('AN', 'q2w8zz', NOW - 20, 'Varok', null, { del: true })]);
    assert.equal(h.db.prepare('SELECT active FROM buddy_posts').get().active, 0);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM announcements').get().n, 0);
    // A post by a character nobody linked yet still shows who wrote it; the link moves it to the player.
    h.imp([rec('AN', 'n2n2n2', NOW - 10, 'Stranger', { body: 'hello' })]);
    const who = () => h.db.prepare("SELECT u.bnet_id FROM announcements a JOIN users u ON u.id = a.user_id WHERE a.share_id = 'n2n2n2'").get().bnet_id;
    assert.equal(who(), 'char:Stranger');
    h.imp([ch('Stranger', 'Stranger.s000')]);
    assert.equal(who(), 'pid:Stranger.s000');
  } finally { h.close(); }
});

test('guild bank, bank characters and their stock, shopping lists, prices, guild settings, unknown types', () => {
  const h = lightDb({ role: 'member' });
  try {
    h.imp([...CHS,
      rec('gb', '0', NOW - 100, 'Jaina', { scannedAt: NOW - 120, money: 1234567, tabs: ['Mats', 'Gear'], log: [{ at: NOW - 3600, kind: 'deposit', who: 'Jaina', item: 2589, count: 20 }] }),
      rec('gb', '1', NOW - 100, 'Jaina', { items: [{ id: 2589, count: 20 }, { id: 2592, count: 5 }] }),
      rec('gb', '2', NOW - 100, 'Jaina', { items: [{ id: 2589, count: 1 }] }),
      rec('BC', '1', NOW - 200, 'Varok', { names: ['Bankalt'] }),
      rec('bk', 'Bankalt', NOW - 100, 'Bankalt', { bags: [{ id: 14047, count: 40 }], bank: [{ id: 2592, count: 60 }] }),
      rec('sh', PIDS.Jaina, NOW - 100, 'Jaina', { items: [{ name: 'Linen Belt', qty: 2, skill: 197 }] }),
      rec('pr', PIDS.Jaina, NOW - 100, 'Jaina', { day: 2500, prices: [{ id: 2589, copper: 120 }, { id: 2592, copper: 300 }] }),
      rec('pr', PIDS.Zuljinne, NOW - 90, 'Zuljinne', { day: 2500, prices: [{ id: 2589, copper: 100 }] }),
      rec('CFG', '1', NOW - 100, 'Grommash', { officerRankMax: 3, relayRankMax: 3 }),
      `zz:anything^${S.makeVersion(NOW - 60, 'Jaina')}^Jaina^^1^2`,
    ]);
    assert.deepEqual({ ...h.db.prepare('SELECT bank_money, bank_scanned_at FROM guilds WHERE id = ?').get(h.gid) }, { bank_money: 1234567, bank_scanned_at: new Date((NOW - 120) * 1000).toISOString() });
    assert.deepEqual(h.db.prepare('SELECT tab, item_id, count FROM guild_bank ORDER BY tab, item_id').all().map((r) => ({ ...r })),
      [{ tab: 'Gear', item_id: 2589, count: 1 }, { tab: 'Mats', item_id: 2589, count: 20 }, { tab: 'Mats', item_id: 2592, count: 5 }]);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM bank_log').get().n, 1);
    assert.equal(h.db.prepare("SELECT is_bank FROM characters WHERE name = 'Bankalt'").get().is_bank, 1);
    assert.deepEqual(h.db.prepare("SELECT location, item_id, count FROM inventory i JOIN characters c ON c.id = i.character_id WHERE c.name = 'Bankalt' ORDER BY location").all().map((r) => ({ ...r })),
      [{ location: 'bags', item_id: 14047, count: 40 }, { location: 'bank', item_id: 2592, count: 60 }]);
    const shop = h.db.prepare('SELECT items FROM shopping_lists s JOIN users u ON u.id = s.user_id WHERE u.bnet_id = ?').get(`pid:${PIDS.Jaina}`);
    assert.deepEqual(JSON.parse(shop.items), [{ name: 'Linen Belt', qty: 2, prof: 'Tailoring', reagents: [] }]);
    assert.deepEqual(h.db.prepare('SELECT item_id, day, price FROM prices ORDER BY item_id').all().map((r) => ({ ...r })),
      [{ item_id: 2589, day: '2026-11-05', price: 100 }, { item_id: 2592, day: '2026-11-05', price: 300 }], 'the lower price for the same item and day');
    const g = h.db.prepare('SELECT officer_rank_max, relay_rank_max FROM guilds WHERE id = ?').get(h.gid);
    assert.deepEqual({ ...g }, { officer_rank_max: 3, relay_rank_max: 3 });
    const role = h.db.prepare('SELECT m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.bnet_id = ?').get(`pid:${PIDS.Jaina}`).role;
    assert.equal(role, 'officer', 'rank 3 is an officer rank now');
    assert.equal(h.db.prepare("SELECT state FROM shared_records WHERE id = 'zz:anything'").get().state, 'ok', 'unknown types are kept');
    // Bank characters list changed: no longer a bank character.
    h.imp([rec('BC', '1', NOW - 50, 'Varok', { names: [] })]);
    assert.equal(h.db.prepare("SELECT is_bank FROM characters WHERE name = 'Bankalt'").get().is_bank, 0);
  } finally { h.close(); }
});

test('my own records never overwrite what my uploads wrote (characters, recipes, shopping list, prices)', () => {
  const h = lightDb();
  try {
    h.db.prepare("UPDATE characters SET level = 23, class = 'SHAMAN' WHERE name = 'Thrallia'").run();
    h.imp([
      rec('ch', 'Thrallia', NOW - 100, 'Thrallia', { pid: ME_PID, alts: ['Thrallia'], class: 'WARRIOR', level: 1 }),
      rec('rc', `Thrallia:${S.toB36(164)}`, NOW - 100, 'Thrallia', { kind: 'n', count: 1, list: ['Nope'] }),
      rec('pr', ME_PID, NOW - 100, 'Thrallia', { day: 2500, prices: [{ id: 2589, copper: 1 }] }),
    ], { via: {} });
    const t = h.db.prepare("SELECT user_id, level, class FROM characters WHERE name = 'Thrallia'").get();
    assert.deepEqual([t.user_id, t.level, t.class], [h.me, 23, 'SHAMAN']);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM recipes').get().n, 0);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM prices').get().n, 0);
  } finally { h.close(); }
});

test('raids page data through the API: the projected raid shows like any other', async (t) => {
  const h = await setupShare(t, { role: 'member' });
  h.imp([...CHS, LL, RD, SU_Z, RT_L]);
  const list = await h.srv.api.get('/api/raids');
  assert.equal(list.status, 200);
  const raid = list.body.upcoming.find((r) => r.title === 'Molten Core Thursday');
  assert.ok(raid);
  assert.equal(raid.status, 'locked');
  const one = await h.srv.api.get(`/api/raids/${raid.id}`);
  assert.equal(one.status, 200);
});
