'use strict';
// Derived state from shared records (docs/SHARING.md §4.4): pure functions in app/src/shared/sharing.js.
// The SR+ loyalty fold must give exactly what the old server gave: fixtures from its raid tests
// (test/fixtures/sharing-vectors.json "fold"), and a differential test that replays random raid weeks
// through the real old services (app/src/core/services/raids.js closeRaid/awardItem on a fresh
// in-memory database) and through loyaltyFold, and compares the bonuses.
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../src/shared/sharing');
const { loadVectors } = require('./fixtures/sharing-lua');

const V = loadVectors();
const NOW = 1794067200;
const D = 86400;
const HEAVY = process.env.GUILDCAMP_SIM_HEAVY === '1';

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
function shuffle(list, rng) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
const rec = (type, key, t, author, fields, opts = {}) => S.encode({ type, key, v: S.makeVersion(t, author, !!opts.final), author, del: !!opts.del, fields });

// ------------------------------------------------------------------------------------------ raid status
test('raid status comes from RT; open when there is none', () => {
  assert.deepEqual(S.raidStatus(null), { status: 'open', lockedAt: null, closedAt: null, kind: '', instance: '' });
  assert.equal(S.raidStatus(rec('RT', 'k3f9a2', NOW, 'Grommash', { status: 'l', lockedAt: NOW })).status, 'locked');
  assert.equal(S.raidStatus(rec('RT', 'k3f9a2', NOW, 'Grommash', { status: 'l', lockedAt: NOW })).lockedAt, NOW);
  assert.equal(S.raidStatus(rec('RT', 'k3f9a2', NOW, 'Grommash', { status: 'o' })).status, 'open');
  assert.equal(S.raidStatus(rec('RT', 'k3f9a2', NOW, 'Grommash', { status: 'x' }, { final: true })).status, 'cancelled');
  const done = S.raidStatus(rec('RT', 'k3f9a2', NOW, 'Grommash', { status: 'd', kind: 'r', instance: 'abc123', lockedAt: NOW - 60 }, { final: true }));
  assert.deepEqual(done, { status: 'done', lockedAt: NOW - 60, closedAt: NOW, kind: 'r', instance: 'abc123' });
  // The spec example decodes to a close.
  assert.equal(S.raidStatus(V.records.find((r) => r.name === 'spec RT close example').record).status, 'done');
});

test('reserves that count at a close follow the lock time', () => {
  const su = (reserves, reservesAt, prev, prevAt) => rec('su', 'k3f9a2:Thrallia.p4m7', NOW, 'Thrallia', { character: 'Thrallia', role: 'd', status: 'y', reserves, reservesAt, prev, prevAt });
  const LOCK = NOW - 100;
  assert.deepEqual(S.countingReserves(su(['a1'], NOW - 50, ['b2'], NOW - 500), null), ['a1'], 'never locked: the current list');
  assert.deepEqual(S.countingReserves(su(['a1'], NOW - 200, ['b2'], NOW - 500), LOCK), ['a1'], 'chosen before the lock');
  assert.deepEqual(S.countingReserves(su(['a1'], NOW - 50, ['b2'], NOW - 500), LOCK), ['b2'], 'changed after the lock: the previous list');
  assert.deepEqual(S.countingReserves(su(['a1'], LOCK, ['b2'], NOW - 500), LOCK), ['a1'], 'at the lock time counts');
  assert.deepEqual(S.countingReserves(su(['a1'], NOW - 50, ['b2'], NOW - 60), LOCK), [], 'both after the lock: none');
  assert.deepEqual(S.countingReserves(su(['a1'], NOW - 50, [], null), LOCK), [], 'no previous list');
  assert.deepEqual(S.countingReserves(null, LOCK), []);
  assert.deepEqual(S.countingReserves(rec('su', 'k3f9a2:Thrallia.p4m7', NOW, 'Thrallia', null, { del: true }), LOCK), []);
});

// ------------------------------------------------------------------------------------------ craft requests
test('craft request state: cancelled, done, earliest active claim, requester ignored', () => {
  const cr = (state, final) => rec('cr', 'r1r1r1', NOW - 1000, 'Thrallia', { pid: 'Thrallia.p4m7', item: 'Robe', state }, { final });
  const cl = (pid, author, state, claimedAt) => rec('cl', `r1r1r1:${pid}`, claimedAt || NOW - 500, author, { state, claimedAt });
  assert.deepEqual(S.craftRequestState(cr('o'), []), { state: 'open', claimer: null });
  assert.deepEqual(S.craftRequestState(cr('o'), [cl('Zuljin.a8x2', 'Zuljin', 'c', NOW - 300), cl('Varok.7tq3', 'Varok', 'c', NOW - 400)]), { state: 'claimed', claimer: 'Varok.7tq3' });
  assert.deepEqual(S.craftRequestState(cr('o'), [cl('Zuljin.a8x2', 'Zuljin', 'c', NOW - 300), cl('Varok.7tq3', 'Varok', 'w', NOW - 400)]), { state: 'claimed', claimer: 'Zuljin.a8x2' }, 'a withdrawn claim does not count');
  assert.deepEqual(S.craftRequestState(cr('o'), [cl('Zuljin.a8x2', 'Zuljin', 'd', NOW - 300)]), { state: 'done', claimer: 'Zuljin.a8x2' }, "the claimer's done");
  assert.deepEqual(S.craftRequestState(cr('o'), [cl('Zuljin.a8x2', 'Zuljin', 'd', NOW - 300), cl('Varok.7tq3', 'Varok', 'c', NOW - 400)]), { state: 'claimed', claimer: 'Varok.7tq3' }, 'only the claimer can finish it');
  assert.deepEqual(S.craftRequestState(cr('o'), [cl('Thrallia.p4m7', 'Thrallia', 'c', NOW - 900)]), { state: 'open', claimer: null }, "the requester's own claim is ignored");
  assert.deepEqual(S.craftRequestState(cr('d', true), []), { state: 'done', claimer: null });
  assert.equal(S.craftRequestState(cr('x', true), [cl('Zuljin.a8x2', 'Zuljin', 'd', NOW - 300)]).state, 'cancelled');
  assert.equal(S.craftRequestState(rec('cr', 'r1r1r1', NOW, 'Thrallia', null, { del: true }), []).state, 'cancelled');
  // Ties on claimedAt: the smaller pid (bytes), the same on every peer.
  assert.equal(S.craftRequestState(cr('o'), [cl('Zz.aaaa', 'Zz', 'c', NOW - 300), cl('Aa.aaaa', 'Aa', 'c', NOW - 300)]).claimer, 'Aa.aaaa');
  // Claims of other requests are ignored.
  assert.equal(S.craftRequestState(cr('o'), [rec('cl', 'other1:Zuljin.a8x2', NOW, 'Zuljin', { state: 'c' })]).state, 'open');
});

// ------------------------------------------------------------------------------------------ bank requests
test('bank request state: the earlier of the cancel and the officer answer', () => {
  const bq = (state, t, final) => rec('bq', 'b4nkrq', t, 'Thrallia', { pid: 'Thrallia.p4m7', item: 'Runecloth', count: 20, state }, { final });
  const bh = (state, t) => rec('BH', 'b4nkrq', t, 'Varok', { state });
  assert.deepEqual(S.bankRequestState(bq('o', NOW - 100), null), { state: 'open', by: null, at: null });
  assert.deepEqual(S.bankRequestState(bq('o', NOW - 100), bh('s', NOW - 50)), { state: 'sent', by: 'Varok', at: NOW - 50 });
  assert.deepEqual(S.bankRequestState(bq('o', NOW - 100), bh('d', NOW - 50)), { state: 'declined', by: 'Varok', at: NOW - 50 });
  assert.equal(S.bankRequestState(bq('x', NOW - 40, true), bh('s', NOW - 50)).state, 'sent', 'sent before the cancel');
  assert.equal(S.bankRequestState(bq('x', NOW - 60, true), bh('s', NOW - 50)).state, 'cancelled', 'cancelled before it was sent');
  assert.equal(S.bankRequestState(bq('x', NOW - 50, true), bh('s', NOW - 50)).state, 'cancelled', 'a tie goes to the cancel');
  assert.equal(S.bankRequestState(null, bh('s', NOW - 50)).state, 'sent');
});

// ------------------------------------------------------------------------------------------ drives
test('drive state: total of hand-ins, reached at the goal, closed by DR', () => {
  const dr = (state, final) => rec('DR', 'dr1v3x', NOW - 1000, 'Grommash', { title: 'Bandages', unit: 'Runecloth', goal: 100, state }, { final });
  const dc = (key, amount, drive = 'dr1v3x') => rec('dc', key, NOW - 10, 'Thrallia', { pid: 'Thrallia.p4m7', drive, character: 'Thrallia', amount });
  assert.deepEqual(S.driveState(dr('o'), []), { total: 0, goal: 100, reached: false, closed: false, status: 'open' });
  assert.deepEqual(S.driveState(dr('o'), [dc('a00001', 60), dc('a00002', 30)]), { total: 90, goal: 100, reached: false, closed: false, status: 'open' });
  assert.deepEqual(S.driveState(dr('o'), [dc('a00001', 60), dc('a00002', 50)]), { total: 110, goal: 100, reached: true, closed: false, status: 'done' });
  assert.equal(S.driveState(dr('o'), [dc('a00001', 60), dc('a00002', 50), dc('a00003', 5)]).total, 115, 'later hand-ins still count');
  assert.equal(S.driveState(dr('c', true), [dc('a00001', 500)]).status, 'closed');
  assert.equal(S.driveState(dr('o'), [dc('a00001', 60, 'other1')]).total, 0, 'hand-ins to other drives');
  assert.equal(S.driveState(dr('o'), [rec('dc', 'a00001', NOW, 'Thrallia', null, { del: true })]).total, 0, 'tombstones do not count');
  assert.equal(S.driveState(rec('DR', 'dr1v3x', NOW, 'Grommash', null, { del: true }), []).status, 'closed');
});

// ------------------------------------------------------------------------------------------ SR+ loyalty
test('SR+ fold fixtures from the old server tests', () => {
  assert.ok(V.fold.length >= 8);
  for (const f of V.fold) assert.deepEqual(S.loyaltyFold(f.instance, f.records).bonuses, f.expect, f.name);
});

test('the fold gives the same answer in every delivery order', () => {
  const rng = prng(42);
  for (const f of V.fold) {
    for (let i = 0; i < 25; i++) assert.deepEqual(S.loyaltyFold(f.instance, shuffle(f.records, rng)).bonuses, f.expect, f.name);
    // Decoded records work as well as strings.
    assert.deepEqual(S.loyaltyFold(f.instance, f.records.map((r) => S.decode(r))).bonuses, f.expect, f.name);
  }
});

// The real old services, on an in-memory database.
function oldServer() {
  const { open } = require('../src/core/db');
  const R = require('../src/core/services/raids');
  const db = open(':memory:');
  let n = 0;
  function guild(players, items, instance) {
    n++;
    const guildId = Number(db.prepare("INSERT INTO guilds (name, invite_code) VALUES (?, ?)").run(`G${n}`, `inv${n}`).lastInsertRowid);
    const users = players.map((p, i) => Number(db.prepare('INSERT INTO users (bnet_id, battletag) VALUES (?, ?)').run(`t:${n}:${i}`, `${p}#1`).lastInsertRowid));
    const lootIds = items.map((gameId, i) => Number(db.prepare('INSERT INTO loot_items (guild_id, instance, boss, name, item_id) VALUES (?,?,?,?,?)')
      .run(guildId, instance, 'Boss', `Item ${gameId}`, gameId).lastInsertRowid));
    return { guildId, users, lootIds };
  }
  return { db, R, guild };
}

// One random season played on the old server and written as records. Returns both answers.
function season(server, rng, opts) {
  const { db, R } = server;
  const players = ['Velanne', 'Mokra', 'Charlie', 'Grim', 'Zul', 'Aria'];
  const pids = players.map((p, i) => `${p}.${'abcdef'[i]}0${i}0`);
  const gameIds = [30871, 30884, 30900, 30901, 30902];
  const instance = 'Hyjal Summit';
  const IK = S.instanceKey(instance);
  const g = server.guild(players, gameIds, instance);
  const records = [];
  let t = NOW - 400 * D;
  // Starting bonuses: in the old loyalty table and in an LY checkpoint.
  const start = [];
  for (let p = 0; p < players.length; p++) {
    for (let i = 0; i < gameIds.length; i++) {
      if (rng() < 0.15) {
        const bonus = 10 * (1 + Math.floor(rng() * 4));
        db.prepare('INSERT INTO loyalty (guild_id, user_id, item_id, bonus) VALUES (?,?,?,?)').run(g.guildId, g.users[p], g.lootIds[i], bonus);
        start.push({ pid: pids[p], item: S.itemKey(gameIds[i]), bonus });
      }
    }
  }
  records.push(rec('LY', IK, t, 'Grim', { upto: t, bonuses: start }));
  const award = (raid, raidKey, late) => {
    const off = rng() < 0.2;
    const i = Math.floor(rng() * gameIds.length);
    const p = rng() < 0.1 ? -1 : Math.floor(rng() * players.length);
    const itemName = off ? `Random thing ${Math.floor(rng() * 3)}` : `Item ${gameIds[i]}`;
    R.awardItem(db, raid, { itemId: off ? null : g.lootIds[i], itemName, userId: p >= 0 ? g.users[p] : null, character: p >= 0 ? players[p] : 'Pugsy', kind: ['sr', 'ms', 'os', 'free'][Math.floor(rng() * 4)] });
    t += late ? 7 : 3;
    records.push(rec('LA', S.randomKey(rng), t, 'Velanne', {
      raid: raidKey, instance: IK, item: off ? S.itemKey(itemName) : S.itemKey(gameIds[i]), itemName, character: p >= 0 ? players[p] : 'Pugsy', pid: p >= 0 ? pids[p] : '', kind: 's',
    }));
  };
  for (let w = 0; w < opts.weeks; w++) {
    const kind = rng() < 0.75 ? 'raid' : rng() < 0.5 ? 'pvp' : 'event';
    const raidKey = S.randomKey(rng);
    const raidId = Number(db.prepare('INSERT INTO raids (guild_id, title, instance, starts_at, kind) VALUES (?,?,?,?,?)').run(g.guildId, `Week ${w}`, instance, '2026-11-01T20:00:00Z', kind).lastInsertRowid);
    const status = {};
    for (let p = 0; p < players.length; p++) {
      if (rng() < 0.15) continue;
      status[p] = ['yes', 'yes', 'yes', 'tentative', 'bench', 'no'][Math.floor(rng() * 6)];
      db.prepare("INSERT INTO signups (raid_id, user_id, character, role, status) VALUES (?,?,?,'dps',?)").run(raidId, g.users[p], players[p], status[p]);
      const picks = shuffle(gameIds.map((_, i) => i), rng).slice(0, Math.floor(rng() * 3));
      for (const i of picks) db.prepare('INSERT INTO reserves (raid_id, user_id, item_id) VALUES (?,?,?)').run(raidId, g.users[p], g.lootIds[i]);
    }
    const raid = () => db.prepare('SELECT * FROM raids WHERE id = ?').get(raidId);
    const awards = Math.floor(rng() * 4);
    for (let a = 0; a < awards; a++) award(raid(), raidKey, false);
    // Close: who came (any player, signed up or not), each with their reserves left after the awards.
    const came = players.map((_, p) => p).filter(() => rng() < 0.6);
    const snapshot = came.map((p) => ({
      pid: pids[p],
      items: db.prepare('SELECT li.item_id FROM reserves r JOIN loot_items li ON li.id = r.item_id WHERE r.raid_id = ? AND r.user_id = ?').all(raidId, g.users[p]).map((r) => S.itemKey(r.item_id)),
    }));
    const noShows = Object.keys(status).map(Number).filter((p) => status[p] === 'yes' && !came.includes(p)).map((p) => pids[p]);
    R.closeRaid(db, raid(), came.map((p) => g.users[p]));
    t += 5;
    records.push(rec('RT', raidKey, t, 'Grim', { status: 'd', kind: kind[0], instance: IK, closedAt: t, attendees: snapshot, noShows }, { final: true }));
    // Sometimes an officer records loot after the close.
    if (rng() < 0.3) award(raid(), raidKey, true);
    t += D * 7;
  }
  const old = {};
  for (const row of db.prepare('SELECT l.user_id, li.item_id, l.bonus FROM loyalty l JOIN loot_items li ON li.id = l.item_id WHERE l.guild_id = ?').all(g.guildId)) {
    if (!row.bonus) continue;
    const pid = pids[g.users.indexOf(row.user_id)];
    (old[pid] = old[pid] || {})[S.itemKey(row.item_id)] = row.bonus;
  }
  return { old, records, instance: IK, t };
}

test('the fold replays the old closeRaid and awardItem exactly (random seasons, differential)', () => {
  const server = oldServer();
  const rounds = HEAVY ? 1500 : 150;
  const rng = prng(2026);
  for (let i = 0; i < rounds; i++) {
    const s = season(server, rng, { weeks: 1 + Math.floor(rng() * 8) });
    const got = S.loyaltyFold(s.instance, shuffle(s.records, rng)).bonuses;
    assert.deepEqual(got, s.old, `season ${i}`);
  }
});

test('a checkpoint folds exactly what is older than 30 days; folding on from it changes nothing', () => {
  const server = oldServer();
  const rng = prng(99);
  for (let i = 0; i < (HEAVY ? 300 : 40); i++) {
    const s = season(server, rng, { weeks: 4 + Math.floor(rng() * 6) });
    const now = s.t - Math.floor(rng() * 60) * D;
    const cp = S.loyaltyCheckpoint(s.instance, s.records, now);
    assert.ok(cp.upto <= now - 30 * D || cp.upto === S.loyaltyFold(s.instance, s.records).upto);
    const ly = rec('LY', s.instance, now, 'Grim', cp);
    assert.ok(S.decode(ly), 'the checkpoint is a valid LY record');
    // Newest LY wins; events it covers are skipped; the answer is the same.
    assert.deepEqual(S.loyaltyFold(s.instance, s.records.concat([ly])).bonuses, s.old, `season ${i}`);
    assert.equal(S.loyaltyFold(s.instance, s.records.concat([ly])).upto, cp.upto);
    // Every close and award it covers may now expire; none it does not cover.
    const lookup = (id) => (id === `LY:${s.instance}` ? ly : null);
    for (const r of s.records) {
      const d = S.decode(r);
      if (!S.isFoldable(d)) continue;
      const far = now + 10000 * D;
      assert.equal(S.isExpired(d, far, lookup), d.t <= cp.upto, `${d.id} t=${d.t} upto=${cp.upto}`);
    }
  }
});

test('needsCheckpoint: only when the newest LY is over 14 days old and something older than 30 days is unfolded', () => {
  const IK = 'abc123';
  const closeAt = (t) => rec('RT', S.randomKey(prng(t)), t, 'Grim', { status: 'd', kind: 'r', instance: IK, attendees: [{ pid: 'A.aaaa', items: ['x1'] }] }, { final: true });
  const lyAt = (t, upto) => rec('LY', IK, t, 'Grim', { upto });
  assert.equal(S.needsCheckpoint(IK, [], NOW), false);
  assert.equal(S.needsCheckpoint(IK, [closeAt(NOW - 10 * D)], NOW), false, 'nothing older than 30 days');
  assert.equal(S.needsCheckpoint(IK, [closeAt(NOW - 31 * D)], NOW), true, 'no LY yet');
  assert.equal(S.needsCheckpoint(IK, [closeAt(NOW - 31 * D), lyAt(NOW - 13 * D, NOW - 43 * D)], NOW), false, 'LY is recent');
  assert.equal(S.needsCheckpoint(IK, [closeAt(NOW - 31 * D), lyAt(NOW - 15 * D, NOW - 45 * D)], NOW), true, 'old LY, new close to fold');
  assert.equal(S.needsCheckpoint(IK, [closeAt(NOW - 50 * D), lyAt(NOW - 15 * D, NOW - 45 * D)], NOW), false, 'already covered');
  // The newest LY by version wins, whatever the order.
  const a = lyAt(NOW - 20 * D, NOW - 50 * D);
  const b = lyAt(NOW - 5 * D, NOW - 35 * D);
  assert.equal(S.loyaltyFold(IK, [a, b]).upto, NOW - 35 * D);
  assert.equal(S.loyaltyFold(IK, [b, a]).upto, NOW - 35 * D);
});
