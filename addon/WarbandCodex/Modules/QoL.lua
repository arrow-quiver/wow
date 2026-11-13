-- Warband Codex › Quality of life. Small helpers, every one off until you turn it on. Hold Shift to skip any of
-- them once (talk to a quest giver with Shift held and nothing is accepted for you).
--   autoRepair    repair everything when a merchant can, and say what it cost
--   sellJunk      sell grey items when you open a merchant
--   autoAccept    accept quests when the quest giver offers them
--   autoTurnIn    hand in finished quests (stops when there is a reward to choose)
--   quickLoot     take everything as soon as the loot window opens
--   bagWarn       a card when your bags are nearly full
--   repairWarn    a card when a piece of gear is about to break
-- Nothing here runs in combat, and nothing buys, invites or speaks for you.
local ADDON, ns = ...
local U = ns.ui
local Q = {}
ns.qol = Q

local GROUP = "Quality of life"
ns.option{ key = "autoRepair", label = "Repair at merchants", desc = "Repair all your gear whenever a merchant who can repair opens, if you can afford it.", group = GROUP, default = false }
ns.option{ key = "sellJunk", label = "Sell grey items", desc = "Sell all poor-quality (grey) items when you open a merchant.", group = GROUP, default = false }
ns.option{ key = "autoAccept", label = "Accept quests", desc = "Accept a quest as soon as it is offered. Hold Shift to read it first.", group = GROUP, default = false }
ns.option{ key = "autoTurnIn", label = "Hand in quests", desc = "Hand in finished quests. When there are several rewards it waits for you to choose.", group = GROUP, default = false }
ns.option{ key = "quickLoot", label = "Quick loot", desc = "Take everything the moment the loot window opens.", group = GROUP, default = false }
ns.option{ key = "bagWarn", label = "Full bags warning", desc = "A card when you have two bag slots or fewer left.", group = GROUP, default = false }
ns.option{ key = "repairWarn", label = "Broken gear warning", desc = "A card when any worn item falls under 20% durability.", group = GROUP, default = false }

local function shift() return IsShiftKeyDown and IsShiftKeyDown() end
local function skip() return ns.inCombat() or shift() end

function Q.repair()
  if not ns.opt("autoRepair") or skip() then return false end
  if not (CanMerchantRepair and ns.try(CanMerchantRepair)) or not (GetRepairAllCost and RepairAllItems) then return false end
  local cost, can = ns.try(GetRepairAllCost)
  cost = tonumber(cost) or 0
  if cost <= 0 or can == false then return false end
  if (tonumber(GetMoney and ns.try(GetMoney)) or 0) < cost then ns.print("Not enough money to repair (" .. ns.money(cost) .. ").") return false end
  ns.try(RepairAllItems)
  ns.print("Repaired for " .. ns.money(cost) .. ".")
  return true
end

function Q.sellJunk()
  if not ns.opt("sellJunk") or skip() then return 0 end
  local use = (C_Container and C_Container.UseContainerItem) or UseContainerItem
  if not use then return 0 end
  local sold = 0
  ns.eachBagItem(function(bag, slot, info)
    local quality = info.quality
    if quality == nil and info.hyperlink then local _, _, q = ns.itemInfo(info.hyperlink); quality = q end
    if quality == 0 and not info.hasNoValue then
      ns.try(use, bag, slot)
      sold = sold + 1
    end
  end)
  if sold > 0 then ns.print("Sold " .. sold .. (sold == 1 and " grey item." or " grey items.")) end
  return sold
end
ns.on("MERCHANT_SHOW", function() Q.repair(); Q.sellJunk() end)

ns.on("QUEST_DETAIL", function()
  if ns.opt("autoAccept") and not skip() and AcceptQuest then ns.try(AcceptQuest) end
end)
ns.on("QUEST_PROGRESS", function()
  if ns.opt("autoTurnIn") and not skip() and IsQuestCompletable and ns.try(IsQuestCompletable) and CompleteQuest then ns.try(CompleteQuest) end
end)
ns.on("QUEST_COMPLETE", function()
  if not ns.opt("autoTurnIn") or skip() or not GetQuestReward then return end
  local choices = tonumber(GetNumQuestChoices and ns.try(GetNumQuestChoices)) or 0
  if choices <= 1 then ns.try(GetQuestReward, math.max(1, choices)) end
end)

ns.on("LOOT_READY", function()
  if not ns.opt("quickLoot") or skip() or not (GetNumLootItems and LootSlot) then return end
  for i = ns.n(ns.try(GetNumLootItems)) or 0, 1, -1 do ns.try(LootSlot, i) end
end)

local warned = {}
local function every(key, seconds)
  local now = ns.now()
  if warned[key] and now - warned[key] < seconds then return false end
  warned[key] = now
  return true
end
function Q.checkBags()
  if not ns.opt("bagWarn") or ns.inCombat() then return false end
  local free, total = ns.bagSpace()
  if total > 0 and free <= 2 and every("bags", 300) then
    ns.toast("Bags nearly full", free .. (free == 1 and " slot left." or " slots left."), "Interface\\Icons\\INV_Misc_Bag_08")
    return true
  end
  return false
end
function Q.checkGear()
  if not ns.opt("repairWarn") or ns.inCombat() then return false end
  local _, low = ns.modules.home.durability()
  if low and low < 0.2 and every("gear", 600) then
    ns.toast("Gear about to break", string.format("Your worst piece is at %d%%.", math.floor(low * 100)), "Interface\\Icons\\Trade_BlackSmithing")
    return true
  end
  return false
end
ns.on("BAG_UPDATE_DELAYED", function() Q.checkBags() end)
ns.on("UPDATE_INVENTORY_DURABILITY", function() Q.checkGear() end)
ns.on("PLAYER_REGEN_ENABLED", function() Q.checkBags(); Q.checkGear() end)

-- ---------- page: this group's switches ----------
local M = ns.module{ id = "qol", title = "Quality of Life", icon = "INV_Misc_Gear_01",
  blurb = "Small helpers. All off until you switch them on; hold Shift to skip one once.", keywords = "auto repair sell junk quest accept loot bags convenience" }

function M.build(body)
  body.list = ns.settingsList(body, function(o) return o.group == GROUP end)
  body.list:SetPoint("TOPLEFT"); body.list:SetPoint("BOTTOMRIGHT")
end
function M.refresh(body) body.list.reload() end
