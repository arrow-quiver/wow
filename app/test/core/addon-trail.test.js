'use strict';
// Trail.lua and the Camp › Getting started page: a new member's first steps, ticked as they happen.
const test = require('node:test');
const assert = require('node:assert');
const { WowClient } = require('./wowsim');

const noError = (wow) => assert.strictEqual(wow.eval('__ns.debugError'), null, 'no addon errors');
const txt = (wow, expr) => wow.eval(`tostring(${expr}:GetText())`);
const shown = (wow, expr) => wow.eval(`tostring(${expr}:IsShown())`);

const SHARE = `__recs = {}
__ns.Share = __ns.Share or {}
__ns.Share.myPid = function() return "Thrallia.p4m7" end
__ns.Share.list = function(ty) local out = {} for _, r in ipairs(__recs) do if r.type == ty then out[#out + 1] = r end end return out end
__ns.Share.get = function(id) for _, r in ipairs(__recs) do if r.type .. ":" .. r.key == id then return r end end end
__ns.Share.putLocal = function(ty, key, f) table.insert(__recs, { type = ty, key = key, fields = f, author = "Thrallia", t = GetServerTime() }) return {} end
function IsInGuild() return true end
table.insert(__recs, { type = "DR", key = "d1", author = "Mokra", t = GetServerTime(), fields = { title = "Runecloth", unit = "Runecloth", goal = 200, notes = "", state = "o" } })`;

function client(opts = {}) {
  const wow = new WowClient(opts);
  wow.login();
  wow.exec(SHARE);
  // The harness logs in a character with professions already scanned: start from a blank one.
  wow.exec('local me = __ns.db.characters[__ns.charKey()]; if me then me.professions = {} end; WowGuildDB.trail = nil');
  wow.clearOutput();
  return wow;
}
const done = (wow) => wow.get('(function() local s = __ns.trail.state() local t = {} for _, x in ipairs(s) do if x.done then t[#t + 1] = x.id end end return t end)()') || [];

test('steps tick when the thing actually happens, and stay ticked', () => {
  const wow = client();
  assert.deepStrictEqual(Array.from(done(wow)), [], 'nothing yet (no app inbox, no professions)');
  assert.strictEqual(wow.eval('__ns.trail.line()'), 'Getting started: 0 of 5 done.');
  // A failed action doesn't tick: a group without a role, an empty post, a gift that isn't a number.
  wow.exec('__ns.lfg.new("Deadmines"); __ns.board.post("wts", ""); __ns.goals.give("d1", "lots")');
  assert.deepStrictEqual(Array.from(done(wow)), []);
  // The real ones do.
  wow.exec('__ns.lfg.new("tank Deadmines")');
  assert.deepStrictEqual(Array.from(done(wow)), ['group']);
  wow.exec('__ns.board.post("wts", "Mooncloth 12g")');
  wow.exec('__ns.goals.give("d1", "20")');
  assert.deepStrictEqual(Array.from(done(wow)), ['group', 'social', 'give']);
  // The app and professions are read from what's there.
  wow.exec('WowGuildInbox = { guild = "wow" }; __ns.db.characters[__ns.charKey()] = { professions = { { name = "Tailoring" } } }');
  assert.deepStrictEqual(Array.from(done(wow)), ['app', 'prof', 'group', 'social', 'give']);
  assert.strictEqual(wow.eval('tostring(__ns.trail.line())'), 'nil', 'no reminder once everything is done');
  // Ticks are kept (SavedVariables), also when the inbox is gone again.
  wow.exec('WowGuildInbox = nil');
  assert.strictEqual(Array.from(done(wow)).length, 5);
  assert.ok(wow.db().trail.group > 0);
  noError(wow);
});

test('answering a call to arms counts as the social step; the wrapped functions still return what they did', () => {
  const wow = client();
  assert.strictEqual(wow.eval('tostring(__ns.presence.answer("Mokra"))'), 'true');
  assert.deepStrictEqual(Array.from(done(wow)), ['social']);
  assert.strictEqual(wow.eval('tostring(__ns.lfg.new("nonsense"))'), 'false');
  assert.strictEqual(wow.eval('tostring(__ns.goals.give("d1", 5))'), 'true');
  noError(wow);
});

test('Getting started page: the list with Go there, the Today reminder, and telling the guild once at the end', () => {
  const wow = client();
  wow.exec(`__guildchat = {}
    C_ChatInfo.SendChatMessage = function(text, kind) table.insert(__guildchat, kind .. ">" .. text) end
    SendChatMessage = C_ChatInfo.SendChatMessage
    __ns.ui.show("trail")`);
  const p = 'WowGuildWindow.pages.trail';
  assert.ok(wow.texts().includes('Getting started: 0 of 5 done'));
  assert.strictEqual(txt(wow, `${p}.rows[3].title`), 'Join or start a guild group');
  assert.strictEqual(shown(wow, `${p}.tell`), 'false');
  // Go there opens the page that does the step.
  wow.click(`${p}.rows[3].btn`);
  assert.strictEqual(wow.eval('__ns.ui.current'), 'groups');
  // Today reminds while something is left; hiding it stops that.
  wow.exec('__ns.ui.show("camp")');
  assert.ok(wow.texts().some((t) => /Getting started: 0 of 5 done\./.test(t)));
  wow.exec('__ns.ui.show("trail")');
  wow.click(`${p}.hide`);
  assert.strictEqual(wow.eval('tostring(__ns.trail.line())'), 'nil');
  assert.strictEqual(shown(wow, `${p}.hide`), 'false');
  // Everything done: tell the guild, once.
  wow.exec('for _, s in ipairs(__ns.trail.STEPS) do __ns.trail.done(s.id) end; __ns.ui.show("trail")');
  assert.ok(wow.texts().includes("You're all set. Welcome to the pack!"));
  assert.strictEqual(wow.eval(`tostring(${p}.rows[1].done)`), 'true');
  assert.strictEqual(shown(wow, `${p}.rows[1].btn`), 'false');
  assert.strictEqual(shown(wow, `${p}.tell`), 'true');
  assert.strictEqual(wow.eval('#__guildchat'), '0', 'nothing is posted until the click');
  wow.click(`${p}.tell`);
  assert.strictEqual(wow.eval('#__guildchat'), '1');
  assert.match(wow.eval('__guildchat[1]'), /^GUILD>\[Guild Camp\] I've finished getting started/);
  assert.strictEqual(shown(wow, `${p}.tell`), 'false');
  assert.strictEqual(wow.eval('tostring(__ns.trail.announce())'), 'nil', 'only once');
  noError(wow);
});
