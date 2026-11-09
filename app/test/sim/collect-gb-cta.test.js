'use strict';
// SHARING.md step 4, the other half: guild bank tabs offered to the sharing engine as gb records when
// the guild bank closes, and /wow cta going out at once as a ca record (the old ctaQueue is gone),
// on both game versions (16001 WoW: Forever, 120105 Retail). The engine is a stub (ns.Share) that
// records what it is handed; every record is checked with the app's codec.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { WowClient, toLua, ADDON_DIR } = require('./wowsim');
const S = require('../../src/shared/sharing');

const IFACES = [16001, 120105];
const T = 1794066000;

const STUB = `
__shared = { put = {}, offers = {}, slash = {} }
__ns.Share = {
  myPid = function() return "Thrallia.p4m7" end,
  get = function() return nil end,
  offer = function(t, key, fields) table.insert(__shared.offers, { type = t, key = key, fields = fields }) end,
  putLocal = function(t, key, fields) table.insert(__shared.put, { type = t, key = key, fields = fields }); return true end,
  slash = function(rest) table.insert(__shared.slash, rest) end,
}
function __encode(r, author, t)
  local SC = __ns.ShareCodec
  author = author or __ns.charKey()
  t = t or ${T}
  return SC.encode({ type = r.type, key = r.key, author = author, v = SC.makeVersion(t, author), fields = r.fields })
end`;

const GUILD_BANK = `
__gb = {
  [1] = { name = "Mats", slots = { [1] = {"|Hitem:14047|h[Runecloth]|h", 20}, [2] = {"|Hitem:14047|h[Runecloth]|h", 10},
    [5] = {"|Hitem:13444|h[Major Mana Potion]|h", 4}, [7] = {"|Hitem:2589|h[Linen Cloth]|h", 1} } },
  [2] = { name = "Raid", slots = { [1] = {"|Hitem:13457|h[Greater Fire Protection Potion]|h", 6} } },
  [3] = { name = "Officers", hidden = true, slots = { [1] = {"|Hitem:19019|h[Thunderfury]|h", 1} } },
  [4] = { name = "", slots = {} },
}
__gbLog = {
  [1] = { { "deposit", "Grommash", "|Hitem:14047|h[Runecloth]|h", 10, 0, 0, 3 }, { "withdraw", "Zuljinne", "|Hitem:2589|h[Linen Cloth]|h", 1, 0, 1, 0 } },
}
__gbMoneyLog = { { "withdraw", "Thrallia", 50000, 0, 1, 0 }, { "repair", "Grommash", 1234, 0, 0, 0 } }
function GetNumGuildBankTabs() return #__gb end
function GetGuildBankTabInfo(t) return __gb[t].name, "icon", not __gb[t].hidden end
function GetGuildBankItemLink(t, s) local x = __gb[t].slots[s]; return x and x[1] end
function GetGuildBankItemInfo(t, s) local x = __gb[t].slots[s]; return "tex", x and x[2] or 0 end
function QueryGuildBankTab() end
function QueryGuildBankLog() end
function GetGuildBankMoney() return 1234567 end
function GetNumGuildBankTransactions(t) return __gbLog[t] and #__gbLog[t] or 0 end
function GetGuildBankTransaction(t, i) local l = __gbLog[t][i]; return l[1], l[2], l[3], l[4], 1, nil, 0, l[5], l[6], l[7] end
function GetNumGuildBankMoneyTransactions() return #__gbMoneyLog end
function GetGuildBankMoneyTransaction(i) local l = __gbMoneyLog[i]; return l[1], l[2], l[3], 0, l[4], l[5], l[6] end
Enum = Enum or {}; Enum.PlayerInteractionType = { Banker = 8, GuildBanker = 10 }`;

function client({ iface, mocks = '', player = {}, savedVariables, share = true } = {}) {
  const wow = new WowClient({ interface: iface, savedVariables,
    player: { name: 'Thrallia', realm: 'Forever', classToken: 'SHAMAN', level: 60, guild: 'wow', ...player } });
  wow.exec(mocks);
  if (share) wow.exec(STUB);
  wow.login();
  if (share) wow.exec(STUB);
  return wow;
}
// An empty Lua table comes back as {}: read these lists as arrays.
const list = (v) => (Array.isArray(v) ? v : []);
const offers = (wow) => list(wow.get('__shared.offers'));
const puts = (wow) => list(wow.get('__shared.put'));
const noError = (wow) => assert.equal(wow.eval('__ns.debugError'), null, 'no addon errors');
function check(wow, recExpr) {
  const str = wow.lua(`__encode(${recExpr})`);
  assert.equal(S.checkRecord(str, T + 60, () => null), null, `the app accepts ${str}`);
  assert.equal(wow.lua(`ns.ShareCodec.checkRecord(${toLua(str)}, ${T + 60})`), null, 'the addon accepts it too');
  return S.decode(str);
}

// ---------------------------------------------------------------- gb

for (const iface of IFACES) {
  test(`gb on ${iface}: each guild bank tab is offered when the bank closes; the app's guildBank stays as it was`, () => {
    const wow = client({ iface, mocks: GUILD_BANK });
    const open = iface === 120105 ? () => wow.fire('PLAYER_INTERACTION_MANAGER_FRAME_SHOW', 10) : () => wow.fire('GUILDBANKFRAME_OPENED');
    const close = iface === 120105 ? () => wow.fire('PLAYER_INTERACTION_MANAGER_FRAME_HIDE', 10) : () => wow.fire('GUILDBANKFRAME_CLOSED');
    open();
    wow.fire('GUILDBANKBAGSLOTS_CHANGED');
    assert.deepEqual(offers(wow), [], 'nothing offered while tabs may still be loading');
    const before = Math.floor(Date.now() / 1000);
    close();
    const got = offers(wow);
    assert.deepEqual(got.map((o) => [o.type, o.key]), [['gb', '0'], ['gb', '1'], ['gb', '2'], ['gb', '4']], 'tab 3 is not viewable: not offered');
    const head = got[0].fields;
    assert.ok(Math.abs(head.scannedAt - before) < 5, 'scanned now (server time)');
    assert.equal(head.money, 1234567);
    assert.deepEqual(head.tabs, ['Mats', 'Raid', 'Officers', 'Tab 4'], 'every tab\'s name, by position');
    const hour = head.scannedAt - (head.scannedAt % 3600);
    assert.deepEqual(head.log, [
      { at: hour, kind: 'repair', who: 'Grommash', amount: 1234 },
      { at: hour - 3 * 3600, kind: 'deposit', who: 'Grommash', item: 14047, count: 10 },
      { at: hour - 86400, kind: 'withdraw', who: 'Thrallia', amount: 50000 },
      { at: hour - 86400, kind: 'withdraw', who: 'Zuljinne', item: 2589, count: 1 },
    ], 'newest first, at whole hours');
    assert.deepEqual(got[1].fields, { items: [{ id: 2589, count: 1 }, { id: 13444, count: 4 }, { id: 14047, count: 30 }] }, 'stacks added, sorted by item id');
    assert.deepEqual(got[2].fields, { items: [{ id: 13457, count: 6 }] });
    assert.deepEqual(got[3].fields, { items: {} }, 'an empty tab is offered as empty');
    for (let i = 1; i <= got.length; i++) {
      const rec = check(wow, `__shared.offers[${i}]`);
      assert.equal(rec.type, 'gb');
    }
    assert.deepEqual(check(wow, '__shared.offers[1]').fields.tabs, ['Mats', 'Raid', 'Officers', 'Tab 4']);
    // What the app already reads is unchanged.
    const sv = wow.db().guildBank;
    assert.deepEqual(Object.keys(sv).sort(), ['guild', 'log', 'money', 'scannedAt', 'tabs']);
    assert.deepEqual(sv.tabs.map((t) => [t.name, list(t.items).map((x) => [x.id, x.name, x.count])]), [
      ['Mats', [[14047, 'Runecloth', 30], [13444, 'Major Mana Potion', 4], [2589, 'Linen Cloth', 1]]],
      ['Raid', [[13457, 'Greater Fire Protection Potion', 6]]],
      ['', []],
    ]);
    assert.equal(sv.log.length, 4);
    assert.deepEqual(Object.keys(sv.log.find((l) => l.kind === 'deposit')).sort(), ['at', 'count', 'id', 'kind', 'name', 'who']);
    // Closing again (some clients fire both events) just offers again; the engine decides what to publish.
    close();
    assert.equal(offers(wow).length, 4, 'closed already: no second scan');
    noError(wow);
  });
}

test('gb: tab 0 keeps the newest 25 log lines and fits 1.5 KB', () => {
  const lines = [];
  for (let h = 0; h < 30; h++) lines.push(`{ "deposit", "Character${'x'.repeat(30)}${h}", "|Hitem:${14000 + h}|h[Thing]|h", ${h + 1}, 0, 0, ${h} }`);
  const wow = client({ iface: 16001, mocks: GUILD_BANK + `\n__gbLog[1] = { ${lines.join(', ')} }; __gbMoneyLog = {}` });
  wow.fire('GUILDBANKFRAME_OPENED');
  wow.fire('GUILDBANKFRAME_CLOSED');
  const head = offers(wow)[0].fields;
  assert.ok(head.log.length <= 25 && head.log.length >= 10, `${head.log.length} log lines kept`);
  assert.deepEqual(head.log.map((l) => l.count), Array.from({ length: head.log.length }, (_, i) => i + 1), 'the newest ones');
  const rec = check(wow, '__shared.offers[1]');
  assert.ok(Buffer.byteLength(wow.lua('__encode(__shared.offers[1])')) <= 1536);
  assert.equal(rec.fields.log.length, head.log.length);
});

test('gb: nothing offered with bank sharing off, without Share.lua, or when one offer fails', () => {
  const off = client({ iface: 120105, mocks: GUILD_BANK });
  off.exec('WowGuildDB.options.collectBank = false');
  off.fire('GUILDBANKFRAME_OPENED');
  off.fire('GUILDBANKFRAME_CLOSED');
  assert.deepEqual(offers(off), []);
  assert.equal(off.db().guildBank, undefined);

  const none = client({ iface: 16001, mocks: GUILD_BANK, share: false });
  none.exec('__ns.Share = nil');
  none.fire('GUILDBANKFRAME_OPENED');
  none.fire('GUILDBANKFRAME_CLOSED');
  assert.equal(none.db().guildBank.money, 1234567, 'the app still gets the guild bank');
  noError(none);

  const failing = client({ iface: 16001, mocks: GUILD_BANK });
  failing.exec(`local offer = __ns.Share.offer
    __ns.Share.offer = function(t, key, f) if key == "1" then error("store full") end return offer(t, key, f) end`);
  failing.fire('GUILDBANKFRAME_OPENED');
  failing.fire('GUILDBANKFRAME_CLOSED');
  assert.deepEqual(offers(failing).map((o) => o.key), ['0', '2', '4'], 'the other tabs still go');
  assert.match(failing.eval('__ns.debugError'), /store full/);
});

// ---------------------------------------------------------------- ca

for (const iface of IFACES) {
  test(`/wow cta on ${iface}: a ca record goes to the sharing engine at once`, () => {
    const wow = client({ iface });
    wow.clearOutput();
    wow.slash('cta Crossroads 8 Alliance at the flight master');
    wow.slash('cta 3 help');
    const put = puts(wow);
    assert.equal(put.length, 2);
    assert.deepEqual(put[0].fields, { character: 'Thrallia', zone: 'Crossroads', needed: 8, message: 'Alliance at the flight master' });
    assert.deepEqual(put[1].fields, { character: 'Thrallia', zone: 'The Barrens', needed: 3, message: 'help' });
    for (const p of put) {
      assert.equal(p.type, 'ca');
      assert.match(p.key, /^[0-9a-z]{6}$/);
    }
    assert.notEqual(put[0].key, put[1].key);
    assert.match(wow.printed(), /Call to arms sent to your guild: Crossroads\./);
    assert.equal(wow.eval('__popups'), '0', 'no reload');
    const rec = check(wow, '__shared.put[1]');
    assert.equal(rec.id, `ca:${put[0].key}`);
    assert.deepEqual(rec.fields, put[0].fields);
    // Nothing queued in the saved data.
    wow.logout();
    assert.equal(wow.db().ctaQueue, undefined);
    assert.doesNotMatch(wow.saveVariables(), /ctaQueue/);
    noError(wow);
  });
}

test('/wow cta explains when the call waits or cannot go', () => {
  const wow = client({ iface: 120105 });
  wow.clearOutput();
  wow.exec('__inInstance = true');
  wow.slash('cta Deadmines 2 tank down');
  assert.match(wow.printed(), /Call to arms for Deadmines saved\. Waiting until you leave the dungeon\./);
  wow.exec('__inInstance = false; __inCombat = true');
  wow.slash('cta Hillsbrad 5');
  assert.match(wow.printed(), /Call to arms for Hillsbrad saved\. It goes out when the fight ends\./);
  wow.exec('__inCombat = false');
  assert.equal(puts(wow).length, 2, 'both handed to the engine, which sends them when it can');
  // The engine refuses, or fails.
  wow.exec('__ns.Share.putLocal = function() return false end');
  wow.slash('cta Crossroads');
  assert.match(wow.printed(), /Couldn't send the call to arms\. Try again in a moment\./);
  wow.exec('__ns.Share.putLocal = function() error("no store") end');
  wow.slash('cta Crossroads');
  assert.match(wow.eval('__ns.debugError'), /no store/);
  // Odd numbers are left out rather than sent.
  wow.exec(STUB);
  wow.slash('cta Crossroads 0 hi');
  wow.slash('cta Crossroads 5000 hi');
  assert.deepEqual(puts(wow).map((p) => p.fields.needed), [undefined, undefined]);
  // A long message is cut by the codec; the record is still valid.
  wow.exec(`__ns.addCta("Crossroads", 5, string.rep("Alliance everywhere! ", 20))`);
  assert.ok(Buffer.byteLength(check(wow, '__shared.put[3]').fields.message) <= 200);
  // Not in a guild: nobody to call.
  const loner = client({ iface: 16001, player: { guild: null } });
  loner.slash('cta Crossroads 5');
  assert.match(loner.printed(), /You're not in a guild, so there's nobody to call\./);
  assert.deepEqual(puts(loner), []);
  noError(loner);
});

test('an old call-to-arms queue from addon 0.11 is dropped at load, not sent again', () => {
  const sv = `WowGuildDB = { version = 1, characters = {}, ctaQueue = {
    { zone = "Fresh", msg = "x", at = ${Math.floor(Date.now() / 1000) - 60}, character = "Thrallia" } } }`;
  const wow = client({ iface: 16001, savedVariables: sv });
  assert.equal(wow.db().ctaQueue, undefined);
  assert.deepEqual(puts(wow), []);
  wow.logout();
  const again = new WowClient({ savedVariables: wow.saveVariablesBuffer() }).login();
  assert.equal(again.db().ctaQueue, undefined);
});

test('no ctaQueue left anywhere in the addon but the line that drops it', () => {
  const hits = [];
  for (const f of fs.readdirSync(ADDON_DIR).filter((n) => n.endsWith('.lua'))) {
    fs.readFileSync(path.join(ADDON_DIR, f), 'utf8').split(/\r?\n/).forEach((line, i) => {
      if (/ctaQueue/.test(line) && !line.trim().startsWith('--')) hits.push(`${f}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(hits, [hits.find((h) => /^Core\.lua:\d+: db\.ctaQueue = nil$/.test(h))].filter(Boolean));
  assert.equal(hits.length, 1);
});

test('a guildmate\'s fresh call to arms is listed on the Call to arms tab, once; mine, old ones and seeded ones are not', () => {
  for (const iface of IFACES) {
    const wow = client({ iface });
    const arrive = (rec, how = 'd', from = 'Grommash') => wow.exec(`__ns.ctaArrived(${toLua(rec)}, ${toLua(how)}, ${toLua(from)})`);
    const now = Number(wow.eval('GetServerTime()'));
    const ca = (key, extra = {}) => ({ id: `ca:${key}`, type: 'ca', author: 'Grommash', t: now - 30, fields: { character: 'Grommash', zone: 'Tarren Mill', needed: 5, message: 'they are back' }, ...extra });
    arrive(ca('aaaaaa'));
    arrive(ca('aaaaaa'), 'm', 'Zuljin'); // the same call again, passed on by someone else
    arrive(ca('bbbbbb', { author: 'Thrallia' }), 'd', 'Thrallia'); // my own, from another session
    arrive(ca('cccccc', { t: now - 3600 }));                       // an hour old
    arrive(ca('dddddd'), 's', 'Thrallia');                         // seeded by the app
    arrive(ca('eeeeee', { del: true, fields: null }));            // deleted
    arrive({ id: 'lp:x', type: 'lp', author: 'Grommash', t: now, fields: {} });
    arrive(ca('ffffff', { fields: { zone: '', needed: 0 } }), 'd', 'Zuljin');
    const recent = wow.lua('ns.ctaRecent');
    assert.deepEqual(recent.map((c) => [c.character, c.zone, c.needed, c.message]),
      [['Grommash', 'Tarren Mill', 5, 'they are back'], ['Grommash', 'somewhere', undefined, '']]);
    noError(wow);
  }
});

// ---------------------------------------------------------------- /wow share

test('/wow share hands the rest to the sharing engine, and says so when it is not running', () => {
  const wow = client({ iface: 120105 });
  wow.slash('share');
  wow.slash('share status now');
  assert.deepEqual(wow.get('__shared.slash'), ['', 'status now']);
  wow.exec('__ns.Share = nil');
  wow.clearOutput();
  wow.slash('share');
  assert.match(wow.printed(), /Sharing with your guild isn't running\. Restart World of Warcraft to finish the addon update\. A \/reload isn't enough\./);
  wow.clearOutput();
  wow.slash('help');
  assert.match(wow.printed(), /\/wow share {2}how sharing with your guild is going/);
  // The Camp tab shows the engine's status line too.
  wow.exec(STUB);
  wow.exec('__ns.Share.statusLine = function() return "Sharing with 7 guildmates. 1,368 records." end; __ns.ui.show("camp")');
  assert.ok(wow.texts().some((t) => /\|cff999999Sharing with 7 guildmates\. 1,368 records\.\|r/.test(t)));
  wow.exec('__ns.Share.statusLine = function() error("not yet") end; __ns.ui.show("camp")');
  noError(wow);
});

test('the problem report says whether sharing runs and which recipe ids the game gave', () => {
  const wow = client({ iface: 16001, mocks: `
GetProfessions = nil; C_TradeSkillUI = nil
local lines = { {"Professions", true}, {"Tailoring", false, 150, 150} }
function GetNumSkillLines() return #lines end
function GetSkillLineInfo(i) local l = lines[i]; return l[1], l[2], nil, l[3], nil, nil, l[4] end
function GetTradeSkillLine() return "Tailoring" end
function GetNumTradeSkills() return 1 end
function GetTradeSkillInfo() return "Linen Belt", "medium", 0 end
function GetTradeSkillItemLink() return "|Hitem:7026::|h[Linen Belt]|h" end` });
  wow.fire('TRADE_SKILL_SHOW');
  wow.slash('debug');
  const report = wow.eval('WowGuildReport.edit:GetText()');
  assert.match(report, /sharing: on, player id Thrallia\.p4m7/);
  assert.match(report, /recipes shared: Tailoring item ids \(1\)/);
  wow.exec('__ns.Share = nil; WowGuildDB.characters.Thrallia.recipes = nil');
  wow.slash('debug');
  const bare = wow.eval('WowGuildReport.edit:GetText()');
  assert.match(bare, /sharing: not loaded/);
  assert.match(bare, /recipes shared: none yet \(open a profession window\)/);
  assert.doesNotMatch(bare, /calls to arms waiting/);
  noError(wow);
});
