'use strict';
// Recruit.lua: the recruiting desk. One /who search per click, the queue (unguilded, not contacted, wanted classes
// first), Message (chat box filled in, the daily cap), replies, officers' invites, joining, and the channel ad.
const test = require('node:test');
const assert = require('node:assert');
const { WowClient } = require('./wowsim');

const SETUP = `__recs = {}
__ns.Share = __ns.Share or {}
__ns.Share.myPid = function() return "Thrallia.p4m7" end
__ns.Share.list = function(ty) local out = {} for _, r in ipairs(__recs) do if r.type == ty then out[#out + 1] = r end end return out end
__ns.Share.get = function(id) for _, r in ipairs(__recs) do if r.type .. ":" .. r.key == id then return r end end end
__ns.Share.putLocal = function(ty, key, f)
  for i, r in ipairs(__recs) do if r.type == ty and r.key == key then table.remove(__recs, i) break end end
  local r = { type = ty, key = key, fields = f, author = "Thrallia" }
  table.insert(__recs, r) return r
end
table.insert(__recs, { type = "RA", key = "1", author = "Thrallia", fields = { ad = "wow is recruiting! /w me", msg = "Hey {name}, want in?", classes = "PRIEST", minLevel = 10, maxLevel = 30 } })
table.insert(__recs, { type = "rk", key = "Taken", author = "Mokra", fields = { pid = "Mokra.m1", state = "c", at = 1 } })
__whos = {}
C_FriendList = { SendWho = function(q) table.insert(__whos, q) end,
  GetNumWhoResults = function() return #__who end,
  GetWhoInfo = function(i) return __who[i] end }
__who = {
  { fullName = "Guildy", fullGuildName = "Some Guild", level = 20, classStr = "Mage", area = "Orgrimmar", filename = "MAGE" },
  { fullName = "Lonewolf", fullGuildName = "", level = 14, classStr = "Warrior", area = "The Barrens", filename = "WARRIOR" },
  { fullName = "Healer", fullGuildName = "", level = 12, classStr = "Priest", area = "The Barrens", filename = "PRIEST" },
  { fullName = "Taken", fullGuildName = "", level = 13, classStr = "Rogue", area = "Durotar", filename = "ROGUE" },
}
__chat = {}
ChatFrame_OpenChat = function(t) table.insert(__chat, t) end
__sent = {}
SendChatMessage = function(text, chan, _, to) table.insert(__sent, chan .. "|" .. tostring(to) .. "|" .. text) end
C_ChatInfo.SendChatMessage = nil
__invites = {}
C_GuildInfo.Invite = function(n) table.insert(__invites, n) end
__officer = true
CanGuildInvite = function() return __officer end`;

function client() {
  const wow = new WowClient();
  wow.login();
  wow.exec(SETUP);
  return wow;
}

test('scanning: one /who a click through the level brackets; unguilded and not contacted only; wanted classes first', () => {
  const wow = client();
  assert.strictEqual(wow.eval('__ns.recruit.scan()'), '10-14');
  assert.strictEqual(wow.eval('__whos[1]'), '10-14');
  wow.fire('WHO_LIST_UPDATE');
  assert.strictEqual(wow.eval('#__ns.recruit.queue()'), '2');
  assert.strictEqual(wow.eval('__ns.recruit.queue()[1].name'), 'Healer', 'a priest: wanted');
  // Results of a /who we didn't ask for are left alone.
  wow.fire('WHO_LIST_UPDATE');
  assert.strictEqual(wow.eval('#__ns.recruit.queue()'), '2');
  assert.strictEqual(wow.eval('__ns.recruit.scan()'), '15-19');
  assert.strictEqual(wow.eval('__ns.recruit.scan()'), '20-24');
  assert.strictEqual(wow.eval('__ns.recruit.scan()'), '25-29');
  assert.strictEqual(wow.eval('__ns.recruit.scan()'), '30-30');
  assert.strictEqual(wow.eval('__ns.recruit.scan()'), '10-14', 'round again');
  assert.strictEqual(wow.eval('__ns.debugError'), null);
});

test('Message: the chat box filled in, the guild told, the daily cap; replies; invite; joined', () => {
  const wow = client();
  wow.exec('__ns.recruit.scan()');
  wow.fire('WHO_LIST_UPDATE');
  assert.strictEqual(wow.eval('tostring(__ns.recruit.message("Healer"))'), 'true');
  assert.strictEqual(wow.eval('__chat[1]'), '/w Healer Hey Healer, want in?');
  assert.strictEqual(wow.eval('#__sent'), '0', 'nothing is sent for you');
  wow.exec('__rk = __ns.Share.get("rk:Healer")');
  assert.strictEqual(wow.eval('__rk.fields.state'), 'c');
  assert.strictEqual(wow.eval('__rk.fields.class'), 'PRIEST');
  assert.strictEqual(wow.eval('#__ns.recruit.queue()'), '1');
  // Their answer.
  assert.strictEqual(wow.eval('__ns.recruit.whisper("hey who is this", "Healer-Forever")'), null);
  wow.fire('CHAT_MSG_WHISPER', 'Yeah sure!', 'Healer-Forever');
  assert.strictEqual(wow.eval('__ns.Share.get("rk:Healer").fields.state'), 'i');
  assert.strictEqual(wow.eval('__ns.Share.get("rk:Healer").fields.pid'), 'Thrallia.p4m7', 'the finder stays');
  assert.match(wow.printed(), /Healer wants in!/);
  // Officers: invite on a click.
  wow.exec('__ns.recruit.show()');
  assert.match(wow.eval('WowGuildRecruit.rows[1].name:GetText()'), /Healer.*wants in/);
  wow.click('WowGuildRecruit.rows[1].go');
  assert.strictEqual(wow.eval('__invites[1]'), 'Healer');
  wow.fire('CHAT_MSG_SYSTEM', 'Healer has joined the guild.');
  assert.strictEqual(wow.eval('__ns.Share.get("rk:Healer").fields.state'), 'j');
  // The daily cap.
  wow.exec(`__ns.db.recruit.sent[math.floor(GetServerTime() / 86400)] = 30`);
  assert.strictEqual(wow.eval('tostring(__ns.recruit.message("Lonewolf"))'), 'false');
  assert.match(wow.printed(), /That's 30 messages today/);
  assert.strictEqual(wow.eval('__ns.debugError'), null);
});

test('a "no thanks"; Skip; the ad once every 15 minutes; members can\'t invite', () => {
  const wow = client();
  wow.exec('__ns.recruit.scan()');
  wow.fire('WHO_LIST_UPDATE');
  wow.exec('__ns.recruit.message("Lonewolf")');
  wow.fire('CHAT_MSG_WHISPER', 'no thanks', 'Lonewolf');
  assert.strictEqual(wow.eval('__ns.Share.get("rk:Lonewolf").fields.state'), 'n');
  wow.exec('__ns.recruit.skip("Healer")');
  assert.strictEqual(wow.eval('#__ns.recruit.queue()'), '0');
  wow.exec('__ns.recruit.scan()');
  wow.fire('WHO_LIST_UPDATE');
  assert.strictEqual(wow.eval('#__ns.recruit.queue()'), '0', 'skipped and contacted stay out');
  wow.exec('GetChannelName = function(n) if n == "LookingForGroup" then return 4 end return 0 end');
  assert.strictEqual(wow.eval('tostring(__ns.recruit.postAd())'), 'true');
  assert.strictEqual(wow.eval('__sent[1]'), 'CHANNEL|4|wow is recruiting! /w me');
  assert.strictEqual(wow.eval('tostring(__ns.recruit.postAd())'), 'false');
  assert.match(wow.printed(), /The ad went out recently/);
  wow.exec('__officer = false; C_GuildInfo.CanEditOfficerNote = nil');
  assert.strictEqual(wow.eval('tostring(__ns.recruit.invite("Healer"))'), 'false');
  assert.strictEqual(wow.eval('__ns.debugError'), null);
});
