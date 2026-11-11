'use strict';
// The Market and Professions sections of the guild window (MainUI.lua): Deal hunter, Price alerts, Guildies need.
const test = require('node:test');
const assert = require('node:assert');
const { WowClient } = require('./wowsim');

const noError = (wow) => assert.strictEqual(wow.eval('__ns.debugError'), null, 'no addon errors');
const txt = (wow, expr) => wow.eval(`tostring(${expr}:GetText())`);
const shown = (wow, expr) => wow.eval(`tostring(${expr}:IsShown())`);

const INBOX = {
  guild: 'wow',
  prices: [{ id: 2589, price: 1000 }, { id: 2592, price: 4000 }],
  deals: {
    realm: "Zul'jin Horde", day: '2026-11-09',
    items: [
      { id: 14047, name: 'Runecloth', buy: 30000, worth: 50000, profit: 17500, sure: 'high' },
      { id: 13510, name: 'Flask of the Titans', buy: 250000, worth: 400000, profit: 130000, sure: 'low' },
    ],
    vendor: [{ id: 4338, name: 'Mageweave Cloth', buy: 500, worth: 2000, profit: 1500, sure: 'certain' }],
  },
};
const AUCTIONATOR = `Auctionator = { API = { v1 = { GetAuctionPriceByItemID = function(_, id) return __live and __live[id] end } } }`;

function client(inbox = INBOX) {
  const wow = new WowClient({ inbox });
  wow.exec(AUCTIONATOR);
  wow.login();
  wow.clearOutput();
  return wow;
}

test('Deal hunter page: each deal with buy, worth, profit and how sure; live prices mark what is gone', () => {
  const wow = client();
  wow.exec('__ns.ui.show("deals")');
  const p = 'WowGuildWindow.pages.deals';
  assert.ok(wow.texts().includes('3 worth buying  |cff999999about 14g 90s if you flip them all|r'));
  assert.deepStrictEqual([1, 2, 3].map((i) => txt(wow, `${p}.rows[${i}].name`)), ['Mageweave Cloth', 'Runecloth', 'Flask of the Titans']);
  assert.deepStrictEqual(['buy', 'worth', 'profit', 'state'].map((f) => txt(wow, `${p}.rows[1].${f}`)), ['5s 0c', '20s 0c', '+15s 0c', '|cff40bf40sells to a vendor|r']);
  assert.strictEqual(txt(wow, `${p}.rows[2].state`), '|cff40bf40likely|r');
  assert.strictEqual(txt(wow, `${p}.rows[3].state`), '|cff999999risky|r');
  assert.strictEqual(shown(wow, `${p}.rows[4]`), 'false');
  // This session's prices: Runecloth is still cheap, the flask went up past its worth.
  wow.exec('__live = { [14047] = 29000, [13510] = 450000 }; __ns.ui.show("deals")');
  assert.strictEqual(txt(wow, `${p}.rows[2].state`), '|cff40bf40likely|r  |cff40bf40still there|r');
  assert.strictEqual(txt(wow, `${p}.rows[2].profit`), '+1g 85s');
  assert.strictEqual(txt(wow, `${p}.rows[3].state`), '|cff999999gone|r');
  assert.strictEqual(txt(wow, `${p}.rows[3].profit`), '');
  assert.ok(wow.texts().some((t) => /^2 worth buying/.test(t)));
  noError(wow);
});

test('Deal hunter page: no deals says where they come from', () => {
  const wow = client({ guild: 'wow' });
  wow.exec('__ns.ui.show("deals")');
  assert.ok(wow.texts().some((t) => /^No deals yet\. They come from the Guild Camp app/.test(t)));
  assert.strictEqual(shown(wow, 'WowGuildWindow.pages.deals.rows[1]'), 'false');
  noError(wow);
});

test('Price alerts page: what is watched and why; set my own target, remove it; a bad entry is explained', () => {
  const wow = client();
  wow.exec(`__ns.ahTab = __ns.ahTab or {}
    __ns.ahTab.lines = function() return { { id = 2592, name = "Wool Cloth", kind = "list", qty = 10 }, { id = 2589, name = "Linen Cloth", kind = "guild", who = "Mokra", qty = 20 } } end
    __ns.ui.show("alerts")`);
  const p = 'WowGuildWindow.pages.alerts';
  assert.ok(wow.texts().includes('Watching 2 items at the auction house'));
  assert.deepStrictEqual([1, 2].map((i) => txt(wow, `${p}.rows[${i}].name`)), ['Linen Cloth', 'Wool Cloth']);
  assert.strictEqual(txt(wow, `${p}.rows[1].target`), 'under 8s 50c');
  assert.strictEqual(txt(wow, `${p}.rows[1].why`), '|cff99999985% of the usual 10s 0c · guild bank request from Mokra|r');
  assert.strictEqual(txt(wow, `${p}.rows[2].why`), '|cff99999985% of the usual 40s 0c · your shopping list|r');
  assert.strictEqual(shown(wow, `${p}.rows[1].btn`), 'false', 'only my own targets can be removed');
  // My own target, by item link: it moves to the top and can be removed.
  wow.exec(`${p}.input:SetText("50s |cffffffff|Hitem:2592::::::::|h[Wool Cloth]|h|r")`);
  wow.click(`${p}.go`);
  assert.match(txt(wow, `${p}.status`), /^Price alert: .*Wool Cloth.* under 50s 0c\.$/);
  assert.strictEqual(txt(wow, `${p}.input`), '');
  assert.strictEqual(txt(wow, `${p}.rows[1].name`), 'Wool Cloth');
  assert.strictEqual(txt(wow, `${p}.rows[1].target`), 'under 50s 0c');
  assert.match(txt(wow, `${p}.rows[1].why`), /^\|cffe8a33dyour target\|r {2}\|cff999999usual 40s 0c\|r {2}\|cff999999your shopping list\|r$/);
  assert.strictEqual(shown(wow, `${p}.rows[1].btn`), 'true');
  wow.click(`${p}.rows[1].btn`);
  assert.strictEqual(txt(wow, `${p}.status`), 'Price alert removed.');
  assert.strictEqual(wow.eval('tostring(WowGuildDB.priceTargets[2592])'), 'nil');
  assert.strictEqual(txt(wow, `${p}.rows[2].target`), 'under 34s 0c', 'back to 85% of the usual');
  // Something it can't read: explained on the page, the text stays, nothing is listed in chat.
  wow.exec(`${p}.input:SetText("cheap stuff please")`);
  wow.click(`${p}.go`);
  assert.match(txt(wow, `${p}.status`), /^Couldn't read that/);
  assert.strictEqual(txt(wow, `${p}.input`), 'cheap stuff please');
  wow.exec(`${p}.input:SetText("")`);
  wow.click(`${p}.go`);
  assert.strictEqual(txt(wow, `${p}.status`), 'Type a price and an item first.');
  assert.strictEqual(wow.printed(), '', 'nothing goes to chat');
  noError(wow);
});

test('Guildies need page: mats I hold for a guildie, one whisper per click', () => {
  const wow = client();
  wow.exec(`__whispers = {}
    C_ChatInfo = C_ChatInfo or {}
    C_ChatInfo.SendChatMessage = function(text, kind, _, to) table.insert(__whispers, kind .. ">" .. tostring(to) .. ">" .. text) end
    SendChatMessage = C_ChatInfo.SendChatMessage
    __ns.Share = __ns.Share or {}
    __ns.Share.list = function(ty) if ty == "mw" then return { { type = "mw", key = "Mokra.m1", author = "Mokra", fields = { items = { { id = 2589, qty = 12 } } } } } end return {} end
    __ns.prof.owned = function(id) return id == 2589 and 8 or 0 end
    C_Item = C_Item or {}
    C_Item.GetItemNameByID = function() return "Linen Cloth" end
    __ns.ui.show("mats")`);
  const p = 'WowGuildWindow.pages.mats';
  assert.match(txt(wow, `${p}.rows[1].text`), /^Mokra needs 12 × .* \|cff9e9ea8\(you have 8\)\|r$/);
  assert.strictEqual(txt(wow, `${p}.rows[1].btn`), 'Whisper');
  assert.strictEqual(wow.eval('#__whispers'), '0', 'nothing is sent by opening the page');
  wow.click(`${p}.rows[1].btn`);
  assert.strictEqual(wow.eval('#__whispers'), '1');
  assert.match(wow.eval('__whispers[1]'), /^WHISPER>Mokra>Hi Mokra! I have 8 /);
  noError(wow);
});
