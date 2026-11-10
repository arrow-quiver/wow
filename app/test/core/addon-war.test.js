'use strict';
// War.lua: death and kill marks with map positions, the "wm" record, the call-for-help popup, and the guild's
// marks as pins on the world map.
const test = require('node:test');
const assert = require('node:assert');
const { WowClient } = require('./wowsim');

const MAP = `
__pos = { x = 0.452, y = 0.381 }
C_Map = C_Map or {}
C_Map.GetBestMapForUnit = function() return 1424 end
C_Map.GetPlayerMapPosition = function() return { GetXY = function() return __pos.x, __pos.y end } end
C_Map.GetMapInfo = function(id) return { name = id == 1424 and "Hillsbrad Foothills" or "Elsewhere" } end
__pvp = "contested"
GetZonePVPInfo = function() return __pvp end
`;
const SHARE = `__offers = {}
__wm = {}
__ns.Share = {
  putLocal = function(t, key, fields) __lastPut = { type = t, key = key, fields = fields }; return true end,
  offer = function(t, key, fields) table.insert(__offers, { type = t, key = key }) end,
  myPid = function() return "Thrallia.p4m7" end,
  ready = function() return true end,
  list = function(t) if t == "wm" then return __wm end return {} end,
  get = function() return nil end,
}`;

// The game's death recap (C_DeathRecap.GetRecapEvents) and the PvP flag: how War.lua tells a death to players.
const COMBAT = `
__flagged = true
UnitIsPVP = function(unit) return __flagged end
__recap = nil
C_DeathRecap = { GetRecapEvents = function() return __recap end }
__ROGUE = { sourceGUID = "Player-4395-0F0F0F0F", sourceName = "Sneaky" }
__WOLF = { sourceGUID = "Pet-0-4395-0-1-1234-0100ABCDEF", sourceName = "Fang" }
__OGRE = { sourceGUID = "Creature-0-4395-0-1-2287-000ABC", sourceName = "Crushridge Ogre" }
`;

function client() {
  const wow = new WowClient();
  wow.exec(MAP);
  wow.login();
  wow.exec(SHARE);
  wow.exec(COMBAT);
  wow.exec('__asks = 0; local orig = __ns.war.askForHelp; __ns.war.askForHelp = function(z, k) __asks = __asks + 1; orig(z, k) end');
  return wow;
}

test('no addon file registers the combat log event (the game refuses it as the addon loads and blocks the addon)', () => {
  const fs = require('fs');
  const path = require('path');
  const { ADDON_DIR, readToc } = require('./wowsim');
  for (const f of readToc().files) {
    const src = fs.readFileSync(path.join(ADDON_DIR, f), 'utf8').replace(/--[^\n]*/g, '');
    assert.ok(!/COMBAT_LOG_EVENT/.test(src), `${f} must not use COMBAT_LOG_EVENT(_UNFILTERED)`);
    assert.ok(!/CombatLogGetCurrentEventInfo/.test(src), `${f} must not read the combat log`);
    // Never write into Blizzard's shared frames (taint gets the addon blocked): our own dialog and notice instead.
    assert.ok(!/StaticPopup_Show|StaticPopupDialogs|UIErrorsFrame|RaidNotice_AddMessage|RaidWarningFrame/.test(src), `${f} must not use Blizzard's popups or error/raid-warning frames`);
  }
  const wow = new WowClient();
  wow.login();
  assert.strictEqual(wow.eval('tostring(__ns.war.combatEvent)'), 'nil');
});

test('dying to players in the open world marks the spot and offers to call the guild', () => {
  const wow = client();
  wow.exec('__recap = { __OGRE, __ROGUE }');
  wow.fire('PLAYER_DEAD');
  assert.strictEqual(wow.eval('#WowGuildDB.war.marks'), '1');
  assert.strictEqual(wow.eval('WowGuildDB.war.marks[1].x .. "," .. WowGuildDB.war.marks[1].y .. "," .. WowGuildDB.war.marks[1].kind'), '452,381,d');
  assert.strictEqual(wow.eval('WowGuildDB.war.maps[1424]'), 'Hillsbrad Foothills');
  assert.strictEqual(wow.eval('__asks'), '1');
  // Our own dialog, never Blizzard's StaticPopup (that taints Release Spirit and gets the addon blocked).
  assert.strictEqual(wow.eval('tostring(StaticPopupDialogs and StaticPopupDialogs.WOWGUILD_CALL_HELP)'), 'nil');
  assert.strictEqual(wow.eval('tostring(WowGuildHelpPrompt:IsShown())'), 'true');
  wow.exec('WowGuildHelpPrompt.yes:GetScript("OnClick")()');
  assert.strictEqual(wow.eval('tostring(WowGuildHelpPrompt:IsShown())'), 'false');
  assert.strictEqual(wow.eval('__lastPut.type .. ":" .. __lastPut.fields.zone .. ":" .. __lastPut.fields.message'), 'ca:The Barrens:Died to players here. Help!', 'the zone the game says you are in');
  // A player's pet counts as the player.
  wow.exec('__recap = { __WOLF }');
  wow.fire('PLAYER_DEAD');
  assert.strictEqual(wow.eval('#WowGuildDB.war.marks'), '2');
  // No recap: flagged in a contested zone counts.
  wow.exec('__recap = nil');
  wow.fire('PLAYER_DEAD');
  assert.strictEqual(wow.eval('#WowGuildDB.war.marks'), '3');
  assert.strictEqual(wow.eval('__asks'), '3');
  // warHelp off: the mark, no dialog.
  wow.exec('WowGuildDB.options.warHelp = false; __recap = { __ROGUE }');
  wow.fire('PLAYER_DEAD');
  assert.strictEqual(wow.eval('__asks'), '3');
  assert.strictEqual(wow.eval('#WowGuildDB.war.marks'), '4');
  assert.strictEqual(wow.eval('__ns.debugError'), null);
});

test('dying to a mob, or unflagged, or in a sanctuary is no PvP death: no mark, no dialog', () => {
  const wow = client();
  wow.exec('__recap = { __OGRE }');
  wow.fire('PLAYER_DEAD');
  wow.exec('__recap = nil; __flagged = false');
  wow.fire('PLAYER_DEAD');
  wow.exec('__flagged = true; __pvp = "sanctuary"');
  wow.fire('PLAYER_DEAD');
  // A recap the game won't let us read (secret values) falls back to the flag and zone.
  wow.exec('__pvp = "friendly"; C_DeathRecap.GetRecapEvents = function() error("secret") end');
  wow.fire('PLAYER_DEAD');
  assert.strictEqual(wow.eval('WowGuildDB.war and #WowGuildDB.war.marks or 0'), '0');
  assert.strictEqual(wow.eval('__asks'), '0');
  assert.strictEqual(wow.eval('__ns.debugError'), null);
});

test('honorable kills are read with the game\'s own (translated) honor strings', () => {
  const wow = client();
  // Without the game's strings: the English text.
  wow.fire('CHAT_MSG_COMBAT_HONOR_GAIN', 'Sneaky dies, honorable kill Rank: Scout (Estimated Honor Points: 12)');
  wow.fire('CHAT_MSG_COMBAT_HONOR_GAIN', 'You have been awarded 50 honor points.');
  assert.strictEqual(wow.eval('#WowGuildDB.war.marks'), '1');
  assert.strictEqual(wow.eval('WowGuildDB.war.marks[1].kind'), 'k');
  // A German client.
  wow.exec(`COMBATLOG_HONORGAIN = "%s stirbt, ehrenhafter Sieg Rang: %s (Geschätzte Ehrenpunkte: %d)"
    COMBATLOG_HONORGAIN_NO_RANK = "%s stirbt, ehrenhafter Sieg (Geschätzte Ehrenpunkte: %d)"`);
  wow.fire('CHAT_MSG_COMBAT_HONOR_GAIN', 'Schleicher stirbt, ehrenhafter Sieg Rang: Späher (Geschätzte Ehrenpunkte: 12)');
  wow.fire('CHAT_MSG_COMBAT_HONOR_GAIN', 'Schleicher stirbt, ehrenhafter Sieg (Geschätzte Ehrenpunkte: 3)');
  wow.fire('CHAT_MSG_COMBAT_HONOR_GAIN', 'Ihr habt 50 Ehrenpunkte erhalten.');
  wow.fire('CHAT_MSG_COMBAT_HONOR_GAIN', 'Sneaky dies, honorable kill Rank: Scout (Estimated Honor Points: 12)');
  assert.strictEqual(wow.eval('#WowGuildDB.war.marks'), '3');
  // Positional format specifiers (%1$s) and magic characters in the string.
  wow.exec('COMBATLOG_HONORGAIN = "[%1$s] -- %2$s: %3$d+ honor?"; COMBATLOG_HONORGAIN_NO_RANK = nil');
  assert.strictEqual(wow.eval('tostring(__ns.war.isHonorKill("[Sneaky] -- Scout: 12+ honor?"))'), 'true');
  assert.strictEqual(wow.eval('tostring(__ns.war.isHonorKill("Sneaky -- Scout: 12 honor"))'), 'false');
  assert.strictEqual(wow.eval('__ns.debugError'), null);
});

test('no mark inside an instance or without a position', () => {
  const wow = client();
  wow.exec('__recap = { __ROGUE }; __inInstance = true; __instanceType = "pvp"');
  wow.fire('PLAYER_DEAD');
  wow.exec('__inInstance = false; __pos = { x = 0, y = 0 }');
  wow.fire('PLAYER_DEAD');
  assert.strictEqual(wow.eval('WowGuildDB.war and #WowGuildDB.war.marks or 0'), '0');
});

test('the "wm" record: newest 30 marks of the last 14 days, with map names', () => {
  const wow = client();
  wow.exec(`local t = GetServerTime()
    WowGuildDB.war = { maps = { [1424] = "Hillsbrad Foothills" }, marks = {} }
    for i = 1, 40 do table.insert(WowGuildDB.war.marks, { map = 1424, x = i, y = i, at = t - i * 60, kind = "d" }) end
    table.insert(WowGuildDB.war.marks, { map = 1440, x = 1, y = 1, at = t - 20 * 86400, kind = "k" })`);
  wow.exec('__rec = __ns.war.record("Thrallia.p4m7")');
  assert.strictEqual(wow.eval('__rec.type .. ":" .. __rec.key'), 'wm:Thrallia.p4m7');
  assert.strictEqual(wow.eval('#__rec.fields.marks'), '30');
  assert.strictEqual(wow.eval('__rec.fields.marks[1].x'), '1', 'newest first');
  assert.strictEqual(wow.eval('#__rec.fields.maps .. ":" .. __rec.fields.maps[1].name'), '1:Hillsbrad Foothills');
  // It's part of what the addon offers to the sharing engine.
  wow.exec('__found = false for _, r in ipairs(__ns.Collect.sharedRecords()) do if r.type == "wm" then __found = true end end');
  assert.strictEqual(wow.eval('tostring(__found)'), 'true');
  assert.strictEqual(wow.eval('tostring(__ns.war.record(nil))'), 'nil');
});

test("the world map shows the guild's marks of the last week for the map on screen", () => {
  const wow = new WowClient();
  wow.exec(MAP);
  wow.exec(`WorldMapFrame = CreateFrame("Frame", "WorldMapFrame", UIParent)
    WorldMapFrame:SetSize(1000, 667)
    WorldMapFrame.canvas = CreateFrame("Frame", nil, WorldMapFrame)
    WorldMapFrame.canvas:SetSize(1000, 667)
    function WorldMapFrame:GetCanvas() return self.canvas end
    function WorldMapFrame:GetMapID() return 1424 end
    WorldMapFrame.HookScript = function() end`);
  wow.login();
  wow.exec(SHARE);
  wow.exec(`local t = GetServerTime()
    __wm = {
      { author = "Grommash", fields = { marks = { { map = 1424, x = 500, y = 500, at = t - 60, kind = "d" }, { map = 1440, x = 1, y = 1, at = t - 60, kind = "k" } } } },
      { author = "Jaina", fields = { marks = { { map = 1424, x = 100, y = 200, at = t - 3600, kind = "k" }, { map = 1424, x = 9, y = 9, at = t - 9 * 86400, kind = "d" } } } },
    }
    WorldMapFrame.canvas.GetWidth = function() return 1000 end
    WorldMapFrame.canvas.GetHeight = function() return 667 end
    WorldMapFrame:Show()`);
  assert.strictEqual(wow.eval('#__ns.war.marksFor(1424)'), '2');
  assert.strictEqual(wow.eval('__ns.war.marksFor(1424)[1].who'), 'Grommash');
  assert.strictEqual(wow.eval('__ns.war.refreshPins()'), '2');
  wow.slash('war off');
  assert.strictEqual(wow.eval('__ns.war.refreshPins()'), '0');
  assert.match(wow.printed(), /War map off/);
  wow.slash('war');
  assert.match(wow.printed(), /War map: you have 0 deaths and 0 kills/);
  assert.strictEqual(wow.eval('__ns.debugError'), null);
});
