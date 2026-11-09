'use strict';
// SHARING.md step 4 with the real sharing engine (Share.lua, ShareSync.lua) under GuildNet:
//   - scenario 1: A sounds a call to arms; it is in B's chat within 2 s and in B's store;
//   - the records Collect.lua builds (ch, rc, gb, bk, sh) reach a guildmate's store, including ones
//     that change mid-session (a profession window opened, a guild bank visit, a bank character's bank).
// Both game versions talk to each other: 16001 (WoW: Forever) and 120105 (Retail).
const test = require('node:test');
const assert = require('node:assert/strict');
const { createGuildNet } = require('./guildnet');

const PID = 'Thrallia.p4m7';
const ME = { pid: PID, bt: 'Calvin#1234', main: 'Thrallia', alts: ['Thrallia', 'Zuljinne'] };

// Thrallia's game: a Tailoring window with recipe links (WoW: Forever style), a guild bank.
const THRALLIA_MOCKS = `
GetProfessions = nil; GetProfessionInfo = nil; C_TradeSkillUI = nil
local lines = { {"Professions", true}, {"Tailoring", false, 150, 150}, {"Secondary Skills", true}, {"First Aid", false, 30, 75} }
function GetNumSkillLines() return #lines end
function GetSkillLineInfo(i) local l = lines[i]; return l[1], l[2], nil, l[3], nil, nil, l[4] end
function GetTradeSkillLine() return "Tailoring", 150, 150 end
local ts = { { "Cloth", "header" }, { "Brown Linen Shirt", "trivial", 3915, 2576 }, { "Linen Belt", "medium", 8776, 7026 } }
function GetNumTradeSkills() return #ts end
function GetTradeSkillInfo(i) local t = ts[i]; return t[1], t[2], 0 end
function GetTradeSkillRecipeLink(i) local t = ts[i]; if t[3] then return "|Henchant:" .. t[3] .. "|h[" .. t[1] .. "]|h" end end
function GetTradeSkillItemLink(i) local t = ts[i]; if t[4] then return "|Hitem:" .. t[4] .. "|h[" .. t[1] .. "]|h" end end
local gb = { [1] = { name = "Mats", slots = { [1] = {"|Hitem:14047|h[Runecloth]|h", 20} } } }
function GetNumGuildBankTabs() return 1 end
function GetGuildBankTabInfo(t) return gb[t].name, "icon", true end
function GetGuildBankItemLink(t, s) local x = gb[t].slots[s]; return x and x[1] end
function GetGuildBankItemInfo(t, s) local x = gb[t].slots[s]; return "tex", x and x[2] or 0 end
function QueryGuildBankTab() end
function QueryGuildBankLog() end
function GetGuildBankMoney() return 1234567 end`;

const ready = (c) => c.lua('ns.Share and ns.Share.ready and ns.Share.ready() or false') === true;
const storeHas = (c, id) => c.lua(`(function() local r = ns.Share.get(${JSON.stringify(id)}); return r ~= nil and not r.del end)()`) === true;
const record = (c, id) => c.lua(`ns.Share.get(${JSON.stringify(id)})`);
const noErrors = (net) => { for (const c of net.clients) assert.deepEqual(c.errors, [], `${c.name}: no Lua errors`); };

for (const [ia, ib] of [[16001, 120105], [120105, 16001]]) {
  test(`scenario 1, ${ia} → ${ib}: a call to arms is in the guildmate's chat within 2 s and in their store`, () => {
    const net = createGuildNet({ seed: ia });
    const a = net.client('Thrallia', { rank: 3, interface: ia, inbox: { guild: 'wow', me: ME } }).login();
    const b = net.client('Zuljin', { rank: 3, interface: ib }).login();
    assert.ok(net.runUntil(() => ready(a) && ready(b), { max: 120 }), 'both sharing');
    net.run(120); // hellos and the first exchange settle
    a.lua('SlashCmdList.WOWGUILD("cta Crossroads 5 Alliance at the flight master")');
    const sent = net.now();
    assert.match(a.chat.at(-1), /Call to arms sent to your guild: Crossroads\./);
    const heard = () => b.chat.some((l) => /Call to arms from Thrallia in Crossroads, 5 needed: Alliance at the flight master/.test(l));
    assert.ok(net.runUntil(heard, { max: 2, step: 0.05 }), `in B's chat within 2 s (chat: ${b.chat.slice(-3).join(' | ')})`);
    assert.ok(net.now() - sent <= 2);
    const cas = b.lua('ns.Share.list("ca")');
    assert.equal(cas.length, 1);
    assert.equal(cas[0].author, 'Thrallia');
    assert.deepEqual(cas[0].fields, { character: 'Thrallia', zone: 'Crossroads', needed: 5, message: 'Alliance at the flight master' });
    assert.deepEqual(a.lua('ns.Share.list("ca")')[0].v, cas[0].v, 'the same record in both stores');
    assert.ok(b.sounds.length >= 1, 'a sound');
    // B's Call to arms tab lists it; A's lists its own.
    assert.deepEqual(b.lua('ns.ctaRecent').map((c) => [c.character, c.zone, c.needed]), [['Thrallia', 'Crossroads', 5]]);
    assert.deepEqual(a.lua('ns.ctaRecent').map((c) => [c.zone, c.mine]), [['Crossroads', true]]);
    // Nothing queued for the app any more.
    a.logout();
    assert.equal(a.sv().ctaQueue, undefined);
    noErrors(net);
  });
}

test('the records Collect.lua builds reach a guildmate: ch and rc at ready, then rc, gb, bk and sh as they change', () => {
  const net = createGuildNet({ seed: 4 });
  const a = net.client('Thrallia', { rank: 3, interface: 16001, classToken: 'SHAMAN', inbox: { guild: 'wow', me: ME }, mocks: THRALLIA_MOCKS }).login();
  const officer = net.client('Grommash', { rank: 1, interface: 120105 }).login();
  assert.ok(net.runUntil(() => ready(a) && ready(officer), { max: 120 }));
  // At ready: ch (no recipes saved yet, so no rc).
  assert.ok(net.runUntil(() => storeHas(officer, 'ch:Thrallia'), { max: 300 }), 'ch arrives');
  const ch = record(officer, 'ch:Thrallia').fields;
  assert.deepEqual([ch.pid, ch.battletag, ch.main, ch.class], [PID, 'Calvin#1234', true, 'SHAMAN']);
  assert.deepEqual(ch.alts, ['Thrallia', 'Zuljinne']);
  assert.deepEqual(ch.professions, [{ skill: 197, rank: 150, max: 150 }, { skill: 129, rank: 30, max: 75 }]);
  // Opening the Tailoring window mid-session shares the recipes, with their spell ids.
  a.fire('TRADE_SKILL_SHOW');
  assert.ok(net.runUntil(() => storeHas(officer, 'rc:Thrallia:5h'), { max: 120 }), 'rc arrives after the window opens');
  assert.deepEqual(record(officer, 'rc:Thrallia:5h').fields, { kind: 's', count: 2, list: [3915, 8776] });
  // A guild bank visit: each tab offered when the bank closes.
  a.fire('GUILDBANKFRAME_OPENED');
  net.run(2);
  a.fire('GUILDBANKFRAME_CLOSED');
  assert.ok(net.runUntil(() => storeHas(officer, 'gb:0') && storeHas(officer, 'gb:1'), { max: 120 }), 'guild bank tabs arrive');
  assert.equal(record(officer, 'gb:0').fields.money, 1234567);
  assert.deepEqual(record(officer, 'gb:1').fields.items, [{ id: 14047, count: 20 }]);
  // The officers make Thrallia a bank character; her next bank visit shares her stock.
  officer.lua('ns.Share.putLocal("BC", "1", { names = { "Thrallia" } })');
  assert.ok(net.runUntil(() => storeHas(a, 'BC:1'), { max: 60 }), 'BC reaches Thrallia');
  a.fire('BANKFRAME_OPENED');
  assert.ok(net.runUntil(() => storeHas(officer, 'bk:Thrallia'), { max: 120 }), 'bk arrives');
  assert.deepEqual(record(officer, 'bk:Thrallia').fields.bank, [{ id: 14047, count: 35 }]);
  // A shopping list entry.
  a.lua('ns.db.shopping = { { key = 1, name = "Linen Belt", qty = 4, prof = "Tailoring", reagents = {} } }; ns.Collect.changed()');
  assert.ok(net.runUntil(() => storeHas(officer, `sh:${PID}`), { max: 120 }), 'sh arrives');
  assert.deepEqual(record(officer, `sh:${PID}`).fields.items, [{ name: 'Linen Belt', qty: 4, skill: 197 }]);
  const stats = net.stats();
  assert.equal(stats.dropped.throttle, 0, 'never over the game\'s throttle');
  noErrors(net);
});
