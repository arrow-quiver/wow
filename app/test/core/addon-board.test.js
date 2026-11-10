'use strict';
// The bulletin board in game (Board.lua): list, post (with a price for selling and buying), take down my own,
// and one chat line for a guildmate's fresh post.
const test = require('node:test');
const assert = require('node:assert');
const { WowClient } = require('./wowsim');

const STUBS = `__recs = {}
__ns.Share = __ns.Share or {}
__ns.Share.myPid = function() return "Thrallia.p4m7" end
__ns.Share.list = function(ty) local out = {} for _, r in ipairs(__recs) do if r.type == ty then out[#out + 1] = r end end return out end
__ns.Share.putLocal = function(ty, key, f)
  for i, r in ipairs(__recs) do if r.key == key then table.remove(__recs, i) break end end
  table.insert(__recs, { type = ty, key = key, fields = f, author = "Thrallia", t = (__t or 1000) }) __t = (__t or 1000) + 1
  return {}
end
table.insert(__recs, { type = "bb", key = "jb0001", author = "Jaina", t = 900, fields = { pid = "Jaina.j000", character = "Jaina", kind = "l", text = "LF2M SM Armory", state = "o" } })`;

test('the board: post, list newest first, price parsing, take down only mine', () => {
  const wow = new WowClient();
  wow.login();
  wow.exec(STUBS);
  assert.strictEqual(wow.eval('select(2, __ns.board.parse("Mooncloth x4 12g 50s"))'), '125000');
  assert.strictEqual(wow.eval('__ns.board.parse("Mooncloth x4 12g 50s")'), 'Mooncloth x4');
  assert.strictEqual(wow.eval('select(2, __ns.board.parse("Need 5 Iron Bars"))'), null);
  wow.exec('__ns.board.slash("wts Mooncloth x4 12g")');
  assert.strictEqual(wow.eval('__recs[2].fields.price'), '120000');
  assert.strictEqual(wow.eval('__recs[2].fields.kind'), 's');
  // A price on an LFG post is just text.
  wow.exec('__ns.board.slash("lfg ZF run 5g")');
  assert.strictEqual(wow.eval('__recs[3].fields.price'), null);
  assert.strictEqual(wow.eval('__recs[3].fields.text'), 'ZF run');
  assert.strictEqual(wow.eval('__ns.board.list()'), '3');
  assert.strictEqual(wow.eval('__ns.board.posts()[1].text'), 'ZF run');
  // Jaina's post (number 3) isn't mine.
  assert.strictEqual(wow.eval('tostring(__ns.board.takeDown(3))'), 'false');
  assert.strictEqual(wow.eval('tostring(__ns.board.takeDown(1))'), 'true');
  assert.strictEqual(wow.eval('__ns.board.list()'), '2');
  assert.strictEqual(wow.eval('tostring(__ns.board.post("nope", "x"))'), 'false');
  assert.strictEqual(wow.eval('__ns.debugError'), null);
});

test("a guildmate's fresh post gets one chat line; mine and old ones don't", () => {
  const wow = new WowClient();
  wow.login();
  wow.exec(STUBS);
  wow.exec('__now = GetServerTime()');
  const rec = (key, author, t, text) => `{ type = "bb", key = "${key}", author = "${author}", t = ${t}, fields = { character = "${author}", kind = "s", text = "${text}", price = 5000, state = "o" } }`;
  assert.strictEqual(wow.eval(`__ns.board.arrived(${rec('aa0001', 'Grom', '__now - 10', 'Wolf meat')}, "m", "Grom")`), '|cffe8a33dBoard|r Selling: Wolf meat (50s) — Grom (/wow board)');
  assert.strictEqual(wow.eval(`__ns.board.arrived(${rec('aa0001', 'Grom', '__now - 10', 'Wolf meat')}, "m", "Grom")`), null);
  assert.strictEqual(wow.eval(`__ns.board.arrived(${rec('aa0002', 'Grom', '__now - 5000', 'Old')}, "m", "Grom")`), null);
  assert.strictEqual(wow.eval(`__ns.board.arrived(${rec('aa0003', 'Thrallia', '__now', 'Mine')}, "d", "Thrallia")`), null);
  assert.strictEqual(wow.eval('__ns.debugError'), null);
});
