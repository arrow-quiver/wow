'use strict';
// Goals.lua and the Camp › Guild goals page: supply drives (DR + dc records) and zone kill goals (BT + kk).
const test = require('node:test');
const assert = require('node:assert');
const { WowClient } = require('./wowsim');

const noError = (wow) => assert.strictEqual(wow.eval('__ns.debugError'), null, 'no addon errors');
const txt = (wow, expr) => wow.eval(`tostring(${expr}:GetText())`);

const SHARE = `__recs = {}
__ns.Share = __ns.Share or {}
__ns.Share.myPid = function() return "Thrallia.p4m7" end
__ns.Share.list = function(ty) local out = {} for _, r in ipairs(__recs) do if r.type == ty then out[#out + 1] = r end end return out end
__ns.Share.putLocal = function(ty, key, f) table.insert(__recs, { type = ty, key = key, fields = f, author = "Thrallia", t = GetServerTime() }) return {} end
local t = GetServerTime()
table.insert(__recs, { type = "DR", key = "d1", author = "Mokra", t = t - 100, fields = { title = "Runecloth for the bank", unit = "Runecloth", goal = 200, notes = "For bandages", state = "o" } })
table.insert(__recs, { type = "DR", key = "d2", author = "Mokra", t = t - 900, fields = { title = "Old drive", unit = "Linen", goal = 10, notes = "", state = "c" } })
table.insert(__recs, { type = "dc", key = "c1", author = "Mokra", t = t - 50, fields = { pid = "Mokra.m1", drive = "d1", character = "Mokra", amount = 60, note = "" } })
table.insert(__recs, { type = "dc", key = "c2", author = "Zed", t = t - 40, fields = { pid = "Zed.z1", drive = "d1", character = "Zed", amount = 40, note = "" } })
table.insert(__recs, { type = "dc", key = "c3", author = "Mokra", t = t - 30, fields = { pid = "Mokra.m1", drive = "d1", character = "Mokra", amount = 20, note = "" } })
table.insert(__recs, { type = "dc", key = "c4", author = "Zed", t = t - 30, fields = { pid = "Zed.z1", drive = "d2", character = "Zed", amount = 5, note = "" } })
table.insert(__recs, { type = "BT", key = "z1", author = "Mokra", t = t - 70, fields = { target = "", zone = "Hillsbrad Foothills", points = 5, cap = 10, ends = t + 3 * 86400, note = "", state = "o" } })
table.insert(__recs, { type = "BT", key = "p1", author = "Mokra", t = t - 70, fields = { target = "Stabby", zone = "", points = 50, cap = 1, ends = t + 86400, note = "", state = "o" } })
table.insert(__recs, { type = "kk", key = "k1", author = "Zed", t = t - 10, fields = { pid = "Zed.z1", target = "A", zone = "Hillsbrad Foothills", at = t - 10, kos = 0, bounty = "z1" } })
table.insert(__recs, { type = "kk", key = "k2", author = "Zed", t = t - 9, fields = { pid = "Zed.z1", target = "B", zone = "Hillsbrad Foothills", at = t - 9, kos = 0, bounty = "z1" } })
table.insert(__recs, { type = "kk", key = "k3", author = "Zed", t = t - 8, fields = { pid = "Zed.z1", target = "C", zone = "Elsewhere", at = t - 8, kos = 1, bounty = "" } })`;

function client() {
  const wow = new WowClient();
  wow.login();
  wow.exec(SHARE);
  wow.clearOutput();
  return wow;
}

test('drives: open ones with the total, who gave most and my own; a gift is my own record', () => {
  const wow = client();
  const d = wow.get('__ns.goals.drives()');
  assert.strictEqual(d.length, 1, 'the closed drive is not listed');
  assert.deepStrictEqual([d[0].title, d[0].total, d[0].goal, d[0].mine, d[0].done], ['Runecloth for the bank', 120, 200, 0, false]);
  assert.deepStrictEqual(d[0].givers.map((g) => [g.name, g.amount]), [['Mokra', 80], ['Zed', 40]]);
  // Giving: only whole numbers from 1.
  for (const bad of ['', 'lots', '0', '-5', '1000000']) assert.strictEqual(wow.eval(`tostring(__ns.goals.give("d1", ${JSON.stringify(bad)}))`), 'false', bad);
  assert.strictEqual(wow.eval('tostring(__ns.goals.give("nope", 5))'), 'false', 'a drive that is not open');
  assert.strictEqual(wow.eval('tostring(__ns.goals.give("d1", "80"))'), 'true');
  const rec = wow.get('__recs[#__recs]');
  assert.deepStrictEqual([rec.type, rec.fields.pid, rec.fields.drive, rec.fields.character, rec.fields.amount], ['dc', 'Thrallia.p4m7', 'd1', 'Thrallia', 80]);
  const after = wow.get('__ns.goals.drives()')[0];
  assert.deepStrictEqual([after.total, after.mine, after.done], [200, 80, true]);
  assert.match(wow.printed(), /Recorded: 80 Runecloth for Runecloth for the bank\. Thank you!/);
  noError(wow);
});

test('kill goals: zone bounties with the kills recorded for them; the login line', () => {
  const wow = client();
  const h = wow.get('__ns.goals.hunts()');
  assert.deepStrictEqual(h.map((x) => [x.zone, x.done, x.cap, x.points]), [['Hillsbrad Foothills', 2, 10, 5]], 'the player bounty is not a kill goal');
  assert.strictEqual(wow.eval('__ns.goals.line()'), '2 guild goals open: Runecloth for the bank 120/200 · Hillsbrad Foothills 2/10 kills');
  wow.exec('__recs = {}');
  assert.strictEqual(wow.eval('tostring(__ns.goals.line())'), 'nil');
  noError(wow);
});

test('Guild goals page: bars, "I gave", and the kill goals', () => {
  const wow = client();
  wow.exec('__ns.ui.show("goals")');
  const p = 'WowGuildWindow.pages.goals';
  assert.ok(wow.texts().includes('1 supply drive'));
  assert.strictEqual(txt(wow, `${p}.drives[1].title`), 'Runecloth for the bank');
  assert.strictEqual(txt(wow, `${p}.drives[1].count`), '120 of 200 Runecloth');
  assert.strictEqual(txt(wow, `${p}.drives[1].who`), 'Most: Mokra 80, Zed 40  For bandages');
  assert.strictEqual(wow.eval(`tostring(${p}.drives[2]:IsShown())`), 'false');
  assert.match(txt(wow, `${p}.hunts[1].what`), /^Hillsbrad Foothills {2}\|cffe8a33d2 of 10 kills\|r {2}\|cff9999995 season points each\|r$/);
  assert.match(txt(wow, `${p}.hunts[1].left`), /days left$/);
  // "I gave" with an empty box explains itself; with a number it records and the bar moves.
  wow.click(`${p}.drives[1].btn`);
  assert.match(txt(wow, `${p}.status`), /^Write how many you gave/);
  wow.exec(`${p}.drives[1].box:SetText("30")`);
  wow.click(`${p}.drives[1].btn`);
  assert.match(txt(wow, `${p}.status`), /^Recorded: 30 Runecloth/);
  assert.strictEqual(txt(wow, `${p}.drives[1].count`), '150 of 200 Runecloth');
  assert.match(txt(wow, `${p}.drives[1].who`), /^\|cffe8a33dYou gave 30\.\|r {2}Most: Mokra 80, Zed 40, Thrallia 30/);
  assert.strictEqual(txt(wow, `${p}.drives[1].box`), '');
  assert.strictEqual(wow.printed(), '', 'nothing goes to chat');
  // No goals at all.
  wow.exec('__recs = {}; __ns.ui.show("goals")');
  assert.ok(wow.texts().some((t) => /^No guild goals right now/.test(t)));
  noError(wow);
});

// ---------------------------------------------------------------- review of #64

test('shared records with odd numbers: strings are coerced, junk is skipped, an oversized gift is capped', () => {
  const wow = client();
  wow.exec(`local t = GetServerTime()
    table.insert(__recs, { type = "BT", key = "z2", author = "Mokra", t = t, fields = { target = "", zone = "Arathi", points = "7", cap = 3, ends = tostring(t + 86400), note = "", state = "o" } })
    table.insert(__recs, { type = "BT", key = "z3", author = "Mokra", t = t, fields = { target = "", zone = "Duskwood", points = "lots", cap = 3, ends = "soon", note = "", state = "o" } })
    table.insert(__recs, { type = "DR", key = "d3", author = "Mokra", t = t, fields = { unit = "Iron", goal = 50, state = "o" } })
    table.insert(__recs, { type = "dc", key = "c9", author = "Zed", t = t, fields = { pid = "Zed.z1", drive = "d3", character = "Zed", amount = 1e15 } })`);
  const h = wow.get('__ns.goals.hunts()');
  assert.deepStrictEqual(h.map((x) => [x.zone, x.points]), [['Arathi', 7], ['Hillsbrad Foothills', 5]], 'the string record is read, the junk one is skipped');
  const d3 = wow.get('__ns.goals.drives()').find((x) => x.key === 'd3');
  assert.strictEqual(d3.title, 'Drive', 'a drive with no title is called Drive');
  assert.strictEqual(d3.total, wow.get('__ns.goals.MAX_GIFT'), 'one gift counts at most MAX_GIFT');
  assert.match(wow.eval('__ns.goals.line()'), /Arathi 0\/3 kills/);
  wow.exec('__ns.ui.show("goals")');
  noError(wow);
});
