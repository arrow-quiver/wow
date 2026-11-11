'use strict';
// The Raids & Dungeons section of the guild window (MainUI.lua): raids, dungeon groups, dungeon quests.
const test = require('node:test');
const assert = require('node:assert');
const { WowClient } = require('./wowsim');

const noError = (wow) => assert.strictEqual(wow.eval('__ns.debugError'), null, 'no addon errors');

// A small stand-in for the sharing engine: records in a list, the newest put replaces the same type and key.
const SHARE = `__recs = {}
__ns.Share = __ns.Share or {}
__ns.Share.myPid = function() return "Tester.t1" end
__ns.Share.list = function(ty) local out = {} for _, r in ipairs(__recs) do if r.type == ty then out[#out + 1] = r end end return out end
__ns.Share.get = function(id) for _, r in ipairs(__recs) do if r.type .. ":" .. r.key == id then return r end end end
__ns.Share.putLocal = function(ty, key, f)
  for i, r in ipairs(__recs) do if r.type == ty and r.key == key then table.remove(__recs, i) break end end
  table.insert(__recs, { type = ty, key = key, fields = f, author = "Tester", t = GetServerTime() }) return {}
end
function IsInGuild() return true end
local t = GetServerTime()
table.insert(__recs, { type = "dg", key = "g1", author = "Mokra", t = t, fields = { pid = "Mokra.m1", character = "Mokra", dungeon = "Deadmines", startsAt = t, role = "t", level = 20, tank = 1, heal = 1, dps = 3, note = "", state = "o" } })
table.insert(__recs, { type = "dj", key = "g1:Zed.z1", author = "Zed", t = t, fields = { character = "Zed", role = "d", status = "y", joinedAt = t - 5 } })`;

function client(extra = '') {
  const wow = new WowClient({ player: 'Tester' });
  wow.login();
  wow.exec(SHARE);
  if (extra) wow.exec(extra);
  wow.clearOutput();
  return wow;
}
const groups = 'WowGuildWindow.pages.groups';
const txt = (wow, expr) => wow.eval(`tostring(${expr}:GetText())`);
const shown = (wow, expr) => wow.eval(`tostring(${expr}:IsShown())`);

test('Dungeon groups page: the line-up, join by role, leave; answers show on the page', () => {
  const wow = client();
  wow.exec('__ns.ui.show("groups")');
  assert.ok(wow.texts().includes('1 open group'));
  assert.match(txt(wow, `${groups}.rows[1].title`), /^Deadmines {2}\|cff999999now\|r {2}\|cffe8a33dneeds 1 healer, 2 dps\|r$/);
  assert.strictEqual(txt(wow, `${groups}.rows[1].who`), 'Mokra (tank), Zed (dps)');
  assert.deepStrictEqual([1, 2, 3].map((k) => txt(wow, `${groups}.rows[1].b[${k}]`)), ['Tank', 'Healer', 'DPS']);
  assert.strictEqual(shown(wow, `${groups}.rows[2]`), 'false');
  // Join as healer: a "dj" record for me, the row says I'm in and offers Leave only.
  wow.click(`${groups}.rows[1].b[2]`);
  assert.strictEqual(wow.printed(), '', 'nothing goes to chat');
  assert.match(txt(wow, `${groups}.status`), /You joined Mokra's Deadmines group as healer/);
  assert.strictEqual(wow.eval('__ns.Share.get("dj:g1:Tester.t1").fields.role'), 'h');
  assert.match(txt(wow, `${groups}.rows[1].who`), /Thrallia \(healer\).*You're in\./);
  assert.deepStrictEqual([1, 2, 3].map((k) => shown(wow, `${groups}.rows[1].b[${k}]`)), ['false', 'false', 'true']);
  assert.strictEqual(txt(wow, `${groups}.rows[1].b[3]`), 'Leave');
  wow.click(`${groups}.rows[1].b[3]`);
  assert.match(txt(wow, `${groups}.status`), /You left the group/);
  assert.strictEqual(wow.eval('__ns.Share.get("dj:g1:Tester.t1").fields.status'), 'w');
  assert.strictEqual(txt(wow, `${groups}.rows[1].b[1]`), 'Tank', 'the role buttons are back');
  noError(wow);
});

test('Dungeon groups page: start a group, then invite, done and call off on my own', () => {
  const wow = client();
  wow.exec('__ns.ui.show("groups")');
  wow.click(`${groups}.start.healer`);
  assert.strictEqual(txt(wow, `${groups}.status`), 'Type the dungeon first.');
  wow.exec(`${groups}.dungeon:SetText("Wailing Caverns")`);
  wow.click(`${groups}.start.healer`);
  assert.match(txt(wow, `${groups}.status`), /Group for Wailing Caverns posted to your guild/);
  assert.strictEqual(txt(wow, `${groups}.dungeon`), '', 'the box clears');
  assert.ok(wow.texts().includes('2 open groups'));
  const mine = [1, 2].find((i) => /^Wailing Caverns/.test(txt(wow, `${groups}.rows[${i}].title`)));
  assert.ok(mine, 'my group is listed');
  assert.strictEqual(txt(wow, `${groups}.rows[${mine}].who`), 'Thrallia (healer)');
  assert.deepStrictEqual([1, 2, 3].map((k) => txt(wow, `${groups}.rows[${mine}].b[${k}]`)), ['Invite all', 'Done', 'Call off']);
  wow.click(`${groups}.rows[${mine}].b[1]`);
  assert.match(txt(wow, `${groups}.status`), /nobody has joined yet/);
  wow.click(`${groups}.rows[${mine}].b[3]`);
  assert.match(txt(wow, `${groups}.status`), /Group called off/);
  assert.ok(wow.texts().includes('1 open group'));
  assert.strictEqual(wow.printed(), '');
  noError(wow);
});

test('Dungeon groups page: no groups says so; the sharing engine missing is explained, not an error', () => {
  const wow = client('__recs = {}');
  wow.exec('__ns.ui.show("groups")');
  assert.ok(wow.texts().includes('No guild dungeon groups right now. Start one below.'));
  wow.exec(`__ns.Share = nil; ${groups}.dungeon:SetText("Deadmines")`);
  wow.click(`${groups}.start.tank`);
  assert.match(txt(wow, `${groups}.status`), /Guild Camp doesn't know you yet|can't be shared right now/);
  assert.strictEqual(txt(wow, `${groups}.dungeon`), 'Deadmines', 'what I typed stays');
  noError(wow);
});

test('Raids page: each raid with when, how many, where I stand and my reserves', () => {
  const wow = client(`WowGuildInbox = WowGuildInbox or {}
    WowGuildInbox.raids = {
      { title = "Molten Core", startsAt = time() + 7200, coming = 18, signup = "yes", role = "healer", reserves = { { name = "Aurastone Hammer", bonus = 20 }, { name = "Cauterizing Band" } } },
      { title = "Onyxia", startsAt = time() + 3 * 86400, coming = 9 },
      { title = "AV premade", startsAt = time() + 600, coming = 12, signup = "tentative" },
    }`);
  wow.exec('__ns.ui.show("raids")');
  const raids = 'WowGuildWindow.pages.raids';
  assert.ok(wow.texts().includes("3 coming up  |cffe8a33d1 you haven't answered|r"));
  assert.strictEqual(txt(wow, `${raids}.rows[1].title`), 'Molten Core');
  assert.match(txt(wow, `${raids}.rows[1].when`), /\|cff999999in 2 h\|r$/);
  assert.strictEqual(txt(wow, `${raids}.rows[1].me`), "You're coming as healer");
  assert.strictEqual(txt(wow, `${raids}.rows[1].coming`), '18 coming');
  assert.strictEqual(txt(wow, `${raids}.rows[1].reserved`), 'Reserved: Aurastone Hammer (+20), Cauterizing Band');
  assert.strictEqual(txt(wow, `${raids}.rows[2].me`), 'Not signed up yet');
  assert.match(txt(wow, `${raids}.rows[2].when`), /in 3 days/);
  assert.strictEqual(txt(wow, `${raids}.rows[3].me`), "You're a maybe");
  assert.match(txt(wow, `${raids}.rows[3].when`), /in 10 min/);
  assert.strictEqual(shown(wow, `${raids}.rows[4]`), 'false');
  wow.exec('WowGuildInbox.raids = {}; __ns.ui.show("raids")');
  assert.ok(wow.texts().includes('Nothing scheduled.'));
  noError(wow);
});

test('Dungeon quests page: counts, each quest\'s state, and who else in my group has it', () => {
  const wow = client();
  const name = wow.eval('(function() local n = {} for k in pairs(__ns.dungeonQuests.DATA) do n[#n + 1] = k end table.sort(n) return n[1] end)()');
  const first = wow.eval(`__ns.dungeonQuests.DATA[${JSON.stringify(name)}][1][1]`);
  wow.exec(`__ns.dungeonQuests.party[${JSON.stringify(name)}] = { Mokra = { [string.lower(${JSON.stringify(first)})] = true } }`);
  wow.exec('__ns.ui.show("quests")');
  const page = 'WowGuildWindow.pages.quests';
  wow.exec(`${page}.input:SetText(${JSON.stringify(name)})`);
  wow.click(`${page}.go`);
  const body = wow.texts().reverse().find((t) => t.startsWith('|cffffd100Quests: '));
  assert.ok(body.startsWith(`|cffffd100Quests: ${name}|r`));
  assert.match(body, /\|cff40bf400 ready to hand in\|r {2}\|cffe8a33d0 in your log\|r {2}\|cff999999\d+ still to pick up\|r/);
  assert.ok(body.includes(first) && body.includes('also: Mokra'));
  assert.strictEqual(txt(wow, `${page}.input`), name, 'the dungeon stays in the box');
  noError(wow);
});
