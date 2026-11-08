'use strict';
// docs/SHARING.md §13 scenario 13, end to end with the REAL pieces on one virtual clock:
//
//   the app's core (createCore, one per player, in a temp folder) → its HTTP API through main/api.js → the outbox
//   → main/sync.js writes WowGuild_Inbox/Inbox.lua into a fake game folder → the real addon (GuildNet clients)
//   reads it at login or /reload, sends, receives → SavedVariables written to that game folder at logout →
//   main/sync.js uploads them → the core imports them.
//
// Scenarios 5 and 6 run through the same pieces, in every delivery order. Every scenario ends with the §13 rule
// (e2e-kit.js assertSame): equal digests on every online client and, by running the real core on each client's
// SavedVariables, equal domain tables. Nothing here touches a game install, gh or the network.
const test = require('node:test');
const assert = require('node:assert');
const { createE2E } = require('./e2e-kit');
const { makeRecord, sharedDb } = require('./guildnet');
const S = require('../../src/shared/sharing');
const LINES = require('../../src/core/sharing').LINES;

const WEBHOOK = 'https://discord.com/api/webhooks/13/e2e';
const G = 'Forever/wow';
const FINAL_LINE = 'Someone already closed or cancelled this. Check it and try again.';
const iso = (sec) => new Date(sec * 1000).toISOString();
const noErrors = (net) => { for (const c of net.clients) assert.deepStrictEqual(c.errors, [], `${c.name} had no Lua errors`); };
const recOf = (c, id) => c.lua(`local P = ns.Share._.P(); return P and P.recs[${JSON.stringify(id)}]`);
const viaOf = (c, id) => c.lua(`local P = ns.Share._.P(); return P and P.via[${JSON.stringify(id)}]`);
const sentOf = (c) => c.lua('local P = ns.Share._.P(); return P and P.sent') || {};
const outboxOf = (p) => Object.values((p.inbox() || {}).outbox || {});
// The player id an account keeps for the guild (ids are per guild: WowGuildDB.shared.guilds[partition].pid).
const guildPid = (db) => (((db && db.shared && db.shared.guilds) || {})[G] || {}).pid;
// A minute of play (logins, hellos, exchanges), then until every online store is the same.
const settle = (net) => {
  net.run(60);
  assert.ok(net.runUntil(() => net.converged(), { max: 900, step: 5 }), `converged: ${JSON.stringify(net.digests())}`);
};

// The guild of scenario 13: Thrall (Guild Master), Grom (an officer who plays a member alt on one account and his
// officer on another, on one PC) and Zul (a member on a retail client).
async function guildOf(t, { seed = 13 } = {}) {
  const kit = await createE2E(t, { seed });
  const thrall = await kit.player('Thrall', { accounts: { THRALL: [['Thrall', { rank: 0 }]] } });
  const grom = await kit.player('Grom', {
    accounts: { GROM: [['Grommalt', { rank: 3 }]], GROMB: [['Grommash', { rank: 1 }]] },
    settings: { discordWebhook: WEBHOOK },
  });
  const zul = await kit.player('Zul', { accounts: { ZUL: [['Zuljin', { rank: 3, interface: 120105 }]] } });
  const everyone = [[thrall, 'Thrall'], [grom, 'Grommalt'], [grom, 'Grommash'], [zul, 'Zuljin']];
  return { kit, net: kit.net, thrall, grom, zul, everyone };
}

// Everyone plays once, then every app has synced: the apps know the guild, the ranks and each other.
async function playOnce({ net, everyone }, seconds = 30) {
  for (const [p, n] of everyone) p.login(n);
  net.run(seconds);
  for (const [p, n] of everyone) await p.logout(n);
}

test('scenario 13: an officer\'s raid waits on a member character, goes out on an officer character, a sign-up comes back, and two accounts become one player', async (t) => {
  const { kit, net, thrall, grom, zul, everyone } = await guildOf(t);

  // 1. Everyone plays before any app wrote an inbox: each account makes its own player id (after the grace
  //    period that waits for guildmates' copies). Grom's two accounts get two ids.
  for (const [p, n] of everyone) p.login(n);
  net.run(120);
  const before = { GROM: guildPid(grom.c('Grommalt').db()), GROMB: guildPid(grom.c('Grommash').db()) };
  assert.ok(S.pidOk(before.GROM) && S.pidOk(before.GROMB) && before.GROM !== before.GROMB, `two ids: ${JSON.stringify(before)}`);
  for (const [p, n] of everyone) await p.logout(n);

  // The apps found the guild; roles come from the in-game ranks (Grom: his best character, Grommash).
  assert.strictEqual((await thrall.api('GET', '/api/me')).role, 'owner');
  assert.strictEqual((await grom.api('GET', '/api/me')).role, 'officer');
  assert.strictEqual((await zul.api('GET', '/api/me')).role, 'member');
  // Grom's app took one of the ids and hands it, with both characters, to every account through the inbox.
  const gromPid = (await grom.api('GET', '/api/share/status')).pid;
  assert.ok([before.GROM, before.GROMB].includes(gromPid), gromPid);
  const me = grom.inbox().me;
  assert.strictEqual(me.pid, gromPid);
  assert.deepStrictEqual([...Object.values(me.alts)].sort(), ['Grommalt', 'Grommash']);

  // 2. Grom schedules a raid in his app. The page shows it at once, and the core's 'outbox' event rewrites the
  //    inbox with no upload in between.
  assert.deepStrictEqual(outboxOf(grom), []);
  const startsAt = Math.floor(net.now()) + 3 * 86400;
  const made = await grom.api('POST', '/api/raids', { kind: 'raid', title: 'Molten Core Thursday', instance: 'Molten Core', starts_at: iso(startsAt), size: 40, sr_limit: 2 });
  assert.strictEqual(made.message, 'Raid scheduled.');
  assert.strictEqual((await grom.api('GET', '/api/raids')).upcoming.length, 1, 'shown at once');
  await grom.flush();
  const out1 = outboxOf(grom);
  assert.strictEqual(out1.length, 1);
  assert.deepStrictEqual([out1[0].g, out1[0].need], [G, 'o']);
  assert.match(out1[0].id, /^RD:[0-9a-z]{6}$/);
  const rdId = out1[0].id;
  const raidKey = rdId.slice(3);
  let st = await grom.api('GET', '/api/share/status');
  assert.deepStrictEqual(st.outbox.map((e) => [e.id, e.state, e.note]), [[rdId, 'queued', LINES.saved]]);

  // 3. Grom logs in on his member alt: the entry waits (wait,officer) and the game says why.
  grom.login('Grommalt');
  thrall.login('Thrall');
  zul.login('Zuljin');
  net.run(60);
  assert.ok(grom.c('Grommalt').chat.some((l) => l.includes('1 officer change is waiting. Log in on an officer character to send it.')),
    grom.c('Grommalt').chat.join('\n'));
  assert.strictEqual(recOf(zul.c('Zuljin'), rdId), null, 'nothing went out');
  await grom.logout('Grommalt');
  assert.strictEqual(grom.c('Grommalt').sv().shared.guilds[G].sent[out1[0].op], 'wait,officer');
  st = await grom.api('GET', '/api/share/status');
  assert.deepStrictEqual(st.outbox.map((e) => [e.id, e.state, e.note]), [[rdId, 'waiting', LINES.officer]], 'a plain note in /api/share/status');
  assert.strictEqual(outboxOf(grom).length, 1, 'still in the inbox');

  // 4. On his officer character it goes out; guildmates online take it first-hand.
  grom.login('Grommash');
  net.run(60);
  assert.match(viaOf(zul.c('Zuljin'), rdId), /^Grommash,\d+,d$/);
  assert.ok(recOf(thrall.c('Thrall'), rdId));
  // The account that just logged in adopted the app's player id from the inbox: the two accounts are one player.
  assert.strictEqual(guildPid(grom.c('Grommash').db()), gromPid);
  await grom.logout('Grommash');
  assert.match(grom.c('Grommash').sv().shared.guilds[G].sent[out1[0].op], /^ok,[0-9a-z]{8},Grommash$/);
  st = await grom.api('GET', '/api/share/status');
  assert.deepStrictEqual(st.outbox.map((e) => [e.id, e.state]), [[rdId, 'sent']]);
  // The acknowledged entry is dropped from the next inbox, and the app posts to Discord now that it went out.
  assert.deepStrictEqual(outboxOf(grom), []);
  await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(grom.discord.length, 1, grom.discord.join('\n'));
  assert.match(grom.discord[0], /Molten Core Thursday/);
  // The addon forgets the acknowledgement once the app dropped the entry.
  grom.login('Grommash');
  net.run(20);
  assert.strictEqual(sentOf(grom.c('Grommash'))[out1[0].op], undefined);

  // 5. Zul's app shows the raid after his next logout; he signs up in it, and it goes out at his next login.
  await zul.logout('Zuljin');
  const zr = (await zul.api('GET', '/api/raids')).upcoming;
  assert.deepStrictEqual(zr.map((r) => [r.title, r.status]), [['Molten Core Thursday', 'open']]);
  const signed = await zul.api('POST', `/api/raids/${zr[0].id}/signup`, { character: 'Zuljin', role: 'healer', status: 'yes', note: 'late 10 min' });
  assert.strictEqual(signed.message, 'You’re signed up.');
  await zul.flush();
  const zout = outboxOf(zul);
  const zulPid = (await zul.api('GET', '/api/share/status')).pid;
  assert.deepStrictEqual(zout.map((e) => [e.id, e.need]), [[`su:${raidKey}:${zulPid}`, undefined]], 'a member change needs no officer');
  zul.login('Zuljin');
  net.run(60);
  await zul.logout('Zuljin');
  assert.deepStrictEqual((await zul.api('GET', '/api/share/status')).outbox.map((e) => e.state), ['sent']);
  await grom.logout('Grommash');
  const detail = await grom.api('GET', `/api/raids/${made.raid.id}`);
  assert.deepStrictEqual(detail.signups.map((s) => [s.character, s.role, s.status, s.note]), [['Zuljin', 'healer', 'yes', 'late 10 min']]);

  // 6. The merge, seen from guildmates' apps: both of Grom's characters belong to one player.
  grom.login('Grommalt'); // the anchor's ch now lists both characters
  zul.login('Zuljin');
  net.run(60);
  for (const [p, n] of [[grom, 'Grommalt'], [zul, 'Zuljin'], [thrall, 'Thrall']]) await p.logout(n);
  assert.strictEqual(guildPid(grom.c('Grommalt').sv()), gromPid);
  for (const p of [zul, thrall]) {
    const chars = p.db.prepare("SELECT name, user_id FROM characters WHERE name IN ('Grommalt','Grommash')").all();
    assert.strictEqual(chars.length, 2);
    assert.strictEqual(chars[0].user_id, chars[1].user_id, `${p.name}: one player for both characters`);
    assert.strictEqual(p.db.prepare('SELECT bnet_id FROM users WHERE id = ?').get(chars[0].user_id).bnet_id, `pid:${gromPid}`);
    const members = (await p.api('GET', '/api/members')).members;
    assert.strictEqual(members.length, 3, `${p.name}: Grom's old second id is not a guildmate of its own: ${JSON.stringify(members.map((m) => m.name))}`);
  }

  // §13: everyone online until the stores agree, then every app holds the same guild.
  for (const [p, n] of [[thrall, 'Thrall'], [grom, 'Grommash'], [zul, 'Zuljin']]) p.login(n);
  settle(net);
  const tables = await kit.assertSame([thrall, grom, zul]);
  assert.strictEqual(tables.signups.length, 1);
  assert.strictEqual(tables.raids.length, 1);
  noErrors(net);
});

test('scenario 13: stale edits from the app are refused in game and rolled back with the plain message', async (t) => {
  const g = await guildOf(t, { seed: 31 });
  const { kit, net, thrall, grom, zul } = g;
  await playOnce(g);
  // A raid everyone knows.
  const made = await grom.api('POST', '/api/raids', { kind: 'raid', title: 'Blackwing Lair', instance: 'Blackwing Lair', starts_at: iso(Math.floor(net.now()) + 2 * 86400) });
  const gRaid = made.raid.id;
  await grom.flush();
  grom.login('Grommash');
  thrall.login('Thrall');
  net.run(60);
  await grom.logout('Grommash');
  await thrall.logout('Thrall');
  const tRaid = (await thrall.api('GET', '/api/raids')).upcoming[0];
  assert.strictEqual(tRaid.status, 'open');

  // Thrall plays while Grom locks and then reopens the raid in his app; Thrall's app sees neither.
  thrall.login('Thrall');
  await grom.api('POST', `/api/raids/${gRaid}/lock`);
  await grom.flush();
  grom.login('Grommash');
  net.run(30);
  await grom.api('POST', `/api/raids/${gRaid}/unlock`);
  await grom.flush();
  await grom.reload('Grommash');
  net.run(30);
  // From his stale copy (open, no status yet) Thrall locks it in his app. His page shows it locked at once.
  const locked = await thrall.api('POST', `/api/raids/${tRaid.id}/lock`);
  assert.strictEqual(locked.raid.status, 'locked');
  await thrall.flush();
  // His /reload sends it: the game holds a newer status than the one his app edited, so it refuses (no,stale).
  await thrall.reload('Thrall');
  net.run(10);
  await thrall.logout('Thrall');
  assert.deepStrictEqual(Object.values(thrall.c('Thrall').sv().shared.guilds[G].sent), ['no,stale'], 'refused in game');
  let st = await thrall.api('GET', '/api/share/status');
  assert.deepStrictEqual(st.refused.map((e) => e.note), [LINES.stale]);
  assert.deepStrictEqual(st.outbox.filter((e) => e.state !== 'sent'), []);
  // Rolled back: his app shows Grom's last change (reopened), and nothing of his is left to send.
  assert.strictEqual((await thrall.api('GET', `/api/raids/${tRaid.id}`)).raid.status, 'open');
  assert.deepStrictEqual(outboxOf(thrall), []);

  // A final edit already stands: Grom closes the raid; Thrall, not synced since, locks it from his copy.
  thrall.login('Thrall');
  const closed = await grom.api('POST', `/api/raids/${gRaid}/close`, { attendee_user_ids: [] });
  assert.match(closed.message, /^Raid closed\./);
  await grom.flush();
  await grom.reload('Grommash');
  net.run(30);
  await thrall.api('POST', `/api/raids/${tRaid.id}/lock`);
  await thrall.flush();
  await thrall.reload('Thrall');
  net.run(10);
  await thrall.logout('Thrall');
  assert.deepStrictEqual(Object.values(thrall.c('Thrall').sv().shared.guilds[G].sent), ['no,final'], 'the game refused it too');
  st = await thrall.api('GET', '/api/share/status');
  assert.deepStrictEqual(st.refused.map((e) => e.note).sort(), [LINES.stale, FINAL_LINE].sort());
  assert.strictEqual((await thrall.api('GET', `/api/raids/${tRaid.id}`)).raid.status, 'done');

  for (const [p, n] of [[thrall, 'Thrall'], [zul, 'Zuljin']]) p.login(n);
  settle(net);
  await kit.assertSame([thrall, grom, zul]);
  noErrors(net);
});

test('scenario 13: a wiped WTF folder is seeded from the app with no bulk traffic', async (t) => {
  const g = await guildOf(t, { seed: 77 });
  const { kit, net, thrall, grom, zul } = g;
  await playOnce(g);
  // Guild life the stores hold: raids and notices from the officer's app, crafting requests from a member's.
  for (let i = 0; i < 6; i++) {
    await grom.api('POST', '/api/raids', { kind: 'raid', title: `Raid night ${i + 1}`, instance: 'Molten Core', starts_at: iso(Math.floor(net.now()) + (i + 1) * 86400) });
    await grom.api('POST', '/api/announcements', { body: `Notice ${i + 1}: bring flasks and fire resistance.` });
  }
  for (let i = 0; i < 6; i++) await zul.api('POST', '/api/requests', { item: `Item ${i + 1}`, notes: 'mats in the mail' });
  await grom.flush();
  await zul.flush();
  const trio = [[grom, 'Grommash'], [zul, 'Zuljin'], [thrall, 'Thrall']];
  for (const [p, n] of trio) p.login(n);
  settle(net);
  for (const [p, n] of trio) await p.logout(n);
  const total = thrall.db.prepare("SELECT COUNT(*) AS n FROM shared_records WHERE state = 'ok'").get().n;
  assert.ok(total >= 18, `records: ${total}`);
  assert.deepStrictEqual(Object.values(thrall.inbox().seed || {}), [], 'no seed while his store is full');

  // Thrall's WTF folder is wiped (a reinstall). He logs in once alone; his store is nearly empty.
  thrall.wipeAccount('THRALL');
  thrall.login('Thrall');
  net.run(30);
  await thrall.logout('Thrall');
  const inbox = thrall.inbox();
  const seed = Object.values(inbox.seed || {});
  assert.ok(seed.length >= total - 5, `seeded ${seed.length} of ${total}`);
  assert.strictEqual(inbox.seedG, G);

  // At his next login with guildmates online, the store is loaded from the seed, so almost nothing travels.
  for (const [p, n] of [[grom, 'Grommash'], [zul, 'Zuljin']]) p.login(n);
  net.run(60);
  net.resetStats();
  thrall.login('Thrall');
  settle(net);
  net.run(60);
  // Guildmates send none of the seeded versions (id^v) to him; only what changed since travels (his own new ch).
  const seededIds = new Set(seed.map((r) => r.slice(0, r.indexOf('^'))));
  const seededVersions = seed.map((r) => r.split('^', 2).join('^'));
  const resent = net.log.filter((e) => e.from !== 'Thrall' && (e.type === '1R' || e.type === '1M') && seededVersions.some((iv) => e.text.includes(iv)));
  assert.deepStrictEqual(resent.map((e) => e.text.slice(0, 40)), [], 'seeded records are not sent again');
  const records = net.log.filter((e) => e.type === '1R' || e.type === '1M');
  assert.ok(records.length <= 6, `records sent after the seeded login: ${records.map((e) => e.text.slice(2, 30)).join(' | ')}`);
  const stats = net.stats();
  assert.ok(stats.sent <= 30, `messages after the seeded login: ${stats.sent} ${JSON.stringify(stats.perType)}`);
  assert.match(viaOf(thrall.c('Thrall'), [...seededIds].find((id) => id.startsWith('RD:'))), /,s$/, 'loaded from the seed');
  await kit.assertSame([thrall, grom, zul]);
  noErrors(net);
});

test('scenario 13: a guildmate\'s call to arms shows in chat at once and reaches every app', async (t) => {
  const g = await guildOf(t, { seed: 5 });
  const { kit, net, thrall, grom, zul } = g;
  await playOnce(g);
  const trio = [[thrall, 'Thrall'], [zul, 'Zuljin'], [grom, 'Grommash']];
  for (const [p, n] of trio) p.login(n);
  net.run(60);
  const at = net.now();
  zul.c('Zuljin').lua('SlashCmdList.WOWGUILD("cta Crossroads 5 Alliance at the flight master")');
  net.run(2);
  const line = thrall.c('Thrall').chatLog.find((e) => e.text.includes('Call to arms from Zuljin in Crossroads, 5 needed: Alliance at the flight master'));
  assert.ok(line && line.t - at <= 2, `Thrall's chat: ${thrall.c('Thrall').chat.slice(-3).join(' | ')}`);
  // One made in Thrall's app goes out at his next /reload and lands in chat at once too.
  await thrall.api('POST', '/api/ctas', { zone: 'Tarren Mill', needed: 10, message: 'Defend the inn' });
  await thrall.flush();
  const at2 = net.now();
  await thrall.reload('Thrall');
  net.run(3);
  const line2 = zul.c('Zuljin').chatLog.find((e) => e.text.includes('Call to arms from Thrall in Tarren Mill'));
  assert.ok(line2 && line2.t - at2 <= 3, `Zul's chat: ${zul.c('Zuljin').chat.slice(-3).join(' | ')}`);
  for (const [p, n] of trio) await p.logout(n);
  for (const p of [thrall, grom, zul]) {
    const ctas = (await p.api('GET', '/api/camp')).ctas;
    assert.deepStrictEqual(ctas.map((c) => c.zone).sort(), ['Crossroads', 'Tarren Mill'], p.name);
  }
  for (const [p, n] of trio) p.login(n);
  settle(net);
  await kit.assertSame([thrall, grom, zul]);
  noErrors(net);
});

// ---------------------------------------------------------------------------------------------------------------
// Scenarios 5 and 6: officers' records reach a member in every order. Each officer holds its own records (in its
// SavedVariables, as after a session that wrote them) and logs in alone, in the order given, while the member
// plays; the member's real app syncs after each arrival (a /reload), so the app imports them in that order too.
// Then everyone plays together until the stores agree and the §13 rule runs on every client.
async function deliverInOrder(t, { seed, groups, order, member = 'Orgrim', startTime, afterEach }) {
  const kit = await createE2E(t, { seed, net: { startTime } });
  const { net } = kit;
  const officers = new Map();
  for (const g of groups) {
    officers.set(g.name, net.client(g.author, { rank: 1, savedVariables: sharedDb(g.records(net.now()), { via: g.author, at: Math.floor(net.now()) - 60 }) }));
  }
  const obs = await kit.player(member, { accounts: { [member.toUpperCase()]: [[member, { rank: 3, interface: 120105 }]] } });
  obs.login(member);
  net.run(30);
  await obs.reload(member);
  for (const name of order) {
    const c = officers.get(name);
    c.login();
    // Both just logged in (the member reloaded), so each defers its answer to a catch-up hello (§8, 2 min).
    net.run(200);
    c.logout();
    await obs.reload(member);
    if (afterEach) await afterEach(obs, order.slice(0, order.indexOf(name) + 1));
  }
  for (const c of officers.values()) c.login();
  settle(net);
  const tables = await kit.assertSame([obs], { label: `order ${order.join(', ')}: ` });
  noErrors(net);
  return { tables, obs };
}

const ORDERS = (names) => permutations(names);
function permutations(list) {
  if (list.length <= 1) return [list];
  const out = [];
  list.forEach((x, i) => { for (const rest of permutations([...list.slice(0, i), ...list.slice(i + 1)])) out.push([x, ...rest]); });
  return out;
}

test('scenario 5: cancel, close and lock of one raid by three officers, every delivery order: the earliest final wins everywhere', async (t) => {
  const key = 'k5r5d5';
  // The cancel came first (earliest final), then a close from a stale copy, then a lock from an older one.
  const groups = [
    { name: 'cancel', author: 'Grommash', records: (now) => [
      makeRecord({ type: 'RD', key, t: now - 900, author: 'Grommash', fields: { kind: 'r', title: 'Onyxia Friday', instance: "Onyxia's Lair", startsAt: now + 86400, minutes: 120, size: 40, srLimit: 1 } }),
      makeRecord({ type: 'RT', key, t: now - 600, author: 'Grommash', fields: { status: 'x' } }),
    ] },
    { name: 'close', author: 'Saurfang', records: (now) => [
      makeRecord({ type: 'RT', key, t: now - 500, author: 'Saurfang', fields: { status: 'd', kind: 'r', instance: S.instanceKey("Onyxia's Lair"), closedAt: now - 500, attendees: [{ pid: 'Varok.7tq3', items: [] }], noShows: [] } }),
    ] },
    { name: 'lock', author: 'Varok', records: (now) => [
      makeRecord({ type: 'RT', key, t: now - 400, author: 'Varok', fields: { status: 'l', lockedAt: now - 400 } }),
    ] },
  ];
  const orders = ORDERS(groups.map((g) => g.name));
  const startTime = Math.floor(Date.now() / 1000); // every order starts at the same moment
  let first = null;
  for (const [i, order] of orders.entries()) {
    const { tables } = await deliverInOrder(t, {
      seed: 500 + i, groups, order, startTime,
      // After each arrival the member's app shows what those records say (§4.4: the earliest final wins).
      afterEach: async (obs, arrived) => {
        const rts = groups.filter((g) => arrived.includes(g.name)).flatMap((g) => g.records(startTime)).filter((r) => r.startsWith('RT:'));
        const best = rts.reduce((a, b) => (!a || S.compareRecords(b, a) > 0 ? b : a), null);
        // No raid row before its RD (it comes with the cancel); then the status the best RT so far gives.
        const want = arrived.includes('cancel') ? [S.raidStatus(best).status] : [];
        const rows = obs.db.prepare('SELECT status FROM raids').all().map((r) => r.status);
        assert.deepStrictEqual(rows, want, `order ${order.join(', ')}, after ${arrived.join(', ')}`);
      },
    });
    assert.deepStrictEqual(tables.raids.map((r) => [r.key, r.status]), [[key, 'cancelled']], `order ${order.join(', ')}`);
    assert.deepStrictEqual(tables.attendance, [], 'a cancelled raid records no attendance');
    const same = { ...tables, players: null }; // player ids are random per run
    if (!first) first = same;
    else assert.deepStrictEqual(same, first, `order ${order.join(', ')} ends like order ${orders[0].join(', ')}`);
  }
});

test('scenario 6: awards, closes and a checkpoint in every order (awards after the close too): loyalty as in the old raid tests', async (t) => {
  // The old server's raid test fixtures (test/fixtures/sharing-vectors.json "fold"), moved to this week, with the
  // checkpoint written by a third officer so each kind of record comes from its own officer.
  const vectors = require('../fixtures/sharing-vectors.json').fold;
  const cases = process.env.GUILDCAMP_SIM_HEAVY === '1'
    ? vectors.filter((v) => v.records.some((r) => r.startsWith('LA:')) && v.records.some((r) => r.startsWith('RT:')))
    : vectors.filter((v) => v.name.startsWith('week 2'));
  assert.ok(cases.length >= 1);
  for (const fx of cases) {
    const ik = fx.instance;
    const tmax = Math.max(...fx.records.map((r) => S.decode(r).t));
    const shift = (now) => Math.floor(now) - 3 * 86400 - tmax;
    const moved = (now, type) => fx.records.map((r) => S.decode(r)).filter((d) => d.type === type).map((d) => {
      const D = shift(now);
      const fields = { ...d.fields };
      if (type === 'LY') fields.upto += D;
      if (type === 'RT') fields.closedAt += D;
      const author = type === 'LY' ? 'Saurfang' : d.author;
      return makeRecord({ type: d.type, key: d.key, t: d.t + D, author, fields });
    });
    const itemNames = { ntj: 'Frost Greaves', ntw: 'Night Cloak' };
    const groups = [
      { name: 'awards', author: 'Velanne', records: (now) => moved(now, 'LA') },
      { name: 'closes', author: 'Grim', records: (now) => moved(now, 'RT') },
      { name: 'checkpoint', author: 'Saurfang', records: (now) => [
        makeRecord({ type: 'LL', key: ik, t: Math.floor(now) - 40 * 86400, author: 'Saurfang', fields: { name: 'Winter Halls', bosses: ['The Frost King'],
          items: Object.entries(itemNames).map(([item, name]) => ({ item, boss: 1, name })) } }),
        ...moved(now, 'LY'),
      ] },
    ];
    // The fixture's expectation still holds for the moved records.
    const sample = [...groups[0].records(1794066000), ...groups[1].records(1794066000), ...groups[2].records(1794066000)];
    assert.deepStrictEqual(S.loyaltyFold(ik, sample).bonuses, fx.expect, `${fx.name}: fold of the moved records`);
    // Loyalty rows need the instance's loot list (it comes with the checkpoint); only its items get rows.
    const rowsOf = (bonuses) => {
      const out = [];
      for (const [pid, byItem] of Object.entries(bonuses)) for (const [item, bonus] of Object.entries(byItem)) if (itemNames[item] && bonus > 0) out.push({ who: pid, item, bonus });
      return out.sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
    };
    const loyaltyOf = (tables) => tables.loyalty.map((l) => ({ who: l.who, item: l.item, bonus: l.bonus }))
      .sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
    const want = rowsOf(fx.expect);
    const startTime = Math.floor(Date.now() / 1000);
    for (const [i, order] of ORDERS(groups.map((g) => g.name)).entries()) {
      const { tables } = await deliverInOrder(t, {
        seed: 600 + i, groups, order, startTime,
        // After each arrival the member's app holds the fold of what arrived so far (awards after the close too).
        afterEach: async (obs, arrived) => {
          const recs = groups.filter((g) => arrived.includes(g.name)).flatMap((g) => g.records(startTime));
          const now = arrived.includes('checkpoint') ? rowsOf(S.loyaltyFold(ik, recs).bonuses) : [];
          assert.deepStrictEqual(loyaltyOf(obs.tables()), now, `${fx.name}, order ${order.join(', ')}, after ${arrived.join(', ')}`);
        },
      });
      assert.deepStrictEqual(loyaltyOf(tables), want, `${fx.name}, order ${order.join(', ')}`);
    }
  }
});
