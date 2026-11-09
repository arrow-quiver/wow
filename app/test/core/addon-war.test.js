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

function client() {
  const wow = new WowClient();
  wow.exec(MAP);
  wow.login();
  wow.exec(SHARE);
  return wow;
}

test('dying in the open world marks the spot and, in a PvP area, offers to call the guild', () => {
  const wow = client();
  const before = Number(wow.eval('__popups'));
  wow.fire('PLAYER_DEAD');
  assert.strictEqual(wow.eval('#WowGuildDB.war.marks'), '1');
  assert.strictEqual(wow.eval('WowGuildDB.war.marks[1].x .. "," .. WowGuildDB.war.marks[1].y .. "," .. WowGuildDB.war.marks[1].kind'), '452,381,d');
  assert.strictEqual(wow.eval('WowGuildDB.war.maps[1424]'), 'Hillsbrad Foothills');
  assert.strictEqual(Number(wow.eval('__popups')), before + 1);
  // Accepting the popup sends a call to arms with the zone.
  wow.exec('StaticPopupDialogs.WOWGUILD_CALL_HELP.OnAccept(nil, { zone = "Hillsbrad Foothills" })');
  assert.strictEqual(wow.eval('__lastPut.type .. ":" .. __lastPut.fields.zone .. ":" .. __lastPut.fields.message'), 'ca:Hillsbrad Foothills:Died to players here. Help!');
  // Sanctuary: a mark, no popup. warHelp off: no popup either.
  wow.exec('__pvp = "sanctuary"');
  wow.fire('PLAYER_DEAD');
  assert.strictEqual(Number(wow.eval('__popups')), before + 1);
  wow.exec('__pvp = "hostile"; WowGuildDB.options.warHelp = false');
  wow.fire('PLAYER_DEAD');
  assert.strictEqual(Number(wow.eval('__popups')), before + 1);
  assert.strictEqual(wow.eval('#WowGuildDB.war.marks'), '3');
  // An honorable kill marks a kill; other honor lines don't.
  wow.fire('CHAT_MSG_COMBAT_HONOR_GAIN', 'Sneaky dies, honorable kill Rank: Scout (Estimated Honor Points: 12)');
  wow.fire('CHAT_MSG_COMBAT_HONOR_GAIN', 'You have been awarded 50 honor points.');
  assert.strictEqual(wow.eval('WowGuildDB.war.marks[1].kind'), 'k');
  assert.strictEqual(wow.eval('#WowGuildDB.war.marks'), '4');
  assert.strictEqual(wow.eval('__ns.debugError'), null);
});

test('no mark inside an instance or without a position', () => {
  const wow = client();
  wow.exec('__inInstance = true; __instanceType = "pvp"');
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
    WowGuildWarPins.GetWidth = function() return 1000 end
    WowGuildWarPins.GetHeight = function() return 667 end
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
