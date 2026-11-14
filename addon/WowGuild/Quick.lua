-- Guild Camp: the quick panel. The war table (the Guild Camp app over the game, Ctrl+Shift+G) is where the guild's
-- pages are; what it can't do is act inside the game at once (it reaches the game at the next /reload). This small
-- panel holds exactly those things: what needs an answer right now, each with its button, and one line to write in
-- with buttons to send it as a call to arms, a board post or a new group.
--
-- The minimap campfire, the key binding and /wow open it. The full in-game window (MainUI.lua) is still there for
-- anyone who turns on "Use the full in-game window" in the settings, and through /wow full.
local ADDON, ns = ...
local Q = {}
ns.quick = Q

Q.ROWS = 7
Q.WIDTH = 400
Q.CALL_FRESH = 600   -- a call to arms is "right now" for this long
local GOLD, GREY, GREEN = "|cffe8a33d", "|cff999999", "|cff40bf40"

local function now() return (GetServerTime and ns.try(GetServerTime)) or time() end
local function plain(s) return (string.gsub(tostring(s or ""), "|", "||")) end
local function me() return UnitName and ns.try(UnitName, "player") or nil end

-- What a command would print in chat, as text for the panel's status line.
local function capture(fn, ...)
  if ns.ui and ns.ui.capture then return ns.ui.capture(fn, ...) end
  fn(...)
  return ""
end

-- ---------- what needs me right now ----------
-- → { { text, buttons = { { label, run } } } }, the most urgent first. `run` returns the line for the status bar
-- (or nil). Each button is one action on one click.
function Q.items()
  local out = {}
  local function add(text, buttons) out[#out + 1] = { text = text, buttons = buttons or {} } end
  local t = now()
  local P, L, R, G = ns.presence, ns.lfg, ns.recruit, ns.goals

  -- Calls to arms from the last ten minutes: answer a guildmate's, invite who answered mine.
  local calls = ns.ctaRecent or {}
  for i = #calls, math.max(1, #calls - 2), -1 do
    local c = calls[i]
    if c and c.at and t - c.at <= Q.CALL_FRESH then
      if c.mine then
        local coming = (P and me()) and P.coming(me(), c.at) or {}
        if #coming > 0 then
          add(string.format("%sYour call in %s|r  %sComing: %s|r", GOLD, plain(c.zone or "?"), GREEN, table.concat(coming, ", ")), { { "Invite them", function()
            local n = 0
            for _, name in ipairs(coming) do
              if not (UnitInParty and ns.try(UnitInParty, name)) and L and L.invite then L.invite(name); n = n + 1 end
            end
            return n > 0 and string.format("Invited %d.", n) or "They're all in your group already."
          end } })
        end
      elseif c.character and not c.answered then
        add(string.format("%s%s calls to arms in %s|r%s", GOLD, plain(c.character), plain(c.zone or "?"), (c.message and c.message ~= "") and ("  " .. GREY .. plain(c.message) .. "|r") or ""), { { "On my way", function()
          local sent = P and P.answer(c.character)
          if not sent and ns.ui and ns.ui.whisper then sent = ns.ui.whisper(string.format("On my way to %s!", (c.zone and c.zone ~= "") and c.zone or "you"), c.character) end
          c.answered = sent and true or false
          return sent and ("Told " .. plain(c.character) .. " you're coming.") or "Couldn't send that right now."
        end } })
      end
    end
  end

  -- Recruits who want in (officers): the name to right-click.
  if R and R.isOfficer and R.isOfficer() then
    for i, k in ipairs(R.interested()) do
      if i > 2 then break end
      add(string.format("%s%s wants to join the guild|r", GOLD, plain(k.name)), { { R.canInviteByAddon() and "Invite" or "Show name", function() return capture(R.invite, k.name) end } })
    end
  end

  -- Guild groups and premades: mine, the one I'm in, then the ones I could join.
  if L and L.groups then
    local groups = L.groups()
    local function at(i) L.last = groups; return i end
    for i, e in ipairs(groups) do
      local f = e.rec.fields
      local what = plain(f.dungeon or "?") .. (L.isPremade and L.isPremade(f) and " premade" or "")
      if e.mine then
        local premade = L.isPremade and L.isPremade(f)
        add(string.format("Your %s  %s%d joined, %s|r", what, GREY, #e.g.members, L.needText(e.g.open)), {
          { "Invite all", function() return capture(L.inviteGroup, at(i)) end },
          premade and { "Won", function() return capture(L.finish, at(i), "d", "Won") end } or { "Done", function() return capture(L.finish, at(i), "d") end },
          premade and { "Lost", function() return capture(L.finish, at(i), "d", "Lost") end } or { "Call off", function() return capture(L.finish, at(i), "x") end },
        })
      elseif e.joined then
        add(string.format("%sYou're in|r %s's %s", GREEN, plain(f.character or "?"), what), { { "Leave", function() return capture(L.leave, at(i)) end } })
      elseif L.needText(e.g.open) ~= "full" then
        add(string.format("%s  %s%s, %s|r", what, GREY, plain(f.character or "?"), L.needText(e.g.open)), {
          { "Tank", function() return capture(L.join, at(i), "tank") end },
          { "Healer", function() return capture(L.join, at(i), "healer") end },
          { "DPS", function() return capture(L.join, at(i), "dps") end },
        })
      end
    end
  end

  -- Supply drives still short: write the number in the box, then "I gave".
  if G and G.drives then
    for _, d in ipairs(G.drives()) do
      if not d.done then
        add(string.format("%s  %s%d of %d %s|r", d.title, GREY, d.total, d.goal, d.unit), { { "I gave", function()
          local n = Q.text()
          if n == "" then return "Write how many you gave in the box first." end
          local ok = false
          local said = capture(function() ok = G.give(d.key, n) end)
          if ok then Q.clear() end
          return said
        end } })
      end
    end
  end
  return out
end

-- ---------- the line to write in ----------
function Q.text() return (Q.panel and Q.panel.box and Q.panel.box:GetText()) or "" end
function Q.clear() if Q.panel and Q.panel.box then Q.panel.box:SetText("") end end

-- The buttons under the box: what to do with what's written. Each → the line for the status bar.
Q.SEND = {
  { key = "horn", label = "Call to arms", width = 100, run = function(text)
    local zone = (GetZoneText and ns.try(GetZoneText)) or ""
    local ok = false
    local said = capture(function() ok = ns.addCta(zone, nil, text) end)
    return (ok and said == "") and ("The horn sounds in " .. zone .. ".") or said, ok
  end },
  { key = "lfg", label = "LFG", width = 50, board = "lfg" },
  { key = "wts", label = "Selling", width = 64, board = "wts" },
  { key = "wtb", label = "Buying", width = 62, board = "wtb" },
  { key = "help", label = "Help", width = 50, board = "help" },
  { key = "tank", label = "Group: tank", width = 96, group = "tank", row = 2 },
  { key = "healer", label = "healer", width = 62, group = "healer", row = 2 },
  { key = "dps", label = "dps", width = 46, group = "dps", row = 2 },
  { key = "kos", label = "Kill on sight: my target", width = 170, row = 2, run = function(text)
    local isPlayer = UnitIsPlayer and ns.try(UnitIsPlayer, "target")
    local enemy = isPlayer and (not UnitIsEnemy or ns.try(UnitIsEnemy, "player", "target"))
    local ok, n = pcall(UnitName, "target")
    if not enemy or not ok or type(n) ~= "string" or n == "" or not ns.hunt then return "Target an enemy player first.", false end
    local zone = (GetZoneText and ns.try(GetZoneText)) or ""
    return capture(ns.hunt.add, n, text ~= "" and text or (zone ~= "" and ("Seen in " .. zone) or "")), true
  end },
}

function Q.send(key)
  local spec
  for _, s in ipairs(Q.SEND) do if s.key == key then spec = s end end
  if not spec then return nil end
  local text = Q.text()
  local said, ok
  if spec.board then
    if text == "" then return Q.say("Write the post in the box first.") end
    if not ns.board then return Q.say("The board isn't available.") end
    said = capture(function() ok = ns.board.post(spec.board, text) end)
  elseif spec.group then
    if text == "" then return Q.say("Write the dungeon in the box first.") end
    if not ns.lfg then return Q.say("Groups aren't available.") end
    said = capture(function() ok = ns.lfg.new(spec.group .. " " .. text) end)
  else
    said, ok = spec.run(text)
  end
  if ok then Q.clear() end
  Q.say(said)
  return ok and true or false
end

function Q.say(line)
  if Q.panel then Q.panel.status:SetText(line or "") end
  Q.refresh(true)
  return line
end

-- ---------- the panel ----------
local function makePanel()
  local S = ns.skin
  local f = CreateFrame("Frame", "WowGuildQuick", UIParent)
  f:SetSize(Q.WIDTH, 196 + Q.ROWS * 28); f:SetFrameStrata("DIALOG")
  f:SetMovable(true); f:EnableMouse(true); f:RegisterForDrag("LeftButton"); f:SetClampedToScreen(true)
  f:SetScript("OnDragStart", f.StartMoving)
  f:SetScript("OnDragStop", function(self)
    self:StopMovingOrSizing()
    local point, _, rel, x, y = self:GetPoint()
    ns.db.ui = ns.db.ui or {}
    ns.db.ui.quickPos = { point = point, rel = rel, x = x, y = y }
  end)
  tinsert(UISpecialFrames, "WowGuildQuick") -- Escape closes it
  S.panel(f)
  f.title = S.text(f, "heading", "Guild Camp", S.GOLD); f.title:SetPoint("TOPLEFT", 12, -10)
  f.hint = S.text(f, "small", "", S.GREY); f.hint:SetPoint("TOPLEFT", 12, -30); f.hint:SetWidth(Q.WIDTH - 24)
  local close = CreateFrame("Button", nil, f, "UIPanelCloseButton"); close:SetPoint("TOPRIGHT", -2, -2)
  f.head = S.text(f, "body", "", S.GOLD); f.head:SetPoint("TOPLEFT", 12, -62); f.head:SetWidth(Q.WIDTH - 24)

  f.rows = {}
  for i = 1, Q.ROWS do
    local r = CreateFrame("Frame", nil, f)
    r:SetSize(Q.WIDTH - 24, 26); r:SetPoint("TOPLEFT", 12, -82 - (i - 1) * 28)
    r.stripe = S.colorTex(r, "BACKGROUND", 1, 1, 1, i % 2 == 1 and 0.04 or 0); r.stripe:SetAllPoints()
    r.text = S.text(r, "small", ""); r.text:SetPoint("LEFT", 4, 0); r.text:SetWidth(Q.WIDTH - 24 - 8)
    r.b = {}
    for k = 1, 3 do
      local b = CreateFrame("Button", nil, r, "UIPanelButtonTemplate")
      b:SetSize(62, 20)
      r.b[k] = b
    end
    r:Hide()
    f.rows[i] = r
  end

  local y = -82 - Q.ROWS * 28 - 6
  f.box = CreateFrame("EditBox", nil, f, "InputBoxTemplate")
  f.box:SetSize(Q.WIDTH - 36, 22); f.box:SetPoint("TOPLEFT", 18, y); f.box:SetAutoFocus(false)
  if f.box.SetMaxLetters then f.box:SetMaxLetters(140) end
  f.box:SetScript("OnEscapePressed", function(self) self:ClearFocus() end)
  f.boxHint = S.text(f, "small", "Write here, then pick what it is:", S.GREY); f.boxHint:SetPoint("BOTTOMLEFT", f.box, "TOPLEFT", -4, 2)
  f.send = {}
  local x = { 12, 12 }
  for _, sp in ipairs(Q.SEND) do
    local row = sp.row or 1
    local b = CreateFrame("Button", nil, f, "UIPanelButtonTemplate")
    b:SetSize(sp.width, 22); b:SetPoint("TOPLEFT", x[row], y - 28 - (row - 1) * 26)
    b:SetText(sp.label)
    b:SetScript("OnClick", function() ns.safely(Q.send, sp.key) end)
    x[row] = x[row] + sp.width + 4
    f.send[sp.key] = b
  end
  f.status = S.text(f, "small", "", S.GREY); f.status:SetPoint("BOTTOMLEFT", 12, 10); f.status:SetWidth(Q.WIDTH - 24)

  local pos = ns.db.ui and ns.db.ui.quickPos
  if pos then f:SetPoint(pos.point or "CENTER", UIParent, pos.rel or "CENTER", pos.x or 0, pos.y or 0) else f:SetPoint("RIGHT", UIParent, "RIGHT", -60, 60) end
  f:Hide()
  return f
end

function Q.refresh(keepStatus)
  local f = Q.panel
  if not f or not f:IsShown() then return end
  if not keepStatus then f.status:SetText("") end
  f.hint:SetText("Everything else is on the war table: press Ctrl+Shift+G (the Guild Camp app).")
  local items = Q.items()
  f.head:SetText(#items == 0 and "Nothing needs you right now." or (#items == 1 and "1 thing right now" or (#items .. " things right now")))
  for i, r in ipairs(f.rows) do
    local it = items[i]
    if it then
      -- Buttons sit at the right, the last one outermost; the text gets what's left.
      local n, right = #it.buttons, 4
      for k = 3, 1, -1 do
        local spec, b = it.buttons[k], r.b[k]
        if spec then
          b:SetText(spec[1])
          b:SetSize(math.max(46, #spec[1] * 7 + 16), 20)
          b:ClearAllPoints(); b:SetPoint("RIGHT", -right, 0)
          right = right + math.max(46, #spec[1] * 7 + 16) + 4
          b:SetScript("OnClick", function() Q.say(ns.safely(spec[2])) end)
          b:Show()
        else b:Hide() end
      end
      r.text:SetWidth(math.max(60, Q.WIDTH - 24 - 8 - right))
      r.text:SetText(it.text)
      r.count = n
      r:Show()
    else r.count = 0; r:Hide() end
  end
  if #items > Q.ROWS and f.status:GetText() == "" then f.status:SetText(string.format("And %d more on the war table.", #items - Q.ROWS)) end
end

function Q.show()
  Q.panel = Q.panel or makePanel()
  Q.panel:Show()
  Q.refresh()
  -- Once: where the big window went.
  if not ns.db.quickSeen then
    ns.db.quickSeen = true
    ns.print(GOLD .. "The guild's pages are on the war table now: press Ctrl+Shift+G.|r This panel is for what has to happen in the game at once. /wow full opens the old window.")
  end
  return Q.panel
end
function Q.hide() if Q.panel then Q.panel:Hide() end end
function Q.toggle()
  if Q.panel and Q.panel:IsShown() then Q.hide() else Q.show() end
end

-- The campfire, the key binding and /wow: the quick panel, or the full window for those who chose it.
function Q.usesFullWindow() return ns.opt("fullWindow") == true end
function Q.open()
  if Q.usesFullWindow() then return ns.ui.toggle() end
  return Q.toggle()
end

-- Things arrive (a call to arms, a group, a recruit): the open panel follows.
function Q.changed() if Q.panel and Q.panel:IsShown() then ns.safely(Q.refresh, true) end end
ns.on("ADDON_LOADED", function(name)
  if name ~= ADDON then return end
  local s = ns.Share
  if type(s) == "table" and type(s.onRecord) == "function" then s.onRecord(function() Q.changed() end) end
end)
ns.on("CHAT_MSG_ADDON", function() Q.changed() end)
