'use strict';
// Recruit.lua: the recruiting desk. One /who search per click, the queue (unguilded, not contacted, wanted classes
// first), Message (one whisper, the daily cap), replies and people asking to join, officers' invites (by name link
// where the game blocks addon invites), joining, the channel ad, and the one-key "next step".
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

test('Message: one whisper, the guild told, the daily cap; replies; invite; joined', () => {
  const wow = client();
  wow.exec('__ns.recruit.scan()');
  wow.fire('WHO_LIST_UPDATE');
  assert.strictEqual(wow.eval('tostring(__ns.recruit.message("Healer"))'), 'true');
  assert.deepStrictEqual(wow.get('__sent'), ['WHISPER|Healer|Hey Healer, want in?'], 'one whisper, to that player');
  assert.strictEqual(wow.eval('#__chat'), '0', 'the chat box is left alone');
  wow.exec('__rk = __ns.Share.get("rk:Healer")');
  assert.strictEqual(wow.eval('__rk.fields.state'), 'c');
  assert.strictEqual(wow.eval('__rk.fields.class'), 'PRIEST');
  assert.strictEqual(wow.eval('#__ns.recruit.queue()'), '1');
  // Their answer.
  assert.strictEqual(wow.eval('__ns.recruit.whisper("hey who is this", "Healer-Forever")'), null);
  wow.fire('CHAT_MSG_WHISPER', 'Yeah sure!', 'Healer-Forever');
  assert.strictEqual(wow.eval('__ns.Share.get("rk:Healer").fields.state'), 'i');
  assert.strictEqual(wow.eval('__ns.Share.get("rk:Healer").fields.pid'), 'Thrallia.p4m7', 'the finder stays');
  assert.match(wow.printed(), /\|Hplayer:Healer\|h\[Healer\]\|h wants to join the guild/, 'the name is a link to right-click');
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
  assert.strictEqual(wow.eval('__sent[#__sent]'), 'CHANNEL|4|wow is recruiting! /w me');
  assert.strictEqual(wow.eval('tostring(__ns.recruit.postAd())'), 'false');
  assert.match(wow.printed(), /The ad went out recently/);
  wow.exec('__officer = false; C_GuildInfo.CanEditOfficerNote = nil');
  assert.strictEqual(wow.eval('tostring(__ns.recruit.invite("Healer"))'), 'false');
  assert.strictEqual(wow.eval('__ns.debugError'), null);
});

test('surnames (WoW Forever): "Be Fachada" is Be, queued and whispered as Be', () => {
  const wow = client();
  wow.exec(`__who = { { fullName = "Be Fachada", fullGuildName = "", level = 12, classStr = "Paladin", area = "Durotar", filename = "PALADIN" } }
__ns.db.recruit = { queue = { ["Korty Ul"] = { name = "Korty Ul", level = 11, seen = GetServerTime() } }, skip = {}, sent = {}, bracket = 0 }`);
  wow.exec('__ns.recruit.scan()');
  wow.fire('WHO_LIST_UPDATE');
  assert.strictEqual(wow.eval('#__ns.recruit.queue()'), '1', 'the old "Korty Ul" entry is dropped');
  assert.strictEqual(wow.eval('__ns.recruit.queue()[1].name'), 'Be');
  assert.strictEqual(wow.eval('tostring(__ns.recruit.message("Be"))'), 'true');
  assert.strictEqual(wow.eval('__sent[1]'), 'WHISPER|Be|Hey Be, want in?');
  assert.strictEqual(wow.eval('__ns.Share.get("rk:Be").fields.state'), 'c');
  wow.fire('CHAT_MSG_WHISPER', 'yes please', 'Be Fachada');
  assert.strictEqual(wow.eval('__ns.Share.get("rk:Be").fields.state'), 'i');
  wow.fire('CHAT_MSG_SYSTEM', 'Be Fachada has joined the guild.');
  assert.strictEqual(wow.eval('__ns.Share.get("rk:Be").fields.state'), 'j');
  assert.strictEqual(wow.eval('__ns.debugError'), null);
});

// ---------------------------------------------------------------- 0.22: invites the game blocks, one key, busy brackets, asks

test('WoW Forever: no invite is tried from the addon; the officer gets the name as a link to right-click', () => {
  const wow = client();
  wow.exec('WOW_PROJECT_CAMELOT = 18; WOW_PROJECT_ID = 18');
  assert.strictEqual(wow.eval('tostring(__ns.recruit.canInviteByAddon())'), 'false');
  wow.clearOutput();
  assert.strictEqual(wow.eval('__ns.recruit.invite("Healer")'), 'link');
  assert.strictEqual(wow.eval('#__invites'), '0', 'the protected call is never made');
  assert.match(wow.printed(), /\|Hplayer:Healer\|h\[Healer\]\|h wants to join the guild\.\|r Right-click the name and choose Invite to guild\./);
  wow.exec('table.insert(__recs, { type = "rk", key = "Healer", author = "Mokra", fields = { pid = "Mokra.m1", state = "i", at = GetServerTime() } }); __ns.recruit.show()');
  assert.strictEqual(wow.eval('WowGuildRecruit.rows[1].go:GetText()'), 'Show name');
  assert.strictEqual(wow.eval('__ns.debugError'), null);
});

test('elsewhere: the game refusing an addon invite is remembered, and the link is given instead', () => {
  const wow = client();
  wow.exec('WOW_PROJECT_ID = 1');
  assert.strictEqual(wow.eval('__ns.recruit.invite("Healer")'), 'asked');
  assert.strictEqual(wow.eval('__invites[1]'), 'Healer');
  // The game says the action was forbidden for our addon.
  wow.clearOutput();
  wow.fire('ADDON_ACTION_FORBIDDEN', 'SomeOtherAddon', 'GuildInvite()');
  assert.strictEqual(wow.eval('tostring(__ns.db.recruit.inviteBlocked)'), 'nil', 'another addon\'s block is not ours');
  wow.fire('ADDON_ACTION_FORBIDDEN', 'WowGuild', 'C_GuildInfo.Invite()');
  assert.strictEqual(wow.eval('tostring(__ns.db.recruit.inviteBlocked)'), 'true');
  assert.match(wow.printed(), /doesn't let addons send guild invites here/);
  assert.match(wow.printed(), /\|Hplayer:Healer\|h\[Healer\]\|h/);
  assert.strictEqual(wow.eval('__ns.recruit.invite("Lonewolf")'), 'link');
  assert.strictEqual(wow.eval('#__invites'), '1', 'not tried again');
  // An invite function that throws counts as blocked too.
  wow.exec('__ns.db.recruit.inviteBlocked = nil; C_GuildInfo.Invite = function() error("blocked") end');
  assert.strictEqual(wow.eval('__ns.recruit.invite("Lonewolf")'), 'link');
  assert.strictEqual(wow.eval('__ns.debugError'), null);
});

test('one key: each press does one thing: search, then message the best, wait between, show who wants in', () => {
  const wow = client();
  wow.exec('__clock = GetServerTime(); GetServerTime = function() return __clock end; WOW_PROJECT_CAMELOT = 18; WOW_PROJECT_ID = 18');
  const step = () => wow.eval('(__ns.recruit.next())');
  assert.strictEqual(wow.eval('__ns.recruit.peek().text'), 'Search /who 10-14');
  assert.strictEqual(step(), 'scan');
  assert.deepStrictEqual(wow.get('__whos'), ['10-14']);
  wow.fire('WHO_LIST_UPDATE');
  // Two in the queue: the wanted class first. One press, one whisper.
  assert.strictEqual(wow.eval('__ns.recruit.peek().text'), 'Message Healer (12 Priest)');
  assert.strictEqual(step(), 'message');
  assert.deepStrictEqual(wow.get('__sent'), ['WHISPER|Healer|Hey Healer, want in?']);
  // Too soon for the next message: nothing is sent.
  assert.strictEqual(step(), 'wait');
  assert.strictEqual(wow.eval('#__sent'), '1');
  wow.exec('__clock = __clock + 4');
  assert.strictEqual(step(), 'message');
  assert.strictEqual(wow.eval('__sent[2]'), 'WHISPER|Lonewolf|Hey Lonewolf, want in?');
  // The queue is empty: the next press would search, but /who needs its gap.
  assert.strictEqual(step(), 'wait');
  assert.strictEqual(wow.eval('#__whos'), '1');
  wow.exec('__clock = __clock + 10');
  assert.strictEqual(step(), 'scan');
  assert.deepStrictEqual(wow.get('__whos'), ['10-14', '15-19']);
  // Healer says yes: the next press shows the name to invite, once, then goes back to work.
  wow.fire('CHAT_MSG_WHISPER', 'yes', 'Healer');
  wow.exec('__ns.db.recruit.shown = {}; __clock = __clock + 10');
  wow.clearOutput();
  assert.strictEqual(wow.eval('__ns.recruit.peek().text'), 'Show Healer (wants in)');
  assert.strictEqual(step(), 'invite');
  assert.match(wow.printed(), /\|Hplayer:Healer\|h/);
  assert.strictEqual(step(), 'scan', 'not shown again for two minutes');
  // The key binding and /wow recruit next are the same step.
  wow.exec('__clock = __clock + 10; WowGuild_RecruitNext()');
  assert.strictEqual(wow.eval('#__whos'), '4');
  // At the daily limit a press with a full queue searches instead of messaging.
  wow.exec('__ns.db.recruit.queue.Extra = { name = "Extra", level = 20, seen = __clock }; __ns.db.recruit.sent[math.floor(__clock / 86400)] = 30; __clock = __clock + 10');
  assert.strictEqual(step(), 'scan');
  assert.strictEqual(wow.eval('#__sent'), '2');
  assert.strictEqual(wow.eval('__ns.debugError'), null);
});

test('a full /who list is searched again class by class, then the next bracket', () => {
  const wow = client();
  wow.exec(`__clock = GetServerTime(); GetServerTime = function() return __clock end
    local full = {}
    for i = 1, 50 do full[i] = { fullName = "P" .. string.char(64 + math.floor((i - 1) / 26) + 1) .. string.char(97 + (i - 1) % 26), fullGuildName = "", level = 12, classStr = "Mage", area = "X", filename = "MAGE" } end
    __who = full`);
  wow.exec('__ns.recruit.scan()');
  wow.clearOutput();
  wow.fire('WHO_LIST_UPDATE');
  assert.match(wow.printed(), /That level range is busy: the next searches go class by class\./);
  wow.exec('__who = {}');
  const queries = [];
  for (let i = 0; i < 10; i += 1) {
    wow.exec('__clock = __clock + 10; __ns.recruit.scan()');
    wow.fire('WHO_LIST_UPDATE');
    queries.push(wow.eval('__whos[#__whos]'));
  }
  assert.deepStrictEqual(queries.slice(0, 3), ['10-14 c-"Warrior"', '10-14 c-"Paladin"', '10-14 c-"Hunter"']);
  assert.strictEqual(queries[8], '10-14 c-"Druid"');
  assert.strictEqual(queries[9], '15-19', 'after the last class, the next bracket');
  assert.strictEqual(wow.eval('__ns.debugError'), null);
});

test('someone we never messaged asks to join the guild: they go on the list as interested', () => {
  const wow = client();
  wow.exec(`local roster = { { "Guildmate-Zuljin", "Pup", 3, 20, "Mage", "Orgrimmar", "", "", true } }
    function GetNumGuildMembers() return #roster end
    function GetGuildRosterInfo(i) return unpack(roster[i]) end`);
  // Ordinary whispers, and "inv" for a dungeon, are not asks.
  for (const t of ['hey', 'inv please', 'what guild are you in', 'no guild for me thanks, not interested in an invite']) {
    wow.fire('CHAT_MSG_WHISPER', t, 'Stranger');
    assert.strictEqual(wow.eval('tostring((__ns.Share.get("rk:Stranger")))'), 'nil', t);
  }
  wow.clearOutput();
  wow.fire('CHAT_MSG_WHISPER', 'Hi! Can I join your guild?', 'Stranger-Zuljin');
  assert.strictEqual(wow.eval('__ns.Share.get("rk:Stranger").fields.state'), 'i');
  assert.strictEqual(wow.eval('__ns.Share.get("rk:Stranger").fields.pid'), 'Thrallia.p4m7');
  assert.match(wow.printed(), /\|Hplayer:Stranger\|h\[Stranger\]\|h wants to join the guild/);
  // A guildmate saying the same words is not a recruit.
  wow.fire('CHAT_MSG_WHISPER', 'did you invite him to the guild?', 'Guildmate');
  assert.strictEqual(wow.eval('tostring((__ns.Share.get("rk:Guildmate")))'), 'nil');
  // A member who can't invite still records it; they're told the officers can.
  wow.exec('__officer = false; C_GuildInfo.CanEditOfficerNote = nil');
  wow.clearOutput();
  wow.fire('CHAT_MSG_WHISPER', 'is your guild recruiting?', 'Other');
  assert.strictEqual(wow.eval('__ns.Share.get("rk:Other").fields.state'), 'i');
  assert.match(wow.printed(), /Other wants in!\|r Your officers can invite them now/);
  assert.strictEqual(wow.eval('__ns.debugError'), null);
});
