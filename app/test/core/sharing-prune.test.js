'use strict';
// Pruning (docs/SHARING.md §11, D6): this computer drops the shared records every addon has already expired, so its
// database never holds more than an addon store would. The rows those records made stay as history: every page
// shows the same before and after, also when the rows are made again later, and an expired copy (or a record that
// expires with a dropped parent) is never taken back.
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../../src/shared/sharing');
const sharing = require('../../src/core/sharing');
const project = require('../../src/core/share/project');
const { pruneShared } = require('../../src/core/share/prune');
const { setupShare, rec, NOW, D, PIDS } = require('./sharing-helpers');

const B = NOW - 80 * D; // when the guild's records were made: 80 days before "now"
const MC = 'Molten Core';
const IK = S.instanceKey(MC);
const CLOAK = S.itemKey(17102);
const RAID = 'k3f9a2';
const SKILL = S.toB36(197); // Tailoring

function guildRecords() {
  const chs = Object.entries(PIDS).map(([n, p]) => rec('ch', n, B, n, { pid: p, alts: [n], level: 60 }));
  return [
    ...chs,
    rec('LL', IK, B, 'Grommash', { name: MC, items: [{ item: CLOAK, name: 'Cloak' }] }),
    rec('RD', RAID, B, 'Grommash', { kind: 'r', title: 'MC Thursday', instance: MC, startsAt: B + D, minutes: 180, size: 40, srLimit: 2 }),
    rec('su', `${RAID}:${PIDS.Jaina}`, B + 100, 'Jaina', { character: 'Jaina', role: 'd', status: 'y', reserves: [CLOAK], reservesAt: B + 100 }),
    rec('su', `${RAID}:${PIDS.Zuljinne}`, B + 100, 'Zuljinne', { character: 'Zuljinne', role: 'h', status: 'y', reserves: [] }),
    rec('AN', 'q2w8zz', B, 'Grommash', { body: 'Bring fire resist' }),
    rec('DR', 'd1d1d1', B, 'Varok', { title: 'Flasks', unit: 'flasks', goal: 10, state: 'c' }, { final: true }),
    rec('dc', 'c1c1c1', B, 'Jaina', { pid: PIDS.Jaina, drive: 'd1d1d1', character: 'Jaina', amount: 5 }),
    rec('bq', 'b1b1b1', B, 'Jaina', { pid: PIDS.Jaina, item: 'Runecloth', count: 20, state: 'o' }),
    rec('BH', 'b1b1b1', B + 60, 'Varok', { state: 's' }),
    rec('cr', 'r1r1r1', B, 'Jaina', { pid: PIDS.Jaina, item: 'Robe of Power', notes: '', state: 'd' }, { final: true }),
    rec('cl', `r1r1r1:${PIDS.Zuljinne}`, B + 60, 'Zuljinne', { state: 'd' }),
    rec('ca', 'x8k2pq', B, 'Zuljinne', { character: 'Zuljinne', zone: 'Crossroads', needed: 5, message: 'help' }),
    rec('lp', `${PIDS.Jaina}:Jaina`, B, 'Jaina', { character: 'Jaina', level: 30, zone: 'Barrens' }),
    rec('rc', `Zuljinne:${SKILL}`, B, 'Zuljinne', { kind: 'n', count: 1, list: ['Robe of Power'] }),
    rec('gb', '0', B, 'Jaina', { scannedAt: B, money: 123456, tabs: ['Mats'], log: [] }),
    rec('gb', '1', B, 'Jaina', { items: [{ id: 14047, count: 20 }] }),
    rec('pr', PIDS.Jaina, B, 'Jaina', { day: Math.floor((B * 1000 - Date.UTC(2020, 0, 1)) / 86400000), prices: [{ id: 14047, copper: 80 }] }),
    `zz:j1^${S.makeVersion(B, 'Jaina', false)}^Jaina^^x`, // a type this version doesn't know
    rec('su', `${RAID}:${PIDS.Varok}`, B + 200, 'Jaina', { character: 'Jaina', role: 'd', status: 'y' }), // Jaina isn't Varok: ignored
  ];
}
// The raid's close and its award, a day later.
const later = () => [
  rec('RT', RAID, B + D + 3 * 3600, 'Grommash', { status: 'd', lockedAt: B + D, kind: 'r', instance: IK, closedAt: B + D + 3 * 3600,
    attendees: [{ pid: PIDS.Jaina, items: [CLOAK] }, { pid: PIDS.Zuljinne, items: [] }], noShows: [] }, { final: true }),
  rec('LA', 'a1a1a1', B + D + 2 * 3600, 'Grommash', { raid: RAID, instance: IK, item: CLOAK, itemName: 'Cloak', character: 'Jaina', pid: PIDS.Jaina, kind: 's' }),
];

// Every page a player or an officer can open, as JSON.
async function pages(h) {
  const raid = h.row('SELECT id FROM raids WHERE share_id = ?', RAID);
  const paths = ['/api/raids', `/api/raids/${raid.id}`, `/api/raids/${raid.id}/loot`, '/api/loot', '/api/bank', '/api/drives', '/api/requests',
    '/api/camp', '/api/partners', '/api/crafters', '/api/crafters?q=Robe', '/api/roster', '/api/members', '/api/prices', '/api/characters/Zuljinne', '/api/activity'];
  const out = {};
  for (const p of paths) {
    const r = await h.srv.api.get(p);
    assert.equal(r.status, 200, `${p}: ${JSON.stringify(r.body)}`);
    out[p] = r.body;
  }
  return out;
}

async function setup(t) {
  const h = await setupShare(t, { role: 'officer', now: B + 600 });
  h.imp(guildRecords());
  h.setNow(B + 2 * D);
  h.imp(later());
  assert.equal(h.stored(`su:${RAID}:${PIDS.Varok}`).state, 'ignored');
  h.setNow(NOW);
  return h;
}

test('D6: pruning drops what every addon has expired and leaves every page as it was, also after the rows are made again', async (t) => {
  const h = await setup(t);
  const before = await pages(h);
  // What the page shows comes from records that have all expired by now, except the loot list and the
  // raid close and award (kept until an SR+ checkpoint covers them).
  const stored = h.row('SELECT COUNT(*) AS n FROM shared_records WHERE guild_id = ?', h.gid).n;
  assert.ok(stored > 20);
  const n = h.db.transaction(() => pruneShared(h.db, h.gid, NOW))();
  const left = h.rows('SELECT id FROM shared_records WHERE guild_id = ? ORDER BY id', h.gid).map((r) => r.id);
  assert.deepEqual(left, [`LA:a1a1a1`, `LL:${IK}`, `RT:${RAID}`]);
  assert.equal(n, stored - 3);
  assert.deepEqual(await pages(h), before, 'every page shows the same');
  assert.ok(before['/api/raids'].past.some((r) => r.title === 'MC Thursday'), 'the past raid is there to compare');
  assert.equal(before['/api/loot'].history.length, 1, 'the loot history is there to compare');
  assert.deepEqual(before['/api/characters/Zuljinne'].recipes.map((x) => x.name), ['Robe of Power'], 'and a guildmate\'s recipes');
  assert.equal(before['/api/drives'].past.length, 1);
  assert.equal(before['/api/camp'].announcements.length, 1);

  // Every row made again from what is left (as a new loot list, award or raid status would trigger).
  const ids = [...new Set([...guildRecords(), ...later()].map((s) => S.parse(s).id))];
  h.db.transaction(() => { for (const id of ids) sharing.reproject(h.db, h.gid, id); })();
  project.run(h.db, h.gid, [`raid:${RAID}`, `loyalty:${IK}`, 'gb', 'bc', `ll:${IK}`]);
  assert.deepEqual(await pages(h), before, 'still the same after the rows are made again');

  // An expired copy, or a sign-up that expires with the dropped raid, is never taken back.
  const late = rec('su', `${RAID}:${PIDS.Grommash}`, NOW - 60, 'Grommash', { character: 'Grommash', role: 't', status: 'y' });
  const r = h.imp([guildRecords().find((s) => s.startsWith('AN:')), late]);
  assert.equal(r.imported, 0);
  assert.equal(h.stored(`su:${RAID}:${PIDS.Grommash}`), undefined);
  assert.deepEqual(await pages(h), before);
  // A newer version of the dropped raid that is not used (a member passing on an officer record) doesn't make the
  // raid's rows removable either.
  const forged = rec('RD', RAID, NOW - 60, 'Grommash', { kind: 'r', title: 'MC Thursday', instance: MC, startsAt: NOW + D, minutes: 180, size: 40, srLimit: 2 });
  h.imp([forged], { via: { [`RD:${RAID}`]: `Jaina,${NOW},m` } });
  assert.equal(h.stored(`RD:${RAID}`).state, 'ignored');
  sharing.reproject(h.db, h.gid, `RD:${RAID}`);
  assert.deepEqual(await pages(h), before);
});

test('D6: a record with a change of mine still to send is kept, and pruning runs from an upload at most once an hour', async (t) => {
  const h = await setup(t);
  // My unsent edit of the old notice: its stored version stays (the rows go back to it if the edit is refused).
  h.queue({ type: 'AN', key: 'q2w8zz', fields: { body: 'Bring fire resist and flasks' }, need: 'o' });
  h.imp([]);
  assert.ok(h.stored('AN:q2w8zz'), 'kept while my change waits');
  assert.equal(h.stored('ca:x8k2pq'), undefined, 'the upload pruned the rest');
  // Within the same hour nothing runs again.
  h.db.prepare("INSERT INTO shared_records (guild_id, id, v, author, body, state) VALUES (?, 'zz:j2', ?, 'Jaina', ?, 'ok')")
    .run(h.gid, S.makeVersion(B, 'Jaina', false), `zz:j2^${S.makeVersion(B, 'Jaina', false)}^Jaina^^x`);
  h.imp([]);
  assert.ok(h.stored('zz:j2'));
  h.setNow(NOW + 3600);
  h.imp([]);
  assert.equal(h.stored('zz:j2'), undefined, 'the next hour it goes');
});

test('D6: a raid close arriving after its raid was dropped is still taken (no addon expires it before an SR+ checkpoint covers it) and its SR+ bonus counts', async (t) => {
  const h = await setupShare(t, { role: 'officer', now: B + 600 });
  const chs = Object.entries(PIDS).map(([n, p]) => rec('ch', n, B, n, { pid: p, alts: [n], level: 60 }));
  h.imp([...chs,
    rec('LL', IK, B, 'Grommash', { name: MC, items: [{ item: CLOAK, name: 'Cloak' }] }),
    rec('RD', RAID, B, 'Grommash', { kind: 'r', title: 'MC Thursday', instance: MC, startsAt: B + D, minutes: 180, size: 40, srLimit: 2 }),
    rec('su', `${RAID}:${PIDS.Jaina}`, B + 100, 'Jaina', { character: 'Jaina', role: 'd', status: 'y', reserves: [CLOAK], reservesAt: B + 100 }),
  ]);
  // Weeks later an upload drops the raid; its close hadn't reached this computer yet.
  h.setNow(NOW);
  h.imp([]);
  assert.equal(h.stored(`RD:${RAID}`), undefined, 'the raid was dropped');
  const close = later()[0];
  assert.equal(S.checkRecord(close, NOW, () => null), null, 'an addon without the raid takes the close');
  h.setNow(NOW + 7200);
  const r = h.imp([close], { via: { [`RT:${RAID}`]: `Grommash,${NOW},d` } });
  assert.equal(r.imported, 1);
  assert.equal(h.stored(`RT:${RAID}`).state, 'ok');
  // Jaina reserved the cloak and didn't get it: the close gives her SR+ on it.
  const jaina = h.userOf(PIDS.Jaina).id;
  assert.deepEqual(h.rows('SELECT user_id, bonus FROM loyalty WHERE guild_id = ?', h.gid), [{ user_id: jaina, bonus: 10 }]);
  assert.ok(h.row('SELECT 1 FROM raids WHERE share_id = ?', RAID), 'the past raid still shows');
});

test('D6: dropping a player\'s anchor ch (not played for 60 days) leaves their name as it was on the members page when their alt\'s ch comes in again', async (t) => {
  const h = await setupShare(t, { now: B + 600 });
  const JP = PIDS.Jaina;
  h.db.prepare("INSERT INTO characters (guild_id, name, class, level, rank, rank_index) VALUES (?, 'Jainalt', 'MAGE', 60, 'r', 3)").run(h.gid);
  h.imp([
    rec('ch', 'Jaina', B, 'Jaina', { pid: JP, battletag: 'Jaina#1111', main: true, alts: ['Jaina', 'Jainalt'], level: 60 }),
    rec('ch', 'Jainalt', B, 'Jainalt', { pid: JP, alts: ['Jainalt'], level: 60 }),
  ]);
  const members = async () => (await h.srv.api.get('/api/members')).body;
  // She plays only her alt from now on: its ch stays fresh, the anchor's ages out and is dropped.
  h.setNow(NOW - 2 * D);
  h.imp([rec('ch', 'Jainalt', NOW - 2 * D, 'Jainalt', { pid: JP, alts: ['Jainalt'], level: 60 })]);
  const before = await members();
  assert.ok(JSON.stringify(before).includes('Jaina#1111'));
  h.setNow(NOW);
  h.imp([]);
  assert.equal(h.stored('ch:Jaina'), undefined, 'the anchor\'s ch was dropped');
  // Her alt logs in again the next day.
  h.setNow(NOW + D);
  h.imp([rec('ch', 'Jainalt', NOW + D - 60, 'Jainalt', { pid: JP, alts: ['Jainalt'], level: 60 })]);
  assert.equal(h.row('SELECT battletag FROM users WHERE bnet_id = ?', `pid:${JP}`).battletag, 'Jaina#1111');
  assert.deepEqual(await members(), before);
  // Back on her anchor, the name comes from its new ch as before.
  h.imp([rec('ch', 'Jaina', NOW + D - 30, 'Jaina', { pid: JP, battletag: 'Jaina#2222', main: true, alts: ['Jaina', 'Jainalt'], level: 60 })]);
  assert.equal(h.row('SELECT battletag FROM users WHERE bnet_id = ?', `pid:${JP}`).battletag, 'Jaina#2222');
});

test('Y5: a raid close arriving after its raid was dropped also marks the past raid done with its attendance, as a database that never dropped the raid shows it', async (t) => {
  const first = [
    ...Object.entries(PIDS).map(([n, p]) => rec('ch', n, B, n, { pid: p, alts: [n], level: 60 })),
    rec('LL', IK, B, 'Grommash', { name: MC, items: [{ item: CLOAK, name: 'Cloak' }] }),
    rec('RD', RAID, B, 'Grommash', { kind: 'r', title: 'MC Thursday', instance: MC, startsAt: B + D, minutes: 180, size: 40, srLimit: 2 }),
    rec('su', `${RAID}:${PIDS.Jaina}`, B + 100, 'Jaina', { character: 'Jaina', role: 'd', status: 'y', reserves: [CLOAK], reservesAt: B + 100 }),
  ];
  const close = later()[0];
  const via = { [`RT:${RAID}`]: `Grommash,${NOW},d` };
  const shown = async (h) => {
    const raid = h.row('SELECT id, status FROM raids WHERE share_id = ?', RAID);
    const page = (await h.srv.api.get(`/api/raids/${raid.id}`)).body;
    return {
      status: raid.status,
      attendance: h.rows('SELECT u.battletag FROM attendance a JOIN users u ON u.id = a.user_id WHERE a.raid_id = ? ORDER BY u.battletag', raid.id).map((r) => r.battletag),
      past: (await h.srv.api.get('/api/raids')).body.past.map((r) => [r.title, r.status]),
      page: [page.raid.status, page.raid.closed ?? null],
    };
  };
  // The control: the close arrives while the raid is still here.
  const keep = await setupShare(t, { role: 'officer', now: B + 600 });
  keep.imp(first);
  keep.setNow(B + 2 * D);
  keep.imp([close], { via });
  const want = await shown(keep);
  assert.equal(want.status, 'done');
  assert.deepEqual(want.attendance.length, 2, 'Jaina and Zuljinne attended');

  // Weeks later an upload drops the raid; its close reaches this computer only after that.
  const h = await setupShare(t, { role: 'officer', now: B + 600 });
  h.imp(first);
  h.setNow(NOW);
  h.imp([]);
  assert.equal(h.stored(`RD:${RAID}`), undefined, 'the raid was dropped');
  h.setNow(NOW + 7200);
  assert.equal(h.imp([close], { via }).imported, 1);
  assert.deepEqual(await shown(h), want);
});

test('Y5: share_pruned does not grow for good: an entry goes once no late copy of its record, or of one that expires with it, could be taken anyway, while the entries of raids, drives, loot lists, awards and characters stay; every page shows the same and a late copy is still refused', async (t) => {
  const h = await setup(t);
  const entries = () => h.rows('SELECT id FROM share_pruned WHERE guild_id = ? ORDER BY id', h.gid).map((r) => r.id);
  h.db.transaction(() => pruneShared(h.db, h.gid, NOW))();
  const before = await pages(h);
  assert.ok(entries().includes('ca:x8k2pq'), 'dropped, with its entry');
  // The next upload (pruning runs once an hour): a call to arms and a leveling-partner post from 80 days ago can't
  // come back any more, so their entries go; a finished request (its claims could still come back), a sign-up and
  // the raid stay.
  h.imp([]);
  const left = entries();
  for (const id of ['ca:x8k2pq', `lp:${PIDS.Jaina}:Jaina`, 'gb:0', 'gb:1', `pr:${PIDS.Jaina}`]) assert.ok(!left.includes(id), `${id} forgotten`);
  for (const id of [`RD:${RAID}`, 'DR:d1d1d1', 'cr:r1r1r1', 'bq:b1b1b1', `su:${RAID}:${PIDS.Jaina}`, 'ch:Jaina']) assert.ok(left.includes(id), `${id} kept`);
  assert.deepEqual(await pages(h), before, 'every page shows the same');
  // A late copy of the forgotten call to arms is refused all the same: it expired by the codec's own rule.
  const ca = guildRecords().find((s) => s.startsWith('ca:'));
  assert.equal(h.imp([ca]).imported, 0);
  assert.equal(h.stored('ca:x8k2pq'), undefined);
  assert.deepEqual(await pages(h), before);
  // A year on, only the entries kept for good are left (the raid close still here waits for an SR+ checkpoint).
  h.setNow(NOW + 400 * D);
  h.imp([]);
  const year = entries();
  assert.deepEqual(year.filter((id) => !id.startsWith('ch:')), ['DR:d1d1d1', `RD:${RAID}`]);
  assert.ok(year.includes('ch:Jaina'));
});

test('Y5: a guildmate\'s recipes from a dropped rc stay on the page once its share_pruned entry is forgotten, also when an upload later brings the name of one of them', async (t) => {
  const old = NOW - 200 * D;
  const mining = S.toB36(186);
  const h = await setupShare(t, { role: 'officer', now: old + 600 });
  h.imp([rec('ch', 'Zuljinne', old, 'Zuljinne', { pid: PIDS.Zuljinne, alts: ['Zuljinne'], level: 60 }),
    rec('rc', `Zuljinne:${mining}`, old + 60, 'Zuljinne', { kind: 's', count: 2, list: [2660, 99999] })], { names: { s: { 2660: 'Smelt Copper' } } });
  const recipes = async () => (await h.srv.api.get('/api/characters/Zuljinne')).body.recipes.map((x) => x.name).sort();
  assert.deepEqual(await recipes(), ['Recipe 99999', 'Smelt Copper']);
  // The next upload drops the rc (expired 140 days ago) and, a late copy being refused by its own expiry by now,
  // forgets its entry at once.
  h.setNow(NOW);
  h.imp([]);
  assert.equal(h.stored(`rc:Zuljinne:${mining}`), undefined);
  assert.equal(h.row('SELECT COUNT(*) AS n FROM share_pruned WHERE id = ?', `rc:Zuljinne:${mining}`).n, 0);
  assert.deepEqual(await recipes(), ['Recipe 99999', 'Smelt Copper'], 'kept as history');
  // My addon learns the name of the unnamed one: nothing to name it from, and the history stays.
  h.setNow(NOW + 3600);
  h.imp([], { names: { s: { 99999: 'Smelt Iron' } } });
  assert.deepEqual(await recipes(), ['Recipe 99999', 'Smelt Copper']);
});
