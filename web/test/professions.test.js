// Profession helper: skill-up ranking, shopping list, tracker, and the site round trip.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const dbm = require('../src/db');
const { applyPayload, buildInbox, toLua } = require('../src/sync');
const { createApp, config } = require('../src/server');
const { WowClient } = require('./wowsim');
const { parseSavedVariables } = require('../../companion/lua');

// A Blacksmithing window with recipes at every difficulty.
const TRADESKILL_MOCK = `
Enum = Enum or {}; Enum.CraftingReagentType = { Basic = 1 }
local names = { [2770] = "Copper Ore", [2840] = "Copper Bar", [2589] = "Linen Cloth", [2835] = "Rough Stone", [9999] = "Mystery Dust" }
local recipes = {
  [1] = { name = "Copper Bracers", learned = true, relativeDifficulty = 0, numSkillUps = 1, numAvailable = 0, mats = { {2840, 2} } },
  [2] = { name = "Linen Belt", learned = true, relativeDifficulty = 1, numSkillUps = 1, numAvailable = 0, mats = { {2589, 1} } },
  [3] = { name = "Rough Grinding Stone", learned = true, relativeDifficulty = 2, numSkillUps = 1, numAvailable = 0, mats = { {2835, 4} } },
  [4] = { name = "Old Thing", learned = true, relativeDifficulty = 3, numSkillUps = 1, numAvailable = 9, mats = { {2835, 1} } },
  [5] = { name = "Ore Shard", learned = true, relativeDifficulty = 0, numSkillUps = 1, numAvailable = 3, mats = { {2770, 1} } },
  [6] = { name = "Strange Rod", learned = true, relativeDifficulty = 0, numSkillUps = 1, numAvailable = 0, mats = { {9999, 1} } },
  [7] = { name = "Not Learned", learned = false, relativeDifficulty = 0, mats = {} },
}
C_TradeSkillUI = {
  IsTradeSkillLinked = function() return false end,
  IsTradeSkillGuild = function() return false end,
  GetBaseProfessionInfo = function() return { professionName = "Blacksmithing" } end,
  GetAllRecipeIDs = function() return { 1, 2, 3, 4, 5, 6, 7 } end,
  GetRecipeInfo = function(id) local r = recipes[id]; return r and { name = r.name, learned = r.learned, relativeDifficulty = r.relativeDifficulty, numSkillUps = r.numSkillUps, numAvailable = r.numAvailable } end,
  GetRecipeSchematic = function(id)
    local slots = {}
    for _, m in ipairs(recipes[id].mats) do slots[#slots + 1] = { reagentType = 1, quantityRequired = m[2], reagents = { { itemID = m[1] } } } end
    slots[#slots + 1] = { reagentType = 0, quantityRequired = 1, reagents = { { itemID = 424242 } } } -- optional reagent: ignored
    return { reagentSlotSchematics = slots }
  end,
}
__counts = { [2589] = 2 }
C_Item.GetItemCount = function(id) return __counts[id] or 0 end
C_Item.GetItemNameByID = function(id) return names[id] end
local prices = { [2840] = 50, [2589] = 10, [2835] = 5, [2770] = 30 }
Auctionator = { API = { v1 = { GetAuctionPriceByItemID = function(caller, id) return prices[id] end } } }
ProfessionsFrame = { IsShown = function() return true end }
`;

function client(inboxFile) {
  const wow = new WowClient(inboxFile ? { inboxFile } : {});
  wow.exec(TRADESKILL_MOCK);
  wow.fire('ADDON_LOADED', 'WowGuild');
  wow.fire('PLAYER_LOGIN');
  return wow;
}

test('skill-up guide ranks: mats on hand first, then cheapest per point, unknown prices last, grey skipped', () => {
  const wow = client();
  wow.fire('TRADE_SKILL_SHOW');
  const order = wow.eval(`(function() local t = {} for _, r in ipairs(__ns.prof.rank(__ns.prof.current.recipes)) do t[#t+1] = r.recipe.name .. "=" .. string.format("%.1f", r.perPoint) end return table.concat(t, ", ") end)()`);
  // Ore Shard can be made from bags; Linen Belt 10/0.75=13.3; Grinding Stone 20/0.25=80; Bracers 100/1; Strange Rod has no price.
  assert.strictEqual(order, 'Ore Shard=30.0, Linen Belt=13.3, Rough Grinding Stone=80.0, Copper Bracers=100.0, Strange Rod=0.0');
  assert.strictEqual(wow.eval('#__ns.prof.current.recipes'), '6', 'unlearned recipe skipped');
  assert.strictEqual(wow.eval('#__ns.prof.current.recipes[1].reagents'), '1', 'optional reagents ignored');
  assert.strictEqual(wow.eval('__ns.debugError'), null);
  // Reagents are remembered so the site can price them.
  const sv = parseSavedVariables(wow.saveVariables()).WowGuildDB;
  assert.deepStrictEqual(sv.reagentIds.sort((a, b) => a - b), [2589, 2770, 2835, 2840, 9999]);
});

test('shopping list tracks mats, uses alt and guild bank stock, and ticks off as you loot', () => {
  const inboxFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-')), 'Inbox.lua');
  fs.writeFileSync(inboxFile, `WowGuildInbox = ${toLua({ guild: 'wow', prices: [], stock: [{ id: 2589, chars: [{ name: 'Thrallia', count: 2 }, { name: 'Altie', count: 7 }], guildBank: 20 }] })}\n`);
  const wow = client(inboxFile);
  wow.fire('TRADE_SKILL_SHOW');
  wow.exec('for _, r in ipairs(__ns.prof.current.recipes) do if r.name == "Linen Belt" then __ns.prof.addToList(r, 5) end end');
  wow.exec('for _, r in ipairs(__ns.prof.current.recipes) do if r.name == "Linen Belt" then __ns.prof.addToList(r, 1) end end');
  assert.strictEqual(wow.eval('__ns.prof.list()[1].qty'), '6', 'adding again increases the quantity');
  wow.slash('list');
  const text = wow.eval('__ns.prof.trackerText()');
  assert.match(text, /For: 6 × Linen Belt/);
  assert.match(text, /Linen Cloth\|r {2}2 \/ 6 {2}\|cffe8a33d\(7 on alts, 20 in guild bank\)/);
  // Loot 4 more linen: done.
  wow.exec('__counts[2589] = 6');
  wow.fire('BAG_UPDATE_DELAYED');
  assert.match(wow.printed(), /Got all 6 Linen Cloth/);
  assert.match(wow.printed(), /Everything on your shopping list is ready/);
  assert.match(wow.eval('__ns.prof.trackerText()'), /\|cff40bf40Linen Cloth\|r {2}6 \/ 6$/m);
  wow.slash('list clear');
  assert.strictEqual(wow.eval('#__ns.prof.list()'), '0');
  wow.slash('guide');
  assert.strictEqual(wow.eval('__ns.debugError'), null);
});

test('site stores the shopping list, prices reagents and reports stock back', async () => {
  const db = dbm.open(':memory:');
  const u = db.prepare("INSERT INTO users (bnet_id, battletag) VALUES ('dev:J#1','J#1')").run().lastInsertRowid;
  const g = db.prepare("INSERT INTO guilds (name, invite_code) VALUES ('wow','i')").run().lastInsertRowid;
  db.prepare("INSERT INTO memberships (user_id, guild_id, role) VALUES (?,?,'owner')").run(u, g);
  const today = Math.floor((Date.now() - Date.UTC(2020, 0, 1)) / 86400000);
  applyPayload(db, g, u, {
    characters: {
      Thrallia: { name: 'Thrallia', inventory: { bags: [{ id: 2589, name: 'Linen Cloth', count: 2 }] } },
      Altie: { name: 'Altie', inventory: { bank: [{ id: 2589, name: 'Linen Cloth', count: 7 }] } },
    },
    guildBank: { scannedAt: Math.floor(Date.now() / 1000), money: 0, tabs: [{ name: 'Mats', items: [{ id: 2589, name: 'Linen Cloth', count: 20 }] }] },
    prices: { items: [[2589, 12, today], [2840, 55, today]] },
    reagentIds: [2589, 2840, 2835],
    shopping: [{ name: 'Linen Belt', qty: 6, prof: 'Blacksmithing', reagents: [{ id: 2589, name: 'Linen Cloth', qty: 1 }] }],
  });
  const inbox = buildInbox(db, g, u);
  assert.deepStrictEqual(inbox.prices.sort((a, b) => a.id - b.id), [{ id: 2589, price: 12 }, { id: 2840, price: 55 }]);
  assert.deepStrictEqual(inbox.stock, [{ id: 2589, chars: [{ name: 'Altie', count: 7 }, { name: 'Thrallia', count: 2 }], guildBank: 20 }]);

  // And the Crafters page shows it.
  const cfg = { ...config({}), devLogin: true, timers: false };
  const app = createApp(cfg, db);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try {
    const url = `http://127.0.0.1:${srv.address().port}`;
    const res = await fetch(`${url}/login/dev`, { method: 'POST', body: new URLSearchParams({ battletag: 'J#1' }), redirect: 'manual' });
    const cookie = res.headers.get('set-cookie').split(';')[0];
    const html = await (await fetch(`${url}/crafters`, { headers: { cookie } })).text();
    assert.match(html, /Your shopping list/);
    assert.match(html, /6 × Linen Belt/);
    assert.match(html, /Altie 7, Thrallia 2/);
    assert.match(html, /about 72c/);
  } finally { srv.close(); }
});
