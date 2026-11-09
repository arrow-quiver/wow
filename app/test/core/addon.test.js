// The in-game addon on its own, run through the simulated client (wowsim): data collection, /wow commands,
// the main window, professions, tooltips, the Coach, the guild news the Guild Camp app writes, update
// notices and the wording players see. Nothing here needs the app or its local core.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WowClient, toLua, readToc, ADDON_DIR } = require('./wowsim');

const NOW = () => Math.floor(Date.now() / 1000);
const text = (wow, expr) => wow.eval(`tostring(${expr})`);
const noError = (wow) => assert.strictEqual(wow.eval('__ns.debugError'), null, 'no addon errors');

// A session: optional news from the app, extra mocks run before ADDON_LOADED, then login.
function session({ inbox, mocks = '', ...opts } = {}) {
  const wow = new WowClient({ inbox, ...opts });
  if (mocks) wow.exec(mocks);
  return wow.login();
}

// A stand-in for the sharing engine (Share.lua) that records what the addon hands it.
// It replaces whatever Share.lua set up, so these tests only see the addon's own calls.
const SHARE_STUB = `__shared = { put = {}, offers = {}, slash = {} }
__ns.Share = {
  putLocal = function(t, key, fields) table.insert(__shared.put, { type = t, key = key, fields = fields }); return true end,
  offer = function(t, key, fields) table.insert(__shared.offers, { type = t, key = key, fields = fields }) end,
  slash = function(rest) table.insert(__shared.slash, rest) end,
  myPid = function() return "Thrallia.p4m7" end,
  get = function(id) return nil end,
}`;
const stubShare = (wow) => { wow.exec(SHARE_STUB); return wow; };
const calls = (wow) => wow.get('__shared.put') || [];

// ---------------------------------------------------------------- data collection

test('addon collects data out of combat and parses /wow cta', () => {
  const wow = new WowClient();
  wow.fire('ADDON_LOADED', 'WowGuild');
  wow.fire('PLAYER_LOGIN');
  stubShare(wow);
  wow.fire('GUILD_ROSTER_UPDATE');
  wow.fire('TRADE_SKILL_SHOW');
  wow.slash('cta Crossroads 8 Alliance at the flight master');
  wow.slash('cta 3 help');
  wow.fire('PLAYER_LOGOUT');
  const db = wow.db();
  const me = db.characters.Thrallia;
  assert.strictEqual(me.class, 'SHAMAN');
  assert.strictEqual(me.level, 23);
  assert.strictEqual(me.race, 'Orc');
  assert.strictEqual(me.faction, 'Horde');
  assert.strictEqual(me.zone, 'The Barrens');
  assert.strictEqual(me.money, 123456);
  assert.strictEqual(me.guild, 'wow');
  assert.deepStrictEqual(me.professions.map((p) => p.name), ['Blacksmithing', 'Fishing', 'Cooking']);
  assert.deepStrictEqual(me.professions[0], { name: 'Blacksmithing', skill: 120, max: 150 });
  assert.deepStrictEqual(me.recipes.Blacksmithing.map((r) => r.name), ['Rough Sharpening Stone', 'Copper Chain Vest']);
  assert.match(wow.printed(), /Saved 2 Blacksmithing recipes for the guild crafter list/);
  assert.strictEqual(db.roster.members.length, 3);
  assert.strictEqual(db.roster.members[1].name, 'Grommash Hellscream', 'realm suffix removed');
  assert.deepStrictEqual(db.roster.members.map((m) => m.online), [true, true, false]);
  assert.strictEqual(db.roster.members[2].class, 'HUNTER');
  assert.deepStrictEqual(db.roster.members.map((m) => m.rankIndex), [0, 1, 2], 'in-game rank index (0 = Guild Master) is saved');
  // Calls to arms go to the sharing engine as "ca" records at once: no queue, no reload.
  const put = calls(wow);
  assert.deepStrictEqual(put.map((c) => [c.type, c.fields.zone, c.fields.needed, c.fields.message, c.fields.character]),
    [['ca', 'Crossroads', 8, 'Alliance at the flight master', 'Thrallia'], ['ca', 'The Barrens', 3, 'help', 'Thrallia']]);
  for (const c of put) assert.match(c.key, /^[0-9a-z]{6}$/, 'a random base36 key');
  assert.notStrictEqual(put[0].key, put[1].key);
  assert.strictEqual(db.ctaQueue, undefined, 'no call-to-arms queue in the saved data');
  assert.strictEqual(wow.eval('__popups'), '0', 'no reload needed to send a call to arms');

  // In combat: nothing gets collected.
  wow.exec('__inCombat = true; WowGuildDB.roster = { members = {} }; WowGuildDB.characters.Thrallia.recipes = nil');
  wow.exec('WowGuildDB.characters.Thrallia.readiness = nil; WowGuildDB.characters.Thrallia.inventory = nil');
  wow.fire('GUILD_ROSTER_UPDATE');
  wow.exec('__ns.collectRoster(); __ns.collectAll("test"); __ns.collectRecipes(); __ns.collectBank(); __ns.collectReadiness(); __ns.collectExtras()');
  assert.strictEqual(wow.eval('#WowGuildDB.roster.members'), '0');
  assert.strictEqual(wow.eval('WowGuildDB.characters.Thrallia.recipes'), null);
  assert.strictEqual(wow.eval('WowGuildDB.characters.Thrallia.readiness'), null);
  assert.strictEqual(wow.eval('WowGuildDB.characters.Thrallia.inventory'), null);
  noError(wow);
});

test('/wow cta: zone, number and message in any combination', () => {
  const wow = session();
  const parse = (s) => wow.get(`(function() local z, n, m = __ns.parseCta(${toLua(s)}) return { zone = z, needed = n, msg = m } end)()`);
  assert.deepStrictEqual(parse('Crossroads 5 Alliance hitting the flight master'), { zone: 'Crossroads', needed: 5, msg: 'Alliance hitting the flight master' });
  assert.deepStrictEqual(parse('5 need help here'), { zone: 'The Barrens', needed: 5, msg: 'need help here' });
  assert.deepStrictEqual(parse(''), { zone: 'The Barrens', msg: '' });
  assert.deepStrictEqual(parse('Hillsbrad Foothills 12'), { zone: 'Hillsbrad Foothills', needed: 12, msg: '' });
  assert.deepStrictEqual(parse('need help'), { zone: 'The Barrens', msg: 'need help' }, 'no number: the whole text is the message');
  // Without the sharing engine nothing is sent, and the player is told plainly.
  wow.exec('__ns.Share = nil');
  wow.slash('cta');
  assert.match(wow.printed(), /Calls to arms can't be sent right now\. Restart World of Warcraft to finish the addon update\. A \/reload isn't enough\./);
  noError(wow);
  stubShare(wow);
  wow.slash('cta');
  assert.match(wow.printed(), /Call to arms sent to your guild: The Barrens\./);
  assert.strictEqual(calls(wow)[0].fields.zone, 'The Barrens');
  assert.strictEqual(wow.db().ctaQueue, undefined);
});

test('raid readiness: item level, repair and consumables in bags', () => {
  const wow = session();
  wow.logout();
  const me = wow.db().characters.Thrallia;
  assert.deepStrictEqual(me.readiness.consumables, { potion: 5, bandage: 10 });
  assert.strictEqual(me.readiness.durability, 50);
  assert.strictEqual(me.readiness.ilvl, 58.2, 'equipped item level');
  assert.ok(me.readiness.at > 0);
  assert.ok(me.inventory.bags.find((i) => i.name === 'Minor Healing Potion' && i.count === 5));
  assert.ok(me.inventory.bags.find((i) => i.id === 9999 && i.name === 'Old Sword'));
});

const GUILD_BANK_MOCK = `
local gb = {
  [1] = { name = "Mats", slots = { [1] = {"|Hitem:14047|h[Runecloth]|h", 20}, [2] = {"|Hitem:14047|h[Runecloth]|h", 10}, [5] = {"|Hitem:13444|h[Major Mana Potion]|h", 4} } },
  [2] = { name = "Raid", slots = { [1] = {"|Hitem:13457|h[Greater Fire Protection Potion]|h", 6} } },
}
function GetNumGuildBankTabs() return 2 end
function GetGuildBankTabInfo(t) return gb[t].name, "icon", true end
function GetGuildBankItemLink(t, s) local x = gb[t].slots[s]; return x and x[1] end
function GetGuildBankItemInfo(t, s) local x = gb[t].slots[s]; return "tex", x and x[2] or 0 end
function QueryGuildBankTab() end
function QueryGuildBankLog() end
function GetGuildBankMoney() return 1234567 end
function GetNumGuildBankTransactions(t) return t == 1 and 1 or 0 end
function GetGuildBankTransaction(t, i) return "deposit", "Grommash", "|Hitem:14047|h[Runecloth]|h", 10, 1, nil, 0, 0, 0, 3 end
function GetNumGuildBankMoneyTransactions() return 1 end
function GetGuildBankMoneyTransaction(i) return "withdraw", "Thrallia", 50000, 0, 0, 1, 0 end
`;

test('bags, bank and guild bank are read when their windows open', () => {
  const wow = session({ mocks: GUILD_BANK_MOCK });
  wow.fire('BANKFRAME_OPENED');
  wow.fire('GUILDBANKFRAME_OPENED');
  wow.fire('GUILDBANKFRAME_CLOSED');
  wow.fire('PLAYER_LOGOUT');
  const sv = wow.db();
  const me = sv.characters.Thrallia;
  assert.deepStrictEqual(me.inventory.bank, [{ id: 14047, name: 'Runecloth', count: 35 }], 'stacks are added together');
  assert.ok(me.inventory.bankAt > 0);
  assert.ok(me.inventory.bags.find((i) => i.name === 'Minor Healing Potion' && i.count === 5));
  assert.strictEqual(sv.guildBank.money, 1234567);
  assert.strictEqual(sv.guildBank.guild, 'wow');
  assert.deepStrictEqual(sv.guildBank.tabs.map((t) => [t.name, t.items.map((i) => [i.name, i.count])]),
    [['Mats', [['Runecloth', 30], ['Major Mana Potion', 4]]], ['Raid', [['Greater Fire Protection Potion', 6]]]]);
  assert.strictEqual(sv.guildBank.log.length, 2);
  const deposit = sv.guildBank.log.find((l) => l.kind === 'deposit');
  assert.deepStrictEqual([deposit.who, deposit.id, deposit.name, deposit.count], ['Grommash', 14047, 'Runecloth', 10]);
  assert.ok(Math.abs(NOW() - 3 * 3600 - deposit.at) < 60, '"3 hours ago" becomes a time');
  const withdraw = sv.guildBank.log.find((l) => l.kind === 'withdraw');
  assert.deepStrictEqual([withdraw.who, withdraw.amount], ['Thrallia', 50000]);

  // The guild bank is only read while it's open, and not at all with bank sharing switched off.
  wow.exec('WowGuildDB.guildBank = nil; __ns.collectGuildBank()');
  assert.strictEqual(wow.eval('WowGuildDB.guildBank'), null, 'closed: nothing read');
  wow.exec('WowGuildDB.options.collectBank = false; WowGuildDB.characters.Thrallia.inventory.bank = nil');
  wow.fire('BANKFRAME_OPENED');
  wow.fire('GUILDBANKFRAME_OPENED');
  assert.strictEqual(wow.eval('WowGuildDB.characters.Thrallia.inventory.bank'), null);
  assert.strictEqual(wow.eval('WowGuildDB.guildBank'), null);
  noError(wow);
});

test('newer clients: the bank and guild bank open through the interaction manager', () => {
  const wow = session({ mocks: GUILD_BANK_MOCK + 'Enum = Enum or {}; Enum.PlayerInteractionType = { Banker = 8, GuildBanker = 10 }' });
  wow.fire('PLAYER_INTERACTION_MANAGER_FRAME_SHOW', 8);
  wow.fire('PLAYER_INTERACTION_MANAGER_FRAME_SHOW', 10);
  wow.fire('PLAYER_INTERACTION_MANAGER_FRAME_HIDE', 10);
  const sv = wow.db();
  assert.strictEqual(sv.characters.Thrallia.inventory.bank[0].count, 35);
  assert.strictEqual(sv.guildBank.tabs.length, 2);
});

test('PvP, reputations, currencies, realm and the addon version are saved', () => {
  const MOCK = `
function UnitPVPRank() return 6 end
function GetPVPRankInfo(r) return "Scout", r - 4 end
function GetPVPLifetimeStats() return 120, 3, 7 end
function GetPVPThisWeekStats() return 15, 900 end
function GetPVPLastWeekStats() return 40, 0, 2500, 5 end
function GetRealmName() return "Zul'jin" end
C_Reputation = { GetNumFactions = function() return 2 end, GetFactionDataByIndex = function(i)
  if i == 1 then return { name = "Horde", isHeader = true } end
  return { name = "Durotar Supply and Logistics", reaction = 5, currentStanding = 4500, currentReactionThreshold = 3000, nextReactionThreshold = 9000 } end }
C_CurrencyInfo = { GetCurrencyListSize = function() return 2 end,
  GetCurrencyListInfo = function(i) if i == 1 then return { name = "Merchant's Favor", quantity = 12, currencyID = 3001 } end return { name = "Empty", quantity = 0 } end,
  GetCurrencyInfo = function() return { quantity = 5400 } end }`;
  const wow = session({ mocks: MOCK, addonVersion: '0.5.0', inbox: { guild: 'wow', announcements: [{ body: 'Hello' }] } });
  wow.fire('PLAYER_LOGOUT');
  const sv = wow.db();
  assert.strictEqual(sv.addonVersion, '0.5.0', 'the app reads this');
  const me = sv.characters.Thrallia;
  assert.strictEqual(me.realm, "Zul'jin");
  assert.deepStrictEqual([me.pvp.rankName, me.pvp.rank, me.pvp.hk, me.pvp.weekHk, me.pvp.weekContribution, me.pvp.honor, me.pvp.highestRank],
    ['Scout', 2, 120, 15, 900, 5400, 3]);
  assert.deepStrictEqual([me.pvp.lastWeekHk, me.pvp.lastWeekContribution, me.pvp.lastWeekRank], [40, 2500, 5]);
  assert.deepStrictEqual(me.reputations, [{ name: 'Durotar Supply and Logistics', header: 'Horde', standing: 5, value: 1500, max: 6000 }]);
  assert.deepStrictEqual(me.currencies, [{ name: "Merchant's Favor", qty: 12, id: 3001 }], 'empty currencies are skipped');
  noError(wow);
});

test('older clients: the classic reputation, skill line, trade skill and craft APIs still work', () => {
  const MOCK = `
GetProfessions = nil
C_TradeSkillUI = nil
function GetNumFactions() return 2 end
function GetFactionInfo(i)
  if i == 1 then return "Horde", "", 0, 0, 0, 0, false, false, true, false, false end
  return "Orgrimmar", "", 6, 9000, 21000, 12000, false, false, false, false, true
end
local lines = { {"Professions", true}, {"Mining", false, 55, 150}, {"Secondary Skills", true}, {"First Aid", false, 30, 75}, {"Weapon Skills", true}, {"Swords", false, 100, 115} }
function GetNumSkillLines() return #lines end
function GetSkillLineInfo(i) local l = lines[i]; return l[1], l[2], nil, l[3], nil, nil, l[4] end
function GetTradeSkillLine() return "Tailoring" end
local ts = { {"Cloth", "header"}, {"Linen Belt", "medium", 2}, {"Brown Linen Shirt", "trivial", 0} }
function GetNumTradeSkills() return #ts end
function GetTradeSkillInfo(i) local t = ts[i]; return t[1], t[2], t[3] end
function GetTradeSkillNumReagents(i) return 1 end
function GetTradeSkillReagentInfo(i, r) return "Linen Cloth", "icon", 2 end
function GetTradeSkillReagentItemLink(i, r) return "|Hitem:2589::|h[Linen Cloth]|h" end
function GetTradeSkillItemLink(i) return "|Hitem:7026::|h[Linen Belt]|h" end
function GetNumCrafts() return 2 end
function GetCraftDisplaySkillLine() return "Enchanting" end
function GetCraftInfo(i) if i == 1 then return "Enchant Bracer - Minor Health", nil, "optimal" end return "Bracer", nil, "header" end
__selected = {}
function SelectTradeSkill(i) table.insert(__selected, "select:" .. i) end
function DoTradeSkill(i, n) table.insert(__selected, "do:" .. i .. "x" .. n) end`;
  const wow = session({ mocks: MOCK });
  wow.fire('TRADE_SKILL_SHOW');
  wow.fire('CRAFT_SHOW');
  wow.fire('PLAYER_LOGOUT');
  const me = wow.db().characters.Thrallia;
  assert.deepStrictEqual(me.professions, [{ name: 'Mining', skill: 55, max: 150 }, { name: 'First Aid', skill: 30, max: 75 }], 'weapon skills are not professions');
  assert.deepStrictEqual(me.reputations, [{ name: 'Orgrimmar', header: 'Horde', standing: 6, value: 3000, max: 12000 }]);
  assert.deepStrictEqual(me.recipes.Tailoring.map((r) => r.name), ['Linen Belt', 'Brown Linen Shirt']);
  assert.deepStrictEqual(me.recipes.Enchanting, [{ name: 'Enchant Bracer - Minor Health' }]);
  // The skill-up guide reads the same window.
  assert.strictEqual(wow.eval('__ns.prof.lastScan.method'), 'classic');
  const ranked = wow.get('(function() local t = {} for _, r in ipairs(__ns.prof.rank(__ns.prof.current.recipes)) do t[#t+1] = r.recipe.name end return t end)()');
  assert.deepStrictEqual(ranked, ['Linen Belt'], 'grey recipes give no points');
  assert.deepStrictEqual(wow.get('__ns.prof.current.recipes[1].reagents'), [{ id: 2589, name: 'Linen Cloth', qty: 2 }]);
  assert.strictEqual(wow.eval('__ns.prof.current.recipes[1].outputId'), '7026');
  wow.exec('__ns.prof.select(__ns.prof.current.recipes[1]); __ns.prof.craft(__ns.prof.current.recipes[1], 2)');
  assert.deepStrictEqual(wow.get('__selected'), ['select:2', 'do:2x2']);
  noError(wow);
});

test('SavedVariables written by the game load back unchanged', () => {
  const wow = session({ mocks: GUILD_BANK_MOCK });
  wow.fire('GUILD_ROSTER_UPDATE');
  wow.fire('TRADE_SKILL_SHOW');
  wow.fire('GUILDBANKFRAME_OPENED');
  wow.exec(`__ns.db.shopping = { { key = 1, name = ${toLua('"quoted" \\ back\\slash')}, qty = 1, reagents = {} } }`);
  wow.logout();
  const file = wow.saveVariablesBuffer();
  assert.match(file.toString('utf8'), /^\nWowGuildDB = \{\n/);
  const again = new WowClient({ savedVariables: file });
  assert.deepStrictEqual(again.db(), wow.db());
  assert.strictEqual(again.db().shopping[0].name, '"quoted" \\ back\\slash');
});

test('an existing player\'s WowGuildDB from addon 0.10 keeps working', () => {
  const old = `
WowGuildDB = {
	["version"] = 1,
	["addonVersion"] = "0.10.0",
	["options"] = { ["tooltips"] = false, ["loginNews"] = false },
	["characters"] = {
		["Thrallia"] = { ["name"] = "Thrallia", ["level"] = 22, ["recipes"] = { ["Blacksmithing"] = { { ["name"] = "Old Recipe" } } } },
		["Altie"] = { ["name"] = "Altie", ["level"] = 10, ["class"] = "MAGE" },
	},
	["ctaQueue"] = {
		{ ["zone"] = "Old", ["msg"] = "", ["at"] = ${NOW() - 2 * 86400}, ["character"] = "Thrallia" },
		{ ["zone"] = "Fresh", ["msg"] = "x", ["at"] = ${NOW() - 60}, ["character"] = "Thrallia" },
	},
	["roster"] = { ["members"] = { { ["name"] = "Someone" } }, ["scannedAt"] = 1 },
	["shopping"] = { { ["key"] = 77, ["name"] = "Linen Belt", ["qty"] = 3, ["prof"] = "Tailoring", ["reagents"] = { { ["id"] = 2589, ["name"] = "Linen Cloth", ["qty"] = 2 } } } },
	["reagentIds"] = { 2589 },
	["coach"] = { ["chars"] = { ["Thrallia"] = { ["name"] = "Thrallia", ["obs"] = { ["minutes"] = 30, ["pulls"] = 4 }, ["quiz"] = { ["aggression"] = 2 } } }, ["questions"] = {} },
	["ui"] = { ["minimapAngle"] = 45, ["trackerHidden"] = true, ["windowPos"] = { ["point"] = "TOP", ["x"] = 10, ["y"] = -20 } },
}
`;
  const wow = session({ savedVariables: old });
  const db = wow.db();
  assert.strictEqual(db.addonVersion, readToc().fields.Version, 'the new version is recorded');
  assert.strictEqual(db.version, 1);
  assert.strictEqual(wow.eval('tostring(__ns.opt("tooltips"))'), 'false', 'options survive');
  assert.strictEqual(wow.eval('tostring(__ns.opt("minimapButton"))'), 'true', 'new options default on');
  assert.strictEqual(db.characters.Altie.class, 'MAGE', 'other characters survive');
  assert.strictEqual(db.characters.Thrallia.level, 23, 'this character refreshes');
  assert.strictEqual(db.ctaQueue, undefined, 'the old call-to-arms queue is dropped: calls now go out at once');
  assert.strictEqual(wow.eval('__ns.prof.list()[1].qty'), '3', 'the shopping list survives');
  assert.strictEqual(text(wow, '__ns.prof.trackerShown()'), 'false', 'a hidden shopping list stays hidden');
  assert.strictEqual(db.coach.chars.Thrallia.obs.pulls, 4, 'Coach observations survive');
  assert.strictEqual(db.coach.chars.Thrallia.quiz.aggression, 2);
  assert.strictEqual(db.ui.minimapAngle, 45);
  assert.doesNotMatch(wow.printed(), /crafting request|campfire/, 'login news stays off');
  wow.slash('');
  assert.strictEqual(text(wow, 'WowGuildWindow:IsShown()'), 'true');
  noError(wow);
});

// ---------------------------------------------------------------- the main window

const TRADESKILL = `
Enum = Enum or {}; Enum.CraftingReagentType = { Basic = 1 }
C_TradeSkillUI = {
  IsTradeSkillLinked = function() return false end,
  GetBaseProfessionInfo = function() return { professionName = "Tailoring" } end,
  GetAllRecipeIDs = function() return { 1 } end,
  GetRecipeInfo = function() return { name = "Linen Belt", learned = true, relativeDifficulty = 1, numSkillUps = 1, numAvailable = 0 } end,
  GetRecipeSchematic = function() return { reagentSlotSchematics = { { reagentType = 1, quantityRequired = 2, reagents = { { itemID = 2589 } } } } } end,
}
C_Item.GetItemCount = function() return 1 end
C_Item.GetItemNameByID = function() return "Linen Cloth" end`;

const UI_INBOX = () => ({
  guild: 'wow', site: 'https://wow.example', latestAddon: '9.9.9', generatedAt: NOW() - 120,
  raids: [{ title: 'Hyjal week 1', startsAt: NOW() + 86400, coming: 12 }],
  announcements: [{ body: 'Raid sign-ups open Sunday', by: 'J#1' }],
  canCraft: [{ item: 'Copper Chain Vest', requester: 'Grom#2', notes: 'mats in mail' }],
  buddies: [{ character: 'Zuljinne', level: 18, zone: 'Stonetalon', whenText: 'tonight', note: 'Venture Co.' }],
});

// The news loads from a real WowGuild_Inbox/Inbox.lua file, the way the app writes it.
function uiClient() {
  const inboxFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-')), 'Inbox.lua');
  fs.writeFileSync(inboxFile, `WowGuildInbox = ${toLua(UI_INBOX())}\n`);
  const wow = new WowClient({ inboxFile });
  wow.exec(TRADESKILL);
  return wow.login();
}

test('minimap button opens the window on the Camp tab with raids, notices and status', () => {
  const wow = uiClient();
  assert.strictEqual(text(wow, 'WowGuildMinimapButton:IsShown()'), 'true');
  wow.click('WowGuildMinimapButton');
  assert.strictEqual(text(wow, 'WowGuildWindow:IsShown()'), 'true');
  assert.strictEqual(text(wow, '__ns.ui.current'), 'camp');
  assert.strictEqual(wow.eval('WowGuildWindow.pages.camp.sync and "ok"'), 'ok');
  assert.match(wow.eval('__ns.textRaids()'), /Hyjal week 1[\s\S]*12 coming[\s\S]*not signed up yet/);
  assert.match(wow.eval('__ns.textNotices()'), /Raid sign-ups open Sunday {2}\|cff999999J\|r/, 'battle tag number hidden');
  assert.ok(wow.texts().some((t) => /Guild news from 2 min ago/.test(t)), 'camp shows how fresh the news is');
  assert.ok(wow.eval('table.concat(UISpecialFrames, ",")').includes('WowGuildWindow'), 'Escape closes the window');
  wow.click('WowGuildMinimapButton');
  assert.strictEqual(text(wow, 'WowGuildWindow:IsShown()'), 'false', 'second click closes it');
  wow.click('WowGuildMinimapButton', 'RightButton');
  assert.strictEqual(text(wow, '__ns.ui.current'), 'settings', 'right-click opens settings');
  wow.exec('WowGuildMinimapButton.scripts.OnEnter(WowGuildMinimapButton)');
  noError(wow);
});

test('Sync now saves and offers the reload', () => {
  const wow = uiClient();
  wow.exec('__ns.ui.show("camp"); __popups = 0; WowGuildDB.roster = { members = {} }');
  wow.click('WowGuildWindow.pages.camp.sync');
  assert.strictEqual(wow.eval('__popups'), '1');
  assert.strictEqual(wow.eval('#WowGuildDB.roster.members'), '3', 'everything saved first');
  wow.slash('sync');
  assert.strictEqual(wow.eval('__popups'), '2');
  assert.match(wow.printed(), /Data saved\. Reload or log out and the Guild Camp app will upload it\./);
});

test('Call to arms form sends a call with the typed details', () => {
  const wow = stubShare(uiClient());
  wow.exec('__ns.ui.show("camp")');
  wow.click('WowGuildWindow.tabs.cta');
  assert.strictEqual(text(wow, '__ns.ui.current'), 'cta');
  assert.strictEqual(text(wow, 'WowGuildWindow.pages.cta.zone:GetText()'), 'The Barrens', 'zone is prefilled');
  wow.exec(`local p = WowGuildWindow.pages.cta
    p.zone:SetText("Crossroads"); p.needed:SetText("8"); p.msg:SetText("Alliance at the flight master")
    __popups = 0; __click(p.send)`);
  const q = calls(wow);
  assert.deepStrictEqual([q[0].type, q[0].fields.zone, q[0].fields.needed, q[0].fields.message], ['ca', 'Crossroads', 8, 'Alliance at the flight master']);
  assert.strictEqual(wow.eval('__popups'), '0', 'sent at once: no reload');
  assert.strictEqual(text(wow, 'WowGuildWindow.pages.cta.msg:GetText()'), '', 'message box clears');
  assert.ok(wow.texts().some((t) => /Calls to arms since you logged in[\s\S]*Crossroads \(need 8\) Alliance at the flight master \|cff999999you, /.test(t)), 'sent calls are listed');
  // A guildmate's call arrives (the sharing engine prints it and plays the sound): it's listed too.
  wow.exec(`__ns.ctaArrived({ id = "ca:k3f9a2", type = "ca", author = "Grommash", t = GetServerTime(),
    fields = { character = "Grommash", zone = "Tarren Mill", needed = 5.0, message = "they are back" } }, "d", "Grommash")`);
  assert.ok(wow.texts().some((t) => /Tarren Mill \(need 5\) they are back \|cff999999Grommash, /.test(t)));
  // Without the sharing engine the form says so and keeps what was typed.
  wow.exec(`__ns.Share = nil; local p = WowGuildWindow.pages.cta; p.msg:SetText("again"); __click(p.send)`);
  assert.match(wow.printed(), /Calls to arms can't be sent right now/);
  assert.strictEqual(text(wow, 'WowGuildWindow.pages.cta.msg:GetText()'), 'again');
  noError(wow);
});

test('Professions tab: guide and tracker buttons, per-recipe quantity and remove', () => {
  const wow = uiClient();
  wow.fire('TRADE_SKILL_SHOW');
  wow.exec('__ns.prof.addToList(__ns.prof.current.recipes[1], 5)');
  wow.exec('__ns.ui.show("prof")');
  const page = 'WowGuildWindow.pages.prof';
  assert.match(text(wow, `${page}.rows[1].text:GetText()`), /5 × Linen Belt/);
  assert.strictEqual(text(wow, `${page}.rows[2]:IsShown()`), 'false');
  wow.click(`${page}.rows[1].plus`);
  assert.strictEqual(wow.eval('__ns.prof.list()[1].qty'), '6');
  assert.match(text(wow, `${page}.rows[1].text:GetText()`), /6 × Linen Belt/, 'row updates straight away');
  wow.click(`${page}.rows[1].minus`);
  assert.strictEqual(wow.eval('__ns.prof.list()[1].qty'), '5');
  wow.click(`${page}.trackBtn`);
  assert.strictEqual(text(wow, '__ns.prof.trackerShown()'), 'true');
  assert.strictEqual(text(wow, `${page}.trackBtn:GetText()`), 'Hide shopping list');
  assert.strictEqual(text(wow, '__ns.prof.guideShown()'), 'true', 'guide opened by itself with the profession window');
  assert.strictEqual(text(wow, `${page}.guideBtn:GetText()`), 'Hide skill-up guide');
  wow.click(`${page}.guideBtn`);
  assert.strictEqual(text(wow, '__ns.prof.guideShown()'), 'false');
  wow.click(`${page}.guideBtn`);
  assert.strictEqual(text(wow, '__ns.prof.guideShown()'), 'true');
  wow.click(`${page}.rows[1].remove`);
  assert.strictEqual(wow.eval('#__ns.prof.list()'), '0');
  assert.strictEqual(text(wow, `${page}.rows[1]:IsShown()`), 'false');
  wow.exec('__popups = 0');
  wow.click(`${page}.clearBtn and ${page}.clearBtn or ${page}.trackBtn`);
  noError(wow);
});

test('Guild tab shows requests, your requests and leveling partners', () => {
  const inbox = { ...UI_INBOX(), myRequests: [{ item: 'Linen Belt', status: 'claimed', crafter: 'Grom#2' }, { item: 'Rope', status: 'open' }] };
  const wow = session({ inbox, mocks: TRADESKILL });
  wow.exec('__ns.ui.show("guild")');
  const guild = wow.eval('__ns.textGuild()');
  assert.match(guild, /Copper Chain Vest[\s\S]*for Grom\|r {2}mats in mail[\s\S]*Zuljinne \(18\) in Stonetalon, tonight[\s\S]*Venture Co\./);
  assert.match(guild, /Claim them in the Guild Camp app so nobody doubles up/);
  assert.match(guild, /Linen Belt {2}\|cff999999being made by Grom\|r/);
  assert.match(guild, /Rope {2}\|cff999999waiting for a crafter/);
  noError(wow);
});

test('Settings tab: options apply immediately, app link and update notice shown', () => {
  const wow = uiClient();
  wow.exec('__ns.ui.show("settings")');
  const page = 'WowGuildWindow.pages.settings';
  const APP = 'https://github.com/arrow-quiver/wow/releases/latest';
  assert.strictEqual(text(wow, `${page}.site:GetText()`), APP, 'the app comes from GitHub releases, not a guild server');
  wow.exec(`${page}.site.scripts.OnTextChanged(${page}.site, true)`);
  assert.strictEqual(text(wow, `${page}.site:GetText()`), APP, 'the link box is read-only');
  assert.ok(wow.texts().some((t) => /Addon version \d+\.\d+\.\d+.*9\.9\.9 is available.*Update it from the Guild Camp app \(Addon & sync page\)/.test(t)));
  assert.strictEqual(text(wow, `${page}.boxes[1]:GetChecked()`), 'true');
  wow.exec(`local cb = ${page}.boxes[1]; cb:SetChecked(false); __click(cb)`);
  assert.strictEqual(text(wow, 'WowGuildMinimapButton:IsShown()'), 'false', 'minimap button hides');
  assert.strictEqual(text(wow, 'WowGuildDB.options.minimapButton'), 'false');
  wow.exec(`local cb = ${page}.boxes[1]; cb:SetChecked(true); __click(cb)`);
  assert.strictEqual(text(wow, 'WowGuildMinimapButton:IsShown()'), 'true');
  // Every option has a box, in the same order as the Blizzard options panel.
  assert.strictEqual(wow.eval(`#${page}.boxes`), wow.eval('#__ns.OPTION_LIST'));
  assert.strictEqual(wow.eval('#__ns.OPTION_LIST'), '11');
  wow.exec('__ns.optionsPanel.scripts.OnShow()');
  assert.strictEqual(text(wow, '__ns.optionsPanel.boxes[2]:GetChecked()'), 'true');
  wow.exec('__ns.optionsPanel.boxes[2]:SetChecked(false); __click(__ns.optionsPanel.boxes[2])');
  assert.strictEqual(text(wow, 'WowGuildDB.options.tooltips'), 'false');
});

test('Settings tab links to the Guild Camp app even without any news yet', () => {
  const wow = session();
  wow.exec('__ns.ui.show("settings")');
  assert.strictEqual(text(wow, 'WowGuildWindow.pages.settings.site:GetText()'), 'https://github.com/arrow-quiver/wow/releases/latest');
});

test('minimap button drags around the minimap and remembers where', () => {
  const wow = uiClient();
  wow.exec('WowGuildMinimapButton.scripts.OnDragStart(WowGuildMinimapButton); WowGuildMinimapButton.scripts.OnUpdate(WowGuildMinimapButton)');
  assert.strictEqual(wow.eval('string.format("%.0f", WowGuildDB.ui.minimapAngle)'), '90');
  wow.exec('WowGuildMinimapButton.scripts.OnDragStop(WowGuildMinimapButton)');
  assert.strictEqual(wow.eval('WowGuildMinimapButton.scripts.OnUpdate'), null);
});

test('key binding, addon drawer and /wow all open the same window', () => {
  const wow = uiClient();
  wow.exec('WowGuild_Toggle()');
  assert.strictEqual(text(wow, 'WowGuildWindow:IsShown()'), 'true');
  wow.exec('WowGuild_OnAddonCompartmentClick()');
  assert.strictEqual(text(wow, 'WowGuildWindow:IsShown()'), 'false');
  wow.slash('');
  assert.strictEqual(text(wow, 'WowGuildWindow:IsShown()'), 'true');
  wow.slash('options');
  assert.strictEqual(text(wow, '__ns.ui.current'), 'settings');
  wow.slash('config');
  assert.strictEqual(text(wow, '__ns.ui.current'), 'settings');
  const toc = fs.readFileSync(path.join(ADDON_DIR, 'WowGuild.toc'), 'utf8');
  assert.match(toc, /AddonCompartmentFunc: WowGuild_OnAddonCompartmentClick/);
  assert.match(toc, /MainUI\.lua/);
  const bindings = fs.readFileSync(path.join(ADDON_DIR, 'Bindings.xml'), 'utf8');
  assert.match(bindings, /<Binding name="WOWGUILD_TOGGLE"[^>]*>\s*WowGuild_Toggle\(\)\s*<\/Binding>/);
  assert.match(bindings, /<Binding name="WOWGUILD_COACH"[^>]*>\s*WowGuild_ToggleCoach\(\)\s*<\/Binding>/);
  assert.strictEqual(wow.eval('BINDING_NAME_WOWGUILD_TOGGLE'), 'Open or close the guild window');
  assert.strictEqual(wow.eval('BINDING_HEADER_WOWGUILD'), 'Guild Camp');
  wow.exec('WowGuild_ToggleCoach()');
  assert.strictEqual(text(wow, 'WowGuildCoach:IsShown()'), 'true');
  // The other slash names reach the same handler.
  assert.deepStrictEqual([wow.eval('SLASH_WOWGUILD1'), wow.eval('SLASH_WOWGUILD2'), wow.eval('SLASH_WOWGUILD3')], ['/wow', '/wowguild', '/guildcamp']);
});

test('/wow help lists every command', () => {
  const wow = session();
  wow.clearOutput();
  wow.slash('help');
  const out = wow.printed();
  for (const cmd of ['/wow cta', '/wow share', '/wow sync', '/wow status', '/wow guide', '/wow list', '/wow coach', '/wow options', '/wow debug']) assert.ok(out.includes(cmd), cmd);
});

test('guild style by default: dark-and-gold window with text tabs, first-run welcome, what\'s new', () => {
  const wow = uiClient();
  wow.exec('if WowGuildWelcome then WowGuildWelcome:Hide() end; __ns.db.welcomeSeen = nil; __ns.welcome.check()');
  assert.strictEqual(wow.eval('tostring(WowGuildWelcome:IsShown())'), 'true', 'first login shows the welcome');
  assert.match(wow.eval('WowGuildWelcome.title:GetText()'), /wow/);
  wow.exec('__click(WowGuildWelcome.rows[2].btn)');
  assert.strictEqual(wow.eval('tostring(WowGuildCoach.quiz:IsShown())'), 'true', 'Take the quiz opens the Coach quiz');
  wow.exec('__ns.ui.show("guild")');
  assert.strictEqual(wow.eval('tostring(WowGuildWindow.styled)'), 'true');
  assert.strictEqual(wow.eval('tostring(WowGuildWindow.skinned)'), 'true');
  assert.strictEqual(wow.eval('tostring(WowGuildWindow.tabs.guild.on)'), 'true');
  assert.strictEqual(wow.eval('tostring(WowGuildWindow.tabs.camp.on)'), 'false');
  wow.exec('__click(WowGuildWindow.tabs.coach)');
  assert.strictEqual(wow.eval('tostring(WowGuildWindow.pages.coach:IsShown())'), 'true');
  assert.match(wow.eval('WowGuildWindow.title:GetText()'), /Guild Camp/);
  // Next login: no welcome; after an update with news: what's new, once.
  wow.exec('WowGuildWelcome:Hide(); __ns.welcome.NEWS[__ns.addonVersion()] = { "Something new" }; __ns.db.newsSeen = "0.0.1"; __ns.welcome.check()');
  assert.strictEqual(wow.eval('WowGuildWelcome.caps:GetText()'), "WHAT'S NEW");
  wow.exec('WowGuildWelcome:Hide(); __ns.welcome.check()');
  assert.strictEqual(wow.eval('tostring(WowGuildWelcome:IsShown())'), 'false');
  noError(wow);
});

test('window uses the Blizzard frame and bottom tabs when that style is picked', () => {
  const wow = uiClient();
  wow.exec('__ns.db.options.blizzardStyle = true; __ns.ui.show("guild")');
  assert.strictEqual(wow.eval('tostring(WowGuildWindow.native)'), 'true');
  assert.strictEqual(wow.eval('tostring(WowGuildWindow.bottomTabs)'), 'true');
  assert.strictEqual(wow.eval('WowGuildWindow.selectedTab'), '5');
  assert.match(wow.eval('WowGuildWindow.TitleText:GetText()'), /Guild Camp {2}\|cff999999wow\|r/);
  wow.exec('__ns.ui.show("nonsense")');
  assert.strictEqual(text(wow, '__ns.ui.current'), 'camp', 'an unknown tab falls back to Camp');
  noError(wow);
});

test('uses LibDBIcon when another addon provides it, instead of its own button', () => {
  const LIBS = `
__dbicon = { registered = nil, shown = nil }
local ldb = { NewDataObject = function(self, name, obj) __ldbname = name; __ldbobj = obj; return obj end }
local dbi = { Register = function(self, name, obj, db) __dbicon.registered = name end,
  Show = function(self) __dbicon.shown = true end, Hide = function(self) __dbicon.shown = false end }
function LibStub(name) if name == "LibDataBroker-1.1" then return ldb elseif name == "LibDBIcon-1.0" then return dbi end end`;
  const wow = session({ inbox: UI_INBOX(), mocks: LIBS });
  assert.strictEqual(wow.eval('__ldbname'), 'Guild Camp');
  assert.strictEqual(wow.eval('__ldbobj.type'), 'launcher');
  assert.strictEqual(wow.eval('__dbicon.registered'), 'Guild Camp');
  assert.strictEqual(wow.eval('tostring(__dbicon.shown)'), 'true');
  assert.strictEqual(wow.eval('tostring(WowGuildMinimapButton)'), 'nil', 'no duplicate button');
  wow.exec('__ldbobj.OnClick(nil, "LeftButton")');
  assert.strictEqual(wow.eval('tostring(WowGuildWindow:IsShown())'), 'true');
  wow.exec('__ldbobj.OnClick(nil, "RightButton")');
  assert.strictEqual(text(wow, '__ns.ui.current'), 'settings');
  wow.exec('__lines = {}; __ldbobj.OnTooltipShow({ AddLine = function(_, l) table.insert(__lines, l) end })');
  assert.deepStrictEqual(wow.get('__lines'), ['Guild Camp', 'Click: open the guild window', 'Right-click: settings']);
  wow.exec('WowGuildDB.options.minimapButton = false; __ns.applyOptions()');
  assert.strictEqual(wow.eval('tostring(__dbicon.shown)'), 'false');
  assert.strictEqual(wow.eval('tostring(WowGuildDB.ui.dbicon.hide)'), 'true', 'LibDBIcon remembers it');
});

test('skill-up guide opened without a profession shows a hint, not blank rows', () => {
  const wow = new WowClient();
  wow.exec('C_TradeSkillUI = nil; GetNumTradeSkills = nil');
  wow.login();
  wow.slash('guide');
  assert.strictEqual(text(wow, 'WowGuildSkillGuide:IsShown()'), 'true');
  assert.strictEqual(text(wow, 'WowGuildSkillGuide.rows[1]:IsShown()'), 'false', 'no empty Make / +5 rows');
  assert.match(wow.eval('WowGuildSkillGuide.sub:GetText()'), /Open a profession window/);
  assert.match(wow.printed(), /Open a profession window and the guide fills in/);
  wow.slash('guide');
  assert.strictEqual(text(wow, 'WowGuildSkillGuide:IsShown()'), 'false');
  assert.strictEqual(text(wow, 'WowGuildDB.ui.guideHidden'), 'true', 'closing it is remembered');
});

test('errors are reported, and the problem report explains the state', () => {
  const wow = uiClient();
  wow.exec('__handled = {}; function geterrorhandler() return function(e) table.insert(__handled, e) end end');
  wow.exec('__ns.on("WOWGUILD_TEST", function() error("boom") end); __ns.on("WOWGUILD_TEST", function() __second = true end); __fire("WOWGUILD_TEST")');
  assert.match(wow.eval('__handled[1]'), /Guild Camp: .*boom/);
  assert.strictEqual(wow.eval('tostring(__second)'), 'true', 'one failing handler never stops the others');
  wow.fire('TRADE_SKILL_SHOW');
  wow.fire('GUILD_ROSTER_UPDATE');
  wow.slash('debug');
  const report = wow.eval('WowGuildReport.edit:GetText()');
  assert.match(report, /addon: \d+\.\d+\.\d+/);
  assert.match(report, /profession API: modern/);
  assert.match(report, /last scan: Tailoring, 1 recipes, modern/);
  assert.match(report, /guild news: wow, generated /);
  assert.match(report, /roster scan: 3 members/);
  assert.match(report, /recent errors:\n {2}\d\d:\d\d:\d\d .*boom/);
  wow.exec('WowGuildReport:Hide(); __ns.ui.show("settings"); __click(WowGuildWindow.pages.settings.report)');
  assert.strictEqual(text(wow, 'WowGuildReport:IsShown()'), 'true');
  wow.exec('WowGuildReport.edit.scripts.OnTextChanged(WowGuildReport.edit, true)');
  assert.strictEqual(wow.eval('WowGuildReport.edit:GetText()'), wow.eval('WowGuildReport.report'), 'the report box is read-only');
});

// ---------------------------------------------------------------- professions

const BLACKSMITHING = `
Enum = Enum or {}; Enum.CraftingReagentType = { Basic = 1 }
local names = { [2770] = "Copper Ore", [2840] = "Copper Bar", [2589] = "Linen Cloth", [2835] = "Rough Stone", [9999] = "Mystery Dust" }
local recipes = {
  [1] = { name = "Copper Bracers", learned = true, relativeDifficulty = 0, numSkillUps = 1, numAvailable = 0, mats = { {2840, 2} } },
  [2] = { name = "Linen Belt", learned = true, relativeDifficulty = 1, numSkillUps = 1, numAvailable = 0, mats = { {2589, 1} } },
  [3] = { name = "Rough Grinding Stone", learned = true, relativeDifficulty = 2, numSkillUps = 1, numAvailable = 0, mats = { {2835, 4} } },
  [4] = { name = "Old Thing", learned = true, relativeDifficulty = 3, numSkillUps = 1, numAvailable = 9, mats = { {2835, 1} } },
  [5] = { name = "Ore Shard", learned = true, relativeDifficulty = 0, numSkillUps = 1, numAvailable = 3, mats = { {2770, 1} } },
  [6] = { name = "Strange Rod", learned = true, relativeDifficulty = 0, numSkillUps = 1, numAvailable = 0, mats = { {9999, 1} } },
  [7] = { name = "Not Learned", learned = false, relativeDifficulty = 0, mats = {} },
}
C_TradeSkillUI = {
  IsTradeSkillLinked = function() return false end,
  IsTradeSkillGuild = function() return false end,
  GetBaseProfessionInfo = function() return { professionName = "Blacksmithing" } end,
  GetAllRecipeIDs = function() return { 1, 2, 3, 4, 5, 6, 7 } end,
  GetRecipeInfo = function(id) local r = recipes[id]; return r and { name = r.name, learned = r.learned, relativeDifficulty = r.relativeDifficulty, numSkillUps = r.numSkillUps, numAvailable = r.numAvailable } end,
  GetRecipeSchematic = function(id)
    local slots = {}
    for _, m in ipairs(recipes[id].mats) do slots[#slots + 1] = { reagentType = 1, quantityRequired = m[2], reagents = { { itemID = m[1] } } } end
    slots[#slots + 1] = { reagentType = 0, quantityRequired = 1, reagents = { { itemID = 424242 } } } -- optional reagent: ignored
    return { reagentSlotSchematics = slots }
  end,
}
__counts = { [2589] = 2 }
C_Item.GetItemCount = function(id) return __counts[id] or 0 end
C_Item.GetItemNameByID = function(id) return names[id] end
local prices = { [2840] = 50, [2589] = 10, [2835] = 5, [2770] = 30 }
Auctionator = { API = { v1 = { GetAuctionPriceByItemID = function(caller, id) return prices[id] end } } }
ProfessionsFrame = { IsShown = function() return true end }
`;

test('skill-up guide ranks: mats on hand first, then cheapest per point, unknown prices last, grey skipped', () => {
  const wow = session({ mocks: BLACKSMITHING });
  wow.fire('TRADE_SKILL_SHOW');
  const order = wow.eval(`(function() local t = {} for _, r in ipairs(__ns.prof.rank(__ns.prof.current.recipes)) do t[#t+1] = r.recipe.name .. "=" .. string.format("%.1f", r.perPoint) end return table.concat(t, ", ") end)()`);
  // Ore Shard can be made from bags; Linen Belt 10/0.75=13.3; Grinding Stone 20/0.25=80; Bracers 100/1; Strange Rod has no price.
  assert.strictEqual(order, 'Ore Shard=30.0, Linen Belt=13.3, Rough Grinding Stone=80.0, Copper Bracers=100.0, Strange Rod=0.0');
  assert.strictEqual(wow.eval('#__ns.prof.current.recipes'), '6', 'unlearned recipe skipped');
  assert.strictEqual(wow.eval('#__ns.prof.current.recipes[1].reagents'), '1', 'optional reagents ignored');
  assert.strictEqual(wow.eval('#__ns.prof.rank(__ns.prof.current.recipes, 2)'), '2', 'the guide asks for its top rows only');
  // The guide window shows them, with prices from Auctionator and a chance for non-orange recipes.
  assert.strictEqual(text(wow, 'WowGuildSkillGuide:IsShown()'), 'true');
  assert.strictEqual(wow.eval('WowGuildSkillGuide.title:GetText()'), 'Blacksmithing skill-ups');
  assert.match(wow.eval('WowGuildSkillGuide.sub:GetText()'), /Prices from Auctionator/);
  assert.match(wow.eval('WowGuildSkillGuide.rows[1].info:GetText()'), /can make 3 now/);
  assert.match(wow.eval('WowGuildSkillGuide.rows[2].info:GetText()'), /13c per point {2}· {2}75% chance/);
  assert.match(wow.eval('WowGuildSkillGuide.rows[5].info:GetText()'), /some prices unknown/);
  assert.strictEqual(text(wow, 'WowGuildSkillGuide.rows[6]:IsShown()'), 'false');
  noError(wow);
  // Reagents are remembered so Guild Camp can price them.
  assert.deepStrictEqual(wow.db().reagentIds.sort((a, b) => a - b), [2589, 2770, 2835, 2840, 9999]);
  wow.fire('TRADE_SKILL_CLOSE');
  assert.strictEqual(text(wow, 'WowGuildSkillGuide:IsShown()'), 'false', 'closes with the profession window');
});

test('guide prices fall back to the guild price index without Auctionator', () => {
  const wow = session({ mocks: BLACKSMITHING + 'Auctionator = nil', inbox: { guild: 'wow', prices: [{ id: 2589, price: 8 }] } });
  wow.fire('TRADE_SKILL_SHOW');
  assert.deepStrictEqual(wow.get('{ __ns.prof.price(2589) }'), [8, 'guild']);
  assert.strictEqual(wow.eval('__ns.prof.price(2840)'), null);
  assert.match(wow.eval('WowGuildSkillGuide.sub:GetText()'), /Prices from guild scans/);
});

test('shopping list tracks mats, uses alt and guild bank stock, and ticks off as you loot', () => {
  const inbox = { guild: 'wow', prices: [], stock: [{ id: 2589, chars: [{ name: 'Thrallia', count: 2 }, { name: 'Altie', count: 7 }], guildBank: 20 }] };
  const wow = session({ mocks: BLACKSMITHING, inbox });
  wow.fire('TRADE_SKILL_SHOW');
  wow.exec('for _, r in ipairs(__ns.prof.current.recipes) do if r.name == "Linen Belt" then __ns.prof.addToList(r, 5) end end');
  assert.match(wow.printed(), /Added 5 × Linen Belt to your shopping list\. \/wow list shows it\./);
  wow.exec('for _, r in ipairs(__ns.prof.current.recipes) do if r.name == "Linen Belt" then __ns.prof.addToList(r, 1) end end');
  assert.strictEqual(wow.eval('__ns.prof.list()[1].qty'), '6', 'adding again increases the quantity');
  assert.strictEqual(wow.eval('__ns.prof.list()[1].prof'), 'Blacksmithing');
  wow.slash('list');
  assert.strictEqual(text(wow, '__ns.prof.trackerShown()'), 'true');
  const tracker = wow.eval('__ns.prof.trackerText()');
  assert.match(tracker, /For: 6 × Linen Belt/);
  assert.match(tracker, /Linen Cloth\|r {2}2 \/ 6 {2}\|cffe8a33d\(7 on alts, 20 in guild bank\)/, 'the character you are on is not counted as an alt');
  // Loot 4 more linen: done.
  wow.exec('__counts[2589] = 6');
  wow.fire('BAG_UPDATE_DELAYED');
  assert.match(wow.printed(), /Got all 6 Linen Cloth/);
  assert.match(wow.printed(), /Everything on your shopping list is ready/);
  assert.match(wow.eval('__ns.prof.trackerText()'), /\|cff40bf40Linen Cloth\|r {2}6 \/ 6$/m);
  // The list is saved for Guild Camp (Crafters page) and survives a reload.
  const saved = wow.db().shopping;
  assert.deepStrictEqual(saved.map((e) => [e.name, e.qty, e.reagents[0].id, e.reagents[0].qty]), [['Linen Belt', 6, 2589, 1]]);
  wow.slash('list clear');
  assert.strictEqual(wow.eval('#__ns.prof.list()'), '0');
  assert.match(wow.printed(), /Shopping list cleared/);
  assert.match(wow.eval('__ns.prof.trackerText()'), /^Empty\./);
  wow.slash('guide');
  noError(wow);
});

test('the shopping list reopens on login when it has items', () => {
  const first = session({ mocks: BLACKSMITHING });
  first.fire('TRADE_SKILL_SHOW');
  first.exec('__ns.prof.addToList(__ns.prof.current.recipes[2], 2)');
  first.logout();
  const second = session({ mocks: BLACKSMITHING, savedVariables: first.saveVariables() });
  assert.strictEqual(text(second, '__ns.prof.trackerShown()'), 'true');
  const third = session({ mocks: BLACKSMITHING, savedVariables: first.saveVariables().replace('["options"] = {', '["options"] = {\n["trackerOnLogin"] = false,') });
  assert.strictEqual(text(third, '__ns.prof.trackerShown()'), 'false', 'unless switched off');
});

const POLISH = `
Enum = Enum or {}; Enum.CraftingReagentType = { Basic = 1 }; Enum.TooltipDataType = { Item = 0 }
__calls = {}
C_TradeSkillUI = {
  IsTradeSkillLinked = function() return false end,
  GetBaseProfessionInfo = function() return { professionName = "Tailoring" } end,
  GetAllRecipeIDs = function() return { 77 } end,
  GetRecipeInfo = function() return { name = "Linen Belt", learned = true, relativeDifficulty = 0, numSkillUps = 1, numAvailable = 2, icon = 132491 } end,
  GetRecipeSchematic = function() return { outputItemID = 7026, reagentSlotSchematics = { { reagentType = 1, quantityRequired = 2, reagents = { { itemID = 2589 } } } } } end,
  OpenRecipe = function(id) table.insert(__calls, "open:" .. id) end,
  CraftRecipe = function(id, n) table.insert(__calls, "craft:" .. id .. "x" .. n) end,
}
C_Item.GetItemCount = function() return 1 end
C_Item.GetItemNameByID = function(id) return ({ [2589] = "Linen Cloth", [7026] = "Linen Belt" })[id] end
C_Item.GetItemIconByID = function(id) return 1000 + id end
C_Item.GetItemInfo = function(id) local n = C_Item.GetItemNameByID(id); return n, "|cffffffff|Hitem:" .. id .. "::|h[" .. tostring(n) .. "]|h|r", 1 end
ITEM_QUALITY_COLORS = { [1] = { hex = "|cffffffff" } }
__links = {}
function ChatEdit_InsertLink(l) table.insert(__links, l) return true end
__shift = false
function IsModifiedClick() return __shift end
GameTooltip = CreateFrame("GameTooltip", "GameTooltip")
__tt = {}
function GameTooltip:SetOwner() __tt = {} end
function GameTooltip:SetItemByID(id) table.insert(__tt, "item:" .. id) end
function GameTooltip:AddLine(t) table.insert(__tt, t) end
function GameTooltip:AddDoubleLine(a, b) table.insert(__tt, a .. " = " .. b) end
__postcall = nil
TooltipDataProcessor = { AddTooltipPostCall = function(kind, fn) __postcall = fn end }
__ah = {}
Auctionator = { API = { v1 = {
  GetAuctionPriceByItemID = function() return 50 end,
  MultiSearchExact = function(caller, names) for _, n in ipairs(names) do table.insert(__ah, caller .. ":" .. n) end end,
  CreateShoppingList = function(caller, list, names) table.insert(__ah, "list:" .. list .. ":" .. #names) end,
} } }`;

const POLISH_INBOX = {
  guild: 'wow', site: 'https://wow.example',
  holdings: [{ id: 2589, chars: [{ name: 'Thrallia', count: 3 }, { name: 'Altie', count: 7 }], guildBank: 40 }],
  crafters: [{ name: 'Linen Belt', who: 'Grommash,Zuljinne' }, { name: 'Bolt of Linen Cloth', who: 'A,B,C,D,E,F' }],
  prices: [{ id: 2589, price: 12 }],
};

test('item tooltips get guild crafters, other characters and guild bank', () => {
  const wow = session({ inbox: POLISH_INBOX, mocks: POLISH });
  assert.ok(wow.eval('__postcall ~= nil and "yes"'), 'hooked through the tooltip data processor');
  wow.exec('__tt = {}; __postcall(GameTooltip, { id = 2589 })');
  const lines = wow.eval('table.concat(__tt, "\\n")');
  assert.match(lines, /^\|cffe8a33dwow\|r Your other characters = Altie 7/, 'first line is tagged');
  assert.doesNotMatch(lines, /Thrallia/, 'the character you are on is not repeated');
  assert.match(lines, /Guild bank = 40/);
  assert.doesNotMatch(lines, /Guild price/, 'Auctionator shows its own price');
  wow.exec('__tt = {}; __postcall(GameTooltip, { id = 7026 })');
  assert.match(wow.eval('table.concat(__tt, "\\n")'), /Guild crafters = Grommash, Zuljinne/);
  // Long crafter lists are cut short.
  assert.deepStrictEqual(wow.get('__ns.tooltip.linesFor(1, "Bolt of Linen Cloth")'), [['Guild crafters', 'A, B, C, D +2']]);
  wow.exec('WowGuildDB.options.tooltips = false; __tt = {}; __postcall(GameTooltip, { id = 2589 })');
  assert.strictEqual(wow.eval('#__tt'), '0', 'switch it off in settings');
});

test('item tooltips show the guild price without Auctionator, and hook old clients through OnTooltipSetItem', () => {
  const OLD = POLISH + `
Auctionator = nil
TooltipDataProcessor = nil
__hooks = {}
function GameTooltip:HookScript(name, fn) __hooks[name] = fn end
function GameTooltip:GetItem() return "Linen Cloth", "|cffffffff|Hitem:2589::|h[Linen Cloth]|h|r" end`;
  const wow = session({ inbox: POLISH_INBOX, mocks: OLD });
  wow.exec('__tt = {}; __hooks.OnTooltipSetItem(GameTooltip)');
  const lines = wow.eval('table.concat(__tt, "\\n")');
  assert.match(lines, /Guild bank = 40/);
  assert.match(lines, /Guild price = 12c/);
});

test('guide rows: icon, item tooltip on hover, click opens recipe, shift-click links, Make crafts, +5 list', () => {
  const wow = session({ inbox: POLISH_INBOX, mocks: POLISH });
  wow.fire('TRADE_SKILL_SHOW');
  const row = 'WowGuildSkillGuide.rows[1]';
  assert.match(wow.eval(`${row}.name:GetText()`), /\|cffff8040Linen Belt\|r/, 'orange recipe');
  wow.exec(`${row}.scripts.OnEnter(${row})`);
  assert.strictEqual(wow.eval('__tt[1]'), 'item:7026');
  wow.click(row);
  wow.exec(`__shift = true; __click(${row}); __shift = false`);
  wow.click(`${row}.make`);
  assert.deepStrictEqual(wow.get('__calls'), ['open:77', 'craft:77x1']);
  assert.match(wow.eval('__links[1]'), /\|Hitem:7026::\|h\[Linen Belt\]/);
  wow.click(`${row}.add`);
  assert.strictEqual(wow.eval('__ns.prof.list()[1].qty'), '5');
  noError(wow);
});

test('professions tab: mats as item rows, auction house search and Auctionator list', () => {
  const wow = session({ inbox: POLISH_INBOX, mocks: POLISH });
  wow.fire('TRADE_SKILL_SHOW');
  wow.exec('__ns.prof.addToList(__ns.prof.current.recipes[1], 5)');
  wow.exec('__ns.ui.show("prof")');
  const mats = 'WowGuildWindow.pages.prof.mats.rows[1]';
  assert.strictEqual(wow.eval(`${mats}.itemId`), '2589');
  assert.match(wow.eval(`${mats}.note:GetText()`), /1 \/ 10\|r {2}\|cffe8a33d7 on alts, 40 in guild bank/);
  assert.match(wow.eval(`${mats}.name:GetText()`), /\|cffffffffLinen Cloth\|r/, 'name in its quality colour');
  wow.exec(`${mats}.scripts.OnEnter(${mats})`);
  assert.strictEqual(wow.eval('__tt[1]'), 'item:2589');
  wow.exec(`__shift = true; __click(${mats}); __shift = false`);
  assert.match(wow.eval('__links[1]'), /Linen Cloth/);
  assert.strictEqual(wow.eval('tostring(WowGuildWindow.pages.prof.ahBtn:IsShown())'), 'true');
  wow.click('WowGuildWindow.pages.prof.ahBtn');
  wow.click('WowGuildWindow.pages.prof.listBtn');
  assert.deepStrictEqual(wow.get('__ah'), ['WowGuild:Linen Cloth', 'list:Guild Camp shopping list:1']);
  assert.match(wow.printed(), /Made an Auctionator shopping list called "Guild Camp shopping list"/);
  noError(wow);
});

test('auction house search explains itself without Auctionator or when nothing is left', () => {
  const wow = session({ inbox: POLISH_INBOX, mocks: POLISH + '\nAuctionator = nil' });
  wow.fire('TRADE_SKILL_SHOW');
  assert.strictEqual(text(wow, '__ns.prof.searchAuctionHouse()'), 'false');
  assert.match(wow.printed(), /Nothing left to buy on your shopping list/);
  wow.exec('__ns.prof.addToList(__ns.prof.current.recipes[1], 5)');
  assert.strictEqual(text(wow, '__ns.prof.searchAuctionHouse()'), 'false');
  assert.match(wow.printed(), /Install Auctionator to search the auction house from your shopping list/);
  wow.exec('__ns.ui.show("prof")');
  assert.strictEqual(wow.eval('tostring(WowGuildWindow.pages.prof.ahBtn:IsShown())'), 'false');
});

// ---------------------------------------------------------------- the Coach

const COACH_GAME = `
DUEL_WINNER_KNOCKOUT = "%1$s has defeated %2$s in a duel"
DUEL_WINNER_RETREAT = "%2$s has fled from %1$s in a duel"
__t = 1000
function GetTime() return __t end
function GetRealmName() return "Forever" end
function UnitIsPVP() return __flagged == true end
function IsInGroup() return __grouped == true end
function GetPVPLifetimeStats() return __hk or 0, 0, 0 end
function GetNumTalentTabs() return 3 end
local tabs = { {"Elemental", 0}, {"Enhancement", 11}, {"Restoration", 0} }
function GetTalentTabInfo(i) return tabs[i][1], "icon", tabs[i][2], "bg" end
function GetNumTalents(tab) return tab == 2 and 2 or 0 end
function GetTalentInfo(tab, i) if i == 1 then return "Ancestral Knowledge", "icon", 1, 1, 5, 5 else return "Shield Specialization", "icon", 1, 2, 0, 5 end end
function UnitCharacterPoints() return 1 end
function GetInventoryItemLink(_, slot) if slot == 16 then return "|cff1eff00|Hitem:15223::|h[Big Stick]|h|r" end end
function GetItemInfo() return "Big Stick", nil, 2, 25 end
`;

test('the Coach learns play style, takes the quiz, and queues a question and a plan request', () => {
  const wow = session({ mocks: COACH_GAME, inbox: { guild: 'wow', generatedAt: 1, coach: { plans: {}, answers: [], pending: 0, enabled: true } } });
  // Two hours of aggressive, flagged play with fights, a death, kills and a won duel.
  wow.exec('__flagged = true');
  for (let i = 0; i < 240; i++) {
    if (i % 4 === 0) wow.exec('__fire("PLAYER_REGEN_DISABLED"); __t = __t + 20; __fire("PLAYER_REGEN_ENABLED")');
    if (i === 100) wow.exec('__hk = 12');
    wow.exec('__ns.coach.sample()');
  }
  wow.exec('__hk = 30; __ns.coach.sample()');
  wow.fire('PLAYER_DEAD');
  wow.fire('CHAT_MSG_SYSTEM', 'Thrallia has defeated Grommash in a duel');
  wow.fire('CHAT_MSG_SYSTEM', 'Someone has defeated Thrallia in a duel');
  wow.fire('CHAT_MSG_SYSTEM', 'Grommash has fled from Thrallia in a duel');
  wow.fire('QUEST_TURNED_IN');
  const obs = wow.get('__ns.coach.char().obs');
  assert.deepStrictEqual([obs.duelsWon, obs.duelsLost, obs.pulls, obs.deaths, obs.quests, obs.hk, obs.combatSec], [2, 1, 60, 1, 1, 30, 1200]);
  assert.strictEqual(obs.minutes, 120.5);
  assert.strictEqual(obs.flaggedMin, 120.5);
  // Out of combat only: a sample in combat just counts that it happened.
  wow.exec('__inCombat = true; __ns.coach.sample(); __inCombat = false');
  assert.strictEqual(wow.eval('__ns.coach.char().obs.combatSamples'), '1');
  assert.strictEqual(wow.eval('__ns.coach.char().obs.flaggedMin'), '120.5');

  // Open the window from the main panel's Coach tab: the main window steps aside.
  wow.exec('__ns.ui.show("coach")');
  assert.match(wow.texts().join('\n'), /Plan:|Play a little|Warmonger|Duelist/);
  wow.click('WowGuildWindow.pages.coach.open');
  assert.strictEqual(wow.eval('tostring(WowGuildCoach:IsShown())'), 'true');
  assert.strictEqual(wow.eval('tostring(WowGuildWindow:IsShown())'), 'false', 'the main window closes behind the Coach');
  assert.ok(wow.eval('table.concat(UISpecialFrames, ",")').includes('WowGuildCoach'));
  assert.match(wow.eval('WowGuildCoach.archetype:GetText()'), /The (Warmonger|Duelist)/);
  assert.match(wow.eval('WowGuildCoach.sub:GetText()'), /Level 23 Shaman {2}- {2}Elemental 0 \/ Enhancement 11 \/ Restoration 0/);
  // 241 samples out of combat plus the one in combat, half a minute each.
  assert.match(wow.eval('WowGuildCoach.observed:GetText()'), /Watched for 2h 01m of play\. Only outside combat\./);

  // The quiz: click answers, save.
  wow.click('WowGuildCoach.tune');
  assert.strictEqual(wow.eval('tostring(WowGuildCoach.quiz:IsShown())'), 'true');
  wow.exec(`local g = WowGuildCoach.quiz.groups
    __click(g[1].buttons[5]); __click(g[2].buttons[2]); __click(g[3].buttons[1]); __click(g[4].buttons[5]); __click(g[5].buttons[3])
    __click(g[6].buttons[1]); __click(g[7].buttons[2])`);
  wow.exec('__ns.coach.saveQuiz(WowGuildCoach.quiz.answers); WowGuildCoach.quiz:Hide()');
  const quiz = wow.get('__ns.coach.char().quiz');
  assert.deepStrictEqual(quiz, { aggression: 5, risk: 2, social: 1, pvp: 5, pace: 3, role: 'Damage', goal: 'World PvP' });
  const prof = wow.get('__ns.coach.char().profile');
  assert.ok(prof.scores.aggression >= 65 && prof.scores.pvp >= 65, JSON.stringify(prof.scores));
  assert.strictEqual(prof.archetype, 'Warmonger');
  assert.strictEqual(prof.quiz, true);

  // Next steps: the unspent point, plus the quiz no longer nags.
  const steps = wow.get('(function() local t = {} for _, s in ipairs(__ns.coach.nextSteps()) do t[#t+1] = s.title end return t end)()');
  assert.ok(steps.includes('Spend 1 talent point'), steps.join('|'));
  assert.ok(!steps.includes('Tell the Coach how you play'));

  // Ask a question in the Ask view; it waits for a reload.
  wow.exec('__ns.coachUI.view("ask"); WowGuildCoach.edit:SetText("Enhancement or Elemental for world PvP?")');
  wow.click('WowGuildCoach.action');
  assert.strictEqual(wow.eval('#__ns.db.coach.questions'), '1');
  assert.strictEqual(wow.eval('__ns.coach.waiting()[1].state'), 'unsent');
  assert.strictEqual(wow.eval('WowGuildCoach.action2:GetText()'), 'Send now (reload)');
  assert.ok(wow.texts().some((t) => /Waiting to send: press 'Send now'\. It reloads your UI so the Guild Camp app can send it\./.test(t)));
  assert.match(wow.printed(), /Question saved for the Coach\. Press 'Send now' \(or reload\) and the Guild Camp app sends it\./);
  wow.exec('WowGuildCoach.edit:SetText("   ")');
  wow.click('WowGuildCoach.action');
  assert.strictEqual(wow.eval('#__ns.db.coach.questions'), '1', 'blank questions are ignored');

  wow.exec('__ns.coachUI.view("build")');
  wow.click('WowGuildCoach.action');
  assert.ok(Number(wow.eval('__ns.coach.char().planRequest')) > 0);
  assert.match(wow.printed(), /Asked the Coach for a fresh build plan\. It's sent at your next \/reload or logout \(with the Guild Camp app running\)\./);
  assert.strictEqual(wow.eval('WowGuildCoach.foot:GetText()'), 'Fresh plan asked for. Reload and the Guild Camp app sends it.');
  wow.fire('PLAYER_LOGOUT');
  noError(wow);

  // What the app uploads for the Coach.
  const coach = wow.db().coach;
  const ch = coach.chars.Thrallia;
  assert.deepStrictEqual([ch.name, ch.class, ch.level, ch.realm], ['Thrallia', 'SHAMAN', 23, 'Forever']);
  assert.strictEqual(ch.profile.archetype, 'Warmonger');
  assert.deepStrictEqual(ch.talents.trees.map((t) => `${t.name} ${t.points}`), ['Elemental 0', 'Enhancement 11', 'Restoration 0']);
  assert.deepStrictEqual(ch.talents.picked, [{ name: 'Ancestral Knowledge', rank: 5, max: 5, tree: 'Enhancement' }]);
  assert.strictEqual(ch.talents.unspent, 1);
  assert.deepStrictEqual(ch.gear.items[0], { slot: 'Main hand', id: 15223, name: 'Big Stick', ilvl: 25, quality: 2 });
  assert.strictEqual(ch.gear.lowestDurability, 30);
  assert.ok(ch.stats.minutes > 0 && ch.stats.duelsWon === 2);
  assert.strictEqual(coach.questions[0].text, 'Enhancement or Elemental for world PvP?');
  assert.strictEqual(coach.questions[0].char, 'Thrallia');
  assert.ok(coach.questions[0].id);
});

test('the Coach shows answers and the build plan the app brings back', () => {
  const first = session({ mocks: COACH_GAME });
  first.exec('__ns.coach.ask("Enhancement or Elemental for world PvP?")');
  first.exec('__ns.coach.saveQuiz({ aggression = 5, risk = 2, social = 1, pvp = 5, pace = 3, role = "Damage", goal = "World PvP" })');
  first.logout();
  const qid = first.eval('WowGuildDB.coach.questions[1].id');
  const inbox = {
    guild: 'wow', generatedAt: NOW() + 10,
    coach: {
      enabled: true, pending: 0,
      answers: [{ qid, char: 'Thrallia', q: 'Enhancement or Elemental for world PvP?', a: 'Enhancement: Stormstrike burst wins world fights.', status: 'answered', at: NOW() }],
      plans: { Thrallia: { headline: 'Enhancement for world PvP', summary: 'Burst with Stormstrike.', spec: 'Enhancement', split: '0/31/20',
        talents: [{ name: 'Ancestral Knowledge', tree: 'Enhancement', points: 5, why: 'More mana' }, { name: 'Flurry', tree: 'Enhancement', points: 5, why: 'Big speed' }],
        stats: ['Strength', 'Agility'], gear: [{ slot: 'Two-hand', advice: 'Slow and heavy' }], tips: ['Open with Earth Shock interrupts'],
        next_steps: [{ title: 'Get a slow two-hander', detail: 'Windfury loves it' }], confidence: 'classic', level: 23, at: 1 } },
    },
  };
  const wow = session({ mocks: COACH_GAME, savedVariables: first.saveVariables(), inbox });
  wow.exec('__ns.coachUI.show("ask")');
  assert.strictEqual(wow.eval('#__ns.db.coach.questions'), '0', 'answered question is cleared from the queue');
  assert.match(wow.eval('__ns.coach.answers()[1].a'), /Stormstrike burst/);
  assert.ok(wow.texts().includes('Enhancement: Stormstrike burst wins world fights.'), 'the answer is on screen');
  assert.strictEqual(wow.eval('WowGuildCoach.action2:GetText()'), 'Check for answers');
  wow.exec('__ns.coachUI.view("build")');
  assert.strictEqual(wow.eval('__ns.coach.plan().spec'), 'Enhancement');
  const shown = wow.texts().join('\n');
  assert.match(shown, /Enhancement for world PvP/);
  assert.match(shown, /\|cffe8a33dFocus:\|r Enhancement {3}- {3}0\/31\/20 {3}- {3}based on Classic Era, Forever may differ/);
  assert.match(shown, /\|cff7f7f7fAncestral Knowledge\|r/, 'talents already taken are greyed');
  assert.match(shown, /Two-hand:\|r Slow and heavy/);
  assert.match(wow.eval('WowGuildCoach.foot:GetText()'), /^Made at level 23, /);
  const steps2 = wow.get('(function() local t = {} for _, s in ipairs(__ns.coach.nextSteps()) do t[#t+1] = s.title .. ": " .. s.detail end return t end)()').join('|');
  // Ancestral Knowledge is already 5/5, so the step points at the next talent the plan wants.
  assert.match(steps2, /Spend 1 talent point: Your plan says: Flurry \(Enhancement\), 0 of 5/);
  assert.match(steps2, /Get a slow two-hander: Windfury loves it/);
  assert.match(wow.eval('__ns.coach.summary()'), /Warmonger[\s\S]*Plan: Enhancement for world PvP/);
  noError(wow);
  wow.slash('coach');
  assert.strictEqual(wow.eval('tostring(WowGuildCoach:IsShown())'), 'false', '/wow coach toggles the window');
  wow.slash('coach build');
  assert.strictEqual(wow.eval('__ns.coachUI.current'), 'build');
  wow.slash('coach ask');
  assert.strictEqual(wow.eval('__ns.coachUI.current'), 'ask');
});

test('the Coach explains a sent question, a failed plan and a switched-off AI', () => {
  const first = session({ mocks: COACH_GAME });
  first.exec('__ns.coach.ask("How do I beat rogues?")');
  first.logout();
  const inbox = { guild: 'wow', generatedAt: NOW() + 30, coach: { enabled: true, answers: [], plans: { Thrallia: { error: 'The Coach is busy.' } } } };
  const wow = session({ mocks: COACH_GAME, savedVariables: first.saveVariables(), inbox });
  wow.exec('__ns.coachUI.show("ask")');
  assert.strictEqual(wow.eval('__ns.coach.waiting()[1].state'), 'sent', 'news newer than the question means it went out');
  assert.ok(wow.texts().includes("Sent. The Guild Camp app brings the answer back in a minute: press 'Check for answers'."));
  wow.exec('__ns.coachUI.view("build")');
  assert.ok(wow.texts().includes("The last attempt didn't work: The Coach is busy."));
  const off = session({ mocks: COACH_GAME, inbox: { guild: 'wow', coach: { enabled: false, answers: [], plans: {} } } });
  off.exec('__ns.coachUI.show("build")');
  assert.ok(off.texts().includes('Your guild has switched the Coach AI off.'));
  off.exec('__ns.coachUI.view("ask")');
  assert.strictEqual(off.eval('WowGuildCoach.foot:GetText()'), 'Your guild has switched the Coach AI off.');
  // At most five questions wait at once.
  for (let i = 0; i < 6; i++) off.exec(`__ns.coach.ask("q${i}")`);
  assert.strictEqual(off.eval('#WowGuildDB.coach.questions'), '5');
  assert.match(off.printed(), /You already have 5 questions waiting/);
});

test('Coach next steps: repairs, bag space, trainer, professions behind, quiz', () => {
  const MOCK = COACH_GAME + `
function UnitLevel() return 40 end
function GetInventoryItemDurability(slot) if slot == 5 then return 10, 100 end end
C_Container.GetContainerNumFreeSlots = function(bag) return bag == 0 and 1 or 0 end
function UnitCharacterPoints() return 0 end
local profs = { [2] = {"Blacksmithing", 120, 225}, [4] = {"Fishing", 40, 225} }
function GetProfessions() return nil, 2, nil, 4 end
function GetProfessionInfo(i) local p = profs[i]; return p[1], "icon", p[2], p[3] end`;
  const wow = session({ mocks: MOCK });
  wow.exec('__ns.coach.refresh()');
  const steps = wow.get('(function() local t = {} for _, s in ipairs(__ns.coach.nextSteps()) do t[#t+1] = s.kind .. ": " .. s.title .. " / " .. s.detail end return t end)()');
  assert.deepStrictEqual(steps, [
    'repair: Repair your gear / Something is down to 10% durability.',
    "bags: Make bag space / Only 1 free bag slot. Vendor grey items or bank what you don't need.",
    'trainer: Visit your class trainer / New spell ranks arrive every even level.',
    'prof: Blacksmithing is behind your level / 120 of about 200. The skill-up guide shows what to make.',
    "quiz: Tell the Coach how you play / Five quick questions. Press 'Tune my style'.",
  ]);
  wow.fire('TRAINER_SHOW');
  assert.ok(!wow.get('(function() local t = {} for _, s in ipairs(__ns.coach.nextSteps()) do t[#t+1] = s.kind end return t end)()').includes('trainer'), 'visiting the trainer clears it');
});

// ---------------------------------------------------------------- guild news from the app

test('raids, sign-ups and soft reserves from the app show in game', () => {
  const inbox = {
    guild: 'wow', generatedAt: NOW(),
    raids: [
      { title: 'Week 1', startsAt: NOW() + 86400, coming: 3, signup: 'yes', role: 'Healer', reserves: [{ name: 'Night Cloak', bonus: 0 }, { name: 'Band of Accuria', bonus: 20 }] },
      { title: 'Week 2', startsAt: NOW() + 2 * 86400, coming: 0 },
      { title: 'Premade', startsAt: NOW() + 3 * 86400, coming: 5, signup: 'tentative' },
      { title: 'Late one', startsAt: NOW() + 4 * 86400, coming: 1, signup: 'no' },
    ],
  };
  const wow = session({ inbox });
  const raids = wow.eval('__ns.textRaids()');
  assert.match(raids, /Week 1 {2}\|cff999999\w{3} \d\d \w{3} \d\d:\d\d, 3 coming\|r\n {4}\|cff3fbf5ayou're coming\|r as Healer\n {4}\|cff999999reserved:\|r Night Cloak, Band of Accuria \(\+20\)/);
  assert.match(raids, /Week 2[^\n]*\n {4}\|cffe8a33dnot signed up yet: sign up in the Guild Camp app\|r/);
  assert.match(raids, /Premade[^\n]*\n {4}\|cffe8a33dyou're a maybe/);
  assert.match(raids, /Late one[^\n]*\n {4}\|cff999999you can't make it/);
  assert.doesNotMatch(wow.printed(), /not signed up yet/, 'signed up for the next raid: no reminder');
  const steps = wow.get('(function() local t = {} for _, s in ipairs(__ns.coach.nextSteps()) do t[#t+1] = s.title .. ": " .. s.detail end return t end)()');
  assert.ok(steps.some((s) => /^Sign up: Week 2: \w{3} \d\d \w{3}, \d\d:\d\d in the Guild Camp app\.$/.test(s)), steps.join('|'));
  wow.slash('');
  noError(wow);
});

test('login news: craft requests, the next raid, the latest notice', () => {
  const inbox = {
    guild: 'wow', generatedAt: NOW(),
    canCraft: [{ item: 'Copper Chain Vest', requester: 'Grom#2' }, { item: 'Linen Belt', requester: 'Zul#3' }],
    raids: [{ title: 'Week 1', startsAt: NOW() + 86400, coming: 3 }],
    announcements: [{ body: 'Raid sign-ups Sunday', by: 'J#1' }],
  };
  const wow = session({ inbox });
  assert.match(wow.printed(), /2 crafting requests you can make\. Week 1 on \w{3} \d\d:\d\d: you're not signed up yet\. latest notice: Raid sign-ups Sunday\. Click the campfire on your minimap for more\./);
  assert.strictEqual(wow.eval('WowGuildInbox.canCraft[1].item'), 'Copper Chain Vest');
  const quiet = session({ inbox: { guild: 'wow', generatedAt: NOW() } });
  assert.match(quiet.printed(), /Click the campfire on your minimap for the guild window\.$/);
  const none = session();
  assert.match(none.printed(), /No guild news yet: is the Guild Camp app running\?/);
  // Odd or partial news never breaks the window.
  const odd = session({ inbox: { raids: [{}], announcements: [{}], canCraft: [{}], myRequests: [{ status: 'claimed' }], buddies: [{}] } });
  odd.slash('');
  odd.exec('__ns.ui.show("guild")');
  noError(odd);
});

test('/wow status reports what is saved and how fresh the news is', () => {
  const wow = session({ inbox: { guild: 'wow', generatedAt: NOW() - 3600 } });
  wow.fire('GUILD_ROSTER_UPDATE');
  wow.fire('TRADE_SKILL_SHOW');
  wow.clearOutput();
  wow.slash('status');
  assert.match(wow.printed(), /3 professions and 2 recipes saved for this character\. Guild roster: 3 members\.\n.*Last guild news: \d\d \w{3} \d\d:\d\d$/);
  const none = session();
  none.clearOutput();
  none.slash('status');
  assert.match(none.printed(), /No guild news yet\. Is the Guild Camp app running and signed in\?/);
});

// ---------------------------------------------------------------- updates and wording

const versionLess = (wow, a, b) => wow.eval(`tostring(__ns.versionLess(${toLua(a)}, ${toLua(b)}))`) === 'true';

test('versions compare numerically, with pre-releases before the release', () => {
  const wow = session();
  assert.ok(versionLess(wow, '0.4.0', '0.10.0'));
  assert.ok(!versionLess(wow, '1.0.0', '0.9.9'));
  assert.ok(!versionLess(wow, '0.5.0', '0.5.0'));
  assert.ok(versionLess(wow, '0.11.0-beta.1', '0.11.0'));
  assert.ok(!versionLess(wow, '0.11.0', '0.11.0-beta.1'));
  assert.ok(versionLess(wow, '0.11.0-beta.2', '0.11.0-beta.10'));
  assert.ok(versionLess(wow, '0.11.0-alpha.3', '0.11.0-beta.1'));
  assert.ok(versionLess(wow, '0.11.0-beta', '0.11.0-beta.1'));
  assert.ok(versionLess(wow, '0.11.0-beta.9', '0.11.1-beta.1'));
  assert.ok(!versionLess(wow, '?', '0.11.0'), 'an unreadable version never asks for an update');
  assert.ok(!versionLess(wow, null, '0.11.0'));
  assert.ok(!versionLess(wow, '0.11.0', null));
});

test('update notice points at the Guild Camp app, once per session', () => {
  const wow = session({ addonVersion: '0.11.0', inbox: { guild: 'wow', latestAddon: '0.12.0', site: 'https://wow.example' } });
  const notice = /\|cffe8a33dA newer version of this addon \(0\.12\.0\) is out\.\|r Update it from the Guild Camp app \(Addon & sync page\)\./;
  assert.match(wow.printed(), notice);
  assert.doesNotMatch(wow.printed(), /\/get|CurseForge|website|site/i, 'not CurseForge or the website');
  wow.fire('PLAYER_LOGIN');
  wow.exec('__ns.showLoginNews()');
  assert.strictEqual(wow.printedLines().filter((l) => notice.test(l)).length, 1, 'shown once per session');
  // The window and /wow status say the same.
  wow.exec('__ns.ui.show("camp")');
  assert.ok(wow.texts().some((t) => /Addon version 0\.12\.0 is out\.\|r Update it from the Guild Camp app \(Addon & sync page\)\./.test(t)));
  wow.clearOutput();
  wow.slash('status');
  assert.match(wow.printed(), /Addon version 0\.11\.0\. Version 0\.12\.0 is out\. Update it from the Guild Camp app \(Addon & sync page\)\./);
  wow.exec('__ns.optionsPanel.scripts.OnShow()');
  assert.ok(wow.texts().some((t) => /^Version 0\.11\.0\n0\.12\.0 is available\. Update it from the Guild Camp app/.test(t)));
  assert.ok(!wow.texts().some((t) => /Guild server/.test(t)), 'no guild server any more');
  // A new session shows it again.
  const next = session({ addonVersion: '0.11.0', savedVariables: wow.saveVariables(), inbox: { guild: 'wow', latestAddon: '0.12.0' } });
  assert.match(next.printed(), notice);
});

test('no update notice when the addon is current, newer, switched off or there is no news', () => {
  const cases = [
    { addonVersion: '0.12.0', latest: '0.12.0' },
    { addonVersion: '0.12.1', latest: '0.12.0' },
    { addonVersion: '0.12.0', latest: '0.12.0-beta.4' },
    { addonVersion: '0.12.0', latest: undefined },
  ];
  for (const c of cases) {
    const wow = session({ addonVersion: c.addonVersion, inbox: { guild: 'wow', latestAddon: c.latest } });
    assert.doesNotMatch(wow.printed(), /newer version/, JSON.stringify(c));
    assert.strictEqual(wow.eval('__ns.updateAvailable()'), null);
  }
  const beta = session({ addonVersion: '0.12.0-beta.2', inbox: { guild: 'wow', latestAddon: '0.12.0' } });
  assert.match(beta.printed(), /A newer version of this addon \(0\.12\.0\) is out/, 'a beta tester hears about the release');
  const none = session({ addonVersion: '0.1.0' });
  assert.doesNotMatch(none.printed(), /newer version/);
  // Switched off in settings: silent from the next login.
  const off = session({ addonVersion: '0.1.0', inbox: { guild: 'wow', latestAddon: '0.6.0', announcements: [{ body: 'Hello' }] } });
  assert.match(off.printed(), /latest notice: Hello/);
  off.logout();
  const later = new WowClient({ addonVersion: '0.1.0', savedVariables: off.saveVariables(), inbox: { guild: 'wow', latestAddon: '0.6.0', announcements: [{ body: 'Hello' }] } });
  later.exec('WowGuildDB.options.loginNews = false; WowGuildDB.options.updateNotice = false');
  later.login();
  assert.doesNotMatch(later.printed(), /latest notice|newer version/);
  later.slash('options');
  noError(later);
});

test('no "companion" or website wording reaches the player', () => {
  const banned = /companion|website|guild site|curseforge|downloads page/i;
  const check = (wow, label) => {
    const seen = [...wow.printedLines(), ...wow.texts()];
    const bad = seen.filter((t) => banned.test(t));
    assert.deepStrictEqual(bad, [], `${label}: ${bad.join(' | ')}`);
    return seen;
  };
  const exercise = (wow) => {
    for (const cmd of ['status', 'sync', 'help', '', 'guide', 'guide', 'list', 'list', 'debug']) wow.slash(cmd);
    for (const tab of ['camp', 'coach', 'cta', 'prof', 'guild', 'settings']) wow.exec(`__ns.ui.show("${tab}")`);
    wow.exec('__ns.optionsPanel.scripts.OnShow()');
    wow.exec('__ns.coachUI.show("steps"); __ns.coachUI.view("build"); __ns.coachUI.view("ask")');
    wow.exec('__ns.coach.requestPlan(); __ns.coachUI.view("build")');
    wow.exec('WowGuildCoach.edit:SetText("Which talents?"); __ns.coachUI.submit()');
    wow.exec('__ns.coachUI.view("ask"); __ns.coachUI.showQuiz()');
    wow.exec('WowGuildMinimapButton.scripts.OnEnter(WowGuildMinimapButton)');
    wow.slash('cta Crossroads 3 help');
    wow.logout();
  };
  // Without any news (the app not set up yet) ...
  const fresh = session();
  exercise(fresh);
  const freshSeen = check(fresh, 'no news');
  assert.ok(freshSeen.some((t) => /Guild Camp app/.test(t)), 'it names the Guild Camp app instead');
  // ... and with news, an update waiting, and the Coach AI switched off.
  const later = session({ addonVersion: '0.11.0', inbox: { ...UI_INBOX(), latestAddon: '0.12.0', coach: { enabled: false, answers: [], plans: {} } } });
  exercise(later);
  check(later, 'with news');
  noError(later);
});

test('the addon\'s own text never mentions the companion app', () => {
  // Player-facing strings are checked above; this catches anything those flows don't reach.
  // The one allowed hit is the "Companion" play-style archetype, which is about grouping, not the app.
  for (const f of fs.readdirSync(ADDON_DIR).filter((n) => /\.(lua|xml|toc)$/.test(n))) {
    const lines = fs.readFileSync(path.join(ADDON_DIR, f), 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      if (!/companion/i.test(line)) return;
      const archetype = /name = "Companion", blurb = "Better with friends/.test(line);
      assert.ok(archetype || line.trim().startsWith('--'), `${f}:${i + 1}: ${line.trim()}`);
    });
  }
});

// ---------------------------------------------------------------- the package

test('the .toc: name, version, notes, game versions and files', () => {
  const { fields, files } = readToc();
  assert.strictEqual(fields.Title, 'Guild Camp');
  assert.strictEqual(fields.Interface, '16001, 120105', 'WoW: Forever and Retail');
  assert.match(fields.Version, /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/);
  const wow = new WowClient();
  assert.ok(!versionLess(wow, fields.Version, '0.11.0'), 'at least 0.11.0');
  assert.strictEqual(fields.SavedVariables, 'WowGuildDB', 'existing players keep their data');
  assert.deepStrictEqual(fields.OptionalDeps.split(/\s*,\s*/).sort(), ['Auctionator', 'WowGuild_Inbox']);
  assert.match(fields.Notes, /Guild Camp desktop app/);
  assert.doesNotMatch(fields.Notes, /companion|website/i);
  assert.ok(fields.Notes.length <= 200, `Notes are short (${fields.Notes.length} characters)`);
  assert.strictEqual(fields.AddonCompartmentFunc, 'WowGuild_OnAddonCompartmentClick');
  assert.strictEqual(fields.IconTexture, 'Interface\\Icons\\Spell_Fire_Fire');
  // Every listed file exists, every Lua file is listed, and nothing the app writes is in the package.
  for (const f of files) assert.ok(fs.existsSync(path.join(ADDON_DIR, f)), `${f} exists`);
  const onDisk = fs.readdirSync(ADDON_DIR);
  assert.deepStrictEqual(onDisk.filter((n) => n.endsWith('.lua')).sort(), [...files].sort());
  assert.ok(!files.some((f) => /inbox|data\//i.test(f)), 'the news loads from WowGuild_Inbox, not the addon folder');
  assert.ok(!onDisk.some((n) => /inbox/i.test(n) || n === 'Data'), 'no inbox file or Data folder shipped');
  assert.ok(onDisk.includes('Bindings.xml'));
  // The addon reads WowGuildInbox but never defines it: that's the app's job.
  for (const f of files) assert.doesNotMatch(fs.readFileSync(path.join(ADDON_DIR, f), 'utf8'), /^\s*WowGuildInbox\s*=/m, f);
  // The reported version is the .toc's.
  wow.login();
  assert.strictEqual(wow.db().addonVersion, fields.Version);
  assert.strictEqual(wow.eval('__ns.addonVersion()'), fields.Version);
});

test('works without C_AddOns (older clients) and reports an unknown version safely', () => {
  const wow = new WowClient();
  wow.exec('C_AddOns = nil; function GetAddOnMetadata(a, k) if a == "WowGuild" and k == "Version" then return "0.10.5" end end');
  wow.login();
  assert.strictEqual(wow.db().addonVersion, '0.10.5');
  const bare = new WowClient({ inbox: { latestAddon: '9.0.0' } });
  bare.exec('C_AddOns = nil; GetAddOnMetadata = nil');
  bare.login();
  assert.strictEqual(bare.db().addonVersion, '?');
  assert.doesNotMatch(bare.printed(), /newer version/, 'no nagging when the version is unknown');
});
