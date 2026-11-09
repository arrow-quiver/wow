'use strict';
// /wow lfg in game (addon/WowGuild/Dungeons.lua): listing guild dungeon groups, starting one, joining, leaving and
// finishing, the same line-up rule as the app (S.dungeonGroupState), and the chat lines for new groups and joins.
// The sharing engine is a stub that keeps what was put, so the records the addon makes are checked against the codec.
const test = require('node:test');
const assert = require('node:assert/strict');
const { WowClient, toLua } = require('./wowsim');
const S = require('../../src/shared/sharing');

const STUB = `
__recs = {}
__puts = {}
__ns.Share = {
  myPid = function() return "Thrallia.p4m7" end,
  get = function(id) return __recs[id] end,
  list = function(ty)
    local out, ids = {}, {}
    for id in pairs(__recs) do if string.sub(id, 1, #ty + 1) == ty .. ":" then ids[#ids + 1] = id end end
    table.sort(ids)
    for _, id in ipairs(ids) do out[#out + 1] = __recs[id] end
    return out
  end,
  putLocal = function(t, key, fields)
    local now = GetServerTime()
    __recs[t .. ":" .. key] = { type = t, key = key, id = t .. ":" .. key, t = now, v = tostring(now), author = UnitName("player"), fields = fields }
    table.insert(__puts, { type = t, key = key, fields = fields })
    return true
  end,
  onRecord = function() end,
}
__vc = 0
function __add(t, key, fields, author, at)
  __vc = __vc + 1
  __recs[t .. ":" .. key] = { type = t, key = key, id = t .. ":" .. key, t = at or GetServerTime(), v = tostring(__vc), author = author, fields = fields }
  return __recs[t .. ":" .. key]
end
function __encode(i)
  local p = __puts[i]
  local SC = __ns.ShareCodec
  return SC.encode({ type = p.type, key = p.key, author = "Thrallia", v = SC.makeVersion(GetServerTime(), "Thrallia"), fields = p.fields })
end`;

function client() {
  const wow = new WowClient({ interface: 16001, player: { name: 'Thrallia', realm: 'Forever', classToken: 'SHAMAN', level: 24, guild: 'wow' } });
  wow.login();
  wow.exec(STUB);
  wow.clearOutput();
  return wow;
}
const list = (v) => (Array.isArray(v) ? v : []);
const puts = (wow) => list(wow.get('__puts'));
const now = (wow) => Number(wow.eval('GetServerTime()'));
const noError = (wow) => assert.equal(wow.eval('__ns.debugError'), null, 'no addon errors');
function valid(wow, i) {
  const str = wow.lua(`__encode(${i})`);
  assert.equal(S.checkRecord(str, now(wow) + 60, () => null), null, `the app accepts ${str}`);
  return S.decode(str);
}

test('/wow lfg new posts a dg record; the list shows it as mine; done and cancel are for the leader', () => {
  const wow = client();
  wow.slash('lfg');
  assert.match(wow.printed(), /No guild dungeon groups right now\./);
  wow.slash('lfg new bard Deadmines');
  assert.match(wow.printed(), /Usage: \/wow lfg new <tank\|healer\|dps> <dungeon>/);
  wow.slash('lfg new heal The Deadmines');
  const [p] = puts(wow);
  assert.equal(p.type, 'dg');
  assert.match(p.key, /^[0-9a-z]{6}$/);
  assert.deepEqual(p.fields, { pid: 'Thrallia.p4m7', character: 'Thrallia', dungeon: 'The Deadmines', startsAt: now(wow), role: 'h', level: 24, tank: 1, heal: 1, dps: 3, note: '', state: 'o' });
  assert.equal(valid(wow, 1).type, 'dg');
  assert.match(wow.printed(), /Group for The Deadmines posted to your guild\./);
  wow.clearOutput();
  wow.slash('lfg');
  assert.match(wow.printed(), /1\. The Deadmines, now: Thrallia \(healer\), needs 1 tank, 3 dps\. Yours\./);
  wow.slash('lfg join 1 tank');
  assert.match(wow.printed(), /You lead that group\./);
  wow.slash('lfg done 1');
  const done = puts(wow)[1];
  assert.deepEqual([done.type, done.key, done.fields.state], ['dg', p.key, 'd']);
  assert.match(wow.printed(), /Marked as done\. Good run!/);
  wow.clearOutput();
  wow.slash('lfg');
  assert.match(wow.printed(), /No guild dungeon groups right now\./, 'a finished group leaves the list');
  noError(wow);
});

test('/wow lfg join and leave: first come first in, the waiting list, and a valid dj record', () => {
  const wow = client();
  const t = now(wow);
  wow.exec(`__add("dg", "gr0up1", { pid = "Grom.aaaa", character = "Grom", dungeon = "Wailing Caverns", startsAt = ${t + 1800}, role = "t", tank = 1, heal = 1, dps = 1, state = "o" }, "Grom")`);
  wow.exec(`__add("dj", "gr0up1:Varok.bbbb", { character = "Varok", role = "d", status = "y", joinedAt = ${t - 60} }, "Varok")`);
  wow.slash('lfg');
  assert.match(wow.printed(), /1\. Wailing Caverns, in 30 min: Grom \(tank\), needs 1 healer\./);
  wow.slash('lfg join 1');
  assert.match(wow.printed(), /Pick a role: \/wow lfg join 1 <tank\|healer\|dps>/);
  wow.slash('lfg join 9 dps');
  assert.match(wow.printed(), /No group with that number\./);
  wow.clearOutput();
  wow.slash('lfg join 1 dps');
  assert.match(wow.printed(), /The dps spots in Grom's group are taken\. You're on the waiting list\./);
  const j = puts(wow)[0];
  assert.deepEqual([j.type, j.key], ['dj', 'gr0up1:Thrallia.p4m7']);
  assert.deepEqual(j.fields, { character: 'Thrallia', role: 'd', status: 'y', class: 'SHAMAN', level: 24, joinedAt: t });
  assert.equal(valid(wow, 1).type, 'dj');
  wow.clearOutput();
  wow.slash('lfg');
  assert.match(wow.printed(), /You're waiting\./);
  wow.slash('lfg join 1 healer');
  assert.match(wow.printed(), /You're already in that group\./);
  wow.slash('lfg leave 1');
  assert.deepEqual(puts(wow)[1].fields, { character: 'Thrallia', role: 'd', status: 'w', class: 'SHAMAN', level: 24, joinedAt: t });
  assert.match(wow.printed(), /You left the group\./);
  wow.clearOutput();
  wow.slash('lfg join 1 heal');
  assert.match(wow.printed(), /You joined Grom's Wailing Caverns group as healer\. Wait for the invite\./);
  wow.slash('lfg cancel 1');
  assert.match(wow.printed(), /Only the leader can do that\./);
  noError(wow);
});

test("the addon's line-up matches the app's for the same records", () => {
  const wow = client();
  const t = now(wow);
  const dg = { pid: 'Lead.aaaa', dungeon: 'SFK', role: 'd', tank: 1, heal: 1, dps: 2, state: 'o' };
  const joins = [['Bb', 'd', t + 2], ['Aa', 'd', t + 2], ['Cc', 't', t + 3], ['Dd', 'h', t + 1, 'w'], ['Ee', 'h', t + 4], ['Ff', 't', t + 1]];
  wow.exec(`__add("dg", "dg1grp", ${toLua(dg)}, "Lead", ${t})`);
  for (const [who, role, at, status = 'y'] of joins) {
    wow.exec(`__add("dj", "dg1grp:${who}.bbbb", { character = "${who}", role = "${role}", status = "${status}", joinedAt = ${at} }, "${who}")`);
  }
  const lua = wow.lua(`(function()
    local g = __ns.lfg.state(__recs["dg:dg1grp"], __ns.Share.list("dj"))
    local m, w = {}, {}
    for _, x in ipairs(g.members) do m[#m + 1] = x.character end
    for _, x in ipairs(g.waiting) do w[#w + 1] = x.character end
    return g.state .. "|" .. table.concat(m, ",") .. "|" .. table.concat(w, ",")
  end)()`);
  const rec = (type, key, at, author, fields) => S.encode({ type, key, v: S.makeVersion(at, author), author, del: false, fields });
  const js = S.dungeonGroupState(rec('dg', 'dg1grp', t, 'Lead', dg),
    joins.map(([who, role, at, status = 'y']) => rec('dj', `dg1grp:${who}.bbbb`, t, who, { character: who, role, status, joinedAt: at })));
  assert.equal(lua, `${js.state}|${js.members.map((m) => m.character).join(',')}|${js.waiting.map((m) => m.character).join(',')}`);
  noError(wow);
});

test('chat lines: a guildmate\'s new group, a join and a leave on my group; mine, old and seeded ones stay quiet', () => {
  const wow = client();
  const t = now(wow);
  const arrive = (expr, how = 'd', from = 'Grom') => wow.exec(`__ns.lfg.arrived(${expr}, ${toLua(how)}, ${toLua(from)})`);
  arrive(`__add("dg", "gr0up1", { pid = "Grom.aaaa", character = "Grom", dungeon = "Scholomance", startsAt = ${t}, role = "t", tank = 1, heal = 1, dps = 3, state = "o" }, "Grom")`);
  assert.match(wow.printed(), /Grom is grouping for Scholomance \(now, needs 1 tank, 1 healer, 3 dps\)\. \/wow lfg to join\./);
  wow.clearOutput();
  arrive('__recs["dg:gr0up1"]');
  arrive(`__add("dg", "old001", { pid = "Grom.aaaa", character = "Grom", dungeon = "Old", startsAt = ${t}, state = "o" }, "Grom", ${t - 3600})`);
  arrive(`__add("dg", "seed01", { pid = "Grom.aaaa", character = "Grom", dungeon = "Seeded", startsAt = ${t}, state = "o" }, "Grom")`, 's');
  assert.equal(wow.printed(), '', 'the same group, an old one and a seeded one say nothing');

  wow.slash('lfg new tank Stratholme');
  const key = puts(wow)[0].key;
  wow.clearOutput();
  arrive(`__add("dj", "${key}:Zul.cccc", { character = "Zul", role = "d", status = "y" }, "Zul")`, 'd', 'Zul');
  assert.match(wow.printed(), /Zul joined your Stratholme group as dps\. \/invite Zul/);
  arrive(`__add("dj", "${key}:Zul.cccc", { character = "Zul", role = "d", status = "w" }, "Zul")`, 'd', 'Zul');
  assert.match(wow.printed(), /Zul left your Stratholme group\./);
  wow.clearOutput();
  arrive(`__add("dj", "gr0up1:Zul.cccc", { character = "Zul", role = "d", status = "y" }, "Zul")`, 'd', 'Zul');
  assert.equal(wow.printed(), '', 'joins on someone else\'s group are not my business');
  noError(wow);
});
