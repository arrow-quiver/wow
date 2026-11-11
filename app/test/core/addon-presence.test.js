'use strict';
// Presence.lua: what the guild is doing right now, on its own addon message prefix. Positions (opt-in), answers to
// a call to arms, and who killed whom; and the War pages built on them (Guild map, Nemeses, Call to arms).
const test = require('node:test');
const assert = require('node:assert');
const { WowClient } = require('./wowsim');

const PREFIX = 'GuildCampNow';
const noError = (wow) => assert.strictEqual(wow.eval('__ns.debugError'), null, 'no addon errors');
const txt = (wow, expr) => wow.eval(`tostring(${expr}:GetText())`);
const shown = (wow, expr) => wow.eval(`tostring(${expr}:IsShown())`);
const sentNow = (wow, from = 0) => wow.sentMessages.slice(from).filter((m) => m.prefix === PREFIX).map((m) => m.text);

const WORLD = `__pos = { x = 0.5, y = 0.25 }
C_Map = C_Map or {}
C_Map.GetBestMapForUnit = function() return 1424 end
C_Map.GetPlayerMapPosition = function() return { GetXY = function() return __pos.x, __pos.y end } end
C_Map.GetMapInfo = function(id) return { name = id == 1424 and "Hillsbrad Foothills" or "Elsewhere" } end
GetZoneText = function() return "Hillsbrad Foothills" end
GetRealZoneText = GetZoneText`;

function client() {
  const wow = new WowClient();
  wow.login();
  wow.exec(WORLD);
  wow.clearOutput();
  return wow;
}

test('positions: nothing is shared until I turn it on; then when I move, and "gone" when I turn it off', () => {
  const wow = client();
  assert.ok(wow.prefixes.has(PREFIX), 'the prefix is registered at login');
  assert.strictEqual(wow.eval('tostring(__ns.opt("shareLocation"))'), 'false', 'off by default');
  let from = wow.sentMessages.length;
  assert.strictEqual(wow.eval('tostring(__ns.presence.tick())'), 'false');
  assert.deepStrictEqual(sentNow(wow, from), []);
  // On: my position goes out at once.
  wow.exec('__ns.presence.share(true)');
  assert.deepStrictEqual(sentNow(wow, from), ['P|1424|500|250|Hillsbrad Foothills']);
  // Standing still: nothing more yet.
  from = wow.sentMessages.length;
  assert.strictEqual(wow.eval('tostring(__ns.presence.tick())'), 'false');
  // Moved, but too soon after the last one.
  wow.exec('__pos.x = 0.6');
  assert.strictEqual(wow.eval('tostring(__ns.presence.tick())'), 'false');
  // Moved and the time is up.
  wow.exec('local t = GetServerTime(); GetServerTime = function() return t + 25 end; local g = GetTime and GetTime() or 0; GetTime = function() return g + 25 end');
  assert.strictEqual(wow.eval('tostring(__ns.presence.tick())'), 'true');
  assert.deepStrictEqual(sentNow(wow, from), ['P|1424|600|250|Hillsbrad Foothills']);
  // Inside an instance nothing goes out.
  from = wow.sentMessages.length;
  wow.exec('__pos.x = 0.7; local t = GetServerTime(); GetServerTime = function() return t + 60 end; local g = GetTime(); GetTime = function() return g + 60 end; function IsInInstance() return true, "party" end');
  assert.strictEqual(wow.eval('tostring(__ns.presence.tick())'), 'false');
  assert.deepStrictEqual(sentNow(wow, from), []);
  // Off: the guild is told, and I'm off my own list.
  wow.exec('function IsInInstance() return false end; __ns.presence.share(false)');
  assert.deepStrictEqual(sentNow(wow, from), ['P|0']);
  assert.strictEqual(wow.eval('#__ns.presence.list()'), '0');
  noError(wow);
});

test('hearing guildies: positions, who left, stale ones, and messages that are not what they should be', () => {
  const wow = client();
  wow.receive(PREFIX, 'P|1424|100|200|Hillsbrad Foothills', 'GUILD', 'Mokra-Zuljin');
  wow.receive(PREFIX, 'P|1413|900|900|The Barrens', 'GUILD', 'Zed');
  assert.deepStrictEqual(wow.get('(function() local t = {} for _, z in ipairs(__ns.presence.byZone()) do t[#t + 1] = z.zone .. ":" .. table.concat(z.names, ",") end table.sort(t) return t end)()'),
    ['Hillsbrad Foothills:Mokra', 'The Barrens:Zed']);
  // Not from the guild channel, my own echo, a bad map, coordinates off the map, a name with a link in it: ignored.
  wow.receive(PREFIX, 'P|1424|1|1|X', 'PARTY', 'Sneaky');
  wow.receive(PREFIX, 'P|1424|1|1|X', 'GUILD', 'Thrallia');
  wow.receive(PREFIX, 'P|0|1|1|X', 'GUILD', 'Nomap');
  wow.receive(PREFIX, 'P|1424|5000|1|X', 'GUILD', 'Faraway');
  wow.receive(PREFIX, 'P|1424|1|1|X', 'GUILD', '|cffff0000Bad|r');
  wow.receive(PREFIX, 'Q|whatever', 'GUILD', 'Odd');
  assert.strictEqual(wow.eval('#__ns.presence.list()'), '2');
  // A zone name can't carry colour codes into my window.
  wow.receive(PREFIX, 'P|1424|10|10|Hills|cffff0000brad', 'GUILD', 'Zed');
  assert.strictEqual(wow.eval('__ns.presence.where.Zed.zone'), 'Hillscffff0000brad');
  // Gone, and stale after five minutes.
  wow.receive(PREFIX, 'P|0', 'GUILD', 'Zed');
  assert.strictEqual(wow.eval('#__ns.presence.list()'), '1');
  wow.exec('local t = GetServerTime(); GetServerTime = function() return t + 400 end');
  assert.strictEqual(wow.eval('#__ns.presence.list()'), '0');
  // A flood from one sender is cut off.
  for (let i = 0; i < 60; i += 1) wow.receive(PREFIX, `P|1424|${i}|1|X`, 'GUILD', 'Spammer');
  assert.strictEqual(wow.eval('__ns.presence.where.Spammer.x'), '39', 'the 41st and later are ignored');
  noError(wow);
});

test('guildies who share are drawn on the world map, on the map on screen only', () => {
  const wow = client();
  wow.exec(`WorldMapFrame = CreateFrame("Frame", "WorldMapFrame", UIParent)
    WorldMapFrame.canvas = CreateFrame("Frame", nil, WorldMapFrame)
    function WorldMapFrame.canvas:GetWidth() return 1000 end
    function WorldMapFrame.canvas:GetHeight() return 600 end
    function WorldMapFrame:GetCanvas() return self.canvas end
    function WorldMapFrame:GetMapID() return 1424 end
    __ns.presence.attach(); WorldMapFrame:Show()`);
  wow.receive(PREFIX, 'P|1424|100|200|Hillsbrad Foothills', 'GUILD', 'Mokra');
  wow.receive(PREFIX, 'P|1413|900|900|The Barrens', 'GUILD', 'Zed');
  assert.strictEqual(wow.eval('__ns.presence.refreshPins()'), '1', 'only Mokra is on this map');
  wow.receive(PREFIX, 'P|0', 'GUILD', 'Mokra');
  assert.strictEqual(wow.eval('__ns.presence.refreshPins()'), '0');
  noError(wow);
});

test('Guild map page: who is online and where, my zone first with "Group up?", and the sharing switch', () => {
  const wow = client();
  wow.exec(`__whispers = {}
    C_ChatInfo.SendChatMessage = function(text, kind, _, to) table.insert(__whispers, kind .. ">" .. tostring(to)) end
    SendChatMessage = C_ChatInfo.SendChatMessage
    local roster = { { "Zed-Zuljin", "Pup", 3, 30, "Rogue", "The Barrens", "", "", true }, { "Mokra-Zuljin", "Pup", 3, 24, "Shaman", "Hillsbrad Foothills", "", "", true },
      { "Offline-Zuljin", "Pup", 3, 60, "Mage", "Orgrimmar", "", "", false }, { "Abe-Zuljin", "Pup", 3, 12, "Hunter", "The Barrens", "", "", true } }
    function GetNumGuildMembers() return #roster end
    function GetGuildRosterInfo(i) return unpack(roster[i]) end`);
  wow.receive(PREFIX, 'P|1413|412|288|The Barrens', 'GUILD', 'Zed');
  wow.exec('__ns.ui.show("where")');
  const p = 'WowGuildWindow.pages.where';
  assert.ok(wow.texts().includes('3 online  |cff9999991 on the world map|r'));
  assert.deepStrictEqual([1, 2, 3].map((i) => wow.eval(`${p}.rows[${i}].who`)), ['Mokra', 'Abe', 'Zed'], 'my zone, then the busiest zone by name');
  assert.strictEqual(shown(wow, `${p}.rows[1].btn`), 'true');
  assert.strictEqual(shown(wow, `${p}.rows[2].btn`), 'false', 'no "Group up?" for another zone');
  assert.strictEqual(txt(wow, `${p}.rows[3].zone`), 'The Barrens  |cff4dbfff41, 29 on the map|r');
  assert.strictEqual(shown(wow, `${p}.rows[4]`), 'false', 'the offline one is not listed');
  wow.click(`${p}.rows[1].btn`);
  assert.deepStrictEqual(wow.get('__whispers'), ['WHISPER>Mokra']);
  // The switch.
  assert.strictEqual(txt(wow, `${p}.share`), 'Share my position: off');
  const from = wow.sentMessages.length;
  wow.click(`${p}.share`);
  assert.strictEqual(txt(wow, `${p}.share`), 'Sharing my position: on');
  assert.deepStrictEqual(sentNow(wow, from), ['P|1424|500|250|Hillsbrad Foothills']);
  wow.click(`${p}.share`);
  assert.strictEqual(wow.eval('tostring(__ns.opt("shareLocation"))'), 'false');
  noError(wow);
});

test('rally: answers to a call are heard live; the caller is told and can invite who is coming', () => {
  const wow = client();
  wow.exec(`__invited = {}
    C_PartyInfo = C_PartyInfo or {}
    C_PartyInfo.InviteUnit = function(n) table.insert(__invited, n) end
    function UnitInParty(n) return n == "Zed" end
    __ns.ctaRecent = { { zone = "Hillsbrad Foothills", at = time() - 30, mine = true, character = "Thrallia" } }`);
  // An old answer (to an earlier call of mine) doesn't count for this one.
  wow.exec('__ns.presence.answers.Thrallia = { Oldie = time() - 600 }');
  wow.receive(PREFIX, 'R|Thrallia', 'GUILD', 'Mokra');
  wow.receive(PREFIX, 'R|Thrallia', 'GUILD', 'Zed');
  wow.receive(PREFIX, 'R|Someoneelse', 'GUILD', 'Abe');
  assert.match(wow.printed(), /Mokra is on the way to your call to arms/);
  assert.ok(!/Abe is on the way/.test(wow.printed()));
  assert.deepStrictEqual(wow.get('__ns.presence.coming("Thrallia", time() - 30)'), ['Mokra', 'Zed']);
  wow.exec('__ns.ui.show("cta")');
  const row = 'WowGuildWindow.pages.cta.calls[1]';
  assert.match(txt(wow, `${row}.text`), /Coming: Mokra, Zed/);
  assert.strictEqual(txt(wow, `${row}.btn`), 'Invite them');
  wow.click(`${row}.btn`);
  assert.deepStrictEqual(wow.get('__invited'), ['Mokra'], 'Zed is in my group already');
  noError(wow);
});

test('rally: the fight since the call, from the guild\'s war marks in that zone', () => {
  const wow = client();
  wow.exec(`local t = GetServerTime()
    __ns.Share = __ns.Share or {}
    __ns.Share.list = function(ty) if ty ~= "wm" then return {} end return {
      { type = "wm", key = "a", author = "Mokra", fields = { maps = { { id = 1424, name = "Hillsbrad Foothills" }, { id = 9, name = "Elsewhere" } }, marks = {
        { map = 1424, x = 1, y = 1, at = t - 10, kind = "k" }, { map = 1424, x = 1, y = 1, at = t - 20, kind = "k" }, { map = 1424, x = 1, y = 1, at = t - 25, kind = "d" },
        { map = 1424, x = 1, y = 1, at = t - 500, kind = "k" }, { map = 9, x = 1, y = 1, at = t - 5, kind = "k" } } } } } end
    __ns.ctaRecent = { { zone = "Hillsbrad Foothills", at = t - 60, character = "Mokra" } }`);
  assert.deepStrictEqual(wow.get('{ __ns.war.since("hillsbrad foothills", GetServerTime() - 60) }'), [2, 1]);
  wow.exec('__ns.ui.show("cta")');
  assert.match(txt(wow, 'WowGuildWindow.pages.cta.calls[1].text'), /since: 2 kills, 1 death/);
  noError(wow);
});

test('nemeses: deaths and kills are counted from me and from guildies; revenge is called out', () => {
  const wow = client();
  let from = wow.sentMessages.length;
  // Gankalot kills me twice, and Mokra once.
  wow.exec('__ns.presence.died("Gankalot"); __ns.presence.died("Gankalot-Realm")');
  assert.deepStrictEqual(sentNow(wow, from), ['D|Gankalot', 'D|Gankalot']);
  wow.receive(PREFIX, 'D|Gankalot', 'GUILD', 'Mokra');
  wow.receive(PREFIX, 'D|Stabby', 'GUILD', 'Mokra');
  wow.receive(PREFIX, 'K|Stabby', 'GUILD', 'Zed');
  wow.receive(PREFIX, 'D|not a name!', 'GUILD', 'Mokra');
  assert.deepStrictEqual(wow.get('__ns.presence.nemeses()').map((n) => [n.name, n.deaths, n.kills, n.worst, n.mine]),
    [['Gankalot', 3, 0, 'Thrallia', 2], ['Stabby', 1, 1, 'Mokra', 0]]);
  // I get Gankalot: revenge. Stabby never killed me: a kill, no fanfare.
  wow.clearOutput();
  from = wow.sentMessages.length;
  wow.exec('__ns.presence.killed("Gankalot")');
  assert.match(wow.printed(), /Revenge! Gankalot killed you 2 times\. That's one back\./);
  wow.clearOutput();
  wow.exec('__ns.presence.killed("Stabby")');
  assert.strictEqual(wow.printed(), '');
  assert.deepStrictEqual(sentNow(wow, from), ['K|Gankalot', 'K|Stabby']);
  // It lasts across a reload (SavedVariables), and drops after sixty days.
  assert.strictEqual(wow.db().nemesis.Gankalot.deaths, 3);
  wow.exec('local t = GetServerTime(); GetServerTime = function() return t + 61 * 86400 end');
  assert.strictEqual(wow.eval('#__ns.presence.nemeses()'), '0');
  noError(wow);
});

test('Nemeses page: the list, and one click to put a repeat killer on kill on sight', () => {
  const wow = client();
  wow.exec(`__recs = {}
    __ns.Share = __ns.Share or {}
    __ns.Share.myPid = function() return "Thrallia.p4m7" end
    __ns.Share.list = function(ty) local out = {} for _, r in ipairs(__recs) do if r.type == ty then out[#out + 1] = r end end return out end
    __ns.Share.putLocal = function(ty, key, f) table.insert(__recs, { type = ty, key = key, fields = f, author = "Thrallia", t = GetServerTime() }) return {} end`);
  wow.receive(PREFIX, 'D|Gankalot', 'GUILD', 'Mokra');
  wow.receive(PREFIX, 'D|Gankalot', 'GUILD', 'Mokra');
  wow.receive(PREFIX, 'D|Gankalot', 'GUILD', 'Zed');
  wow.receive(PREFIX, 'K|Gankalot', 'GUILD', 'Zed');
  wow.clearOutput();
  wow.exec('__ns.ui.show("nemesis")');
  const p = 'WowGuildWindow.pages.nemesis';
  assert.ok(wow.texts().includes('1 player who killed guildies in the last 60 days'));
  assert.strictEqual(txt(wow, `${p}.rows[1].name`), 'Gankalot');
  assert.match(txt(wow, `${p}.rows[1].what`), /^killed guildies 3 times \(Mokra most\) {2}\|cff40bf40we got them 1 time\|r {2}\|cff999999last /);
  assert.strictEqual(shown(wow, `${p}.rows[1].btn`), 'true');
  wow.click(`${p}.rows[1].btn`);
  assert.match(txt(wow, `${p}.status`), /Gankalot is now kill on sight for the guild/);
  assert.strictEqual(wow.eval('__ns.hunt.onList("Gankalot").reason'), 'Killed guildies 3 times');
  assert.strictEqual(shown(wow, `${p}.rows[1].btn`), 'false', 'already on the list: no button');
  assert.strictEqual(wow.printed(), '');
  noError(wow);
});
