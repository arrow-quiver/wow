-- wow guild: options panel (Settings → AddOns → wow guild, or /wow options).
local ADDON, ns = ...

ns.OPTION_LIST = {
  { key = "minimapButton", label = "Show the campfire button on the minimap" },
  { key = "tooltips", label = "Show guild crafters, alts and guild bank on item tooltips" },
  { key = "loginNews", label = "Show guild news in chat when I log in" },
  { key = "updateNotice", label = "Tell me when a newer version of this addon is out" },
  { key = "autoGuide", label = "Open the skill-up guide with my profession window" },
  { key = "trackerOnLogin", label = "Show my shopping list on login when it has items" },
  { key = "collectBank", label = "Share my bank and the guild bank with the guild site" },
  { key = "blizzardStyle", label = "Use Blizzard's window style instead of the guild's dark-and-gold look (reload to apply)" },
}
local OPTIONS = ns.OPTION_LIST

local panel = CreateFrame("Frame")
panel.name = "wow guild"

local title = panel:CreateFontString(nil, "ARTWORK", "GameFontNormalLarge")
title:SetPoint("TOPLEFT", 16, -16)
title:SetText("wow guild")
local sub = panel:CreateFontString(nil, "ARTWORK", "GameFontHighlightSmall")
sub:SetPoint("TOPLEFT", title, "BOTTOMLEFT", 0, -8)
sub:SetWidth(560); sub:SetJustifyH("LEFT")
sub:SetText("The addon only reads information outside combat. It sends it to the guild site through the companion app when you log out or /reload.")

panel.boxes = {}
for i, o in ipairs(OPTIONS) do
  local cb = CreateFrame("CheckButton", nil, panel, "UICheckButtonTemplate")
  cb:SetPoint("TOPLEFT", 12, -60 - (i - 1) * 32)
  local label = cb:CreateFontString(nil, "ARTWORK", "GameFontHighlight")
  label:SetPoint("LEFT", cb, "RIGHT", 4, 1)
  label:SetText(o.label)
  cb:SetScript("OnClick", function(self)
    ns.db.options = ns.db.options or {}
    ns.db.options[o.key] = self:GetChecked() and true or false
    if ns.applyOptions then ns.applyOptions() end
  end)
  cb.key = o.key
  panel.boxes[i] = cb
end

local version = panel:CreateFontString(nil, "ARTWORK", "GameFontDisableSmall")
version:SetPoint("TOPLEFT", 16, -60 - #OPTIONS * 32 - 16)

panel:SetScript("OnShow", function()
  for _, cb in ipairs(panel.boxes) do cb:SetChecked(ns.opt(cb.key) and true or false) end
  local inbox = WowGuildInbox
  version:SetText("Version " .. ns.addonVersion() .. (inbox and inbox.site and ("  ·  Guild site: " .. inbox.site) or ""))
end)

local category
if Settings and Settings.RegisterCanvasLayoutCategory and Settings.RegisterAddOnCategory then
  category = Settings.RegisterCanvasLayoutCategory(panel, panel.name)
  Settings.RegisterAddOnCategory(category)
elseif InterfaceOptions_AddCategory then
  InterfaceOptions_AddCategory(panel)
end

function ns.openOptions()
  if category and Settings and Settings.OpenToCategory then
    Settings.OpenToCategory(category.GetID and category:GetID() or category.ID)
  elseif InterfaceOptionsFrame_OpenToCategory then
    InterfaceOptionsFrame_OpenToCategory(panel)
    InterfaceOptionsFrame_OpenToCategory(panel) -- the old frame needs two calls to land on the page
  else
    ns.print("Options: use /wow help for commands.")
  end
end
ns.optionsPanel = panel
