'use strict';
// Celebrate.lua: my milestones in guild chat (once), guildmates' cheered (the Horde banner at 60), the welcome
// wagon, and today's anniversaries.
const test = require('node:test');
const assert = require('node:assert');
const { WowClient } = require('./wowsim');

const STUBS = `__said = {}; __whispers = {}
SendChatMessage = function(text, chan, _, target) if chan == "WHISPER" then table.insert(__whispers, target .. "|" .. text) else table.insert(__said, chan .. "|" .. text) end end
C_ChatInfo = C_ChatInfo or {}; C_ChatInfo.SendChatMessage = nil
IsInGuild = function() return true end`;

function client(extra = '') {
  const wow = new WowClient();
  wow.login();
  wow.exec(`${STUBS}\n${extra}`);
  return wow;
}
const me = (wow) => wow.eval('UnitName("player")');

test('level milestones: 20-50 said once; 60 with the Horde banner; other levels quiet', () => {
  const wow = client();
  wow.fire('PLAYER_LEVEL_UP', 19);
  wow.fire('PLAYER_LEVEL_UP', 20);
  wow.fire('PLAYER_LEVEL_UP', 20);
  assert.strictEqual(wow.eval('#__said'), '1');
  assert.strictEqual(wow.eval('__said[1]'), `GUILD|[Guild Camp] ${me(wow)} reached level 20! — from ${me(wow)}`);
  wow.fire('PLAYER_LEVEL_UP', 60);
  assert.match(wow.eval('__said[2]'), /reached level 60!/);
  assert.strictEqual(wow.eval('tostring(WowGuildCelebration:IsShown())'), 'true');
  assert.strictEqual(wow.eval('WowGuildCelebration.title:GetText()'), "LOK'TAR OGAR!");
  // Option off: nothing said.
  wow.exec('WowGuildDB.options.celebrate = false');
  wow.fire('PLAYER_LEVEL_UP', 30);
  assert.strictEqual(wow.eval('#__said'), '2');
  assert.strictEqual(wow.eval('__ns.debugError'), null);
});

test('epic loot is said once; green loot and other people\'s loot are not', () => {
  const wow = client('LOOT_ITEM_SELF = "You receive loot: %s."');
  const link = (color, id, name) => `|cff${color}|Hitem:${id}::::::::60:::::|h[${name}]|h|r`;
  wow.fire('CHAT_MSG_LOOT', `You receive loot: ${link('1eff00', 1, 'Green Thing')}.`);
  wow.fire('CHAT_MSG_LOOT', `Mokra receives loot: ${link('a335ee', 2, 'Their Epic')}.`);
  wow.fire('CHAT_MSG_LOOT', `You receive loot: ${link('a335ee', 19019, 'Thunderfury')}.`);
  wow.fire('CHAT_MSG_LOOT', `You receive loot: ${link('a335ee', 19019, 'Thunderfury')}.`);
  assert.strictEqual(wow.eval('#__said'), '1');
  assert.match(wow.eval('__said[1]'), /looted \|cffa335ee\|Hitem:19019.*\[Thunderfury\]\|h\|r! — from /);
});

test('professions at 150/225/300, riding and PvP rank; skills known before install stay quiet', () => {
  const wow = new WowClient();
  wow.exec(`__skills = { { "Professions", true }, { "Blacksmithing", false, nil, 230 }, { "Riding", false, nil, 75 } }
    GetNumSkillLines = function() return #__skills end
    GetSkillLineInfo = function(i) local s = __skills[i]; return s[1], s[2], nil, s[4] end
    __rank = 6; UnitPVPRank = function() return __rank end; GetPVPRankInfo = function(r) return "Rank " .. r end`);
  wow.login();
  wow.exec(STUBS);
  wow.fire('SKILL_LINES_CHANGED');
  assert.strictEqual(wow.eval('#__said'), '0', 'what I had when the addon first saw me is not news');
  wow.exec('__skills[2][4] = 300');
  wow.fire('SKILL_LINES_CHANGED');
  assert.strictEqual(wow.eval('#__said'), '1');
  assert.match(wow.eval('__said[1]'), /reached 300 in Blacksmithing!/);
  wow.exec('__rank = 7');
  wow.fire('PLAYER_PVP_RANK_CHANGED');
  assert.match(wow.eval('__said[2]'), /reached PvP rank Rank 7!/);
  assert.strictEqual(wow.eval('__ns.debugError'), null);
});

test('guildmates: a toast for a milestone, the banner for 60, nothing for my own line', () => {
  const wow = client();
  wow.fire('CHAT_MSG_GUILD', '[Guild Camp] Mokra reached level 40! — from Mokra', 'Mokra');
  assert.strictEqual(wow.eval('WowGuildToast.text:GetText()'), 'Mokra reached level 40!');
  wow.fire('CHAT_MSG_GUILD', '[Guild Camp] Zuljin reached level 60! — from Zuljin', 'Zuljin');
  assert.strictEqual(wow.eval('WowGuildCelebration.sub:GetText()'), 'Zuljin has reached level 60!');
  assert.strictEqual(wow.eval(`__ns.celebrate.heard("[Guild Camp] ${me(wow)} reached level 40! — from ${me(wow)}")`), 'mine');
  assert.strictEqual(wow.eval('tostring(__ns.celebrate.heard("just chatting"))'), 'nil');
});

test('welcome wagon: everyone can say welcome; officers send the kit with a buddy close in level', () => {
  const wow = client(`ERR_GUILD_JOIN_S = "%s has joined the guild."
    GetNumGuildMembers = function() return 3 end
    GetGuildRosterInfo = function(i)
      local r = { { "Newbie-Realm", 12, true }, { "Grom-Realm", 60, true }, { "Mokra-Realm", 15, true } }
      return r[i][1], nil, nil, r[i][2], nil, nil, nil, nil, r[i][3] end
    CanGuildInvite = function() return true end`);
  wow.fire('CHAT_MSG_SYSTEM', 'Newbie has joined the guild.');
  assert.strictEqual(wow.eval('WowGuildToast.text:GetText()'), 'Newbie joined the guild!');
  wow.exec('WowGuildToast.btn:GetScript("OnClick")()');
  assert.strictEqual(wow.eval('__said[1]'), 'GUILD|Welcome to the guild, Newbie!');
  wow.exec('__ns.celebrate.welcomeKit("Newbie")');
  assert.strictEqual(wow.eval('#__whispers'), '3');
  assert.match(wow.eval('__whispers[3]'), /^Newbie\|Your guild buddy this week is Mokra/);
  // No links or ads in whispers to other players (Blizzard's add-on policy).
  for (let i = 1; i <= 3; i += 1) assert.ok(!/https?:|Guild Camp app/.test(wow.eval(`__whispers[${i}]`)), wow.eval(`__whispers[${i}]`));
  assert.match(wow.eval('__said[2]'), /Welcome to the guild, Newbie! Your buddy is Mokra\. — from /);
});

test('today\'s anniversaries: a toast once a day', () => {
  const wow = client();
  wow.exec('WowGuildInbox = WowGuildInbox or {}; WowGuildInbox.today = { date = date("!%Y-%m-%d"), lines = { "Mokra has been in the guild for 3 months!" } }');
  assert.strictEqual(wow.eval('__ns.celebrate.today()'), '1');
  assert.match(wow.eval('WowGuildToast.text:GetText()'), /Mokra has been in the guild for 3 months!/);
  assert.strictEqual(wow.eval('tostring(__ns.celebrate.today())'), 'nil', 'once');
});

test('a milestone reached in a dungeon waits, and goes out once you leave; loot lines only (not quest rewards)', () => {
  const wow = client('LOOT_ITEM_SELF = "You receive loot: %s."; LOOT_ITEM_SELF_MULTIPLE = "You receive loot: %sx%d."');
  wow.exec('__inInstance = true; __instanceType = "party"');
  wow.fire('PLAYER_LEVEL_UP', 30);
  const link = '|cffa335ee|Hitem:12345::::::::30:::::|h[Big Epic]|h|r';
  wow.fire('CHAT_MSG_LOOT', `You receive loot: ${link}.`);
  assert.strictEqual(wow.eval('#__said'), '0', 'not in a dungeon');
  wow.exec('__inInstance = false; __instanceType = "none"');
  wow.fire('PLAYER_ENTERING_WORLD');
  assert.strictEqual(wow.eval('#__said'), '2');
  assert.match(wow.eval('__said[1]'), /reached level 30!/);
  assert.match(wow.eval('__said[2]'), /looted .*Big Epic/);
  wow.fire('PLAYER_ENTERING_WORLD');
  assert.strictEqual(wow.eval('#__said'), '2', 'said once');
  // A quest reward is not loot; several of an epic is.
  wow.fire('CHAT_MSG_LOOT', `You receive item: ${link.replace('12345', '12346')}.`);
  assert.strictEqual(wow.eval('#__said'), '2');
  wow.fire('CHAT_MSG_LOOT', `You receive loot: ${link.replace('12345', '12347')}x2.`);
  assert.strictEqual(wow.eval('#__said'), '3');
  assert.strictEqual(wow.eval('__ns.debugError'), null);
});
