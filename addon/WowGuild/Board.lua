-- Guild Camp: the guild bulletin board in game ("bb" records, docs/SHARING.md). Shared with the guild like crafting
-- requests, so it works without the app; the app shows it under Bulletin board.
--   /wow board                      the posts (newest first)
--   /wow board lfg|wts|wtb|help <text> [<gold>g]   put one up (a price only for wts/wtb)
--   /wow board down <n>             take down one of mine (its number in the list)
-- A fresh post from a guildmate gets one chat line.
local ADDON, ns = ...
local B = {}
ns.board = B

B.KINDS = { lfg = "l", wts = "s", wtb = "w", help = "h" }
B.LABEL = { l = "LFG", s = "Selling", w = "Buying", h = "Help" }
local FRESH = 900
local SHOW = 12

local function S() local s = ns.Share; if type(s) == "table" and type(s.list) == "function" and type(s.putLocal) == "function" then return s end end
local function plain(s) return (string.gsub(tostring(s or ""), "|", "||")) end
local function now() return (GetServerTime and ns.try(GetServerTime)) or time() end
local function money(c)
  if not c or c <= 0 then return nil end
  local g, s = math.floor(c / 10000), math.floor((c % 10000) / 100)
  if g > 0 then return s > 0 and string.format("%dg %ds", g, s) or string.format("%dg", g) end
  return string.format("%ds", s)
end
B.money = money

-- Open posts, newest first: { { key, kind, text, price, character, pid, t } }.
function B.posts()
  local sh, out = S(), {}
  if not sh then return out end
  for _, r in ipairs(sh.list("bb")) do
    local f = r.fields or {}
    if f.state == "o" and f.text and f.text ~= "" then
      out[#out + 1] = { key = r.key, kind = f.kind, text = f.text, price = f.price, character = f.character or r.author, pid = f.pid, t = r.t or 0, fields = f }
    end
  end
  -- Newest first; the key breaks ties so posts made in the same second keep their order.
  table.sort(out, function(a, b) if a.t ~= b.t then return a.t > b.t end return tostring(a.key) < tostring(b.key) end)
  return out
end

function B.list()
  local posts = B.posts()
  if #posts == 0 then ns.print("The bulletin board is empty. /wow board lfg|wts|wtb|help <text> to put something up."); return 0 end
  local sh = S()
  local pid = sh and sh.myPid and ns.try(sh.myPid)
  ns.print("Guild bulletin board:")
  for i, p in ipairs(posts) do
    if i > SHOW then ns.print(string.format("  … and %d more in the Guild Camp app.", #posts - SHOW)); break end
    local price = money(p.price)
    ns.print(string.format("  %d. |cffe8a33d%s|r %s%s — %s%s", i, B.LABEL[p.kind] or "Post", plain(p.text), price and (" (" .. price .. ")") or "",
      plain(p.character), p.pid == pid and " |cff9e9ea8(yours: /wow board down " .. i .. ")|r" or ""))
  end
  return #posts
end

-- "Mooncloth x4 12g" → text, price in copper (only a trailing "<n>g" or "<n>g <n>s" counts as the price).
function B.parse(args)
  local text = tostring(args or ""):gsub("^%s+", ""):gsub("%s+$", "")
  local g, s = string.match(text, "%s(%d+)g%s*(%d*)s?$")
  if g then
    text = text:gsub("%s%d+g%s*%d*s?$", "")
    return text, tonumber(g) * 10000 + (tonumber(s) or 0) * 100
  end
  return text, nil
end

function B.post(kindWord, args)
  local kind = B.KINDS[string.lower(kindWord or "")]
  if not kind then ns.print("/wow board lfg|wts|wtb|help <text> [price like 12g]"); return false end
  local text, price = B.parse(args)
  if kind ~= "s" and kind ~= "w" then price = nil end
  if text == "" then ns.print("Write what the post is about, e.g. /wow board wts Mooncloth x4 12g"); return false end
  local sh = S()
  local pid = sh and sh.myPid and ns.try(sh.myPid)
  if not sh or not pid then ns.print("The board isn't ready yet: guild sharing starts a little after login. Try again in a minute."); return false end
  -- putLocal returns the stored record, or nil and a reason (sharing not open, …): only a stored record is a post.
  local called, res = pcall(sh.putLocal, "bb", ns.randomKey(), { pid = pid, character = UnitName and UnitName("player") or "?",
    kind = kind, text = string.sub(text, 1, 200), price = price, state = "o" })
  local ok = (called and res) and true or false
  if ok then ns.print(string.format("Posted to the guild board: %s %s%s. It stays up for a week.", B.LABEL[kind], plain(text), price and (" (" .. money(price) .. ")") or ""))
  else ns.print("Couldn't post that. Try a shorter message.") end
  return ok
end

-- One of mine, by its number in the list (/wow board down 3), or by its record key with B.takeDownKey (the
-- window's rows: a number would hit a different post once a newer one has arrived since the page was drawn).
local function takeDownPost(p)
  local sh = S()
  local pid = sh and sh.myPid and ns.try(sh.myPid)
  if not p or not pid or p.pid ~= pid then ns.print("That isn't one of your posts. /wow board lists them with their numbers."); return false end
  local f = {}
  for k, v in pairs(p.fields) do f[k] = v end
  f.state = "x"
  local called, res = pcall(sh.putLocal, "bb", p.key, f)
  local ok = (called and res) and true or false
  ns.print(ok and "Post taken down." or "Couldn't take that post down.")
  return ok
end

function B.takeDown(n) return takeDownPost(B.posts()[tonumber(n or "") or 0]) end

function B.takeDownKey(key)
  for _, x in ipairs(B.posts()) do if x.key == key then return takeDownPost(x) end end
  return takeDownPost(nil)
end

function B.slash(rest)
  local cmd, args = string.match(rest or "", "^(%S*)%s*(.-)$")
  cmd = string.lower(cmd or "")
  if cmd == "" or cmd == "list" then return B.list()
  elseif cmd == "down" or cmd == "remove" then return B.takeDown(args)
  elseif B.KINDS[cmd] then return B.post(cmd, args)
  else
    ns.print("/wow board  read the guild bulletin board")
    ns.print("/wow board lfg|wts|wtb|help <text> [12g]  put up a post  ·  /wow board down <n>  take yours down")
  end
end

-- A guildmate's fresh post: one chat line.
local seen = {}
function B.arrived(rec, how, from)
  if type(rec) ~= "table" or rec.type ~= "bb" or rec.del or how == "s" or type(rec.fields) ~= "table" then return nil end
  local f = rec.fields
  local me = UnitName and UnitName("player")
  if f.state ~= "o" or rec.author == me or seen[rec.key] then return nil end
  if type(rec.t) ~= "number" or now() - rec.t > FRESH then return nil end
  seen[rec.key] = true
  local price = money(f.price)
  local line = string.format("|cffe8a33dBoard|r %s: %s%s — %s (/wow board)", B.LABEL[f.kind] or "Post", plain(f.text), price and (" (" .. price .. ")") or "", plain(f.character or rec.author))
  ns.print(line)
  return line
end

ns.on("ADDON_LOADED", function(name)
  if name ~= ADDON then return end
  local sh = ns.Share
  if type(sh) == "table" and type(sh.onRecord) == "function" then sh.onRecord(B.arrived) end
end)
