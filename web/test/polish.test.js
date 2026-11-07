// Polish: guild info on item tooltips, item rows, recipe actions, auction house, LibDataBroker/LibDBIcon.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const dbm = require('../src/db');
const { applyPayload, buildInbox, toLua } = require('../src/sync');
const { WowClient } = require('./wowsim');

const GAME = `
Enum = Enum or {}; Enum.CraftingReagentType = { Basic = 1 }; Enum.TooltipDataType = { Item = 0 }
__calls = {}
local function rec(name) return function(...) table.insert(__calls, name .. ":" .. table.concat({ tostringall and tostringall(...) or tostring((...)) }, ",")) end end
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

function client(inbox, extra = '') {
  const inboxFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-')), 'Inbox.lua');
  fs.writeFileSync(inboxFile, `WowGuildInbox = ${toLua(inbox)}\n`);
  const wow = new WowClient({ inboxFile });
  wow.exec(GAME + extra);
  wow.fire('ADDON_LOADED', 'WowGuild');
  wow.fire('PLAYER_LOGIN');
  return wow;
}
const INBOX = {
  guild: 'wow', site: 'https://wow.example',
  holdings: [{ id: 2589, chars: [{ name: 'Thrallia', count: 3 }, { name: 'Altie', count: 7 }], guildBank: 40 }],
  crafters: [{ name: 'Linen Belt', who: 'Grommash,Zuljinne' }],
  prices: [{ id: 2589, price: 12 }],
};

test('site sends holdings and guild crafters for tooltips', () => {
  const db = dbm.open(':memory:');
  const u = db.prepare("INSERT INTO users (bnet_id, battletag) VALUES ('a','J#1')").run().lastInsertRowid;
  const g = db.prepare("INSERT INTO guilds (name, invite_code) VALUES ('wow','i')").run().lastInsertRowid;
  db.prepare("INSERT INTO memberships (user_id, guild_id, role) VALUES (?,?,'owner')").run(u, g);
  applyPayload(db, g, u, {
    characters: { Altie: { name: 'Altie', inventory: { bank: [{ id: 2589, name: 'Linen Cloth', count: 7 }] }, recipes: { Tailoring: [{ name: 'Linen Belt' }] } } },
    guildBank: { scannedAt: Math.floor(Date.now() / 1000), tabs: [{ name: 'Mats', items: [{ id: 2589, name: 'Linen Cloth', count: 40 }] }] },
  });
  const inbox = buildInbox(db, g, u);
  assert.deepStrictEqual(inbox.holdings, [{ id: 2589, chars: [{ name: 'Altie', count: 7 }], guildBank: 40 }]);
  assert.deepStrictEqual(inbox.crafters, [{ name: 'Linen Belt', who: 'Altie' }]);
});

test('item tooltips get guild crafters, other characters and guild bank', () => {
  const wow = client(INBOX);
  assert.ok(wow.eval('__postcall ~= nil and "yes"'), 'hooked through the tooltip data processor');
  wow.exec('__tt = {}; __postcall(GameTooltip, { id = 2589 })');
  const lines = wow.eval('table.concat(__tt, "\\n")');
  assert.match(lines, /Your other characters = Altie 7/);
  assert.doesNotMatch(lines, /Thrallia/, 'the character you are on is not repeated');
  assert.match(lines, /Guild bank = 40/);
  assert.doesNotMatch(lines, /Guild price/, 'Auctionator shows its own price');
  wow.exec('__tt = {}; __postcall(GameTooltip, { id = 7026 })');
  assert.match(wow.eval('table.concat(__tt, "\\n")'), /Guild crafters = Grommash, Zuljinne/);
  wow.exec('WowGuildDB.options.tooltips = false; __tt = {}; __postcall(GameTooltip, { id = 2589 })');
  assert.strictEqual(wow.eval('#__tt'), '0', 'switch it off in settings');
});

test('guide rows: icon, item tooltip on hover, click opens recipe, shift-click links, Make crafts', () => {
  const wow = client(INBOX);
  wow.fire('TRADE_SKILL_SHOW');
  const row = 'WowGuildSkillGuide.rows[1]';
  assert.match(wow.eval(`${row}.name:GetText()`), /Linen Belt/);
  wow.exec(`${row}.scripts.OnEnter(${row})`);
  assert.strictEqual(wow.eval('__tt[1]'), 'item:7026');
  wow.exec(`__click(${row})`);
  wow.exec(`__shift = true; __click(${row}); __shift = false`);
  wow.exec(`__click(${row}.make)`);
  assert.deepStrictEqual(wow.eval('table.concat(__calls, ";")').split(';'), ['open:77', 'craft:77x1']);
  assert.match(wow.eval('__links[1]'), /\|Hitem:7026::\|h\[Linen Belt\]/);
  assert.strictEqual(wow.eval('__ns.debugError'), null);
});

test('professions tab: mats as item rows, auction house search and Auctionator list', () => {
  const wow = client(INBOX);
  wow.fire('TRADE_SKILL_SHOW');
  wow.exec('__ns.prof.addToList(__ns.prof.current.recipes[1], 5)');
  wow.exec('__ns.ui.show("prof")');
  const mats = 'WowGuildWindow.pages.prof.mats.rows[1]';
  assert.strictEqual(wow.eval(`${mats}.itemId`), '2589');
  assert.strictEqual(wow.eval(`${mats}.icon.scripts and "x" or "x"`), 'x');
  assert.match(wow.eval(`${mats}.note:GetText()`), /1 \/ 10\|r {2}\|cffe8a33d7 on alts, 40 in guild bank/);
  wow.exec(`${mats}.scripts.OnEnter(${mats})`);
  assert.strictEqual(wow.eval('__tt[1]'), 'item:2589');
  assert.strictEqual(wow.eval('tostring(WowGuildWindow.pages.prof.ahBtn:IsShown())'), 'true');
  wow.exec('__click(WowGuildWindow.pages.prof.ahBtn); __click(WowGuildWindow.pages.prof.listBtn)');
  assert.deepStrictEqual(wow.eval('table.concat(__ah, ";")').split(';'), ['WowGuild:Linen Cloth', 'list:Guild Camp shopping list:1']);
  assert.strictEqual(wow.eval('__ns.debugError'), null);
});

test('window uses Blizzard frame and bottom tabs when available', () => {
  const wow = client(INBOX);
  wow.exec('__ns.ui.show("guild")');
  assert.strictEqual(wow.eval('tostring(WowGuildWindow.native)'), 'true');
  assert.strictEqual(wow.eval('tostring(WowGuildWindow.bottomTabs)'), 'true');
  assert.strictEqual(wow.eval('WowGuildWindow.selectedTab'), '5');
  assert.match(wow.eval('WowGuildWindow.TitleText:GetText()'), /Guild Camp/);
});

test('uses LibDBIcon when another addon provides it, instead of its own button', () => {
  const LIBS = `
__dbicon = { registered = nil, shown = nil }
local ldb = { NewDataObject = function(self, name, obj) __ldbobj = obj; return obj end }
local dbi = { Register = function(self, name, obj, db) __dbicon.registered = name end,
  Show = function(self) __dbicon.shown = true end, Hide = function(self) __dbicon.shown = false end }
function LibStub(name) if name == "LibDataBroker-1.1" then return ldb elseif name == "LibDBIcon-1.0" then return dbi end end`;
  const wow = client(INBOX, LIBS);
  assert.strictEqual(wow.eval('__dbicon.registered'), 'Guild Camp');
  assert.strictEqual(wow.eval('tostring(__dbicon.shown)'), 'true');
  assert.strictEqual(wow.eval('tostring(WowGuildMinimapButton)'), 'nil', 'no duplicate button');
  wow.exec('__ldbobj.OnClick(nil, "LeftButton")');
  assert.strictEqual(wow.eval('tostring(WowGuildWindow:IsShown())'), 'true');
  wow.exec('WowGuildDB.options.minimapButton = false; __ns.applyOptions()');
  assert.strictEqual(wow.eval('tostring(__dbicon.shown)'), 'false');
});
