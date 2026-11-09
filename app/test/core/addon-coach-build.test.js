'use strict';
// The Coach's build in game: the talent guide beside the talent window (CoachTalents.lua) and gear advice on item
// tooltips from the plan's stat priorities (CoachGear.lua).
const test = require('node:test');
const assert = require('node:assert');
const { WowClient } = require('./wowsim');

const GAME = `
function GetNumTalentTabs() return 3 end
local tabs = { {"Elemental", 0}, {"Enhancement", 5}, {"Restoration", 0} }
function GetTalentTabInfo(i) return tabs[i][1], "icon", tabs[i][2], "bg" end
local talents = { [2] = { {"Ancestral Knowledge", 5, 5}, {"Flurry", 0, 5}, {"Stormstrike", 0, 1} } }
function GetNumTalents(tab) return talents[tab] and #talents[tab] or 0 end
function GetTalentInfo(tab, i) local t = talents[tab] and talents[tab][i]; if t then return t[1], "icon", 1, i, t[2], t[3] end end
function UnitCharacterPoints() return 2 end
-- Items: 100 = worn axe (Strength 10), 101 = better axe (Strength 14, Stamina 3), 102 = a caster mace (Intellect 20), 103 = ring
local stats = { [100] = { ITEM_MOD_STRENGTH_SHORT = 10 }, [101] = { ITEM_MOD_STRENGTH_SHORT = 14, ITEM_MOD_STAMINA_SHORT = 3 },
  [102] = { ITEM_MOD_INTELLECT_SHORT = 20 }, [103] = { ITEM_MOD_AGILITY_SHORT = 5 }, [104] = { ITEM_MOD_STRENGTH_SHORT = 9 } }
local loc = { [100] = "INVTYPE_2HWEAPON", [101] = "INVTYPE_2HWEAPON", [102] = "INVTYPE_2HWEAPON", [103] = "INVTYPE_FINGER", [104] = "INVTYPE_2HWEAPON" }
local function idOf(link) return tonumber(string.match(link or "", "item:(%d+)")) end
function GetItemStats(link) return stats[idOf(link)] end
C_Item = { GetItemInfoInstant = function(link) local id = idOf(link); return id, "Weapon", "Axe", loc[id] end }
function GetInventoryItemLink(_, slot) if slot == 16 then return "|cff1eff00|Hitem:100::|h[Old Axe]|h|r" end end
`;
const PLAN = `WowGuildInbox = WowGuildInbox or {}
WowGuildInbox.coach = { enabled = true, plans = { [__ns.charKey()] = {
  headline = "Enhancement for world PvP", spec = "Enhancement", split = "0/31/20",
  stats = { "Strength", "Stamina", "Agility" },
  talents = {
    { name = "Ancestral Knowledge", tree = "Enhancement", points = 5, why = "More mana" },
    { name = "Flurry", tree = "Enhancement", points = 5, why = "Faster swings after a crit" },
    { name = "Stormstrike", tree = "Enhancement", points = 1, why = "Big burst" },
  } } } }`;
const TALENT_FRAME = `PlayerTalentFrame = CreateFrame("Frame", "PlayerTalentFrame", UIParent)
PlayerTalentFrame.selectedTab = 2
function PlayerTalentFrame:HookScript(n, fn) self.hooks = self.hooks or {}; self.hooks[n] = fn end
local buttons = {}
for i = 1, 3 do local b = CreateFrame("Button", nil, PlayerTalentFrame); b.id = i; function b:GetID() return self.id end; b:Show(); buttons[i] = b end
function PlayerTalentFrame:GetChildren() return unpack(buttons) end
__talentButtons = buttons`;

function session() {
  const wow = new WowClient();
  wow.exec(GAME);
  wow.login();
  wow.exec(PLAN);
  return wow;
}

test('talent guide: next talent, plan order with ticks, glow on the right button', () => {
  const wow = session();
  wow.exec(TALENT_FRAME);
  wow.fire('ADDON_LOADED', 'Blizzard_TalentUI');
  wow.exec('PlayerTalentFrame:Show(); PlayerTalentFrame.hooks.OnShow()');
  assert.strictEqual(wow.eval('tostring(WowGuildCoachTalents:IsShown())'), 'true');
  assert.strictEqual(wow.eval('WowGuildCoachTalents.next:GetText()'), 'Next: Flurry  (0/5)');
  assert.strictEqual(wow.eval('WowGuildCoachTalents.why:GetText()'), 'Faster swings after a crit');
  assert.match(wow.eval('WowGuildCoachTalents.sub:GetText()'), /Enhancement {2}0\/31\/20 {2}- {2}2 to spend/);
  assert.match(wow.eval('WowGuildCoachTalents.rows[1].mark:GetText()'), /\+/);
  assert.match(wow.eval('WowGuildCoachTalents.rows[2].mark:GetText()'), />/);
  assert.strictEqual(wow.eval('WowGuildCoachTalents.rows[3].mark:GetText()'), '3');
  assert.strictEqual(wow.eval('__ns.coachTalents.glowing'), 'Flurry');
  wow.click('WowGuildCoachTalents.open');
  assert.strictEqual(wow.eval('tostring(WowGuildCoach:IsShown())'), 'true');
  wow.exec('PlayerTalentFrame.hooks.OnHide()');
  assert.strictEqual(wow.eval('tostring(WowGuildCoachTalents:IsShown())'), 'false');
  // Turned off in the options: nothing opens.
  wow.exec('__ns.db.options = __ns.db.options or {}; __ns.db.options.coachTalents = false; PlayerTalentFrame.hooks.OnShow()');
  assert.strictEqual(wow.eval('tostring(WowGuildCoachTalents:IsShown())'), 'false');
  assert.strictEqual(wow.eval('__ns.debugError'), null);
});

test('talent guide without a plan says how to get one', () => {
  const wow = new WowClient();
  wow.exec(GAME);
  wow.login();
  wow.exec('__ns.coachTalents.refresh()');
  assert.match(wow.eval('WowGuildCoachTalents.next:GetText()'), /Ask for one in the Coach/);
});

test('gear advice on tooltips weighs stats by the plan', () => {
  const wow = session();
  const verdict = (id) => wow.eval(`(function() local v = __ns.coachGear.verdict("item:${id}"); return v and v[1] end)()`);
  assert.match(verdict(101), /Upgrade for your build \(\+\d+%\)/);
  assert.match(verdict(102), /Worse for your build/);
  assert.strictEqual(verdict(100), "You're wearing this");
  assert.strictEqual(verdict(103), 'Upgrade for your build (empty slot)');
  assert.match(verdict(104), /Worse for your build|About the same/);
  // It shows on the tooltip lines, coloured.
  const lines = wow.eval('(function() local t = {} for _, l in ipairs(__ns.tooltip.linesFor(101, "Better Axe")) do t[#t+1] = l[1] .. "=" .. l[2] end return table.concat(t, ";") end)()');
  assert.match(lines, /Coach=\|cff[0-9a-f]{6}Upgrade for your build/);
  // In combat, or without a plan: nothing.
  wow.exec('__inCombat = true');
  assert.strictEqual(verdict(101), null);
  wow.exec('__inCombat = false; WowGuildInbox.coach.plans = {}');
  assert.strictEqual(verdict(101), null);
});
