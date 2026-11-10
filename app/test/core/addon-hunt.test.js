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
