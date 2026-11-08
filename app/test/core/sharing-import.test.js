'use strict';
// Import from the addon's store (docs/SHARING.md §5, §10): the app's content rules, acknowledgements and
// rollback, the author check, the shared webhook, guild settings, the SR+ checkpoint writer, prices once a
// day, notifications and audit lines, and adopting the player id.
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../../src/shared/sharing');
const sharing = require('../../src/core/sharing');
const { applyPayload } = require('../../src/core/services/sync');
const { setupShare, rec, NOW, D, G, PIDS, ME_PID } = require('./sharing-helpers');

const MC = 'Molten Core';
const IK = S.instanceKey(MC);
const CLOAK = S.itemKey(17102);
const GIRDLE = S.itemKey(19137);
const ch = (name, pid, alts) => rec('ch', name, NOW - 3000, name, { pid, alts: alts || [name], level: 60 });
const CHS = Object.entries(PIDS).map(([n, p]) => ch(n, p));
const LL = rec('LL', IK, NOW - 5000, 'Grommash', { name: MC, items: [{ item: CLOAK, name: 'Cloak' }, { item: GIRDLE, name: 'Girdle' }] });
const RD = rec('RD', 'k3f9a2', NOW - 4000, 'Grommash', { kind: 'r', title: 'Molten Core Thursday', instance: MC, startsAt: NOW + 2 * D, minutes: 180, size: 40, srLimit: 1 });
const WEBHOOK = 'https://discord.com/api/webhooks/123/abc';

// ------------------------------------------------------------------------------------------ rules
test('the codec\'s accept/refuse table: what the addon refuses never reaches the app\'s tables', async (t) => {
  const h = await setupShare(t);
  for (const c of S.ACCEPT_CASES) {
    h.setNow(c.now);
    h.db.prepare('DELETE FROM shared_records').run();
    for (const [id, body] of Object.entries(c.lookup || {})) {
      const p = S.parse(body);
      h.db.prepare("INSERT INTO shared_records (guild_id, id, v, author, body, state) VALUES (?,?,?,?,?, 'ok')").run(h.gid, id, p.v, p.author, body);
    }
    const p = S.parse(c.record);
    h.imp([c.record]);
    const stored = p ? h.stored(p.id) : null;
    const refusedByCodec = ['malformed', 'oversize', 'author', 'future', 'expired'].includes(c.expect);
    if (refusedByCodec) assert.equal(stored && stored.body === c.record ? 'stored' : 'not stored', 'not stored', c.name);
    else if (['ok', 'd', 't', 'm'].includes(c.expect)) assert.ok(stored && stored.body === c.record, c.name);
  }
});

test('content rules: links, owners, own requests, bank characters, raid, loot list and limit; failures are kept as ignored with an audit line', async (t) => {
  const h = await setupShare(t);
  h.imp([...CHS, LL, RD, rec('BC', '1', NOW - 100, 'Varok', { names: ['Bankalt'] })]);
  const cases = [
    // [record, expected reason (null = ok)]
    [rec('su', `k3f9a2:${PIDS.Zuljinne}`, NOW - 60, 'Zuljinne', { character: 'Zuljinne', role: 'h', status: 'y', reserves: [CLOAK] }), null],
    [rec('su', `k3f9a2:${PIDS.Zuljinne}`, NOW - 50, 'Jaina', { character: 'Jaina', role: 'h', status: 'y' }), 'link'],
    [rec('su', `k3f9a2:${PIDS.Jaina}`, NOW - 60, 'Jaina', { character: 'Jaina', role: 'd', status: 'y', reserves: [CLOAK, GIRDLE] }), 'limit'],
    [rec('su', `k3f9a2:${PIDS.Varok}`, NOW - 60, 'Varok', { character: 'Varok', role: 'd', status: 'y', reserves: ['h00000'] }), 'loot list'],
    [rec('su', `zzzzzz:${PIDS.Varok}`, NOW - 60, 'Varok', { character: 'Varok', role: 'd', status: 'y', reserves: [CLOAK] }), 'raid'],
    [rec('cr', 'r1r1r1', NOW - 60, 'Zuljinne', { pid: PIDS.Jaina, item: 'Robe', state: 'o' }), 'link'],
    [rec('cr', 'r2r2r2', NOW - 60, 'Jaina', { pid: PIDS.Jaina, item: 'Robe', state: 'o' }), null],
    [rec('cl', `r2r2r2:${PIDS.Jaina}`, NOW - 50, 'Jaina', { state: 'c' }), 'own request'],
    [rec('bk', 'Jaina', NOW - 60, 'Jaina', { bags: [{ id: 1, count: 1 }] }), 'bank'],
    [rec('bk', 'Bankalt', NOW - 60, 'Bankalt', { bags: [{ id: 1, count: 1 }] }), null],
    [rec('AN', 'q2w8zz', NOW - 60, 'Grommash', { body: 'hi' }), 'rank', `Thrallia,${NOW},m`],
    [rec('WH', '1', NOW - 60, 'Varok', { url: WEBHOOK }), 'officers only'],
  ];
  for (const [r, want, via] of cases) {
    const p = S.parse(r);
    h.imp([r], via ? { via: { [p.id]: via } } : {});
    const s = h.stored(p.id);
    assert.equal(s.state, want ? 'ignored' : 'ok', `${p.id} by ${p.author}`);
    assert.equal(s.reason, want, `${p.id} by ${p.author}`);
  }
  const audit = h.rows("SELECT detail FROM audit_log WHERE action = 'ignored from the guild' ORDER BY id").map((r) => r.detail);
  assert.ok(audit.some((d) => /^Ignored Sign-up for Molten Core Thursday: coming as healer from Jaina: that character is not linked to that player yet\.$/.test(d)), audit.join('\n'));
  // A forged edit of someone's request is ignored, and the rows keep showing the real one.
  h.imp([rec('cr', 'r2r2r2', NOW - 30, 'Zuljinne', { pid: PIDS.Zuljinne, item: 'Stolen', state: 'o' })]);
  assert.equal(h.stored('cr:r2r2r2').state, 'ignored');
  assert.equal(h.row("SELECT item FROM craft_requests WHERE share_id = 'r2r2r2'").item, 'Robe');
  assert.equal(sharing.baseOf(h.db, h.gid, 'cr:r2r2r2'), h.stored('cr:r2r2r2').v, 'the base is what the addon holds');
});

test('a record ignored for a missing link is used once the link arrives (any order)', async (t) => {
  const h = await setupShare(t);
  const su = rec('su', `k3f9a2:${PIDS.Zuljinne}`, NOW - 60, 'Zulalt', { character: 'Zulalt', role: 'h', status: 'y' });
  h.imp([LL, RD, su, ch('Zulalt', PIDS.Zuljinne)]);
  assert.equal(h.stored(`su:k3f9a2:${PIDS.Zuljinne}`).reason, 'link');
  assert.equal(h.row('SELECT COUNT(*) AS n FROM signups').n, 0);
  h.imp([ch('Zuljinne', PIDS.Zuljinne, ['Zuljinne', 'Zulalt'])]);
  assert.equal(h.stored(`su:k3f9a2:${PIDS.Zuljinne}`).state, 'ok');
  assert.equal(h.row('SELECT character FROM signups').character, 'Zulalt');
});

// ------------------------------------------------------------------------------------------ acks
test('acknowledgements: ok stores my record and posts to Discord once; wait shows why; no,stale rolls back with the reason', async (t) => {
  const h = await setupShare(t, { role: 'officer', webhook: WEBHOOK });
  h.imp([...CHS, LL]);
  // Schedule a raid and post a notice in the app.
  const raid = h.queue({ type: 'RD', key: 'k3f9a2', fields: S.decode(RD).fields, need: 'o' });
  const notice = h.queue({ type: 'AN', key: 'q2w8zz', fields: { body: 'Bring fire resist' }, need: 'o' });
  assert.equal(h.row("SELECT title FROM raids WHERE share_id = 'k3f9a2'").title, 'Molten Core Thursday', 'the page shows it at once');
  assert.equal(h.discord.calls.length, 0, 'nothing posted before the game sends it');
  const v1 = S.makeVersion(NOW - 10, 'Thrallia');
  h.imp([], { sent: { [raid.op]: `ok,${S.makeVersion(NOW, 'Thrallia')},Thrallia`, [notice.op]: 'wait,officer' } });
  const o = Object.fromEntries(h.outbox().map((r) => [r.op, r]));
  assert.equal(o[raid.op].state, 'sent');
  assert.equal(o[notice.op].state, 'waiting');
  assert.equal(o[notice.op].note, 'Log in on an officer character to send this.');
  assert.equal(h.stored('RD:k3f9a2').how, 'o');
  assert.deepEqual(sharing.exportOutbox(h.db).map((e) => e.op), [notice.op], 'sent entries leave the inbox');
  await new Promise((r) => setImmediate(r));
  assert.equal(h.discord.calls.length, 1);
  assert.match(h.discord.calls[0].body.content, /^🗓️ \*\*Raid: Molten Core Thursday\*\* \(Molten Core\)/);
  h.imp([], { sent: { [raid.op]: `ok,${S.makeVersion(NOW, 'Thrallia')},Thrallia` } });
  await new Promise((r) => setImmediate(r));
  assert.equal(h.discord.calls.length, 1, 'posted once');

  // Lock it, then the game says someone changed it in the meantime: back to open, with the reason.
  const lock = h.queue({ type: 'RT', key: 'k3f9a2', fields: { status: 'l', lockedAt: NOW }, need: 'o' });
  assert.equal(h.row("SELECT status FROM raids WHERE share_id = 'k3f9a2'").status, 'locked');
  h.imp([], { sent: { [lock.op]: 'no,stale' } });
  assert.equal(h.row("SELECT status FROM raids WHERE share_id = 'k3f9a2'").status, 'open', 'rolled back');
  const refused = sharing.status(h.db).refused;
  assert.deepEqual(refused.map((r) => [r.op, r.state, r.note, r.summary]), [[lock.op, 'refused', 'Someone changed this in the meantime. Check it and try again.', 'Molten Core Thursday: locked']]);
  void v1;
});

test('a newer version from someone else replaces my pending change, which is dropped with the reason', async (t) => {
  const h = await setupShare(t, { role: 'officer' });
  h.imp([...CHS, LL, RD]);
  const lock = h.queue({ type: 'RT', key: 'k3f9a2', fields: { status: 'l', lockedAt: NOW }, need: 'o' });
  h.setNow(NOW + 60);
  h.imp([rec('RT', 'k3f9a2', NOW + 30, 'Grommash', { status: 'x' }, { final: true })]);
  assert.equal(h.outbox().find((r) => r.op === lock.op).state, 'refused');
  assert.equal(h.row("SELECT status FROM raids WHERE share_id = 'k3f9a2'").status, 'cancelled');
});

test('cancel: a waiting change is dropped and the page shows what was there before', async (t) => {
  const h = await setupShare(t, { role: 'officer' });
  h.imp([...CHS, LL, RD]);
  const x = h.queue({ type: 'RT', key: 'k3f9a2', fields: { status: 'x' }, need: 'o' });
  assert.equal(h.row("SELECT status FROM raids WHERE share_id = 'k3f9a2'").status, 'cancelled');
  assert.ok(S.isFinalV(S.parse(h.outbox().find((r) => r.op === x.op).record).v), 'a cancel is a final version');
  const r = await h.srv.api.post(`/api/share/outbox/${x.op}/cancel`, {});
  assert.equal(r.status, 200);
  assert.equal(h.row("SELECT status FROM raids WHERE share_id = 'k3f9a2'").status, 'open');
  assert.deepEqual(sharing.exportOutbox(h.db), []);
  assert.equal((await h.srv.api.post(`/api/share/outbox/${x.op}/cancel`, {})).status, 409);
  // The game had already sent it after all: the late "ok" is recognised, and no author check appears.
  h.imp([rec('RT', 'k3f9a2', NOW, 'Thrallia', { status: 'x' }, { final: true })], { sent: { [x.op]: `ok,${S.makeVersion(NOW, 'Thrallia', true)},Thrallia` }, via: { 'RT:k3f9a2': `Varok,${NOW},t` } });
  assert.equal(h.row('SELECT COUNT(*) AS n FROM share_author_checks').n, 0);
});

// ------------------------------------------------------------------------------------------ author check
test('author check: a change in my name this computer did not make; "It was me" and "Undo it"', async (t) => {
  const h = await setupShare(t, { role: 'member' });
  h.imp([...CHS, LL, RD]);
  // My sign-up, sent from here.
  const mine = h.queue({ type: 'su', key: `k3f9a2:${ME_PID}`, fields: { character: 'Thrallia', role: 'h', status: 'y', reserves: [CLOAK], reservesAt: NOW } });
  const v = S.makeVersion(NOW, 'Thrallia');
  const real = S.encode({ type: 'su', key: `k3f9a2:${ME_PID}`, v, author: 'Thrallia', fields: { character: 'Thrallia', role: 'h', status: 'y', reserves: [CLOAK], reservesAt: NOW } });
  h.imp([real], { sent: { [mine.op]: `ok,${v},Thrallia` }, via: { [`su:k3f9a2:${ME_PID}`]: null } });
  assert.equal(h.row('SELECT COUNT(*) AS n FROM share_author_checks').n, 0, 'my own change is not flagged');
  // Someone passes on a "no" in my name.
  h.setNow(NOW + 100);
  const forged = rec('su', `k3f9a2:${ME_PID}`, NOW + 50, 'Thrallia', { character: 'Thrallia', role: 'h', status: 'n' });
  h.imp([forged], { via: { [`su:k3f9a2:${ME_PID}`]: `Jaina,${NOW + 60},m` } });
  const st = await h.srv.api.get('/api/share/status');
  assert.equal(st.status, 200);
  assert.deepEqual(st.body.authorChecks.map((c) => [c.summary, c.via]), [['Sign-up for Molten Core Thursday: not coming as healer', 'Jaina']]);
  assert.equal(h.row('SELECT status FROM signups').status, 'no', 'nothing happens by itself');
  const id = st.body.authorChecks[0].id;
  const undo = await h.srv.api.post(`/api/share/author-checks/${id}`, { action: 'undo' });
  assert.equal(undo.status, 200);
  assert.equal(h.row('SELECT status FROM signups').status, 'yes', 'my previous version again');
  const entry = sharing.exportOutbox(h.db).find((e) => e.id === `su:k3f9a2:${ME_PID}`);
  assert.ok(entry && /\^y\^/.test(`^${entry.body}^`));
  assert.equal(entry.base, S.parse(forged).v);
  assert.equal((await h.srv.api.post(`/api/share/author-checks/${id}`, { action: 'mine' })).status, 404, 'handled once');
  // "It was me" on another one.
  h.setNow(NOW + 300);
  h.imp([rec('AN', 'q2w8zz', NOW + 200, 'Thrallia', { body: 'from my laptop' })], { via: { 'AN:q2w8zz': `Thrallia,${NOW + 200},d` } });
  const c2 = (await h.srv.api.get('/api/share/status')).body.authorChecks[0];
  assert.equal(c2.summary, 'Notice: from my laptop');
  assert.equal((await h.srv.api.post(`/api/share/author-checks/${c2.id}`, { action: 'mine' })).status, 200);
  assert.deepEqual((await h.srv.api.get('/api/share/status')).body.authorChecks, []);
  // Records the addon builds itself (ch, rc ...) and records from before this computer shared are never flagged.
  h.imp([rec('ch', 'Thrallia', NOW + 250, 'Thrallia', { pid: ME_PID, alts: ['Thrallia'] }), rec('AN', 'old111', NOW - 30 * D, 'Thrallia', { body: 'old' })],
    { via: { 'ch:Thrallia': `Jaina,${NOW},m`, 'AN:old111': `Jaina,${NOW},t` } });
  assert.deepEqual((await h.srv.api.get('/api/share/status')).body.authorChecks, []);
});

// ------------------------------------------------------------------------------------------ webhook
test('shared webhook: offered to officers only; accept gives the url once; officers share theirs over OFFICER', async (t) => {
  const h = await setupShare(t, { role: 'officer' });
  h.imp([...CHS, rec('WH', '1', NOW - 60, 'Varok', { url: WEBHOOK })]);
  let s = (await h.srv.api.get('/api/share/status')).body;
  assert.deepEqual(s.webhookOffer, { from: 'Varok', at: new Date((NOW - 60) * 1000).toISOString() });
  assert.match(h.row("SELECT detail FROM audit_log WHERE action = 'from the guild' ORDER BY id DESC").detail, /^Varok shared a Discord webhook\.$/);
  const acc = await h.srv.api.post('/api/share/webhook/accept', {});
  assert.deepEqual(acc.body, { url: WEBHOOK });
  s = (await h.srv.api.get('/api/share/status')).body;
  assert.equal(s.webhookOffer, null);
  assert.equal((await h.srv.api.post('/api/share/webhook/accept', {})).status, 404);
  // A newer one is offered again; dismiss.
  h.imp([rec('WH', '1', NOW - 30, 'Grommash', { url: `${WEBHOOK}2` })]);
  assert.equal((await h.srv.api.get('/api/share/status')).body.webhookOffer.from, 'Grommash');
  assert.equal((await h.srv.api.post('/api/share/webhook/dismiss', {})).status, 200);
  assert.equal((await h.srv.api.get('/api/share/status')).body.webhookOffer, null);
  // Sharing mine needs one in Settings.
  assert.equal((await h.srv.api.post('/api/share/webhook/share', {})).status, 400);
  h.settings.discordWebhook = WEBHOOK;
  const share = await h.srv.api.post('/api/share/webhook/share', {});
  assert.equal(share.status, 200);
  assert.deepEqual(sharing.exportOutbox(h.db).filter((e) => e.id === 'WH:1').map((e) => ({ ...e, op: 0, t: 0 })),
    [{ op: 0, g: G, id: 'WH:1', t: 0, need: 'o', base: S.parse(rec('WH', '1', NOW - 30, 'Grommash', { url: `${WEBHOOK}2` })).v, chan: 'OFFICER', body: WEBHOOK.replace(/[~^;,#|]/g, (c) => `~${c.charCodeAt(0).toString(16).toUpperCase()}`) }]);
});

test('shared webhook: a member\'s app keeps none, and gets it once promoted', async (t) => {
  const h = await setupShare(t, { role: 'member' });
  h.imp([...CHS, rec('WH', '1', NOW - 60, 'Varok', { url: WEBHOOK })]);
  assert.equal(h.stored('WH:1').reason, 'officers only');
  assert.equal((await h.srv.api.get('/api/share/status')).body.webhookOffer, null);
  assert.equal((await h.srv.api.post('/api/share/webhook/share', {})).status, 403);
  h.imp([rec('CFG', '1', NOW - 30, 'Grommash', { officerRankMax: 4 })]); // my rank 4 is an officer rank now
  h.imp([]);
  assert.equal(h.stored('WH:1').state, 'ok');
  assert.equal((await h.srv.api.get('/api/share/status')).body.webhookOffer.from, 'Varok');
});

// ------------------------------------------------------------------------------------------ settings
test('guild settings: officer and relay ranks from the Guild Master; roles follow; the guild JSON shows them', async (t) => {
  const h = await setupShare(t, { role: 'member' });
  h.imp(CHS);
  const roleOf = (p) => h.row('SELECT m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.bnet_id = ?', `pid:${p}`).role;
  assert.equal(roleOf(PIDS.Jaina), 'member');
  h.imp([rec('CFG', '1', NOW - 60, 'Grommash', { officerRankMax: 3, relayRankMax: null })]);
  assert.equal(roleOf(PIDS.Jaina), 'officer');
  assert.equal(roleOf(PIDS.Grommash), 'owner');
  const me = await h.srv.api.get('/api/me');
  assert.equal(me.body.guild.officer_rank_max, 3);
  assert.equal(me.body.guild.relay_rank_max, null);
  h.imp([rec('CFG', '1', NOW - 30, 'Grommash', { officerRankMax: 1, relayRankMax: 2 })]);
  assert.equal(roleOf(PIDS.Jaina), 'member');
  assert.equal((await h.srv.api.get('/api/me')).body.guild.relay_rank_max, 2);
  assert.ok(h.rows("SELECT detail FROM audit_log WHERE action = 'rank demote'").some((r) => /^Jaina: member/.test(r.detail)));
});

// ------------------------------------------------------------------------------------------ LY writer
test('SR+ checkpoint: an officer\'s app writes an LY folding exactly the closes and awards older than 30 days', async (t) => {
  const old = NOW - 40 * D;
  const close = rec('RT', 'k3f9a2', old, 'Grommash', { status: 'd', lockedAt: old - 600, kind: 'r', instance: IK, closedAt: old,
    attendees: [{ pid: PIDS.Zuljinne, items: [CLOAK] }, { pid: PIDS.Jaina, items: [GIRDLE] }], noShows: [] }, { final: true });
  const award = rec('LA', 'a1a1a1', old + 60, 'Grommash', { raid: 'k3f9a2', instance: IK, item: GIRDLE, itemName: 'Girdle', character: 'Jaina', pid: PIDS.Jaina, kind: 's' });
  const recent = rec('RT', 'm2m2m2', NOW - 5 * D, 'Grommash', { status: 'd', lockedAt: NOW - 5 * D, kind: 'r', instance: IK, closedAt: NOW - 5 * D,
    attendees: [{ pid: PIDS.Zuljinne, items: [CLOAK] }], noShows: [] }, { final: true });
  const rd = rec('RD', 'k3f9a2', old - D, 'Grommash', { kind: 'r', title: 'MC', instance: MC, startsAt: old, srLimit: 2 });
  const rd2 = rec('RD', 'm2m2m2', NOW - 6 * D, 'Grommash', { kind: 'r', title: 'MC 2', instance: MC, startsAt: NOW - 5 * D, srLimit: 2 });

  const member = await setupShare(t, { role: 'member' });
  member.imp([...CHS, LL, rd, rd2, close, award, recent]);
  assert.equal(sharing.exportOutbox(member.db).length, 0, 'members never write one');

  const h = await setupShare(t, { role: 'officer' });
  const loyaltyBefore = () => h.rows('SELECT user_id, item_id, bonus FROM loyalty ORDER BY user_id, item_id').map((r) => ({ ...r }));
  const r = h.imp([...CHS, LL, rd, rd2, close, award, recent]);
  assert.equal(r.checkpoints, 1);
  const ly = sharing.exportOutbox(h.db).filter((e) => e.id === `LY:${IK}`);
  assert.equal(ly.length, 1);
  assert.equal(ly[0].need, 'o');
  const fields = S.decode(`LY:${IK}^${S.makeVersion(NOW, 'Thrallia')}^Thrallia^^${ly[0].body}`).fields;
  assert.deepEqual(fields, S.loyaltyCheckpoint(IK, [close, award, recent], NOW));
  assert.equal(fields.upto, NOW - 30 * D);
  assert.deepEqual(fields.bonuses, [{ pid: PIDS.Zuljinne, item: CLOAK, bonus: 10 }]);
  const before = loyaltyBefore();
  // Once queued it is not queued again, and the loyalty shown does not change.
  assert.equal(h.imp([]).checkpoints, 0);
  assert.deepEqual(loyaltyBefore(), before);
  assert.equal(before.find((x) => x.bonus === 20) !== undefined, true, 'Zuljinne: two closes with the cloak');
});

// ------------------------------------------------------------------------------------------ prices
test('auction prices are shared once a day: reagents I want and guild bank items, newest price each', async (t) => {
  const h = await setupShare(t, { role: 'member' });
  const day = Math.floor((NOW * 1000 - Date.UTC(2020, 0, 1)) / 86400000);
  h.db.prepare('INSERT INTO wanted_items (user_id, item_id) VALUES (?, 2589), (?, 2592)').run(h.me, h.me);
  h.db.prepare("INSERT INTO guild_bank (guild_id, tab, item_id, count) VALUES (?, 'Mats', 14047, 20)").run(h.gid);
  const prices = { items: [[2589, 120, day], [2589, 150, day - 1], [2592, 300, day - 2], [14047, 80, day], [99999, 5, day]] };
  const up = () => applyPayload(h.db, h.gid, h.me, { prices }, { ctx: h.ctx });
  up();
  const pr = sharing.exportOutbox(h.db).filter((e) => e.id === `pr:${ME_PID}`);
  assert.equal(pr.length, 1);
  const f = S.decode(`pr:${ME_PID}^${S.makeVersion(NOW, 'Thrallia')}^Thrallia^^${pr[0].body}`).fields;
  assert.deepEqual(f, { day, prices: [{ id: 2589, copper: 120 }, { id: 2592, copper: 300 }, { id: 14047, copper: 80 }] });
  up();
  assert.equal(h.outbox().filter((r) => r.rec_id === `pr:${ME_PID}`).length, 1, 'once a day');
  h.setNow(NOW + D);
  up();
  assert.equal(h.outbox().filter((r) => r.rec_id === `pr:${ME_PID}`).length, 2, 'the next day again (the first one replaced)');
  assert.equal(sharing.exportOutbox(h.db).filter((e) => e.id === `pr:${ME_PID}`).length, 1);
});

// ------------------------------------------------------------------------------------------ notifications
test('notifications for guildmates\' new records under 24 hours old; audit lines say who passed them on', async (t) => {
  const h = await setupShare(t, { role: 'officer' });
  h.db.prepare("INSERT INTO recipes (character_id, profession, name) SELECT id, 'Tailoring', 'Robe of Power' FROM characters WHERE name = 'Thrallia'").run();
  h.imp([...CHS, LL]);
  h.imp([
    RD,
    rec('AN', 'q2w8zz', NOW - 120, 'Grommash', { body: 'Bring fire resist' }),
    rec('ca', 'x8k2pq', NOW - 60, 'Zuljinne', { character: 'Zuljinne', zone: 'Crossroads', needed: 5, message: 'help' }),
    rec('ca', 'oldold', NOW - 7200, 'Zuljinne', { character: 'Zuljinne', zone: 'Old', message: 'old call' }),
    rec('cr', 'r1r1r1', NOW - 60, 'Jaina', { pid: PIDS.Jaina, item: 'Robe of Power', notes: 'size M', state: 'o' }),
    rec('cr', 'r2r2r2', NOW - 60, 'Jaina', { pid: PIDS.Jaina, item: 'Something Else', state: 'o' }),
    rec('bq', 'b1b1b1', NOW - 60, 'Jaina', { pid: PIDS.Jaina, item: 'Runecloth', count: 20, state: 'o' }),
    rec('DR', 'd1d1d1', NOW - 2 * D, 'Varok', { title: 'Old drive', unit: 'flasks', goal: 10, state: 'o' }),
    rec('DR', 'd2d2d2', NOW - 60, 'Varok', { title: 'Flasks', unit: 'flasks', goal: 10, state: 'o' }),
  ], { via: { 'RD:k3f9a2': `Varok,${NOW},t` } });
  const kinds = h.events.map((e) => `${e.kind}: ${e.title}`);
  assert.deepEqual(kinds.sort(), [
    'bank: 🏦 Bank request from Jaina', 'cta: ⚔️ Call to arms: Crossroads', 'drive: 📦 Supply drive: Flasks', 'notice: 📜 Guild notice',
    'raid: 🗓️ Molten Core Thursday', 'request: 🔨 Jaina needs Robe of Power',
  ].sort());
  const raidEvent = h.events.find((e) => e.kind === 'raid');
  assert.match(raidEvent.route, /^\/raids\/\d+$/);
  assert.equal(h.row("SELECT detail FROM audit_log WHERE detail LIKE 'Grommash scheduled%'").detail, 'Grommash scheduled Molten Core Thursday (passed on by Varok).');
  // A hand-in that reaches the goal; a cancel of a raid I signed up for.
  h.events.length = 0;
  h.queue({ type: 'su', key: `k3f9a2:${ME_PID}`, fields: { character: 'Thrallia', role: 'h', status: 'y' } });
  h.imp([
    rec('dc', 'c1c1c1', NOW - 30, 'Jaina', { pid: PIDS.Jaina, drive: 'd2d2d2', character: 'Jaina', amount: 12 }),
    rec('RT', 'k3f9a2', NOW - 20, 'Grommash', { status: 'x' }, { final: true }),
  ]);
  assert.deepEqual(h.events.map((e) => `${e.kind}: ${e.title}`).sort(), ['drive: 🎉 Flasks reached its goal', 'raid: ❌ Molten Core Thursday is cancelled']);
});

// ------------------------------------------------------------------------------------------ pid
test('player id: adopted from the addon when the app has none; the app\'s own wins; a second computer adopts mine from my ch', async (t) => {
  const a = await setupShare(t, { pid: null });
  a.imp([], { pid: 'Thrallia.zz99' });
  assert.equal(sharing.myPid(a.db), 'Thrallia.zz99');
  a.imp([], { pid: 'Thrallia.qq11' });
  assert.equal(sharing.myPid(a.db), 'Thrallia.zz99', 'kept once set');

  const b = await setupShare(t, { pid: null });
  b.imp([rec('ch', 'Thrallia', NOW - 60, 'Thrallia', { pid: 'Thrallia.pc22', alts: ['Thrallia'] })], { via: { 'ch:Thrallia': `Jaina,${NOW},m` } });
  assert.equal(sharing.myPid(b.db), 'Thrallia.pc22');

  const c = await setupShare(t, { pid: null });
  const made = sharing.myPid(c.db);
  assert.match(made, /^Thrallia\.[0-9a-z]{4}$/, 'made on my main character');
  assert.equal(sharing.myPid(c.db), made);
});

test('clock skew from the addon moves the app\'s times; other guilds\' partitions are left alone', async (t) => {
  const h = await setupShare(t, { role: 'officer' });
  h.impRaw({ clock: { server: NOW + 120, here: NOW }, guilds: { 'Forever/other': { recs: { [S.parse(RD).id]: RD } } } });
  assert.equal(sharing.serverNow(h.db), NOW + 120);
  assert.equal(h.stored('RD:k3f9a2'), undefined, 'another guild\'s records stay out');
  const q = h.queue({ type: 'AN', key: 'q2w8zz', fields: { body: 'hi' }, need: 'o' });
  assert.equal(h.outbox().find((r) => r.op === q.op).t, NOW + 120);
  // The partition key is the one the addon used.
  h.impRaw({ guilds: { 'forever/WOW': { recs: {} } } });
  assert.equal(sharing.exportOutbox(h.db)[0].g, 'forever/WOW');
});
