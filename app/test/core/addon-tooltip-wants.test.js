'use strict';
// Tooltip.lua: what the guild is short of, on item tooltips (open supply drives and unhandled guild bank requests).
const test = require('node:test');
const assert = require('node:assert');
const { WowClient } = require('./wowsim');

const SHARE = `__recs = {}
__ns.Share = __ns.Share or {}
__ns.Share.myPid = function() return "Thrallia.p4m7" end
__ns.Share.list = function(ty) local out = {} for _, r in ipairs(__recs) do if r.type == ty then out[#out + 1] = r end end return out end
local t = GetServerTime()
table.insert(__recs, { type = "DR", key = "d1", author = "Mokra", t = t, fields = { title = "Cloth for bandages", unit = "Runecloth", goal = 200, notes = "", state = "o" } })
table.insert(__recs, { type = "dc", key = "c1", author = "Zed", t = t, fields = { pid = "Zed.z1", drive = "d1", character = "Zed", amount = 186, note = "" } })
table.insert(__recs, { type = "DR", key = "d2", author = "Mokra", t = t, fields = { title = "Full drive", unit = "Linen Cloth", goal = 10, notes = "", state = "o" } })
table.insert(__recs, { type = "dc", key = "c2", author = "Zed", t = t, fields = { pid = "Zed.z1", drive = "d2", character = "Zed", amount = 10, note = "" } })
table.insert(__recs, { type = "bq", key = "q1", author = "Mokra", t = t, fields = { pid = "Mokra.m1", item = "Runecloth", count = 20, note = "", state = "o" } })
table.insert(__recs, { type = "bq", key = "q2", author = "Abe", t = t, fields = { pid = "Abe.a1", item = "Elixir of the Mongoose", count = 5, note = "", state = "o" } })
table.insert(__recs, { type = "bq", key = "q3", author = "Zed", t = t, fields = { pid = "Zed.z1", item = "Elixir of the Mongoose", count = 2, note = "", state = "x" } })
table.insert(__recs, { type = "bq", key = "q4", author = "Zed", t = t, fields = { pid = "Zed.z1", item = "Major Mana Potion", count = 9, note = "", state = "o" } })
table.insert(__recs, { type = "BH", key = "q4", author = "Mokra", t = t, fields = { state = "s" } })`;

const arr = (v) => (Array.isArray(v) ? v : []); // an empty Lua table comes back as {}
const line = (lines, left) => { const l = arr(lines).find((x) => x[0] === left); return l ? l[1] : null; };

test('item tooltips say when a drive still wants the item and who asked the guild bank for it', () => {
  const wow = new WowClient();
  wow.login();
  wow.exec(SHARE);
  const rune = wow.get('__ns.tooltip.linesFor(14047, "Runecloth")');
  assert.strictEqual(line(rune, 'Guild goal'), '|cffe8a33d14 more wanted|r (Cloth for bandages)');
  assert.strictEqual(line(rune, 'Guild request'), 'Mokra wants 20');
  // A drive that's full says nothing; a cancelled request and one an officer handled are not listed.
  assert.strictEqual(line(wow.get('__ns.tooltip.linesFor(2589, "Linen Cloth")'), 'Guild goal'), null);
  assert.strictEqual(line(wow.get('__ns.tooltip.linesFor(13452, "Elixir of the Mongoose")'), 'Guild request'), 'Abe wants 5');
  assert.strictEqual(line(wow.get('__ns.tooltip.linesFor(13444, "Major Mana Potion")'), 'Guild request'), null);
  assert.deepStrictEqual(arr(wow.get('__ns.tooltip.linesFor(1, "Something else")')).filter((x) => /^Guild (goal|request)$/.test(x[0])), []);
  // Names match whatever the capitals.
  assert.strictEqual(line(wow.get('__ns.tooltip.linesFor(14047, "RUNECLOTH")'), 'Guild request'), 'Mokra wants 20');
  assert.strictEqual(wow.eval('__ns.debugError'), null, 'no addon errors');
});

test('the list is rebuilt at most every ten seconds', () => {
  const wow = new WowClient();
  wow.login();
  wow.exec(SHARE);
  wow.exec('__clock = 100; GetTime = function() return __clock end; __ns.tooltip.resetWants()');
  assert.strictEqual(line(wow.get('__ns.tooltip.linesFor(14047, "Runecloth")'), 'Guild request'), 'Mokra wants 20');
  wow.exec('table.insert(__recs, { type = "bq", key = "q9", author = "Zed", t = GetServerTime(), fields = { pid = "Zed.z1", item = "Runecloth", count = 3, note = "", state = "o" } })');
  wow.exec('__clock = 105');
  assert.strictEqual(line(wow.get('__ns.tooltip.linesFor(14047, "Runecloth")'), 'Guild request'), 'Mokra wants 20', 'still the cached list');
  wow.exec('__clock = 111');
  assert.strictEqual(line(wow.get('__ns.tooltip.linesFor(14047, "Runecloth")'), 'Guild request'), 'Mokra wants 20, Zed wants 3');
});

test("a request's name with |c or |r in it shows as text on the tooltip (review of #67)", () => {
  const wow = new WowClient();
  wow.login();
  wow.exec(SHARE);
  wow.exec('table.insert(__recs, { type = "bq", key = "q9", author = "Ev|cffff0000il|r", t = GetServerTime(), fields = { pid = "Evil.e1", item = "Silk Cloth", count = 3, note = "", state = "o" } })');
  assert.strictEqual(line(wow.get('__ns.tooltip.linesFor(4306, "Silk Cloth")'), 'Guild request'), 'Ev||cffff0000il||r wants 3');
  assert.strictEqual(wow.eval('__ns.debugError'), null, 'no addon errors');
});
