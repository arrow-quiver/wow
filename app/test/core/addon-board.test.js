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

// ---------------------------------------------------------------- the Bulletin board page of the guild window

test('Bulletin board page: posts as rows; whisper the poster, take my own down, put one up by kind', () => {
  const wow = new WowClient();
  wow.login();
  wow.exec(STUBS);
  wow.exec(`__recs = {}; __t = GetServerTime(); __chat = {}
    function ChatFrame_OpenChat(text) table.insert(__chat, text) end
    local t = GetServerTime()
    table.insert(__recs, { type = "bb", key = "p1", author = "Mokra", t = t - 600, fields = { pid = "Mokra.m1", character = "Mokra", kind = "s", text = "Mooncloth x4", price = 120000, state = "o" } })
    table.insert(__recs, { type = "bb", key = "p2", author = "Zed", t = t - 900, fields = { pid = "Zed.z1", character = "Zed", kind = "l", text = "ZF run tonight", state = "o" } })
    table.insert(__recs, { type = "bb", key = "p3", author = "Zed", t = t - 950, fields = { pid = "Zed.z1", character = "Zed", kind = "h", text = "old", state = "x" } })`);
  wow.clearOutput();
  wow.exec('__ns.ui.show("board")');
  const p = 'WowGuildWindow.pages.board';
  const t = (expr) => wow.eval(`tostring(${expr}:GetText())`);
  assert.ok(wow.texts().includes('2 posts on the board'));
  assert.strictEqual(t(`${p}.rows[1].kind`), '|cff40bf40Selling|r');
  assert.strictEqual(t(`${p}.rows[1].text`), 'Mooncloth x4  |cffffd10012g|r');
  assert.match(t(`${p}.rows[1].who`), /^Mokra, /);
  assert.strictEqual(t(`${p}.rows[1].btn`), 'Whisper');
  assert.strictEqual(t(`${p}.rows[2].kind`), '|cff66b3ffLFG|r');
  assert.strictEqual(wow.eval(`tostring(${p}.rows[3]:IsShown())`), 'false', 'the taken-down post is not listed');
  // Whisper: the chat box opens on the poster; nothing is sent.
  wow.click(`${p}.rows[1].btn`);
  assert.deepStrictEqual(wow.get('__chat'), ['/w Mokra ']);
  // Put one up: write it, pick the kind.
  wow.click(`${p}.post.wtb`);
  assert.strictEqual(t(`${p}.status`), 'Write the post first.');
  wow.exec(`${p}.input:SetText("Wool Cloth x20 2g")`);
  wow.click(`${p}.post.wtb`);
  assert.match(t(`${p}.status`), /^Posted to the guild board: Buying Wool Cloth x20 \(2g\)/);
  assert.strictEqual(t(`${p}.input`), '');
  assert.ok(wow.texts().includes('3 posts on the board'));
  // Mine has Take down.
  const mine = [1, 2, 3].find((i) => wow.eval(`tostring(${p}.rows[${i}].mine)`) === 'true');
  assert.match(t(`${p}.rows[${mine}].who`), /^you, /);
  assert.strictEqual(t(`${p}.rows[${mine}].btn`), 'Take down');
  wow.click(`${p}.rows[${mine}].btn`);
  assert.strictEqual(t(`${p}.status`), 'Post taken down.');
  assert.ok(wow.texts().includes('2 posts on the board'));
  assert.strictEqual(wow.printed(), '', 'nothing goes to chat');
  assert.strictEqual(wow.eval('__ns.debugError'), null, 'no addon errors');
});

// ---------------------------------------------------------------- review of #60

test('Take down on a row removes that post even after a newer one arrives; a rejected post or take-down is a failure', () => {
  const wow = new WowClient();
  wow.login();
  wow.exec(STUBS);
  wow.exec(`__recs = {}
    local t = GetServerTime()
    table.insert(__recs, { type = "bb", key = "m1", author = "Thrallia", t = t - 600, fields = { pid = "Thrallia.p4m7", character = "Thrallia", kind = "s", text = "Mine A", state = "o" } })
    table.insert(__recs, { type = "bb", key = "m2", author = "Thrallia", t = t - 900, fields = { pid = "Thrallia.p4m7", character = "Thrallia", kind = "s", text = "Mine B", state = "o" } })`);
  wow.exec('__ns.ui.show("board")');
  const p = 'WowGuildWindow.pages.board';
  assert.strictEqual(wow.eval(`tostring(${p}.rows[1].text:GetText())`), 'Mine A');
  // A newer post of mine lands after the page was drawn: every index shifts by one.
  wow.exec(`table.insert(__recs, { type = "bb", key = "m3", author = "Thrallia", t = GetServerTime(), fields = { pid = "Thrallia.p4m7", character = "Thrallia", kind = "l", text = "Mine C", state = "o" } })`);
  wow.click(`${p}.rows[1].btn`);
  assert.strictEqual(wow.eval(`tostring(${p}.status:GetText())`), 'Post taken down.');
  const state = (k) => wow.eval(`(function() for _, r in ipairs(__recs) do if r.key == "${k}" then return r.fields.state end end end)()`);
  assert.strictEqual(state('m1'), 'x', 'the post on the clicked row is the one taken down');
  assert.strictEqual(state('m3'), 'o', 'the newer post is untouched');
  assert.strictEqual(state('m2'), 'o');
  // putLocal refusing the record (returns nil and a reason) is not a post and not a take-down.
  wow.exec('__ns.Share.putLocal = function() return nil, "guild" end');
  assert.strictEqual(wow.eval('tostring(__ns.board.post("wts", "Wool 2g"))'), 'false');
  assert.strictEqual(wow.eval('tostring(__ns.board.takeDownKey("m2"))'), 'false');
  assert.strictEqual(wow.eval('__ns.debugError'), null);
});

test("a guildmate's |c, |r and |H in a post, partner row or request are shown as text", () => {
  const wow = new WowClient();
  wow.login();
  wow.exec(STUBS);
  wow.exec(`__recs = {}
    table.insert(__recs, { type = "bb", key = "e1", author = "Zed", t = GetServerTime(), fields = { pid = "Zed.z1", character = "Z|cffff0000ed", kind = "s", text = "|Hitem:1|h[Fake]|h |cffff0000red|r", state = "o" } })`);
  wow.exec('__ns.ui.show("board")');
  const p = 'WowGuildWindow.pages.board';
  assert.strictEqual(wow.eval(`tostring(${p}.rows[1].text:GetText())`), '||Hitem:1||h[Fake]||h ||cffff0000red||r');
  assert.match(wow.eval(`tostring(${p}.rows[1].who:GetText())`), /^Z\|\|cffff0000ed, /);
  wow.exec(`WowGuildInbox = { canCraft = { { item = "Vest|r", requester = "Grom|cff#2", notes = "|Hx|h" } }, myRequests = { { item = "Belt|r" } },
    buddies = { { character = "Zul|r", level = 18, zone = "|cffStone", whenText = "to|night", note = "|Hn|h" } } }`);
  const req = wow.eval('__ns.textGuildRequests()');
  assert.ok(req.includes('Vest||r') && req.includes('Grom||cff') && req.includes('||Hx||h') && req.includes('Belt||r'), req);
  wow.exec('__ns.ui.show("guild")');
  const row = wow.eval('tostring(WowGuildWindow.pages.guild.partners[1].text:GetText())');
  assert.strictEqual(row, 'Zul||r (18) in ||cffStone, to||night  |cff999999||Hn||h|r');
  assert.strictEqual(wow.eval('__ns.debugError'), null);
});
