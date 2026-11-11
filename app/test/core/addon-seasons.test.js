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

// ---------------------------------------------------------------- the Leaderboard page of the guild window

const BOARD = `WowGuildInbox = WowGuildInbox or {}
WowGuildInbox.seasons = { month = "2026-11", daysLeft = 19, count = 15, players = {
  Grommash = { title = "MVP", rank = 1, score = 306, streak = 3, badges = 2, best = "Bloodied" },
  Jainah = { title = "", rank = 2, score = 33, streak = 1, badges = 0, best = "" },
  Tester = { title = "", rank = 14, score = 4, streak = 0, badges = 0, best = "" },
}, board = {
  { rank = 1, name = "Grommash", class = "Warrior", score = 306, streak = 3, title = "MVP", gold = 120, kills = 14, crafts = 2, raids = 3 },
  { rank = 2, name = "Jainah", class = "Mage", score = 33, streak = 1, title = "", gold = 0, kills = 1, crafts = 0, raids = 0 },
  { rank = 3, name = "Zed", class = "Death Knight", score = 30, streak = 0, title = "", gold = 30, kills = 0, crafts = 0, raids = 0 },
  { rank = 4, name = "P4", score = 20 }, { rank = 5, name = "P5", score = 19 }, { rank = 6, name = "P6", score = 18 },
  { rank = 7, name = "P7", score = 17 }, { rank = 8, name = "P8", score = 16 }, { rank = 9, name = "P9", score = 15 },
  { rank = 10, name = "P10", score = 14 }, { rank = 11, name = "P11", score = 13 }, { rank = 12, name = "P12", score = 12 },
  { rank = 13, name = "P13", score = 11 }, { rank = 14, name = "Testermain", score = 4 }, { rank = 15, name = "P15", score = 1 },
}, leaders = { { title = "Quartermaster", name = "Grommash", value = 120, unit = "gold" }, { title = "Warlord", name = "Grommash", value = 14, unit = "kills" } } }`;

function boardClient(inbox, me = 'Tester') {
  const wow = new WowClient({ player: me });
  wow.login();
  wow.exec(inbox);
  wow.exec(`function UnitName(u) if u == "player" then return ${JSON.stringify(me)} end return nil end`);
  wow.clearOutput();
  wow.exec('__ns.ui.show("season")');
  return wow;
}
const row = (wow, i, field) => wow.eval(`tostring(WowGuildWindow.pages.season.rows[${i}].${field})`);

test('Leaderboard page: the board best first, my row lit and kept in view, leaders and days left', () => {
  const wow = boardClient(BOARD);
  assert.strictEqual(wow.eval('__ns.debugError'), null, 'no addon errors');
  const t = wow.texts();
  assert.ok(t.includes('Season: November 2026'));
  assert.ok(t.includes('19 days left'));
  assert.strictEqual(row(wow, 1, 'name:GetText()'), 'Grommash  |cffe8a33d3-week streak|r');
  assert.strictEqual(row(wow, 1, 'title:GetText()'), 'MVP');
  assert.strictEqual(row(wow, 1, 'deeds:GetText()'), '120g given · 14 kills · 2 crafts · 3 raids');
  assert.strictEqual(row(wow, 1, 'score:GetText()'), '306');
  assert.strictEqual(row(wow, 2, 'deeds:GetText()'), '1 kill');
  assert.strictEqual(row(wow, 1, 'me'), 'false');
  // I'm #14 and twelve rows fit: the last row is mine.
  assert.strictEqual(row(wow, 11, 'shownRank'), '11');
  assert.strictEqual(row(wow, 12, 'shownRank'), '14');
  assert.strictEqual(row(wow, 12, 'me'), 'true');
  assert.strictEqual(row(wow, 12, 'name:GetText()'), 'Testermain');
  assert.ok(t.includes('|cffe8a33dQuartermaster|r Grommash   |cffe8a33dWarlord|r Grommash'));
  assert.ok(t.includes("You're #14 of 15.  The full board of 15 is in the Guild Camp app."));
  assert.strictEqual(wow.printed(), '', 'nothing goes to chat');
});

test('Leaderboard page: an older app (no board) still shows ranks from the tooltip entries; empty says so', () => {
  const wow = boardClient(INBOX, 'Jainah');
  assert.strictEqual(wow.eval('__ns.debugError'), null, 'no addon errors');
  assert.strictEqual(row(wow, 1, 'name:GetText()'), 'Grommash  |cffe8a33d3-week streak|r');
  assert.strictEqual(row(wow, 2, 'name:GetText()'), 'Jainah');
  assert.strictEqual(row(wow, 2, 'me'), 'true');
  assert.strictEqual(wow.eval('tostring(WowGuildWindow.pages.season.rows[3]:IsShown())'), 'false');
  assert.ok(wow.texts().includes("You're #2 of 2."));

  const none = boardClient('WowGuildInbox = WowGuildInbox or {}; WowGuildInbox.seasons = { month = "2026-11", players = {} }');
  assert.strictEqual(none.eval('__ns.debugError'), null, 'no addon errors');
  assert.ok(none.texts().some((x) => /No standings yet/.test(x)));
  assert.strictEqual(none.eval('tostring(WowGuildWindow.pages.season.rows[1]:IsShown())'), 'false');
});

// ---------------------------------------------------------------- last season's recap

const LAST = `WowGuildInbox = WowGuildInbox or {}
WowGuildInbox.seasons = { month = "2026-11", daysLeft = 19, count = 1, players = { Thrallia = { title = "", rank = 1, score = 5, streak = 0, badges = 0, best = "" } },
  board = { { rank = 1, name = "Thrallia", score = 5 } }, leaders = {},
  last = { month = "2026-10", mvp = { name = "Jainah", score = 1000 }, players = 9, gold = 1240, kills = 86, crafts = 31, raids = 12,
    leaders = { { title = "Quartermaster", name = "Jainah", value = 1000, unit = "gold" }, { title = "Warlord", name = "Grommash", value = 40, unit = "kills" } } } }`;

test('last season: the recap lines, once in chat for each finished season, and on the Leaderboard page', () => {
  const wow = new WowClient();
  wow.login();
  wow.exec(LAST);
  wow.clearOutput();
  assert.strictEqual(wow.eval('__ns.seasons.recapLine()'), "October's season: MVP Jainah (1000 points) · Quartermaster Jainah · Warlord Grommash");
  assert.strictEqual(wow.eval('__ns.seasons.togetherLine()'), 'The guild together: 1240g given · 86 kills · 31 crafts · 12 raid sign-ins, by 9 guildies');
  assert.strictEqual(wow.eval('tostring(__ns.seasons.announceLast())'), 'true');
  assert.match(wow.printed(), /October's season: MVP Jainah \(1000 points\)/);
  assert.match(wow.printed(), /The guild together: 1240g given .* A new season is on: \/wow season\./);
  wow.clearOutput();
  assert.strictEqual(wow.eval('tostring(__ns.seasons.announceLast())'), 'false', 'once per season');
  assert.strictEqual(wow.printed(), '');
  assert.strictEqual(wow.db().recapSeen, '2026-10');
  // On the page.
  wow.exec('__ns.ui.show("season")');
  assert.strictEqual(wow.eval('WowGuildWindow.pages.season.last:GetText()'), "October's season: MVP Jainah (1000 points) · Quartermaster Jainah · Warlord Grommash");
  // With login news switched off nothing is printed; with no last season there is nothing to say.
  wow.exec('WowGuildDB.recapSeen = nil; WowGuildDB.options.loginNews = false');
  assert.strictEqual(wow.eval('tostring(__ns.seasons.announceLast())'), 'false');
  wow.exec('WowGuildDB.options.loginNews = true; WowGuildInbox.seasons.last = nil; __ns.ui.show("season")');
  assert.strictEqual(wow.eval('tostring(__ns.seasons.recapLine())'), 'nil');
  assert.strictEqual(wow.eval('tostring(__ns.seasons.announceLast())'), 'false');
  assert.strictEqual(wow.eval('WowGuildWindow.pages.season.last:GetText()'), '');
  assert.strictEqual(wow.eval('__ns.debugError'), null, 'no addon errors');
});
