-- wow guild: item helpers shared by the windows (icons, quality colours, tooltips, chat links).
local ADDON, ns = ...
local I = {}
ns.items = I

local QUESTION = "Interface\\Icons\\INV_Misc_QuestionMark"

function I.icon(id)
  if not id then return QUESTION end
  if C_Item and C_Item.GetItemIconByID then
    local t = ns.try(C_Item.GetItemIconByID, id)
    if t then return t end
  end
  if GetItemIcon then
    local t = ns.try(GetItemIcon, id)
    if t then return t end
  end
  return QUESTION
end

function I.link(id)
  local info = (C_Item and C_Item.GetItemInfo) or GetItemInfo
  if not info then return nil end
  local _, link = ns.try(info, id)
  return link
end

-- Name in its quality colour, e.g. green for uncommon.
function I.coloredName(id, fallback)
  local name = fallback
  local quality
  local info = (C_Item and C_Item.GetItemInfo) or GetItemInfo
  if info then
    local n, _, q = ns.try(info, id)
    name, quality = n or name, q
  end
  if not quality and C_Item and C_Item.GetItemQualityByID then quality = ns.try(C_Item.GetItemQualityByID, id) end
  name = name or ("Item " .. tostring(id))
  local colors = ITEM_QUALITY_COLORS
  local c = quality and colors and colors[quality]
  if c and c.hex then return c.hex .. name .. "|r" end
  return name
end

function I.showTooltip(owner, id)
  if not GameTooltip or not id then return end
  GameTooltip:SetOwner(owner, "ANCHOR_RIGHT")
  if GameTooltip.SetItemByID then GameTooltip:SetItemByID(id) end
  GameTooltip:Show()
end

function I.hideTooltip()
  if GameTooltip then GameTooltip:Hide() end
end

-- Shift-click: put the item link in the chat box, like everywhere else in the game.
function I.insertLink(id)
  local link = I.link(id)
  if link and ChatEdit_InsertLink then return ChatEdit_InsertLink(link) end
  return false
end

function I.shiftDown()
  if IsModifiedClick then return IsModifiedClick("CHATLINK") end
  return IsShiftKeyDown and IsShiftKeyDown()
end
