-- Guild Camp: the sharing codec (docs/SHARING.md, protocol v1).
--
-- The same codec as app/src/shared/sharing.js, byte for byte: records, escaping, base36,
-- varint id lists, djb2, buckets, short ids, digests, versions, expiry, record checks, the
-- receive rules and the H/I/G/R/M message layouts. It depends on nothing else in the addon
-- and can be loaded on its own (it returns the codec as well as setting ns.ShareCodec).
--
-- Rules for this file (it runs on Lua 5.1 in game and on fengari, Lua 5.3 with 32-bit
-- integers, in tests): no integer division, bit operators, goto, utf8.*, string.pack,
-- math.type or tonumber(s, 36); numbers on the wire are made by our own loops, never by
-- tostring; every large number is kept as a float (x + 0.0) so fengari's 32-bit integers
-- never overflow; character classes are byte tables, never locale-dependent patterns.
-- Nothing here errors on bad input: decoders return nil, checks return a reason.
--
-- Function names are the same as in sharing.js (camelCase), with these differences:
--   JS null                 -> nil
--   JS arrays / objects     -> Lua tables (decoded empty lists are {}; nil fields are absent)
--   lookup(id)              -> a function returning a record string, a decoded record or nil
--   acceptRecord(...)       -> returns a table { ok = true, how, rec } or { ok = false, reason }
--   splitRecord / packRecords / encodeGet / inventoryPages -> arrays (Lua tables)
--   byteLength(s)           -> #s
-- Field names: docs/SHARING.md, Appendix A.

local _, ns = ...
if type(ns) ~= "table" then ns = {} end

local C = {}
ns.ShareCodec = C

local floor = math.floor
local byte, sub, char = string.byte, string.sub, string.char
local concat, sort = table.concat, table.sort

local K = {
  MAJOR = 1,
  MINOR = 1,
  PREFIX = "GuildCamp",
  FINAL_BASE = 2700000000000.0,
  FINAL_MIN = 1350000000000.0,
  HOUR = 3600,
  DAY = 86400,
  FUTURE_SLACK = 300,
  PARENT_FALLBACK_DAYS = 120,
  TOMB_NEVER_DAYS = 180,
  UNKNOWN_DAYS = 14,
  ID_MAX = 64,
  NAME_MAX = 48,
  RECORD_MAX = 8715,
  MEMBER_BUCKETS = 32,
  OFFICER_BUCKETS = 16,
  BUCKETS = 48,
  SHORT_MOD = 1679616,
  DIGEST_MOD = 1679615,
  INT_MAX_CHARS = 10,
  MSG_MAX = 255,
  HELLO_MAX = 210,
  HELLO_VERSION_MAX = 11,
  INV_PER_PAGE = 20,
  INV_MAX = 250,
  INV_PAGES_MAX = 35,
  GET_MAX_IDS = 55,
  R_SINGLE_MAX = 253,
  M_DATA_MAX = 249,
  M_PARTS_MAX = 35,
  MID_MOD = 1296,
  AUTHOR_MAX_RECORDS = 300,
  AUTHOR_MAX_BYTES = 65536,
  AUTHOR_MAX_RC_BYTES = 32768,
  STORE_MAX_RECORDS = 4000,
  STORE_MAX_BYTES = 614400,
  UNKNOWN_MAX_RECORDS = 200,
  UNKNOWN_MAX_BYTES = 32768,
  BONUS_STEP = 10,
  LY_EVERY_DAYS = 14,
  LY_FOLD_DAYS = 30,
  SHRINK_ROUNDS = 16,
}
C.K = K

local TWO32 = 4294967296.0
local INT_LIMIT = 3656158440062976.0 -- 36^10
local B36 = "0123456789abcdefghijklmnopqrstuvwxyz"
local VARINT = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_"
local HEX = "0123456789ABCDEF"
C.VARINT = VARINT

-- Byte lookups (built once).
local B36VAL, VARVAL, HEXVAL = {}, {}, {}
for i = 1, 36 do B36VAL[byte(B36, i)] = i - 1 end
for i = 1, 64 do VARVAL[byte(VARINT, i)] = i - 1 end
for i = 1, 16 do HEXVAL[byte(HEX, i)] = i - 1 end
local MUST = {} -- bytes that must be escaped in text: ~ ^ ; , # | , below 0x20 and 0x7F
for c = 0, 31 do MUST[c] = true end
MUST[127], MUST[126], MUST[94], MUST[59], MUST[44], MUST[35], MUST[124] = true, true, true, true, true, true, true
local NAMEBAD = {} -- bytes never allowed in names, keys and authors
for c = 0, 32 do NAMEBAD[c] = true end
NAMEBAD[127], NAMEBAD[126], NAMEBAD[94], NAMEBAD[59], NAMEBAD[44], NAMEBAD[35], NAMEBAD[124], NAMEBAD[58] = true, true, true, true, true, true, true, true
local WIREBAD = {} -- bytes never allowed anywhere in a record: controls, 0x7F, # and |
for c = 0, 31 do WIREBAD[c] = true end
WIREBAD[127], WIREBAD[35], WIREBAD[124] = true, true, true
local VERSIONOK = {} -- [0-9A-Za-z.-]
for i = 1, 62 do VERSIONOK[byte(VARINT, i)] = true end
VERSIONOK[46], VERSIONOK[45] = true, true

C.SKILLS = {
  [129] = "First Aid", [164] = "Blacksmithing", [165] = "Leatherworking", [171] = "Alchemy", [182] = "Herbalism",
  [185] = "Cooking", [186] = "Mining", [197] = "Tailoring", [202] = "Engineering", [333] = "Enchanting", [356] = "Fishing",
  [393] = "Skinning", [755] = "Jewelcrafting", [773] = "Inscription",
}

-- ---------------------------------------------------------------------------------------
-- The type table (§4.3). Mirrors TYPES in sharing.js exactly (a test compares the two).
-- ---------------------------------------------------------------------------------------
local function text(n, max) return { n = n, k = "text", max = max } end
local function int(n, dash) return { n = n, k = "int", dash = dash } end
local function enm(n, values) return { n = n, k = "enum", values = values } end
local function flag(n) return { n = n, k = "flag" } end
local function pInt(n) return { n = n, k = "int" } end
local function pText(n, max) return { n = n, k = "text", max = max } end
local function listOf(n, maxItems, max) return { n = n, k = "list", maxItems = maxItems, of = { k = "text", max = max } } end
local function listParts(n, maxItems, parts, rest) return { n = n, k = "list", maxItems = maxItems, parts = parts, rest = rest } end
local function tuple(n, parts) return { n = n, k = "tuple", parts = parts } end
local function itemCount() return { pInt("id"), pInt("count") } end

local TYPES = {
  ch = {
    key = { "name" }, author = "key", max = 400, expiry = { days = 60 },
    fields = {
      text("pid", 64), text("battletag", 32), flag("main"), listOf("alts", 20, 48),
      text("class", 20), text("race", 20), int("level"), text("faction", 12), int("ilvl"), int("repair"),
      tuple("consumables", { pInt("flask"), pInt("elixir"), pInt("potion"), pInt("food"), pInt("bandage") }),
      listParts("professions", 12, { pInt("skill"), pInt("rank"), pInt("max") }),
      tuple("pvp", { pInt("rank"), pInt("hk") }), text("addon", 16),
      -- Raid readiness (appended fields: older addons leave them out): points per talent tree, resistances, unenchanted slot ids.
      tuple("talents", { pInt("a"), pInt("b"), pInt("c"), pInt("unspent") }),
      tuple("resists", { pInt("fire"), pInt("nature"), pInt("frost"), pInt("shadow"), pInt("arcane") }),
      { n = "unenchanted", k = "list", maxItems = 10, of = { k = "int" } },
    },
  },
  rc = {
    key = { "name", "int" }, author = "key", max = 2048, maxIf = { field = "kind", value = "n", max = 6144 },
    expiry = { days = 60, newerOf = "ch" },
    fields = {
      enm("kind", "sin"), int("count"),
      { n = "list", k = "switch", on = "kind", cases = { n = { k = "list", maxItems = 500, of = { k = "text", max = 100 } } }, default = { k = "ids", maxItems = 2000 } },
    },
  },
  su = {
    key = { "b36x6", "pid" }, max = 400, expiry = { parent = "RD", seg = 1 },
    fields = {
      text("character", 48), enm("role", "thd"), enm("status", "ytnb"), text("note", 120),
      listOf("reserves", 10, 12), int("reservesAt"), listOf("prev", 10, 12), int("prevAt"),
    },
  },
  cr = {
    key = { "b36x6" }, max = 400, final = { field = "state", values = "xd" }, expiry = { days = 30, finalDays = 7 },
    fields = { text("pid", 64), text("item", 100), text("notes", 200), enm("state", "oxd") },
  },
  cl = {
    key = { "b36x6", "pid" }, max = 60, expiry = { parent = "cr", seg = 1 },
    fields = { enm("state", "cdw"), int("claimedAt") },
  },
  lp = {
    key = { "pid", "name" }, max = 400, expiry = { days = 3 },
    fields = { text("character", 48), int("level"), text("zone", 60), text("when", 60), text("note", 140) },
  },
  ca = {
    key = { "b36x6" }, max = 300, expiry = { days = 1 },
    fields = { text("character", 48), text("zone", 60), int("needed"), text("message", 200) },
  },
  -- Dungeon groups: dg is a group a guildmate puts together, dj a guildmate joining it with a role.
  dg = {
    key = { "b36x6" }, max = 400, final = { field = "state", values = "xd" }, expiry = { field = "startsAt", days = 1 },
    fields = {
      text("pid", 64), text("character", 48), text("dungeon", 60), int("startsAt"), enm("role", "thd"), int("level"),
      int("tank"), int("heal"), int("dps"), text("note", 140), enm("state", "oxd"),
    },
  },
  dj = {
    key = { "b36x6", "pid" }, max = 160, expiry = { parent = "dg", seg = 1 },
    fields = { text("character", 48), enm("role", "thd"), enm("status", "yw"), text("class", 20), int("level"), int("joinedAt") },
  },
  dc = {
    key = { "b36x6" }, max = 250, expiry = { parent = "DR", field = "drive" },
    fields = { text("pid", 64), text("drive", 8), text("character", 48), int("amount"), text("note", 120) },
  },
  bq = {
    key = { "b36x6" }, max = 400, final = { field = "state", values = "x" }, expiry = { days = 30 },
    fields = { text("pid", 64), text("item", 100), int("count"), text("note", 200), enm("state", "ox") },
  },
  gb = {
    key = { "tab" }, max = 1536, expiry = { days = 30 },
    variants = {
      ["0"] = {
        int("scannedAt"), int("money"), listOf("tabs", 8, 32),
        listParts("log", 25, { pInt("at"), pText("kind", 12), pText("who", 48), pInt("item"), pInt("count"), pInt("amount") }),
      },
    },
    fields = { listParts("items", 98, itemCount()) },
  },
  bk = {
    key = { "name" }, author = "key", max = 2048, expiry = { days = 30 },
    fields = { listParts("bags", 200, itemCount()), listParts("bank", 300, itemCount()) },
  },
  sh = {
    key = { "pid" }, max = 1024, expiry = { days = 30 },
    fields = { listParts("items", 20, { pText("name", 100), pInt("qty"), pInt("skill") }) },
  },
  pr = {
    key = { "pid" }, max = 800, expiry = { days = 14 },
    fields = { int("day"), listParts("prices", 60, { pInt("id"), pInt("copper") }) },
  },
  RD = {
    key = { "b36x6" }, max = 600, expiry = { field = "startsAt", days = 45 },
    fields = {
      enm("kind", "rpe"), text("title", 60), text("instance", 60), int("startsAt"), int("minutes"), int("size"),
      int("srLimit"), text("notes", 300),
    },
  },
  RT = {
    key = { "b36x6" }, max = 2048, final = { field = "status", values = "xd" }, expiry = { parent = "RD", seg = 1 },
    fold = { field = "status", value = "d", kindField = "kind", kind = "r" },
    fields = {
      enm("status", "olxd"), int("lockedAt"), enm("kind", "rpe"), text("instance", 8), int("closedAt"),
      listParts("attendees", 60, { pText("pid", 64) }, { n = "items", k = "text", max = 12, maxItems = 20 }),
      listOf("noShows", 60, 64),
    },
  },
  LA = {
    key = { "b36x6" }, max = 300, expiry = { days = 180 }, fold = {},
    fields = {
      text("raid", 8), text("instance", 8), text("item", 12), text("itemName", 100), text("character", 48),
      text("pid", 64), enm("kind", "smof"), int("roll"), int("bonus"),
    },
  },
  LL = {
    key = { "b36x6" }, max = 8192, expiry = { never = true },
    fields = {
      text("name", 60), listOf("bosses", 40, 60),
      listParts("items", 150, { pText("item", 12), pInt("boss"), pText("name", 100) }),
    },
  },
  LY = {
    key = { "b36x6" }, max = 3072, expiry = { never = true },
    fields = { int("upto"), listParts("bonuses", 200, { pText("pid", 64), pText("item", 12), pInt("bonus") }) },
  },
  AN = { key = { "b36x6" }, max = 600, expiry = { days = 60 }, fields = { text("body", 500) } },
  DR = {
    key = { "b36x6" }, max = 500, final = { field = "state", values = "c" }, expiry = { days = 180, finalDays = 60 },
    fields = { text("title", 80), text("unit", 40), int("goal"), text("notes", 300), enm("state", "oc") },
  },
  BH = { key = { "b36x6" }, max = 40, expiry = { parent = "bq", seg = 1 }, fields = { enm("state", "sd") } },
  BC = { key = { "one" }, max = 700, expiry = { never = true }, fields = { listOf("names", 50, 48) } },
  CFG = {
    key = { "one" }, max = 40, rank = "gm", expiry = { never = true },
    fields = { int("officerRankMax"), int("relayRankMax", true) },
  },
  WH = {
    key = { "one" }, max = 300, channel = "OFFICER", noBucket = true, firstHand = true, expiry = { never = true },
    fields = { text("url", 250) },
  },
}
C.TYPES = TYPES

-- "member" for an all-lowercase type of 1-4 letters, "officer" for all-uppercase, else nil.
local function spaceOf(t)
  if type(t) ~= "string" or #t < 1 or #t > 4 then return nil end
  local lower, upper = true, true
  for i = 1, #t do
    local c = byte(t, i)
    if c < 97 or c > 122 then lower = false end
    if c < 65 or c > 90 then upper = false end
  end
  if lower then return "member" end
  if upper then return "officer" end
  return nil
end
C.spaceOf = spaceOf
for code, spec in pairs(TYPES) do
  spec.code = code
  spec.space = spaceOf(code)
end

-- ---------------------------------------------------------------------------------------
-- Bytes, hashes, base36
-- ---------------------------------------------------------------------------------------
function C.byteLength(s) return type(s) == "string" and #s or 0 end

local function djb2(s)
  if type(s) ~= "string" then s = "" end
  local h = 5381.0
  for i = 1, #s do h = (h * 33 + byte(s, i)) % TWO32 end
  return h
end
C.djb2 = djb2

-- A non-negative whole number below 36^10 (as a float), else nil.
local function whole(n)
  if type(n) ~= "number" or n ~= n or n < 0 or n >= INT_LIMIT then return nil end
  return floor(n) + 0.0
end

local function toB36(n)
  n = whole(n)
  if not n then return "" end
  if n == 0 then return "0" end
  local out = {}
  while n > 0 do
    local d = n % 36
    out[#out + 1] = sub(B36, d + 1, d + 1)
    n = (n - d) / 36
  end
  local m = #out
  for i = 1, floor(m / 2) do out[i], out[m + 1 - i] = out[m + 1 - i], out[i] end
  return concat(out)
end
C.toB36 = toB36

local function pad36(n, width)
  if type(width) ~= "number" or width ~= width or width < 0 then width = 0 end
  if width > 16 then width = 16 end
  width = floor(width)
  local s = toB36(n)
  if #s > width then s = sub(s, #s - width + 1) end
  if #s < width then s = string.rep("0", width - #s) .. s end
  return s
end
C.pad36 = pad36

local function fromB36(s)
  if type(s) ~= "string" or #s == 0 or #s > K.INT_MAX_CHARS then return nil end
  local n = 0.0
  for i = 1, #s do
    local d = B36VAL[byte(s, i)]
    if not d then return nil end
    n = n * 36 + d
  end
  return n
end
C.fromB36 = fromB36

local function isB36(s, len)
  if type(s) ~= "string" or #s ~= len then return false end
  for i = 1, len do if not B36VAL[byte(s, i)] then return false end end
  return true
end

local function cutUtf8(s, max)
  if type(s) ~= "string" then return "" end
  if type(max) ~= "number" or max ~= max then return s end
  if #s <= max then return s end
  local cut = max
  if cut < 0 then cut = 0 end
  while cut > 0 do
    local c = byte(s, cut + 1)
    if c < 128 or c > 191 then break end
    cut = cut - 1
  end
  return sub(s, 1, cut)
end
C.cutUtf8 = cutUtf8

local function escape(s, max)
  if type(s) ~= "string" then return "" end
  if max then s = cutUtf8(s, max) end
  local out, start = {}, 1
  for i = 1, #s do
    local c = byte(s, i)
    if MUST[c] then
      if i > start then out[#out + 1] = sub(s, start, i - 1) end
      local lo = c % 16
      local hi = (c - lo) / 16
      out[#out + 1] = "~" .. sub(HEX, hi + 1, hi + 1) .. sub(HEX, lo + 1, lo + 1)
      start = i + 1
    end
  end
  if start == 1 then return s end
  if start <= #s then out[#out + 1] = sub(s, start) end
  return concat(out)
end
C.escape = escape

-- Cut an escaped text to at most max bytes, never inside a "~XX" escape or a UTF-8 sequence.
local function cutEscaped(e, max)
  if type(e) ~= "string" then return "" end
  if type(max) ~= "number" or max ~= max then return e end
  if #e <= max then return e end
  local cut = max
  if cut < 0 then cut = 0 end
  while cut > 0 do
    local c = byte(e, cut + 1)
    if c < 128 or c > 191 then break end
    cut = cut - 1
  end
  if cut >= 1 and byte(e, cut) == 126 then
    cut = cut - 1
  elseif cut >= 2 and byte(e, cut - 1) == 126 then
    cut = cut - 2
  end
  return sub(e, 1, cut)
end
C.cutEscaped = cutEscaped

local function unescape(s)
  if type(s) ~= "string" then return nil end
  local out, start, i, n = {}, 1, 1, #s
  while i <= n do
    local c = byte(s, i)
    if c == 126 then
      local hi, lo = HEXVAL[byte(s, i + 1) or 0], HEXVAL[byte(s, i + 2) or 0]
      if not hi or not lo then return nil end
      local b = hi * 16 + lo
      if not MUST[b] then return nil end
      if i > start then out[#out + 1] = sub(s, start, i - 1) end
      out[#out + 1] = char(b)
      i = i + 3
      start = i
    elseif MUST[c] then
      return nil
    else
      i = i + 1
    end
  end
  if start == 1 then return s end
  if start <= n then out[#out + 1] = sub(s, start) end
  return concat(out)
end
C.unescape = unescape

-- ---------------------------------------------------------------------------------------
-- Varint id lists (most significant group first, 5 bits per character; 0-31 end a number)
-- ---------------------------------------------------------------------------------------
local function varint(n)
  local groups = {}
  repeat
    local d = n % 32
    groups[#groups + 1] = d
    n = (n - d) / 32
  until n <= 0
  local out = {}
  for i = #groups, 1, -1 do
    local d = groups[i]
    if i > 1 then d = d + 32 end
    out[#out + 1] = sub(VARINT, d + 1, d + 1)
  end
  return concat(out)
end

local function encodeIds(ids, maxItems)
  if type(ids) ~= "table" then return "" end
  local vals = {}
  for _, x in ipairs(ids) do
    local n = whole(x)
    if n then vals[#vals + 1] = n end
  end
  sort(vals)
  local out, prev, count = {}, -1, 0
  for _, n in ipairs(vals) do
    if n ~= prev then
      if maxItems and count >= maxItems then break end
      if prev < 0 then out[#out + 1] = varint(n) else out[#out + 1] = varint(n - prev) end
      prev = n
      count = count + 1
    end
  end
  return concat(out)
end
C.encodeIds = encodeIds

local function decodeIds(s)
  if type(s) ~= "string" then return nil end
  local out, acc, digits, prev = {}, 0.0, 0, nil
  for i = 1, #s do
    local d = VARVAL[byte(s, i)]
    if not d then return nil end
    acc = acc * 32 + (d % 32)
    digits = digits + 1
    if digits > 10 then return nil end
    if d < 32 then
      local n = acc
      if prev then n = prev + acc end
      out[#out + 1] = n
      prev = n
      acc = 0.0
      digits = 0
    end
  end
  if digits ~= 0 then return nil end
  return out
end
C.decodeIds = decodeIds

-- ---------------------------------------------------------------------------------------
-- Buckets, short ids, digests
-- ---------------------------------------------------------------------------------------
local function typeOfId(id)
  if type(id) ~= "string" then return "" end
  local i = string.find(id, ":", 1, true)
  if not i or i < 2 then return "" end
  return sub(id, 1, i - 1)
end

function C.bucket(id)
  local t = typeOfId(id)
  local space = spaceOf(t)
  if not space or (TYPES[t] and TYPES[t].noBucket) then return nil end
  local h = djb2(id)
  if space == "member" then return h % K.MEMBER_BUCKETS end
  return K.MEMBER_BUCKETS + h % K.OFFICER_BUCKETS
end

function C.shortId(id) return pad36(djb2((type(id) == "string" and id or "") .. "#") % K.SHORT_MOD, 4) end

local function digestTerm(id, v)
  return djb2((type(id) == "string" and id or "") .. "^" .. (type(v) == "string" and v or ""))
end
C.digestTerm = digestTerm
local function digestValue(sum, count)
  if type(sum) == "number" and sum == sum and type(count) == "number" and count == count and count > 0 and sum >= 0 and sum < 9007199254740992 then return 1 + sum % K.DIGEST_MOD end
  return 0
end
C.digestValue = digestValue
function C.digestString(sum, count) return pad36(digestValue(sum, count), 4) end

function C.mayServe(b, trustedMe)
  return type(b) == "number" and (b < K.MEMBER_BUCKETS or trustedMe and true or false)
end

-- ---------------------------------------------------------------------------------------
-- Versions
-- ---------------------------------------------------------------------------------------
function C.makeVersion(t, author, final)
  t = whole(t) or 0.0
  local h = djb2(author) % 64
  if final then return pad36(K.FINAL_BASE - t * 64 + h, 8) end
  return pad36(t * 64 + h, 8)
end

function C.nextT(t, tOld)
  t = whole(t) or 0.0
  local o = whole(tOld)
  if o and o >= t then return o + 1 end
  return t
end

local function isFinalV(v)
  local n = fromB36(v)
  return n ~= nil and n >= K.FINAL_MIN
end
C.isFinalV = isFinalV

local function tOfVersion(v)
  if type(v) ~= "string" or #v ~= 8 then return nil end
  local n = fromB36(v)
  if not n then return nil end
  local h = n % 64
  if n >= K.FINAL_MIN then return (K.FINAL_BASE - n + h) / 64 end
  return (n - h) / 64
end
C.tOfVersion = tOfVersion

local function compareVersions(a, b)
  local x, y = fromB36(a), fromB36(b)
  if x == y then return 0 end
  if x == nil then return -1 end
  if y == nil then return 1 end
  if x > y then return 1 end
  return -1
end
C.compareVersions = compareVersions

-- Byte order, independent of the locale.
local function compareBytes(a, b)
  if type(a) ~= "string" then a = "" end
  if type(b) ~= "string" then b = "" end
  if a == b then return 0 end
  local n = #a
  if #b < n then n = #b end
  for i = 1, n do
    local x, y = byte(a, i), byte(b, i)
    if x ~= y then
      if x > y then return 1 end
      return -1
    end
  end
  if #a > #b then return 1 end
  return -1
end
C.compareBytes = compareBytes

local function versionOf(rec)
  if type(rec) ~= "string" then return nil end
  local a = string.find(rec, "^", 1, true)
  if not a then return nil end
  local b = string.find(rec, "^", a + 1, true)
  if b then return sub(rec, a + 1, b - 1) end
  return sub(rec, a + 1)
end

function C.compareRecords(a, b)
  local c = compareVersions(versionOf(a), versionOf(b))
  if c ~= 0 then return c end
  return compareBytes(type(a) == "string" and a or "", type(b) == "string" and b or "")
end

local function hourStart(now)
  if type(now) ~= "number" or now ~= now or now == 1 / 0 or now == -1 / 0 then return 0 end
  return floor(now / K.HOUR) * K.HOUR
end
C.hourStart = hourStart

-- ---------------------------------------------------------------------------------------
-- Keys
-- ---------------------------------------------------------------------------------------
local function nameOk(s, allowDot)
  if type(s) ~= "string" or #s == 0 or #s > K.NAME_MAX then return false end
  for i = 1, #s do
    local c = byte(s, i)
    if NAMEBAD[c] or (c == 46 and not allowDot) then return false end
  end
  return true
end
local function authorOk(s) return nameOk(s, false) end
C.authorOk = authorOk

local function pidOk(s)
  if type(s) ~= "string" or #s > 64 or #s < 6 then return false end
  if byte(s, #s - 4) ~= 46 then return false end
  return nameOk(sub(s, 1, #s - 5), false) and isB36(sub(s, #s - 3), 4)
end
C.pidOk = pidOk

local function split(s, sep)
  if type(s) ~= "string" then return {} end
  if type(sep) ~= "string" or sep == "" then return { s } end
  local out, pos = {}, 1
  while true do
    local i = string.find(s, sep, pos, true)
    if not i then
      out[#out + 1] = sub(s, pos)
      return out
    end
    out[#out + 1] = sub(s, pos, i - 1)
    pos = i + 1
  end
end
C.split = split

local function segOk(kind, s)
  if kind == "name" then return nameOk(s, false) end
  if kind == "b36x6" then return isB36(s, 6) end
  if kind == "int" then return fromB36(s) ~= nil end
  if kind == "pid" then return pidOk(s) end
  if kind == "tab" then return #s == 1 and byte(s) >= 48 and byte(s) <= 56 end
  if kind == "one" then return s == "1" end
  return false
end

local function keyOk(t, key)
  local spec = TYPES[t]
  if not spec then return true end
  local segs = split(key, ":")
  if #segs ~= #spec.key then return false end
  for i = 1, #segs do if not segOk(spec.key[i], segs[i]) then return false end end
  return true
end
C.keyOk = keyOk

local function randomChars(n, rng)
  if type(rng) ~= "function" then rng = math.random end
  local out = {}
  for i = 1, n do
    local d = floor(rng() * 36) % 36
    out[i] = sub(B36, d + 1, d + 1)
  end
  return concat(out)
end
function C.randomKey(rng) return randomChars(6, rng) end
function C.newPid(anchor, rng)
  if type(anchor) ~= "string" then anchor = "" end
  return anchor .. "." .. randomChars(4, rng)
end

local function asciiLowerTrim(s)
  if type(s) ~= "string" then return "" end
  local a, b = 1, #s
  while a <= b do
    local c = byte(s, a)
    if c ~= 32 and c ~= 9 and c ~= 10 and c ~= 13 then break end
    a = a + 1
  end
  while b >= a do
    local c = byte(s, b)
    if c ~= 32 and c ~= 9 and c ~= 10 and c ~= 13 then break end
    b = b - 1
  end
  local out = {}
  for i = a, b do
    local c = byte(s, i)
    if c >= 65 and c <= 90 then c = c + 32 end
    out[#out + 1] = char(c)
  end
  return concat(out)
end

function C.itemKey(idOrName)
  if type(idOrName) == "number" then
    local n = whole(idOrName)
    if n and n > 0 then return toB36(n) end
    return ""
  end
  local name = asciiLowerTrim(idOrName)
  if name == "" then return "" end
  return "h" .. pad36(djb2(name) % 60466176, 5)
end

function C.instanceKey(name)
  local n = asciiLowerTrim(name)
  if n == "" then return "" end
  return pad36(djb2(n) % 2176782336.0, 6)
end

-- ---------------------------------------------------------------------------------------
-- Field values
-- ---------------------------------------------------------------------------------------
local BAD = {} -- marker for a value that does not decode

local function encodeScalar(spec, value, escCap)
  local k = spec.k
  if k == "text" then
    if type(value) ~= "string" then value = "" end
    local e = escape(value, spec.max)
    if escCap then return cutEscaped(e, escCap) end
    return e
  elseif k == "int" then
    local s = toB36(value)
    if s == "" and spec.dash then return "-" end
    return s
  elseif k == "enum" then
    if type(value) == "string" and #value == 1 and string.find(spec.values, value, 1, true) then return value end
    return ""
  elseif k == "flag" then
    if value == true or value == 1 or value == "1" then return "1" end
    return ""
  end
  return ""
end

local function decodeScalar(spec, s)
  local k = spec.k
  if k == "text" then
    local t = unescape(s)
    if t == nil then return BAD end
    return t
  elseif k == "int" then
    if s == "" or (spec.dash and s == "-") then return nil end
    local n = fromB36(s)
    if n == nil then return BAD end
    return n
  elseif k == "enum" then
    if s == "" or (#s == 1 and string.find(spec.values, s, 1, true)) then return s end
    return BAD
  elseif k == "flag" then
    if s == "" then return false end
    if s == "1" then return true end
    return BAD
  end
  return BAD
end

local function trimJoin(strs, n, sep)
  while n > 0 and strs[n] == "" do n = n - 1 end
  if n == 0 then return "" end
  return concat(strs, sep, 1, n)
end

local function encodeParts(parts, rest, obj)
  if type(obj) ~= "table" then obj = {} end
  local strs = {}
  for i = 1, #parts do strs[i] = encodeScalar(parts[i], obj[parts[i].n]) end
  local n = #parts
  if rest and type(obj[rest.n]) == "table" then
    local count = 0
    for _, x in ipairs(obj[rest.n]) do
      if count >= rest.maxItems then break end
      local s = encodeScalar(rest, x)
      if s ~= "" then
        n = n + 1
        strs[n] = s
        count = count + 1
      end
    end
  end
  return trimJoin(strs, n, ",")
end

local function encodeValue(spec, value, fields, escCap)
  local k = spec.k
  if k == "list" then
    local out = {}
    if type(value) == "table" then
      for _, x in ipairs(value) do
        if #out >= spec.maxItems then break end
        local s
        if spec.of then s = encodeScalar(spec.of, x) else s = encodeParts(spec.parts, spec.rest, x) end
        if s ~= "" then out[#out + 1] = s end
      end
    end
    return concat(out, ";")
  elseif k == "tuple" then
    return encodeParts(spec.parts, nil, value)
  elseif k == "ids" then
    return encodeIds(value, spec.maxItems)
  elseif k == "switch" then
    local sel = fields and fields[spec.on]
    local subspec = (type(sel) == "string" and spec.cases[sel]) or spec.default
    return encodeValue(subspec, value, fields)
  end
  return encodeScalar(spec, value, escCap)
end

local function decodeParts(parts, rest, s)
  local bits = split(s, ",")
  local o = {}
  for i = 1, #parts do
    local v = decodeScalar(parts[i], bits[i] or "")
    if v == BAD then return BAD end
    o[parts[i].n] = v
  end
  if rest then
    local r = {}
    for i = #parts + 1, #bits do
      local v = decodeScalar(rest, bits[i])
      if v == BAD then return BAD end
      r[#r + 1] = v
    end
    o[rest.n] = r
  end
  return o
end

local function decodeValue(spec, s, fields)
  local k = spec.k
  if k == "list" then
    local out = {}
    if s == "" then return out end
    for _, item in ipairs(split(s, ";")) do
      local v
      if spec.of then v = decodeScalar(spec.of, item) else v = decodeParts(spec.parts, spec.rest, item) end
      if v == BAD then return BAD end
      out[#out + 1] = v
    end
    return out
  elseif k == "tuple" then
    return decodeParts(spec.parts, nil, s)
  elseif k == "ids" then
    local v = decodeIds(s)
    if v == nil then return BAD end
    return v
  elseif k == "switch" then
    local sel = fields[spec.on]
    local subspec = (type(sel) == "string" and spec.cases[sel]) or spec.default
    return decodeValue(subspec, s, fields)
  end
  return decodeScalar(spec, s)
end

local function fieldsFor(t, key)
  local spec = TYPES[t]
  if not spec then return nil end
  if spec.variants and spec.variants[key] then return spec.variants[key] end
  return spec.fields
end
C.fieldsFor = fieldsFor

local function maxFor(t, fields)
  local spec = TYPES[t]
  if not spec then return K.RECORD_MAX end
  if spec.maxIf and type(fields) == "table" and fields[spec.maxIf.field] == spec.maxIf.value then return spec.maxIf.max end
  return spec.max
end
C.maxFor = maxFor

local function encodeFieldList(specs, fields, budget)
  if type(fields) ~= "table" then fields = {} end
  local caps, body = {}, ""
  for _ = 1, K.SHRINK_ROUNDS do
    local strs = {}
    for i = 1, #specs do strs[i] = encodeValue(specs[i], fields[specs[i].n], fields, caps[i]) end
    body = trimJoin(strs, #specs, "^")
    if not budget or #body <= budget then return body end
    local over = #body - budget
    local best, bestLen = nil, 0
    for i = 1, #specs do
      if specs[i].k == "text" then
        local len = #strs[i]
        if len > 0 and len >= bestLen then best, bestLen = i, len end
      end
    end
    if not best then return body end
    local cap = bestLen - over
    if cap < 0 then cap = 0 end
    caps[best] = cap
  end
  return body
end

function C.encodeBody(t, key, fields, author)
  if type(key) ~= "string" then return "" end
  local specs = fieldsFor(t, key)
  if not specs then return "" end
  local id = t .. ":" .. key
  local alen = K.NAME_MAX
  if type(author) == "string" and author ~= "" then alen = #author end
  local head = #id + 1 + 8 + 1 + alen + 1
  return encodeFieldList(specs, fields, maxFor(t, fields) - head - 1)
end

local function encode(rec)
  if type(rec) ~= "table" then return "" end
  local t, key = rec.type, rec.key
  if type(rec.id) == "string" and (not t or key == nil) then
    local i = string.find(rec.id, ":", 1, true) or (#rec.id + 1)
    t, key = sub(rec.id, 1, i - 1), sub(rec.id, i + 1)
  end
  if type(t) ~= "string" then t = "" end
  if type(key) ~= "string" then key = "" end
  local id = t .. ":" .. key
  local v = rec.v
  if type(v) == "number" then v = pad36(v, 8) elseif type(v) ~= "string" then v = "" end
  local author = type(rec.author) == "string" and rec.author or ""
  local head = id .. "^" .. v .. "^" .. author .. "^" .. (rec.del and "d" or "")
  if rec.del then return head end
  local body
  local specs = fieldsFor(t, key)
  if specs then
    body = encodeFieldList(specs, rec.fields, maxFor(t, rec.fields) - #head - 1)
  else
    local strs, n = {}, 0
    if type(rec.raw) == "table" then
      for _, x in ipairs(rec.raw) do
        n = n + 1
        strs[n] = type(x) == "string" and x or ""
      end
    end
    body = trimJoin(strs, n, "^")
  end
  if body == "" then return head end
  return head .. "^" .. body
end
C.encode = encode

-- ---------------------------------------------------------------------------------------
-- Parsing and decoding
-- ---------------------------------------------------------------------------------------
local function parse(str)
  if type(str) ~= "string" or #str < 14 or #str > K.RECORD_MAX then return nil end
  for i = 1, #str do if WIREBAD[byte(str, i)] then return nil end end
  local parts = split(str, "^")
  if #parts < 4 then return nil end
  local id, v, author, flags = parts[1], parts[2], parts[3], parts[4]
  local colon = string.find(id, ":", 1, true)
  if not colon or colon < 2 or #id > K.ID_MAX then return nil end
  local t, key = sub(id, 1, colon - 1), sub(id, colon + 1)
  if not spaceOf(t) or key == "" then return nil end
  for i = 1, #key do
    local c = byte(key, i)
    if c == 32 or c == 126 or c == 59 or c == 44 then return nil end
  end
  if not isB36(v, 8) or not authorOk(author) then return nil end
  if flags ~= "" and flags ~= "d" then return nil end
  if flags == "d" and #parts ~= 4 then return nil end
  if fromB36(v) % 64 ~= djb2(author) % 64 then return nil end
  local raw = {}
  for i = 5, #parts do raw[#raw + 1] = parts[i] end
  return { id = id, type = t, key = key, v = v, t = tOfVersion(v), author = author, del = flags == "d", raw = raw }
end
C.parse = parse

local function decode(str)
  local p = parse(str)
  if not p then return nil end
  local specs = fieldsFor(p.type, p.key)
  if not specs then
    return { id = p.id, type = p.type, key = p.key, v = p.v, t = p.t, author = p.author, del = p.del, raw = p.raw }
  end
  if not keyOk(p.type, p.key) then return nil end
  local fields = {}
  if not p.del then
    for i = 1, #specs do
      local val = decodeValue(specs[i], p.raw[i] or "", fields)
      if val == BAD then return nil end
      fields[specs[i].n] = val
    end
  end
  return { id = p.id, type = p.type, key = p.key, v = p.v, t = p.t, author = p.author, del = p.del, fields = fields }
end
C.decode = decode

local function asRec(x)
  if type(x) == "string" then return decode(x) end
  if type(x) == "table" then return x end
  return nil
end

-- ---------------------------------------------------------------------------------------
-- Final versions, expiry, folding
-- ---------------------------------------------------------------------------------------
local function isFinal(rec)
  local spec = type(rec) == "table" and TYPES[rec.type]
  if not spec or not spec.final or rec.del or type(rec.fields) ~= "table" then return false end
  local val = rec.fields[spec.final.field]
  return type(val) == "string" and #val == 1 and string.find(spec.final.values, val, 1, true) ~= nil
end
C.isFinal = isFinal

local function isFoldable(rec)
  local spec = type(rec) == "table" and TYPES[rec.type]
  if not spec or not spec.fold or rec.del or type(rec.fields) ~= "table" then return false end
  local f = spec.fold
  if f.field and rec.fields[f.field] ~= f.value then return false end
  if f.kindField and rec.fields[f.kindField] ~= f.kind then return false end
  return true
end
C.isFoldable = isFoldable

local function isFolded(rec, lookup)
  local inst = rec.fields and rec.fields.instance
  if type(inst) ~= "string" or inst == "" or type(lookup) ~= "function" then return false end
  local ly = asRec(lookup("LY:" .. inst))
  return ly ~= nil and not ly.del and type(ly.fields) == "table" and type(ly.fields.upto) == "number" and rec.t <= ly.fields.upto
end

local function expiresAt(recIn, lookup, depth)
  depth = depth or 0
  local rec = asRec(recIn)
  if not rec or type(rec.t) ~= "number" then return nil end
  local spec = TYPES[rec.type]
  local t = rec.t
  if not spec then return t + K.UNKNOWN_DAYS * K.DAY end
  local e = spec.expiry
  if e.never then
    if rec.del then return t + K.TOMB_NEVER_DAYS * K.DAY end
    return nil
  end
  if e.parent then
    local pkey
    if e.seg then
      pkey = split(rec.key, ":")[e.seg]
    elseif e.field and type(rec.fields) == "table" and type(rec.fields[e.field]) == "string" and rec.fields[e.field] ~= "" then
      pkey = rec.fields[e.field]
    end
    local parent
    if pkey and depth < 3 and type(lookup) == "function" then parent = asRec(lookup(e.parent .. ":" .. pkey)) end
    if parent then return expiresAt(parent, lookup, depth + 1) end
    return t + K.PARENT_FALLBACK_DAYS * K.DAY
  end
  if e.field then
    local base = t
    if not rec.del and type(rec.fields) == "table" and type(rec.fields[e.field]) == "number" then base = rec.fields[e.field] end
    return base + e.days * K.DAY
  end
  local base = t
  if e.newerOf and type(lookup) == "function" then
    local p = asRec(lookup(e.newerOf .. ":" .. split(rec.key, ":")[1]))
    if p and type(p.t) == "number" and p.t > base then base = p.t end
  end
  local days = e.days
  if e.finalDays and isFinal(rec) then days = e.finalDays end
  return base + days * K.DAY
end
C.expiresAt = expiresAt

local function isExpired(recIn, hour, lookup)
  if type(hour) ~= "number" or hour ~= hour or hour == 1 / 0 or hour == -1 / 0 then hour = 0 end
  local rec = asRec(recIn)
  if not rec then return true end
  if isFoldable(rec) and not isFolded(rec, lookup) then return false end
  local at = expiresAt(rec, lookup)
  return at ~= nil and at <= hour
end
C.isExpired = isExpired

-- ---------------------------------------------------------------------------------------
-- Checks
-- ---------------------------------------------------------------------------------------
-- nil when fine, else "malformed" | "oversize" | "author" | "future" | "expired".
local function checkRecord(str, now, lookup)
  if type(now) ~= "number" or now ~= now or now == 1 / 0 or now == -1 / 0 then now = 0 end
  if type(str) ~= "string" then return "malformed" end
  if #str > K.RECORD_MAX then return "oversize" end
  local rec = decode(str)
  if not rec then return "malformed" end
  local spec = TYPES[rec.type]
  if spec then
    if isFinalV(rec.v) ~= isFinal(rec) then return "malformed" end
    if #str > maxFor(rec.type, rec.fields) then return "oversize" end
    if spec.author == "key" and rec.author ~= split(rec.key, ":")[1] then return "author" end
  end
  if rec.t > now + K.FUTURE_SLACK then return "future" end
  if isExpired(rec, hourStart(now), lookup) then return "expired" end
  return nil
end
C.checkRecord = checkRecord

local function rankOf(env, name)
  local r = type(env) == "table" and type(env.ranks) == "table" and name ~= nil and env.ranks[name] or nil
  if type(r) == "number" and r == r then return r end
  return nil
end
local function isOfficer(env, name)
  local r = rankOf(env, name)
  local max = 1
  if type(env) == "table" and type(env.officerRankMax) == "number" then max = env.officerRankMax end
  return r ~= nil and (r == 0 or r <= max)
end
C.isOfficer = isOfficer
local function isTrusted(env, name)
  if isOfficer(env, name) then return true end
  local r = rankOf(env, name)
  return r ~= nil and type(env) == "table" and type(env.relayRankMax) == "number" and r <= env.relayRankMax
end
C.isTrusted = isTrusted

-- Receive rules 1-4 for one record from env.sender (see sharing.js acceptRecord).
function C.acceptRecord(str, now, lookup, env)
  if type(env) ~= "table" then env = {} end
  if env.sender == env.me then return { ok = false, reason = "self" } end
  local p = parse(str)
  if not p then return { ok = false, reason = "malformed" } end
  local spec = TYPES[p.type]
  local want = (spec and spec.channel) or "GUILD"
  if (env.channel or "GUILD") ~= want then return { ok = false, reason = "channel" } end
  if rankOf(env, env.sender) == nil then return { ok = false, reason = "unknown" } end
  local how
  if spaceOf(p.type) == "member" then
    if env.sender == p.author then how = "d" else how = "m" end
  elseif env.sender == p.author then
    local ok
    if spec and spec.rank == "gm" then ok = rankOf(env, p.author) == 0 else ok = isOfficer(env, p.author) end
    if not ok then return { ok = false, reason = "rank" } end
    how = "d"
  else
    if (spec and spec.firstHand) or not isTrusted(env, env.sender) then return { ok = false, reason = "rank" } end
    how = "t"
  end
  local reason = checkRecord(str, now, lookup)
  if reason then return { ok = false, reason = reason } end
  return { ok = true, how = how, rec = decode(str) }
end

function C.overAuthorCaps(usage, t, bytes)
  if spaceOf(t) ~= "member" or not TYPES[t] then return false end -- unknown types: one store-wide budget instead
  if type(bytes) ~= "number" or bytes ~= bytes then bytes = 0 end
  local u = type(usage) == "table" and usage or {}
  if (u.count or 0) + 1 > K.AUTHOR_MAX_RECORDS then return true end
  if t == "rc" then return (u.rcBytes or 0) + bytes > K.AUTHOR_MAX_RC_BYTES end
  return (u.bytes or 0) + bytes > K.AUTHOR_MAX_BYTES
end

function C.addAuthorUsage(usage, t, bytes, sign)
  if type(sign) ~= "number" or sign ~= sign then sign = 1 end
  if type(bytes) ~= "number" or bytes ~= bytes then bytes = 0 end
  local u = type(usage) == "table" and usage or { count = 0, bytes = 0, rcBytes = 0 }
  u.count = (u.count or 0) + sign
  if t == "rc" then u.rcBytes = (u.rcBytes or 0) + sign * bytes else u.bytes = (u.bytes or 0) + sign * bytes end
  return u
end

-- ---------------------------------------------------------------------------------------
-- Messages
-- ---------------------------------------------------------------------------------------
local function versionOk(s)
  for i = 1, #s do if not VERSIONOK[byte(s, i)] then return false end end
  return true
end
local function minOf(a, b) if a < b then return a end return b end

function C.encodeHello(h)
  if type(h) ~= "table" or type(h.digests) ~= "table" or #h.digests ~= K.BUCKETS then return "" end
  local addon = ""
  if type(h.addon) == "string" and versionOk(h.addon) then addon = sub(h.addon, 1, K.HELLO_VERSION_MAX) end
  local out = { "1H", pad36(minOf(whole(h.minor) or 0, 35), 1), pad36(minOf(whole(h.count) or 0, 46655), 3) }
  for i = 1, K.BUCKETS do out[#out + 1] = pad36(minOf(whole(h.digests[i]) or 0, K.DIGEST_MOD), 4) end
  out[#out + 1] = "^"
  out[#out + 1] = addon
  return concat(out)
end

function C.parseHello(msg)
  if type(msg) ~= "string" or #msg < 199 or #msg > K.HELLO_MAX or sub(msg, 1, 2) ~= "1H" then return nil end
  local minor, count = fromB36(sub(msg, 3, 3)), fromB36(sub(msg, 4, 6))
  if not minor or not count or byte(msg, 199) ~= 94 then return nil end
  local digests = {}
  for i = 0, K.BUCKETS - 1 do
    local d = fromB36(sub(msg, 7 + i * 4, 10 + i * 4))
    if not d or d > K.DIGEST_MOD then return nil end
    digests[i + 1] = d
  end
  local addon = sub(msg, 200)
  if not versionOk(addon) then return nil end
  return { minor = minor, count = count, digests = digests, addon = addon }
end

local function encodeInventory(inv)
  if type(inv) ~= "table" or type(inv.entries) ~= "table" or #inv.entries > K.INV_PER_PAGE then return "" end
  local b, page, pages = whole(inv.bucket), whole(inv.page), whole(inv.pages)
  if not b or b >= K.BUCKETS or not page or page == 0 or not pages or pages == 0 or page > pages or pages > K.INV_PAGES_MAX then return "" end
  local out = { "1I", pad36(b, 2), pad36(minOf(whole(inv.digest) or 0, K.DIGEST_MOD), 4), pad36(page, 1), pad36(pages, 1) }
  for _, e in ipairs(inv.entries) do
    if type(e) ~= "table" or not isB36(e.shortId, 4) or not isB36(e.v, 8) then return "" end
    out[#out + 1] = e.shortId .. e.v
  end
  return concat(out)
end
C.encodeInventory = encodeInventory

function C.inventoryPages(b, digest, entries)
  local list = {}
  if type(entries) == "table" then
    for _, e in ipairs(entries) do
      if type(e) == "table" and isB36(e.shortId, 4) and isB36(e.v, 8) then list[#list + 1] = { shortId = e.shortId, v = e.v } end
    end
  end
  sort(list, function(x, y)
    local c = compareBytes(x.shortId, y.shortId)
    if c == 0 then c = compareBytes(x.v, y.v) end
    return c < 0
  end)
  local maxEntries = K.INV_PER_PAGE * K.INV_PAGES_MAX
  local n = minOf(#list, maxEntries)
  local pages = floor((n + K.INV_PER_PAGE - 1) / K.INV_PER_PAGE)
  if pages < 1 then pages = 1 end
  local out = {}
  for p = 1, pages do
    local chunk = {}
    for i = (p - 1) * K.INV_PER_PAGE + 1, minOf(p * K.INV_PER_PAGE, n) do chunk[#chunk + 1] = list[i] end
    out[#out + 1] = encodeInventory({ bucket = b, digest = digest, page = p, pages = pages, entries = chunk })
  end
  return out
end

function C.parseInventory(msg)
  if type(msg) ~= "string" or #msg < 10 or #msg > K.INV_MAX or sub(msg, 1, 2) ~= "1I" then return nil end
  local b, digest = fromB36(sub(msg, 3, 4)), fromB36(sub(msg, 5, 8))
  local page, pages = fromB36(sub(msg, 9, 9)), fromB36(sub(msg, 10, 10))
  if not b or b >= K.BUCKETS or not digest or digest > K.DIGEST_MOD or not page or page == 0 or not pages or pages == 0 or page > pages then return nil end
  local body = sub(msg, 11)
  if #body % 12 ~= 0 then return nil end
  local entries = {}
  for i = 1, #body, 12 do
    local sid, v = sub(body, i, i + 3), sub(body, i + 4, i + 11)
    if not isB36(sid, 4) or not isB36(v, 8) then return nil end
    entries[#entries + 1] = { shortId = sid, v = v }
  end
  return { bucket = b, digest = digest, page = page, pages = pages, entries = entries }
end

function C.encodeGet(target, shortIds)
  local out = {}
  if not authorOk(target) then return out end
  local room = minOf(K.GET_MAX_IDS, floor((K.MSG_MAX - 3 - #target) / 4))
  local ids = {}
  if type(shortIds) == "table" then
    for _, s in ipairs(shortIds) do if isB36(s, 4) then ids[#ids + 1] = s end end
  end
  local i = 1
  while i <= #ids do
    out[#out + 1] = "1G" .. target .. "^" .. concat(ids, "", i, minOf(i + room - 1, #ids))
    i = i + room
  end
  return out
end

function C.parseGet(msg)
  if type(msg) ~= "string" or #msg > K.MSG_MAX or sub(msg, 1, 2) ~= "1G" then return nil end
  local caret = string.find(msg, "^", 3, true)
  if not caret or caret < 4 then return nil end
  local target, ids = sub(msg, 3, caret - 1), sub(msg, caret + 1)
  if not authorOk(target) or #ids == 0 or #ids % 4 ~= 0 or #ids / 4 > K.GET_MAX_IDS then return nil end
  local shortIds = {}
  for i = 1, #ids, 4 do
    local s = sub(ids, i, i + 3)
    if not isB36(s, 4) then return nil end
    shortIds[#shortIds + 1] = s
  end
  return { target = target, shortIds = shortIds }
end

function C.packRecords(records)
  local out, cur, curLen = {}, nil, 0
  if type(records) ~= "table" then return out end
  for _, r in ipairs(records) do
    if type(r) == "string" and r ~= "" and #r <= K.R_SINGLE_MAX then
      if cur and curLen + 1 + #r <= K.MSG_MAX then
        cur[#cur + 1] = "#"
        cur[#cur + 1] = r
        curLen = curLen + 1 + #r
      else
        if cur then out[#out + 1] = concat(cur) end
        cur = { "1R", r }
        curLen = 2 + #r
      end
    end
  end
  if cur then out[#out + 1] = concat(cur) end
  return out
end

function C.parseRecords(msg)
  if type(msg) ~= "string" or #msg < 3 or #msg > K.MSG_MAX or sub(msg, 1, 2) ~= "1R" then return nil end
  local recs = split(sub(msg, 3), "#")
  for i = 1, #recs do if recs[i] == "" then return nil end end
  return recs
end

function C.splitRecord(record, mid)
  local out = {}
  if type(record) ~= "string" or record == "" then return out end
  local chunks, i, n = {}, 1, #record
  while i <= n do
    local last = i + K.M_DATA_MAX - 1
    if last >= n then
      last = n
    else
      local e = last
      while e >= i do
        local c = byte(record, e + 1)
        if c < 128 or c > 191 then break end
        e = e - 1
      end
      if e >= i then last = e end
    end
    chunks[#chunks + 1] = sub(record, i, last)
    if #chunks > K.M_PARTS_MAX then return {} end
    i = last + 1
  end
  local m = pad36((whole(mid) or 0) % K.MID_MOD, 2)
  for p = 1, #chunks do out[p] = "1M" .. m .. pad36(p, 1) .. pad36(#chunks, 1) .. chunks[p] end
  return out
end

function C.parseParts(msg)
  if type(msg) ~= "string" or #msg < 7 or #msg > K.MSG_MAX or sub(msg, 1, 2) ~= "1M" then return nil end
  local mid, part, parts = fromB36(sub(msg, 3, 4)), fromB36(sub(msg, 5, 5)), fromB36(sub(msg, 6, 6))
  local data = sub(msg, 7)
  if not mid or not part or part == 0 or not parts or parts == 0 or part > parts or data == "" or #data > K.M_DATA_MAX then return nil end
  return { mid = mid, part = part, parts = parts, data = data }
end

function C.joinParts(datas)
  if type(datas) ~= "table" then return nil end
  local n = 0
  for k in pairs(datas) do
    if type(k) ~= "number" then return nil end
    n = n + 1
  end
  if n == 0 then return nil end
  for i = 1, n do
    if type(datas[i]) ~= "string" or datas[i] == "" then return nil end
  end
  return concat(datas, "", 1, n)
end

function C.messageKind(msg)
  if type(msg) ~= "string" or #msg < 2 then return nil end
  local d, l = byte(msg, 1), byte(msg, 2)
  if d < 48 or d > 57 or l < 65 or l > 90 then return nil end
  return { major = d - 48, type = sub(msg, 2, 2) }
end

return C
