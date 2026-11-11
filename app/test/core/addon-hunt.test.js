'use strict';
// Hunt.lua: the kill-on-sight list and bounties in game: alerts, tooltips, kills that count, adding and removing,
// and "Kill on sight" for whoever killed me.
const test = require('node:test');
const assert = require('node:assert');
const { WowClient } = require('./wowsim');

const SHARE = `__recs = {}
__ns.Share = __ns.Share or {}
__ns.Share.myPid = function() return "Thrallia.p4m7" end
__ns.Share.list = function(ty) local out = {} for _, r in ipairs(__recs) do if r.type == ty then out[#out + 1] = r end end return out end
__ns.Share.putLocal = function(ty, key, f)
  for i, r in ipairs(__recs) do if r.type == ty and r.key == key then table.remove(__recs, i) break end end
  table.insert(__recs, { type = ty, key = key, fields = f, author = "Thrallia", t = GetServerTime() }) return {}
end
local t = GetServerTime()
table.insert(__recs, { type = "ko", key = "Gankalot", author = "Mokra", t = t - 100, fields = { pid = "Mokra.m1", reason = "Camps the Crossroads", state = "o" } })
table.insert(__recs, { type = "ko", key = "Gone", author = "Mokra", t = t - 90, fields = { pid = "Mokra.m1", reason = "", state = "x" } })
table.insert(__recs, { type = "BT", key = "b2b2b2", author = "Thrallia", t = t - 80, fields = { target = "Stabby", zone = "", points = 50, cap = 1, ends = t + 86400, note = "", state = "o" } })
table.insert(__recs, { type = "BT", key = "z3z3z3", author = "Thrallia", t = t - 70, fields = { target = "", zone = "Hillsbrad Foothills", points = 5, cap = 10, ends = t + 86400, note = "", state = "o" } })
table.insert(__recs, { type = "BT", key = "old111", author = "Thrallia", t = t - 60, fields = { target = "Oldie", zone = "", points = 9, cap = 1, ends = t - 10, note = "", state = "o" } })
__units = { nameplate1 = { name = "Gankalot", level = 30, class = "Rogue" }, nameplate2 = { name = "Stabby", level = 28, class = "Warrior" }, nameplate3 = { name = "Friendly", level = 20, class = "Mage" } }
UnitIsPlayer = function(u) return __units[u] ~= nil or u == "player" end
UnitIsEnemy = function(a, u) return __units[u] ~= nil and __units[u].name ~= "Friendly" end
local origName = UnitName
UnitName = function(u) if __units[u] then return __units[u].name end return origName(u) end
UnitLevel = function(u) return __units[u] and __units[u].level or 25 end
UnitClass = function(u) return __units[u] and __units[u].class or "Shaman" end
GetRealZoneText = function() return "Hillsbrad Foothills" end`;

function client() {
  const wow = new WowClient();
  wow.login();
  wow.exec(SHARE);
  return wow;
}

test('the lists: kill on sight (taken-off ones gone) and open bounties (expired gone)', () => {
  const wow = client();
  assert.strictEqual(wow.eval('#__ns.hunt.kos()'), '1');
  assert.strictEqual(wow.eval('__ns.hunt.onList("gankalot").name'), 'Gankalot');
  assert.strictEqual(wow.eval('__ns.hunt.onList("Gone")'), null);
  assert.strictEqual(wow.eval('#__ns.hunt.bounties()'), '2');
  assert.strictEqual(wow.eval('__ns.hunt.bountyOn("Stabby").points'), '50');
  assert.strictEqual(wow.eval('__ns.hunt.bountyOn("Oldie")'), null);
  assert.strictEqual(wow.eval('__ns.hunt.zoneBounty("Hillsbrad Foothills").key'), 'z3z3z3');
  assert.strictEqual(wow.eval('__ns.hunt.slash("")'), '1');
  assert.strictEqual(wow.eval('__ns.hunt.slashBounties()'), '2');
  assert.match(wow.printed(), /50 points: kill Stabby/);
  assert.match(wow.printed(), /5 points: each kill in Hillsbrad Foothills, up to 10 kills/);
  assert.strictEqual(wow.eval('__ns.debugError'), null);
});

test('spotting them: a warning and a sound once every 2 minutes; enemies only; option off', () => {
  const wow = client();
  wow.fire('NAME_PLATE_UNIT_ADDED', 'nameplate1');
  assert.strictEqual(wow.eval('WowGuildNotice.text:GetText()'), 'KILL ON SIGHT: Gankalot 30 Rogue is near!');
  assert.match(wow.printed(), /KILL ON SIGHT: Gankalot 30 Rogue is near!.*\(Camps the Crossroads\)/);
  assert.ok(wow.sounds.length >= 1);
  assert.strictEqual(wow.eval('__ns.hunt.check("nameplate1")'), null, 'not again so soon');
  assert.strictEqual(wow.eval('__ns.hunt.check("nameplate2")'), 'BOUNTY: Stabby 28 Warrior is near! 50 points.');
  assert.strictEqual(wow.eval('__ns.hunt.check("nameplate3")'), null);
  wow.exec('__ns.hunt.resetAlerts(); WowGuildDB.options.kosAlerts = false');
  assert.strictEqual(wow.eval('__ns.hunt.check("nameplate1")'), null);
  // Tooltip lines.
  assert.strictEqual(wow.eval('table.concat(__ns.hunt.tooltipLines("Gankalot"), "|")'), '|cffff4040Kill on sight: Camps the Crossroads|r');
  assert.strictEqual(wow.eval('table.concat(__ns.hunt.tooltipLines("Stabby"), "|")'), '|cffe8a33dBounty: 50 points|r');
  assert.strictEqual(wow.eval('__ns.debugError'), null);
});

test('my honorable kills: kill on sight, a bounty, a zone bounty; anyone else not recorded', () => {
  const wow = client();
  const before = Number(wow.eval('#__recs'));
  wow.fire('CHAT_MSG_COMBAT_HONOR_GAIN', 'Gankalot dies, honorable kill Rank: Scout (Estimated Honor Points: 12)');
  wow.exec('__kk = {} for _, r in ipairs(__recs) do if r.type == "kk" then table.insert(__kk, r) end end');
  assert.strictEqual(wow.eval('#__kk'), '1');
  assert.strictEqual(wow.eval('__kk[1].fields.target'), 'Gankalot');
  assert.strictEqual(wow.eval('__kk[1].fields.kos'), '1');
  // Gankalot was killed in a zone with a zone bounty: it counts for that too.
  assert.strictEqual(wow.eval('__kk[1].fields.bounty'), 'z3z3z3');
  assert.match(wow.printed(), /Gankalot slain, zone bounty: \+13 season points\./);
  assert.strictEqual(wow.eval('__ns.hunt.killed("Stabby dies, honorable kill Rank: Grunt (Estimated Honor Points: 9)").bounty'), 'b2b2b2');
  // Claimed now: no longer an open bounty, no alert, no promise of points.
  assert.strictEqual(wow.eval('__ns.hunt.bountyOn("Stabby")'), null);
  wow.exec('GetRealZoneText = function() return "Ashenvale" end');
  assert.strictEqual(wow.eval('__ns.hunt.killed("Randomguy dies, honorable kill Rank: Scout (Estimated Honor Points: 5)")'), null);
  assert.strictEqual(Number(wow.eval('#__recs')), before + 2);
  // Translated strings: the victim comes from the game's own format.
  wow.exec('COMBATLOG_HONORGAIN = "[%1$s] -- %2$s: %3$d+ honor?"; COMBATLOG_HONORGAIN_NO_RANK = nil');
  assert.strictEqual(wow.eval('__ns.hunt.victimOf("[gankalot] -- Scout: 12+ honor?")'), 'Gankalot');
  assert.strictEqual(wow.eval('__ns.debugError'), null);
});

test('adding and taking off; "Kill on sight" for whoever killed me', () => {
  const wow = client();
  wow.slash('kos add sneaky Ganks at the flight path');
  assert.strictEqual(wow.eval('__ns.hunt.onList("Sneaky").reason'), 'Ganks at the flight path');
  wow.slash('kos remove Sneaky');
  assert.strictEqual(wow.eval('__ns.hunt.onList("Sneaky")'), null);
  // Killed by Sneaky: the prompt offers kill on sight.
  wow.exec(`UnitIsPVP = function() return true end
C_DeathRecap = { GetRecapEvents = function() return { { sourceGUID = "Player-4395-0F0F0F0F", sourceName = "Sneaky-Thunderfury" } } end }
C_Map = C_Map or {}
C_Map.GetBestMapForUnit = function() return 1424 end
C_Map.GetPlayerMapPosition = function() return { GetXY = function() return 0.4, 0.4 end } end`);
  assert.strictEqual(wow.eval('__ns.war.killerName()'), 'Sneaky');
  wow.fire('PLAYER_DEAD');
  assert.strictEqual(wow.eval('WowGuildHelpPrompt.kos:GetText()'), 'Kill on sight: Sneaky');
  wow.click('WowGuildHelpPrompt.kos');
  assert.match(wow.eval('__ns.hunt.onList("Sneaky").reason'), /^Killed Thrallia in /);
  assert.strictEqual(wow.eval('__ns.debugError'), null);
});

// ---------------------------------------------------------------- the War section of the guild window

const hunt = 'WowGuildWindow.pages.hunt';
const noError = (wow) => assert.strictEqual(wow.eval('__ns.debugError'), null, 'no addon errors');

test('The hunt page: the list with who added it, take off, add by name and from my target, bounties', () => {
  const wow = client();
  wow.exec('__ns.ui.show("hunt")');
  assert.ok(wow.texts().includes('Kill on sight  |cff9999991 on the list · 8 season points a kill|r'));
  assert.strictEqual(wow.eval(`${hunt}.kos[1].name:GetText()`), 'Gankalot');
  assert.strictEqual(wow.eval(`${hunt}.kos[1].why:GetText()`), 'Camps the Crossroads|cff999999 · added by Mokra|r');
  assert.strictEqual(wow.eval(`tostring(${hunt}.kos[2]:IsShown())`), 'false');
  // Bounties: the richest first, with what to do and the time left.
  assert.strictEqual(wow.eval(`${hunt}.bounties[1].points:GetText()`), '50 points');
  assert.strictEqual(wow.eval(`${hunt}.bounties[1].what:GetText()`), 'Kill Stabby');
  assert.strictEqual(wow.eval(`${hunt}.bounties[2].what:GetText()`), 'Each kill in Hillsbrad Foothills, up to 10');
  assert.match(wow.eval(`${hunt}.bounties[1].left:GetText()`), /^(23|24)h left$/);
  assert.strictEqual(wow.eval(`tostring(${hunt}.bounties[3]:IsShown())`), 'false', 'the expired one is gone');

  // Add by name: the answer shows on the page, not in chat.
  wow.clearOutput();
  wow.exec(`${hunt}.name:SetText("campy"); ${hunt}.why:SetText("Ganks lowbies")`);
  wow.click(`${hunt}.add`);
  assert.strictEqual(wow.printed(), '');
  assert.match(wow.eval(`${hunt}.status:GetText()`), /Campy is now kill on sight for the guild/);
  assert.strictEqual(wow.eval('#__ns.hunt.kos()'), '2');
  assert.strictEqual(wow.eval(`${hunt}.name:GetText()`), '', 'the boxes are cleared');
  // An empty name does nothing.
  wow.click(`${hunt}.add`);
  assert.strictEqual(wow.eval(`${hunt}.status:GetText()`), "Type the player's name first.");
  assert.strictEqual(wow.eval('#__ns.hunt.kos()'), '2');

  // From my target: enemy players only.
  wow.click(`${hunt}.target`);
  assert.strictEqual(wow.eval(`${hunt}.status:GetText()`), 'Target an enemy player first.');
  wow.exec('__units.target = { name = "Friendly", level = 20, class = "Mage" }');
  wow.click(`${hunt}.target`);
  assert.strictEqual(wow.eval(`${hunt}.status:GetText()`), 'Target an enemy player first.');
  wow.exec('__units.target = { name = "Stabby", level = 28, class = "Warrior" }; GetZoneText = function() return "Ashenvale" end');
  wow.click(`${hunt}.target`);
  assert.strictEqual(wow.eval('__ns.hunt.onList("Stabby").reason'), 'Seen in Ashenvale');
  assert.strictEqual(wow.eval('#__ns.hunt.kos()'), '3');

  // Take off: the row's own button.
  const rowOf = (name) => [1, 2, 3].find((i) => wow.eval(`tostring(${hunt}.kos[${i}].who)`) === name);
  wow.click(`${hunt}.kos[${rowOf('Gankalot')}].btn`);
  assert.match(wow.eval(`${hunt}.status:GetText()`), /Gankalot is off the list/);
  assert.strictEqual(wow.eval('tostring((__ns.hunt.onList("Gankalot")))'), 'nil');
  assert.strictEqual(wow.eval('#__ns.hunt.kos()'), '2');
  noError(wow);
});

test('Call to arms page: a guildmate\'s call has "On my way", one whisper, once', () => {
  const wow = client();
  wow.exec(`__whispers = {}
    C_ChatInfo = C_ChatInfo or {}
    C_ChatInfo.SendChatMessage = function(text, kind, _, to) table.insert(__whispers, kind .. ">" .. tostring(to) .. ">" .. text) end
    __ns.ctaRecent = { { zone = "Ashenvale", needed = 5, message = "Zoram Strand", character = "Mokra", at = time() - 60 }, { zone = "Barrens", at = time() - 30, mine = true, character = "Thrallia" } }
    __ns.ui.show("cta")`);
  const calls = 'WowGuildWindow.pages.cta.calls';
  // Newest first: mine (no button), then Mokra's.
  assert.match(wow.eval(`${calls}[1].text:GetText()`), /^Barrens \|cff999999you, /);
  assert.strictEqual(wow.eval(`tostring(${calls}[1].btn:IsShown())`), 'false');
  assert.match(wow.eval(`${calls}[2].text:GetText()`), /^Ashenvale \(need 5\): Zoram Strand \|cff999999Mokra, /);
  assert.strictEqual(wow.eval(`tostring(${calls}[2].btn:IsShown())`), 'true');
  assert.strictEqual(wow.eval('#__whispers'), '0', 'nothing is sent by opening the page');
  wow.click(`${calls}[2].btn`);
  assert.deepStrictEqual(wow.get('__whispers'), ['WHISPER>Mokra>On my way to Ashenvale!']);
  assert.strictEqual(wow.eval(`tostring(${calls}[2].btn:IsShown())`), 'false', 'answered: the button goes');
  assert.strictEqual(wow.eval(`tostring(${calls}[3]:IsShown())`), 'false');
  noError(wow);
});

test('War report page: the guild\'s week by zone, and the map marks switch', () => {
  const wow = client();
  wow.exec(`local t = GetServerTime()
    table.insert(__recs, { type = "wm", key = "Mokra.m1", author = "Mokra", t = t, fields = { maps = { { id = 10, name = "The Barrens" }, { id = 63, name = "Ashenvale" } }, marks = {
      { map = 10, x = 500, y = 500, at = t - 3600, kind = "d" }, { map = 10, x = 510, y = 500, at = t - 7200, kind = "k" }, { map = 10, x = 520, y = 500, at = t - 100, kind = "k" },
      { map = 63, x = 100, y = 100, at = t - 86400, kind = "d" }, { map = 63, x = 100, y = 100, at = t - 9 * 86400, kind = "d" } } } })
    table.insert(__recs, { type = "wm", key = "Zed.z1", author = "Zed", t = t, fields = { maps = {}, marks = { { map = 10, x = 1, y = 1, at = t - 50, kind = "d" } } } })`);
  const s = wow.get('__ns.war.summary()');
  assert.deepStrictEqual([s.deaths, s.kills], [3, 2], 'the nine-day-old death is out');
  assert.deepStrictEqual(s.zones.map((z) => [z.name, z.kills, z.deaths]), [['The Barrens', 2, 2], ['Ashenvale', 0, 1]]);
  wow.clearOutput();
  wow.exec('__ns.ui.show("report")');
  const body = wow.texts().find((t) => /The last 7 days/.test(t));
  assert.match(body, /The guild: \|cff40bf402 kills\|r, \|cffff40403 deaths\|r to players\./);
  assert.match(body, /The Barrens {2}\|cff40bf402 kills\|r {2}\|cffff40402 deaths\|r/);
  assert.match(body, /Ashenvale {2}\|cff40bf400 kills\|r {2}\|cffff40401 death\|r/);
  assert.match(body, /The marks show on your world map\./);
  wow.click('WowGuildWindow.pages.report.buttons[1]');
  assert.strictEqual(wow.eval('tostring(__ns.opt("warMap"))'), 'false');
  assert.ok(wow.texts().some((t) => /The marks are hidden on your world map/.test(t)));
  assert.strictEqual(wow.printed(), '');
  wow.click('WowGuildWindow.pages.report.buttons[1]');
  assert.strictEqual(wow.eval('tostring(__ns.opt("warMap"))'), 'true');
  noError(wow);
});
