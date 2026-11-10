'use strict';
// Helpers while you play (Helpers.lua): guildies nearby, the instance helper, smart reminders, who can craft this.
const test = require('node:test');
const assert = require('node:assert');
const { WowClient } = require('./wowsim');

const ROSTER = `__said = {}
SendChatMessage = function(text, chan, _, to) table.insert(__said, chan .. "|" .. (to or "") .. "|" .. text) end
C_ChatInfo = C_ChatInfo or {}; C_ChatInfo.SendChatMessage = nil
__invited = {}
InviteUnit = function(n) table.insert(__invited, n) end
C_PartyInfo = nil
UnitInParty = function(n) return n == "Grom" end
UnitInRaid = function() return false end
__roster = {
  {"Thrallia-Forever", "Guild Master", 0, 23, "Shaman", "The Barrens", "", "", true},
  {"Zuljin-Forever", "Member", 3, 40, "Hunter", "The Barrens", "", "", true},
  {"Rexxar-Forever", "Member", 3, 24, "Hunter", "The Barrens", "", "", true},
  {"Grom-Forever", "Member", 3, 22, "Warrior", "Ashenvale", "", "", true},
  {"Nazgrel-Forever", "Member", 3, 20, "Rogue", "Durotar", "", "", true},
  {"Sleepy-Forever", "Member", 3, 23, "Mage", "The Barrens", "", "", false},
}
GetNumGuildMembers = function() return #__roster end
GetGuildRosterInfo = function(i) return unpack(__roster[i]) end`;

test('guildies nearby: online, in my zone, closest in level first; a zone note once; Group up? whispers', () => {
  const wow = new WowClient();
  wow.login();
  wow.exec(ROSTER);
  wow.exec('__list = __ns.helpers.nearby()');
  assert.strictEqual(wow.eval('#__list'), '2');
  assert.strictEqual(wow.eval('__list[1].name'), 'Rexxar');
  assert.strictEqual(wow.eval('__list[2].name'), 'Zuljin');
  assert.strictEqual(wow.eval('__ns.helpers.zoneChanged()'), 'Guildies in The Barrens: Rexxar (24), Zuljin (40). /wow near to group up.');
  assert.strictEqual(wow.eval('__ns.helpers.zoneChanged()'), null);
  assert.strictEqual(wow.eval('__ns.helpers.showNearby()'), '2');
  wow.click('WowGuildHelperPanel.rows[1].btn');
  assert.strictEqual(wow.eval('__said[1]'), "WHISPER|Rexxar|Hey Rexxar! I'm in The Barrens too (level 23). Want to group up?");
  wow.exec('WowGuildDB.options.radar = false; __ns.helpers.lastZoneNote = {}');
  assert.strictEqual(wow.eval('__ns.helpers.zoneChanged()'), null);
  assert.strictEqual(wow.eval('__ns.debugError'), null);
});

test('instance helper: guildies the right level for the dungeon, not already grouped; Invite; Ask the Coach', () => {
  const wow = new WowClient();
  wow.login();
  wow.exec(ROSTER);
  wow.exec('GetInstanceInfo = function() return "Wailing Caverns", "party" end; __inInstance = true; __instanceType = "party"');
  // Wailing Caverns is 17-24 (+2): Rexxar 24 and Nazgrel 20; Grom 22 is in my group, Zuljin 40 too high.
  assert.strictEqual(wow.eval('__ns.helpers.enteredInstance()'), '2');
  assert.match(wow.eval('WowGuildHelperPanel.rows[1].name:GetText()'), /^Rexxar/);
  assert.match(wow.eval('WowGuildHelperPanel.rows[2].name:GetText()'), /^Nazgrel/);
  wow.click('WowGuildHelperPanel.rows[2].btn');
  assert.strictEqual(wow.eval('__invited[1]'), 'Nazgrel');
  wow.click('WowGuildHelperPanel.extra');
  assert.match(wow.eval('WowGuildDB.coach and WowGuildDB.coach.questions and WowGuildDB.coach.questions[1].text or __ns.coach.db().questions[1].text'), /^Tips for Wailing Caverns/);
  // Outside, an unknown instance, or the option off: nothing.
  wow.exec('GetInstanceInfo = function() return "Somewhere", "party" end');
  assert.strictEqual(wow.eval('__ns.helpers.enteredInstance()'), null);
  wow.exec('GetInstanceInfo = function() return "The Deadmines", "party" end; WowGuildDB.options.instanceHelper = false');
  assert.strictEqual(wow.eval('__ns.helpers.enteredInstance()'), null);
  assert.strictEqual(wow.eval('__ns.helpers.dungeonFor("deadmines").name'), 'The Deadmines');
  assert.strictEqual(wow.eval('__ns.debugError'), null);
});

test('smart reminders: raid soon, repair, bags, talents; each at most every 30 minutes; option off', () => {
  const t = Math.floor(Date.now() / 1000);
  const wow = new WowClient({ inbox: { raids: [
    { id: 7, title: 'Onyxia', startsAt: t + 40 * 60, signup: 'yes' },
    { id: 8, title: 'Molten Core', startsAt: t + 30 * 60, signup: 'no' },
    { id: 9, title: 'Zul\'Gurub', startsAt: t + 5 * 3600, signup: 'yes' },
  ] } });
  wow.login();
  wow.exec(`GetInventoryItemDurability = function(slot) if slot == 5 then return 10, 100 end return 90, 100 end
C_Container.GetContainerNumFreeSlots = function(bag) return bag == 0 and 1 or 0 end
GetUnspentTalentPoints = function() return 2 end`);
  wow.exec('__ns.helpers.resetReminders(); __r = __ns.helpers.check()');
  assert.strictEqual(wow.eval('table.concat(__r, ",")'), 'raid,repair,bags,talents');
  const said = wow.printed();
  assert.match(said, /Reminder:.*Onyxia starts in 40 minutes/);
  assert.match(said, /Reminder:.*Your gear is at 10%: repair before it breaks\./);
  assert.match(said, /Reminder:.*Only 1 bag slot left\./);
  assert.match(said, /Reminder:.*You have 2 talent points to spend/);
  // On screen in our own frame, never Blizzard's error frame.
  assert.strictEqual(wow.eval('WowGuildNotice:IsShown() and "yes" or "no"'), 'yes');
  assert.strictEqual(wow.notices.length, 0);
  assert.strictEqual(wow.eval('#__ns.helpers.check()'), '0');
  wow.exec('__ns.helpers.resetReminders(); WowGuildDB.options.reminders = false');
  assert.strictEqual(wow.eval('#__ns.helpers.check()'), '0');
  assert.strictEqual(wow.eval('__ns.debugError'), null);
});

test('who can craft this: the guild crafters for a link, a crafting request and a whisper', () => {
  const wow = new WowClient({ inbox: { crafters: [{ name: 'Mooncloth Robe', who: 'Zuljin,Rexxar' }] } });
  wow.login();
  wow.exec(`${ROSTER}
__puts = {}
__ns.Share = __ns.Share or {}
__ns.Share.myPid = function() return "p1" end
__ns.Share.putLocal = function(ty, key, f) table.insert(__puts, ty .. "|" .. f.item .. "|" .. f.notes .. "|" .. f.state) return {} end`);
  const link = '|cffa335ee|Hitem:14140::::::::|h[Mooncloth Robe]|h|r';
  assert.strictEqual(wow.eval(`__ns.helpers.showCrafters("${link}")`), '2');
  wow.click('WowGuildHelperPanel.rows[1].btn');
  assert.strictEqual(wow.eval('__puts[1]'), 'cr|Mooncloth Robe|for Zuljin|o');
  assert.match(wow.eval('__said[1]'), /^WHISPER\|Zuljin\|Hi Zuljin! Could you craft Mooncloth Robe for me\?/);
  wow.click('WowGuildHelperPanel.extra');
  assert.strictEqual(wow.eval('__puts[2]'), 'cr|Mooncloth Robe||o');
  assert.strictEqual(wow.eval('#__said'), '1');
  assert.strictEqual(wow.eval('__ns.helpers.showCrafters("|cffffffff|Hitem:1::::::::|h[Nothing Special]|h|r")'), '0');
  assert.strictEqual(wow.eval('__ns.debugError'), null);
});
