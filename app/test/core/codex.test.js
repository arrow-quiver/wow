'use strict';
// Warband Codex (addon/WarbandCodex): the standalone all-in-one addon, run on the simulated client.
// Covers the window (tabs, order, search, themes), every module's logic, the link to Guild Camp through
// GuildCampAPI, and the source rules (Lua 5.1, no combat log, no Blizzard popups).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { WowClient, readToc } = require('./wowsim');

const CODEX_DIR = path.join(__dirname, '..', '..', '..', 'addon', 'WarbandCodex');
const empty = (v) => (Array.isArray(v) ? v.length : Object.keys(v || {}).length) === 0;
const noError = (wow) => assert.strictEqual(wow.eval('__ns.debugError'), null, 'no addon errors');

// The game APIs the Codex reads that the simulator doesn't have. Tests change the __ tables.
const MOCKS = `
__units = { player = { name = "Thrallia", class = "SHAMAN", level = 23 } }
function UnitName(u) local x = __units[u or "player"]; return x and x.name or nil end
function UnitExists(u) return __units[u] ~= nil end
function UnitIsDead(u) return __units[u] and __units[u].dead == true end
function UnitIsPlayer(u) return __units[u] and __units[u].player == true end
function UnitIsEnemy(a, u) return __units[u] and __units[u].enemy == true end
function UnitPlayerControlled(u) return __units[u] and __units[u].player == true end
function UnitCreatureType(u) return __units[u] and __units[u].kind end
function UnitCreatureFamily(u) return __units[u] and __units[u].family end
function UnitClass(u) local x = __units[u or "player"]; if not x then return nil end return x.class, x.class end
function UnitLevel(u) local x = __units[u or "player"]; return x and x.level or 0 end
function UnitXP() return 400 end
function UnitXPMax() return 1000 end
function GetXPExhaustion() return 150 end
function GetRealmName() return "Forever" end
function IsShiftKeyDown() return __shift == true end

-- Talents: three trees of a made-up shaman. { name, tier, col, max, prereq = { tier, col } }
__talents = {
  { name = "Elemental", list = { { "Convection", 1, 2, 5 }, { "Concussion", 1, 3, 5 }, { "Earth's Grasp", 2, 1, 2 }, { "Call of Flame", 2, 3, 3 }, { "Elemental Focus", 3, 1, 1 }, { "Call of Thunder", 3, 3, 5, { 2, 3 } } } },
  { name = "Enhancement", list = { { "Ancestral Knowledge", 1, 2, 5 }, { "Shield Specialization", 1, 3, 5 }, { "Thundering Strikes", 2, 2, 5 } } },
  { name = "Restoration", list = { { "Improved Healing Wave", 1, 2, 5 }, { "Tidal Focus", 1, 3, 5 } } },
}
__ranks = {}
function GetNumTalentTabs() return #__talents end
function GetTalentTabInfo(i) local n = 0; for k, v in pairs(__ranks) do if string.sub(k, 1, 1) == tostring(i) then n = n + v end end; return __talents[i].name, "icon" .. i, n end
function GetNumTalents(tab) return #__talents[tab].list end
function GetTalentInfo(tab, i) local t = __talents[tab].list[i]; return t[1], "ticon", t[2], t[3], __ranks[tab .. "." .. i] or 0, t[4] end
function GetTalentPrereqs(tab, i) local t = __talents[tab].list[i]; if t[5] then return t[5][1], t[5][2] end end
__unspent = 0
function UnitCharacterPoints() return __unspent end

-- Items: link → { slot, stats }
__items = {
  ["|Hitem:100|h[Worn Mail Helm]|h"] = { "INVTYPE_HEAD", { ITEM_MOD_STRENGTH_SHORT = 4, ITEM_MOD_STAMINA_SHORT = 5 } },
  ["|Hitem:200|h[Helm of the Storm]|h"] = { "INVTYPE_HEAD", { ITEM_MOD_STRENGTH_SHORT = 9, ITEM_MOD_STAMINA_SHORT = 5 } },
  ["|Hitem:300|h[Cloth Cap]|h"] = { "INVTYPE_HEAD", { ITEM_MOD_INTELLECT_SHORT = 3 } },
  ["|Hitem:400|h[Earthfury Boots]|h"] = { "INVTYPE_FEET", { ITEM_MOD_STRENGTH_SHORT = 2 } },
}
__worn = { [1] = "|Hitem:100|h[Worn Mail Helm]|h" }
function GetInventoryItemLink(unit, slot) return __worn[slot] end
function GetItemStats(link) local it = __items[link]; return it and it[2] or nil end
C_Item.GetItemInfoInstant = function(link) local it = __items[link]; if not it then return nil end; return 1, "Armor", "Mail", it[1] end

-- Loot.
__loot = {}
function GetInstanceInfo() return __instance or "Wailing Caverns", "party" end
function GetNumLootItems() return #__loot end
function GetLootSlotLink(i) return __loot[i][1] end
function GetLootSlotInfo(i) return "icon", "name", 1, nil, __loot[i][2] end
function GetLootSourceInfo(i) return __lootGuid end

-- Merchants and quests.
__calls = {}
local function note(name) return function(...) __calls[#__calls + 1] = name .. ":" .. table.concat({ ... }, ",") end end
function CanMerchantRepair() return true end
function GetRepairAllCost() return __repairCost or 2500, true end
RepairAllItems = note("repair")
C_Container.UseContainerItem = note("use")
AcceptQuest = note("accept")
CompleteQuest = note("complete")
GetQuestReward = note("reward")
function IsQuestCompletable() return true end
function GetNumQuestChoices() return __choices or 0 end
LootSlot = note("loot")

-- Reputation and PvP.
function GetNumFactions() return 2 end
function GetFactionInfo(i)
  if i == 1 then return "Argent Dawn", "", 5, 3000, 9000, 4500, false, true, false end
  return "Orgrimmar", "", 6, 9000, 21000, 12000, false, true, false
end
function GetPVPSessionStats() return 3, 0 end
function GetPVPLifetimeStats() return 40, 2, 4 end
function UnitPVPRank() return 6 end
function GetPVPRankInfo(r) return "Grunt", 2 end
function GetPVPRankProgress() return 0.4 end
function GetBattlefieldWinner() return __winner end
function GetNumBattlefieldScores() return 2 end
function GetBattlefieldScore(i) if i == 1 then return "Thrallia", 7, 12, 3, 250 end return "Other", 1, 2, 3, 4 end

function IsTradeskillTrainer() return __tradeTrainer == true end
function GetTrainerServiceSkillLine() return "Blacksmithing" end
__services = { { "Lightning Bolt", "Rank 4", "available", 1800, 20 }, { "Chain Lightning", "Rank 1", "unavailable", 9000, 32 }, { "Healing Wave", "Rank 3", "used", 0, 12 } }
function GetNumTrainerServices() return #__services end
function GetTrainerServiceInfo(i) local s = __services[i]; return s[1], s[2], s[3] end
function GetTrainerServiceCost(i) return __services[i][4] end
function GetTrainerServiceLevelReq(i) return __services[i][5] end
C_Map = { GetBestMapForUnit = function() return 1411 end, GetPlayerMapPosition = function() return { x = 0.4567, y = 0.1234 } end }
`;

function client(opts = {}) {
  const wow = new WowClient({ addonDir: CODEX_DIR, mocks: MOCKS + (opts.mocks || ''), savedVariables: opts.savedVariables });
  wow.login();
  wow.clearOutput();
  return wow;
}
const slash = (wow, text) => wow.exec(`SlashCmdList.WARBANDCODEX(${JSON.stringify(text)})`);

test('the .toc lists every Lua file, and every file is Lua 5.1 that keeps the addon rules', () => {
  const toc = readToc(CODEX_DIR);
  const onDisk = [];
  const walk = (dir, rel) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      if (f.isDirectory()) walk(path.join(dir, f.name), rel + f.name + '/');
      else if (f.name.endsWith('.lua')) onDisk.push(rel + f.name);
    }
  };
  walk(CODEX_DIR, '');
  assert.deepStrictEqual([...toc.files].sort(), onDisk.sort(), 'the .toc and the folder agree');
  assert.strictEqual(toc.fields.SavedVariables, 'WarbandCodexDB');
  let luaparse = null;
  try { luaparse = require('luaparse'); } catch { luaparse = null; }
  for (const f of onDisk) {
    const src = fs.readFileSync(path.join(CODEX_DIR, f), 'utf8');
    if (luaparse) assert.doesNotThrow(() => luaparse.parse(src, { luaVersion: '5.1' }), `${f} parses as Lua 5.1`);
    const code = src.replace(/--[^\n]*/g, '');
    assert.doesNotMatch(code, /COMBAT_LOG_EVENT_UNFILTERED/, `${f}: no combat log`);
    assert.doesNotMatch(code, /StaticPopup|UIErrorsFrame|RaidWarningFrame/, `${f}: only our own frames`);
    assert.doesNotMatch(code, /\bgoto\b|\/\/|<<|>>|utf8\.|string\.pack|math\.type/, `${f}: nothing newer than Lua 5.1`);
  }
});

test('the window: opens on Home, every tab draws, hunters-only tab is hidden for a shaman', () => {
  const wow = client();
  slash(wow, '');
  assert.strictEqual(wow.eval('__ns.shell.current'), 'home');
  assert.strictEqual(wow.eval('tostring(WarbandCodexWindow:IsShown())'), 'true');
  const tabs = wow.get('(function() local t = {} for _, m in ipairs(__ns.shell.tabs()) do t[#t + 1] = m.id end return t end)()');
  assert.deepStrictEqual(tabs, ['home', 'armory', 'dungeons', 'professions', 'talents', 'reputation', 'pvp', 'guild', 'qol', 'settings']);
  for (const id of tabs) {
    slash(wow, id);
    assert.strictEqual(wow.eval('__ns.shell.current'), id, id);
    noError(wow);
  }
  slash(wow, 'pets');
  assert.strictEqual(wow.eval('__ns.shell.current'), 'home', 'a shaman has no pets tab');
  slash(wow, '');
  assert.strictEqual(wow.eval('tostring(WarbandCodexWindow:IsShown())'), 'false', '/codex closes it again');
  wow.click('WarbandCodexMinimapButton');
  assert.strictEqual(wow.eval('__ns.shell.current'), 'home', 'reopens on the last tab used');
  noError(wow);
});

test('tabs can be reordered and hidden per character, and the layout is saved', () => {
  const wow = client();
  slash(wow, '');
  wow.exec('__ns.shell.moveTab("pvp", -6); __ns.shell.setHidden("qol", true); __ns.shell.setHidden("home", true)');
  const ids = () => wow.get('(function() local t = {} for _, m in ipairs(__ns.shell.tabs()) do t[#t + 1] = m.id end return t end)()');
  assert.deepStrictEqual(ids().slice(0, 4), ['home', 'pvp', 'armory', 'dungeons'], 'pvp moved up to just under Home');
  assert.ok(!ids().includes('qol'), 'hidden');
  assert.ok(ids().includes('home'), 'Home cannot be hidden');
  wow.logout();
  const again = client({ savedVariables: wow.saveVariablesBuffer() });
  slash(again, '');
  const after = again.get('(function() local t = {} for _, m in ipairs(__ns.shell.tabs()) do t[#t + 1] = m.id end return t end)()');
  assert.deepStrictEqual(after.slice(0, 3), ['home', 'pvp', 'armory']);
  assert.ok(!after.includes('qol'));
  noError(again);
});

test('search finds tabs, bosses, dungeons and settings, and opens the result', () => {
  const wow = client();
  const labels = (q) => wow.get(`(function() local t = {} for _, r in ipairs(__ns.shell.find(${JSON.stringify(q)})) do t[#t + 1] = r.label end return t end)()`);
  assert.strictEqual(wow.get('#__ns.shell.find("x")'), 0, 'one letter is too short');
  assert.ok(labels('mutanus').includes('Mutanus the Devourer'));
  assert.ok(labels('wailing').includes('Wailing Caverns'));
  assert.ok(labels('repair').includes('Repair at merchants'));
  assert.ok(labels('talents').includes('Talents'));
  wow.exec('__ns.shell.search("mutanus", true); __ns.shell.pickResult(1)');
  assert.strictEqual(wow.eval('__ns.shell.current'), 'dungeons');
  assert.ok(wow.texts().includes('Wailing Caverns'), 'the dungeon page shows the boss\'s dungeon');
  noError(wow);
});

test('themes: five of them, the choice is saved, colours follow', () => {
  const wow = client();
  slash(wow, 'settings');
  assert.deepStrictEqual(wow.get('__ns.ui.themeOrder'), ['ember', 'frost', 'fel', 'blood', 'silver']);
  const before = wow.eval('__ns.ui.hex("accent")');
  wow.exec('__ns.ui.setTheme("frost")');
  assert.notStrictEqual(wow.eval('__ns.ui.hex("accent")'), before);
  assert.strictEqual(wow.eval('WarbandCodexDB.opts.theme'), 'frost');
  wow.exec('__ns.ui.setTheme("nope")');
  assert.strictEqual(wow.eval('WarbandCodexDB.opts.theme'), 'frost', 'an unknown theme changes nothing');
  noError(wow);
});

test('talent calculator: the game\'s rules, three builds, a build code, the next point', () => {
  const wow = client();
  const T = '__ns.talents';
  assert.strictEqual(wow.get(`#${T}.tree("SHAMAN")`), 3, 'the trees were read from the game at login');
  assert.strictEqual(wow.eval(`tostring(${T}.tree("MAGE"))`), 'nil', 'a class never played is unknown');
  const add = (tab, i) => wow.get(`{ ${T}.add("SHAMAN", ${tab}, ${i}) }`);
  assert.deepStrictEqual(add(1, 4), [false, 'Needs 5 points in Elemental first.'], 'tier 2 needs five points');
  for (let n = 0; n < 5; n++) assert.strictEqual(add(1, 1)[0], true);
  assert.deepStrictEqual(add(1, 1), [false, 'Already at its top rank.']);
  assert.strictEqual(add(1, 4)[0], true, 'tier 2 opens');
  for (let n = 0; n < 4; n++) add(1, 2);
  assert.deepStrictEqual(add(1, 6), [false, "Needs Call of Flame at its top rank first."], 'prerequisite');
  add(1, 4); add(1, 4);
  assert.strictEqual(add(1, 6)[0], true);
  assert.deepStrictEqual(wow.get(`{ ${T}.remove("SHAMAN", 1, 4) }`), [false, 'Call of Thunder depends on it.']);
  // Twelve points sit above tier 3, which needs ten: two can come out, a third cannot.
  assert.deepStrictEqual(wow.get(`{ ${T}.remove("SHAMAN", 1, 1) }`), [true]);
  assert.deepStrictEqual(wow.get(`{ ${T}.remove("SHAMAN", 1, 1) }`), [true]);
  assert.deepStrictEqual(wow.get(`{ ${T}.remove("SHAMAN", 1, 1) }`), [false, 'Talents further down the tree need these points.']);
  const code = wow.eval(`${T}.code("SHAMAN")`);
  assert.strictEqual(code, 'SHAMAN:340301--');
  // A second build is separate; the code loads into it.
  wow.exec(`${T}.setActive("SHAMAN", 2)`);
  assert.strictEqual(wow.get(`(${T}.total(${T}.tree("SHAMAN"), ${T}.build("SHAMAN").pts))`), 0);
  assert.deepStrictEqual(wow.get(`{ ${T}.load("SHAMAN:540301--") }`), [true, 'SHAMAN']);
  assert.strictEqual(wow.get(`(${T}.total(${T}.tree("SHAMAN"), ${T}.build("SHAMAN").pts))`), 13);
  assert.strictEqual(wow.get(`{ ${T}.load("SHAMAN:000005--") }`)[0], false, 'a code that breaks the rules is refused');
  assert.strictEqual(wow.get(`{ ${T}.load("MAGE:5--") }`)[0], false);
  // What to take next, against what is really spent.
  wow.exec('__unspent = 2; __ranks["1.1"] = 3');
  assert.deepStrictEqual(wow.get(`(function() local n = ${T}.nextPoint(); return { n.name, n.have, n.want } end)()`), ['Convection', 3, 5]);
  slash(wow, 'talents');
  assert.ok(wow.texts().includes('13 / 51 points   ·   needs level 22'));
  assert.ok(wow.texts().some((t) => /^2 talent points to spend: your build says Convection\.$/.test(t)) || wow.get('__ns.modules.talents.steps()')[0].text === '2 talent points to spend: your build says Convection.');
  noError(wow);
});

test('trainer: remembers what the class trainer teaches and what it costs', () => {
  const wow = client();
  wow.fire('TRAINER_SHOW');
  const [ready, later, cost] = wow.get('{ __ns.talents.trainer() }');
  assert.deepStrictEqual(ready.map((s) => s.name), ['Lightning Bolt']);
  assert.deepStrictEqual(later.map((s) => [s.name, s.level]), [['Chain Lightning', 32]]);
  assert.strictEqual(cost, 1800);
  assert.strictEqual(wow.get('__ns.modules.talents.steps()')[0].text, 'Your trainer has 1 spell for you (18s 0c).');
  noError(wow);
});

test('armory: scores for the talent tree, finds upgrades, wishlist, tooltip line, sets', () => {
  const wow = client();
  const A = '__ns.armory';
  assert.strictEqual(wow.eval(`${A}.spec().label`), 'Elemental', 'no points spent: the first tree');
  wow.exec('__ns.char().spec = 2');
  assert.strictEqual(wow.eval(`${A}.spec().label`), 'Enhancement');
  assert.strictEqual(wow.get(`${A}.score("|Hitem:100|h[Worn Mail Helm]|h")`), 4 * 1 + 5 * 0.4);
  // Known items: one seen as loot, one in the wishlist.
  wow.exec(`__ns.learned("items")[200] = { link = "|Hitem:200|h[Helm of the Storm]|h", src = "Mutanus the Devourer, Wailing Caverns" }`);
  slash(wow, 'wish |Hitem:300|h[Cloth Cap]|h');
  assert.match(wow.printed(), /Cloth Cap is on your wishlist\./);
  const ups = wow.get(`${A}.upgrades()`);
  assert.deepStrictEqual(ups.map((u) => [u.name, u.slotName, Math.round(u.pct), u.source]), [['Helm of the Storm', 'Head', 83, 'Mutanus the Devourer, Wailing Caverns']]);
  assert.strictEqual(wow.eval(`${A}.tooltipLine("|Hitem:200|h[Helm of the Storm]|h")`), 'Codex: |cff73d17a+83%|r vs your head (Enhancement)');
  assert.match(wow.eval(`${A}.tooltipLine("|Hitem:300|h[Cloth Cap]|h")`), /^Codex: \|cffeb5450-100%\|r vs your head/);
  wow.setCombat(true);
  assert.strictEqual(wow.eval(`tostring(${A}.tooltipLine("|Hitem:200|h[Helm of the Storm]|h"))`), 'nil', 'nothing is read in combat');
  wow.setCombat(false);
  // Sets: a piece worn counts by its set word.
  wow.exec('__worn[8] = "|Hitem:400|h[Earthfury Boots]|h"');
  const sets = wow.get(`${A}.sets()`);
  assert.deepStrictEqual(sets.map((s) => [s.name, s.have, s.of]), [['The Elements', 0, 8], ['The Earthfury', 1, 8], ['The Ten Storms', 0, 8]]);
  slash(wow, 'armory');
  assert.ok(wow.texts().includes('+83%'));
  assert.strictEqual(wow.get('__ns.modules.armory.badge()'), 1);
  noError(wow);
});

test('dungeons: learns loot per boss with a drop rate, once per corpse; the entering card; quests and keys', () => {
  const wow = client();
  const D = '__ns.dungeons';
  wow.setInstance(true);
  wow.fire('PLAYER_ENTERING_WORLD');
  assert.deepStrictEqual(wow.get('{ __ns.lastToast.title, __ns.lastToast.text }'), ['Wailing Caverns', '8 bosses  ·  0 of 5 quests in your log  ·  /codex dungeons']);
  wow.exec(`__units.target = { name = "Mutanus the Devourer", dead = true }
    __loot = { { "|Hitem:200|h[Helm of the Storm]|h", 3 }, { "|Hitem:9|h[Grey Thing]|h", 0 } }; __lootGuid = "Creature-1"`);
  wow.fire('LOOT_OPENED');
  wow.fire('LOOT_OPENED'); // the same corpse again
  wow.exec('__loot = { { "|Hitem:9|h[Grey Thing]|h", 0 } }; __lootGuid = "Creature-2"');
  wow.fire('LOOT_OPENED'); // a second kill that dropped nothing worth noting
  const [kills, loot] = wow.get(`{ ${D}.lootOf("Wailing Caverns", "Mutanus the Devourer") }`);
  assert.strictEqual(kills, 2);
  assert.deepStrictEqual(loot.map((l) => [l.id, l.n, l.rate]), [[200, 1, 0.5]]);
  assert.strictEqual(wow.eval('__ns.learned("items")[200].src'), 'Mutanus the Devourer, Wailing Caverns', 'the armory hears about it');
  // A boss the baseline doesn't know shows as "also seen here".
  wow.exec(`__units.target = { name = "Forever Newcomer", dead = true }; __loot = { { "|Hitem:300|h[Cloth Cap]|h", 2 } }; __lootGuid = "Creature-3"`);
  wow.fire('LOOT_OPENED');
  assert.deepStrictEqual(wow.get(`${D}.extraSources(${D}.byName("wc"))`), ['Forever Newcomer']);
  slash(wow, 'dungeons');
  assert.ok(wow.texts().includes('Wailing Caverns'), 'opens on the dungeon you are in');
  wow.exec('__ns.modules.dungeons.select("Wailing Caverns", "bosses", "Mutanus the Devourer")');
  assert.ok(wow.texts().includes('1 of 2  ·  50%'));
  assert.ok(wow.texts().includes('Also seen here'));
  assert.deepStrictEqual(wow.get(`${D}.quests(${D}.byName("Wailing Caverns"))`).map((q) => q.title).slice(0, 2), ['Serpentbloom', 'Leaders of the Fang']);
  assert.deepStrictEqual(wow.get(`${D}.keys(${D}.byName("Scarlet Monastery"))`).map((k) => k.name), ['Scarlet Key']);
  // Learning can be switched off.
  wow.exec('__ns.setOpt("lootLearn", false); __lootGuid = "Creature-4"');
  wow.fire('LOOT_OPENED');
  assert.strictEqual(wow.get(`{ ${D}.lootOf("Wailing Caverns", "Forever Newcomer") }`)[0], 1);
  noError(wow);
});

test('professions: records recipes, knows who can make what, asks and answers over the guild channel, trainers', () => {
  const wow = client();
  const P = '__ns.professions';
  wow.fire('TRADE_SKILL_SHOW');
  assert.deepStrictEqual(wow.get(`${P}.all()`).map((r) => [r.name, r.prof, r.who]), [['Copper Chain Vest', 'Blacksmithing', ['Thrallia']], ['Rough Sharpening Stone', 'Blacksmithing', ['Thrallia']]]);
  // A guildmate asks: my Codex answers with a whisper. A reply to my own question is kept.
  wow.exec(`__sent = {}; C_ChatInfo.SendAddonMessage = function(prefix, text, channel, target) __sent[#__sent + 1] = { prefix, text, channel, target }; return true end`);
  wow.fire('CHAT_MSG_ADDON', 'WBCodex', 'RQ:copper chain vest', 'GUILD', 'Mokra-Forever');
  assert.deepStrictEqual(wow.get('__sent'), [['WBCodex', 'RA:Copper Chain Vest', 'WHISPER', 'Mokra']]);
  assert.strictEqual(wow.eval(`tostring(${P}.ask("Runecloth Bag"))`), 'true');
  assert.deepStrictEqual(wow.get('__sent[2]'), ['WBCodex', 'RQ:Runecloth Bag', 'GUILD']);
  wow.exec('__roster = { "Zed-Forever", "Mokra-Forever" }; GetNumGuildMembers = function() return #__roster end; GetGuildRosterInfo = function(i) return __roster[i] end');
  wow.fire('CHAT_MSG_ADDON', 'WBCodex', 'RA:Runecloth Bag', 'WHISPER', 'Zed');
  assert.deepStrictEqual(wow.get(`${P}.who("runecloth bag").codex`), ['Zed']);
  noError(wow);
});

test('professions: recipe answers only for guildmates on the guild channel, and only for what I asked (review of #78)', () => {
  const wow = client();
  const P = '__ns.professions';
  wow.fire('TRADE_SKILL_SHOW');
  wow.exec(`__sent = {}; C_ChatInfo.SendAddonMessage = function(prefix, text, channel, target) __sent[#__sent + 1] = { prefix, text, channel, target }; return true end
    __roster = { "Zed-Forever", "Mokra-Forever" }; GetNumGuildMembers = function() return #__roster end; GetGuildRosterInfo = function(i) return __roster[i] end`);
  // A whisper from anyone (guildmate or not) is never answered: only the guild channel is.
  wow.fire('CHAT_MSG_ADDON', 'WBCodex', 'RQ:copper chain vest', 'WHISPER', 'Stranger');
  wow.fire('CHAT_MSG_ADDON', 'WBCodex', 'RQ:copper chain vest', 'WHISPER', 'Mokra');
  wow.fire('CHAT_MSG_ADDON', 'WBCodex', 'RQ:copper chain vest', 'GUILD', null);
  assert.ok(empty(wow.get('__sent')), 'no answer outside the guild channel');
  // An unsolicited answer is dropped, and a nil sender raises nothing.
  wow.fire('CHAT_MSG_ADDON', 'WBCodex', 'RA:Runecloth Bag', 'WHISPER', 'Zed');
  wow.fire('CHAT_MSG_ADDON', 'WBCodex', 'RA:Runecloth Bag', 'WHISPER', null);
  assert.ok(empty(wow.get(`${P}.who("runecloth bag").codex`)), 'nothing kept without a question');
  assert.ok(empty(wow.get(`${P}.answers`)));
  // After I ask: a guildmate's whisper counts, a stranger's and one on another channel don't.
  wow.exec(`${P}.ask("Runecloth Bag")`);
  wow.fire('CHAT_MSG_ADDON', 'WBCodex', 'RA:Runecloth Bag', 'WHISPER', 'Stranger');
  wow.fire('CHAT_MSG_ADDON', 'WBCodex', 'RA:Runecloth Bag', 'GUILD', 'Mokra');
  wow.fire('CHAT_MSG_ADDON', 'WBCodex', 'RA:Some Other Thing', 'WHISPER', 'Mokra');
  wow.fire('CHAT_MSG_ADDON', 'WBCodex', 'RA:Runecloth Bag', 'WHISPER', 'Zed-Forever');
  assert.deepStrictEqual(wow.get(`${P}.who("runecloth bag").codex`), ['Zed']);
  assert.ok(!wow.get(`${P}.answers["some other thing"]`), 'answers to questions I never asked are dropped');
  // Answers per recipe are capped, and a late answer is dropped.
  wow.exec(`for i = 1, 60 do __roster[#__roster + 1] = "Alt" .. i end
`);
  for (let i = 1; i <= 60; i++) wow.fire('CHAT_MSG_ADDON', 'WBCodex', 'RA:Runecloth Bag', 'WHISPER', `Alt${i}`);
  assert.strictEqual(wow.get(`${P}.who("runecloth bag").codex`).length, wow.get(`${P}.MAX_ANSWERS`));
  wow.exec(`${P}.asked["runecloth bag"] = __ns.now() - ${P}.ASK_WINDOW - 1; ${P}.answers = {}`);
  wow.fire('CHAT_MSG_ADDON', 'WBCodex', 'RA:Runecloth Bag', 'WHISPER', 'Mokra');
  assert.ok(empty(wow.get(`${P}.who("runecloth bag").codex`)), 'an answer after the window is dropped');
  noError(wow);
});

test('professions: trainers and the page', () => {
  const wow = client();
  const P = '__ns.professions';
  wow.fire('TRADE_SKILL_SHOW');
  wow.exec(`__sent = {}; C_ChatInfo.SendAddonMessage = function(prefix, text, channel, target) __sent[#__sent + 1] = { prefix, text, channel, target }; return true end`);
  wow.exec('__ns.setOpt("recipeShare", false); __sent = {}');
  wow.fire('CHAT_MSG_ADDON', 'WBCodex', 'RQ:copper chain vest', 'GUILD', 'Mokra');
  assert.ok(empty(wow.get('__sent')), 'answers can be switched off');
  // A profession trainer is remembered with the spot.
  wow.exec('__tradeTrainer = true; __units.npc = { name = "Saru Steelfury" }');
  wow.fire('TRAINER_SHOW');
  assert.deepStrictEqual(wow.get(`${P}.trainers()`).map((t) => [t.name, t.prof, t.zone, t.x, t.here]), [['Saru Steelfury', 'Blacksmithing', 'The Barrens', 0.457, true]]);
  slash(wow, 'professions');
  assert.ok(wow.texts().includes('Copper Chain Vest'));
  noError(wow);
});

test('hunter pets: the tab appears for hunters, beasts met are logged, a better rank raises a card', () => {
  const wow = client({ mocks: '__units.player = { name = "Thrallia", class = "HUNTER", level = 23 }\n' });
  const P = '__ns.pets';
  assert.ok(wow.get('(function() local t = {} for _, m in ipairs(__ns.shell.tabs()) do t[#t + 1] = m.id end return t end)()').includes('pets'));
  assert.strictEqual(wow.get(`${P}.rankAt("Bite", 17)`), 3);
  wow.exec(`${P}.setKnown("Bite", 2); __units.target = { name = "Savannah Prowler", kind = "Beast", family = "Cat", level = 17 }`);
  wow.fire('PLAYER_TARGET_CHANGED');
  assert.deepStrictEqual(wow.get('{ __ns.lastToast.title, __ns.lastToast.text }'), ['Savannah Prowler (Cat, level 17)', 'Teaches Bite 3, Claw 3. Tame it and use the skill to learn it.']);
  assert.deepStrictEqual(wow.get('__ns.learned("beasts")["Savannah Prowler"]'), { family: 'Cat', zone: 'The Barrens', min: 17, max: 17 });
  wow.exec('__ns.lastToast = nil');
  wow.fire('PLAYER_TARGET_CHANGED');
  assert.strictEqual(wow.eval('tostring(__ns.lastToast)'), 'nil', 'once per beast and level');
  slash(wow, 'pets');
  assert.strictEqual(wow.eval('__ns.shell.current'), 'pets');
  noError(wow);
});

test('reputation: standings with progress, reward notes, the vendor\'s spot is learned', () => {
  const wow = client();
  const R = '__ns.reputation';
  const rows = wow.get(`${R}.rows()`);
  assert.deepStrictEqual(rows.slice(0, 2).map((r) => [r.name, r.label, r.cur, r.max]), [['Argent Dawn', 'Friendly', 1500, 6000], ['Brood of Nozdormu', 'Not met yet', 0, 0]]);
  assert.ok(rows.some((r) => r.name === 'Orgrimmar' && r.label === 'Honored'));
  assert.ok(rows.some((r) => r.name === 'Frostwolf Clan'), 'my side');
  assert.ok(!rows.some((r) => r.name === 'Stormpike Guard'), 'not the other side');
  assert.deepStrictEqual(wow.get(`{ ${R}.nextReward(${R}.rows()[1]) }`)[0], 'Honored');
  wow.exec('__units.npc = { name = "Quartermaster Miranda Breechlock" }');
  wow.fire('MERCHANT_SHOW');
  assert.deepStrictEqual(wow.get('__ns.learned("vendors")["Quartermaster Miranda Breechlock"]'), { map: 1411, x: 0.457, y: 0.123, zone: 'The Barrens' });
  slash(wow, 'reputation');
  assert.ok(wow.texts().some((t) => /^Friendly {3}· {3}4500 to the next standing {3}· {3}next reward at Honored$/.test(t)));
  noError(wow);
});

test('pvp: kills by day, battleground record, enemy log, my kill-on-sight list and its alert', () => {
  const wow = client();
  const P = '__ns.pvp';
  wow.fire('CHAT_MSG_COMBAT_HONOR_GAIN', 'Gankalot dies, honorable kill Rank: Scout (Estimated Honor Points: 14)');
  wow.fire('CHAT_MSG_COMBAT_HONOR_GAIN', 'You have been awarded 200 honor points.');
  const h = wow.get(`${P}.honor()`);
  assert.deepStrictEqual([h.session, h.lifetime, h.today, h.rank, h.progress], [3, 40, 1, 'Grunt', 0.4]);
  // A battleground ends: counted once.
  wow.setInstance(true, { type: 'pvp' });
  wow.exec('__winner = 0');
  wow.fire('UPDATE_BATTLEFIELD_SCORE');
  wow.fire('UPDATE_BATTLEFIELD_SCORE');
  assert.deepStrictEqual(wow.get(`${P}.battlegrounds()`), [{ map: 'The Barrens', played: 1, won: 1, rate: 1 }]);
  wow.setInstance(false);
  wow.fire('PLAYER_ENTERING_WORLD');
  // Enemies seen, and kill on sight.
  wow.exec('__units.target = { name = "Gankalot", player = true, enemy = true, class = "ROGUE", level = 25 }');
  wow.fire('PLAYER_TARGET_CHANGED');
  const e = wow.get(`${P}.enemies()`)[0];
  assert.deepStrictEqual([e.name, e.class, e.level, e.seen, e.killed, e.zone], ['Gankalot', 'ROGUE', 25, 1, 1, 'The Barrens']);
  assert.strictEqual(wow.eval('tostring(__ns.lastToast)'), 'nil', 'not on the list yet');
  slash(wow, 'kos gankalot camps the crossroads');
  assert.match(wow.printed(), /Gankalot is kill on sight\./);
  wow.fire('PLAYER_TARGET_CHANGED');
  assert.deepStrictEqual(wow.get('{ __ns.lastToast.title, __ns.lastToast.text }'), ['Kill on sight: Gankalot', 'camps the crossroads']);
  wow.exec('__ns.lastToast = nil');
  wow.fire('PLAYER_TARGET_CHANGED');
  assert.strictEqual(wow.eval('tostring(__ns.lastToast)'), 'nil', 'at most every two minutes');
  slash(wow, 'kos remove Gankalot');
  assert.ok(empty(wow.get(`${P}.kosList()`)));
  // A friendly player is never logged.
  wow.exec('__units.target = { name = "Friend", player = true, enemy = false }');
  wow.fire('PLAYER_TARGET_CHANGED');
  assert.strictEqual(wow.get(`${P}.enemies()`).length, 1);
  for (const v of ['overview', 'bgs', 'enemies', 'kos']) { slash(wow, 'pvp'); wow.exec(`${P}.setView("${v}")`); noError(wow); }
  noError(wow);
});

test('quality of life: everything is off by default; each helper does its one thing; Shift skips', () => {
  const wow = client();
  const calls = () => wow.get('__calls');
  wow.exec('__bags[0][3] = { itemID = 9, stackCount = 1, hyperlink = "|Hitem:9|h[Grey Thing]|h", quality = 0 }');
  for (const ev of ['MERCHANT_SHOW', 'QUEST_DETAIL', 'QUEST_PROGRESS', 'QUEST_COMPLETE', 'LOOT_READY']) wow.fire(ev);
  assert.ok(empty(calls()), 'nothing happens until switched on');
  for (const key of ['autoRepair', 'sellJunk', 'autoAccept', 'autoTurnIn', 'quickLoot']) wow.exec(`__ns.setOpt("${key}", true)`);
  wow.exec('__shift = true');
  for (const ev of ['MERCHANT_SHOW', 'QUEST_DETAIL']) wow.fire(ev);
  assert.ok(empty(calls()), 'Shift skips');
  wow.exec('__shift = false; __loot = { { "a", 1 }, { "b", 1 } }');
  wow.fire('MERCHANT_SHOW');
  assert.deepStrictEqual(calls(), ['repair:', 'use:0,3']);
  assert.match(wow.printed(), /Repaired for 25s 0c\./);
  assert.match(wow.printed(), /Sold 1 grey item\./);
  wow.exec('__calls = {}');
  wow.fire('QUEST_DETAIL'); wow.fire('QUEST_PROGRESS'); wow.fire('QUEST_COMPLETE'); wow.fire('LOOT_READY');
  assert.deepStrictEqual(calls(), ['accept:', 'complete:', 'reward:1', 'loot:2', 'loot:1']);
  wow.exec('__calls = {}; __choices = 3');
  wow.fire('QUEST_COMPLETE');
  assert.ok(empty(calls()), 'a reward to choose waits for the player');
  wow.exec('__repairCost = 99999999');
  wow.fire('MERCHANT_SHOW');
  assert.match(wow.printed(), /Not enough money to repair/);
  slash(wow, 'qol');
  assert.ok(wow.texts().includes('Repair at merchants'));
  noError(wow);
});

test('guild: who is online on its own; events, groups and sync through Guild Camp when it is there', () => {
  const alone = client();
  assert.deepStrictEqual(alone.get('__ns.guild.online()').map((p) => [p.name, p.level]), [['Grommash', 31]]);
  assert.ok(empty(alone.get('__ns.guild.events()')));
  assert.strictEqual(alone.eval('tostring(__ns.guild.sync())'), 'false');
  slash(alone, 'guild');
  assert.ok(alone.texts().some((t) => /^This part comes from Guild Camp\./.test(t)));
  noError(alone);

  const CAMP = `
__joined, __published = {}, {}
GuildCampAPI = { version = 1,
  raids = function() return { { title = "Molten Core", startsAt = 1800000000, coming = 12 }, { title = "Onyxia", startsAt = 1800090000, coming = 9, signup = "yes", role = "healer" } } end,
  groups = function() return { { n = 1, dungeon = "Wailing Caverns", leader = "Mokra", role = "t", startsAt = 0, need = { t = 0, h = 1, d = 2 }, members = { { name = "Mokra", role = "t" } }, mine = false, joined = false, waiting = false } } end,
  groupJoin = function(n, role) __joined[#__joined + 1] = n .. ":" .. role; return true end,
  groupNew = function(role, dungeon) __joined[#__joined + 1] = "new:" .. role .. ":" .. dungeon; return true end,
  kos = function() return { { name = "Stabby", reason = "ganks lowbies", by = "Mokra", t = 5 } } end,
  crafters = function(item) if item == "Runecloth Bag" then return "Zed,Mokra" end end,
  publish = function(addon, key, value) __published[addon .. "/" .. key] = value; return true end,
}`;
  const wow = client({ mocks: CAMP });
  assert.deepStrictEqual(wow.get('__ns.modules.guild.steps()').map((s) => s.text), ['1 guild event you haven\'t answered.', '1 guild dungeon group is looking for players.']);
  assert.strictEqual(wow.get('__ns.modules.guild.badge()'), 1);
  assert.deepStrictEqual(wow.get('__ns.professions.who("Runecloth Bag").guild'), ['Zed', 'Mokra']);
  assert.deepStrictEqual(wow.get('__ns.pvp.kosList()').map((k) => [k.name, k.guild, k.by]), [['Stabby', true, 'Mokra']]);
  // The snapshot reaches Guild Camp (at login, on logout and on the button).
  const snap = wow.get('__published["WarbandCodex/character_Thrallia"]');
  assert.deepStrictEqual([snap.name, snap.class, snap.level, snap.spec, snap.gear[0].name, snap.pvp.kills], ['Thrallia', 'SHAMAN', 23, 'Elemental', 'Worn Mail Helm', 40]);
  assert.deepStrictEqual(snap.reputations, [{ name: 'Argent Dawn', standing: 'Friendly' }, { name: 'Orgrimmar', standing: 'Honored' }]);
  wow.exec('__ns.setOpt("campSync", false)');
  assert.strictEqual(wow.eval('tostring(__ns.guild.sync())'), 'false', 'sharing can be switched off');
  slash(wow, 'guild');
  wow.exec('__ns.guild.setView("groups")');
  assert.ok(wow.texts().some((t) => /^Mokra \(tank\) {2}· {2}needs 1 healer, 2 dps$/.test(t)));
  noError(wow);
});

test('Home gathers the next steps from every tab', () => {
  const wow = client();
  wow.exec('__unspent = 1');
  wow.fire('TRAINER_SHOW');
  slash(wow, 'home');
  const steps = wow.get('__ns.modules.home.steps()').map((s) => [s.text, s.tab]);
  assert.deepStrictEqual(steps, [['Bags nearly full: 0 of 3 slots free.', undefined], ['1 talent point to spend.', 'talents'], ['Your trainer has 1 spell for you (18s 0c).', 'talents']]);
  assert.ok(wow.texts().includes('400 / 1000 XP  (+150 rested)'));
  noError(wow);
});

test('settings: one searchable list of every option; QoL switches start off', () => {
  const wow = client();
  slash(wow, 'settings');
  const keys = wow.get('(function() local t = {} for _, o in ipairs(__ns.optionList) do t[#t + 1] = o.key end return t end)()');
  for (const k of ['animations', 'toasts', 'minimap', 'tooltipGain', 'dungeonCard', 'lootLearn', 'recipeShare', 'petAlerts', 'kosAlerts', 'enemyLog', 'campSync', 'autoRepair', 'sellJunk', 'autoAccept', 'autoTurnIn', 'quickLoot', 'bagWarn', 'repairWarn']) assert.ok(keys.includes(k), k);
  for (const k of ['autoRepair', 'sellJunk', 'autoAccept', 'autoTurnIn', 'quickLoot', 'bagWarn', 'repairWarn']) assert.strictEqual(wow.eval(`tostring(__ns.opt("${k}"))`), 'false', k);
  wow.exec('WarbandCodexWindow.pages.settings.body.filter.type("grey")');
  const shown = wow.get('(function() local t = {} for _, r in ipairs(WarbandCodexWindow.pages.settings.body.list.rowsData) do t[#t + 1] = r.label or r.header end return t end)()');
  assert.deepStrictEqual(shown, ['Quality of life', 'Sell grey items']);
  wow.exec('__ns.shell.search("minimap button", true); __ns.shell.pickResult(1)');
  assert.strictEqual(wow.eval('__ns.shell.current'), 'settings');
  noError(wow);
});
