'use strict';
// SHARING.md step 4: the shared records the addon builds about its own character (Collect.lua):
// ch (who I am), rc (recipes, with spell ids, item ids or names), bk (bank characters only) and sh
// (shopping list), on both game versions (16001 WoW: Forever, 120105 Retail).
//
// The sharing engine is replaced by a stub (ns.Share) so only the collectors run. Every record is
// encoded with the addon's codec (ShareCodec.lua) and checked by the app's (sharing.js), so the field
// names and limits are the ones docs/SHARING.md Appendix A gives.
const test = require('node:test');
const assert = require('node:assert/strict');
const { WowClient, toLua } = require('./wowsim');
const S = require('../../src/shared/sharing');

const IFACES = [16001, 120105];
const T = 1794066000;
const PID = 'Thrallia.p4m7';

// The sharing engine as far as Collect.lua sees it. `recs` holds what ns.Share.get returns.
const STUB = (pid) => `
__shared = { put = {}, offers = {}, recs = {} }
__ns.Share = {
  myPid = function() return ${toLua(pid)} end,
  get = function(id) return __shared.recs[id] end,
  offer = function(t, key, fields) table.insert(__shared.offers, { type = t, key = key, fields = fields }) end,
  putLocal = function(t, key, fields) table.insert(__shared.put, { type = t, key = key, fields = fields }); return true end,
}
-- A record as the engine would send it: encoded with the addon's own codec.
function __encode(r, author, t)
  local SC = __ns.ShareCodec
  author = author or __ns.charKey()
  t = t or ${T}
  return SC.encode({ type = r.type, key = r.key, author = author, v = SC.makeVersion(t, author), fields = r.fields })
end`;

// Profession APIs per game version. Retail names the profession in the player's language and
// gives skill-line ids; WoW: Forever has the older skill-line and trade skill window APIs.
const RETAIL_PROFS = `
GetNumSkillLines = nil; GetSkillLineInfo = nil; GetNumTradeSkills = nil; GetTradeSkillInfo = nil; GetTradeSkillLine = nil
function GetProfessions() return 1, 2, nil, 4, 5 end
local P = { [1] = {"Schmiedekunst", 120, 150, 164}, [2] = {"Bergbau", 140, 150, 186}, [4] = {"Angeln", 40, 75, 356}, [5] = {"Kochkunst", 80, 150, 185} }
function GetProfessionInfo(i) local p = P[i]; return p[1], "icon", p[2], p[3], 0, 0, p[4] end
C_TradeSkillUI = {
  IsTradeSkillLinked = function() return false end,
  IsTradeSkillGuild = function() return false end,
  GetBaseProfessionInfo = function() return { professionName = "Schmiedekunst", professionID = 164 } end,
  GetAllRecipeIDs = function() return { 2662, 2660, 3115, 7408 } end,
  GetRecipeInfo = function(id)
    local r = { [2660] = "Rough Sharpening Stone", [2662] = "Copper Chain Pants", [3115] = "Rough Copper Vest", [7408] = "Heavy Copper Maul" }
    return { name = r[id], learned = id ~= 7408 }
  end,
}`;

const CLASSIC_PROFS = `
GetProfessions = nil; GetProfessionInfo = nil; C_TradeSkillUI = nil
local lines = { {"Professions", true}, {"Tailoring", false, 150, 150}, {"Enchanting", false, 100, 150},
  {"Secondary Skills", true}, {"First Aid", false, 30, 75}, {"Weapon Skills", true}, {"Swords", false, 100, 115} }
function GetNumSkillLines() return #lines end
function GetSkillLineInfo(i) local l = lines[i]; return l[1], l[2], nil, l[3], nil, nil, l[4] end
__tradeLine = "Tailoring"
function GetTradeSkillLine() return __tradeLine, 150, 150 end
__ts = {
  { "Cloth", "header" },
  { "Brown Linen Shirt", "trivial", 3915, 2576 },
  { "Linen Belt", "medium", 8776, 7026 },
  { "Heavy Linen Gloves", "easy", 3840, 4307 },
}
function GetNumTradeSkills() return #__ts end
function GetTradeSkillInfo(i) local t = __ts[i]; return t[1], t[2], 0 end
function GetTradeSkillRecipeLink(i) local t = __ts[i]; if t[3] then return "|cffffd000|Henchant:" .. t[3] .. "|h[Tailoring: " .. t[1] .. "]|h|r" end end
function GetTradeSkillItemLink(i) local t = __ts[i]; if t[4] then return "|cffffffff|Hitem:" .. t[4] .. "::::::::60:::::|h[" .. t[1] .. "]|h|r" end end
__crafts = { { "Enchant Bracer - Minor Health", 7418 }, { "Bracer", nil, "header" }, { "Enchant Chest - Minor Mana", 7443 } }
function GetNumCrafts() return #__crafts end
function GetCraftDisplaySkillLine() return "Enchanting" end
function GetCraftInfo(i) local c = __crafts[i]; return c[1], nil, c[3] or "optimal" end
function GetCraftRecipeLink(i) local c = __crafts[i]; if c[2] then return "|cffffd000|Henchant:" .. c[2] .. "|h[" .. c[1] .. "]|h|r" end end
function GetCraftItemLink(i) local c = __crafts[i]; if c[2] then return "|cffffd000|Henchant:" .. c[2] .. "|h[" .. c[1] .. "]|h|r" end end`;

const PVP = `
function UnitPVPRank() return 6 end
function GetPVPRankInfo(r) return "Scout", r - 4 end
function GetPVPLifetimeStats() return 120, 3, 7 end`;

// A logged-in client with the sharing stub. player/inbox/savedVariables/mocks as WowClient takes them.
function client({ iface, name = 'Thrallia', pid = PID, inbox, mocks = '', savedVariables, gameData } = {}) {
  const wow = new WowClient({
    interface: iface, savedVariables, gameData,
    player: { name, realm: 'Forever', classToken: 'SHAMAN', raceToken: 'Orc', level: 60, faction: 'Horde', guild: 'wow' },
    inbox,
  });
  wow.exec(mocks);
  wow.exec(STUB(pid));
  wow.login();
  wow.exec(STUB(pid)); // again, in case Share.lua set itself up at login
  return wow;
}
const profsFor = (iface) => (iface === 120105 ? RETAIL_PROFS : CLASSIC_PROFS);
const ME = { pid: PID, bt: 'Calvin#1234', main: 'Thrallia', alts: ['Thrallia', 'Zuljinne'] };
const noError = (wow) => assert.equal(wow.eval('__ns.debugError'), null, 'no addon errors');

// Encode a record as the engine would, check it with BOTH codecs, and return the app's decoding.
function roundTrip(wow, expr, author) {
  const str = wow.lua(`__encode(${expr}${author ? `, ${toLua(author)}` : ''})`);
  assert.equal(typeof str, 'string');
  assert.equal(S.checkRecord(str, T + 60, () => null), null, `the app accepts ${str}`);
  assert.equal(wow.lua(`ns.ShareCodec.checkRecord(${toLua(str)}, ${T + 60})`), null, 'the addon accepts it too');
  assert.ok(Buffer.byteLength(str) <= S.maxFor(S.decode(str).type, S.decode(str).fields), 'within its type\'s size');
  return S.decode(str);
}

// ---------------------------------------------------------------- ch

for (const iface of IFACES) {
  test(`ch on ${iface}: pid, BattleTag, main and alts from the app; class, level, readiness, professions, pvp, addon`, () => {
    const wow = client({ iface, inbox: { guild: 'wow', me: ME }, mocks: profsFor(iface) + PVP });
    const ch = wow.lua('ns.Collect.ch()');
    assert.equal(ch.type, 'ch');
    assert.equal(ch.key, 'Thrallia');
    const rec = roundTrip(wow, 'ns.Collect.ch()');
    assert.equal(rec.id, 'ch:Thrallia');
    const f = rec.fields;
    assert.equal(f.pid, PID);
    assert.equal(f.battletag, 'Calvin#1234');
    assert.equal(f.main, true);
    assert.deepEqual(f.alts, ['Thrallia', 'Zuljinne'], 'the anchor lists its alts');
    assert.deepEqual([f.class, f.race, f.level, f.faction], ['SHAMAN', 'Orc', 60, 'Horde']);
    assert.equal(f.ilvl, 58, 'equipped item level, rounded');
    assert.equal(f.repair, 50);
    assert.deepEqual(f.consumables, { flask: 0, elixir: 0, potion: 5, food: 0, bandage: 10 });
    const expectProfs = iface === 120105
      ? [{ skill: 164, rank: 120, max: 150 }, { skill: 186, rank: 140, max: 150 }, { skill: 356, rank: 40, max: 75 }, { skill: 185, rank: 80, max: 150 }]
      : [{ skill: 197, rank: 150, max: 150 }, { skill: 333, rank: 100, max: 150 }, { skill: 129, rank: 30, max: 75 }];
    assert.deepEqual(f.professions, expectProfs, 'skill-line ids: from the game on Retail (any language), from English names on 16001');
    assert.deepEqual(f.pvp, { rank: 2, hk: 120 });
    assert.equal(f.addon, wow.lua('ns.addonVersion()'));
    // The saved professions the app reads keep their shape (Retail adds the game's skill-line id).
    const saved = wow.db().characters.Thrallia.professions[0];
    assert.deepEqual(saved, iface === 120105 ? { name: 'Schmiedekunst', skill: 120, max: 150, id: 164 } : { name: 'Tailoring', skill: 150, max: 150 });
    noError(wow);
  });

  test(`ch on ${iface}: an alt names the pid and BattleTag but lists no alts and is not the main`, () => {
    const wow = client({ iface, name: 'Zuljinne', inbox: { guild: 'wow', me: ME }, mocks: profsFor(iface) });
    const f = roundTrip(wow, 'ns.Collect.ch()').fields;
    assert.equal(f.pid, PID);
    assert.equal(f.battletag, 'Calvin#1234');
    assert.equal(f.main, false);
    assert.deepEqual(f.alts, [], 'alts travel only in the anchor\'s ch');
  });
}

test('ch without the app: the anchor is the main and lists this account\'s characters in its guild and realm', () => {
  const sv = `WowGuildDB = { characters = {
    Zuljinne = { name = "Zuljinne", guild = "wow", realm = "Forever", level = 20 },
    Bankie = { name = "Bankie", guild = "wow", realm = "Forever", level = 1 },
    Elsewhere = { name = "Elsewhere", guild = "Other Guild", realm = "Forever" },
    Otherrealm = { name = "Otherrealm", guild = "wow", realm = "Somewhere Else" },
    Guildless = { name = "Guildless", realm = "Forever" },
  } }`;
  const wow = client({ iface: 16001, savedVariables: sv, mocks: CLASSIC_PROFS });
  const f = roundTrip(wow, 'ns.Collect.ch()').fields;
  assert.equal(f.main, true, 'the pid\'s anchor is the main by default');
  assert.equal(f.battletag, '', 'no BattleTag without the app');
  assert.deepEqual(f.alts, ['Thrallia', 'Bankie', 'Zuljinne']);
  // A character that is not the anchor lists nobody, and with no pid the record still builds.
  const alt = client({ iface: 16001, name: 'Zuljinne', savedVariables: sv, mocks: CLASSIC_PROFS });
  assert.deepEqual(roundTrip(alt, 'ns.Collect.ch()').fields.alts, []);
  const nopid = client({ iface: 16001, pid: null, mocks: CLASSIC_PROFS });
  const ch = nopid.lua('ns.Collect.ch()');
  assert.equal(ch.fields.pid, undefined);
  assert.equal(ch.fields.main, false);
  noError(nopid);
});

test('ch stays within 400 bytes: a very long alt list is shortened, never the record refused', () => {
  const alts = Array.from({ length: 20 }, (_, i) => `Altcharacter${String.fromCharCode(97 + i)}xyzw`);
  const wow = client({ iface: 120105, inbox: { guild: 'wow', me: { ...ME, alts } }, mocks: RETAIL_PROFS });
  const rec = roundTrip(wow, 'ns.Collect.ch()');
  assert.ok(rec.fields.alts.length > 5 && rec.fields.alts.length < 20, `${rec.fields.alts.length} alts kept`);
  assert.deepEqual(rec.fields.alts, alts.slice(0, rec.fields.alts.length), 'the first ones are kept');
  assert.equal(rec.fields.professions.length, 4, 'nothing else is lost');
});

test('the profession skill map works in other languages through the game\'s own profession names', () => {
  for (const iface of IFACES) {
    const wow = client({ iface, mocks: CLASSIC_PROFS + '\n__tradeLine = "Schneiderei"', gameData: { spells: { 3908: 'Schneiderei', 7411: 'Verzauberkunst' } } });
    assert.equal(wow.lua('ns.Collect.skillId("Schneiderei")'), 197, `${iface}: German Tailoring`);
    assert.equal(wow.lua('ns.Collect.skillId("verzauberkunst")'), 333, 'any case');
    assert.equal(wow.lua('ns.Collect.skillId("Tailoring")'), 197, 'English still works');
    assert.equal(wow.lua('ns.Collect.skillId("Basket Weaving")'), null);
    assert.equal(wow.lua('ns.Collect.skillId(nil)'), null);
    wow.fire('TRADE_SKILL_SHOW');
    assert.equal(wow.db().characters.Thrallia.recipeSkills.Schneiderei, 197);
  }
});

// ---------------------------------------------------------------- rc

for (const iface of IFACES) {
  test(`rc on ${iface}: one record per profession, keyed name:skill, with spell ids`, () => {
    const wow = client({ iface, mocks: profsFor(iface) });
    wow.fire('TRADE_SKILL_SHOW');
    wow.fire('CRAFT_SHOW');
    const recs = wow.lua('ns.Collect.rc()');
    if (iface === 120105) {
      assert.deepEqual(recs.map((r) => r.key), ['Thrallia:4k'], 'Blacksmithing is 164 = "4k" in base36, whatever the language');
      assert.deepEqual(recs[0].fields, { kind: 's', count: 3, list: [2660, 2662, 3115] }, 'learned recipes only, sorted');
    } else {
      assert.deepEqual(recs.map((r) => r.key), ['Thrallia:99', 'Thrallia:5h'], 'Enchanting (333) and Tailoring (197)');
      assert.deepEqual(recs[0].fields, { kind: 's', count: 2, list: [7418, 7443] }, 'craft window: spell ids from GetCraftRecipeLink');
      assert.deepEqual(recs[1].fields, { kind: 's', count: 3, list: [3840, 3915, 8776] }, 'trade skill window: spell ids from GetTradeSkillRecipeLink');
      // The ids are saved next to the names the app already reads.
      assert.deepEqual(wow.db().characters.Thrallia.recipes.Tailoring[0], { name: 'Brown Linen Shirt', id: 3915, item: 2576 });
    }
    for (let i = 1; i <= recs.length; i++) {
      const rec = roundTrip(wow, `ns.Collect.rc()[${i}]`);
      assert.equal(rec.type, 'rc');
      assert.equal(rec.author, 'Thrallia', 'rc is written by its own character');
    }
    noError(wow);
  });

  test(`rc on ${iface}: without recipe links, item ids; without those, names`, () => {
    // No GetTradeSkillRecipeLink: the crafted items' ids.
    const items = client({ iface, mocks: CLASSIC_PROFS + '\nGetTradeSkillRecipeLink = nil' });
    items.fire('TRADE_SKILL_SHOW');
    let rc = items.lua('ns.Collect.rc()')[0];
    assert.deepEqual([rc.key, rc.fields], ['Thrallia:5h', { kind: 'i', count: 3, list: [2576, 4307, 7026] }]);
    roundTrip(items, 'ns.Collect.rc()[1]');
    // One recipe without a spell id: item ids for all (they all have one).
    const mixed = client({ iface, mocks: CLASSIC_PROFS + '\n__ts[3][3] = nil' });
    mixed.fire('TRADE_SKILL_SHOW');
    assert.deepEqual(mixed.lua('ns.Collect.rc()')[0].fields, { kind: 'i', count: 3, list: [2576, 4307, 7026] });
    // No links at all: names (kind n), sorted, duplicates once.
    const names = client({ iface, mocks: CLASSIC_PROFS + '\nGetTradeSkillRecipeLink = nil; GetTradeSkillItemLink = nil\n__ts[5] = { "Linen Belt", "trivial" }' });
    names.fire('TRADE_SKILL_SHOW');
    rc = names.lua('ns.Collect.rc()')[0];
    assert.deepEqual(rc.fields, { kind: 'n', count: 3, list: ['Brown Linen Shirt', 'Heavy Linen Gloves', 'Linen Belt'] });
    const rec = roundTrip(names, 'ns.Collect.rc()[1]');
    assert.deepEqual(rec.fields.list, ['Brown Linen Shirt', 'Heavy Linen Gloves', 'Linen Belt']);
    // A craft window without links: names too.
    const crafts = client({ iface, mocks: CLASSIC_PROFS + '\nGetCraftRecipeLink = nil; GetCraftItemLink = nil' });
    crafts.fire('CRAFT_SHOW');
    assert.deepEqual(crafts.lua('ns.Collect.rc()')[0].fields, { kind: 'n', count: 2, list: ['Enchant Bracer - Minor Health', 'Enchant Chest - Minor Mana'] });
    // Recipes saved by an older addon (names only) still share, as names.
    const old = client({ iface, mocks: CLASSIC_PROFS, savedVariables: 'WowGuildDB = { characters = { Thrallia = { recipes = { Tailoring = { { name = "Old Recipe" } } } } } }' });
    assert.deepEqual(old.lua('ns.Collect.rc()')[0].fields, { kind: 'n', count: 1, list: ['Old Recipe'] });
    for (const w of [items, mixed, names, crafts, old]) noError(w);
  });
}

test('rc: a dropped profession is not shared, an unknown one is skipped, and a big list is cut to fit', () => {
  const wow = client({ iface: 16001, mocks: CLASSIC_PROFS });
  wow.fire('TRADE_SKILL_SHOW');
  // Recipes saved for a profession the character no longer has, and for one we can't name.
  wow.exec(`local c = WowGuildDB.characters.Thrallia
    c.recipes.Blacksmithing = { { name = "Copper Bracers", id = 2663 } }
    c.recipes["Basket Weaving"] = { { name = "Basket", id = 1 } }`);
  assert.deepEqual(wow.lua('ns.Collect.rc()').map((r) => r.key), ['Thrallia:5h']);
  // Unknown professions (no skill list read yet): every nameable profession is shared.
  wow.exec('WowGuildDB.characters.Thrallia.professions = nil')
  assert.deepEqual(wow.lua('ns.Collect.rc()').map((r) => r.key), ['Thrallia:4k', 'Thrallia:5h']);
  // 2,000 far-apart spell ids do not fit in 2 KB: the list is cut, and count matches it.
  wow.exec(`local list = {}
    for i = 1, 2400 do list[i] = { name = "R" .. i, id = 100000 + i * 997 } end
    WowGuildDB.characters.Thrallia.recipes.Tailoring = list`);
  const rec = roundTrip(wow, 'ns.Collect.rc()[2]');
  assert.equal(rec.key, 'Thrallia:5h');
  assert.equal(rec.fields.kind, 's');
  assert.ok(rec.fields.list.length > 500 && rec.fields.list.length < 2000, `${rec.fields.list.length} ids kept`);
  assert.equal(rec.fields.count, rec.fields.list.length);
  // 500+ long names: cut to fit the 6 KB names limit.
  wow.exec(`local list = {}
    for i = 1, 600 do list[i] = { name = string.rep("Pattern of the long name ", 3) .. i } end
    WowGuildDB.characters.Thrallia.recipes.Tailoring = list`);
  const names = roundTrip(wow, 'ns.Collect.rc()[2]');
  assert.equal(names.fields.kind, 'n');
  assert.ok(names.fields.count > 50 && names.fields.count === names.fields.list.length);
  noError(wow);
});

// ---------------------------------------------------------------- bk

for (const iface of IFACES) {
  test(`bk on ${iface}: only while the officers list this character in BC:1`, () => {
    const wow = client({ iface, mocks: profsFor(iface) });
    wow.fire('BANKFRAME_OPENED');
    assert.equal(wow.lua('ns.Collect.bk()'), null, 'no BC record: not a bank character');
    const bc = (names) => wow.exec(`__shared.recs["BC:1"] = __encode({ type = "BC", key = "1", fields = { names = ${toLua(names)} } }, "Grommash")`);
    bc(['Bankie', 'Gold']);
    assert.equal(wow.lua('ns.Collect.bk()'), null, 'listed names do not include me');
    bc(['Bankie', 'thrallia']);
    const bk = wow.lua('ns.Collect.bk()');
    assert.equal(bk.key, 'Thrallia');
    assert.deepEqual(bk.fields.bags, [{ id: 118, count: 5 }, { id: 2581, count: 10 }, { id: 9999, count: 1 }], 'sorted by item id');
    assert.deepEqual(bk.fields.bank, [{ id: 14047, count: 35 }], 'stacks added together');
    const rec = roundTrip(wow, 'ns.Collect.bk()');
    assert.equal(rec.id, 'bk:Thrallia');
    assert.deepEqual(rec.fields.bank, [{ id: 14047, count: 35 }]);
    // The engine may hand back a decoded record instead of the string.
    wow.exec('__shared.recs["BC:1"] = { id = "BC:1", type = "BC", key = "1", fields = { names = { "Thrallia" } } }');
    assert.equal(wow.lua('ns.Collect.bk()').key, 'Thrallia');
    // A deleted BC, or bank sharing switched off: nothing.
    wow.exec('__shared.recs["BC:1"] = "BC:1^" .. __ns.ShareCodec.makeVersion(1794066000, "Grommash") .. "^Grommash^d"');
    assert.equal(wow.lua('ns.Collect.bk()'), null);
    bc(['Thrallia']);
    wow.exec('WowGuildDB.options.collectBank = false');
    assert.equal(wow.lua('ns.Collect.bk()'), null, 'the "Share my bank" option is respected');
    noError(wow);
  });
}

test('bk: a huge bank is cut to fit 2 KB, bank first', () => {
  const wow = client({ iface: 120105, mocks: RETAIL_PROFS });
  wow.exec(`__shared.recs["BC:1"] = { fields = { names = { "Thrallia" } } }
    local bank = {}
    for i = 1, 300 do bank[i] = { id = 1000000 + i * 37, count = 200 } end
    WowGuildDB.characters.Thrallia.inventory.bank = bank`);
  const rec = roundTrip(wow, 'ns.Collect.bk()');
  assert.equal(rec.fields.bags.length, 3, 'bags kept whole');
  assert.ok(rec.fields.bank.length > 50 && rec.fields.bank.length < 300, `${rec.fields.bank.length} bank items kept`);
});

// ---------------------------------------------------------------- sh

for (const iface of IFACES) {
  test(`sh on ${iface}: my shopping list (recipe, how many, profession), at most 20, keyed by pid`, () => {
    const wow = client({ iface, mocks: profsFor(iface) });
    assert.equal(wow.lua('ns.Collect.sh()'), null, 'an empty list is not shared');
    wow.exec(`__ns.db.shopping = {
      { key = 1, name = "Linen Belt", qty = 5, prof = "Tailoring", reagents = {} },
      { key = 2, name = "Rough Sharpening Stone", qty = 0, prof = "Schmiedekunst", skill = 164, reagents = {} },
      { key = 3, name = "Mystery", qty = 2, prof = "Basket Weaving", reagents = {} },
      { key = 4, qty = 2, reagents = {} },
    }`);
    const sh = wow.lua('ns.Collect.sh()');
    assert.equal(sh.key, PID);
    assert.deepEqual(sh.fields.items, [
      { name: 'Linen Belt', qty: 5, skill: 197 },
      { name: 'Rough Sharpening Stone', qty: 1, skill: 164 },
      { name: 'Mystery', qty: 2 },
    ]);
    const rec = roundTrip(wow, 'ns.Collect.sh()');
    assert.equal(rec.id, `sh:${PID}`);
    assert.deepEqual(rec.fields.items[2], { name: 'Mystery', qty: 2, skill: null });
    // 25 entries with long names: at most 20, then cut to fit 1 KB.
    wow.exec(`local list = {}
      for i = 1, 25 do list[i] = { key = i, name = string.rep("Very long recipe name ", 4) .. i, qty = i, prof = "Tailoring", reagents = {} } end
      __ns.db.shopping = list`);
    const long = roundTrip(wow, 'ns.Collect.sh()');
    assert.ok(long.fields.items.length > 3 && long.fields.items.length <= 20);
    assert.equal(long.fields.items[0].qty, 1);
    // No pid (the engine has none yet): no sh.
    wow.exec('__ns.Share.myPid = function() return nil end');
    assert.equal(wow.lua('ns.Collect.sh()'), null);
    noError(wow);
  });
}

test('the skill-up guide remembers the profession\'s skill line on shopping list entries', () => {
  const wow = client({ iface: 120105, mocks: RETAIL_PROFS + `
C_TradeSkillUI.GetRecipeSchematic = function() return { reagentSlotSchematics = { { reagentType = 1, quantityRequired = 1, reagents = { { itemID = 2835 } } } } } end` });
  wow.fire('TRADE_SKILL_SHOW');
  wow.exec('__ns.prof.addToList(__ns.prof.current.recipes[1], 2)');
  assert.equal(wow.db().shopping[0].skill, 164);
  assert.deepEqual(wow.lua('ns.Collect.sh()').fields.items, [{ name: wow.db().shopping[0].name, qty: 2, skill: 164 }]);
});

// ---------------------------------------------------------------- all together

for (const iface of IFACES) {
  test(`sharedRecords on ${iface}: ch, rc per profession, bk when listed, sh; all valid records`, () => {
    const wow = client({ iface, inbox: { guild: 'wow', me: ME }, mocks: profsFor(iface) });
    wow.fire('TRADE_SKILL_SHOW');
    wow.fire('CRAFT_SHOW');
    wow.fire('BANKFRAME_OPENED');
    let all = wow.lua('ns.Collect.sharedRecords()');
    const rcCount = iface === 120105 ? 1 : 2;
    assert.deepEqual(all.map((r) => r.type), ['ch', ...Array(rcCount).fill('rc')], 'no bk (not listed), no sh (empty list)');
    wow.exec('__shared.recs["BC:1"] = { fields = { names = { "Thrallia" } } }');
    wow.exec('__ns.db.shopping = { { key = 1, name = "Linen Belt", qty = 5, prof = "Tailoring", reagents = {} } }');
    all = wow.lua('ns.Collect.sharedRecords()');
    assert.deepEqual(all.map((r) => r.type), ['ch', ...Array(rcCount).fill('rc'), 'bk', 'sh']);
    for (const r of all) {
      assert.deepEqual(Object.keys(r).sort(), ['fields', 'key', 'type']);
      for (const name of Object.keys(r.fields)) {
        const specs = S.fieldsFor(r.type, r.key);
        assert.ok(specs.some((s) => s.n === name), `${r.type}.${name} is a field of the type table`);
      }
    }
    for (let i = 1; i <= all.length; i++) roundTrip(wow, `ns.Collect.sharedRecords()[${i}]`);
    noError(wow);
  });
}

test('without Share.lua (or before it loads) the collectors still work and nothing errors', () => {
  const wow = new WowClient({ interface: 16001 });
  wow.exec(CLASSIC_PROFS);
  wow.exec('__ns.Share = nil');
  wow.login();
  wow.exec('__ns.Share = nil');
  wow.fire('TRADE_SKILL_SHOW');
  wow.fire('BANKFRAME_OPENED');
  const all = wow.lua('ns.Collect.sharedRecords()');
  assert.deepEqual(all.map((r) => r.type), ['ch', 'rc'], 'no pid: no sh; no BC: no bk');
  assert.equal(all[0].fields.pid, undefined);
  // Without the codec either, records are still built (just not size-checked).
  wow.exec('__ns.ShareCodec = nil');
  assert.equal(wow.lua('ns.Collect.rc()')[0].key, 'Thrallia:5h');
  wow.logout();
  assert.ok(wow.db().characters.Thrallia.recipes.Tailoring.length === 3, 'the app\'s data is saved as before');
  assert.equal(wow.eval('__ns.debugError'), null);
});

test('a builder that fails is reported and the others still come back', () => {
  const wow = client({ iface: 120105, mocks: RETAIL_PROFS });
  wow.exec('__ns.db.shopping = { { key = 1, name = "Linen Belt", qty = 5, prof = "Tailoring", reagents = {} } }');
  wow.exec('__ns.Collect.rc = function() error("boom") end');
  const all = wow.lua('ns.Collect.sharedRecords()');
  assert.deepEqual(all.map((r) => r.type), ['ch', 'sh']);
  assert.match(wow.eval('__ns.debugError'), /boom/);
});
