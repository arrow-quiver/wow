'use strict';
// The Deal hunter beside the auction house (addon/WowGuild/Deals.lua): the inbox's deals, checked against
// Auctionator's live price, searched with one click.
const test = require('node:test');
const assert = require('node:assert');
const { WowClient } = require('./wowsim');

const INBOX = {
  guild: 'wow',
  deals: {
    realm: "Zul'jin Horde", day: '2026-11-09',
    items: [
      { id: 14047, name: 'Runecloth', buy: 30000, worth: 50000, profit: 17500, sure: 'high' },
      { id: 13510, name: 'Flask of the Titans', buy: 250000, worth: 400000, profit: 130000, sure: 'low' },
    ],
    vendor: [{ id: 4338, name: 'Mageweave Cloth', buy: 500, worth: 2000, profit: 1500, sure: 'certain' }],
  },
};
const AUCTIONATOR = `__searched = {}
Auctionator = { API = { v1 = {
  GetAuctionPriceByItemID = function(_, id) return __live and __live[id] end,
  MultiSearchExact = function(_, names) table.insert(__searched, table.concat(names, "|")) end,
  CreateShoppingList = function(_, name, names) __list = name .. ":" .. table.concat(names, "|") end,
} } }
AuctionHouseFrame = CreateFrame("Frame", "AuctionHouseFrame", UIParent)`;

function session(inbox = INBOX) {
  const wow = new WowClient({ inbox });
  wow.exec(AUCTIONATOR);
  return wow.login();
}

test('Deal hunter opens with the auction house, lists deals and searches them', () => {
  const wow = session();
  wow.exec('AuctionHouseFrame:Show()');
  wow.fire('AUCTION_HOUSE_SHOW');
  assert.strictEqual(wow.eval('tostring(WowGuildDeals:IsShown())'), 'true');
  assert.match(wow.eval('WowGuildDeals.sub:GetText()'), /Zul'jin Horde, from your scan of 2026-11-09/);
  // Vendor flips first, then the app's order.
  assert.strictEqual(wow.eval('WowGuildDeals.rows[1].name:GetText()'), 'Mageweave Cloth');
  assert.strictEqual(wow.eval('WowGuildDeals.rows[2].name:GetText()'), 'Runecloth');
  assert.strictEqual(wow.eval('WowGuildDeals.rows[2].profit:GetText()'), '+1g 75s');
  assert.match(wow.eval('WowGuildDeals.rows[2].meta:GetText()'), /buy 3g 0s, usually 5g 0s/);
  wow.click('WowGuildDeals.rows[2]');
  assert.strictEqual(wow.eval('__searched[1]'), 'Runecloth');
  wow.click('WowGuildDeals.all');
  assert.strictEqual(wow.eval('__searched[2]'), 'Mageweave Cloth|Runecloth|Flask of the Titans');
  wow.click('WowGuildDeals.mk');
  assert.strictEqual(wow.eval('__list'), 'Guild Camp deals:Mageweave Cloth|Runecloth|Flask of the Titans');
  wow.fire('AUCTION_HOUSE_CLOSED');
  assert.strictEqual(wow.eval('tostring(WowGuildDeals:IsShown())'), 'false');
});

test('a new scan this session re-checks prices: gone deals are greyed out and not searched', () => {
  const wow = session();
  wow.exec('__live = { [14047] = 60000, [13510] = 260000 }');
  wow.fire('AUCTION_HOUSE_SHOW');
  assert.match(wow.eval('WowGuildDeals.rows[2].meta:GetText()'), /Gone: now 6g 0s/);
  assert.strictEqual(wow.eval('WowGuildDeals.rows[2].profit:GetText()'), '');
  assert.match(wow.eval('WowGuildDeals.rows[3].meta:GetText()'), /buy 26g 0s, usually 40g 0s/);
  assert.strictEqual(wow.eval('WowGuildDeals.rows[3].profit:GetText()'), '+12g 0s');
  wow.click('WowGuildDeals.all');
  assert.strictEqual(wow.eval('__searched[1]'), 'Mageweave Cloth|Flask of the Titans');
});

test('closing it by hand keeps it closed until the next visit; the option turns it off; /wow deals toggles', () => {
  const wow = session();
  wow.fire('AUCTION_HOUSE_SHOW');
  wow.exec('__ns.deals.panel():Hide(); __ns.deals.panel().closedByHand = true');
  wow.fire('AUCTION_HOUSE_SHOW');
  assert.strictEqual(wow.eval('tostring(WowGuildDeals:IsShown())'), 'false');
  wow.fire('AUCTION_HOUSE_CLOSED');
  wow.exec('__ns.db.options = __ns.db.options or {}; __ns.db.options.dealsPanel = false');
  wow.fire('AUCTION_HOUSE_SHOW');
  assert.strictEqual(wow.eval('tostring(WowGuildDeals:IsShown())'), 'false');
  wow.exec('SlashCmdList.WOWGUILD("deals")');
  assert.strictEqual(wow.eval('tostring(WowGuildDeals:IsShown())'), 'true');
});

test('without deals in the inbox it explains how to get them', () => {
  const wow = session({ guild: 'wow' });
  wow.fire('AUCTION_HOUSE_SHOW');
  assert.match(wow.eval('WowGuildDeals.empty:GetText()'), /Scan the auction house with Auctionator, then \/reload/);
  assert.strictEqual(wow.eval('tostring(WowGuildDeals.all:IsShown())'), 'false');
});
