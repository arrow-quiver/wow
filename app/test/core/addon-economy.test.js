'use strict';
// The economy helpers: the profession leveling plan (Professions.lua, ProfUI.lua), price alerts at the auction house
// (PriceAlerts.lua), and mats for crafts (Mats.lua).
const test = require('node:test');
const assert = require('node:assert');
const { WowClient } = require('./wowsim');

// Linen Cloth 2589 (10s), Wool Cloth 2592 (40s), Coarse Thread 2320 (1s).
const INBOX = {
  prices: [{ id: 2589, price: 1000 }, { id: 2592, price: 4000 }, { id: 2320, price: 100 }],
  holdings: [{ id: 2592, chars: [{ name: 'Altie', count: 3 }], guildBank: 4 }],
  crafters: [{ name: 'Heavy Linen Gloves', who: 'Thrallia,Mokra' }, { name: 'Mooncloth Robe', who: 'Zulsha' }],
};
const RECIPES = `__ns.prof.current = { name = "Tailoring", recipes = {
  { key = "a", name = "Bolt of Linen Cloth", diff = 2, skillUps = 1, reagents = { { id = 2589, qty = 2, name = "Linen Cloth" } } },
  { key = "b", name = "Heavy Linen Gloves", diff = 0, skillUps = 1, reagents = { { id = 2589, qty = 4, name = "Linen Cloth" }, { id = 2320, qty = 1, name = "Coarse Thread" } } },
  { key = "c", name = "Woolen Cape", diff = 1, skillUps = 1, reagents = { { id = 2592, qty = 1, name = "Wool Cloth" } } },
} }
GetTradeSkillLine = function() return "Tailoring", 70, 75 end
__owned = { [2589] = 8 }
__ns.prof.owned = function(id) return __owned[id] or 0 end`;

test('the leveling plan: the next points (up to the rank\'s cap), bags then alts then the guild bank, then buying', () => {
  const wow = new WowClient({ inbox: INBOX });
  wow.login();
  wow.exec(RECIPES);
  wow.exec('__plan = __ns.prof.plan(__ns.prof.current.recipes)');
  assert.strictEqual(wow.eval('__plan.goal'), '5', 'only 5 points left in this rank');
  // Gloves first (8 linen in bags make 2 free, then 10s × 4 + 1s each = 41s a point), but woolen capes at 0.75
  // points use wool from the alts (3) and the guild bank (4) for free, so capes come first.
  const steps = JSON.parse(wow.eval('(function() local t = {} for _, s in ipairs(__plan.steps) do t[#t + 1] = string.format("%q", s.recipe.name .. "|" .. s.crafts) end return "[" .. table.concat(t, ",") .. "]" end)()'));
  assert.ok(steps.length >= 1);
  assert.ok(Number(wow.eval('__plan.points')) >= 5);
  assert.strictEqual(wow.eval('__plan.steps[1].recipe.name'), 'Woolen Cape');
  assert.ok(Number(wow.eval('__plan.alts[2592] or 0')) > 0, 'wool from the alts');
  assert.strictEqual(wow.eval('__plan.unknown'), 'false');
  // Green recipes are never in the plan.
  assert.ok(!steps.some((s) => s.startsWith('Bolt of Linen Cloth')));
  wow.exec('__ns.prof.planToList(__plan)');
  assert.strictEqual(wow.eval('#__ns.prof.list()'), String(steps.length));
  // The guide's plan view.
  wow.exec('__ns.prof.toggleGuide(); __ns.prof.planMode = true; __ns.prof.refreshGuide()');
  assert.strictEqual(wow.eval('WowGuildSkillGuide.title:GetText()'), 'Tailoring: the next points');
  assert.match(wow.eval('WowGuildSkillGuide.rows[1].name:GetText()'), /^\d+ × \|cff[0-9a-f]{6}Woolen Cape\|r$/);
  assert.strictEqual(wow.eval('__ns.debugError'), null);
});

test('price alerts: an item on the buy list at or under its target, once per visit; own targets', () => {
  const wow = new WowClient({ inbox: INBOX });
  wow.login();
  wow.exec(`__ns.ahTab = __ns.ahTab or {}
__ns.ahTab.lines = function() return { { id = 2592, name = "Wool Cloth", kind = "list", qty = 10 }, { id = 2589, name = "Linen Cloth", kind = "guild", who = "Mokra", qty = 20 } } end`);
  const w = 'local l = __ns.priceAlerts.watch()';
  assert.strictEqual(wow.eval(`(function() ${w}; return l[2592].target end)()`), '3400', '85% of 40s');
  assert.strictEqual(wow.eval('__ns.priceAlerts.seen(2592, 3500, 5)'), null, 'over the target');
  assert.strictEqual(wow.eval('__ns.priceAlerts.seen(2592, 3000, 5)'), 'Deal: Wool Cloth at 30s 0c each, 5 up (usual 40s 0c), on your shopping list.');
  assert.strictEqual(wow.eval('__ns.priceAlerts.seen(2592, 2000, 5)'), null, 'once per visit');
  // The classic auction list.
  wow.exec(`GetNumAuctionItems = function() return 1 end
GetAuctionItemInfo = function() return "Linen Cloth", nil, 20, nil, nil, nil, nil, nil, nil, 16000, nil, nil, nil, "Seller", nil, nil, 2589 end`);
  assert.strictEqual(wow.eval('__ns.priceAlerts.classicList()'), '1');
  assert.match(wow.printed(), /Deal: Linen Cloth at 8s 0c each, 20 up \(usual 10s 0c\), on a guild bank request from Mokra\./);
  // My own target, by item link.
  wow.exec('__ns.priceAlerts.reset()');
  assert.strictEqual(wow.eval('__ns.priceAlerts.parseMoney("1g 50s")'), '15000');
  assert.strictEqual(wow.eval('__ns.priceAlerts.parseMoney("75s")'), '7500');
  assert.strictEqual(wow.eval('__ns.priceAlerts.slash("50s |cffffffff|Hitem:2592::::::::|h[Wool Cloth]|h|r")'), '5000');
  assert.match(wow.eval('__ns.priceAlerts.seen(2592, 4500, 1)'), /your target 50s 0c/);
  wow.exec('WowGuildDB.options.priceAlerts = false; __ns.priceAlerts.reset()');
  assert.strictEqual(wow.eval('__ns.priceAlerts.seen(2592, 1, 1)'), null);
  assert.strictEqual(wow.eval('__ns.debugError'), null);
});

test('mats for crafts: what my list lacks goes out; their mats in my bags and crafts I can make get a nudge once a day', () => {
  const wow = new WowClient({ inbox: INBOX });
  wow.login();
  wow.exec(`${RECIPES}
__recs = {
  { type = "mw", key = "Mokra.m1", author = "Mokra", fields = { items = { { id = 2589, qty = 12 }, { id = 9999, qty = 1 } } } },
  { type = "mw", key = "Thrallia.p4m7", author = "Thrallia", fields = { items = { { id = 2589, qty = 2 } } } },
  { type = "cr", key = "c00001", author = "Zulsha", fields = { item = "Heavy Linen Gloves", state = "o" } },
  { type = "bq", key = "q00001", author = "Grom", fields = { item = "Heavy Linen Gloves", count = 3, state = "o" } },
  { type = "cr", key = "c00002", author = "Grom", fields = { item = "Mooncloth Robe", state = "o" } },
}
__ns.Share = __ns.Share or {}
__ns.Share.list = function(ty) local out = {} for _, r in ipairs(__recs) do if r.type == ty then out[#out + 1] = r end end return out end`);
  wow.exec('__m = __ns.mats.matches()');
  assert.strictEqual(wow.eval('#__m.have'), '1', 'only Mokra\'s linen: not my own record, not what I lack');
  assert.strictEqual(wow.eval('__m.have[1].mine'), '8');
  assert.strictEqual(wow.eval('#__m.craft'), '2', 'the gloves twice (a request and a bank request), not the robe');
  assert.strictEqual(wow.eval('__ns.mats.nudge()'), '3');
  assert.match(wow.printed(), /Mokra is short of 12 × .* for crafting\. You have 8\./);
  assert.match(wow.printed(), /Grom wants 3 × Heavy Linen Gloves \(a guild bank request\)\. You can make it\./);
  assert.strictEqual(wow.eval('__ns.mats.nudge()'), '0', 'once a day');
  assert.strictEqual(wow.eval('__ns.mats.show()'), '3');
  // My list's shortfall as the record.
  wow.exec('__ns.prof.addToList(__ns.prof.current.recipes[2], 3)');
  wow.exec('__rec = __ns.mats.record("Thrallia.p4m7")');
  assert.strictEqual(wow.eval('__rec.type'), 'mw');
  const short = (id) => wow.eval(`(function() for _, it in ipairs(__rec.fields.items) do if it.id == ${id} then return it.qty end end end)()`);
  assert.strictEqual(short(2589), '4', '12 linen for 3 gloves, 8 in bags');
  assert.strictEqual(short(2320), '3');
  assert.strictEqual(wow.eval('__ns.debugError'), null);
});
