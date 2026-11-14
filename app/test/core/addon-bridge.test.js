'use strict';
// Bridge.lua: GuildCampAPI, the public API other addons use (the Warband Codex reads the kill-on-sight list, groups,
// raids and crafters through it, and hands over a character snapshot with publish).
const test = require('node:test');
const assert = require('node:assert/strict');
const { WowClient } = require('./wowsim');

const noError = (wow) => assert.strictEqual(wow.eval('__ns.debugError'), null, 'no addon errors');
const SHARE = `__recs = {}
__ns.Share = __ns.Share or {}
__ns.Share.myPid = function() return "Thrallia.p4m7" end
__ns.Share.list = function(ty) local out = {} for _, r in ipairs(__recs) do if r.type == ty then out[#out + 1] = r end end return out end
__ns.Share.putLocal = function(ty, key, f) table.insert(__recs, { type = ty, key = key, fields = f, author = "Thrallia", t = GetServerTime() }) return {} end
local t = GetServerTime()
table.insert(__recs, { type = "ko", key = "Stabby", author = "Mokra", t = t - 100, fields = { pid = "Mokra.m1", reason = "ganks lowbies", state = "o" } })
table.insert(__recs, { type = "ko", key = "Forgiven", author = "Mokra", t = t - 50, fields = { pid = "Mokra.m1", reason = "", state = "x" } })
table.insert(__recs, { type = "dg", key = "g1", author = "Mokra", t = t - 30, fields = { pid = "Mokra.m1", character = "Mokra", role = "t", dungeon = "Wailing Caverns", startsAt = t + 600, note = "bring water", state = "o" } })
if __ns.hunt and __ns.hunt.invalidate then __ns.hunt.invalidate() end`;

function client(opts) {
  const wow = new WowClient(opts);
  wow.login();
  wow.exec(SHARE);
  wow.clearOutput();
  return wow;
}

test('GuildCampAPI: the kill-on-sight list, dungeon groups, raids and crafters as plain copies', () => {
  const wow = client({ inbox: { guild: 'HowBowWoW', raids: [{ title: 'Molten Core', startsAt: 1800000000, coming: 12, signup: 'yes', role: 'healer', reserves: [{ name: 'x' }] }], crafters: [{ name: 'Runecloth Bag', who: 'Zed,Mokra' }] } });
  assert.strictEqual(wow.get('GuildCampAPI.version'), 1);
  assert.strictEqual(wow.eval('GuildCampAPI.guild()'), 'HowBowWoW');
  assert.deepStrictEqual(wow.get('GuildCampAPI.kos()').map((k) => [k.name, k.reason, k.by]), [['Stabby', 'ganks lowbies', 'Mokra']]);
  const groups = wow.get('GuildCampAPI.groups()');
  assert.strictEqual(groups.length, 1);
  assert.deepStrictEqual([groups[0].n, groups[0].dungeon, groups[0].leader, groups[0].role, groups[0].note, groups[0].mine, groups[0].joined], [1, 'Wailing Caverns', 'Mokra', 't', 'bring water', false, false]);
  assert.deepStrictEqual(groups[0].need, { t: 0, h: 1, d: 3 });
  assert.deepStrictEqual(groups[0].members, [{ name: 'Mokra', role: 't' }]);
  assert.deepStrictEqual(wow.get('GuildCampAPI.raids()'), [{ title: 'Molten Core', startsAt: 1800000000, coming: 12, signup: 'yes', role: 'healer' }]);
  assert.strictEqual(wow.eval('GuildCampAPI.crafters("runecloth bag")'), 'Zed,Mokra');
  assert.strictEqual(wow.eval('tostring(GuildCampAPI.crafters("Nothing"))'), 'nil');
  noError(wow);
});

test('GuildCampAPI: joining a group and adding to the list go through the addon\'s own rules', () => {
  const wow = client();
  wow.exec('GuildCampAPI.groups(); GuildCampAPI.groupJoin(1, "healer")');
  const join = wow.get('__recs[#__recs]');
  assert.deepStrictEqual([join.type, join.key, join.fields.role, join.fields.status], ['dj', 'g1:Thrallia.p4m7', 'h', 'y']);
  const g = wow.get('GuildCampAPI.groups()')[0];
  assert.deepStrictEqual([g.joined, g.need], [true, { t: 0, h: 0, d: 3 }]);
  wow.exec('GuildCampAPI.kosAdd("gankalot", "camps the crossroads")');
  assert.deepStrictEqual(wow.get('GuildCampAPI.kos()').map((k) => k.name).sort(), ['Gankalot', 'Stabby']);
  noError(wow);
});

test('GuildCampAPI.publish keeps another addon\'s snapshot in the saved data, by addon and key', () => {
  const wow = client();
  assert.strictEqual(wow.eval('tostring(GuildCampAPI.publish("WarbandCodex", "character_Thrallia", { level = 23, gear = { "Helm" } }))'), 'true');
  assert.deepStrictEqual(wow.get('WowGuildDB.ext.WarbandCodex.character_Thrallia.data'), { level: 23, gear: ['Helm'] });
  for (const bad of ['"../x", "k", {}', '"A", "bad key", {}', '"A", "k", "text"', 'nil, "k", {}']) {
    assert.strictEqual(wow.eval(`tostring(GuildCampAPI.publish(${bad}))`), 'false', bad);
  }
  wow.logout();
  assert.match(wow.saveVariablesBuffer().toString(), /\["character_Thrallia"\]/);
  noError(wow);
});

test('GuildCampAPI.publish keeps a plain, size-capped copy, never the caller\'s table (review of #78)', () => {
  const wow = client();
  // A copy: changing the caller's table afterwards changes nothing saved. Functions and cycles are left out.
  wow.exec(`__snap = { level = 23, gear = { "Helm" }, fn = function() end, [true] = 1 }
    __snap.self = __snap; __snap.gear.back = __snap
    __ok = GuildCampAPI.publish("WarbandCodex", "character_Thrallia", __snap)
    __snap.level = 99; __snap.gear[1] = "Changed"`);
  assert.strictEqual(wow.get('__ok'), true);
  assert.deepStrictEqual(wow.get('WowGuildDB.ext.WarbandCodex.character_Thrallia.data'), { level: 23, gear: ['Helm'] });
  assert.strictEqual(wow.eval('tostring(WowGuildDB.ext.WarbandCodex.character_Thrallia.data == __snap)'), 'false');
  // Too deep: the deep part is dropped. Too big: nothing is kept and the old snapshot stays.
  wow.exec(`local t = {} local c = t for i = 1, 20 do c.x = {} c = c.x end c.leaf = "deep"
    __deepOk = GuildCampAPI.publish("WarbandCodex", "deep", t)`);
  assert.strictEqual(wow.get('__deepOk'), true);
  assert.strictEqual(wow.eval('tostring(string.find(tostring(WowGuildDB.ext.WarbandCodex.deep.data.x.x.x.x.x.x.x.x), "table"))'), 'nil');
  wow.exec(`local big = {} for i = 1, 2000 do big[i] = string.rep("x", 40) end
    __bigOk = GuildCampAPI.publish("WarbandCodex", "character_Thrallia", { big = big })`);
  assert.strictEqual(wow.get('__bigOk'), false);
  assert.deepStrictEqual(wow.get('WowGuildDB.ext.WarbandCodex.character_Thrallia.data'), { level: 23, gear: ['Helm'] });
  wow.logout();
  assert.ok(wow.saveVariablesBuffer().length < 64 * 1024);
  noError(wow);
});
