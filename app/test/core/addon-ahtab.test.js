'use strict';
// AuctionTab.lua: the Guild Camp list at the auction house. What to buy (shopping list + guild bank requests), the
// total, the confirm prompt, and buying one purchase per click on the modern and classic auction house, with the
// price guard and the spend cap.
const test = require('node:test');
const assert = require('node:assert');
const { WowClient } = require('./wowsim');

const STUBS = `
__ns.prof = {
  remaining = function() return {
    { id = 14047, name = "Runecloth", need = 40, have = 10, done = false },
    { id = 2589, name = "Linen Cloth", need = 5, have = 5, done = true },
  } end,
  price = function(id) local p = { [14047] = 1000, [13444] = 9000 } return p[id] end,
}
__ns.Share = {
  list = function(t)
    if t == "bq" then return {
      { key = "aaaaaa", author = "Shadowfen", fields = { item = "Major Mana Potion", count = 4, state = "o", note = "MC" } },
      { key = "bbbbbb", author = "Mokra", fields = { item = "Heavy Leather", count = 2, state = "o" } },
      { key = "cccccc", author = "Mokra", fields = { item = "Runecloth", count = 9, state = "x" } },
      { key = "dddddd", author = "Zuljin", fields = { item = "Iron Bar", count = 9, state = "o" } },
    } end
    if t == "BH" then return { { key = "dddddd", fields = { state = "s" } } } end
    return {}
  end,
}
C_Item = C_Item or {}
C_Item.GetItemInfoInstant = function(name) local ids = { ["Major Mana Potion"] = 13444, ["Runecloth"] = 14047 } return ids[name] end
__popupData = nil
StaticPopup_Show = function(which, a, b, data) __popupWhich = which; __popupText = a; __popupData = data end
`;
const MODERN = `
__ah = { searches = {}, starts = {}, confirms = {}, bids = {} }
C_AuctionHouse = {
  MakeItemKey = function(id) return { itemID = id } end,
  SendSearchQuery = function(key) table.insert(__ah.searches, key.itemID) end,
  StartCommoditiesPurchase = function(id, qty) table.insert(__ah.starts, id .. "x" .. qty) end,
  ConfirmCommoditiesPurchase = function(id, qty) table.insert(__ah.confirms, id .. "x" .. qty) end,
  CancelCommoditiesPurchase = function() __ah.cancelled = true end,
  GetNumItemSearchResults = function() return 2 end,
  GetItemSearchResultInfo = function(key, i)
    if i == 1 then return { auctionID = 11, buyoutAmount = 40000, quantity = 1 } end
    return { auctionID = 12, buyoutAmount = 9500, quantity = 1 }
  end,
  PlaceBid = function(id, amount) table.insert(__ah.bids, id .. ":" .. amount) end,
}
`;

function client(extra = '') {
  const wow = new WowClient();
  wow.login();
  wow.exec(STUBS + extra);
  return wow;
}

test('the list: missing mats (ticked) and open guild requests (not ticked), with prices and the total', () => {
  const wow = client();
  wow.exec('__lines = __ns.ahTab.lines(); __t = __ns.ahTab.totals(__lines)');
  assert.strictEqual(wow.eval('#__lines'), '3', 'done mats, cancelled and handled requests are left out');
  assert.strictEqual(wow.eval('__lines[1].name .. ":" .. __lines[1].qty .. ":" .. tostring(__lines[1].on) .. ":" .. __lines[1].est'), 'Runecloth:30:true:30000');
  assert.strictEqual(wow.eval('__lines[2].name .. ":" .. __lines[2].kind .. ":" .. __lines[2].who .. ":" .. tostring(__lines[2].on) .. ":" .. __lines[2].est'), 'Major Mana Potion:guild:Shadowfen:false:36000');
  assert.strictEqual(wow.eval('tostring(__lines[3].est)'), 'nil');
  assert.strictEqual(wow.eval('__t.count .. ":" .. __t.est .. ":" .. __t.unpriced'), '1:30000:0');
  // Ticking the request adds it.
  wow.exec('__ns.ahTab.picked["gaaaaaa"] = true; __t = __ns.ahTab.totals(__ns.ahTab.lines())');
  assert.strictEqual(wow.eval('__t.count .. ":" .. __t.est'), '2:66000');
  // The panel shows them.
  wow.exec('__ns.ahTab.show()');
  assert.match(wow.eval('WowGuildAuctionTab.total:GetText()'), /^Total: about 6g 60s for 2 items/);
  assert.strictEqual(wow.eval('__ns.debugError'), null);
});

test('nothing is bought without the confirm prompt; the prompt shows the total and sets the spend cap', () => {
  const wow = client(MODERN);
  wow.exec('__ns.ahTab.show(); WowGuildAuctionTab.go:GetScript("OnClick")()');
  assert.strictEqual(wow.eval('__popupWhich'), 'WOWGUILD_AH_BUY');
  assert.strictEqual(wow.eval('__popupText'), '1 item for about 3g 0s');
  assert.strictEqual(wow.eval('__popupData.cap'), '36000');
  assert.strictEqual(wow.eval('#__ah.searches'), '0', 'no search before the OK');
  assert.strictEqual(wow.eval('tostring(__ns.ahTab.run)'), 'nil');
});

test('modern auction house: commodity Buy, price check, Confirm; then an item, cheapest auction per click', () => {
  const wow = client(MODERN);
  wow.exec('__ns.ahTab.picked["gaaaaaa"] = true; __ns.ahTab.confirm(); StaticPopupDialogs.WOWGUILD_AH_BUY.OnAccept(nil, __popupData)');
  assert.strictEqual(wow.eval('__ah.searches[1]'), '14047');
  wow.fire('COMMODITY_SEARCH_RESULTS_UPDATED', 14047);
  assert.strictEqual(wow.eval('__ns.ahTab.buttonText()'), 'Buy 30 × Runecloth (1 of 2)');
  wow.exec('__ns.ahTab.click()');
  assert.strictEqual(wow.eval('__ah.starts[1]'), '14047x30');
  wow.fire('COMMODITY_PRICE_UPDATED', 1050, 31500);
  assert.strictEqual(wow.eval('__ns.ahTab.buttonText()'), 'Confirm: pay 3g 15s for 30 × Runecloth');
  assert.strictEqual(wow.eval('#__ah.confirms'), '0', 'confirm needs its own click');
  wow.exec('__ns.ahTab.click()');
  assert.strictEqual(wow.eval('__ah.confirms[1]'), '14047x30');
  wow.fire('COMMODITY_PURCHASE_SUCCEEDED');
  // Next: Major Mana Potion (4) as single auctions: the cheaper one first.
  assert.strictEqual(wow.eval('__ah.searches[2]'), '13444');
  wow.fire('ITEM_SEARCH_RESULTS_UPDATED', { itemID: 13444 });
  assert.strictEqual(wow.eval('__ns.ahTab.buttonText()'), 'Buy 1 × Major Mana Potion for 95s 0c');
  wow.exec('__ns.ahTab.click()');
  assert.strictEqual(wow.eval('__ah.bids[1]'), '12:9500');
  wow.fire('AUCTION_HOUSE_PURCHASE_COMPLETED');
  assert.strictEqual(wow.eval('__ns.ahTab.run.spent .. ":" .. __ns.ahTab.run.left'), '41000:3');
  // 40000 for one potion is over 9000 × 1.2: skipped, and the run ends.
  wow.exec('C_AuctionHouse.GetNumItemSearchResults = function() return 1 end; C_AuctionHouse.GetItemSearchResultInfo = function() return { auctionID = 11, buyoutAmount = 40000, quantity = 1 } end');
  wow.fire('ITEM_SEARCH_RESULTS_UPDATED', { itemID: 13444 });
  wow.exec('__ns.ahTab.click()');
  assert.strictEqual(wow.eval('#__ah.bids'), '1');
  assert.match(wow.printed(), /Skipped Major Mana Potion: it costs 4g 0s, more than 20% over the expected 90s 0c/);
  assert.match(wow.printed(), /Done buying\. Spent 4g 10s on 2 purchases\./);
  assert.strictEqual(wow.eval('tostring(__ns.ahTab.run)'), 'nil');
  assert.strictEqual(wow.eval('__ns.debugError'), null);
});

test('a commodity priced over the guard is cancelled before Confirm', () => {
  const wow = client(MODERN);
  wow.exec('__ns.ahTab.confirm(); StaticPopupDialogs.WOWGUILD_AH_BUY.OnAccept(nil, __popupData)');
  wow.fire('COMMODITY_SEARCH_RESULTS_UPDATED', 14047);
  wow.exec('__ns.ahTab.click()');
  wow.fire('COMMODITY_PRICE_UPDATED', 2000, 60000);
  assert.strictEqual(wow.eval('tostring(__ah.cancelled)'), 'true');
  assert.strictEqual(wow.eval('#__ah.confirms'), '0');
  assert.match(wow.printed(), /Skipped Runecloth/);
});

test('classic auction house: search by name, cheapest buyout I can use, one auction per click; Stop ends it', () => {
  const wow = client(`
    __q = {}; __bids = {}
    QueryAuctionItems = function(name) table.insert(__q, name) end
    CanSendAuctionQuery = function() return true end
    GetNumAuctionItems = function() return 3 end
    GetAuctionItemInfo = function(list, i)
      local rows = { { "Runecloth", 20, 24000, "Bob", 14047 }, { "Runecloth", 10, 9000, "Ann", 14047 }, { "Runecloth", 40, 30000, "Cat", 14047 } }
      local r = rows[i]
      return r[1], nil, r[2], nil, nil, nil, nil, nil, nil, r[3], nil, nil, nil, r[4], nil, nil, r[5]
    end
    PlaceAuctionBid = function(list, i, amount) table.insert(__bids, i .. ":" .. amount) end
    C_AuctionHouse = nil`);
  wow.exec('__ns.ahTab.confirm(); StaticPopupDialogs.WOWGUILD_AH_BUY.OnAccept(nil, __popupData)');
  assert.strictEqual(wow.eval('__q[1]'), 'Runecloth');
  wow.fire('AUCTION_ITEM_LIST_UPDATE');
  assert.strictEqual(wow.eval('__ns.ahTab.buttonText()'), 'Buy 10 × Runecloth for 90s 0c', 'cheapest per unit; 40 is more than needed');
  wow.exec('__ns.ahTab.click()');
  assert.strictEqual(wow.eval('__bids[1]'), '2:9000');
  assert.strictEqual(wow.eval('__ns.ahTab.run.left'), '20');
  assert.strictEqual(wow.eval('#__q'), '2', 'searched again for the rest');
  wow.exec('WowGuildAuctionTab.stop:GetScript("OnClick")()');
  assert.match(wow.printed(), /Stopped\. Spent 90s 0c on 1 purchase\./);
  assert.strictEqual(wow.eval('__ns.debugError'), null);
});

test('closing the auction house stops buying', () => {
  const wow = client(MODERN);
  wow.exec('__ns.ahTab.confirm(); StaticPopupDialogs.WOWGUILD_AH_BUY.OnAccept(nil, __popupData)');
  wow.fire('AUCTION_HOUSE_CLOSED');
  assert.strictEqual(wow.eval('tostring(__ns.ahTab.run)'), 'nil');
  assert.match(wow.printed(), /The auction house closed, so buying stopped/);
});
