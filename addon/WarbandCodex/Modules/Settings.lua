-- Warband Codex › Settings. Theme, window size, which tabs show and in what order (per character), and every
-- option of every tab in one searchable list, grouped, each with a line saying what it does.
local ADDON, ns = ...
local U = ns.ui

-- A list of option switches: ns.settingsList(parent, keep(option) → bool) → list with .reload(filterText)
function ns.settingsList(parent, keep)
  local list
  list = U.list(parent, 44, function(l, i)
    local r = U.row(l, i)
    r.head = U.text(r, "heading", "", "line"); r.head:SetPoint("BOTTOMLEFT", 4, 8)
    r.label = U.text(r, "sub", "", "text"); r.label:SetPoint("TOPLEFT", 10, -7); r.label:SetPoint("RIGHT", -170, 0)
    r.desc = U.text(r, "small", "", "dim"); r.desc:SetPoint("TOPLEFT", 10, -25); r.desc:SetPoint("RIGHT", -170, 0)
    r.toggle = U.toggle(r, function() return r.item and r.item.get and r.item.get() end, function(v) if r.item and r.item.set then r.item.set(v) end end)
    r.toggle:SetPoint("RIGHT", -12, 0)
    r.up = U.button(r, "Up", function() if r.item and r.item.move then r.item.move(-1) end end, { w = 40, h = 22 })
    r.up:SetPoint("RIGHT", -112, 0)
    r.down = U.button(r, "Down", function() if r.item and r.item.move then r.item.move(1) end end, { w = 46, h = 22 })
    r.down:SetPoint("RIGHT", -62, 0)
    return r
  end, function(r, item)
    if item.header then
      r.head:SetText(item.header); r.head:Show()
      r.label:SetText(""); r.desc:SetText(""); r.toggle:Hide(); r.up:Hide(); r.down:Hide()
      return
    end
    r.head:Hide()
    r.label:SetText(item.label); r.desc:SetText(item.desc or "")
    if item.get then r.toggle:Show(); r.toggle.refresh() else r.toggle:Hide() end
    if item.move then r.up:Show(); r.down:Show() else r.up:Hide(); r.down:Hide() end
  end, 9)
  function list.reload(filter, extra)
    local rows, group = {}, nil
    for _, o in ipairs(ns.optionList) do
      if (not keep or keep(o)) and (not filter or filter == "" or ns.matches(o.label .. " " .. (o.desc or "") .. " " .. (o.group or ""), filter)) then
        if o.group ~= group and not keep then group = o.group; rows[#rows + 1] = { header = group } end
        rows[#rows + 1] = { key = o.key, label = o.label, desc = o.desc, get = function() return ns.opt(o.key) end, set = function(v) ns.setOpt(o.key, v) end }
      end
    end
    for _, x in ipairs(extra or {}) do rows[#rows + 1] = x end
    list.rowsData = rows
    list.set(rows)
  end
  return list
end

local M = ns.module{ id = "settings", title = "Settings", icon = "Trade_Engineering", pinned = true,
  blurb = "Theme, window, tabs and every option in one searchable list.", keywords = "options config theme scale tabs" }

local body_
-- Scroll the list to an option (from a search result).
function M.focus(key)
  if not body_ then return end
  body_.filter:SetText("")
  M.refresh(body_)
  for i, row in ipairs(body_.list.rowsData or {}) do
    if row.key == key then body_.list.offset = math.max(0, i - 2); body_.list.render() break end
  end
end

local function tabRows(filter)
  local rows = {}
  if filter and filter ~= "" and not ns.matches("tabs order hide show", filter) then return rows end
  rows[#rows + 1] = { header = "Tabs for this character" }
  local tabs = ns.shell.allTabs()
  local hidden = ns.char().ui.hidden
  for _, m in ipairs(tabs) do
    if not m.available or m.available() then
      local id = m.id
      rows[#rows + 1] = { label = m.title, desc = m.pinned and "Always shown." or (m.blurb or ""),
        get = (not m.pinned) and function() return not hidden[id] end or nil,
        set = function(v) ns.shell.setHidden(id, not v) end,
        move = function(by) ns.shell.moveTab(id, by); M.refresh(body_) end }
    end
  end
  return rows
end

function M.build(body)
  body_ = body
  body.themeLabel = U.text(body, "small", "Theme", "dim"); body.themeLabel:SetPoint("TOPLEFT", 0, -5)
  local choices = {}
  for _, key in ipairs(U.themeOrder) do choices[#choices + 1] = { key, U.themes[key].label } end
  body.themes = U.chips(body, choices, function(key) U.setTheme(key); M.refresh(body) end)
  body.themes:SetPoint("TOPLEFT", 50, 0)

  body.scaleLabel = U.text(body, "small", "", "dim"); body.scaleLabel:SetPoint("TOPLEFT", 0, -37)
  local function scale(by)
    local s = (tonumber(ns.db.opts.scale) or 1) + by
    ns.db.opts.scale = math.max(0.7, math.min(1.4, math.floor(s * 20 + 0.5) / 20))
    ns.shell.applyScale(); M.refresh(body)
  end
  body.smaller = U.button(body, "-", function() scale(-0.05) end, { w = 26, h = 22 }); body.smaller:SetPoint("TOPLEFT", 110, -32)
  body.bigger = U.button(body, "+", function() scale(0.05) end, { w = 26, h = 22 }); body.bigger:SetPoint("LEFT", body.smaller, "RIGHT", 6, 0)
  body.reset = U.button(body, "Reset window", function() ns.shell.resetPlace(); M.refresh(body) end, { w = 110, h = 22 })
  body.reset:SetPoint("LEFT", body.bigger, "RIGHT", 12, 0)
  body.reset.tip = "Back to the middle of the screen at the normal size."

  body.filter = U.edit(body, 240, "Search settings ...", function() M.refresh(body) end)
  body.filter:SetPoint("TOPRIGHT", 0, -32)

  body.list = ns.settingsList(body)
  body.list:SetPoint("TOPLEFT", 0, -66); body.list:SetPoint("BOTTOMRIGHT")
end

function M.refresh(body)
  body.themes.pick((ns.db.opts.theme and U.themes[ns.db.opts.theme]) and ns.db.opts.theme or "ember", true)
  body.scaleLabel:SetText(string.format("Window size  %d%%", math.floor((tonumber(ns.db.opts.scale) or 1) * 100 + 0.5)))
  local filter = body.filter.value()
  body.list.reload(filter, tabRows(filter))
end
