// The addon's main window: every action reachable by clicking, no slash commands needed.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { toLua } = require('../src/sync');
const { WowClient } = require('./wowsim');
const { parseSavedVariables } = require('../../companion/lua');

const ADDON = path.join(__dirname, '..', '..', 'addon', 'WowGuild');
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

function client() {
  const inboxFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-')), 'Inbox.lua');
  fs.writeFileSync(inboxFile, `WowGuildInbox = ${toLua({
    guild: 'wow', site: 'https://wow.example', latestAddon: '9.9.9', generatedAt: Math.floor(Date.now() / 1000) - 120,
    raids: [{ title: 'Hyjal week 1', startsAt: Math.floor(Date.now() / 1000) + 86400, coming: 12 }],
    announcements: [{ body: 'Raid sign-ups open Sunday', by: 'J#1' }],
    canCraft: [{ item: 'Copper Chain Vest', requester: 'Grom#2', notes: 'mats in mail' }],
    buddies: [{ character: 'Zuljinne', level: 18, zone: 'Stonetalon', whenText: 'tonight', note: 'Venture Co.' }],
  })}\n`);
  const wow = new WowClient({ inboxFile });
  wow.exec(TRADESKILL);
  wow.fire('ADDON_LOADED', 'WowGuild');
  wow.fire('PLAYER_LOGIN');
  return wow;
}
const text = (wow, expr) => wow.eval(`tostring(${expr})`);

test('minimap button opens the window on the Camp tab with raids, notices and status', () => {
  const wow = client();
  assert.strictEqual(text(wow, 'WowGuildMinimapButton:IsShown()'), 'true');
  wow.exec('__click(WowGuildMinimapButton)');
  assert.strictEqual(text(wow, 'WowGuildWindow:IsShown()'), 'true');
  assert.strictEqual(text(wow, '__ns.ui.current'), 'camp');
  const camp = wow.eval('WowGuildWindow.pages.camp.sync and "ok"');
  assert.strictEqual(camp, 'ok');
  // The camp text is set on a font string inside the page's scroll area; read it via the text builders.
  assert.match(wow.eval('__ns.textRaids()'), /Hyjal week 1[\s\S]*not signed up yet/);
  assert.match(wow.eval('__ns.textNotices()'), /Raid sign-ups open Sunday/);
  assert.ok(wow.eval('table.concat(UISpecialFrames, ",")').includes('WowGuildWindow'), 'Escape closes the window');
  wow.exec('__click(WowGuildMinimapButton)');
  assert.strictEqual(text(wow, 'WowGuildWindow:IsShown()'), 'false', 'second click closes it');
  wow.exec('__click(WowGuildMinimapButton, "RightButton")');
  assert.strictEqual(text(wow, '__ns.ui.current'), 'settings', 'right-click opens settings');
  assert.strictEqual(wow.eval('__ns.debugError'), null);
});

test('Sync now saves and offers the reload', () => {
  const wow = client();
  wow.exec('__ns.ui.show("camp"); __popups = 0; __click(WowGuildWindow.pages.camp.sync)');
  assert.strictEqual(wow.eval('__popups'), '1');
});

test('Call to arms form queues a call with the typed details', () => {
  const wow = client();
  wow.exec('__click(WowGuildWindow and WowGuildWindow.tabs.cta or (function() __ns.ui.show("camp") return WowGuildWindow.tabs.cta end)())');
  assert.strictEqual(text(wow, '__ns.ui.current'), 'cta');
  assert.strictEqual(text(wow, 'WowGuildWindow.pages.cta.zone:GetText()'), 'The Barrens', 'zone is prefilled');
  wow.exec(`local p = WowGuildWindow.pages.cta
    p.zone:SetText("Crossroads"); p.needed:SetText("8"); p.msg:SetText("Alliance at the flight master")
    __popups = 0; __click(p.send)`);
  const q = parseSavedVariables(wow.saveVariables()).WowGuildDB.ctaQueue;
  assert.deepStrictEqual([q[0].zone, q[0].needed, q[0].msg], ['Crossroads', 8, 'Alliance at the flight master']);
  assert.strictEqual(wow.eval('__popups'), '1', 'offers a reload to send it');
  assert.strictEqual(text(wow, 'WowGuildWindow.pages.cta.msg:GetText()'), '', 'message box clears');
});

test('Professions tab: guide and tracker buttons, per-recipe quantity and remove', () => {
  const wow = client();
  wow.fire('TRADE_SKILL_SHOW');
  wow.exec('__ns.prof.addToList(__ns.prof.current.recipes[1], 5)');
  wow.exec('__ns.ui.show("prof")');
  const page = 'WowGuildWindow.pages.prof';
  assert.match(text(wow, `${page}.rows[1].text:GetText()`), /5 × Linen Belt/);
  assert.strictEqual(text(wow, `${page}.rows[2]:IsShown()`), 'false');
  wow.exec(`__click(${page}.rows[1].plus)`);
  assert.strictEqual(wow.eval('__ns.prof.list()[1].qty'), '6');
  assert.match(text(wow, `${page}.rows[1].text:GetText()`), /6 × Linen Belt/, 'row updates straight away');
  wow.exec(`__click(${page}.rows[1].minus)`);
  assert.strictEqual(wow.eval('__ns.prof.list()[1].qty'), '5');
  wow.exec(`__click(${page}.trackBtn)`);
  assert.strictEqual(text(wow, '__ns.prof.trackerShown()'), 'true');
  assert.strictEqual(text(wow, `${page}.trackBtn:GetText()`), 'Hide shopping list');
  const before = text(wow, '__ns.prof.guideShown()');
  assert.strictEqual(before, 'true', 'guide opened by itself with the profession window');
  assert.strictEqual(text(wow, `${page}.guideBtn:GetText()`), 'Hide skill-up guide');
  wow.exec(`__click(${page}.guideBtn)`);
  assert.strictEqual(text(wow, '__ns.prof.guideShown()'), 'false');
  wow.exec(`__click(${page}.guideBtn)`);
  assert.strictEqual(text(wow, '__ns.prof.guideShown()'), 'true');
  wow.exec(`__click(${page}.rows[1].remove)`);
  assert.strictEqual(wow.eval('#__ns.prof.list()'), '0');
  assert.strictEqual(text(wow, `${page}.rows[1]:IsShown()`), 'false');
  assert.strictEqual(wow.eval('__ns.debugError'), null);
});

test('Guild tab shows requests and leveling partners', () => {
  const wow = client();
  wow.exec('__ns.ui.show("guild")');
  assert.match(wow.eval('__ns.textGuild()'), /Copper Chain Vest[\s\S]*for Grom[\s\S]*Zuljinne \(18\) in Stonetalon, tonight[\s\S]*Venture Co\./);
});

test('Settings tab: options apply immediately, site link and update notice shown', () => {
  const wow = client();
  wow.exec('__ns.ui.show("settings")');
  const page = 'WowGuildWindow.pages.settings';
  assert.strictEqual(text(wow, `${page}.site:GetText()`), 'https://wow.example/get');
  assert.strictEqual(text(wow, `${page}.boxes[1]:GetChecked()`), 'true');
  wow.exec(`local cb = ${page}.boxes[1]; cb:SetChecked(false); __click(cb)`);
  assert.strictEqual(text(wow, 'WowGuildMinimapButton:IsShown()'), 'false', 'minimap button hides');
  assert.strictEqual(text(wow, 'WowGuildDB.options.minimapButton'), 'false');
  wow.exec(`local cb = ${page}.boxes[1]; cb:SetChecked(true); __click(cb)`);
  assert.strictEqual(text(wow, 'WowGuildMinimapButton:IsShown()'), 'true');
});

test('minimap button drags around the minimap and remembers where', () => {
  const wow = client();
  wow.exec('WowGuildMinimapButton.scripts.OnDragStart(WowGuildMinimapButton); WowGuildMinimapButton.scripts.OnUpdate(WowGuildMinimapButton)');
  assert.strictEqual(wow.eval('string.format("%.0f", WowGuildDB.ui.minimapAngle)'), '90');
});

test('key binding, addon drawer and /wow all open the same window', () => {
  const wow = client();
  wow.exec('WowGuild_Toggle()');
  assert.strictEqual(text(wow, 'WowGuildWindow:IsShown()'), 'true');
  wow.exec('WowGuild_OnAddonCompartmentClick()');
  assert.strictEqual(text(wow, 'WowGuildWindow:IsShown()'), 'false');
  wow.slash('');
  assert.strictEqual(text(wow, 'WowGuildWindow:IsShown()'), 'true');
  wow.slash('options');
  assert.strictEqual(text(wow, '__ns.ui.current'), 'settings');
  const toc = fs.readFileSync(path.join(ADDON, 'WowGuild.toc'), 'utf8');
  assert.match(toc, /AddonCompartmentFunc: WowGuild_OnAddonCompartmentClick/);
  assert.match(toc, /MainUI\.lua/);
  const bindings = fs.readFileSync(path.join(ADDON, 'Bindings.xml'), 'utf8');
  assert.match(bindings, /<Binding name="WOWGUILD_TOGGLE"[^>]*>\s*WowGuild_Toggle\(\)\s*<\/Binding>/);
  assert.strictEqual(wow.eval('BINDING_NAME_WOWGUILD_TOGGLE'), 'Open or close the guild window');
});
