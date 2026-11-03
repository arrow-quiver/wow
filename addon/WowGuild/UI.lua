-- wow guild: the in-game panel showing news from the website.
local ADDON, ns = ...

local panel

local function ago(t)
  if not t then return "" end
  local s = time() - t
  if s < 3600 then return math.max(1, math.floor(s / 60)) .. " min ago" end
  if s < 86400 then return math.floor(s / 3600) .. " h ago" end
  return math.floor(s / 86400) .. " d ago"
end

local function buildText()
  local inbox = WowGuildInbox
  if not inbox then
    return "No news from the guild site yet.\n\nMake sure the companion app is running, then /reload."
  end
  local lines = {}
  local function add(s) lines[#lines + 1] = s end
  add("|cffe8a33d" .. (inbox.guild or "Guild") .. "|r  |cff999999updated " .. ago(inbox.generatedAt) .. "|r")
  add("")
  add("|cffffd100Raids|r")
  if inbox.raids and #inbox.raids > 0 then
    for _, r in ipairs(inbox.raids) do
      local me
      if r.signup == "yes" then me = "|cff3fbf5ayou're coming|r" .. (r.role and (" as " .. r.role) or "")
      elseif r.signup == "tentative" then me = "|cffe8a33dyou're a maybe|r"
      elseif r.signup == "no" then me = "|cff999999you can't make it|r"
      else me = "|cffe8a33dnot signed up yet|r" end
      add("  " .. r.title .. "  |cff999999" .. date("%a %d %b %H:%M", r.startsAt or 0) .. ", " .. (r.coming or 0) .. " coming|r")
      add("    " .. me)
      if r.reserves and #r.reserves > 0 then
        local parts = {}
        for _, x in ipairs(r.reserves) do parts[#parts + 1] = x.name .. ((x.bonus or 0) > 0 and (" (+" .. x.bonus .. ")") or "") end
        add("    |cff999999reserved:|r " .. table.concat(parts, ", "))
      end
    end
  else add("  |cff999999Nothing scheduled|r") end
  add("")
  add("|cffffd100Notices|r")
  if inbox.announcements and #inbox.announcements > 0 then
    for _, a in ipairs(inbox.announcements) do add("  " .. a.body .. "  |cff999999" .. (a.by or ""):gsub("#%d+", "") .. "|r") end
  else add("  |cff999999None|r") end
  add("")
  add("|cffffd100Requests you can craft|r")
  if inbox.canCraft and #inbox.canCraft > 0 then
    for _, r in ipairs(inbox.canCraft) do
      add("  " .. r.item .. "  |cff999999for " .. (r.requester or ""):gsub("#%d+", "") .. "|r" .. (r.notes and r.notes ~= "" and ("  " .. r.notes) or ""))
    end
    add("  |cff999999Claim them on the site so nobody doubles up.|r")
  else add("  |cff999999None right now|r") end
  add("")
  add("|cffffd100Your requests|r")
  if inbox.myRequests and #inbox.myRequests > 0 then
    for _, r in ipairs(inbox.myRequests) do
      add("  " .. r.item .. "  |cff999999" .. (r.status == "claimed" and ("being made by " .. (r.crafter or ""):gsub("#%d+", "")) or "waiting") .. "|r")
    end
  else add("  |cff999999None|r") end
  add("")
  add("|cffffd100Looking for leveling partners|r")
  if inbox.buddies and #inbox.buddies > 0 then
    for _, b in ipairs(inbox.buddies) do
      add(string.format("  %s (%s)%s%s", b.character, tostring(b.level or "?"),
        (b.zone and b.zone ~= "") and (" in " .. b.zone) or "", (b.whenText and b.whenText ~= "") and (", " .. b.whenText) or ""))
    end
  else add("  |cff999999Nobody posted|r") end
  add("")
  add("|cff999999/wow cta [zone] [number] [message]  sounds the horn on Discord|r")
  return table.concat(lines, "\n")
end

local function createPanel()
  local f = CreateFrame("Frame", "WowGuildPanel", UIParent, "BackdropTemplate")
  f:SetSize(420, 460)
  f:SetPoint("CENTER")
  f:SetFrameStrata("DIALOG")
  f:SetMovable(true)
  f:EnableMouse(true)
  f:RegisterForDrag("LeftButton")
  f:SetScript("OnDragStart", f.StartMoving)
  f:SetScript("OnDragStop", f.StopMovingOrSizing)
  f:SetClampedToScreen(true)
  if f.SetBackdrop then
    f:SetBackdrop({
      bgFile = "Interface\\Buttons\\WHITE8x8", edgeFile = "Interface\\Buttons\\WHITE8x8", edgeSize = 2,
    })
    f:SetBackdropColor(0.12, 0.23, 0.2, 0.96)
    f:SetBackdropBorderColor(0.91, 0.64, 0.24, 1)
  end
  tinsert(UISpecialFrames, "WowGuildPanel") -- Escape closes it

  local title = f:CreateFontString(nil, "OVERLAY", "GameFontNormalLarge")
  title:SetPoint("TOPLEFT", 14, -12)
  title:SetText("Guild camp")

  local close = CreateFrame("Button", nil, f, "UIPanelCloseButton")
  close:SetPoint("TOPRIGHT", -2, -2)

  local scroll = CreateFrame("ScrollFrame", nil, f, "UIPanelScrollFrameTemplate")
  scroll:SetPoint("TOPLEFT", 14, -40)
  scroll:SetPoint("BOTTOMRIGHT", -32, 14)
  local content = CreateFrame("Frame", nil, scroll)
  content:SetSize(370, 10)
  scroll:SetScrollChild(content)
  local text = content:CreateFontString(nil, "OVERLAY", "GameFontHighlight")
  text:SetPoint("TOPLEFT")
  text:SetWidth(370)
  text:SetJustifyH("LEFT")
  text:SetSpacing(3)
  f.text = text
  f.content = content
  f:Hide()
  return f
end

function ns.togglePanel()
  panel = panel or createPanel()
  if panel:IsShown() then panel:Hide() return end
  panel.text:SetText(buildText())
  panel.content:SetHeight(panel.text:GetStringHeight() + 10)
  panel:Show()
end

function ns.showLoginNews()
  local inbox = WowGuildInbox
  if inbox and inbox.latestAddon and ns.opt("updateNotice") and ns.versionLess(ns.addonVersion(), inbox.latestAddon) then
    ns.print(string.format("|cffe8a33dA newer version of this addon (%s) is out.|r Get it at %s/get", inbox.latestAddon, inbox.site or "the guild site"))
  end
  if not ns.opt("loginNews") then return end
  if not inbox then
    ns.print("Type /wow for the guild panel. No news from the site yet. Is the companion running?")
    return
  end
  local craft = inbox.canCraft and #inbox.canCraft or 0
  local notices = inbox.announcements and #inbox.announcements or 0
  local parts = {}
  if craft > 0 then parts[#parts + 1] = craft .. (craft == 1 and " crafting request you can make" or " crafting requests you can make") end
  local nextRaid = inbox.raids and inbox.raids[1]
  if nextRaid and not nextRaid.signup then
    parts[#parts + 1] = nextRaid.title .. " on " .. date("%a %H:%M", nextRaid.startsAt or 0) .. ": you're not signed up yet"
  end
  if notices > 0 then parts[#parts + 1] = "latest notice: " .. inbox.announcements[1].body end
  if #parts > 0 then ns.print(table.concat(parts, ". ") .. ". Type /wow for more.")
  else ns.print("Type /wow for the guild panel.") end
end
