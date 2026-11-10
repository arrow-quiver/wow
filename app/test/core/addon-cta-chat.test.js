'use strict';
// A call to arms also goes to guild chat (Core.lua ns.ctaChat), in the shape the app reads from the chat log.
const test = require('node:test');
const assert = require('node:assert');
const { WowClient } = require('./wowsim');

const STUBS = `__said = {}
SendChatMessage = function(text, chan) table.insert(__said, chan .. "|" .. text) end
C_ChatInfo = C_ChatInfo or {}; C_ChatInfo.SendChatMessage = nil
IsInGuild = function() return true end
__ns.Share = __ns.Share or {}
__ns.Share.putLocal = function() return { type = "ca" } end`;

test('a call to arms is said in guild chat too; not in a dungeon; not with the option off', () => {
  const wow = new WowClient();
  wow.login();
  wow.exec(STUBS);
  wow.exec('__ok = __ns.addCta("Hillsbrad Foothills", 3, "help at the mill!")');
  assert.strictEqual(wow.eval('tostring(__ok)'), 'true');
  assert.strictEqual(wow.eval('__said[1]'), `GUILD|[Guild Camp] Call to arms: Hillsbrad Foothills (3 needed): help at the mill! — from ${wow.eval('UnitName("player")')}`);
  wow.exec('__ns.addCta("Tarren Mill", nil, "")');
  assert.match(wow.eval('__said[2]'), /^GUILD\|\[Guild Camp\] Call to arms: Tarren Mill — from /);
  wow.exec('WowGuildDB.options.ctaChat = false; __ns.addCta("Southshore", nil, "x")');
  assert.strictEqual(wow.eval('#__said'), '2');
  wow.exec('WowGuildDB.options.ctaChat = true; __inInstance = true; __instanceType = "party"; __ns.addCta("Deadmines", nil, "x")');
  assert.strictEqual(wow.eval('#__said'), '2');
  // Long messages fit the 255-character chat limit, keeping who sent it.
  assert.ok(Number(wow.eval('#__ns.ctaText("Z", nil, string.rep("a", 300), "Grom")')) <= 255);
  assert.match(wow.eval('__ns.ctaText("Z", nil, string.rep("a", 300), "Grom")'), /\.\.\. — from Grom$/);
  assert.strictEqual(wow.eval('__ns.debugError'), null);
});
