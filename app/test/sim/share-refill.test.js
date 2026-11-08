'use strict';
// Refills (docs/SHARING.md §8): a guildmate whose store is empty again soon after the guild pushed it the whole store
// (the game crashed before saving, the WTF folder was wiped, another PC) gets it back, and a made-up "my store is
// empty" hello, repeated, costs the guild only an inventory round now and then. The two look the same on the wire.
// The real addon on GuildNet; no game install.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createGuildNet, sharedDb, guildStore, digestsOf } = require('./guildnet');
const { toLua } = require('./wowsim');
const SJ = require('../../src/shared/sharing');

const send = (c, msg, chan = 'GUILD') => c.lua(`return C_ChatInfo.SendAddonMessage("GuildCamp", ${toLua(msg)}, ${toLua(chan)})`);
const quiet = (c) => { c.lua('if ns.Collect then ns.Collect.sharedRecords = nil; ns.Collect.offerAll = function() end end'); return c; };
const noErrors = (net) => { for (const c of net.clients) assert.deepEqual(c.errors, [], `${c.name} had no Lua errors`); };
const zeroHello = SJ.encodeHello({ minor: 1, count: 0, digests: new Array(SJ.K.BUCKETS).fill(0), addon: '0.11.0' });
// Messages the guild (everyone but Sneaky) sent since the last resetStats.
const guildSent = (net) => Object.entries(net.stats().perSender).filter(([n]) => n !== 'Sneaky').reduce((a, [, v]) => a + v.sent, 0);

test('trust-4: Sneaky joins, then repeats an all-zero hello every 10 minutes for 8 hours; the guild sends on average at most 60 messages per 10 minutes (the whole store when he joined included), never the whole store again, a refill now and then, from the fourth hour on no more than twice what it sends without him, and a real newcomer still gets all of it', () => {
  const net = createGuildNet({ seed: 9 });
  const store = guildStore({ now: net.now() });
  ['Grommash', 'Saurfang', 'Zuljin', 'Varok'].forEach((n, i) => quiet(net.client(n, { rank: i < 2 ? 1 : 3, savedVariables: sharedDb(store), inbox: { me: { pid: `${n}.aaaa` } } }).login()));
  net.run(600);
  net.resetStats();
  net.run(1800);
  const baseline = Math.max(1, Math.ceil(guildSent(net) / 3)); // per 10 quiet minutes (the beacon)
  // His own login hello is all-zero too: the whole store, pushed (§7: about 1,100 messages).
  const sneaky = quiet(net.client('Sneaky', { rank: 3, inbox: { me: { pid: 'Sneaky.s000' } } }).login());
  const rounds = [];
  for (let round = 0; round < 48; round++) {
    net.resetStats();
    if (round > 0) send(sneaky, zeroHello);
    net.run(600);
    rounds.push(guildSent(net));
  }
  const avg = rounds.reduce((a, b) => a + b, 0) / rounds.length;
  const shown = `${rounds.join(', ')} (baseline ${baseline} per 10 minutes)`;
  assert.ok(rounds[0] > 900, `he got the whole store when he joined: ${rounds[0]} messages`);
  assert.ok(avg <= 60, `on average ${avg.toFixed(1)} messages per 10 minutes: ${shown}`);
  // His empty store looks like a guildmate's whose game crashed before saving: a refill (the guild's inventory, ~100
  // messages) now and then. He never asks for anything with it, so each one makes him wait longer for the next.
  // Without the refills' limits, an inventory round every 40 minutes; with the old 16-hour guard, none, but a real
  // newcomer whose game crashed twice then waited 16 hours.
  const later = rounds.slice(1);
  assert.ok(later.every((n) => n < 300), `never the whole store again: ${shown}`);
  assert.ok(later.filter((n) => n > 2 * baseline).length <= 5, `at most 5 refills in 8 hours: ${shown}`);
  assert.ok(rounds.slice(24).every((n) => n <= 2 * baseline), `from the fourth hour on, nothing more: ${shown}`);
  // A real newcomer still gets the whole store.
  const want = digestsOf(store);
  const nb = quiet(net.client('Newbie', { rank: 3 }).login());
  assert.ok(net.runUntil(() => nb.digests() === want, { max: 900, step: 10 }), 'the newcomer is complete within 15 minutes');
  noErrors(net);
});

// Newbie, new to the guild, logs in; each time his store is complete, his game crashes before saving `gap` s later
// (nothing of the session is kept) and he logs in again 30 s after. `early`: on login 3 the game crashes `early` s in,
// before he could ask for anything. → minutes to a complete store, per login (null: login 3 with the early crash).
function crashLoop(seed, { gap, logins, early = 0 }) {
  const net = createGuildNet({ seed });
  const store = guildStore({ now: net.now() });
  const want = digestsOf(store);
  ['Grommash', 'Saurfang', 'Zuljin', 'Varok'].forEach((n, i) => quiet(net.client(n, { rank: i < 2 ? 1 : 3, savedVariables: sharedDb(store), inbox: { me: { pid: `${n}.aaaa` } } }).login()));
  net.run(600);
  const nb = quiet(net.client('Newbie', { rank: 3, inbox: { me: { pid: 'Newbie.n000' } } }).login());
  const times = [];
  for (let k = 0; k < logins; k++) {
    if (early && k === 2) {
      net.run(early);
      times.push(null);
    } else {
      const start = net.now();
      assert.ok(net.runUntil(() => nb.digests() === want, { max: 3600, step: 10 }), `login ${k + 1} complete within an hour (${times.join(', ')})`);
      times.push(Math.round((net.now() - start) / 6) / 10);
      if (k === logins - 1) break;
      net.run(gap);
    }
    nb.crash();
    net.run(30);
    nb.login();
    quiet(nb);
  }
  noErrors(net);
  return times;
}

for (const [gap, logins] of [[300, 6], [1800, 4]]) {
  test(`trust-4: Newbie, new to the guild, has his game crash before saving ${gap / 60} minutes after each login, ${logins} logins in a row; each login gets the whole store again, the first 4 within 20 minutes and the rest within 60 (a refill: the guild's inventories, and what it sent for his G forgiven)`, () => {
    // With the old 16-hour guard on "my bucket is empty" and a whole-store push once a day, logins 3 and 4 waited 955
    // and 458 minutes.
    const times = crashLoop(31, { gap, logins });
    assert.ok(times.slice(0, 4).every((m) => m <= 20), `minutes per login: ${times.join(', ')}`);
    assert.ok(times.every((m) => m <= 60), `minutes per login: ${times.join(', ')}`);
  });
}

test('trust-4: Newbie\'s game crashes 1 minute after each login has the whole store, 5 logins; the login that comes within 10 minutes of the last refill, which he used, still gets a new one at once (each within 12 minutes)', () => {
  // Treated as part of the last refill, those logins waited for his next hello: 15 to 19 minutes.
  const times = crashLoop(34, { gap: 60, logins: 5 });
  assert.ok(times.every((m) => m <= 12), `minutes per login: ${times.join(', ')}`);
});

test('trust-4: Newbie\'s game crashes 40 s into his third login, before he could ask for anything; that unused refill doesn\'t hold up the next login (within 20 minutes)', () => {
  const times = crashLoop(31, { gap: 300, logins: 5, early: 40 });
  assert.ok(times.filter((m) => m !== null).every((m) => m <= 20), `minutes per login: ${times.join(', ')}`);
});

test('trust-4: Newbie\'s WTF folder is wiped after his game crashed, then he plays on a second PC and on a third the same day; each starts empty and gets the whole store within 20 minutes', () => {
  const net = createGuildNet({ seed: 41 });
  const store = guildStore({ now: net.now() });
  const want = digestsOf(store);
  ['Grommash', 'Saurfang', 'Zuljin', 'Varok'].forEach((n, i) => quiet(net.client(n, { rank: i < 2 ? 1 : 3, savedVariables: sharedDb(store), inbox: { me: { pid: `${n}.aaaa` } } }).login()));
  net.run(600);
  const nb = quiet(net.client('Newbie', { rank: 3, inbox: { me: { pid: 'Newbie.n000' } } }).login());
  const times = [];
  const complete = () => {
    const start = net.now();
    assert.ok(net.runUntil(() => nb.digests() === want, { max: 3600, step: 10 }), `complete within an hour (${times.join(', ')})`);
    times.push(Math.round((net.now() - start) / 6) / 10);
  };
  const freshLogin = () => { net._account('Newbie').sv = null; nb.login(); quiet(nb); }; // nothing saved on this PC
  complete();
  net.run(120);
  nb.crash();
  net.run(60);
  freshLogin(); // the WTF folder was wiped
  complete();
  net.run(3600);
  nb.logout();
  net.run(60);
  freshLogin(); // a second PC
  complete();
  net.run(2 * 3600);
  nb.logout();
  net.run(60);
  freshLogin(); // a third PC
  complete();
  assert.ok(times.every((m) => m <= 20), `minutes per login: ${times.join(', ')}`);
  noErrors(net);
});
