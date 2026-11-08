'use strict';
// docs/SHARING.md §13 scenarios 7, 8 and 9: the sharing engine at guild scale, played by the real addon on GuildNet,
// measured against the §7 sizing (40 active members, 1,400 records, 250 KB, 1,100 messages in all).
//
// The default suite runs a lighter version of each. GUILDCAMP_SIM_HEAVY=1 runs the full ones: 25 clients for a
// simulated week with 10% loss (7), 20 logins in 60 s (8), and a new member with 10% loss as well (9).
// Measured numbers go to the test output as diagnostics ("# scenario 9: ...").

const test = require('node:test');
const assert = require('node:assert');
const { createGuildNet, makeRecord, sharedDb, digestsOf, guildStore } = require('./guildnet');
const { makeRng } = require('./wowsim');
const SJ = require('../../src/shared/sharing');

const HEAVY = process.env.GUILDCAMP_SIM_HEAVY === '1';
const G = 'Forever/wow';
const idOf = (r) => r.slice(0, r.indexOf('^'));
// Most messages one sender may put out in any 60 s under the addon's own bucket (8 tokens, +1 every 1.25 s).
const BUDGET_PER_MINUTE = 8 + 60 / 1.25;

// The addon's own records (ch, rc …) of these test characters would add traffic the measurement is not about.
const quiet = (c) => { c.lua('if ns.Collect then ns.Collect.sharedRecords = nil; ns.Collect.offerAll = function() end end'); return c; };
const noErrors = (net) => { for (const c of net.clients) assert.deepStrictEqual(c.errors, [], `${c.name} had no Lua errors`); };

// The most messages any client sent in a sliding 60 s window.
function peakPerMinute(log) {
  const by = new Map();
  for (const e of log) if (e.status === 'sent') (by.get(e.from) || by.set(e.from, []).get(e.from)).push(e.t);
  let peak = 0;
  for (const times of by.values()) {
    let lo = 0;
    for (let hi = 0; hi < times.length; hi++) {
      while (times[hi] - times[lo] >= 60) lo++;
      peak = Math.max(peak, hi - lo + 1);
    }
  }
  return peak;
}

const count = (s, type) => (s.perType[type] ? s.perType[type].sent : 0);
const summary = (s) => `${s.sent} messages (${count(s, '1H')} H, ${count(s, '1I')} I, ${count(s, '1G')} G, ${count(s, '1R')} R, ${count(s, '1M')} M), ${Math.round(s.bytes / 1024)} KB`;

function newMember(t, { loss, maxMinutes }) {
  const net = createGuildNet({ seed: 9, loss });
  const store = guildStore({ now: net.now() });
  const want = digestsOf(store);
  const servers = [['Grommash', 1], ['Zuljin', 3], ['Varok', 3]].map(([n, rank]) => quiet(net.client(n, { rank, savedVariables: sharedDb(store) }).login()));
  net.run(120);
  for (const s of servers) assert.strictEqual(s.digests(), want, `${s.name} holds the whole store`);
  net.resetStats();
  const nb = quiet(net.client('Newbie', { rank: 3 }).login());
  const start = net.now();
  const done = net.runUntil(() => nb.digests() === want, { max: maxMinutes * 60, step: 10 });
  const minutes = (net.now() - start) / 60;
  const s = net.stats();
  t.diagnostic(`scenario 9 (loss ${loss * 100}%): ${store.length} records, ${Math.round(store.reduce((a, r) => a + Buffer.byteLength(r), 0) / 1024)} KB; `
    + `complete after ${minutes.toFixed(1)} min; ${summary(s)}; per sender ${Object.entries(s.perSender).map(([k, v]) => `${k} ${v.sent}`).join(', ')}; `
    + `throttle drops ${s.dropped.throttle}; peak ${peakPerMinute(net.log)} a minute from one sender`);
  assert.ok(done, `the new member is complete within ${maxMinutes} minutes (${nb.lua('return ns.Share._.debug().records')} of ${store.length} records)`);
  assert.strictEqual(s.dropped.throttle, 0, 'no message over the game\'s throttle');
  assert.ok(peakPerMinute(net.log) <= BUDGET_PER_MINUTE);
  assert.ok(net.converged());
  noErrors(net);
  return { minutes, stats: s };
}

test('scenario 9: a new member with three guildmates online gets 1,400 records within 15 virtual minutes', (t) => {
  const { stats } = newMember(t, { loss: 0, maxMinutes: 15 });
  // §7: 1,100 messages in all for the whole store; three servers share the work.
  assert.ok(stats.sent <= 1500, `${stats.sent} messages`);
});

test('scenario 9 with 10% loss: the new member still completes (heavy)', { skip: !HEAVY && 'set GUILDCAMP_SIM_HEAVY=1' }, (t) => {
  newMember(t, { loss: 0.1, maxMinutes: 40 });
});

// 20 (light: 10) members log in within 60 s (light: 30 s) holding a store that is 30 records behind the 5 online.
function massLogin(t, { logins, span }) {
  const net = createGuildNet({ seed: 8 });
  const now = net.now();
  const full = guildStore({ now });
  const rng = makeRng('s8');
  const newer = full.slice();
  const changed = [];
  // 10 records updated (newcomers hold the older version) and 20 new ones (newcomers lack them).
  const pick = full.filter((r) => /^(su|cr|lp|AN|RD|ch):/.test(r) && !SJ.isFinalV(r.split('^')[1]));
  for (let i = 0; i < 10; i++) {
    const r = pick.splice(Math.floor(rng() * pick.length), 1)[0];
    const d = SJ.decode(r);
    const nr = makeRecord({ type: d.type, key: d.key, fields: d.fields, t: now - 600 + i, author: d.author });
    newer[newer.indexOf(r)] = nr;
    changed.push(nr);
  }
  for (let i = 0; i < 20; i++) {
    const author = i < 6 ? 'Grommash' : `Charb${String.fromCharCode(97 + i)}x`;
    const nr = i < 6
      ? makeRecord({ type: 'AN', key: `zz${String(i).padStart(4, '0')}`, t: now - 300 + i, author, fields: { body: `New notice ${i}` } })
      : makeRecord({ type: 'ca', key: `yy${String(i).padStart(4, '0')}`, t: now - 300 + i, author, fields: { character: author, zone: 'Crossroads', needed: 3, message: 'help' } });
    newer.push(nr);
    changed.push(nr);
  }
  const want = digestsOf(newer);
  const servers = [['Grommash', 1], ['Saurfang', 1], ['Zuljin', 3], ['Varok', 3], ['Rexxar', 3]]
    .map(([n, rank]) => quiet(net.client(n, { rank, savedVariables: sharedDb(newer) }).login()));
  net.run(120);
  for (const s of servers) assert.strictEqual(s.digests(), want);
  net.resetStats();
  const newcomers = [];
  for (let i = 0; i < logins; i++) {
    newcomers.push(net.client(`New${String.fromCharCode(97 + i)}`, { rank: 3, interface: i % 2 ? 16001 : 120105, savedVariables: sharedDb(full) }));
  }
  const order = newcomers.map((c) => ({ c, at: rng() * span })).sort((a, b) => a.at - b.at);
  let at = 0;
  for (const x of order) { net.run(x.at - at); at = x.at; quiet(x.c.login()); }
  const start = net.now() - at;
  const ok = net.runUntil(() => net.converged(), { max: 600, step: 5 });
  const seconds = net.now() - start;
  net.run(300); // nothing more should follow
  const s = net.stats();
  assert.ok(ok, 'everyone converged');
  for (const c of newcomers) assert.strictEqual(c.digests(), want);

  // What one exchange needs: the inventory pages of each differing bucket, one G per bucket, and the R / M
  // messages that carry the 30 records. Logins spread over `span` s plus a hello wait of up to 40 s make
  // ceil((span + 40) / 60) one-minute rounds: newcomers that log in after a round's inventories missed them.
  const buckets = new Set(changed.map((r) => SJ.bucket(idOf(r))));
  let pages = 0;
  for (const b of buckets) pages += Math.max(1, Math.ceil(newer.filter((r) => SJ.bucket(idOf(r)) === b).length / SJ.K.INV_PER_PAGE));
  const small = changed.filter((r) => r.length <= SJ.K.R_SINGLE_MAX);
  const carry = SJ.packRecords(small).length + changed.filter((r) => r.length > SJ.K.R_SINGLE_MAX).reduce((a, r) => a + SJ.splitRecord(r, 1).length, 0);
  const oneRound = pages + buckets.size + carry;
  const rounds = Math.ceil((span + 40) / 60);
  const hellos = count(s, '1H');
  const others = s.sent - hellos;
  t.diagnostic(`scenario 8 (${logins} logins in ${span} s, 30 records differ): converged after ${(seconds / 60).toFixed(1)} min; ${summary(s)}; `
    + `one exchange needs ${oneRound} (${pages} I pages, ${buckets.size} G, ${carry} R/M), ${rounds} rounds ${rounds * oneRound}; `
    + `non-hello messages ${others} = ${(others / oneRound).toFixed(2)} x one exchange, ${(others / (rounds * oneRound)).toFixed(2)} x the rounds; `
    + `throttle drops ${s.dropped.throttle}; peak ${peakPerMinute(net.log)} a minute from one sender`);
  assert.ok(s.sent <= 1.5 * rounds * oneRound + hellos, `${s.sent} messages ≤ 1.5 × ${rounds * oneRound} + ${hellos} hellos`);
  assert.ok(hellos <= logins, `${hellos} hellos for ${logins} logins`);
  assert.strictEqual(s.dropped.throttle, 0);
  assert.ok(peakPerMinute(net.log) <= BUDGET_PER_MINUTE);
  noErrors(net);
}

test('scenario 8: 10 logins in 30 s, 1,400 records, 30 differ: messages ≤ 1.5 × needed + hellos', (t) => {
  massLogin(t, { logins: 10, span: 30 });
});

test('scenario 8: 20 logins in 60 s (heavy)', { skip: !HEAVY && 'set GUILDCAMP_SIM_HEAVY=1' }, (t) => {
  massLogin(t, { logins: 20, span: 60 });
});

// Random play: sessions, calls to arms, app changes (sign-ups, requests, partner posts; raids and notices from
// officers), instances, fights, reloads and crashes, all with the real collectors on, then a final hour with
// everyone online. 10% of deliveries are lost.
function randomWeek(t, { clients, days, seed }) {
  const net = createGuildNet({ seed, loss: 0.1 });
  const rng = makeRng(`week:${seed}`);
  const r = (n) => Math.floor(rng() * n);
  const names = [];
  for (let i = 0; i < clients; i++) names.push(`Player${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`);
  const cs = names.map((n, i) => {
    const pid = `${n}.${(1300 + i).toString(36).padStart(4, '0')}`;
    const c = net.client(n, { rank: i === 0 ? 0 : i < 3 ? 1 : 3, interface: i % 3 ? 16001 : 120105, inbox: { me: { pid } } });
    return { c, pid, rank: c.rank, next: r(3600), raids: [], seq: 0 };
  });
  const keyOf = () => { let k = ''; for (let i = 0; i < 6; i++) k += '0123456789abcdefghijklmnopqrstuvwxyz'[r(36)]; return k; };
  const raids = [];
  // One app change for this player: what the app would queue, then /reload.
  const appChange = (p) => {
    const now = net.now();
    const op = `o${(++p.seq).toString(36)}${p.c.name.slice(-2)}`;
    let entry;
    const roll = r(10);
    if (p.rank <= 1 && roll < 3) {
      const key = keyOf();
      raids.push(key);
      entry = { op, g: G, id: `RD:${key}`, t: now, need: 'o', base: '', body: SJ.encodeBody('RD', key, { kind: 'r', title: 'Molten Core', instance: 'Molten Core', startsAt: now + 3 * 86400, minutes: 180, size: 40, srLimit: 2 }) };
    } else if (p.rank <= 1 && roll < 5) {
      const key = keyOf();
      entry = { op, g: G, id: `AN:${key}`, t: now, need: 'o', base: '', body: SJ.encodeBody('AN', key, { body: `Notice from ${p.c.name}` }) };
    } else if (raids.length && roll < 7) {
      const key = `${raids[r(raids.length)]}:${p.pid}`;
      entry = { op, g: G, id: `su:${key}`, t: now, base: '', body: SJ.encodeBody('su', key, { character: p.c.name, role: 'thd'[r(3)], status: 'ytnb'[r(4)], note: 'see you' }) };
    } else if (roll < 9) {
      const key = keyOf();
      entry = { op, g: G, id: `cr:${key}`, t: now, base: '', body: SJ.encodeBody('cr', key, { pid: p.pid, item: 'Flask of the Titans', notes: 'mats ready', state: 'o' }) };
    } else {
      const key = `${p.pid}:${p.c.name}`;
      entry = { op, g: G, id: `lp:${key}`, t: now, base: '', body: SJ.encodeBody('lp', key, { character: p.c.name, level: 40 + r(20), zone: 'Tanaris', when: 'tonight' }) };
    }
    p.c.setInbox({ me: { pid: p.pid }, outbox: [entry] });
    p.c.reload();
  };
  const act = (p) => {
    const c = p.c;
    if (!c.online) {
      c.login();
      p.stopAt = net.now() + 1800 + r(3 * 3600); // session length
      p.next = net.now() + 300 + r(1800);
      return;
    }
    if (net.now() >= p.stopAt) {
      if (r(20) === 0) c.crash(); else c.logout();
      p.next = net.now() + 3600 + r(12 * 3600);
      return;
    }
    const roll = r(10);
    if (roll < 3) appChange(p);
    else if (roll < 5) c.lua(`SlashCmdList.WOWGUILD("cta Zone${r(9)} ${1 + r(4)} help wanted")`);
    else if (roll < 7) { c.setInstance(true); p.inside = net.now() + 300 + r(3600); }
    else if (roll < 8) { c.setCombat(true); p.fight = net.now() + 10 + r(60); }
    else c.reload();
    p.next = net.now() + 600 + r(1800);
  };
  const end = net.now() + days * 86400;
  while (net.now() < end) {
    net.run(60);
    for (const p of cs) {
      if (p.c.online && p.inside && net.now() >= p.inside) { p.c.setInstance(false); p.inside = null; }
      if (p.c.online && p.fight && net.now() >= p.fight) { p.c.setCombat(false); p.fight = null; }
      if (net.now() >= p.next && !p.inside && !p.fight) act(p);
    }
  }
  // The final hour: everyone online, outside, out of combat.
  for (const p of cs) {
    if (p.c.online && p.inside) p.c.setInstance(false);
    if (p.c.online && p.fight) p.c.setCombat(false);
    if (!p.c.online) p.c.login();
  }
  const finalFrom = net.log.length;
  net.run(3600);
  const s = net.stats();
  const finalLog = net.log.slice(finalFrom);
  const recs = cs[0].c.lua('return ns.Share._.debug().records');
  const perClientHour = s.sent / (clients * (days * 24 + 1));
  t.diagnostic(`scenario 7 (${clients} clients, ${days} days, 10% loss): ${recs} records at the end; ${summary(s)}; `
    + `${perClientHour.toFixed(2)} messages per client-hour; final hour ${finalLog.filter((e) => e.status === 'sent').length} messages; `
    + `throttle drops ${s.dropped.throttle}; peak ${peakPerMinute(net.log)} a minute from one sender; converged ${net.converged()}`);
  assert.ok(net.converged(), 'equal digests on every client after a final hour all online');
  assert.strictEqual(s.dropped.throttle, 0, 'zero throttle drops');
  assert.strictEqual(s.refused.instance, 0, 'nothing sent inside an instance or a loading screen');
  assert.ok(!net.log.some((e) => e.status === 'sent' && e.inCombat), 'nothing sent in combat');
  assert.ok(peakPerMinute(net.log) <= BUDGET_PER_MINUTE, 'every client stayed under its own bucket');
  noErrors(net);
}

test('scenario 7: 8 clients, 12 hours of random play, 10% loss: converged after a final hour, within the throttle budget', (t) => {
  randomWeek(t, { clients: 8, days: 0.5, seed: 7 });
});

test('scenario 7: 25 clients, a simulated week of random play, 10% loss (heavy)', { skip: !HEAVY && 'set GUILDCAMP_SIM_HEAVY=1' }, (t) => {
  randomWeek(t, { clients: 25, days: 7, seed: 77 });
});
