-- Guild Camp: the exchange that keeps guildmates' stores equal (docs/SHARING.md §8, §11).
--
-- Hellos (H) carry 48 bucket digests; a differing bucket is answered with an inventory (I),
-- missing records are asked for (G) and pushed (R / M, packed by Share.lua). Every reply waits
-- a random 0.5-W s and is dropped when an equivalent message was seen first; that one rule is
-- the anti-storm. Also here: the repeat guard, the beacon, the catch-up hello, and pruning with
-- the store caps. Same Lua rules as Share.lua (Lua 5.1 and fengari, everything protected).

local ADDON, ns = ...
if type(ns) ~= "table" then ns = {} end
local S = ns.Share
local SC = ns.ShareCodec
if type(S) ~= "table" or type(S._) ~= "table" or type(SC) ~= "table" then return end
local I = S._
local CFG = I.CFG
local K = SC.K
local floor = math.floor
local sub, concat = string.sub, table.concat

local Y = {}
ns.ShareSync = Y

local seen = { I = {}, G = {}, R = {}, H = {}, Hmine = {} } -- key -> GetTime() when seen (or sent); H: others' hellos
local repeatGuard = {}                          -- peer|bucket|mine|theirs -> { at = GetTime(), level = 1.. } (Y.repeatBlocked)
local repeatAgain = {}                          -- rk -> true once a catch-up got its one repeat (repeatBlocked)
local catchupSeen = {}                          -- rk -> GetTime() a guildmate first answered that catch-up after its hello
local pushedFull = {}                           -- peer|bucket -> GetTime() of my last whole-bucket push to them
local refill = {}                               -- peer -> refills of buckets they say are empty (Y.onHello, refillState)
local answered = {}                             -- peer -> { { at = GetTime(), n = buckets answered } … } (ANSWER_BUDGET)
local wideRounds = {}                           -- peer -> { GetTime() … } of their hellos (no catch-up) I answered (WIDE_ROUNDS)
local gotFromMe = {}                            -- peer -> { [id^v] = GetTime() I last sent it for their G, or they asked again } (Y.onGet)
local sentAgain = {}                            -- peer -> { { at = GetTime(), n = records } … } (GET_REPEAT_BUDGET)
local capStuckUntil = -1e9                       -- Y.storeRoom: no new pass for relayed records over the caps until then
local capStuckFrom = {}                          -- ... for the records this guildmate passes on: sender -> until then
local capFullUntil = -1e9                        -- ... nor for any record (nothing at all left to push out)
local counters = { capPasses = 0, getAgainPeak = 0, widePeak = 0 } -- for tests and the problem report: store-cap passes, most G records sent again in one SEEN_R
local invCollect = {}                           -- pages of one inventory being collected
local hellosHeard = {}                          -- GetTime() of hellos heard lately
local exchangeUntil = 0                         -- records stored before this count as an exchange
local helloGen = 0
local joined = true      -- false from becoming ready until my own hello went (or was not needed)
local catchupAt, catchupTimer = nil, false
local timersStarted = false
local lastPruneHour
local lastArrival = -1e9                         -- GetTime() when a guildmate's record was last stored
local busyUntil = -1e9                           -- my store is still changing through an exchange until then

local function after(seconds, fn)
  if C_Timer then C_Timer.After(seconds, function() I.safe(fn) end) end
end

local function shuffle(list)
  for i = #list, 2, -1 do
    local j = floor(I.rand() * i) + 1
    if j > i then j = i end
    list[i], list[j] = list[j], list[i]
  end
  return list
end

-- ---------------------------------------------------------------------------------------
-- Seen messages (suppression, §8)
-- ---------------------------------------------------------------------------------------
function Y.seenRecord(id, v)
  if type(id) == "string" and type(v) == "string" then seen.R[id .. "^" .. v] = I.clock() end
end

-- Should a queued reply carrying this record be dropped? e = the queue entry: e.since (when the
-- message that asked for it arrived), e.window (seconds, at most 10 min).
-- An R with the same id and v seen first wins: seen after the request arrived, or just before it
-- (STALE_MARGIN: the asker may have built its message before that R reached it). An older one does
-- not count: the asker was in a loading screen, an instance or offline then, or lost it.
function Y.recordSeen(id, v, e)
  local at = seen.R[id .. "^" .. (v or "")]
  if not at then return false end
  e = type(e) == "table" and e or {}
  if I.clock() - at > (e.window or CFG.SEEN_R) then return false end
  if e.since then return at >= e.since - CFG.STALE_MARGIN end
  return true
end

local function invKey(b, digest) return I.dec(b) .. ":" .. I.dec(digest) end
-- A G is keyed by its shortIds only: the answer goes to the whole guild, so the same request to
-- another server is just as good (askers sort their shortIds, so equal requests are equal strings).
local function getKey(sids) return concat(sids) end

local function digestKey(list)
  local out = {}
  for i = 1, K.BUCKETS do out[i] = SC.pad36(list[i] or 0, 4) end
  return concat(out)
end

local function recent(map, key, window)
  local at = map[key]
  return at ~= nil and I.clock() - at <= window
end

-- A queued message that became pointless before its turn (G and H).
function Y.stale(e)
  if e.gkey then return recent(seen.G, e.gkey, CFG.SEEN_G) end
  if e.hello then return recent(seen.H, e.hello, CFG.SEEN_H) or (not e.force and recent(seen.Hmine, e.hello, CFG.SEEN_H)) end
  return false
end

-- Called by Share.lua after a message went to the game.
function Y.onSent(m)
  local t = I.clock()
  local kind = sub(m.m, 2, 2)
  if kind == "H" then
    if m.hello then seen.Hmine[m.hello] = t end
    local P = I.P()
    if P then P.stats.lastHello = I.now() end
    exchangeUntil = t + CFG.EXCHANGE_WINDOW
  elseif kind == "I" then
    if m.ikey then seen.I[m.ikey] = t end
    exchangeUntil = t + CFG.EXCHANGE_WINDOW
  elseif kind == "G" then
    if m.gkey then seen.G[m.gkey] = t end
    exchangeUntil = t + CFG.EXCHANGE_WINDOW
  end
  if m.recs then
    for _, str in ipairs(m.recs) do
      local id, v = I.head(str)
      if id then seen.R[id .. "^" .. v] = t end
    end
  end
end

-- ---------------------------------------------------------------------------------------
-- Replies
-- ---------------------------------------------------------------------------------------
-- W = min(6, 1 + 0.2 × guildmates): guildmates heard in the last 30 min, or online in the roster when
-- that is more (someone who just logged in has heard nobody yet, yet everyone online may answer).
local function replyDelay()
  local peers = I.heardCount(CFG.PEER_WINDOW)
  local online = I.onlineCount()
  if online > peers then peers = online end
  local w = CFG.REPLY_W_BASE + CFG.REPLY_W_PER_PEER * peers
  if w > CFG.REPLY_W_MAX then w = CFG.REPLY_W_MAX end
  if w < CFG.REPLY_MIN then w = CFG.REPLY_MIN end
  return CFG.REPLY_MIN + I.rand() * (w - CFG.REPLY_MIN)
end

local function reply(fn)
  after(replyDelay(), function() if S.ready() and I.P() then fn() end end)
end

local function pushIds(ids, window, peer, since)
  for _, id in ipairs(ids) do I.pushRecord(2, id, nil, { reply = true, window = window, peer = peer, since = since }) end
end

-- Push all of bucket b (a guildmate's is empty): one queue entry that becomes the bucket's records,
-- in random order, when its turn comes. Each is still dropped when someone else sent it first.
local function pushBucket(b, peer, since)
  I.enqueue(2, { expand = function()
    local X = I.X()
    local out = {}
    if not X then return out end
    local ids = {}
    for id in pairs(X.inB[b]) do ids[#ids + 1] = id end
    table.sort(ids)
    shuffle(ids)
    for _, id in ipairs(ids) do
      out[#out + 1] = { rec = id, chan = I.channelOf(id), reply = true, window = CFG.SEEN_R, peer = peer, since = since }
    end
    return out
  end, chan = "GUILD" })
end

-- The repeat guard: the same I (bucket, my digest, their digest) to the same peer once per 2 hours, so a gap nobody
-- online can fix costs one I per 2 hours; when that very I is due again right after (within one more window), the
-- guard doubles, up to REPEAT_LEVELS (2, 4, 8, 16 hours): nothing changed on either side, so it can only have been
-- lost or ignored. One exception (again = true, see Y.onHello): a bucket I may serve, for a
-- catch-up of a guildmate who holds fewer records than I do, gets my I once more after REPEAT_AGAIN, as my first
-- one may have been lost (a G from them clears the guard, but a lost I brings no G). Whoever holds the record that
-- nobody online can pass on holds more records, so that gap still costs one I per 2 hours.
-- The same I sent by a guildmate after a hello that is no catch-up counts as mine (guardSent from
-- Y.inventoryMessages): else each of us would answer the same hello again in turn. (A guildmate whose game crashed
-- before saving and who says the same hello again still catches up: my hello, or anyone's, gets their I, and I push
-- what they lack.)
local function guardWindow(g)
  local w = CFG.REPEAT_GUARD
  for _ = 2, g.level or 1 do w = w * 2 end
  return w
end

local function guarded(rk, window)
  local g = repeatGuard[rk]
  if not g then return false end
  return I.clock() - g.at <= (window or guardWindow(g))
end

function Y.repeatBlocked(rk, again)
  if not guarded(rk) then return false end
  return not (again and not repeatAgain[rk] and not guarded(rk, CFG.REPEAT_AGAIN))
end

-- My I for rk went out now (or the very same one from a guildmate did, after the hello that asked for it).
local function guardSent(rk)
  local t = I.clock()
  local g = repeatGuard[rk]
  if g and t - g.at <= guardWindow(g) then
    -- Still guarded: this is the one repeat Y.repeatBlocked lets through (again).
    repeatAgain[rk] = true
    g.at = t
    return
  end
  local level = 1
  if g and t - g.at <= 2 * guardWindow(g) then
    level = (g.level or 1) + 1
    if level > CFG.REPEAT_LEVELS then level = CFG.REPEAT_LEVELS end
  end
  repeatAgain[rk] = nil
  repeatGuard[rk] = { at = t, level = level }
end

-- My inventory of bucket b, made when its turn to be sent comes (nil when someone sent the same).
function Y.inventoryMessages(e)
  local P, X = I.P(), I.X()
  if not P then return nil end
  Y.ensurePruned()
  local b = e.inv
  local digest = I.digestValue(b)
  local key = invKey(b, digest)
  local rk = e.peer and (e.peer .. "|" .. I.dec(b) .. "|" .. I.dec(digest) .. "|" .. I.dec(e.theirs or 0)) or nil
  if rk and Y.repeatBlocked(rk, e.again) then return nil end
  local at = seen.I[key]
  if at and I.clock() - at <= CFG.SEEN_I then
    -- Someone sent this same inventory in the last minute: one a minute serves every newcomer.
    -- When it went out before the hello arrived, the asker may have missed it (it was not online
    -- or not ready yet): try once more when the minute is over.
    if e.since and at < e.since and not e.retry then
      local again = { inv = b, chan = "GUILD", peer = e.peer, theirs = e.theirs, since = e.since, retry = true, again = e.again,
        catchup = e.catchup }
      after(at + CFG.SEEN_I - I.clock() + replyDelay(), function()
        if S.ready() and I.P() then I.enqueue(2, again) end
      end)
    elseif rk and e.since and at >= e.since then
      -- A guildmate sent it after the hello that asked for it, so the asker has it: it counts for my repeat guard
      -- too, or each of us would answer the same hello again in turn. A catch-up keeps the old way once: a second
      -- of us answering in turn is what makes up for an I lost on the way; the same catch-up hello answered by a
      -- guildmate a second time counts as mine.
      if not e.catchup then
        guardSent(rk)
      else
        local c = catchupSeen[rk]
        if c and I.clock() - c <= CFG.REPEAT_GUARD then
          catchupSeen[rk] = nil
          guardSent(rk)
        else
          catchupSeen[rk] = I.clock()
        end
      end
    end
    return nil
  end
  if rk then guardSent(rk) end
  local entries = {}
  for id in pairs(X.inB[b]) do entries[#entries + 1] = { shortId = X.sidOf[id], v = I.vOf(P.recs[id]) } end
  local out = {}
  for _, m in ipairs(SC.inventoryPages(b, digest, entries)) do
    if m ~= "" then out[#out + 1] = { m = m, chan = "GUILD", ikey = key } end
  end
  return out
end

-- ---------------------------------------------------------------------------------------
-- Refills (§8): a guildmate's hello says a bucket is empty that I pushed them whole lately (PUSH_FULL_GUARD). Their
-- game crashed before saving, their files were wiped, or it is another PC of theirs; or it is a made-up hello. The
-- two look the same, so refills are rationed per guildmate, and every guildmate who hears the hellos rations alike.
-- A refill answers every such bucket of that hello with my I, and forgets what I sent for their G of those buckets
-- (they lost it: asking for it again must not count against GET_REPEAT_BUDGET). One whole-store push a day stays the
-- only answer that costs the guild the store without a G.
--   REFILL_MAX at once and one more every REFILL_EVERY: a game that crashes at every login keeps getting the store.
--   A refill they asked (G, of anyone) for less than half of was of no use to them. One such is free (their game may
--   have crashed before they could ask); after a second in a row, no other for REFILL_IDLE, then 4 times as long each
--   time, up to 16 hours. A made-up hello every 10 minutes costs an inventory round now and then.
--   Their hellos within REFILL_SPAN of a refill are part of it (my I for an empty bucket under the repeat guard),
--   unless they used it: then they lost it again, and a new refill may go.
--   A guildmate's same I for that hello counts as mine (refillHeard), so we stay in step.
-- My refill inventories go in random order, so the G's that follow spread over all of us.
-- ---------------------------------------------------------------------------------------
local function idleWindow(idle)
  if idle < 2 then return 0 end
  local w, cap = CFG.REFILL_IDLE, CFG.REPEAT_GUARD
  for _ = 3, idle do w = w * 4 end
  for _ = 2, CFG.REPEAT_LEVELS do cap = cap * 2 end
  if w > cap then w = cap end
  return w
end

-- Did they use the last refill? (once per refill)
local function judgeRefill(r)
  if r.last and not r.judged then
    r.judged = true
    if r.asked * 2 >= r.want then r.idle = 0 else r.idle = r.idle + 1 end
  end
end

-- → "span" (part of the last refill), "grant" (a new one may go) or nil (none now), and the guildmate's entry.
local function refillState(from, t)
  local r = refill[from]
  if not r then
    r = { tok = CFG.REFILL_MAX, at = t, idle = 0 }
    refill[from] = r
  end
  -- (A refill they used, asked again within the span: they lost it again, a game that crashed right after.)
  if r.last and t - r.last <= CFG.REFILL_SPAN and (r.judged or r.asked * 2 < r.want) then return "span", r end
  judgeRefill(r)
  if r.idle > 0 and t - r.last < idleWindow(r.idle) then return nil, r end
  local tok = r.tok + (t - r.at) / CFG.REFILL_EVERY
  if tok > CFG.REFILL_MAX then tok = CFG.REFILL_MAX end
  r.tok, r.at = tok, t
  if tok < 1 then return nil, r end
  return "grant", r
end

-- A refill for the hello heard at t, of the buckets in list ({ b = … }). mine: my own I's go (else a guildmate's
-- went, refillHeard).
local function grantRefill(from, r, list, t, mine)
  local X = I.X()
  judgeRefill(r)
  local tok = r.tok + (t - r.at) / CFG.REFILL_EVERY
  if tok > CFG.REFILL_MAX then tok = CFG.REFILL_MAX end
  tok = tok - 1
  if tok < 0 then tok = 0 end
  r.tok, r.at = tok, t
  r.last, r.judged, r.asked, r.askedSid, r.buckets, r.want, r.heard = t, false, 0, {}, {}, 0, nil
  for _, x in ipairs(list) do
    r.buckets[x.b] = true
    for _ in pairs(X.inB[x.b]) do r.want = r.want + 1 end
  end
  -- My I for these buckets goes now, whatever went before.
  local prefix = from .. "|"
  for k in pairs(mine and repeatGuard or {}) do
    if sub(k, -2) == "|0" and sub(k, 1, #prefix) == prefix then
      local bar = string.find(k, "|", #prefix + 1, true)
      local b = bar and tonumber(sub(k, #prefix + 1, bar - 1))
      if b and r.buckets[b] then
        repeatGuard[k] = nil
        repeatAgain[k] = nil
      end
    end
  end
  local mem = gotFromMe[from]
  if mem then
    for k in pairs(mem) do
      local caret = string.find(k, "^", 1, true)
      local id = caret and sub(k, 1, caret - 1) or k
      local b = X.bucketOf[id] or SC.bucket(id)
      if b and r.buckets[b] then mem[k] = nil end
    end
  end
end

-- A guildmate's I (by) for bucket b, the same as mine, within SEEN_I of a hello whose empty bucket b I did not answer
-- (part of a refill, or none due on my side): my I for it is guarded. When that hello came in the last SEEN_I of my
-- refill's span or after it, a new refill went to them: it counts as mine (else each of us would answer their hellos
-- in turn, the hello reaching some of us a moment before a window's end and others after it).
local function refillHeard(by, b, t)
  for peer, r in pairs(refill) do
    local hd = r.heard
    if hd and peer ~= by and hd.ks[b] and t - hd.at <= CFG.SEEN_I then
      if not r.last or hd.at - r.last > CFG.REFILL_SPAN - CFG.SEEN_I then
        local list = {}
        for bb in pairs(hd.ks) do list[#list + 1] = { b = bb } end
        grantRefill(peer, r, list, hd.at, false)
        r.heard = hd
      end
      guardSent(hd.ks[b])
      hd.ks[b] = nil
    end
  end
end

-- A G from a guildmate (to anyone) after a refill: the shortIds of it they asked for.
local function refillAsked(from, g)
  local r, X = refill[from], I.X()
  if not (r and r.askedSid and not r.judged and X) then return end
  for _, sid in ipairs(g.shortIds) do
    if not r.askedSid[sid] then
      local set = X.bySid[sid]
      if set then
        for id in pairs(set) do
          if r.buckets[X.bucketOf[id]] then
            r.askedSid[sid] = true
            r.asked = r.asked + 1
            break
          end
        end
      end
    end
  end
end

-- ---------------------------------------------------------------------------------------
-- Hellos
-- ---------------------------------------------------------------------------------------
local function myDigests()
  local list = {}
  for b = 0, K.BUCKETS - 1 do list[b + 1] = I.digestValue(b) end
  return list
end

-- Queue a hello unless one with exactly my digests went out or was heard in the last 5 minutes.
-- Skipped when a guildmate's hello with exactly my digests was seen in the last 5 minutes (its answers
-- serve me too), or my own was and this is not a catch-up. A catch-up (force) follows evidence that
-- something is still missing (my store changed through an exchange, or a record's parts never all
-- came), so my earlier hello or its answers may have been lost: it goes again.
local function sendHello(force)
  local P, X = I.P(), I.X()
  if not P or not S.ready() then return false end
  Y.ensurePruned()
  local digs = myDigests()
  local key = digestKey(digs)
  if recent(seen.H, key, CFG.SEEN_H) then return false end
  if not force and recent(seen.Hmine, key, CFG.SEEN_H) then return false end
  local version = ns.addonVersion and ns.addonVersion() or ""
  local msg = SC.encodeHello({ minor = K.MINOR, count = X.count, digests = digs, addon = version })
  if msg == "" then return false end
  I.enqueue(0, { m = msg, chan = "GUILD", check = true, hello = key, force = force })
  exchangeUntil = I.clock() + CFG.EXCHANGE_WINDOW
  return true
end
Y.sendHello = sendHello

local function hellosInWindow()
  local t, n, keep = I.clock(), 0, {}
  for _, at in ipairs(hellosHeard) do
    if t - at <= CFG.HELLO_BUSY_WINDOW then
      n = n + 1
      keep[#keep + 1] = at
    end
  end
  hellosHeard = keep
  return n
end

-- §8 step 2: hello after 3-15 s + 0.5 s per online guildmate (≤ 40 s); a newcomer that heard 3
-- or more hellos in the last 10 s doubles its wait, up to 2 minutes.
local function scheduleHello()
  helloGen = helloGen + 1
  local gen = helloGen
  local wait = CFG.HELLO_MIN + I.rand() * (CFG.HELLO_MAX - CFG.HELLO_MIN) + CFG.HELLO_PER_PEER * I.onlineCount()
  if wait > CFG.HELLO_CAP then wait = CFG.HELLO_CAP end
  local fire
  fire = function()
    if gen ~= helloGen or not S.ready() then return end
    if hellosInWindow() >= CFG.HELLO_BUSY and wait < CFG.HELLO_BACKOFF_CAP then
      local longer = wait * 2
      if longer > CFG.HELLO_BACKOFF_CAP then longer = CFG.HELLO_BACKOFF_CAP end
      local extra = longer - wait
      wait = longer
      after(extra, fire)
      return
    end
    joined = true
    -- Guildmates' exchanges are already filling my store (their inventories serve everyone): my
    -- own hello would only describe a half-way state. The catch-up hello follows once it settles.
    if busyUntil > I.clock() then
      Y.scheduleCatchup()
      return
    end
    -- My store is about to change through the exchange this hello starts: answer nobody until then.
    busyUntil = I.clock() + CFG.SETTLE
    sendHello()
  end
  after(wait, fire)
end

function Y.onHello(from, msg)
  local h = SC.parseHello(msg)
  if not h then return end
  local P, X = I.P(), I.X()
  local t = I.clock()
  hellosHeard[#hellosHeard + 1] = t
  seen.H[digestKey(h.digests)] = t
  Y.ensurePruned()
  local me = I.me()
  local trustedMe, trustedThem = I.trusted(me), I.trusted(from)
  -- A catch-up: a hello that differs from my store in a few buckets only, from a guildmate who holds fewer records
  -- than I do. My inventory of a bucket I may serve may go to them once more (Y.repeatBlocked).
  local differ = 0
  for b = 0, K.BUCKETS - 1 do if I.digestValue(b) ~= h.digests[b + 1] then differ = differ + 1 end end
  local catchup = differ < CFG.WIDE_HELLO and h.count < ((X and X.count) or 0)
  local pushes, invs, empties = {}, {}, {}
  local deferredAnswer = false
  for b = 0, K.BUCKETS - 1 do
    local mine, theirs = I.digestValue(b), h.digests[b + 1]
    if mine ~= theirs and (SC.mayServe(b, trustedMe) or SC.mayServe(b, trustedThem)) then
      -- An empty bucket: push all of it, once per peer and bucket every PUSH_FULL_GUARD (a guildmate who lost it
      -- again so soon, or says so again, gets a refill: my inventory, and asks for what it lacks).
      if theirs == 0 and SC.mayServe(b, trustedMe) and not recent(pushedFull, from .. "|" .. I.dec(b), CFG.PUSH_FULL_GUARD) then
        pushes[#pushes + 1] = b
      elseif theirs ~= 0 or SC.mayServe(b, trustedMe) then -- (their empty bucket I may not serve: nothing to trade)
        local rk = from .. "|" .. I.dec(b) .. "|" .. I.dec(mine) .. "|" .. I.dec(theirs)
        local again = catchup and SC.mayServe(b, trustedMe)
        -- Until my own hello, my inventories would only describe a store about to change: the
        -- exchange my hello starts serves me (this keeps a mass login from answering itself).
        -- While my own store is still changing through an exchange, my inventory describes a state
        -- nobody else holds: settled peers answer instead (the catch-up hello fixes what is left).
        if not (joined and t >= busyUntil) then
          if not Y.repeatBlocked(rk, again) then deferredAnswer = true end
        elseif theirs == 0 then
          empties[#empties + 1] = { b = b, rk = rk, again = again }
        elseif not Y.repeatBlocked(rk, again) then
          invs[#invs + 1] = { b = b, theirs = theirs, again = again, catchup = catchup }
        end
      end
    end
  end
  -- Buckets they say are empty, pushed to them whole lately: a refill (refillState), or nothing.
  local grant, rf, refills = nil, nil, {}
  if #empties > 0 then
    grant, rf = refillState(from, t)
    local ks
    for _, x in ipairs(empties) do
      if grant == "grant" or (grant == "span" and not Y.repeatBlocked(x.rk, x.again)) then
        refills[#refills + 1] = x
      else
        ks = ks or {}
        ks[x.b] = x.rk
      end
    end
    -- Not mine to answer: a guildmate's same I for it soon counts as mine (refillHeard).
    rf.heard = ks and { at = t, ks = ks } or nil
  end
  -- Not answered now: my own hello, once my store has settled, lets X serve me and me serve X.
  if deferredAnswer then Y.scheduleCatchup() end
  -- A hello that is no catch-up gets my I's at most WIDE_ROUNDS times per REPEAT_GUARD: a guildmate back after a
  -- while needs one round, or two when the first was lost; the rest is a catch-up. Made-up digests, new each time,
  -- or the same ones followed by a G that clears my repeat guard, would get an inventory of the store every time.
  -- (Catch-ups, where each of us answers in turn for an I lost on the way, have no such limit: a game that crashes
  -- at every login has up to 6 of them in 2 hours. Refills and whole-bucket pushes have their own limits.)
  local rounds
  if #invs > 0 and not catchup then
    local keepW = {}
    for _, at in ipairs(wideRounds[from] or {}) do if t - at <= CFG.REPEAT_GUARD then keepW[#keepW + 1] = at end end
    wideRounds[from] = keepW
    if #keepW >= CFG.WIDE_ROUNDS then invs = {} else rounds = keepW end
  end
  local n = #pushes + #invs + #refills
  if n == 0 then return end
  -- Each guildmate's hellos get answers for at most ANSWER_BUDGET buckets every SEEN_R. A newcomer's hello and its
  -- catch-ups fit; hellos made up to make the guild send its store or its inventories again and again don't.
  local list, used, keep = answered[from] or {}, 0, {}
  for _, a in ipairs(list) do
    if t - a.at <= CFG.SEEN_R then
      keep[#keep + 1] = a
      used = used + a.n
    end
  end
  answered[from] = keep
  if used + n > CFG.ANSWER_BUDGET then return end
  keep[#keep + 1] = { at = t, n = n }
  if rounds then
    rounds[#rounds + 1] = t
    if #rounds > counters.widePeak then counters.widePeak = #rounds end
  end
  for _, b in ipairs(pushes) do pushedFull[from .. "|" .. I.dec(b)] = t end
  if grant == "grant" and #refills > 0 then grantRefill(from, rf, refills, t, true) end
  -- In random order: each of us then sends some of a refill's inventories first, so the store comes back through
  -- the G's of several of us at once, not through whoever answered fastest alone.
  shuffle(refills)
  for _, x in ipairs(refills) do invs[#invs + 1] = { b = x.b, theirs = 0, again = x.again, catchup = catchup } end
  exchangeUntil = t + CFG.EXCHANGE_WINDOW
  shuffle(pushes)
  reply(function()
    for _, x in ipairs(invs) do
      I.enqueue(2, { inv = x.b, chan = "GUILD", peer = from, theirs = x.theirs, since = t, again = x.again, catchup = x.catchup })
    end
    for _, b in ipairs(pushes) do pushBucket(b, from, t) end
  end)
end

-- ---------------------------------------------------------------------------------------
-- Inventories
-- ---------------------------------------------------------------------------------------
local function finishInventory(key)
  local c = invCollect[key]
  if not c or c.done then return end
  c.done = true
  invCollect[key] = nil
  local P, X = I.P(), I.X()
  if not P or not S.ready() then return end
  Y.ensurePruned()
  local b = c.bucket
  if I.digestValue(b) == c.digest then return end
  local me = I.me()
  local trustedMe, trustedThem = I.trusted(me), I.trusted(c.from)
  -- Ask the sender for every (shortId, v) pair I don't hold, unless my only record with it is newer.
  if SC.mayServe(b, trustedThem) then
    local want, asked = {}, {}
    local wanted = {}
    for _, e in ipairs(c.entries) do
      local sid = e.shortId
      if not asked[sid] then
        local need = true
        local held = X.bySid[sid]
        if held then
          local n, same, newer = 0, false, false
          for id in pairs(held) do
            if X.bucketOf[id] == b then
              n = n + 1
              local v = I.vOf(P.recs[id])
              if v == e.v then same = true elseif SC.compareVersions(v, e.v) > 0 then newer = true end
            end
          end
          if same or (n == 1 and newer) then need = false end
        end
        if need then
          asked[sid] = true
          want[#want + 1] = sid
          wanted[#wanted + 1] = { sid = sid, v = e.v }
        end
      end
    end
    if #want > 0 then
      exchangeUntil = I.clock() + CFG.EXCHANGE_WINDOW
      local target = c.from
      reply(function() Y.askFor(target, b, wanted, 0) end)
    end
  end
  -- Push what the sender lacks or holds older, when its pages were complete.
  if SC.mayServe(b, trustedMe) and c.complete then
    local theirs = {}
    for _, e in ipairs(c.entries) do
      local l = theirs[e.shortId]
      if not l then
        l = {}
        theirs[e.shortId] = l
      end
      l[#l + 1] = e.v
    end
    local pushes = {}
    for id in pairs(X.inB[b]) do
      local v = I.vOf(P.recs[id])
      local l = theirs[X.sidOf[id]]
      local push = true
      if l then
        for _, tv in ipairs(l) do if tv == v then push = false end end
        if push and #l == 1 and SC.compareVersions(l[1], v) > 0 then push = false end
      end
      if push then pushes[#pushes + 1] = id end
    end
    if #pushes > 0 then
      shuffle(pushes)
      local from, since = c.from, c.at
      reply(function() pushIds(pushes, CFG.SEEN_R, from, since) end)
    end
  end
end

-- Do I hold (shortId, v) in bucket b, or something newer with that shortId?
local function holds(b, sid, v)
  local P, X = I.P(), I.X()
  local held = X.bySid[sid]
  if not held then return false end
  for id in pairs(held) do
    if X.bucketOf[id] == b then
      local hv = I.vOf(P.recs[id])
      if hv == v or SC.compareVersions(hv, v) > 0 then return true end
    end
  end
  return false
end

-- G to target for wants = { { sid, v } … }. Whatever has not arrived GET_RETRY s later is asked for
-- again (at most GET_TRIES more times): a lost R or M part costs a retry, not a whole exchange.
function Y.askFor(target, b, wants, tries)
  local sids = {}
  for _, w in ipairs(wants) do sids[#sids + 1] = w.sid end
  table.sort(sids)
  -- "1G" target "^" shortIds: what follows the "^" is the key Y.onGet makes. A retry is not
  -- dropped for matching my own earlier request.
  for _, m in ipairs(SC.encodeGet(target, sids)) do
    local caret = string.find(m, "^", 3, true)
    I.enqueue(0, { m = m, chan = "GUILD", check = tries == 0, gkey = sub(m, caret + 1) })
  end
  if tries >= CFG.GET_TRIES then return end
  local waited = 0
  local check
  check = function()
    if not S.ready() or not I.P() then return end
    waited = waited + CFG.GET_RETRY
    -- Records still arriving: the answer may be queued behind them, so wait (up to 10 minutes).
    if I.clock() - lastArrival < CFG.GET_RETRY / 2 and waited < 600 then
      after(CFG.GET_RETRY, check)
      return
    end
    local still = {}
    for _, w in ipairs(wants) do if not holds(b, w.sid, w.v) then still[#still + 1] = w end end
    if #still > 0 then Y.askFor(target, b, still, tries + 1) end
  end
  after(CFG.GET_RETRY, check)
end

function Y.onInventory(from, msg)
  local inv = SC.parseInventory(msg)
  if not inv then return end
  local t = I.clock()
  local b = inv.bucket
  seen.I[invKey(b, inv.digest)] = t -- my pending I(b) with this digest is now pointless
  Y.ensurePruned()
  if I.digestValue(b) == inv.digest then
    if next(refill) then refillHeard(from, b, t) end
    return
  end
  local key = from .. "|" .. I.dec(b) .. "|" .. I.dec(inv.digest) .. "|" .. I.dec(inv.pages)
  local c = invCollect[key]
  if not c then
    c = { from = from, bucket = b, digest = inv.digest, pages = inv.pages, got = {}, n = 0, entries = {}, at = t }
    invCollect[key] = c
    after(CFG.INV_WAIT, function() finishInventory(key) end)
  end
  if c.got[inv.page] then return end
  c.got[inv.page] = true
  c.n = c.n + 1
  for _, e in ipairs(inv.entries) do c.entries[#c.entries + 1] = e end
  if c.n >= c.pages then
    c.complete = true
    finishInventory(key)
  end
end

-- ---------------------------------------------------------------------------------------
-- Requests
-- ---------------------------------------------------------------------------------------
-- Forget the repeat guard for (peer, bucket). A guard on "my bucket is empty" stays: a G for that bucket means the
-- asker holds some of it now (a new state, a new guard), or lost what I sent (its G goes again, GET_TRIES); a store
-- that lost it all again says so in its hello, and refills answer that (refillState).
function Y.forgetRepeat(peer, b)
  local prefix = peer .. "|" .. I.dec(b) .. "|"
  for k in pairs(repeatGuard) do
    if sub(k, 1, #prefix) == prefix and sub(k, -2) ~= "|0" then
      repeatGuard[k] = nil
      repeatAgain[k] = nil
    end
  end
end

-- The guildmate's G-answer records sent again in the last SEEN_R (GET_REPEAT_BUDGET).
local function sentAgainCount(from, t)
  local list, used, keep = sentAgain[from] or {}, 0, {}
  for _, a in ipairs(list) do
    if t - a.at <= CFG.SEEN_R then
      keep[#keep + 1] = a
      used = used + a.n
    end
  end
  sentAgain[from] = keep
  return used, keep
end

-- G to me: the matching records I may serve go out. A record I already sent for this guildmate's G in the last
-- REPEAT_GUARD counts against GET_REPEAT_BUDGET (my R was lost and their G goes again), so asking for the store
-- over and over doesn't make me send it over and over. Asked again past the budget, it stays counted for as long as
-- they keep asking within REPEAT_GUARD.
function Y.onGet(from, msg)
  local g = SC.parseGet(msg)
  if not g then return end
  seen.G[getKey(g.shortIds)] = I.clock()
  refillAsked(from, g)
  local me = I.me()
  if g.target ~= me then return end
  local P, X = I.P(), I.X()
  local trustedMe = I.trusted(me)
  local t = I.clock()
  local mem = gotFromMe[from]
  if not mem then
    mem = {}
    gotFromMe[from] = mem
  end
  local used, keep = sentAgainCount(from, t)
  local ids, buckets, again = {}, {}, 0
  for _, sid in ipairs(g.shortIds) do
    local set = X.bySid[sid]
    if set then
      for id in pairs(set) do
        local b = X.bucketOf[id]
        if SC.mayServe(b, trustedMe) then
          local k = id .. "^" .. (I.vOf(P.recs[id]) or "")
          local prev = mem[k]
          local repeated = prev ~= nil and t - prev <= CFG.REPEAT_GUARD
          if not repeated or used + again < CFG.GET_REPEAT_BUDGET then
            ids[#ids + 1] = id
            mem[k] = t
            if repeated then again = again + 1 else buckets[b] = true end
          else
            -- Asked again past the budget: it stays "sent again" for as long as they keep asking, so asking for the
            -- store over and over never makes it go out whole again once REPEAT_GUARD is over.
            mem[k] = t
          end
        end
      end
    end
  end
  if again > 0 then
    keep[#keep + 1] = { at = t, n = again }
    if used + again > counters.getAgainPeak then counters.getAgainPeak = used + again end
  end
  if #ids == 0 then return end
  -- The asker could use my inventory, so the gap is one I can fix: if what I send now is lost, my
  -- next inventory for it must not wait for the repeat guard (that is for gaps nobody can fix). (A G for one more
  -- record of each bucket after the same made-up hello brings that hello's inventory round back: WIDE_ROUNDS bounds it.
  -- A game that crashes at every login passes through the same half-filled buckets again, and needs this each time.)
  for b in pairs(buckets) do Y.forgetRepeat(from, b) end
  exchangeUntil = I.clock() + CFG.EXCHANGE_WINDOW
  local since = I.clock()
  reply(function() pushIds(ids, CFG.SEEN_R, nil, since) end)
end

-- ---------------------------------------------------------------------------------------
-- Catch-up: hello again 2 min after the last exchange that changed my store
-- ---------------------------------------------------------------------------------------
local function catchupCheck()
  catchupTimer = false
  if not catchupAt then return end
  local t = I.clock()
  if t < catchupAt then
    catchupTimer = true
    after(catchupAt - t, catchupCheck)
    return
  end
  catchupAt = nil
  if S.ready() then sendHello(true) end
end

function Y.scheduleCatchup()
  local t = I.clock()
  catchupAt = t + CFG.CATCHUP + I.rand() * CFG.CATCHUP_JITTER
  if not catchupTimer then
    catchupTimer = true
    after(catchupAt - t, catchupCheck)
  end
end

function Y.onStored(rec, how)
  local t = I.clock()
  lastArrival = t
  if t > exchangeUntil then return end -- a push on write, not an exchange
  exchangeUntil = t + CFG.EXCHANGE_WINDOW
  busyUntil = t + CFG.SETTLE
  local P = I.P()
  if P then P.stats.lastExchange = I.now() end
  Y.scheduleCatchup()
end

-- A record in parts never completed: something is missing, so hello again a little later.
function Y.onMissed()
  Y.scheduleCatchup()
end

-- ---------------------------------------------------------------------------------------
-- Beacon: every 10 ± 2 min the peer with the lowest djb2(name .. slot) among peers heard in the
-- last 15 min says hello
-- ---------------------------------------------------------------------------------------
local function beaconTick()
  after(CFG.BEACON - CFG.BEACON_JITTER + I.rand() * 2 * CFG.BEACON_JITTER, beaconTick)
  if not S.ready() or not I.P() then return end
  local me = I.me()
  local slot = I.dec(floor(I.now() / CFG.BEACON_SLOT)) -- decimal, as name .. floor(serverTime / 600) reads
  local best, bestName = SC.djb2(me .. slot), me
  local t = I.clock()
  for name, at in pairs(I.heard) do
    if name ~= me and t - at <= CFG.BEACON_PEERS and I.onlineNow[name] then
      local h = SC.djb2(name .. slot)
      if h < best or (h == best and SC.compareBytes(name, bestName) < 0) then best, bestName = h, name end
    end
  end
  if bestName == me then sendHello() end
end

-- ---------------------------------------------------------------------------------------
-- Pruning and caps (§11)
-- ---------------------------------------------------------------------------------------
local function pastRaid(rec, tnow)
  local raid = SC.split(rec.key, ":")[1]
  local rd = I.lookup("RD:" .. raid)
  return rd ~= nil and not rd.del and type(rd.fields) == "table" and type(rd.fields.startsAt) == "number" and rd.fields.startsAt < tnow
end

local function foldedAward(rec)
  local inst = rec.fields and rec.fields.instance
  if type(inst) ~= "string" or inst == "" then return false end
  local ly = I.lookup("LY:" .. inst)
  return ly ~= nil and not ly.del and type(ly.fields) == "table" and type(ly.fields.upto) == "number" and rec.t <= ly.fields.upto
end

-- One of a member's own few records that nobody can multiply in their name: ch and bk (keyed by the character, who
-- must be the author), and a price list keyed by the player id its author's own ch names (a made-up id gives more).
local function onePerMember(id, ty, author)
  if ty == "ch" or ty == "bk" then return true end
  if ty ~= "pr" or type(author) ~= "string" then return false end
  local ch = I.lookup("ch:" .. author)
  return ch ~= nil and not ch.del and type(ch.fields) == "table" and ch.fields.pid == sub(id, 4)
end

-- The store-cap class of a record (§11): over a cap, records go by class, lowest first; nil = never pushed out for
-- the store caps. from / how: who passed it on and how (P.via, or the message bringing it).
--   1 types this version doesn't know
--   2 member records whose author is not in my roster (made-up names, or players who left)
--   3 member records passed on by a guildmate, grouped by who passed them on: the guildmate who passed on the most
--     (bytes, in 3 and 8) goes first, their 8 too. Anyone may pass on a member record in anyone's name, so this is
--     where one guildmate's made-up records in many members' names end up. Not a member's ch, bk or own price list
--     (onePerMember): see 8.
--   4 member records from my app's seed (same exception)
--   5 sign-ups of past raids, 6 guild bank tabs (heard from their author, or mine)
--   7 loot awards folded into loyalty
--   8 ch, bk and price lists keyed by their author's own id, passed on (grouped as in 3) or from my app's seed
--   9 price lists heard from their author
-- Never: officer records (but 7); member records heard from their author or mine (but 5, 6 and 9); my price list.
local function capClass(id, str, from, how, ctx)
  local ty = I.typeOf(id)
  if SC.TYPES[ty] == nil then return 1 end
  if SC.spaceOf(ty) ~= "member" then
    if ty == "LA" then
      local r = I.lookup(id)
      if r ~= nil and not r.del and foldedAward(r) then return 7 end
    end
    return nil
  end
  local _, _, author = I.head(str)
  if ctx.roster and author ~= ctx.me and I.rankOf(author) == nil then return 2 end
  local relayed = how ~= "d" and how ~= "s"
  local one = onePerMember(id, ty, author)
  if relayed then
    if one then return 8, from end
    return 3, from
  end
  if how == "s" then
    if one then return 8 end
    return 4
  end
  if ty == "pr" then
    if from == ctx.me then return nil end
    return 9
  end
  if ty == "su" then
    local r = I.lookup(id)
    if r ~= nil and pastRaid(r, ctx.now) then return 5 end
  elseif ty == "gb" then
    return 6
  end
  return nil
end

local function capContext()
  return { me = I.me(), roster = I.rosterReady and I.rosterReady() or false, now = I.now() }
end

-- Every record the store caps may push out (skip: ids left out), and how many bytes of them (classes 3 and 8) each
-- guildmate passed on. Bytes, not records: 2 KB bank records made up for each roster character are few records but
-- most of the byte cap.
local function capCandidates(skip, ctx)
  local P = I.P()
  local list, sizes = {}, {}
  for id, str in pairs(P.recs) do
    if not (skip and skip[id]) then
      local from, how = I.viaOf(id)
      local c, grp = capClass(id, str, from, how, ctx)
      if c then
        list[#list + 1] = { id = id, c = c, g = grp or "", t = SC.tOfVersion(I.vOf(str)) or 0, n = #str }
        if grp then sizes[grp] = (sizes[grp] or 0) + #str end
      end
    end
  end
  return list, sizes
end

-- a goes before b: by class, then (classes 3 and 8) the guildmate who passed on the most bytes, then (within one
-- guildmate's) 3 before 8, then oldest first. The guildmate who passed on the most goes first across both: their
-- ch, bk and price lists (8) go with their other records (3), before anyone else's. (Junk an honest guildmate passed
-- on counts as theirs.)
local function capOrder(sizes)
  local top, most = nil, -1
  for g, n in pairs(sizes) do
    if n > most or (n == most and SC.compareBytes(g, top) < 0) then top, most = g, n end
  end
  local function rank(e)
    if e.c == 8 and e.g == top then return 3 end
    return e.c
  end
  return function(a, b)
    local ra, rb = rank(a), rank(b)
    if ra ~= rb then return ra < rb end
    if a.g ~= b.g then
      local na, nb = sizes[a.g] or 0, sizes[b.g] or 0
      if na ~= nb then return na > nb end
      return SC.compareBytes(a.g, b.g) < 0
    end
    if a.c ~= b.c then return a.c < b.c end
    if a.t ~= b.t then return a.t < b.t end
    return SC.compareBytes(a.id, b.id) < 0
  end
end

local function capsOver(count, bytes) return count > K.STORE_MAX_RECORDS or bytes > K.STORE_MAX_BYTES end
local function capsAbove(count, bytes)
  return count > K.STORE_MAX_RECORDS - CFG.CAPS_SLACK or bytes > K.STORE_MAX_BYTES - CFG.CAPS_SLACK_BYTES
end

-- Room under the store caps (§11) for a record about to be stored: rec (decoded), its string, the copy it replaces,
-- who sent it and how, with `gone` (ids the author caps push out) already counted out. → true and the ids that must
-- go first, or false (refused). Nothing is removed here.
-- Over a cap, one pass over the store pushes records out by class (capClass), down to CAPS_SLACK below the caps, so
-- the records that follow don't each start a pass. A relayed record may push out only records that go before it and
-- are of a lower class or older than itself (stores only move to newer records, so exchanges can't go round in
-- circles); a relayed one of class 3 or 8 never a class-8 record another guildmate passed on, nor (class 8) a class-3
-- record of a guildmate who passed on fewer bytes than its own passer; else it is refused. A record heard from its
-- author, mine, or from my app's seed always gets in. After a pass for a relayed record that couldn't get CAPS_SLACK
-- below the caps, the records that guildmate passes on over them are refused for CAPS_STUCK without a pass (only
-- theirs: else one backdated record a minute from one guildmate would make the store refuse what everyone else
-- passes on, newer records and officer records included). When even a record heard from its author found too little
-- to push out, every relayed record over the caps is refused, and those heard from their author get in, without a
-- pass for that long. So a store full of records it may not push out costs a pass a minute per guildmate passing
-- records on, not a pass per record.
function Y.storeRoom(rec, str, old, from, how, gone)
  local P, X = I.P(), I.X()
  if not P or type(rec) ~= "table" then return true end
  local skip = { [rec.id] = true }
  local count, bytes = X.count + 1, X.bytes + #str
  if old then count, bytes = count - 1, bytes - #old end
  for _, id in ipairs(gone or {}) do
    local s = P.recs[id]
    if s and not skip[id] then
      skip[id] = true
      count, bytes = count - 1, bytes - #s
    end
  end
  if not capsOver(count, bytes) then return true end
  local ctx = capContext()
  local strong = how == "d" or how == "s" or from == ctx.me
  if strong then
    if I.clock() < capFullUntil then return true end
  elseif I.clock() < capStuckUntil or I.clock() < (capStuckFrom[from or ""] or -1e9) then
    return false
  end
  counters.capPasses = counters.capPasses + 1
  local list, sizes = capCandidates(skip, ctx)
  local order = capOrder(sizes)
  table.sort(list, order)
  local cx, gx = capClass(rec.id, str, from, how, ctx)
  local x = { id = rec.id, c = cx or 99, g = gx or "", t = rec.t or 0 }
  local out = {}
  for _, e in ipairs(list) do
    if not capsAbove(count, bytes) then break end
    if not strong and not order(e, x) then break end
    -- A relayed ch, bk or price list (8) pushes out those of class 8 only when the same guildmate passed them on: else
    -- one guildmate's made-up ones, one per roster character, push out the price lists and ch's passed on by whoever
    -- passed on more of them. A relayed record of class 3 pushes out none (it never did: 8 went after 3 before the
    -- top guildmate's 8 went with their 3). And a relayed one of class 8 never pushes out records (3) passed on by a
    -- guildmate who passed on fewer bytes than its own passer: made-up bank records go before honest relays, not after.
    local keep = false
    if not strong and e.g ~= x.g and (x.c == 3 or x.c == 8) then
      if e.c == 8 then
        keep = true
      elseif e.c == 3 and (sizes[e.g] or 0) < (sizes[x.g] or 0) + #str then
        keep = true
      end
    end
    if not keep and (strong or e.c < x.c or e.t < x.t or (e.t == x.t and SC.compareBytes(e.id, x.id) < 0)) then
      out[#out + 1] = e.id
      count, bytes = count - 1, bytes - e.n
    end
  end
  if capsAbove(count, bytes) then
    local stuck = I.clock() + CFG.CAPS_STUCK
    if strong then
      capStuckUntil, capFullUntil = stuck, stuck
    else
      capStuckFrom[from or ""] = stuck
    end
  end
  if capsOver(count, bytes) and not strong then return false end
  return true, out
end

-- A store over its caps (one saved by another version, a seed, records of mine): down to CAPS_SLACK below them, by
-- class (capClass).
function Y.enforceCaps()
  local P, X = I.P(), I.X()
  if not P then return 0 end
  capStuckUntil, capFullUntil = -1e9, -1e9
  for k in pairs(capStuckFrom) do capStuckFrom[k] = nil end
  if not capsOver(X.count, X.bytes) then return 0 end
  counters.capPasses = counters.capPasses + 1
  local list, sizes = capCandidates(nil, capContext())
  table.sort(list, capOrder(sizes))
  local removed = 0
  for _, e in ipairs(list) do
    if not capsAbove(X.count, X.bytes) then break end
    I.remove(e.id)
    removed = removed + 1
  end
  return removed
end

-- Drop every record expired at the start of the current server hour (the same hour on every peer).
function Y.prune()
  local P = I.P()
  if not P then return 0 end
  local hour = SC.hourStart(I.now())
  local dead = {}
  for id, str in pairs(P.recs) do
    if I.expired(id, str, hour) then dead[#dead + 1] = id end
  end
  for _, id in ipairs(dead) do I.remove(id) end
  lastPruneHour = hour
  -- Records of types this version doesn't know keep to their own budget (a store saved before it, or seeded):
  -- the oldest go.
  local X = I.X()
  if X and X.unk and (X.unk.count > K.UNKNOWN_MAX_RECORDS or X.unk.bytes > K.UNKNOWN_MAX_BYTES) then
    local list = {}
    for id in pairs(X.unkIds) do
      local str = P.recs[id]
      if str then list[#list + 1] = { id = id, t = SC.tOfVersion(I.vOf(str)) or 0 } end
    end
    table.sort(list, function(a, b)
      if a.t ~= b.t then return a.t < b.t end
      return SC.compareBytes(a.id, b.id) < 0
    end)
    for _, x in ipairs(list) do
      if X.unk.count <= K.UNKNOWN_MAX_RECORDS and X.unk.bytes <= K.UNKNOWN_MAX_BYTES then break end
      I.remove(x.id)
      dead[#dead + 1] = x.id
    end
  end
  Y.enforceCaps()
  return #dead
end

function Y.ensurePruned()
  if not I.P() then return end
  if lastPruneHour ~= SC.hourStart(I.now()) then Y.prune() end
end

-- Another guild's store opened (the first one, or after changing guilds): what I heard, sent or guarded was
-- about the old guild's store and peers.
function Y.onPartition()
  lastPruneHour = nil
  for k in pairs(invCollect) do invCollect[k] = nil end
  for _, map in pairs(seen) do for k in pairs(map) do map[k] = nil end end
  for _, map in ipairs({ repeatGuard, repeatAgain, pushedFull, refill, answered, wideRounds, catchupSeen, gotFromMe, sentAgain }) do for k in pairs(map) do map[k] = nil end end
  hellosHeard = {}
  exchangeUntil, busyUntil, lastArrival = 0, -1e9, -1e9
  catchupAt = nil
  capStuckUntil, capFullUntil = -1e9, -1e9
  for k in pairs(capStuckFrom) do capStuckFrom[k] = nil end
end

local function pruneTick()
  local tnow = I.now()
  local wait = SC.hourStart(tnow) + K.HOUR - tnow + I.rand() * CFG.PRUNE_JITTER
  after(wait, pruneTick)
  Y.ensurePruned()
end

-- ---------------------------------------------------------------------------------------
-- Life cycle
-- ---------------------------------------------------------------------------------------
function Y.onReady(withHello)
  if not timersStarted and C_Timer then
    timersStarted = true
    after(CFG.BEACON - CFG.BEACON_JITTER + I.rand() * 2 * CFG.BEACON_JITTER, beaconTick)
    local tnow = I.now()
    after(SC.hourStart(tnow) + K.HOUR - tnow + I.rand() * CFG.PRUNE_JITTER, pruneTick)
  end
  if withHello then
    joined = false
    scheduleHello()
  end
end

function Y.onUnready()
  helloGen = helloGen + 1
  for k in pairs(invCollect) do invCollect[k] = nil end
end

function Y.housekeeping()
  local t = I.clock()
  for k, at in pairs(seen.I) do if t - at > CFG.SEEN_I then seen.I[k] = nil end end
  for k, at in pairs(seen.G) do if t - at > CFG.SEEN_G then seen.G[k] = nil end end
  for k, at in pairs(seen.R) do if t - at > CFG.SEEN_R then seen.R[k] = nil end end
  for k, at in pairs(seen.H) do if t - at > CFG.SEEN_H then seen.H[k] = nil end end
  for k, at in pairs(seen.Hmine) do if t - at > CFG.SEEN_H then seen.Hmine[k] = nil end end
  -- A guard is kept one more window after it ends: an I due again then doubles it (guardSent).
  for k, g in pairs(repeatGuard) do if t - g.at > 2 * guardWindow(g) then repeatGuard[k] = nil end end
  for k in pairs(repeatAgain) do if not repeatGuard[k] then repeatAgain[k] = nil end end
  for k, at in pairs(catchupSeen) do if t - at > CFG.REPEAT_GUARD then catchupSeen[k] = nil end end
  for k, at in pairs(pushedFull) do if t - at > CFG.PUSH_FULL_GUARD then pushedFull[k] = nil end end
  for k, list in pairs(wideRounds) do
    local last = list[#list]
    if not last or t - last > CFG.REPEAT_GUARD then wideRounds[k] = nil end
  end
  -- A guildmate quiet this long gets their refills back (all of them, and no wait for an unused one).
  for k, r in pairs(refill) do
    local quiet = t - (r.last or r.at)
    if quiet > 2 * idleWindow(r.idle) and quiet > CFG.REFILL_MAX * CFG.REFILL_EVERY then refill[k] = nil end
  end
  for k, list in pairs(answered) do
    local last = list[#list]
    if not last or t - last.at > CFG.SEEN_R then answered[k] = nil end
  end
  for k, untilT in pairs(capStuckFrom) do if t >= untilT then capStuckFrom[k] = nil end end
  for peer, mem in pairs(gotFromMe) do
    for k, at in pairs(mem) do if t - at > CFG.REPEAT_GUARD then mem[k] = nil end end
    if next(mem) == nil then gotFromMe[peer] = nil end
  end
  for k, list in pairs(sentAgain) do
    local last = list[#list]
    if not last or t - last.at > CFG.SEEN_R then sentAgain[k] = nil end
  end
end

-- For tests and /wow share: how many entries each table holds.
function Y.debugCounts()
  local function n(map) local c = 0; for _ in pairs(map) do c = c + 1 end return c end
  local got = 0
  for _, mem in pairs(gotFromMe) do got = got + n(mem) end
  local stuck = I.clock() < capStuckUntil
  for _, untilT in pairs(capStuckFrom) do if I.clock() < untilT then stuck = true end end
  return { seenI = n(seen.I), seenG = n(seen.G), seenR = n(seen.R), seenH = n(seen.H), repeatGuard = n(repeatGuard),
    pushedFull = n(pushedFull), refill = n(refill), answered = n(answered), gotFromMe = got,
    collecting = n(invCollect), capStuck = stuck, capPasses = counters.capPasses,
    getAgainPeak = counters.getAgainPeak, widePeak = counters.widePeak }
end

-- For tests: the exchange state (seconds left on each window).
function Y.debugState()
  local t = I.clock()
  return { joined = joined, busy = busyUntil - t, exchange = exchangeUntil - t, lastArrival = t - lastArrival }
end
