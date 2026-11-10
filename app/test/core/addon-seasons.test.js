'use strict';
// Seasons.lua: guildies' season titles and badges on their player tooltips, and /wow season.
const test = require('node:test');
const assert = require('node:assert');
const { WowClient } = require('./wowsim');

const INBOX = `WowGuildInbox = WowGuildInbox or {}
WowGuildInbox.seasons = { month = "2026-11", players = {
  Grommash = { title = "MVP", rank = 1, score = 306, streak = 3, badges = 2, best = "Bloodied" },
  Jainah = { title = "", rank = 2, score = 33, streak = 1, badges = 0, best = "" },
  Mokra = { title = "", rank = 0, score = 0, streak = 0, badges = 1, best = "Benefactor" },
} }`;

test('the tooltip line: title, rank, streak, badges', () => {
  const wow = new WowClient();
  wow.login();
  wow.exec(INBOX);
  assert.strictEqual(wow.eval('__ns.seasons.line("Grommash-Zuljin")'), '|cffe8a33dGuild Camp:|r MVP · #1 this season · 3-week streak · 2 badges (best: Bloodied)');
  assert.strictEqual(wow.eval('__ns.seasons.line("Jainah")'), '|cffe8a33dGuild Camp:|r #2 this season');
  assert.strictEqual(wow.eval('__ns.seasons.line("Mokra")'), '|cffe8a33dGuild Camp:|r 1 badge (best: Benefactor)');
  assert.strictEqual(wow.eval('tostring(__ns.seasons.line("Nobody"))'), 'nil');
  // On a player's tooltip (and not on a mob's, or with the option off).
  wow.exec(`__lines = {}
    __tt = { GetUnit = function() return "Grommash", __unit end, AddLine = function(self, t) table.insert(__lines, t) end, Show = function() end }
    UnitIsPlayer = function(u) return u == "mouseover" end
    UnitName = function(u) if u == "mouseover" then return "Grommash" end return "Ogre" end
    __unit = "mouseover"; __ns.seasons.onUnitTooltip(__tt)
    __unit = "npc"; __ns.seasons.onUnitTooltip(__tt)
    WowGuildDB.options.seasonTooltips = false; __unit = "mouseover"; __ns.seasons.onUnitTooltip(__tt)`);
  assert.strictEqual(wow.eval('#__lines'), '1');
  assert.match(wow.eval('__lines[1]'), /MVP · #1 this season/);
  // A name the game keeps secret (reading it errors) adds nothing and breaks nothing.
  wow.exec('WowGuildDB.options.seasonTooltips = true; UnitName = function() error("secret") end; __ns.seasons.onUnitTooltip(__tt)');
  assert.strictEqual(wow.eval('#__lines'), '1');
  assert.strictEqual(wow.eval('__ns.debugError'), null);
});

test('/wow season: the top five and me; nothing yet before the app wrote a season', () => {
  const wow = new WowClient();
  wow.login();
  wow.slash('season');
  assert.match(wow.printed(), /No season standings yet/);
  wow.exec(INBOX);
  wow.exec('UnitName = function() return "Jainah" end');
  wow.slash('season');
  const out = wow.printed();
  assert.match(out, /Season 2026-11:/);
  assert.match(out, /#1 Grommash {2}306 points {2}MVP/);
  assert.match(out, /#2 Jainah {2}33 points/);
  assert.match(out, /You: #2 with 33 points\./);
  assert.strictEqual(wow.eval('__ns.debugError'), null);
});
