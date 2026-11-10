'use strict';
// BossKills.lua (raid boss kills: who was there, one record per kill) and DungeonQuests.lua (the dungeon quest
// checklist and the party's quests).
const test = require('node:test');
const assert = require('node:assert');
const { WowClient } = require('./wowsim');

const SHARE = `__recs = {}
__ns.Share = __ns.Share or {}
__ns.Share.myPid = function() return "Thrallia.p4m7" end
__ns.Share.get = function(id) for _, r in ipairs(__recs) do if r.type .. ":" .. r.key == id then return r end end end
__ns.Share.putLocal = function(ty, key, f) table.insert(__recs, { type = ty, key = key, fields = f }) return {} end`;

const RAID = `__inInstance = true; __instanceType = "raid"
GetInstanceInfo = function() return "Molten Core", "raid" end
__raid = { {"Thrallia", 0}, {"Mokra-Forever", 2}, {"Pugguy", 0}, {"Zulsha", 1} }
GetNumGroupMembers = function() return #__raid end
GetRaidRosterInfo = function(i) local r = __raid[i]; if r then return r[1], r[2] end end
__roster = { {"Thrallia-Forever", true}, {"Mokra-Forever", true}, {"Zulsha-Forever", true}, {"Offline-Forever", false} }
GetNumGuildMembers = function() return #__roster end
GetGuildRosterInfo = function(i) local r = __roster[i]; return r[1], nil, nil, 60, "Shaman", "Molten Core", nil, nil, r[2] end`;

test('a raid boss kill: guild raiders on record once; dungeons, wipes and duplicates skipped', () => {
  const wow = new WowClient();
  wow.login();
  wow.exec(SHARE);
  wow.exec(RAID);
  wow.fire('ENCOUNTER_END', 663, 'Lucifron', 9, 40, 1);
  wow.exec('__ek = __recs[1]');
  assert.strictEqual(wow.eval('__ek.type'), 'ek');
  assert.strictEqual(wow.eval('__ek.fields.boss'), 'Lucifron');
  assert.strictEqual(wow.eval('__ek.fields.instance'), 'Molten Core');
  assert.strictEqual(wow.eval('table.concat(__ek.fields.names, ",")'), 'Thrallia,Mokra,Zulsha', 'guildies only');
  assert.strictEqual(wow.eval('#__ek.key'), '6');
  // The same kill seen by another raider's addon: the same key, already there, so nothing new.
  assert.strictEqual(wow.eval('__ns.bossKills.keyFor(663, "Mokra")'), wow.eval('__ek.key'));
  wow.fire('ENCOUNTER_END', 663, 'Lucifron', 9, 40, 1);
  assert.strictEqual(wow.eval('#__recs'), '1');
  // A wipe, or a dungeon boss: nothing.
  wow.fire('ENCOUNTER_END', 664, 'Magmadar', 9, 40, 0);
  wow.exec('__instanceType = "party"');
  wow.fire('ENCOUNTER_END', 1, 'Mutanus', 1, 5, 1);
  assert.strictEqual(wow.eval('#__recs'), '1');
  assert.match(wow.printed(), /Lucifron is down!.*Recorded for 3 guildies' raid attendance\./);
  assert.strictEqual(wow.eval('__ns.debugError'), null);
});

const QUESTS = `__log = {
  { "Kalimdor", true, false }, { "Serpentbloom", false, false }, { "Deviate Hides", false, true }, { "Bad Mojo", false, false },
}
__texts = { [4] = "Find the cursed totem in the Wailing Caverns." }
__sel = 0
GetNumQuestLogEntries = function() return #__log end
GetQuestLogTitle = function(i) local q = __log[i]; return q[1], 10, nil, q[2], nil, q[3] and 1 or nil end
SelectQuestLogEntry = function(i) __sel = i end
GetQuestLogSelection = function() return __sel end
GetQuestLogQuestText = function() return __texts[__sel] or "Some quest.", "" end
C_QuestLog = nil`;

test('the dungeon quest checklist: mine first, ready ones, ones to pick up, and quests that mention the dungeon', () => {
  const wow = new WowClient();
  wow.login();
  wow.exec(QUESTS);
  wow.exec('__list = __ns.dungeonQuests.checklist("wc")');
  const titles = JSON.parse(wow.eval('(function() local t = {} for _, q in ipairs(__list) do t[#t + 1] = string.format("%q", q.title .. "|" .. tostring(q.have) .. "|" .. tostring(q.done)) end return "[" .. table.concat(t, ",") .. "]" end)()'));
  assert.deepStrictEqual(titles.slice(0, 3).sort(), ['Bad Mojo|true|false', 'Deviate Hides|true|true', 'Serpentbloom|true|false']);
  assert.ok(titles.includes('Leaders of the Fang|false|false'));
  assert.strictEqual(wow.eval('__ns.dungeonQuests.show("Wailing Caverns")'), String(titles.length));
  assert.strictEqual(wow.eval('WowGuildQuestPanel.title:GetText()'), 'Quests: Wailing Caverns');
  assert.strictEqual(wow.eval('__sel'), '0', 'the quest log selection is put back');
  assert.strictEqual(wow.eval('__ns.dungeonQuests.slash("nowhere")'), null);
  assert.strictEqual(wow.eval('__ns.debugError'), null);
});

test('the party: my quests go out as bits of the list, theirs come back and show', () => {
  const wow = new WowClient();
  wow.login();
  wow.exec(QUESTS);
  const msg = wow.eval('__ns.dungeonQuests.encode("Wailing Caverns")');
  assert.match(msg, /^D\d+:[01]+$/);
  assert.strictEqual(msg.split(':')[1], '10100', 'Serpentbloom and Deviate Hides of the list, nothing else');
  // A party member asks: they hear back, and their quests show on the panel.
  wow.exec(`IsInGroup = function() return true end; IsInRaid = function() return false end
__sent = {}; C_ChatInfo.SendAddonMessage = function(p, m, c) table.insert(__sent, p .. "|" .. m .. "|" .. c) return true end`);
  const theirs = `?${msg.split(':')[0]}:01000`;
  wow.fire('CHAT_MSG_ADDON', 'WowGuildQ', theirs, 'PARTY', 'Mokra-Forever');
  assert.strictEqual(wow.eval('__sent[1]'), `WowGuildQ|${msg}|PARTY`);
  assert.strictEqual(wow.eval('tostring(__ns.dungeonQuests.party["Wailing Caverns"].Mokra["leaders of the fang"])'), 'true');
  wow.exec('__ns.dungeonQuests.show("Wailing Caverns")');
  wow.exec('__found = nil for _, r in ipairs(WowGuildQuestPanel.rows) do if r.name:GetText() == "Leaders of the Fang" then __found = r.state:GetText() end end');
  assert.match(wow.eval('__found'), /also: Mokra/);
  // Entering the dungeon: a chat line, and my group hears my quests.
  wow.exec('__inInstance = true; __instanceType = "party"; GetInstanceInfo = function() return "Wailing Caverns", "party" end');
  assert.match(wow.eval('__ns.dungeonQuests.entered()'), /Quests for Wailing Caverns:\|r 3 in your log, 3 you haven't picked up\./);
  assert.strictEqual(wow.eval('__ns.debugError'), null);
});
