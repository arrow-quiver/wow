-- Guild Camp: sharing guild data with guildmates in game (docs/SHARING.md §5-§9, §11).
--
-- This file holds the store (WowGuildDB.shared), receiving and checking records, the send
-- queues and token bucket, record packing and parts, the outbox and seed the app writes in
-- the inbox, the player id, and the API other modules use (ns.Share). ShareSync.lua adds the
-- exchange (H/I/G), hellos, the beacon and pruning. Record format, hashes and rules all come
-- from ShareCodec.lua (ns.ShareCodec); nothing here re-implements them.
--
-- Rules for this file (Lua 5.1 in game, fengari = Lua 5.3 with 32-bit integers in tests):
-- no integer division, bit operators, goto, utf8.*, string.pack, math.type, unpack or
-- tonumber(s, 36); wire numbers only through the codec; every time value is a float; every
-- event handler and timer is protected, so nothing here ever errors into the game.
--
-- API (ns.Share):
--   offer(type, key, fields)          a record the addon builds (ch, rc, gb, bk, sh); re-stamped
--                                     by the §4.3 / §11 policy and pushed when due
--   putLocal(type, key, fields, opts) an action taken in game (opts.del = tombstone); goes out at once
--   myPid(), get(id), list(type), digests(), ready(), statusLine(), slash(rest), onRecord(fn)
--   meInfo()                          what the app says about me in this guild: { pid, bt, main, alts } or nil
--                                     (player ids are per guild: inbox me.byG[partition], else the top-level me)

local ADDON, ns = ...
if type(ns) ~= "table" then ns = {} end
local SC = ns.ShareCodec
if type(SC) ~= "table" then return end -- without the codec nothing is shared
local K = SC.K

local floor = math.floor
local sub, find, byte, char = string.sub, string.find, string.byte, string.char
local concat = table.concat

local S = {}
ns.Share = S
local I = {} -- internals shared with ShareSync.lua
S._ = I

-- Every tunable number (§7, §8, §9, §11, §15). Times in seconds.
local CFG = {
  PREFIX = "GuildCamp",
  -- token bucket (§7): 8 tokens, +1 every 1.25 s, under the game's 10 and 1 a second
  BUCKET_MAX = 8,
  BUCKET_START = 2,          -- after a login or /reload the game's own bucket may be nearly empty
  REFILL_SECONDS = 1.25,
  FAIL_PAUSE = 3,            -- a refused send: pause this long
  FAIL_SLOW = 60,            -- ... and refill at half speed this long
  FAIL_SLOW_FACTOR = 2,
  SEND_PER_PUMP = 8,
  REPLY_GAP = 0.25, REPLY_GAP_RAND = 0.5, -- replies (P2) go one at a time, 0.25-0.75 s apart, so a guildmate's
                                          -- identical reply is seen in time to drop ours (and none run in step)
  QUEUE_MAX = 400,           -- P2 + P3 entries
  -- incoming work
  FRAME_BUDGET_MS = 3,
  INBOUND_MAX = 600,
  FLOOD_PER_MINUTE = 90,
  FLOOD_IGNORE = 600,
  UNKNOWN_WAIT = 30,         -- a sender missing from the roster is buffered this long
  UNKNOWN_PER_SENDER = 40,
  UNKNOWN_SENDERS = 20,
  PART_TIMEOUT = 60,         -- an incomplete M record is dropped after this
  PARTS_OPEN_PER_SENDER = 8,
  -- sync (§8; used by ShareSync.lua)
  HELLO_MIN = 3, HELLO_MAX = 15, HELLO_PER_PEER = 0.5, HELLO_CAP = 40,
  HELLO_BUSY = 3, HELLO_BUSY_WINDOW = 10, HELLO_BACKOFF_CAP = 120,
  REPLY_MIN = 0.5, REPLY_W_BASE = 1, REPLY_W_PER_PEER = 0.2, REPLY_W_MAX = 6,
  PEER_WINDOW = 1800,        -- "guildmates heard in the last 30 min"
  SEEN_I = 60, SEEN_G = 60, SEEN_R = 600, SEEN_H = 300,
  STALE_MARGIN = 5,          -- an R seen this soon before a request may not have reached the asker yet
  INV_WAIT = 3,
  GET_RETRY = 20, GET_TRIES = 2, -- a G whose records have not arrived after 20 s goes again, twice at most
  REPEAT_GUARD = 7200,       -- the same I to the same guildmate at most this often ...
  REPEAT_LEVELS = 4,         -- ... and each time the very same I is due again, twice as long (2, 4, 8, 16 hours)
  REPEAT_AGAIN = 90,         -- ... but a catch-up (few buckets differ, fewer records than mine) may get my I once more
  PUSH_FULL_GUARD = 86400,   -- a whole bucket is pushed to one guildmate at most this often (after that, a refill:)
  REFILL_MAX = 4,            -- refills (my I for buckets they say are empty, and what I sent for their G forgiven) a
  REFILL_EVERY = 2400,       -- guildmate can get at once, and one more every 40 min (a game that keeps crashing)
  REFILL_SPAN = 600,         -- their hellos this long after a refill are part of it (unless they used it)
  REFILL_IDLE = 1800,        -- a second refill in a row they asked nothing for: no other for 30 min, then 2, 8, 16 h
  WIDE_HELLO = 24,           -- a hello differing in this many of 48 buckets is no catch-up (REPEAT_AGAIN)
  ANSWER_BUDGET = 96,        -- buckets answered (I or a whole-bucket push) to one guildmate's hellos per SEEN_R
  WIDE_ROUNDS = 4,           -- hellos that are no catch-up answered with my I's, per guildmate per REPEAT_GUARD
  GET_REPEAT_BUDGET = 64,    -- records sent again for one guildmate's G (sent for their G in REPEAT_GUARD), per SEEN_R
  CAPS_SLACK = 40, CAPS_SLACK_BYTES = 6144, -- over the store caps (§11), evict down to this far below them
  CAPS_STUCK = 60,           -- a pass that found too little it may push out: no new pass for relayed records this long
  BEACON = 600, BEACON_JITTER = 120, BEACON_PEERS = 900, BEACON_SLOT = 600,
  CATCHUP = 120, CATCHUP_JITTER = 20, EXCHANGE_WINDOW = 30,
  SETTLE = 30,               -- a store that changed through an exchange this recently answers no hellos
  INSTANCE_REHELLO = 300,    -- a hello after leaving an instance only after this long inside
  READY_RETRY = 3,           -- roster loaded but the guild's name not known yet: look again this often
  PRUNE_JITTER = 30,
  HOUSEKEEPING = 60,
  -- records
  CH_MIN_GAP = 1800,         -- ch: a real change at most every 30 min
  REFRESH = 604800,          -- ch, bk, sh, gb: re-stamped weekly even when unchanged
  GB_MIN_AGE = 900, GB_TAB0_GAP = 7200,
  CA_FRESH = 900,            -- a call to arms younger than this gets a chat line and a sound
  OUTBOX_MAX_WAIT = 14 * 86400,
  WH_RESEND = 86400,
  PID_GRACE = 90,            -- with no pid anywhere, wait this long for guildmates' copies of my ch
  CH_FIX_GAP = 10,           -- a ch of mine relayed by someone else is overridden at most this often
  GUILDS_MAX = 3,
  SEED_MAX = 3000,
  NAMES_PER_MINUTE = 50,
  NAMES_PENDING_MAX = 2000,
  NAMES_MAX = 20000,
}
S.CONFIG = CFG
I.CFG = CFG

-- Types whose records several people edit (compare-and-set, §9).
local MULTI = { RT = true, LL = true, BC = true, DR = true, LY = true, CFG = true }
-- Records keyed by a player id: where the pid sits (key segment, or a field).
local PIDKEY = { su = { seg = 2 }, cl = { seg = 2 }, dj = { seg = 2 }, lp = { seg = 1 }, sh = { seg = 1 }, pr = { seg = 1 },
  cr = { field = "pid" }, dc = { field = "pid" }, bq = { field = "pid" }, dg = { field = "pid" } }

local SAY = {
  newer = "A guildmate has a newer Guild Camp addon. Update it from the Guild Camp app.",
  instance = "Waiting until you leave the dungeon.",
  noGuild = "You are not in a guild, so nothing is shared.",
  starting = "Sharing starts once the guild roster has loaded.",
}

-- ---------------------------------------------------------------------------------------
-- Small helpers
-- ---------------------------------------------------------------------------------------
local function report(err)
  if ns.reportError then ns.reportError(err) end
end

-- Call fn safely; an error is reported, never thrown into the game.
local function safe(fn, ...)
  local ok, err = pcall(fn, ...)
  if not ok then report(err) end
  return ok
end
I.safe = safe

local function say(msg)
  if ns.print then ns.print(msg) elseif DEFAULT_CHAT_FRAME then DEFAULT_CHAT_FRAME:AddMessage(msg) end
end

local function rand() return math.random() end
I.rand = rand

-- Server seconds, always a float (fengari's integers are 32-bit).
local function now()
  local t = GetServerTime and GetServerTime() or (time and time()) or 0
  return floor(t) + 0.0
end
I.now = now
local function clock() return (GetTime and GetTime() or 0) + 0.0 end
I.clock = clock

-- Decimal digits of a whole number, made by our own loop (never tostring: fengari prints 1.0).
local function dec(n)
  if type(n) ~= "number" or n ~= n then return "0" end
  n = floor(n)
  if n < 0 then return "-" .. dec(-n) end
  if n == 0 then return "0" end
  local out = {}
  while n > 0 do
    local d = n % 10
    out[#out + 1] = char(48 + d)
    n = (n - d) / 10
  end
  local m = #out
  for i = 1, floor(m / 2) do out[i], out[m + 1 - i] = out[m + 1 - i], out[i] end
  return concat(out)
end
I.dec = dec

-- 1368 -> "1,368"
local function grouped(n)
  local s = dec(n)
  local out = ""
  while #s > 3 do
    out = "," .. sub(s, #s - 2) .. out
    s = sub(s, 1, #s - 3)
  end
  return s .. out
end

-- id, v, author, flags of a record string (cheap; no field decoding).
local function head(str)
  if type(str) ~= "string" then return nil end
  local a = find(str, "^", 1, true)
  if not a then return nil end
  local b = find(str, "^", a + 1, true)
  if not b then return nil end
  local c = find(str, "^", b + 1, true)
  local author, flags = nil, ""
  if c then
    author = sub(str, b + 1, c - 1)
    local d = find(str, "^", c + 1, true)
    flags = d and sub(str, c + 1, d - 1) or sub(str, c + 1)
  else
    author = sub(str, b + 1)
  end
  return sub(str, 1, a - 1), sub(str, a + 1, b - 1), author, flags
end
I.head = head

local function vOf(str)
  local _, v = head(str)
  return v
end
I.vOf = vOf

-- Everything after the 4th "^" ("" when the record has no fields).
local function bodyOf(str)
  local pos = 0
  for _ = 1, 4 do
    pos = find(str, "^", pos + 1, true)
    if not pos then return "" end
  end
  return sub(str, pos + 1)
end

local function typeOf(id)
  local i = type(id) == "string" and find(id, ":", 1, true)
  if not i then return "" end
  return sub(id, 1, i - 1)
end
I.typeOf = typeOf

local function keyOf(id)
  local i = find(id, ":", 1, true)
  return sub(id, i + 1)
end

local function channelOf(id)
  local spec = SC.TYPES[typeOf(id)]
  return (spec and spec.channel) or "GUILD"
end
I.channelOf = channelOf

local function shortName(name)
  if type(name) ~= "string" then return nil end
  if Ambiguate then
    local ok, s = pcall(Ambiguate, name, "guild")
    if ok and type(s) == "string" then return s end
  end
  return name
end

-- ---------------------------------------------------------------------------------------
-- State
-- ---------------------------------------------------------------------------------------
local me                       -- this character
local gkey, P, X               -- partition key ("Realm/Guild"), its SavedVariables table, its in-memory index
local ranks = {}               -- roster: short name -> rank index (0 = Guild Master)
local onlineNow = {}           -- roster: short name -> true when online
local rosterScanned = false
local isReady, everReady, loading = false, false, false
local instanceSince            -- GetTime() when we entered an instance
local env = { ranks = ranks, officerRankMax = 1 }
local heard = {}               -- short name -> GetTime() of their last message
local listeners = {}
local pidPending = false       -- waiting PID_GRACE for guildmates' copies of my ch
local pidGen = 0               -- bumped on a guild switch: a PID_GRACE timer of the old guild does nothing
local chFix = { at = 0, pending = false } -- re-stamping my own ch over a relayed one (CH_FIX_GAP)
local deferred = {}            -- id -> { t, key, fields, at } offers waiting for their re-stamp time
local laterOffers = {}         -- offers made before the store was open
local inflight = {}            -- outbox op -> true once queued this session
local session = { newerSaid = false, waitSaid = false, seeded = false, mid = 0, alerted = {} }

I.heard = heard
I.ranks = ranks
I.onlineNow = onlineNow

function I.me() return me end
function I.P() return P end
function I.X() return X end
function I.gkey() return gkey end

-- What the app says about me in the guild of a partition key (default: the open one): { pid, bt, main, alts },
-- or nil. Player ids are per guild (§3): inbox me.byG[key]; the top-level me is the app's current guild (me.g),
-- or every guild when the app sent neither g nor byG.
local function meEntry(key)
  key = key or gkey
  local inbox = WowGuildInbox
  local m = type(inbox) == "table" and type(inbox.me) == "table" and inbox.me or nil
  if not m or type(key) ~= "string" then return nil end
  if type(m.byG) == "table" then
    local e = m.byG[key]
    if type(e) == "table" then return e end
  elseif m.g == nil then
    return m
  end
  if m.g == key then return m end
  return nil
end
I.meEntry = meEntry

-- ---------------------------------------------------------------------------------------
-- Roles (§5): ranks from my own roster scan, officer/relay ranks from CFG
-- ---------------------------------------------------------------------------------------
local function rankOf(name) return ranks[name] end
I.rankOf = rankOf
function I.officer(name) return SC.isOfficer(env, name) end
-- Has my roster scan of this guild come in (so a name missing from ranks is not in the guild)?
function I.rosterReady() return rosterScanned end
function I.trusted(name) return SC.isTrusted(env, name) end
function I.isGM(name) return ranks[name] == 0 end

-- ---------------------------------------------------------------------------------------
-- The store and its index
-- ---------------------------------------------------------------------------------------
local function newIndex()
  -- usage / byAuthor: member records of types this version knows, per author (§11 caps); unk / unkIds: records of
  -- types it doesn't know, which have one store-wide budget instead (anyone may write them in anyone's name).
  local x = { sum = {}, cnt = {}, inB = {}, bySid = {}, sidOf = {}, bucketOf = {}, count = 0, bytes = 0, usage = {}, dec = {},
    byAuthor = {}, unk = { count = 0, bytes = 0 }, unkIds = {} }
  for b = 0, K.BUCKETS - 1 do
    x.sum[b] = 0.0
    x.cnt[b] = 0
    x.inB[b] = {}
  end
  return x
end

local function index(id, str)
  local _, v, author = head(str)
  X.count = X.count + 1
  X.bytes = X.bytes + #str
  local b = SC.bucket(id)
  if b then
    X.sum[b] = X.sum[b] + SC.digestTerm(id, v)
    X.cnt[b] = X.cnt[b] + 1
    X.inB[b][id] = true
    X.bucketOf[id] = b
    local sid = X.sidOf[id]
    if not sid then
      sid = SC.shortId(id)
      X.sidOf[id] = sid
    end
    local set = X.bySid[sid]
    if not set then
      set = {}
      X.bySid[sid] = set
    end
    set[id] = true
  end
  local ty = typeOf(id)
  if not SC.TYPES[ty] then
    X.unk.count = X.unk.count + 1
    X.unk.bytes = X.unk.bytes + #str
    X.unkIds[id] = true
  elseif author and SC.spaceOf(ty) == "member" then
    X.usage[author] = SC.addAuthorUsage(X.usage[author], ty, #str, 1)
    local set = X.byAuthor[author]
    if not set then
      set = {}
      X.byAuthor[author] = set
    end
    set[id] = true
  end
end

local function unindex(id, str)
  local _, v, author = head(str)
  X.count = X.count - 1
  X.bytes = X.bytes - #str
  local b = X.bucketOf[id]
  if b then
    X.sum[b] = X.sum[b] - SC.digestTerm(id, v)
    X.cnt[b] = X.cnt[b] - 1
    if X.cnt[b] <= 0 then X.sum[b], X.cnt[b] = 0.0, 0 end
    X.inB[b][id] = nil
    X.bucketOf[id] = nil
    local sid = X.sidOf[id]
    local set = sid and X.bySid[sid]
    if set then
      set[id] = nil
      if next(set) == nil then X.bySid[sid] = nil end
    end
  end
  local ty = typeOf(id)
  if not SC.TYPES[ty] then
    if X.unkIds[id] then
      X.unk.count = X.unk.count - 1
      X.unk.bytes = X.unk.bytes - #str
      X.unkIds[id] = nil
    end
  elseif author and SC.spaceOf(ty) == "member" and X.usage[author] then
    local u = SC.addAuthorUsage(X.usage[author], ty, #str, -1)
    if (u.count or 0) <= 0 then u = nil end
    X.usage[author] = u
    local set = X.byAuthor[author]
    if set then
      set[id] = nil
      if next(set) == nil then X.byAuthor[author] = nil end
    end
  end
  X.dec[id] = nil
end

-- The decoded record for an id (cached), or nil. Also the codec's lookup function.
local function lookup(id)
  if not X or type(id) ~= "string" then return nil end
  local d = X.dec[id]
  if d then return d end
  local str = P.recs[id]
  if not str then return nil end
  d = SC.decode(str)
  if d then X.dec[id] = d end
  return d
end
I.lookup = lookup

local function refreshCfg()
  local c = lookup("CFG:1")
  local om, rm = 1, nil
  if c and not c.del and type(c.fields) == "table" then
    if type(c.fields.officerRankMax) == "number" then om = c.fields.officerRankMax end
    if type(c.fields.relayRankMax) == "number" then rm = c.fields.relayRankMax end
  end
  env.officerRankMax, env.relayRankMax = om, rm
end

-- Expired at the start of `hour` (§11)? A fast path for plain "days" types, the codec otherwise.
function I.expired(id, str, hour)
  local spec = SC.TYPES[typeOf(id)]
  if spec and not spec.fold then
    local e = spec.expiry
    if e.days and not e.parent and not e.field and not e.newerOf and not e.never then
      local _, v = head(str)
      local t = SC.tOfVersion(v)
      if not t then return true end
      local days = e.days
      if e.finalDays and SC.isFinalV(v) then days = e.finalDays end
      return t + days * K.DAY <= hour
    end
  end
  local rec = lookup(id)
  if not rec then return true end
  return SC.isExpired(rec, hour, lookup)
end

local function rebuildIndex()
  X = newIndex()
  local bad = {}
  for id, str in pairs(P.recs) do
    local hid = head(str)
    if type(id) ~= "string" or hid ~= id then bad[#bad + 1] = id else index(id, str) end
  end
  for _, id in ipairs(bad) do
    P.recs[id] = nil
    P.via[id] = nil
  end
  refreshCfg()
end

local function sharedRoot()
  if type(WowGuildDB) ~= "table" then WowGuildDB = {} end
  local root = WowGuildDB.shared
  if type(root) ~= "table" then
    root = { v = 1 }
    WowGuildDB.shared = root
  end
  root.v = 1
  if type(root.guilds) ~= "table" then root.guilds = {} end
  return root
end

local function normalizePartition(g)
  if type(g.recs) ~= "table" then g.recs = {} end
  if type(g.via) ~= "table" then g.via = {} end
  if type(g.sent) ~= "table" then g.sent = {} end
  if type(g.names) ~= "table" then g.names = {} end
  if type(g.names.s) ~= "table" then g.names.s = {} end
  if type(g.names.i) ~= "table" then g.names.i = {} end
  if type(g.stats) ~= "table" then g.stats = {} end
  local st = g.stats
  st.peers = st.peers or 0
  st.lastHello = st.lastHello or 0
  st.lastExchange = st.lastExchange or 0
  st.dropped = st.dropped or 0
  st.refused = st.refused or 0
end

-- The partition key of my current guild ("Realm/Guild"), or nil while the game doesn't give the guild's name.
local function currentGuildKey()
  local guild = GetGuildInfo and GetGuildInfo("player")
  if type(guild) ~= "string" or guild == "" then return nil end
  local realm = (GetRealmName and GetRealmName()) or ""
  return realm .. "/" .. guild
end

-- Open the partition of my current guild; at most GUILDS_MAX are kept.
local function openPartition()
  local key = currentGuildKey()
  if not key then return false end
  if key == gkey and P then return true end
  local root = sharedRoot()
  local g = root.guilds[key]
  if type(g) ~= "table" then
    g = {}
    root.guilds[key] = g
  end
  normalizePartition(g)
  g.used = now()
  local keys = {}
  for k, v in pairs(root.guilds) do
    if type(v) == "table" then keys[#keys + 1] = k else root.guilds[k] = nil end
  end
  if #keys > CFG.GUILDS_MAX then
    table.sort(keys, function(a, b) return (tonumber(root.guilds[a].used) or 0) > (tonumber(root.guilds[b].used) or 0) end)
    for i = CFG.GUILDS_MAX + 1, #keys do if keys[i] ~= key then root.guilds[keys[i]] = nil end end
  end
  gkey, P = key, g
  rebuildIndex()
  if ns.ShareSync and ns.ShareSync.onPartition then safe(ns.ShareSync.onPartition) end
  return true
end
I.openPartition = openPartition

-- ---------------------------------------------------------------------------------------
-- Names from game data (§9): spells at once, items after ITEM_DATA_LOAD_RESULT, 50 a minute
-- ---------------------------------------------------------------------------------------
local names = { pending = {}, list = {}, requested = {}, budget = CFG.NAMES_PER_MINUTE, count = 0 }

local function spellName(id)
  if C_Spell and C_Spell.GetSpellName then
    local ok, n = pcall(C_Spell.GetSpellName, id)
    if ok and type(n) == "string" then return n end
  end
  if GetSpellInfo then
    local ok, n = pcall(GetSpellInfo, id)
    if ok and type(n) == "string" then return n end
  end
  return nil
end

local function itemName(id)
  if C_Item and C_Item.GetItemNameByID then
    local ok, n = pcall(C_Item.GetItemNameByID, id)
    if ok and type(n) == "string" then return n end
  end
  local info = GetItemInfo or (C_Item and C_Item.GetItemInfo)
  if info then
    local ok, n = pcall(info, id)
    if ok and type(n) == "string" then return n end
  end
  return nil
end

local function namesFull()
  return names.count > CFG.NAMES_MAX
end

local function setName(kind, id, n)
  local t = P.names[kind]
  if t[id] == nil then names.count = names.count + 1 end
  t[id] = n
end

local function requestItems()
  while names.budget > 0 and #names.list > 0 do
    local id = table.remove(names.list, 1)
    names.pending[id] = nil
    if P and P.names.i[id] == nil then
      local n = itemName(id) -- also asks the game to load it
      if n then
        setName("i", id, n)
      else
        names.requested[id] = true
        names.budget = names.budget - 1
        if C_Item and C_Item.RequestLoadItemDataByID then pcall(C_Item.RequestLoadItemDataByID, id) end
      end
    end
  end
end

local function wantItem(id)
  if type(id) ~= "number" or id <= 0 or id ~= floor(id) or not P or namesFull() then return end
  id = floor(id)
  if P.names.i[id] ~= nil or names.pending[id] or names.requested[id] then return end
  local n = itemName(id)
  if n then
    setName("i", id, n)
    return
  end
  if #names.list >= CFG.NAMES_PENDING_MAX then return end
  names.pending[id] = true
  names.list[#names.list + 1] = id
end

local function wantSpell(id)
  if type(id) ~= "number" or id <= 0 or id ~= floor(id) or not P or namesFull() then return end
  id = floor(id)
  if P.names.s[id] ~= nil then return end
  local n = spellName(id)
  if n then setName("s", id, n) end
end

local function wantItemKey(key)
  if type(key) ~= "string" or key == "" or byte(key, 1) == 104 then return end -- "h…" = hashed name
  wantItem(SC.fromB36(key))
end

local function eachItem(list, field)
  if type(list) ~= "table" then return end
  for _, x in ipairs(list) do if type(x) == "table" then wantItem(x[field or "id"]) end end
end

-- Ask for the names of every id a received record mentions.
local function fillNames(rec)
  if not rec or rec.del or type(rec.fields) ~= "table" then return end
  local f, ty = rec.fields, rec.type
  if ty == "rc" then
    if f.kind == "s" and type(f.list) == "table" then
      for _, id in ipairs(f.list) do wantSpell(id) end
    elseif f.kind == "i" and type(f.list) == "table" then
      for _, id in ipairs(f.list) do wantItem(id) end
    end
  elseif ty == "gb" then
    eachItem(f.items)
    eachItem(f.log, "item")
  elseif ty == "bk" then
    eachItem(f.bags)
    eachItem(f.bank)
  elseif ty == "pr" then
    eachItem(f.prices)
  elseif ty == "LL" then
    if type(f.items) == "table" then for _, x in ipairs(f.items) do if type(x) == "table" then wantItemKey(x.item) end end end
  elseif ty == "su" then
    if type(f.reserves) == "table" then for _, k in ipairs(f.reserves) do wantItemKey(k) end end
  elseif ty == "LA" then
    wantItemKey(f.item)
  end
  requestItems()
end

local function onItemLoaded(id, ok)
  id = tonumber(id)
  if not id or not names.requested[id] then return end
  names.requested[id] = nil
  if ok == false or not P then return end
  local n = itemName(id)
  if n then setName("i", id, n) end
end

-- ---------------------------------------------------------------------------------------
-- Storing records
-- ---------------------------------------------------------------------------------------
local function alertCallToArms(rec, how, from)
  if rec.type ~= "ca" or rec.del or how == "s" or rec.author == me or from == me then return end
  if session.alerted[rec.id] or type(rec.t) ~= "number" or now() - rec.t > CFG.CA_FRESH then return end
  session.alerted[rec.id] = true
  local f = rec.fields or {}
  local who = (type(f.character) == "string" and f.character ~= "" and f.character) or rec.author
  local where = (type(f.zone) == "string" and f.zone ~= "") and f.zone or "somewhere"
  local line = "Call to arms from " .. who .. " in " .. where
  if type(f.needed) == "number" and f.needed > 0 then line = line .. ", " .. dec(f.needed) .. " needed" end
  if type(f.message) == "string" and f.message ~= "" then line = line .. ": " .. f.message else line = line .. "." end
  line = string.gsub(line, "|", "||") -- shown as typed, never as a link or a colour code
  say(line)
  local sound = (SOUNDKIT and SOUNDKIT.RAID_WARNING) or 8959
  if PlaySound then pcall(PlaySound, sound, "Master") end
end

-- Put a record in the store (it already passed every check).
function I.store(id, str, from, how, rec)
  local old = P.recs[id]
  if old then unindex(id, old) end
  P.recs[id] = str
  P.via[id] = from .. "," .. dec(now()) .. "," .. how
  index(id, str)
  X.dec[id] = rec or SC.decode(str)
  rec = X.dec[id]
  if typeOf(id) == "CFG" then refreshCfg() end
  if not rec then return end
  if from ~= me then
    safe(fillNames, rec)
    safe(alertCallToArms, rec, how, from)
  end
  for _, fn in ipairs(listeners) do safe(fn, rec, how, from) end
end

function I.remove(id)
  local old = P.recs[id]
  if not old then return end
  unindex(id, old)
  P.recs[id] = nil
  P.via[id] = nil
end

-- Who passed a stored record on, and how ("d" from its author, "m" relayed, "t" trusted relay, "s" seeded).
local function viaOf(id)
  local v = P.via[id]
  if type(v) ~= "string" then return "", "" end
  local from, how = string.match(v, "^([^,]*),.*,(%a)$")
  return from or "", how or ""
end
I.viaOf = viaOf

-- (t, id) of a is before (t, id) of b.
local function earlier(at, aid, bt, bid)
  if at ~= bt then return at < bt end
  return SC.compareBytes(aid, bid) < 0
end

-- Records of types this version doesn't know (§11): one store-wide budget, no author caps. Over it, the oldest go;
-- a relayed one only pushes out older ones (refused otherwise), one heard from its author always gets in.
-- → true and the ids that must go first when there is room, else false. Nothing is removed here: the store caps
-- (ShareSync's Y.storeRoom) may still refuse the record.
local function unknownRoom(rec, old, size, how)
  local count, bytes = X.unk.count, X.unk.bytes
  if old then count, bytes = count - 1, bytes - #old end
  local function over() return count + 1 > K.UNKNOWN_MAX_RECORDS or bytes + size > K.UNKNOWN_MAX_BYTES end
  if not over() then return true, {} end
  local list = {}
  for id in pairs(X.unkIds) do
    local str = P.recs[id]
    if str and id ~= rec.id then list[#list + 1] = { id = id, t = SC.tOfVersion(vOf(str)) or 0, n = #str } end
  end
  table.sort(list, function(a, b) return earlier(a.t, a.id, b.t, b.id) end)
  local gone = {}
  for _, x in ipairs(list) do
    if not over() then break end
    if how ~= "d" and not earlier(x.t, x.id, rec.t or 0, rec.id) then break end
    gone[#gone + 1] = x.id
    count, bytes = count - 1, bytes - x.n
  end
  if over() then return false end
  return true, gone
end

-- Room under the author's caps (§11) for this member record, counting the one it replaces. The author field is
-- no proof (anyone may pass on a member record in anyone's name), but a record heard from its author is: it always
-- gets in. Room comes first from that author's records stored as relays, those of the guildmate who relayed the
-- most of them first (a forger's batch), oldest first. A relayed record may only push out relayed ones older than
-- itself (so stores only ever move to newer records and an exchange can't go round in circles), else it is
-- refused. Only when no relayed one is left does a record heard from its author push out the author's own oldest.
-- → true and the ids that must go first when there is room, else false (nothing is removed here).
local function authorRoom(rec, old, size, how)
  if SC.spaceOf(rec.type) ~= "member" or not SC.TYPES[rec.type] then return true, {} end
  local u = X.usage[rec.author]
  if not u then return true, {} end
  local tmp = { count = u.count or 0, bytes = u.bytes or 0, rcBytes = u.rcBytes or 0 }
  if old then
    local _, _, oa = head(old)
    if oa == rec.author then SC.addAuthorUsage(tmp, typeOf(rec.id), #old, -1) end
  end
  if not SC.overAuthorCaps(tmp, rec.type, size) then return true, {} end
  local cands, perFrom = {}, {}
  for id in pairs(X.byAuthor[rec.author] or {}) do
    local str = P.recs[id]
    if str and id ~= rec.id then
      local from, h = viaOf(id)
      local relayed = h ~= "d"
      cands[#cands + 1] = { id = id, from = from, relayed = relayed, t = SC.tOfVersion(vOf(str)) or 0, n = #str, ty = typeOf(id) }
      if relayed then perFrom[from] = (perFrom[from] or 0) + 1 end
    end
  end
  table.sort(cands, function(a, b)
    if a.relayed ~= b.relayed then return a.relayed end
    if a.relayed and a.from ~= b.from then
      local na, nb = perFrom[a.from], perFrom[b.from]
      if na ~= nb then return na > nb end
      return SC.compareBytes(a.from, b.from) < 0
    end
    return earlier(a.t, a.id, b.t, b.id)
  end)
  local rcIn = rec.type == "rc"
  local gone = {}
  for _, x in ipairs(cands) do
    if not SC.overAuthorCaps(tmp, rec.type, size) then break end
    if not x.relayed and how ~= "d" then break end
    -- Only a record that frees what is short helps: any frees a place; bytes only of the same kind (rc or not).
    local short = (tmp.count or 0) + 1 > K.AUTHOR_MAX_RECORDS
    if (short or (x.ty == "rc") == rcIn) and (how == "d" or earlier(x.t, x.id, rec.t or 0, rec.id)) then
      gone[#gone + 1] = x.id
      SC.addAuthorUsage(tmp, x.ty, x.n, -1)
    end
  end
  if SC.overAuthorCaps(tmp, rec.type, size) then return false end
  return true, gone
end

-- Room for a record about to be stored: the author caps or the unknown-type budget, then the store caps (§11).
-- → true and the ids that must go first, or false. how "d" (heard from its author, or mine) always gets in under
-- the author caps; strong = it also gets in over the store caps (mine).
local function roomFor(rec, str, old, from, how)
  local room, gone
  if SC.TYPES[rec.type] then room, gone = authorRoom(rec, old, #str, how) else room, gone = unknownRoom(rec, old, #str, how) end
  if not room then
    if from ~= me then return false end
    gone = {}
  end
  local Y = ns.ShareSync
  if Y and Y.storeRoom then
    local ok, more = Y.storeRoom(rec, str, old, from, how, gone)
    if not ok then return false end
    if more then for _, id in ipairs(more) do gone[#gone + 1] = id end end
  end
  return true, gone
end

-- A record from a guildmate (§5 rules 1-5). → true when stored, else false and a reason.
function I.receiveRecord(str, from, chan)
  if not P then return false, "closed" end
  env.me, env.sender, env.channel = me, from, chan
  local res = SC.acceptRecord(str, now(), lookup, env)
  if not res.ok then
    if res.reason ~= "self" then P.stats.refused = (P.stats.refused or 0) + 1 end
    return false, res.reason
  end
  local rec = res.rec
  local Y = ns.ShareSync
  if Y and Y.seenRecord then Y.seenRecord(rec.id, rec.v) end
  local old = P.recs[rec.id]
  if old and (old == str or SC.compareRecords(old, str) >= 0) then return false, "old" end
  local room, gone = roomFor(rec, str, old, from, res.how)
  if not room then
    P.stats.refused = (P.stats.refused or 0) + 1
    return false, "caps"
  end
  for _, id in ipairs(gone) do I.remove(id) end
  I.store(rec.id, str, from, res.how, rec)
  if Y and Y.onStored then safe(Y.onStored, rec, res.how) end
  -- A ch of the character I am playing, newer than mine, from someone else: anyone can relay one in my name
  -- (§3). Mine goes out again at once and newer, so every store keeps it, my SavedVariables included.
  if rec.type == "ch" and rec.key == me and I.fixMyCh then safe(I.fixMyCh) end
  return true, res.how
end

-- ---------------------------------------------------------------------------------------
-- Sending: four queues, one token bucket (§7)
-- ---------------------------------------------------------------------------------------
-- P0 H and G; P1 my new records (ca first); P2 I and replies; P3 re-stamps.
-- Entries: { m = message, chan, dones = {fn…}, recs = {str…} }  a message ready to go
--          { rec = id, str = exact record or nil (= current), chan, done, reply = true, peer, since, window }
--          { inv = bucket, chan }   my inventory pages, made when it is their turn
--          { expand = fn, chan }    fn() → entries that take its place when it is its turn (a whole
--                                   bucket to push: one entry, so the 400 cap never cuts it short)
local Q = {}
for p = 0, 3 do Q[p] = { first = 1, last = 0 } end
local function qlen(q) return q.last - q.first + 1 end
local function qpush(q, e) q.last = q.last + 1; q[q.last] = e end
local function qfront(q) if q.first <= q.last then return q[q.first] end return nil end
local function qpop(q)
  if q.first > q.last then return nil end
  local e = q[q.first]
  q[q.first] = nil
  q.first = q.first + 1
  if q.first > q.last then q.first, q.last = 1, 0 end
  return e
end
local function qunshift(q, e)
  if q.first > q.last then q.first, q.last = 1, 0 end
  q.first = q.first - 1
  q[q.first] = e
end
local function qclear(q)
  for i = q.first, q.last do q[i] = nil end
  q.first, q.last = 1, 0
end

local bucket = { tokens = CFG.BUCKET_START, at = nil, pauseUntil = 0, slowUntil = 0, replyAfter = 0 }
local pumpDue

function I.queued(p)
  if p then return qlen(Q[p]) end
  return qlen(Q[0]) + qlen(Q[1]) + qlen(Q[2]) + qlen(Q[3])
end

local function canSend()
  if not rosterScanned or loading or not P then return false end
  if IsInGuild and not IsInGuild() then return false end
  if IsInInstance then
    local inside = IsInInstance()
    if inside then return false end
  end
  if InCombatLockdown and InCombatLockdown() then return false end
  if UnitAffectingCombat and UnitAffectingCombat("player") then return false end
  return true
end
I.canSend = canSend

local function refill()
  local t = clock()
  if not bucket.at then bucket.at = t end
  local rate = 1 / CFG.REFILL_SECONDS
  if t < bucket.slowUntil then rate = rate / CFG.FAIL_SLOW_FACTOR end
  local tokens = bucket.tokens + (t - bucket.at) * rate
  if tokens > CFG.BUCKET_MAX then tokens = CFG.BUCKET_MAX end
  bucket.tokens, bucket.at = tokens, t
  return rate
end

local function schedulePump(delay)
  if not C_Timer then return end
  if delay < 0 then delay = 0 end
  local want = clock() + delay
  if pumpDue and pumpDue <= want + 0.01 then return end
  pumpDue = want
  C_Timer.After(delay, function()
    if pumpDue == want then pumpDue = nil end
    safe(I.pump)
  end)
end
I.schedulePump = schedulePump

-- Queue an entry. P2 and P3 share QUEUE_MAX; overflow is dropped (asked for again later).
function I.enqueue(p, e, front)
  if p >= 2 and qlen(Q[2]) + qlen(Q[3]) >= CFG.QUEUE_MAX then
    if P then P.stats.dropped = (P.stats.dropped or 0) + 1 end
    return false
  end
  e.chan = e.chan or "GUILD"
  if front then qunshift(Q[p], e) else qpush(Q[p], e) end
  schedulePump(0)
  return true
end

local function nextMid()
  session.mid = (session.mid + 1) % K.MID_MOD
  return session.mid
end

-- The record an entry carries now, or nil when it is gone or someone else sent it first.
local function recordFor(e)
  local str = e.str or (P and P.recs[e.rec])
  if not str then return nil end
  if e.reply then
    local Y = ns.ShareSync
    if Y and Y.recordSeen and Y.recordSeen(e.rec, vOf(str), e) then return nil end
    -- A member record in my name that this addon didn't make or get from my app (anyone may pass one on in my
    -- name): guildmates pass it on, never me, so a record heard from its author is one the author made (§11 caps).
    -- (Stored "d", a record in my name can only be my own: nobody else's message is ever "from" me.) Officer
    -- records in my name come back only through trusted ranks, and only trusted ranks may pass them on.
    local _, _, author = head(str)
    if author == me and SC.spaceOf(typeOf(e.rec)) == "member" then
      local _, how = viaOf(e.rec)
      if how ~= "d" and how ~= "s" then return nil end
    end
  end
  return str
end

-- Pack whole records from the head of q into one R (§6); a record over 253 bytes becomes M parts.
local function packR(q)
  local first = qfront(q)
  local chan = first.chan
  local parts, len, dones = {}, 2, nil
  while true do
    local e = qfront(q)
    if not e or not e.rec or e.chan ~= chan then break end
    local str = recordFor(e)
    if not str then
      qpop(q)
    elseif #str > K.R_SINGLE_MAX then
      if #parts > 0 then break end
      qpop(q)
      local pieces = SC.splitRecord(str, nextMid())
      for i = #pieces, 1, -1 do
        local m = { m = pieces[i], chan = chan }
        if i == #pieces and e.done then m.dones = { e.done } end
        if i == 1 then m.recs = { str } end
        qunshift(q, m)
      end
      return nil
    else
      local add = #str
      if #parts > 0 then add = add + 1 end
      if len + add > K.MSG_MAX then break end
      qpop(q)
      parts[#parts + 1] = str
      len = len + add
      if e.done then
        dones = dones or {}
        dones[#dones + 1] = e.done
      end
    end
  end
  if #parts == 0 then return nil end
  return { m = "1R" .. concat(parts, "#"), chan = chan, dones = dones, recs = parts }
end

-- The next message to send and its queue; or nil (and when a reply may go, if that is what waits).
local function nextMessage()
  for p = 0, 3 do
    local q = Q[p]
    local guard = 0
    if p == 2 and qfront(q) and clock() < bucket.replyAfter then return nil, nil, bucket.replyAfter end
    while qfront(q) and guard < 2000 do
      guard = guard + 1
      local e = qfront(q)
      if e.m then
        qpop(q)
        local Y = ns.ShareSync
        if not (e.check and Y and Y.stale and Y.stale(e)) then return e, p end
      elseif e.inv then
        qpop(q)
        local Y = ns.ShareSync
        local pages = Y and Y.inventoryMessages and Y.inventoryMessages(e) or nil
        if pages then for i = #pages, 1, -1 do qunshift(q, pages[i]) end end
      elseif e.expand then
        qpop(q)
        local ok, list = pcall(e.expand)
        if not ok then report(list) elseif type(list) == "table" then
          for i = #list, 1, -1 do qunshift(q, list[i]) end
        end
      elseif e.rec then
        local m = packR(q)
        if m then return m, p end
      else
        qpop(q)
      end
    end
  end
  return nil
end

local function sendOk(res)
  if res == nil or res == true then return true end
  if res == false then return false end
  if type(res) == "number" then
    local E = Enum and Enum.SendAddonMessageResult
    return res == ((E and E.Success) or 0)
  end
  return false
end

-- One message to the game. → "ok", "fail" (refused: try again) or "error" (drop it).
local function rawSend(msg, chan)
  local api = (C_ChatInfo and C_ChatInfo.SendAddonMessage) or SendAddonMessage
  if not api then return "error" end
  local ok, res = pcall(api, CFG.PREFIX, msg, chan)
  if not ok then
    report(res)
    return "error"
  end
  if sendOk(res) then return "ok" end
  return "fail"
end

function I.pump()
  if not canSend() then return end
  local t = clock()
  if t < bucket.pauseUntil then
    schedulePump(bucket.pauseUntil - t)
    return
  end
  local rate = refill()
  local sent = 0
  while bucket.tokens >= 1 and sent < CFG.SEND_PER_PUMP do
    local m, p, waitUntil = nextMessage()
    if not m then
      if waitUntil then schedulePump(waitUntil - t) end
      return
    end
    local r = rawSend(m.m, m.chan)
    if r == "fail" then
      qunshift(Q[p], m)
      bucket.pauseUntil = t + CFG.FAIL_PAUSE
      bucket.slowUntil = t + CFG.FAIL_SLOW
      if P then P.stats.failed = (P.stats.failed or 0) + 1 end
      schedulePump(CFG.FAIL_PAUSE)
      return
    end
    bucket.tokens = bucket.tokens - 1
    sent = sent + 1
    if p == 2 then bucket.replyAfter = t + CFG.REPLY_GAP + rand() * CFG.REPLY_GAP_RAND end
    if r == "ok" then
      local Y = ns.ShareSync
      if Y and Y.onSent then safe(Y.onSent, m) end
      if m.dones then for _, fn in ipairs(m.dones) do safe(fn) end end
    end
  end
  if I.queued() > 0 then
    local wait = 0
    if bucket.tokens < 1 then wait = (1 - bucket.tokens) / rate end
    schedulePump(wait)
  end
end

-- Push records: ids (or exact strings) at priority p.
function I.pushRecord(p, id, str, opts)
  local e = { rec = id, str = str, chan = channelOf(id) }
  if opts then
    e.done, e.reply, e.peer, e.since, e.window = opts.done, opts.reply, opts.peer, opts.since, opts.window
  end
  return I.enqueue(p, e, opts and opts.front)
end

-- Not ready any more: hellos, requests, inventories and replies are stale.
local function dropReplies()
  qclear(Q[0])
  qclear(Q[2])
end

-- ---------------------------------------------------------------------------------------
-- Receiving (§5 rule 1, §7 flood guard and 3 ms per frame)
-- ---------------------------------------------------------------------------------------
local inbound = { first = 1, last = 0 }
local frame = { at = -1, used = 0, scheduled = false, busy = false }
local flood = {}
local unknown = {}             -- sender -> { at, list = { item… } }
local partials = {}            -- sender -> mid -> { n, got, data, at }

local function sayNewer()
  if session.newerSaid then return end
  session.newerSaid = true
  say(SAY.newer)
end

local function flooded(name)
  local t = clock()
  local f = flood[name]
  if f and f.mute and t < f.mute then return true end
  if not f or t - f.start >= 60 then
    f = { start = t, n = 0 }
    flood[name] = f
  end
  f.n = f.n + 1
  if f.n > CFG.FLOOD_PER_MINUTE then
    f.mute = t + CFG.FLOOD_IGNORE
    if P then P.stats.flood = (P.stats.flood or 0) + 1 end
    return true
  end
  return false
end

local function requestRoster()
  if C_GuildInfo and C_GuildInfo.GuildRoster then pcall(C_GuildInfo.GuildRoster)
  elseif GuildRoster then pcall(GuildRoster) end
end

local function bufferUnknown(it)
  local b = unknown[it.from]
  if not b then
    local n = 0
    for _ in pairs(unknown) do n = n + 1 end
    if n >= CFG.UNKNOWN_SENDERS then return end
    b = { at = clock(), list = {} }
    unknown[it.from] = b
    local from = it.from
    if C_Timer then
      C_Timer.After(CFG.UNKNOWN_WAIT, function()
        if unknown[from] == b then unknown[from] = nil end
      end)
    end
    requestRoster()
  end
  if #b.list < CFG.UNKNOWN_PER_SENDER then b.list[#b.list + 1] = it end
end

local function markSeenFromHead(data)
  local Y = ns.ShareSync
  if not (Y and Y.seenRecord) then return end
  local id, v = head(data)
  if id and v and #v == 8 then Y.seenRecord(id, v) end
end

local function onPart(it)
  local p = SC.parseParts(it.msg)
  if not p then return end
  local per = partials[it.from]
  if not per then
    per = {}
    partials[it.from] = per
  end
  local c = per[p.mid]
  if c and c.n ~= p.parts then c = nil end
  if not c then
    local open = 0
    for _ in pairs(per) do open = open + 1 end
    if open >= CFG.PARTS_OPEN_PER_SENDER then return end
    c = { n = p.parts, got = 0, data = {}, at = clock() }
    per[p.mid] = c
    local mid = p.mid
    if C_Timer then
      C_Timer.After(CFG.PART_TIMEOUT, function()
        if per[mid] == c then
          per[mid] = nil
          if P then P.stats.partsLost = (P.stats.partsLost or 0) + 1 end
          local Y = ns.ShareSync
          if Y and Y.onMissed then safe(Y.onMissed) end
        end
      end)
    end
  end
  if p.part == 1 then markSeenFromHead(p.data) end
  if not c.data[p.part] then
    c.data[p.part] = p.data
    c.got = c.got + 1
  end
  if c.got >= c.n then
    per[p.mid] = nil
    local str = SC.joinParts(c.data)
    if str then I.receiveRecord(str, it.from, it.chan) end
  end
end

local function dispatch(it)
  if not isReady or not P then return end
  if ranks[it.from] == nil then
    bufferUnknown(it)
    return
  end
  heard[it.from] = clock()
  local ty = it.ty
  if ty == "R" then
    local recs = SC.parseRecords(it.msg)
    if recs then for i = 1, #recs do I.receiveRecord(recs[i], it.from, it.chan) end end
  elseif ty == "M" then
    onPart(it)
  elseif it.chan == "GUILD" then
    local Y = ns.ShareSync
    if not Y then return end
    if ty == "H" and Y.onHello then Y.onHello(it.from, it.msg)
    elseif ty == "I" and Y.onInventory then Y.onInventory(it.from, it.msg)
    elseif ty == "G" and Y.onGet then Y.onGet(it.from, it.msg) end
  end
end

local drain
drain = function()
  if frame.busy then return end
  frame.busy = true
  local t = clock()
  if t ~= frame.at then frame.at, frame.used = t, 0 end
  local prof = debugprofilestop
  while inbound.first <= inbound.last do
    if prof and frame.used >= CFG.FRAME_BUDGET_MS then
      if not frame.scheduled and C_Timer then
        frame.scheduled = true
        C_Timer.After(0, function()
          frame.scheduled = false
          safe(drain)
        end)
      end
      break
    end
    local it = qpop(inbound)
    local start = prof and prof() or 0
    safe(dispatch, it)
    if prof then frame.used = frame.used + (prof() - start) end
  end
  frame.busy = false
end

local function onAddonMessage(prefix, msg, chan, sender)
  if prefix ~= CFG.PREFIX or type(msg) ~= "string" or type(sender) ~= "string" then return end
  if chan ~= "GUILD" and chan ~= "OFFICER" then return end
  local from = shortName(sender)
  if not from or from == "" or from == me then return end
  local kind = SC.messageKind(msg)
  if not kind then return end
  if kind.major ~= K.MAJOR then
    if kind.major > K.MAJOR then sayNewer() end
    return
  end
  if flooded(from) then return end
  if not isReady then return end
  if qlen(inbound) >= CFG.INBOUND_MAX then
    if P then P.stats.dropped = (P.stats.dropped or 0) + 1 end
    return
  end
  qpush(inbound, { msg = msg, chan = chan, from = from, ty = kind.type })
  drain()
end

-- ---------------------------------------------------------------------------------------
-- Roster (§5): ranks come from my own latest scan
-- ---------------------------------------------------------------------------------------
local function scanRoster()
  if not (GetNumGuildMembers and GetGuildRosterInfo) then return end
  local n = GetNumGuildMembers()
  if type(n) ~= "number" or n <= 0 then return end
  for k in pairs(ranks) do ranks[k] = nil end
  for k in pairs(onlineNow) do onlineNow[k] = nil end
  for i = 1, n do
    local name, _, rankIndex, _, _, _, _, _, isOnline = GetGuildRosterInfo(i)
    local s = shortName(name)
    if s and type(rankIndex) == "number" then
      ranks[s] = rankIndex
      if isOnline then onlineNow[s] = true end
    end
  end
  if me and ranks[me] == nil and GetGuildInfo then
    local _, _, r = GetGuildInfo("player")
    if type(r) == "number" then ranks[me] = r end
  end
  rosterScanned = true
  -- Senders we did not know yet: replay what they sent.
  for from, b in pairs(unknown) do
    if ranks[from] ~= nil then
      unknown[from] = nil
      for _, it in ipairs(b.list) do qpush(inbound, it) end
    end
  end
  if inbound.first <= inbound.last then drain() end
end

-- Guildmates online in the roster (not me).
function I.onlineCount()
  local n = 0
  for name in pairs(onlineNow) do if name ~= me then n = n + 1 end end
  return n
end

-- Guildmates heard in the last `window` seconds.
function I.heardCount(window)
  local t, n = clock(), 0
  for name, at in pairs(heard) do if name ~= me and t - at <= window then n = n + 1 end end
  return n
end

-- ---------------------------------------------------------------------------------------
-- Building my own records
-- ---------------------------------------------------------------------------------------
-- The record string for id at time t by author, final band when its state is final (§4.2).
local function build(id, t, author, body, del)
  local function make(final)
    local v = SC.makeVersion(t, author, final)
    local s = id .. "^" .. v .. "^" .. author .. "^" .. (del and "d" or "")
    if not del and body ~= "" then s = s .. "^" .. body end
    return s, v
  end
  local str, v = make(false)
  local spec = SC.TYPES[typeOf(id)]
  if not del and spec and spec.final then
    local d = SC.decode(str)
    if d and SC.isFinal(d) then str, v = make(true) end
  end
  return str, v
end

-- t for a new version of id: an editor whose stored copy has t_old ≥ t uses t_old + 1.
local function stampFor(id, t)
  local old = P.recs[id]
  if not old then return t end
  return SC.nextT(t, SC.tOfVersion(vOf(old)))
end

-- Store and push one of my records. → the record string, or nil and a reason.
local function publishOwn(id, str, p, done, front)
  local reason = SC.checkRecord(str, now(), lookup)
  if reason then return nil, reason end
  local rec = SC.decode(str)
  -- Mine always gets in, as guildmates take it from me: what I hold past my caps (records passed on in my name)
  -- makes room the same way, and so do the store caps.
  local _, gone = roomFor(rec, str, P.recs[id], me, "d")
  for _, id2 in ipairs(gone or {}) do I.remove(id2) end
  I.store(id, str, me, "d", rec)
  local Y = ns.ShareSync
  if Y and Y.seenRecord then Y.seenRecord(id, rec.v) end
  -- WH goes on OFFICER; everything else on GUILD. When the queue is full the record still spreads
  -- through the exchange, and an outbox acknowledgement waits for the next session (same id and t).
  I.enqueue(p, { rec = id, str = str, chan = channelOf(id), done = done }, front)
  return str
end

-- ---------------------------------------------------------------------------------------
-- The outbox (§9)
-- ---------------------------------------------------------------------------------------
local function pidOfEntry(op, ty)
  local how = PIDKEY[ty]
  if not how then return nil end
  local key = keyOf(op.id)
  if how.seg then return SC.split(key, ":")[how.seg] end
  if op.del then
    local old = lookup(op.id)
    return old and old.fields and old.fields[how.field] or nil
  end
  -- A probe record (any valid version and author) only serves to read the fields.
  local d = SC.decode(op.id .. "^" .. SC.makeVersion(1, "x") .. "^x^^" .. (type(op.body) == "string" and op.body or ""))
  return d and d.fields and d.fields[how.field] or nil
end

-- Is this character linked to pid (§3: the anchor, or listed in the anchor's ch)?
local function linkedTo(pid)
  if type(pid) ~= "string" or not SC.pidOk(pid) then return false end
  local anchor = sub(pid, 1, #pid - 5)
  if anchor == me then return true end
  local ch = lookup("ch:" .. anchor)
  if not ch or ch.del or type(ch.fields) ~= "table" or ch.fields.pid ~= pid then return false end
  if type(ch.fields.alts) == "table" then
    for _, a in ipairs(ch.fields.alts) do if a == me then return true end end
  end
  return false
end
I.linkedTo = linkedTo

-- Is this author one of my characters (the one logged in, or one the app lists in this guild's me.alts)? An edit over
-- my own earlier change is not stale: the app replaces an entry it has not heard back about and keeps the first
-- base, while the game may already have sent that first entry.
function I.mineAuthor(author)
  if type(author) ~= "string" or author == "" then return false end
  if author == me then return true end
  local e = meEntry(gkey)
  local alts = e and e.alts or nil
  if type(alts) == "table" then
    for _, a in ipairs(alts) do if a == author then return true end end
  end
  return false
end

local function setSent(op, value)
  P.sent[op] = value
end

-- Publish one outbox entry. → "ok" | "no" | "wait,officer" | "wait,gm" | "wait,link".
local function publishEntry(op)
  local id = op.id
  local ty = typeOf(id)
  if ty == "" or not SC.spaceOf(ty) then
    setSent(op.op, "no,malformed")
    return "no"
  end
  local tnow = now()
  local opT = tonumber(op.t)
  if not opT then
    setSent(op.op, "no,malformed")
    return "no"
  end
  opT = floor(opT) + 0.0
  if tnow - opT > CFG.OUTBOX_MAX_WAIT then
    setSent(op.op, "no,expired")
    return "no"
  end
  local spec = SC.TYPES[ty]
  local needGM = op.need == "g" or (spec and spec.rank == "gm")
  local needOfficer = op.need == "o" or SC.spaceOf(ty) == "officer"
  if needGM and not I.isGM(me) then
    setSent(op.op, "wait,gm")
    return "wait,gm"
  end
  if needOfficer and not I.officer(me) then
    setSent(op.op, "wait,officer")
    return "wait,officer"
  end
  if PIDKEY[ty] then
    local pid = pidOfEntry(op, ty)
    if pid ~= S.myPid() or not linkedTo(pid) then
      setSent(op.op, "wait,link")
      return "wait,link"
    end
  end
  local t = opT
  if t > tnow then t = tnow end
  local del = op.del and true or false
  local body = del and "" or (type(op.body) == "string" and op.body or "")
  local stored = P.recs[id]
  local cand = build(id, t, me, body, del)
  if stored ~= cand then
    if stored then
      local sv = vOf(stored)
      if SC.isFinalV(sv) then
        setSent(op.op, "no,final")
        return "no"
      end
      local _, cv = head(cand)
      if MULTI[ty] and not SC.isFinalV(cv) and sv ~= (type(op.base) == "string" and op.base or "")
        and not I.mineAuthor(select(3, head(stored))) then
        setSent(op.op, "no,stale")
        return "no"
      end
    end
    cand = build(id, stampFor(id, t), me, body, del)
  end
  local reason = SC.checkRecord(cand, tnow, lookup)
  if reason then
    setSent(op.op, "no," .. reason)
    return "no"
  end
  local opName = op.op
  local _, v = head(cand)
  inflight[opName] = true
  local function done()
    if P then setSent(opName, "ok," .. v .. "," .. me) end
  end
  if stored == cand then
    -- Already ours (a session that crashed before its acknowledgement was saved): send it again.
    local e = { rec = id, str = cand, chan = channelOf(id), done = done }
    I.enqueue(1, e, ty == "ca")
    return "ok"
  end
  local str = publishOwn(id, cand, 1, done, ty == "ca")
  if not str then
    inflight[opName] = nil
    setSent(op.op, "no,malformed")
    return "no"
  end
  return "ok"
end

local function plural(n, one, many) if n == 1 then return one end return many end

function I.publishOutbox()
  local inbox = WowGuildInbox
  if type(inbox) ~= "table" or not P then return end
  local list = inbox.outbox
  -- Entries the app dropped are forgotten (it saw our answer).
  local present = {}
  if type(list) == "table" then
    for _, op in ipairs(list) do if type(op) == "table" and type(op.op) == "string" then present[op.op] = true end end
  end
  for op in pairs(P.sent) do if not present[op] then P.sent[op] = nil end end
  if type(list) ~= "table" then return end
  local waitOfficer, waitLink = 0, 0
  for _, op in ipairs(list) do
    if type(op) == "table" and type(op.op) == "string" and type(op.id) == "string" and op.g == gkey and not inflight[op.op] then
      local st = P.sent[op.op]
      local settled = type(st) == "string" and (sub(st, 1, 3) == "ok," or st == "ok" or sub(st, 1, 3) == "no,")
      if not settled then
        local ok, res = pcall(publishEntry, op)
        if not ok then
          report(res)
        elseif res == "wait,officer" or res == "wait,gm" then
          waitOfficer = waitOfficer + 1
        elseif res == "wait,link" then
          waitLink = waitLink + 1
        end
      end
    end
  end
  if not session.waitSaid and (waitOfficer > 0 or waitLink > 0) then
    session.waitSaid = true
    if waitOfficer > 0 then
      say(dec(waitOfficer) .. plural(waitOfficer, " officer change is waiting. Log in on an officer character to send it.",
        " officer changes are waiting. Log in on an officer character to send them."))
    end
    if waitLink > 0 then
      local pid = S.myPid()
      local anchor = pid and sub(pid, 1, #pid - 5) or "your main"
      say(dec(waitLink) .. plural(waitLink, " change is waiting. ", " changes are waiting. ") ..
        "Log in on " .. anchor .. " once so guildmates know " .. tostring(me) .. " is yours.")
    end
  end
end

-- How many outbox entries for this guild are not sent yet.
local function outboxWaiting()
  local inbox = WowGuildInbox
  if type(inbox) ~= "table" or type(inbox.outbox) ~= "table" or not P then return 0 end
  local n = 0
  for _, op in ipairs(inbox.outbox) do
    if type(op) == "table" and op.g == gkey and type(op.op) == "string" then
      local st = P.sent[op.op]
      if not (type(st) == "string" and (sub(st, 1, 3) == "ok," or sub(st, 1, 3) == "no,")) then n = n + 1 end
    end
  end
  return n
end

-- ---------------------------------------------------------------------------------------
-- Seed (§9): records the app hands over when this store is empty or far behind
-- ---------------------------------------------------------------------------------------
function I.loadSeed()
  if session.seeded or not P then return 0 end
  session.seeded = true
  local inbox = WowGuildInbox
  local seed = type(inbox) == "table" and inbox.seed
  if type(seed) ~= "table" then return 0 end
  -- A seed is for the app's guild: skip it on a character of another guild.
  if type(inbox.seedG) == "string" then
    if inbox.seedG ~= gkey then return 0 end
  elseif type(inbox.guild) == "string" and inbox.guild ~= "" then
    local guild = GetGuildInfo and GetGuildInfo("player")
    if inbox.guild ~= guild then return 0 end
  end
  local tnow, n = now(), 0
  for i = 1, #seed do
    if i > CFG.SEED_MAX then break end
    local str = seed[i]
    local id = type(str) == "string" and head(str)
    local old = id and P.recs[id]
    if id and (not old or SC.compareRecords(old, str) < 0) and not SC.checkRecord(str, tnow, lookup) then
      local rec = SC.decode(str)
      if rec and rec.id == id then
        I.store(id, str, me, "s", rec)
        n = n + 1
      end
    end
  end
  if n > 0 then
    refreshCfg()
    -- A seed doesn't check the store caps record by record: one pass afterwards (§11).
    local Y = ns.ShareSync
    if Y and Y.enforceCaps then safe(Y.enforceCaps) end
  end
  return n
end

-- ---------------------------------------------------------------------------------------
-- Player id (§3), one per guild (P.pid): this guild's inbox me.pid; the pid this account keeps for the guild;
-- shared.pid from before ids were per guild, when its anchor is in this guild; a guildmate's copy of one of this
-- account's characters' ch (a second PC); else a new one, and the app reconciles it at the next login.
-- A guildmate can relay a ch in my name naming any pid, so a copy counts only for a pid made on a character of
-- this account that is in this guild: a forged one names a pid made on the forger's character.
-- Known limit: a guildmate may still make up a pid on one of MY characters ("Bob.m4l1") and relay a ch of mine
-- naming it before my first login here. To this addon that copy is the same as my other PC's (every copy reaches
-- me relayed, and how it was first heard is kept only in each guildmate's own store), so refusing it would also
-- refuse the second PC its id. It can't link me to another player (the anchor is mine, and my own ch, built from
-- my data, lists only my characters); when the app already has an id for this guild, its inbox me wins at once.
-- ---------------------------------------------------------------------------------------
local function adoptPid(allowNew)
  if not P then return nil end
  local e = meEntry(gkey)
  if e and SC.pidOk(e.pid) then
    P.pid = e.pid
    return P.pid
  end
  if SC.pidOk(P.pid) then return P.pid end
  local function inGuild(name) return name == me or ranks[name] ~= nil end
  local root = sharedRoot()
  if SC.pidOk(root.pid) and inGuild(sub(root.pid, 1, #root.pid - 5)) then
    P.pid = root.pid
    return P.pid
  end
  local mine, names2 = {}, {}
  if me then
    mine[me] = true
    names2[1] = me
  end
  local chars = WowGuildDB and WowGuildDB.characters
  if type(chars) == "table" then
    for name in pairs(chars) do
      if type(name) == "string" and not mine[name] then
        mine[name] = true
        names2[#names2 + 1] = name
      end
    end
  end
  table.sort(names2, function(a, b) return SC.compareBytes(a, b) < 0 end)
  for _, name in ipairs(names2) do
    local c = lookup("ch:" .. name)
    local pid = c and not c.del and type(c.fields) == "table" and c.fields.pid or nil
    if SC.pidOk(pid) then
      local anchor = sub(pid, 1, #pid - 5)
      if mine[anchor] and inGuild(anchor) then
        P.pid = pid
        return P.pid
      end
    end
  end
  if not allowNew or not me then return nil end
  local anchor = me
  if e and SC.authorOk(e.main) and inGuild(e.main) then anchor = e.main end
  P.pid = SC.newPid(anchor)
  return P.pid
end

-- ---------------------------------------------------------------------------------------
-- offer(): records the addon builds itself, with the re-stamp policy (§4.3, §11)
-- ---------------------------------------------------------------------------------------
-- The identity part of a ch body: pid, BattleTag, main and alts (the first four fields).
local function chIdentity(body)
  local i = 0
  for _ = 1, 4 do
    local j = find(body, "^", i + 1, true)
    if not j then return body end
    i = j
  end
  return sub(body, 1, i - 1)
end

-- → true when due now; false and a time when it may go later (nil = only on a change)
local function due(ty, key, body, stored, tnow)
  if not stored then return true end
  local _, sv, sa = head(stored)
  local st = SC.tOfVersion(sv) or 0
  local age = tnow - st
  local old = bodyOf(stored)
  local same = old == body and (sa == me or ty == "gb")
  if ty == "ch" then
    if same then
      if age >= CFG.REFRESH then return true end
      return false, st + CFG.REFRESH
    end
    -- A new player id, main or alt list goes out at once (§3: guildmates link an alt at the next login
    -- on the anchor); other changes (item level, repairs ...) at most every 30 minutes.
    if type(old) ~= "string" or chIdentity(old) ~= chIdentity(body) then return true end
    if age >= CFG.CH_MIN_GAP then return true end
    return false, st + CFG.CH_MIN_GAP
  elseif ty == "gb" then
    if same then return age >= CFG.REFRESH end
    local gap = (key == "0") and CFG.GB_TAB0_GAP or CFG.GB_MIN_AGE
    if age >= gap then return true end
    return false, st + gap
  elseif ty == "bk" or ty == "sh" then
    if same then return age >= CFG.REFRESH end
    return true
  end
  return not same
end

local function offerNow(ty, key, fields)
  local id = ty .. ":" .. key
  local body = SC.encodeBody(ty, key, fields, me)
  local tnow = now()
  local stored = P.recs[id]
  local ok, later = due(ty, key, body, stored, tnow)
  if not ok then
    if later then deferred[id] = { t = ty, key = key, fields = fields, at = later } end
    return false, "unchanged"
  end
  deferred[id] = nil
  local str = build(id, stampFor(id, tnow), me, body, false)
  local res, reason = publishOwn(id, str, 3)
  if not res then return false, reason end
  return true
end

function S.offer(ty, key, fields)
  if type(ty) ~= "string" or type(key) ~= "string" or SC.spaceOf(ty) ~= "member" then return false, "type" end
  if not SC.keyOk(ty, key) then return false, "key" end
  if type(fields) ~= "table" then fields = {} end
  if not P or not isReady or not me then
    laterOffers[ty .. ":" .. key] = { t = ty, key = key, fields = fields }
    return false, "later"
  end
  local spec = SC.TYPES[ty]
  if spec and spec.author == "key" and SC.split(key, ":")[1] ~= me then return false, "author" end
  local ok, a, b = pcall(offerNow, ty, key, fields)
  if not ok then
    report(a)
    return false, "error"
  end
  return a, b
end

-- My own ch over a newer one someone else relayed in my name (receiveRecord): built again from my data and
-- sent at once when it differs, whatever the re-stamp policy says; at most every CH_FIX_GAP seconds (a later
-- one waits for the end of the gap).
function I.fixMyCh()
  if not P or not me or not S.myPid() then return end
  local C = ns.Collect
  if type(C) ~= "table" or type(C.ch) ~= "function" then return end
  local ok, r = pcall(C.ch)
  if not ok then
    report(r)
    return
  end
  if type(r) ~= "table" or r.key ~= me or type(r.fields) ~= "table" then return end
  local id = "ch:" .. me
  local body = SC.encodeBody("ch", me, r.fields, me)
  local stored = P.recs[id]
  if stored and bodyOf(stored) == body then return end
  local t = clock()
  if t < chFix.at then
    if not chFix.pending and C_Timer then
      chFix.pending = true
      C_Timer.After(chFix.at - t + 0.1, function()
        chFix.pending = false
        safe(I.fixMyCh)
      end)
    end
    return
  end
  chFix.at = t + CFG.CH_FIX_GAP
  deferred[id] = nil
  local res, reason = publishOwn(id, build(id, stampFor(id, now()), me, body, false), 1)
  if not res and reason == "future" and C_Timer and not chFix.pending then
    -- The relayed copy is stamped ahead of the clock (FUTURE_SLACK): mine can be newer a little later.
    chFix.pending = true
    C_Timer.After(CFG.CH_FIX_GAP, function()
      chFix.pending = false
      safe(I.fixMyCh)
    end)
  end
end

-- ---------------------------------------------------------------------------------------
-- putLocal(): actions taken in game; they go out at once
-- ---------------------------------------------------------------------------------------
function S.putLocal(ty, key, fields, opts)
  opts = type(opts) == "table" and opts or {}
  if type(ty) ~= "string" or type(key) ~= "string" or not SC.spaceOf(ty) then return nil, "type" end
  if not me then me = UnitName and UnitName("player") end
  if not P and not openPartition() then return nil, "guild" end
  if not SC.keyOk(ty, key) then return nil, "key" end
  local spec = SC.TYPES[ty]
  if SC.spaceOf(ty) == "officer" then
    if spec and spec.rank == "gm" then
      if not I.isGM(me) then return nil, "rank" end
    elseif not I.officer(me) then
      return nil, "rank"
    end
  end
  local id = ty .. ":" .. key
  local stored = P.recs[id]
  if stored and SC.isFinalV(vOf(stored)) then return nil, "final" end
  local del = opts.del and true or false
  local body = del and "" or SC.encodeBody(ty, key, type(fields) == "table" and fields or {}, me)
  local str = build(id, stampFor(id, now()), me, body, del)
  local ok, res, reason = pcall(publishOwn, id, str, 1, nil, ty == "ca")
  if not ok then
    report(res)
    return nil, "error"
  end
  return res, reason
end

-- ---------------------------------------------------------------------------------------
-- Becoming ready (§8) and the event frame
-- ---------------------------------------------------------------------------------------
-- A record of mine the addon no longer builds (§8 step 1): the shopping list was emptied, this
-- character left the bank characters (or bank sharing is off), a profession was dropped. Its live
-- copy in the store would otherwise stay until it expires, so it gets a tombstone. Only with clear
-- evidence: the list must hold this character's ch, and rc goes only for a profession ch lacks.
local function tombstoneMissing(list)
  local present, ch = {}, nil
  for _, r in ipairs(list) do
    if type(r) == "table" and type(r.type) == "string" and type(r.key) == "string" then
      present[r.type .. ":" .. r.key] = true
      if r.type == "ch" and r.key == me then ch = r end
    end
  end
  if not ch or type(ch.fields) ~= "table" then return end
  local function live(id)
    local str = P.recs[id]
    if not str then return nil end
    local _, _, author, flags = head(str)
    if flags == "d" or author ~= me then return nil end
    return str
  end
  local gone = {}
  if not present["bk:" .. me] and live("bk:" .. me) then gone[#gone + 1] = "bk:" .. me end
  local pid = S.myPid()
  if pid and not present["sh:" .. pid] and live("sh:" .. pid) then gone[#gone + 1] = "sh:" .. pid end
  if type(ch.fields.professions) == "table" then
    local has = {}
    for _, p in ipairs(ch.fields.professions) do if type(p) == "table" and type(p.skill) == "number" then has[p.skill] = true end end
    local prefix = "rc:" .. me .. ":"
    for id in pairs(P.recs) do
      if sub(id, 1, #prefix) == prefix and not present[id] and live(id) then
        local skill = SC.fromB36(sub(id, #prefix + 1))
        if skill and not has[skill] then gone[#gone + 1] = id end
      end
    end
  end
  table.sort(gone)
  for _, id in ipairs(gone) do
    deferred[id] = nil
    publishOwn(id, build(id, stampFor(id, now()), me, "", true), 3)
  end
end

-- On every ready (login, /reload, back from a long instance): rebuild my own records and offer
-- them (the re-stamp policy decides what goes out), then whatever was offered while not ready.
local function runCollect()
  if not S.myPid() or not P or not isReady then return end
  local C = ns.Collect
  if type(C) == "table" and type(C.sharedRecords) == "function" then
    local ok, list = pcall(C.sharedRecords)
    if not ok then
      report(list)
    elseif type(list) == "table" then
      for _, r in ipairs(list) do
        if type(r) == "table" then S.offer(r.type, r.key, r.fields) end
      end
      safe(tombstoneMissing, list)
    end
  end
  local later = laterOffers
  laterOffers = {}
  for _, o in pairs(later) do S.offer(o.t, o.key, o.fields) end
end

local function resendWebhook()
  local wh = P.recs["WH:1"]
  if not wh then return end
  local _, _, author, flags = head(wh)
  if author ~= me or flags == "d" then return end
  local tnow = now()
  if tnow - (tonumber(P.whSent) or 0) < CFG.WH_RESEND then return end
  P.whSent = tnow
  I.enqueue(1, { rec = "WH:1", str = wh, chan = "OFFICER" })
end

local function saveClock()
  local root = sharedRoot()
  root.clock = { server = now(), here = floor(time and time() or now()) + 0.0 }
end

local function onReady(withHello)
  if not openPartition() then return end
  P.used = now()
  saveClock()
  local Y = ns.ShareSync
  if Y and Y.prune then safe(Y.prune) end
  safe(I.loadSeed)
  if not S.myPid() then
    if adoptPid(false) == nil and not pidPending then
      pidPending = true
      local gen = pidGen
      if C_Timer then
        C_Timer.After(CFG.PID_GRACE, function()
          -- Started in a guild I have left since: that guild's wait is over, and the new one has its own.
          if gen ~= pidGen then return end
          pidPending = false
          if not isReady then return end
          safe(adoptPid, true)
          safe(runCollect)
        end)
      end
    end
  end
  safe(I.publishOutbox)
  safe(runCollect)
  safe(resendWebhook)
  if Y and Y.onReady then safe(Y.onReady, withHello) end
  schedulePump(0)
end

local function computeReady()
  if IsInGuild and not IsInGuild() then return false end
  if not rosterScanned or loading then return false end
  if IsInInstance then
    local inside = IsInInstance()
    if inside then return false end
  end
  return true
end

-- Another guild's store opened (I left one guild and joined another): what was queued, deferred or offered
-- for the old one must not go out in the new one, and the new guild's seed may load.
local function forgetGuildWork()
  for p = 0, 3 do qclear(Q[p]) end
  for k in pairs(deferred) do deferred[k] = nil end
  -- Outbox entries cleared from the queue unsent go again once I'm back in that guild (sent ones have their "ok").
  for k in pairs(inflight) do inflight[k] = nil end
  laterOffers = {}
  session.seeded = false
  -- The new guild waits its own PID_GRACE for guildmates' copies of my ch before making an id.
  pidPending = false
  pidGen = pidGen + 1
end

local readyRetry = false
local updateReady
updateReady = function()
  if not me then me = UnitName and UnitName("player") end
  local inside = IsInInstance and IsInInstance()
  if inside and not instanceSince then instanceSince = clock() end
  -- In another guild than the one whose store is open, though the game never said I was out of one: the same
  -- as leaving it.
  local cur = isReady and currentGuildKey() or nil
  local moved = cur ~= nil and gkey ~= nil and cur ~= gkey
  if ((IsInGuild and not IsInGuild()) or moved) and rosterScanned then
    -- Out of the guild: its roster no longer counts, so joining another waits for that guild's roster.
    rosterScanned = false
    for k in pairs(ranks) do ranks[k] = nil end
    for k in pairs(onlineNow) do onlineNow[k] = nil end
    for k in pairs(heard) do heard[k] = nil end
    if moved then requestRoster() end
  end
  local r = computeReady()
  local before = gkey
  if r and not isReady and not openPartition() then
    -- In a guild with its roster loaded, but the game doesn't give the guild's name yet (it can lag a few
    -- seconds after login or a guild invite): not ready yet, and try again shortly.
    r = false
    if not readyRetry and C_Timer then
      readyRetry = true
      C_Timer.After(CFG.READY_RETRY, function()
        readyRetry = false
        safe(updateReady)
      end)
    end
  end
  if r == isReady then
    if r then schedulePump(0) end
    return
  end
  isReady = r
  if r then
    local switched = before ~= nil and before ~= gkey
    if switched then forgetGuildWork() end
    local hello = not everReady or switched or (instanceSince ~= nil and clock() - instanceSince > CFG.INSTANCE_REHELLO)
    everReady = true
    instanceSince = nil
    onReady(hello)
  else
    dropReplies()
    local Y = ns.ShareSync
    if Y and Y.onUnready then safe(Y.onUnready) end
  end
end
I.updateReady = updateReady

local function onLogout()
  if not P then return end
  local Y = ns.ShareSync
  if Y and Y.prune then safe(Y.prune) end
  P.stats.peers = I.heardCount(CFG.PEER_WINDOW)
  saveClock()
end

local frameE = CreateFrame and CreateFrame("Frame") or nil
S.frame = frameE
local handlers = {
  ADDON_LOADED = function(name)
    if name ~= ADDON then return end
    me = UnitName and UnitName("player") or me
    sharedRoot()
    S.myPid()
  end,
  PLAYER_LOGIN = function()
    me = UnitName and UnitName("player") or me
    requestRoster()
  end,
  PLAYER_ENTERING_WORLD = function() loading = false; updateReady() end,
  LOADING_SCREEN_ENABLED = function() loading = true; updateReady() end,
  LOADING_SCREEN_DISABLED = function() loading = false; updateReady() end,
  ZONE_CHANGED_NEW_AREA = function() updateReady() end,
  PLAYER_REGEN_ENABLED = function() schedulePump(0) end,
  PLAYER_GUILD_UPDATE = function() requestRoster(); updateReady() end,
  GUILD_ROSTER_UPDATE = function()
    scanRoster()
    updateReady()
  end,
  CHAT_MSG_ADDON = function(prefix, msg, chan, sender) onAddonMessage(prefix, msg, chan, sender) end,
  ITEM_DATA_LOAD_RESULT = function(id, ok) onItemLoaded(id, ok) end,
  PLAYER_LOGOUT = function() onLogout() end,
}
if frameE then
  for event in pairs(handlers) do pcall(frameE.RegisterEvent, frameE, event) end
  frameE:SetScript("OnEvent", function(_, event, ...)
    local fn = handlers[event]
    if fn then safe(fn, ...) end
  end)
end

-- The prefix is registered at load, so guildmates' messages reach us from the first frame.
do
  local reg = (C_ChatInfo and C_ChatInfo.RegisterAddonMessagePrefix) or RegisterAddonMessagePrefix
  if reg then pcall(reg, CFG.PREFIX) end
end

-- Housekeeping once a minute: deferred offers, item name budget, partial M records, tables.
local function housekeeping()
  names.budget = CFG.NAMES_PER_MINUTE
  if P then requestItems() end
  local t = clock()
  for name, f in pairs(flood) do
    if (not f.mute or t >= f.mute) and t - f.start >= 60 then flood[name] = nil end
  end
  for name, at in pairs(heard) do if t - at > CFG.PEER_WINDOW then heard[name] = nil end end
  for from, per in pairs(partials) do if next(per) == nil then partials[from] = nil end end
  if isReady and P then
    local tnow = now()
    local dueList = {}
    for id, d in pairs(deferred) do if d.at <= tnow then dueList[#dueList + 1] = d end end
    for _, d in ipairs(dueList) do
      deferred[d.t .. ":" .. d.key] = nil
      S.offer(d.t, d.key, d.fields)
    end
  end
  local Y = ns.ShareSync
  if Y and Y.housekeeping then safe(Y.housekeeping) end
end
if C_Timer and C_Timer.NewTicker then
  C_Timer.NewTicker(CFG.HOUSEKEEPING, function() safe(housekeeping) end)
end

-- ---------------------------------------------------------------------------------------
-- API
-- ---------------------------------------------------------------------------------------
-- My player id in the open guild (ids are per guild, §3): the app's (this guild's inbox me.pid, kept in the
-- partition as P.pid), else the one this account adopted or made for the guild; nil before a guild is open.
function S.myPid()
  if not P then return nil end
  local e = meEntry(gkey)
  if e and SC.pidOk(e.pid) then
    P.pid = e.pid
    return e.pid
  end
  if SC.pidOk(P.pid) then return P.pid end
  return nil
end

-- What the app says about me in the open guild: { pid, bt, main, alts } or nil (Collect.ch builds ch from it).
function S.meInfo() return meEntry(gkey) end

function S.get(id)
  if not P or type(id) ~= "string" then return nil end
  return lookup(id)
end

-- Decoded records of one type (tombstones left out), sorted by id.
function S.list(ty)
  local out = {}
  if not P or type(ty) ~= "string" then return out end
  local prefix = ty .. ":"
  local ids = {}
  for id in pairs(P.recs) do if sub(id, 1, #prefix) == prefix then ids[#ids + 1] = id end end
  table.sort(ids, function(a, b) return SC.compareBytes(a, b) < 0 end)
  for _, id in ipairs(ids) do
    local d = lookup(id)
    if d and not d.del then out[#out + 1] = d end
  end
  return out
end

-- The 48 bucket digests as one string (what convergence compares), "" before the store opens.
function S.digests()
  if not P then return "" end
  local Y = ns.ShareSync
  if Y and Y.ensurePruned then Y.ensurePruned() end
  local out = {}
  for b = 0, K.BUCKETS - 1 do out[b + 1] = SC.digestString(X.sum[b], X.cnt[b]) end
  return concat(out)
end

function I.digestValue(b) return SC.digestValue(X.sum[b], X.cnt[b]) end

-- Sizes of the working tables (tests and the problem report).
function I.debug()
  local function n(map) local c = 0; for _ in pairs(map) do c = c + 1 end return c end
  local open = 0
  for _, per in pairs(partials) do open = open + n(per) end
  return {
    ready = isReady, rosterScanned = rosterScanned, records = X and X.count or 0, bytes = X and X.bytes or 0,
    q0 = qlen(Q[0]), q1 = qlen(Q[1]), q2 = qlen(Q[2]), q3 = qlen(Q[3]), inbound = qlen(inbound),
    partials = open, unknown = n(unknown), deferred = n(deferred), tokens = bucket.tokens,
    namesPending = #names.list, namesRequested = n(names.requested),
  }
end

function S.ready() return isReady end

function S.statusLine()
  if IsInGuild and not IsInGuild() then return SAY.noGuild end
  if IsInInstance and IsInInstance() then return SAY.instance end
  if not P then return SAY.starting end
  local peers = I.heardCount(CFG.PEER_WINDOW)
  local line = "Sharing with " .. dec(peers) .. plural(peers, " guildmate. ", " guildmates. ") ..
    grouped(X.count) .. plural(X.count, " record.", " records.")
  local waiting = outboxWaiting() + qlen(Q[1])
  if waiting > 0 then line = line .. " " .. dec(waiting) .. plural(waiting, " change waiting.", " changes waiting.") end
  if not rosterScanned then line = line .. " " .. SAY.starting end
  return line
end

function S.slash(rest)
  rest = type(rest) == "string" and string.lower(rest) or ""
  rest = string.match(rest, "^%s*(.-)%s*$") or ""
  if rest == "" or rest == "status" then
    say(S.statusLine())
    if P and (P.stats.refused or 0) > 0 then
      say(dec(P.stats.refused) .. plural(P.stats.refused, " record from guildmates was refused (not allowed or broken).",
        " records from guildmates were refused (not allowed or broken)."))
    end
  else
    say("/wow share  how sharing with your guild is going")
    say("Your addon trades guild data (raids, sign-ups, requests, crafters) with guildmates' addons in game.")
    say("Nothing is sent in combat or inside dungeons and raids. The Guild Camp app shows it after you log out or type /reload.")
  end
end

-- fn(decoded, how, sender) after a record is stored. how: d, t, m (from a guildmate) or s (seeded);
-- my own records come with how "d" and sender = me.
function S.onRecord(fn)
  if type(fn) == "function" then listeners[#listeners + 1] = fn end
end
