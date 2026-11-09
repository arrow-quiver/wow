-- Checks addon/WowGuild/ShareCodec.lua against the golden vectors made by sharing.js
-- (test/fixtures/sharing-vectors.json, turned into a Lua table by the test).
-- Runs on fengari (Lua 5.3) and on a real Lua 5.1. Test code only: it may use tostring and
-- string.format, the codec may not.
-- Usage: local check = <this chunk>(); local failures = check(SC, V)  -- a list of strings

return function(SC, V)
  local fails = {}
  local function fail(where, got, want)
    local function short(x)
      x = tostring(x)
      if #x > 300 then x = string.sub(x, 1, 300) .. "..." end
      return x
    end
    fails[#fails + 1] = where .. ": got " .. short(got) .. " want " .. short(want)
  end
  local function num(n) if type(n) == "number" then return string.format("%.0f", n) end return tostring(n) end

  local function dump(v)
    local t = type(v)
    if v == nil then return "nil" end
    if t == "boolean" then if v then return "T" end return "F" end
    if t == "number" then return "n" .. num(v) end
    if t == "string" then return "s" .. string.format("%d", #v) .. ":" .. v end
    if t == "table" then
      if v[1] ~= nil then
        local out = {}
        for i = 1, #v do out[i] = dump(v[i]) end
        return "[" .. table.concat(out, ",") .. "]"
      end
      local keys = {}
      for k, x in pairs(v) do if type(x) ~= "function" then keys[#keys + 1] = tostring(k) end end
      if #keys == 0 then return "{}" end
      table.sort(keys, function(a, b) return SC.compareBytes(a, b) < 0 end)
      local out = {}
      for i, k in ipairs(keys) do
        local x = v[k]
        if x == nil then x = v[tonumber(k)] end
        out[i] = k .. "=" .. dump(x)
      end
      return "{" .. table.concat(out, ";") .. "}"
    end
    return "?" .. t
  end

  local function same(where, got, want)
    if got ~= want then
      if type(got) == "number" and type(want) == "number" then
        fail(where, num(got), num(want))
      else
        fail(where, got, want)
      end
    end
  end
  local function safe(where, fn, ...)
    local ok, a, b = pcall(fn, ...)
    if not ok then fail(where .. " threw", a, "no error") return nil end
    return a, b
  end
  local function lookupOf(map)
    return function(id) if map then return map[id] end return nil end
  end
  local function each(list, fn)
    if type(list) ~= "table" then return end
    for i, x in ipairs(list) do fn(i, x) end
  end

  -- Constants and the type table
  if V.K then for k, want in pairs(V.K) do same("K." .. k, SC.K[k], want) end end
  if V.typesDump then same("TYPES", dump(SC.TYPES), V.typesDump) end

  each(V.hashes, function(i, c) same("djb2[" .. i .. "]", safe("djb2", SC.djb2, c.s), c.h) end)
  each(V.b36, function(i, c)
    same("toB36[" .. i .. "]", safe("toB36", SC.toB36, c.n), c.s)
    if c.width then same("pad36[" .. i .. "]", safe("pad36", SC.pad36, c.n, c.width), c.pad) end
  end)
  each(V.fromB36, function(i, c) same("fromB36[" .. i .. "]", safe("fromB36", SC.fromB36, c.s), c.n) end)
  each(V.cuts, function(i, c) same("cutUtf8[" .. i .. "]", safe("cutUtf8", SC.cutUtf8, c.s, c.max), c.out) end)
  each(V.escCuts, function(i, c) same("cutEscaped[" .. i .. "]", safe("cutEscaped", SC.cutEscaped, c.s, c.max), c.out) end)
  each(V.escapes, function(i, c)
    local e = safe("escape", SC.escape, c.s, c.max)
    same("escape[" .. i .. "]", e, c.escaped)
    same("unescape[" .. i .. "]", safe("unescape", SC.unescape, c.escaped), c.unescaped)
  end)
  each(V.unescapeBad, function(i, s) same("unescapeBad[" .. i .. "]", safe("unescape", SC.unescape, s), nil) end)
  each(V.varints, function(i, c)
    same("encodeIds[" .. i .. "]", safe("encodeIds", SC.encodeIds, c.ids, c.maxItems), c.s)
    same("decodeIds[" .. i .. "]", dump(safe("decodeIds", SC.decodeIds, c.s)), c.decoded)
  end)
  each(V.varintBad, function(i, s) same("varintBad[" .. i .. "]", safe("decodeIds", SC.decodeIds, s), nil) end)
  each(V.ids, function(i, c)
    same("bucket[" .. i .. "]", safe("bucket", SC.bucket, c.id), c.bucket)
    same("shortId[" .. i .. "]", safe("shortId", SC.shortId, c.id), c.shortId)
    same("digestTerm[" .. i .. "]", safe("digestTerm", SC.digestTerm, c.id, c.v), c.term)
    same("mayServe[" .. i .. "]", SC.mayServe(c.bucket, false), c.memberMayServe)
  end)
  each(V.digests, function(i, c)
    local sum, count = 0, 0
    for _, e in ipairs(c.entries) do sum = sum + SC.digestTerm(e.id, e.v); count = count + 1 end
    for _, e in ipairs(c.removed or {}) do sum = sum - SC.digestTerm(e.id, e.v); count = count - 1 end
    same("digest sum[" .. i .. "]", sum, c.sum)
    same("digest value[" .. i .. "]", SC.digestValue(sum, count), c.value)
    same("digest string[" .. i .. "]", SC.digestString(sum, count), c.str)
  end)
  each(V.versions, function(i, c)
    local v = safe("makeVersion", SC.makeVersion, c.t, c.author, c.final)
    same("makeVersion[" .. i .. "]", v, c.v)
    same("tOfVersion[" .. i .. "]", SC.tOfVersion(c.v), c.tBack)
    same("isFinalV[" .. i .. "]", SC.isFinalV(c.v), c.isFinal)
  end)
  each(V.nextT, function(i, c) same("nextT[" .. i .. "]", SC.nextT(c.t, c.tOld), c.out) end)
  each(V.compare, function(i, c)
    same("compareRecords[" .. i .. "]", safe("compareRecords", SC.compareRecords, c.a, c.b), c.out)
    same("compareRecords swapped[" .. i .. "]", SC.compareRecords(c.b, c.a), -c.out)
  end)
  each(V.keys, function(i, c)
    local fn = SC.itemKey
    if c.kind == "instance" then fn = SC.instanceKey end
    same("key[" .. i .. "] " .. c.kind, safe("key", fn, c.input), c.out)
  end)

  -- Records
  each(V.records, function(i, c)
    local where = "records[" .. i .. "] " .. c.name
    same(where .. " encode", safe("encode", SC.encode, c.input), c.record)
    local d = safe("decode", SC.decode, c.record)
    same(where .. " decode", dump(d), c.dump)
    if d then same(where .. " re-encode", SC.encode(d), c.reencode) end
    same(where .. " check", safe("check", SC.checkRecord, c.record, c.now, lookupOf(c.lookup)), c.check)
    same(where .. " parse", dump(safe("parse", SC.parse, c.record)), c.parseDump)
    same(where .. " final", d and SC.isFinal(d) or false, c.final)
  end)
  each(V.bodies, function(i, c)
    same("encodeBody[" .. i .. "] " .. c.type, safe("encodeBody", SC.encodeBody, c.type, c.key, c.fields, c.author), c.body)
  end)
  each(V.expiry, function(i, c)
    local look = lookupOf(c.lookup)
    same("expiresAt[" .. i .. "] " .. c.name, safe("expiresAt", SC.expiresAt, c.record, look), c.at)
    same("isExpired[" .. i .. "] " .. c.name, safe("isExpired", SC.isExpired, c.record, c.hour, look), c.expired)
  end)
  each(V.accept, function(i, c)
    local look = lookupOf(c.lookup)
    local got
    if c.env then
      local r = safe("acceptRecord", SC.acceptRecord, c.record, c.now, look, c.env)
      if r and r.ok then got = r.how elseif r then got = r.reason end
    else
      got = safe("checkRecord", SC.checkRecord, c.record, c.now, look) or "ok"
    end
    same("accept[" .. i .. "] " .. c.name, got, c.expect)
  end)
  each(V.caps, function(i, c)
    same("overAuthorCaps[" .. i .. "]", SC.overAuthorCaps(c.usage, c.type, c.bytes), c.over)
  end)

  -- Messages
  local M = V.messages or {}
  each(M.hello, function(i, c)
    same("encodeHello[" .. i .. "]", safe("encodeHello", SC.encodeHello, c.input), c.msg)
    same("parseHello[" .. i .. "]", dump(safe("parseHello", SC.parseHello, c.msg)), c.parsed)
  end)
  each(M.inventory, function(i, c)
    same("encodeInventory[" .. i .. "]", safe("encodeInventory", SC.encodeInventory, c.input), c.msg)
    same("parseInventory[" .. i .. "]", dump(safe("parseInventory", SC.parseInventory, c.msg)), c.parsed)
  end)
  each(M.pages, function(i, c)
    same("inventoryPages[" .. i .. "]", dump(safe("inventoryPages", SC.inventoryPages, c.bucket, c.digest, c.entries)), c.msgs)
  end)
  each(M.get, function(i, c)
    same("encodeGet[" .. i .. "]", dump(safe("encodeGet", SC.encodeGet, c.target, c.ids)), c.msgs)
    each(c.parsed, function(j, p) same("parseGet[" .. i .. "." .. j .. "]", dump(SC.parseGet(p.msg)), p.dump) end)
  end)
  each(M.pack, function(i, c)
    same("packRecords[" .. i .. "]", dump(safe("packRecords", SC.packRecords, c.records)), c.msgs)
    each(c.parsed, function(j, p) same("parseRecords[" .. i .. "." .. j .. "]", dump(SC.parseRecords(p.msg)), p.dump) end)
  end)
  each(M.split, function(i, c)
    local msgs = safe("splitRecord", SC.splitRecord, c.record, c.mid)
    same("splitRecord[" .. i .. "]", dump(msgs), c.msgs)
    local datas = {}
    for j, m in ipairs(msgs or {}) do
      local p = SC.parseParts(m)
      same("parseParts[" .. i .. "." .. j .. "]", dump(p), c.parsed[j])
      if p then datas[p.part] = p.data end
    end
    if msgs and #msgs > 0 then same("joinParts[" .. i .. "]", SC.joinParts(datas), c.record) end
  end)
  each(M.kinds, function(i, c) same("messageKind[" .. i .. "]", dump(safe("messageKind", SC.messageKind, c.msg)), c.dump) end)
  each(M.bad, function(i, c)
    local fn = SC[c.fn]
    same("bad " .. c.fn .. "[" .. i .. "]", safe(c.fn, fn, c.msg), nil)
  end)

  -- Fuzz cases (added by the test at run time): never throw, same answer as sharing.js.
  each(V.fuzz, function(i, c)
    local where = "fuzz[" .. i .. "]"
    same(where .. " check", safe(where .. " check", SC.checkRecord, c.s, c.now, nil), c.check)
    local d = safe(where .. " decode", SC.decode, c.s)
    same(where .. " decode", d ~= nil, c.decodes)
    if d then same(where .. " re-encode", SC.encode(d), c.reencode) end
    for _, fn in ipairs({ "parseHello", "parseInventory", "parseGet", "parseRecords", "parseParts", "messageKind", "unescape", "decodeIds", "fromB36" }) do
      safe(where .. " " .. fn, SC[fn], c.s)
    end
    if c.env then
      local r = safe(where .. " accept", SC.acceptRecord, c.s, c.now, nil, c.env)
      local got = r and (r.ok and r.how or r.reason)
      same(where .. " accept", got, c.accept)
    end
  end)

  return fails
end
