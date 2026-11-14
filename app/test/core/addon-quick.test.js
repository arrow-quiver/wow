'use strict';
// Quick.lua: the small in-game panel for what has to happen in the game at once. The guild's pages are on the war
// table (the app, Ctrl+Shift+G); the campfire, the key binding and /wow open this panel instead of the full window.
const test = require('node:test');
const assert = require('node:assert');
const { WowClient } = require('./wowsim');

const noError = (wow) => assert.strictEqual(wow.eval('__ns.debugError'), null, 'no addon errors');
const txt = (wow, expr) => wow.eval(`tostring(${expr}:GetText())`);
const shown = (wow, expr) => wow.eval(`tostring(${expr}:IsShown())`);
const q = 'WowGuildQuick';

const SHARE = `__recs = {}
__ns.Share = __ns.Share or {}
__ns.Share.myPid = function() return "Thrallia.p4m7" end
__ns.Share.list = function(ty) local out = {} for _, r in ipairs(__recs) do if r.type == ty then out[#out + 1] = r end end return out end
__ns.Share.get = function(id) for _, r in ipairs(__recs) do if r.type .. ":" .. r.key == id then return r end end end
__ns.Share.putLocal = function(ty, key, f)
  for i, r in ipairs(__recs) do if r.type == ty and r.key == key then table.remove(__recs, i) break end end
  table.insert(__recs, { type = ty, key = key, fields = f, author = "Thrallia", t = GetServerTime() }) return {}
end
function IsInGuild() return true end
GetZoneText = function() return "Ashenvale" end
__units = {}
UnitIsPlayer = function(u) return __units[u] ~= nil or u == "player" end
UnitIsEnemy = function(a, u) return __units[u] ~= nil end
local origName = UnitName
UnitName = function(u) if __units[u] then return __units[u].name end return origName(u) end`;

function client(extra = '') {
  const wow = new WowClient();
  wow.login();
  wow.exec(SHARE);
  if (extra) wow.exec(extra);
  wow.clearOutput();
  return wow;
}
const rowTexts = (wow) => [1, 2, 3, 4, 5, 6, 7].filter((i) => shown(wow, `${q}.rows[${i}]`) === 'true').map((i) => txt(wow, `${q}.rows[${i}].text`));
const buttons = (wow, i) => [1, 2, 3].filter((k) => shown(wow, `${q}.rows[${i}].b[${k}]`) === 'true').map((k) => txt(wow, `${q}.rows[${i}].b[${k}]`));

test('the campfire, the key binding and /wow open the quick panel; the full window is an option and /wow full', () => {
  const wow = client();
  wow.click('WowGuildMinimapButton');
  assert.strictEqual(shown(wow, q), 'true');
  assert.strictEqual(wow.eval('tostring(WowGuildWindow)'), 'nil', 'the full window is not even built');
  assert.match(wow.printed(), /The guild's pages are on the war table now: press Ctrl\+Shift\+G/, 'said once');
  assert.ok(wow.texts().includes('Everything else is on the war table: press Ctrl+Shift+G (the Guild Camp app).'));
  assert.ok(wow.texts().includes('Nothing needs you right now.'));
  wow.exec('WowGuild_Toggle()');
  assert.strictEqual(shown(wow, q), 'false', 'the key binding closes it again');
  wow.clearOutput();
  wow.slash('');
  assert.strictEqual(shown(wow, q), 'true');
  assert.strictEqual(wow.printed(), '', 'the note is not repeated');
  // Right-click still goes to the settings; /wow full and /wow <page> still open the window.
  wow.exec('WowGuildQuick:Hide()');
  wow.slash('full');
  assert.strictEqual(shown(wow, 'WowGuildWindow'), 'true');
  wow.exec('WowGuildWindow:Hide()');
  wow.slash('hunt');
  assert.strictEqual(wow.eval('__ns.ui.current'), 'hunt');
  // With the option on, the campfire opens the full window as before.
  wow.exec('WowGuildWindow:Hide(); __ns.db.options.fullWindow = true');
  wow.click('WowGuildMinimapButton');
  assert.strictEqual(shown(wow, 'WowGuildWindow'), 'true');
  assert.strictEqual(shown(wow, q), 'false');
  noError(wow);
});

test('what needs me right now: a call to arms to answer, a group to join, a drive to give to', () => {
  const wow = client(`local t = GetServerTime()
    table.insert(__recs, { type = "dg", key = "g1", author = "Mokra", t = t, fields = { pid = "Mokra.m1", character = "Mokra", dungeon = "Deadmines", startsAt = t, role = "t", level = 20, tank = 1, heal = 1, dps = 3, note = "", state = "o" } })
    table.insert(__recs, { type = "DR", key = "d1", author = "Mokra", t = t, fields = { title = "Cloth for bandages", unit = "Runecloth", goal = 200, notes = "", state = "o" } })
    __ns.ctaRecent = { { zone = "Hillsbrad", character = "Oldcall", at = time() - 3600 }, { zone = "Ashenvale", message = "Zoram Strand", character = "Mokra", at = time() - 60 } }`);
  wow.exec('__ns.quick.show()');
  wow.clearOutput(); // the one-time note about where the pages went
  wow.exec('__ns.quick.refresh()');
  assert.ok(wow.texts().includes('3 things right now'));
  const rows = rowTexts(wow);
  assert.match(rows[0], /Mokra calls to arms in Ashenvale/, 'the hour-old call is not "right now"');
  assert.match(rows[1], /^Deadmines {2}\|cff999999Mokra, needs 1 healer, 3 dps\|r$/);
  assert.match(rows[2], /^Cloth for bandages {2}\|cff9999990 of 200 Runecloth\|r$/);
  assert.deepStrictEqual(buttons(wow, 1), ['On my way']);
  assert.deepStrictEqual(buttons(wow, 2), ['Tank', 'Healer', 'DPS']);
  assert.deepStrictEqual(buttons(wow, 3), ['I gave']);

  // On my way: one message to the guild, and the row goes.
  const before = wow.sentMessages.length;
  wow.click(`${q}.rows[1].b[1]`);
  assert.deepStrictEqual(wow.sentMessages.slice(before).filter((m) => m.prefix === 'GuildCampNow').map((m) => m.text), ['R|Mokra']);
  assert.strictEqual(txt(wow, `${q}.status`), "Told Mokra you're coming.");
  assert.ok(wow.texts().includes('2 things right now'));

  // Join as healer: at once, my own record; the row becomes "You're in" with Leave.
  wow.click(`${q}.rows[1].b[2]`);
  assert.match(txt(wow, `${q}.status`), /You joined Mokra's Deadmines group as healer/);
  assert.strictEqual(wow.eval('__ns.Share.get("dj:g1:Thrallia.p4m7").fields.role'), 'h');
  assert.match(rowTexts(wow)[0], /You're in\|r Mokra's Deadmines/);
  assert.deepStrictEqual(buttons(wow, 1), ['Leave']);

  // I gave: the number comes from the box.
  wow.click(`${q}.rows[2].b[1]`);
  assert.strictEqual(txt(wow, `${q}.status`), 'Write how many you gave in the box first.');
  wow.exec(`${q}.box:SetText("40")`);
  wow.click(`${q}.rows[2].b[1]`);
  assert.match(txt(wow, `${q}.status`), /^Recorded: 40 Runecloth/);
  assert.strictEqual(txt(wow, `${q}.box`), '');
  assert.match(rowTexts(wow)[1], /40 of 200 Runecloth/);
  assert.strictEqual(wow.printed(), '', 'answers show on the panel, not in chat');
  noError(wow);
});

test('the line to write in: a call to arms, a board post, a new group, kill on sight for my target', () => {
  const wow = client();
  wow.exec('__ns.quick.show()');
  // Nothing written: the buttons that need text say so; a call to arms needs none.
  wow.click(`${q}.send.wts`);
  assert.strictEqual(txt(wow, `${q}.status`), 'Write the post in the box first.');
  wow.click(`${q}.send.tank`);
  assert.strictEqual(txt(wow, `${q}.status`), 'Write the dungeon in the box first.');
  // A board post.
  wow.exec(`${q}.box:SetText("Mooncloth x4 12g")`);
  wow.click(`${q}.send.wts`);
  assert.match(txt(wow, `${q}.status`), /^Posted to the guild board: Selling Mooncloth x4/);
  assert.strictEqual(txt(wow, `${q}.box`), '');
  assert.strictEqual(wow.eval('#__ns.Share.list("bb")'), '1');
  // A group: it shows up at once as mine.
  wow.exec(`${q}.box:SetText("Wailing Caverns")`);
  wow.click(`${q}.send.healer`);
  assert.match(txt(wow, `${q}.status`), /Group for Wailing Caverns posted to your guild/);
  assert.match(rowTexts(wow)[0], /^Your Wailing Caverns/);
  assert.deepStrictEqual(buttons(wow, 1), ['Invite all', 'Done', 'Call off']);
  // A call to arms, with what's written as its message.
  wow.exec(`${q}.box:SetText("Alliance at the lumber mill")`);
  wow.click(`${q}.send.horn`);
  assert.strictEqual(wow.eval('__ns.ctaRecent[#__ns.ctaRecent].zone'), 'Ashenvale');
  assert.strictEqual(wow.eval('__ns.ctaRecent[#__ns.ctaRecent].message'), 'Alliance at the lumber mill');
  assert.strictEqual(txt(wow, `${q}.box`), '');
  // Kill on sight: an enemy player target only.
  wow.click(`${q}.send.kos`);
  assert.strictEqual(txt(wow, `${q}.status`), 'Target an enemy player first.');
  wow.exec('__units.target = { name = "Stabby", level = 28, class = "Warrior" }');
  wow.click(`${q}.send.kos`);
  assert.match(txt(wow, `${q}.status`), /Stabby is now kill on sight for the guild/);
  assert.strictEqual(wow.eval('__ns.hunt.onList("Stabby").reason'), 'Seen in Ashenvale');
  noError(wow);
});

test('my own group, my own call, and a recruit who wants in', () => {
  const wow = client(`__invited = {}
    C_PartyInfo = C_PartyInfo or {}
    C_PartyInfo.InviteUnit = function(n) table.insert(__invited, n) end
    CanGuildInvite = function() return true end
    WOW_PROJECT_CAMELOT = 18; WOW_PROJECT_ID = 18
    table.insert(__recs, { type = "rk", key = "Newbie", author = "Mokra", t = GetServerTime(), fields = { pid = "Mokra.m1", state = "i", at = GetServerTime() } })
    __ns.ctaRecent = { { zone = "Ashenvale", at = time() - 30, mine = true, character = "Thrallia" } }`);
  wow.receive('GuildCampNow', 'R|Thrallia', 'GUILD', 'Mokra');
  wow.clearOutput();
  wow.exec('__ns.quick.show()');
  const rows = rowTexts(wow);
  assert.match(rows[0], /Your call in Ashenvale\|r {2}\|cff40bf40Coming: Mokra\|r/);
  assert.match(rows[1], /Newbie wants to join the guild/);
  assert.deepStrictEqual(buttons(wow, 1), ['Invite them']);
  assert.deepStrictEqual(buttons(wow, 2), ['Show name'], 'on Forever the invite is the name to right-click');
  wow.click(`${q}.rows[1].b[1]`);
  assert.deepStrictEqual(wow.get('__invited'), ['Mokra']);
  assert.strictEqual(txt(wow, `${q}.status`), 'Invited 1.');
  wow.click(`${q}.rows[2].b[1]`);
  assert.match(txt(wow, `${q}.status`), /\|Hplayer:Newbie\|h\[Newbie\]\|h wants to join the guild/);
  // The open panel follows what arrives: another answer to my call.
  wow.receive('GuildCampNow', 'R|Thrallia', 'GUILD', 'Zed');
  assert.match(rowTexts(wow)[0], /Coming: Mokra, Zed/);
  noError(wow);
});

test('guildmates\' text shows as written on the panel', () => {
  const evil = '|cffff0000RED|r';
  const wow = client(`local t, e = GetServerTime(), ${JSON.stringify(evil)}
    table.insert(__recs, { type = "dg", key = "g1", author = "Mokra", t = t, fields = { pid = "Mokra.m1", character = e, dungeon = e, startsAt = t, role = "t", tank = 1, heal = 1, dps = 3, note = "", state = "o" } })
    __ns.ctaRecent = { { zone = e, message = e, character = e, at = time() } }`);
  wow.exec('__ns.quick.show()');
  const rows = rowTexts(wow);
  assert.ok(rows[0].includes('||cffff0000RED||r calls to arms in ||cffff0000RED||r') && rows[0].includes('|cff999999||cffff0000RED||r|r'));
  assert.ok(rows[1].startsWith('||cffff0000RED||r  |cff999999||cffff0000RED||r, '));
  noError(wow);
});
