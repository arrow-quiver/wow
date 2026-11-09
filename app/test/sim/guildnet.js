'use strict';
// GuildNet: a guild of simulated WoW clients that talk over hidden addon messages, on one virtual clock.
//
// Every client runs the REAL addon (addon/WowGuild, loaded through its .toc by wowsim) in its own Lua state.
// The net plays the game server's part: who is online, the guild roster and ranks, GUILD and OFFICER addon
// messages with latency, loss, reordering and the game's throttle, and the SavedVariables file each account
// writes at logout. Nothing here touches a real game install or the network.
//
//   const { createGuildNet } = require('./guildnet');
//   const net = createGuildNet({ seed: 7, latencyMs: [50, 250], loss: 0.1 });
//   const a = net.client('Thrallia', { rank: 0 }).login();
//   const b = net.client('Zuljin', { rank: 3, interface: 120105 }).login();
//   a.lua('ns.Share.queue(...)');          // run Lua in A's game (ns = the addon namespace)
//   net.run(60);                           // one virtual minute: timers, deliveries and frames, in time order
//   b.logout();                            // PLAYER_LOGOUT, then the account's SavedVariables file is written
//   b.sv();                                // that file, parsed the way the app parses it
//   net.converged();                       // every online client's ns.Share.digests() equal
//
// createGuildNet(options) → net
//   seed = 1                 every random choice (latency, loss, reorder, each client's math.random) follows it
//   latencyMs = [30, 200]    one-way delay per delivery, uniform in [min, max]
//   loss = 0                 chance that one delivery (one recipient) is lost
//   reorder = 0              chance that one delivery skips the per-sender order and arrives late (extra delay
//                            up to max(latency max, 1 s)). Without it messages from one sender arrive in order.
//   throttle = { burst: 10, perSecond: 1, mode: 'drop' }  the game's limit per sender and prefix. 'drop': extra
//                            messages vanish (the send says success); 'result': the send is refused
//                            (AddonMessageThrottle, or false on a classic client). Counted in stats either way.
//   startTime = 1794066000   server time (epoch seconds) when the net starts
//   officerChatMaxRank = 1   OFFICER messages reach (and may be sent by) rank indexes up to this
//   realm = 'Forever', guild = 'wow'   defaults for clients
//   rankNames                rank index → name (default Guild Master, Officer, Veteran, Member, Initiate, ...)
//   addonDir, mocks          addon folder to load (default the real one); extra Lua run in every client before
//                            the addon loads
//   items, spells, itemsCached   game data for item and spell names (see wowsim gameData)
//   frameMs = 50             length of a virtual frame (C_Timer granularity and OnUpdate)
//   loadingSeconds = 2       loading screen length for setInstance
//   instanceLockdown = true  SendAddonMessage inside an instance or during a loading screen is refused
//                            (AddOnMessageLockdown / false); messages still reach clients inside instances
//   strictErrors = true      a Lua error handed to geterrorhandler() fails the test (uncaught errors always do)
//   log = true               keep net.log (every send attempt)
//
// net.client(name, options) → client     (options all optional)
//   rank = 3 (rank index; 0 = Guild Master), account = name (clients on one account share one SavedVariables
//   file and cannot be online together), pc = account (clients on one PC share the inbox file), realm, guild
//   (null = not in a guild), interface: 16001 | 120105 (default 16001), savedVariables (the account's file if it
//   has none yet: text, Buffer, or an object for WowGuildDB), inbox (object or Lua text: the PC's Inbox.lua),
//   classToken, raceToken, level, faction, zone, clockSkew (seconds this PC's clock is off), utcOffset (hours, this
//   PC's time zone for date(); default 0), sendResult
//   ('boolean' | 'enum', default from interface), mocks (extra Lua for this client), addonVersion
// net.member(name, { rank, classToken, level, zone, online }) a roster entry with no client (someone without the addon)
// net.setOnline(name, on)   such a member comes online or goes offline (guildmates get GUILD_ROSTER_UPDATE)
// net.run(seconds)          advance virtual time; throws on a broken message or a Lua error in any client
// net.runUntil(fn, { max = 600, step = 1 })  run in steps until fn() is true → true, or false after max seconds
// net.now()                 server time (seconds, float)
// net.clients / net.get(name) / net.online()
// net.roster                every guild member: { name, realm, guild, rankIndex, rankName, online, classToken, level,
//                           zone, client } (online from login state)
// net.stats()               { attempts, sent, delivered, bytes, dropped: { throttle, loss, offline, unregistered,
//                           officer }, refused: { throttle, instance, notInGuild }, perSender: { name: { attempts, sent,
//                           bytes, throttled, refused, delivered } }, perType: { '1H': { sent, bytes } } }
//                           sent = messages that went out on the wire (bytes counts those); throttle counts every
//                           message over the game's limit (dropped in 'drop' mode, refused in 'result' mode).
// net.resetStats()
// net.digests()             { name: ns.Share.digests() } for each online client (null when the addon has none)
// net.converged()           true when at least one client is online and all their digests are equal and non-null
// net.log                   [{ t, from, prefix, channel, type, bytes, text, status, inCombat, inInstance, loading }]
//
// client
//   login() / logout() / reload() / crash()   crash writes no SavedVariables; reload writes them and loads again
//   setInstance(on, { type, loading }) / setCombat(on)
//   lua(code)       run a chunk or expression in the game with `ns` = the addon namespace → first result (JS)
//   fire(event, ...args)
//   sv()            the account's SavedVariables file, parsed by the app's parser → WowGuildDB (null if none yet);
//                   svAll() → every variable in that file
//   svText()        that file as text; db() the live WowGuildDB of the running game
//   setInbox(obj)   the PC's Inbox.lua, as the app writes it (read at the next login or /reload); null removes it
//   setRank(n)      promotion or demotion: guildmates get GUILD_ROSTER_UPDATE
//   chat            every chat line this character printed, all sessions; chatLog [{ t, text }]
//   sounds, errors, digests(), online, wow (the running WowClient, or null)

const path = require('path');
const { WowClient, VirtualClock, toLua, makeRng, normalizeRealm, DEFAULT_RANK_NAMES } = require('./wowsim');
const { parseSavedVariables, luaAssignment } = require('../../src/shared/lua');

const CLASS_CYCLE = ['WARRIOR', 'SHAMAN', 'MAGE', 'PRIEST', 'ROGUE', 'DRUID', 'HUNTER', 'WARLOCK'];

// Equal digests regardless of table key order.
function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
}

function emptyStats() {
  return {
    attempts: 0, sent: 0, delivered: 0, bytes: 0,
    dropped: { throttle: 0, loss: 0, offline: 0, unregistered: 0, officer: 0 },
    refused: { throttle: 0, instance: 0, notInGuild: 0 },
    perSender: {}, perType: {},
  };
}

class GuildNet {
  constructor({
    seed = 1, latencyMs = [30, 200], loss = 0, reorder = 0, throttle = {}, startTime = 1794066000, officerChatMaxRank = 1,
    realm = 'Forever', guild = 'wow', rankNames = DEFAULT_RANK_NAMES, addonDir, mocks = '', items, spells, itemsCached = false,
    frameMs = 50, loadingSeconds = 2, instanceLockdown = true, strictErrors = true, log = true,
  } = {}) {
    this.seed = seed;
    this.latencyMs = [Math.min(latencyMs[0], latencyMs[1]), Math.max(latencyMs[0], latencyMs[1])];
    this.loss = loss;
    this.reorder = reorder;
    this.throttle = { burst: 10, perSecond: 1, mode: 'drop', ...throttle };
    if (!['drop', 'result'].includes(this.throttle.mode)) throw new Error(`throttle.mode must be 'drop' or 'result', not ${this.throttle.mode}`);
    this.officerChatMaxRank = officerChatMaxRank;
    this.realm = realm;
    this.guild = guild;
    this.rankNames = rankNames;
    this.addonDir = addonDir;
    this.mocks = mocks;
    this.gameData = (items || spells) ? { items: items || {}, spells: spells || {}, itemsCached } : { items: {}, spells: {}, itemsCached };
    this.loadingSeconds = loadingSeconds;
    this.instanceLockdown = instanceLockdown;
    this.strictErrors = strictErrors;
    this.keepLog = log;
    this.clock = new VirtualClock({ startTime, frameMs });
    this.rng = makeRng(`${seed}:net`);
    this.clients = [];
    this.members = [];
    this.log = [];
    this._byName = new Map();
    this._accounts = new Map();
    this._pcs = new Map();
    this._buckets = new Map();
    this._fifo = new Map();
    this._rosterVersion = 0;
    this._rosterCache = new Map();
    this._stats = emptyStats();
  }

  // ---------- people ----------
  client(name, options = {}) {
    if (this._byName.has(name)) throw new Error(`GuildNet already has a character named ${name}`);
    const c = new NetClient(this, name, { classToken: CLASS_CYCLE[this.clients.length % CLASS_CYCLE.length], ...options });
    this.clients.push(c);
    this._byName.set(name, c);
    this._rosterChanged();
    return c;
  }
  member(name, { rank = 3, classToken = 'WARRIOR', level = 60, zone = '', online = false, realm = this.realm, guild = this.guild } = {}) {
    if (this._byName.has(name)) throw new Error(`GuildNet already has a character named ${name}`);
    const m = { name, rankIndex: rank, classToken, level, zone, online, realm, guild };
    this.members.push(m);
    this._byName.set(name, m);
    this._rosterChanged();
    return m;
  }
  // A roster-only member comes online or goes offline: guildmates get the system line and GUILD_ROSTER_UPDATE.
  setOnline(name, on) {
    const m = this._byName.get(name);
    if (!m || m instanceof NetClient) throw new Error(`${name} is not a roster-only member (use client.login/logout)`);
    m.online = !!on;
    this._rosterChanged();
    this._announce(m, on ? `|Hplayer:${name}|h[${name}]|h has come online.` : `${name} has gone offline.`);
    return this;
  }
  get(name) { const c = this._byName.get(name); return c instanceof NetClient ? c : null; }
  online() { return this.clients.filter((c) => c.online); }

  get roster() {
    const out = [];
    for (const c of this.clients) {
      out.push({ name: c.name, realm: c.realm, guild: c.guild, rankIndex: c.rank, rankName: this._rankName(c.rank), online: c.online,
        classToken: c.classToken, level: c.level, zone: c.zone, client: true });
    }
    for (const m of this.members) {
      out.push({ name: m.name, realm: m.realm, guild: m.guild, rankIndex: m.rankIndex, rankName: this._rankName(m.rankIndex),
        online: m.online, classToken: m.classToken, level: m.level, zone: m.zone, client: false });
    }
    return out;
  }

  // ---------- time ----------
  now() { return this.clock.serverTime(); }
  run(seconds) { this.clock.run(seconds); return this; }
  runUntil(fn, { max = 600, step = 1 } = {}) {
    const end = this.clock.ms + max * 1000;
    while (!fn()) {
      if (this.clock.ms >= end) return false;
      this.clock.runUntilMs(Math.min(end, this.clock.ms + step * 1000));
    }
    return true;
  }

  // ---------- results ----------
  stats() { return JSON.parse(JSON.stringify(this._stats)); }
  resetStats() { this._stats = emptyStats(); this.log = []; }
  digests() {
    const out = {};
    for (const c of this.online()) out[c.name] = c.digests();
    return out;
  }
  converged() {
    const values = Object.values(this.digests());
    if (!values.length || values.some((v) => v === null || v === undefined)) return false;
    const first = canonical(values[0]);
    return values.every((v) => canonical(v) === first);
  }

  // ---------- internals ----------
  _rankName(i) { return this.rankNames[i] || `Rank ${i + 1}`; }
  _account(name) {
    let a = this._accounts.get(name);
    if (!a) { a = { name, sv: null, online: null }; this._accounts.set(name, a); }
    return a;
  }
  _pc(name) {
    let p = this._pcs.get(name);
    if (!p) { p = { name, inbox: null }; this._pcs.set(name, p); }
    return p;
  }
  _rosterChanged() { this._rosterVersion++; }
  // The roster a client of (guild, realm) sees; the same array until something changes.
  _rosterFor(guild, realm) {
    const key = `${guild}\u0000${realm}`;
    const hit = this._rosterCache.get(key);
    if (hit && hit.version === this._rosterVersion) return hit.list;
    const list = this.roster.filter((m) => m.guild === guild && m.guild != null && m.realm === realm).map((m) => ({
      name: `${m.name}-${normalizeRealm(m.realm)}`, rankIndex: m.rankIndex, rankName: m.rankName, level: m.level,
      classToken: m.classToken, zone: m.online ? m.zone : '', online: m.online,
    }));
    this._rosterCache.set(key, { version: this._rosterVersion, list });
    return list;
  }
  // Tell guildmates (online clients of the same guild) that the roster changed, like the game does.
  _announce(who, systemText) {
    for (const r of this.clients) {
      if (!r.wow || r === who || r.guild == null || r.guild !== who.guild || r.realm !== who.realm) continue;
      const wow = r.wow;
      this.clock.schedule(200, () => {
        if (r.wow !== wow || !wow.alive) return;
        if (systemText) wow._fireNow('CHAT_MSG_SYSTEM', systemText);
        wow._fireNow('GUILD_ROSTER_UPDATE', true);
      });
    }
  }
  _check() { if (this.clock.dirty) this.clock.check(); }

  _bucket(name, prefix) {
    const key = `${name}\u0000${prefix}`;
    let b = this._buckets.get(key);
    const now = this.clock.ms;
    if (!b) { b = { tokens: this.throttle.burst, at: now }; this._buckets.set(key, b); }
    b.tokens = Math.min(this.throttle.burst, b.tokens + ((now - b.at) / 1000) * this.throttle.perSecond);
    b.at = now;
    return b;
  }

  // C_ChatInfo.SendAddonMessage from a client's game. → { result } or { violation }.
  _send(client, wow, m) {
    const st = this._stats;
    const ps = st.perSender[client.name] || (st.perSender[client.name] = { attempts: 0, sent: 0, bytes: 0, throttled: 0, refused: 0, delivered: 0 });
    st.attempts++;
    ps.attempts++;
    const type = m.bytes.toString('latin1', 0, 2);
    const entry = this.keepLog ? { t: this.now(), from: client.name, prefix: m.prefix, channel: m.channel, type, bytes: m.bytes.length,
      text: m.bytes.toString('utf8'), status: 'sent', inCombat: m.inCombat, inInstance: m.inInstance, loading: m.loading } : null;
    if (entry) this.log.push(entry);
    const refuse = (why, result) => { st.refused[why]++; ps.refused++; if (entry) entry.status = `refused:${why}`; return { result }; };

    if (m.channel !== 'GUILD' && m.channel !== 'OFFICER') {
      if (entry) entry.status = 'violation';
      return { violation: `GuildNet carries only GUILD and OFFICER addon messages, not ${m.channel}` };
    }
    if (client.guild == null) return refuse('notInGuild', 'notInGuild');
    if (this.instanceLockdown && (m.inInstance || m.loading)) return refuse('instance', 'lockdown');
    const bucket = this._bucket(client.name, m.prefix);
    if (bucket.tokens < 1) {
      st.dropped.throttle++;
      ps.throttled++;
      if (this.throttle.mode === 'result') return refuse('throttle', 'throttle');
      if (entry) entry.status = 'dropped:throttle';
      return { result: 'ok' };
    }
    bucket.tokens -= 1;
    st.sent++;
    st.bytes += m.bytes.length;
    ps.sent++;
    ps.bytes += m.bytes.length;
    const pt = st.perType[type] || (st.perType[type] = { sent: 0, bytes: 0 });
    pt.sent++;
    pt.bytes += m.bytes.length;

    const officer = m.channel === 'OFFICER';
    if (officer && client.rank > this.officerChatMaxRank) {
      st.dropped.officer++;
      if (entry) entry.status = 'dropped:officer';
      return { result: 'ok' };
    }
    const sender = `${client.name}-${normalizeRealm(client.realm)}`;
    const [lo, hi] = this.latencyMs;
    for (const r of this.clients) {
      const target = r.wow;
      if (!target || r.guild !== client.guild || r.realm !== client.realm) continue;
      if (officer && r.rank > this.officerChatMaxRank) continue;
      if (this.loss > 0 && this.rng() < this.loss) { st.dropped.loss++; continue; }
      let at = this.clock.ms + Math.round(lo + this.rng() * (hi - lo));
      const key = `${client.name}\u0000${r.name}`;
      if (this.reorder > 0 && this.rng() < this.reorder) {
        at += Math.round(this.rng() * Math.max(hi, 1000));
      } else {
        at = Math.max(at, this._fifo.get(key) || 0);
        this._fifo.set(key, at);
      }
      this.clock.at(at, () => this._deliver(r, target, m, sender, client.name));
    }
    return { result: 'ok' };
  }

  _deliver(r, target, m, sender, from) {
    const st = this._stats;
    if (r.wow !== target || !target.alive) { st.dropped.offline++; return; }
    if (!target.prefixes.has(m.prefix)) { st.dropped.unregistered++; return; }
    st.delivered++;
    const ps = st.perSender[from];
    if (ps) ps.delivered++;
    target.receive(m.prefix, m.bytes, m.channel, sender, '');
  }
}

class NetClient {
  constructor(net, name, o) {
    this.net = net;
    this.name = name;
    this.rank = o.rank ?? 3;
    this.account = o.account || name;
    this.pc = o.pc || this.account;
    this.realm = o.realm || net.realm;
    this.guild = o.guild === undefined ? net.guild : o.guild;
    this.interface = o.interface || 16001;
    if (![16001, 120105].includes(this.interface)) throw new Error(`interface must be 16001 or 120105, not ${o.interface}`);
    this.classToken = o.classToken || 'WARRIOR';
    this.raceToken = o.raceToken || 'Orc';
    this.level = o.level ?? 60;
    this.faction = o.faction || 'Horde';
    this.zone = o.zone || 'Orgrimmar';
    this.clockSkew = o.clockSkew || 0;
    this.utcOffset = o.utcOffset || 0;
    this.sendResult = o.sendResult || null;
    this.mocks = o.mocks || '';
    this.addonVersion = o.addonVersion;
    this.wow = null;
    this.sessions = 0;
    this.chatLog = [];
    this.sounds = [];
    this.errors = [];
    this.svChar = null;
    this.itemCache = new Set();
    const acct = net._account(this.account);
    if (o.savedVariables != null && acct.sv == null) {
      acct.sv = typeof o.savedVariables === 'object' && !Buffer.isBuffer(o.savedVariables)
        ? Buffer.from(`\nWowGuildDB = ${toLua(o.savedVariables)}\n`, 'utf8')
        : Buffer.from(o.savedVariables);
    }
    if (o.inbox !== undefined) this.setInbox(o.inbox);
  }

  get online() { return !!this.wow; }
  get chat() { return this.chatLog.map((e) => e.text); }

  login() {
    if (this.wow) throw new Error(`${this.name} is already logged in`);
    const acct = this.net._account(this.account);
    if (acct.online) throw new Error(`${acct.online.name} is already online on account ${this.account}; log out first`);
    this._start(acct);
    this.net._rosterChanged();
    this.net._announce(this, `|Hplayer:${this.name}|h[${this.name}]|h has come online.`);
    this._run(() => this.wow.login());
    return this;
  }
  logout() {
    const wow = this._need('log out');
    this._finally(() => wow.logout(), () => { this._save(wow); this._stop(); });
    return this;
  }
  // /reload: PLAYER_LOGOUT and the SavedVariables are written, then the game loads again (still online).
  reload() {
    const wow = this._need('reload');
    const acct = this.net._account(this.account);
    this._finally(() => wow.logout(), () => {
      this._save(wow);
      wow.end();
      this.wow = null;
      acct.online = null;
      this._start(acct);
    });
    this._run(() => this.wow.login({ reload: true }));
    return this;
  }
  // The game dies: nothing is written, the character drops offline.
  crash() {
    this._need('crash');
    this._finally(() => {}, () => this._stop());
    return this;
  }
  setInstance(on, { type = 'party', loading = this.net.loadingSeconds } = {}) {
    const wow = this._need('change zone');
    this._run(() => wow.setInstance(on, { type, loading }));
    return this;
  }
  setCombat(on) {
    const wow = this._need('fight');
    this._run(() => wow.setCombat(on));
    return this;
  }
  lua(code) {
    const wow = this._need('run Lua');
    let out;
    this._run(() => { out = wow.lua(code); });
    return out;
  }
  fire(event, ...args) {
    const wow = this._need('get events');
    this._run(() => wow.fire(event, ...args));
    return this;
  }
  db() { return this._need('show its WowGuildDB').db(); }
  digests() {
    if (!this.wow) return null;
    return this.lua('local S = ns.Share; if type(S) == "table" and type(S.digests) == "function" then return S.digests() end return nil');
  }
  svText() { const a = this.net._account(this.account); return a.sv ? a.sv.toString('utf8') : null; }
  sv() {
    const all = this.svAll();
    if (!all) return null;
    const name = (this.wow && this.wow.svNames[0]) || this._svName || 'WowGuildDB';
    return all[name] ?? null;
  }
  // Every variable in the account's SavedVariables file, parsed by the app's parser (null when never written).
  svAll() {
    const a = this.net._account(this.account);
    return a.sv ? parseSavedVariables(a.sv) : null;
  }
  setInbox(obj) {
    const pc = this.net._pc(this.pc);
    pc.inbox = obj == null ? null : (typeof obj === 'string' ? obj : luaAssignment('WowGuildInbox', obj));
    return this;
  }
  setRank(n) {
    this.rank = n;
    this.net._rosterChanged();
    if (this.wow) {
      this.wow.exec(`if __player then __player.rankIndex = ${Number(n)}; __player.rankName = ${toLua(this.net._rankName(n))} end`);
      this.net._announce(this, null);
      const wow = this.wow;
      this.net.clock.schedule(200, () => { if (this.wow === wow && wow.alive) wow._fireNow('GUILD_ROSTER_UPDATE', true); });
    }
    return this;
  }

  // ---------- internals ----------
  _need(what) {
    if (!this.wow) throw new Error(`${this.name} is not logged in, so it cannot ${what}`);
    return this.wow;
  }
  // Run something in the game, then fail the test on a broken message or Lua error from any client.
  _run(fn) {
    fn();
    this.net._check();
  }
  // Like _run, but `cleanup` always happens, so the session state stays consistent when the test fails.
  _finally(fn, cleanup) {
    let err = null;
    try { fn(); } catch (e) { err = e; }
    cleanup();
    if (err) throw err;
    this.net._check();
  }
  _save(wow) {
    this.net._account(this.account).sv = wow.saveVariablesBuffer();
    this.svChar = wow.saveVariablesPerCharacterBuffer();
    this._svName = wow.svNames[0];
  }
  _start(acct) {
    const net = this.net;
    this.sessions++;
    const pc = net._pc(this.pc);
    const self = this;
    this.wow = new WowClient({
      name: this.name,
      clock: net.clock,
      transport: { send: (wow, m) => net._send(self, wow, m) },
      player: { name: this.name, realm: this.realm, classToken: this.classToken, raceToken: this.raceToken, level: this.level,
        faction: this.faction, guild: this.guild, rankIndex: this.rank, rankName: net._rankName(this.rank), zone: this.zone },
      roster: () => (this.guild == null ? [] : net._rosterFor(this.guild, this.realm)),
      rankNames: net.rankNames,
      interface: this.interface,
      sendResult: this.sendResult,
      seed: `${net.seed}:${this.sessions}`,
      gameData: { ...net.gameData, cache: this.itemCache },
      clockSkew: this.clockSkew,
      utcOffset: this.utcOffset,
      strictErrors: net.strictErrors,
      savedVariables: acct.sv || undefined,
      savedVariablesPerCharacter: this.svChar || undefined,
      inboxLua: pc.inbox || undefined,
      addonDir: net.addonDir,
      addonVersion: this.addonVersion,
      mocks: [net.mocks, this.mocks].filter(Boolean).join('\n') || undefined,
      onPrint: (text, t) => this.chatLog.push({ t, text }),
      onSound: (id, channel) => this.sounds.push({ t: net.now(), id, channel }),
    });
    // Errors stay visible on the character after its session ends.
    this.wow.errors = this.errors;
    this.wow._checked.errors = this.errors.length;
    acct.online = this;
  }
  _stop() {
    const wow = this.wow;
    const acct = this.net._account(this.account);
    wow.end();
    this.wow = null;
    acct.online = null;
    this.net._rosterChanged();
    this.net._announce(this, `${this.name} has gone offline.`);
  }
}

function createGuildNet(options) { return new GuildNet(options); }

// ---------- sharing helpers (docs/SHARING.md; used by share-*.test.js) ----------
// Records are made with the JS codec (app/src/shared/sharing.js), the twin of the addon's ShareCodec.lua.
const SJ = require('../../src/shared/sharing');

// A record string the way an addon writes it: type, key, fields, t (server seconds), author; del = tombstone.
// The version is final-band when the fields hold a final state (§4.2), like the addon's own records.
function makeRecord({ type, key, fields = {}, t, author, del = false }) {
  const base = { type, key, author, del, fields };
  const str = SJ.encode({ ...base, v: SJ.makeVersion(t, author, false) });
  if (del) return str;
  const d = SJ.decode(str);
  return d && SJ.isFinal(d) ? SJ.encode({ ...base, v: SJ.makeVersion(t, author, true) }) : str;
}

// A WowGuildDB holding a sharing store: records (strings) in the partition guildKey ("Realm/guild").
// via: who passed each record on (default "Seed", how d). extra: more WowGuildDB fields.
function sharedDb(records, { guildKey = 'Forever/wow', pid, via = 'Seed', at = 1794000000, extra = {} } = {}) {
  const recs = {};
  const vias = {};
  for (const r of records) {
    const id = r.slice(0, r.indexOf('^'));
    recs[id] = r;
    vias[id] = `${via},${at},d`;
  }
  const shared = { v: 1, guilds: { [guildKey]: { recs, via: vias, sent: {}, names: { s: {}, i: {} }, stats: {} } } };
  if (pid) shared.pid = pid;
  return { ...extra, shared };
}

// The digests string a store of these records has (what ns.Share.digests() returns).
function digestsOf(records) {
  const sum = new Array(SJ.K.BUCKETS).fill(0);
  const cnt = new Array(SJ.K.BUCKETS).fill(0);
  for (const r of records) {
    const id = r.slice(0, r.indexOf('^'));
    const v = r.split('^')[1];
    const b = SJ.bucket(id);
    if (b === null || b === undefined) continue;
    sum[b] += SJ.digestTerm(id, v);
    cnt[b]++;
  }
  return sum.map((s, b) => SJ.digestString(s, cnt[b])).join('');
}

// A realistic guild store for the §7 sizing (40 active members, about 100 characters): about 1,400 records and
// 210 KB, every §4.3 type, 13% of them over 253 bytes (sent in M parts). The same seed gives the same records.
function guildStore({ now, seed = 'store', officers = ['Grommash', 'Saurfang'], gm = 'Thrall', chars = 100 }) {
  const rng = makeRng(seed);
  const r = (n) => Math.floor(rng() * n);
  const key = () => { let k = ''; for (let i = 0; i < 6; i++) k += '0123456789abcdefghijklmnopqrstuvwxyz'[r(36)]; return k; };
  const ago = (maxDays) => now - 3600 - r(maxDays * 86400);
  const names = [];
  for (let i = 0; i < chars; i++) names.push(`Char${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}x`);
  // Two characters per player: the even one is the anchor.
  const pids = names.map((n, i) => `${names[i - (i % 2)]}.${(1000 + i - (i % 2)).toString(36).padStart(4, '0')}`);
  const out = [];
  const add = (o) => out.push(makeRecord(o));
  names.forEach((n, i) => add({ type: 'ch', key: n, t: ago(6), author: n, fields: { pid: pids[i], main: i % 2 === 0, alts: i % 2 === 0 ? [names[i + 1]] : [],
    class: 'WARRIOR', race: 'Orc', level: 60, faction: 'Horde', ilvl: 60 + r(20), repair: 90, consumables: { flask: 1, elixir: 2, potion: 5, food: 10, bandage: 20 },
    professions: [{ skill: 164, rank: 300, max: 300 }, { skill: 186, rank: 280, max: 300 }], pvp: { rank: 3, hk: 1200 }, addon: '0.12.0' } }));
  names.forEach((n) => {
    for (const skill of [164, 186]) {
      const count = skill === 164 ? 250 + r(400) : 60 + r(120);
      const ids = [];
      let id = 2000 + r(500);
      for (let k = 0; k < count; k++) { id += 1 + r(40); ids.push(id); }
      add({ type: 'rc', key: `${n}:${skill.toString(36)}`, t: ago(6), author: n, fields: { kind: 's', count, list: ids } });
    }
  });
  const raids = [];
  for (let i = 0; i < 10; i++) {
    const k = key();
    raids.push(k);
    add({ type: 'RD', key: k, t: ago(20), author: officers[i % 2], fields: { kind: 'r', title: `Raid ${i}`, instance: 'Molten Core', startsAt: now + (i - 5) * 86400,
      minutes: 180, size: 40, srLimit: 2, notes: 'Bring fire resistance gear and flasks' } });
    if (i < 5) add({ type: 'RT', key: k, t: ago(4), author: officers[0], fields: { status: 'l', lockedAt: now - 86400 } });
  }
  for (let i = 0; i < 400; i++) {
    const p = pids[(i * 2) % 100];
    add({ type: 'su', key: `${raids[Math.floor(i / 40)]}:${p}`, t: ago(10), author: p.split('.')[0], fields: { character: p.split('.')[0], role: 'thd'[r(3)],
      status: 'y', note: 'see you there', reserves: ['d72', 'eim'], reservesAt: now - 90000 } });
  }
  const reqs = [];
  for (let i = 0; i < 240; i++) {
    const k = key();
    reqs.push(k);
    const p = pids[r(chars)];
    add({ type: 'cr', key: k, t: ago(20), author: p.split('.')[0], fields: { pid: p, item: `Item number ${i}`, notes: 'I bring the mats', state: 'o' } });
  }
  for (let i = 0; i < 100; i++) {
    const p = pids[r(chars)];
    add({ type: 'cl', key: `${reqs[i]}:${p}`, t: ago(10), author: p.split('.')[0], fields: { state: 'c', claimedAt: now - 7200 } });
  }
  for (let i = 0; i < 50; i++) {
    add({ type: 'lp', key: `${pids[i]}:${names[i]}`, t: ago(2), author: names[i], fields: { character: names[i], level: 30, zone: 'Stranglethorn Vale',
      when: 'evenings', note: 'questing, happy to group' } });
  }
  for (let i = 0; i < 9; i++) {
    add({ type: 'gb', key: String(i), t: ago(10), author: names[0], fields: i === 0
      ? { scannedAt: now - 7200, money: 123456789, tabs: ['Mats', 'Gear', 'Potions'], log: Array.from({ length: 15 }, (_, k) => ({ at: now - k * 3600, kind: 'deposit', who: names[k], item: 2589, count: 20 })) }
      : { items: Array.from({ length: 40 }, (_, k) => ({ id: 2000 + k * 13, count: 1 + r(20) })) } });
  }
  for (let i = 0; i < 50; i++) {
    add({ type: 'pr', key: pids[i * 2], t: ago(5), author: pids[i * 2].split('.')[0], fields: { day: 20400, prices: Array.from({ length: 30 }, (_, k) => ({ id: 2500 + k * 7, copper: 100 + r(10000) })) } });
    add({ type: 'sh', key: pids[i * 2], t: ago(10), author: pids[i * 2].split('.')[0], fields: { items: Array.from({ length: 5 }, (_, k) => ({ name: `Reagent ${k}`, qty: 10, skill: 164 })) } });
  }
  for (let i = 0; i < 60; i++) {
    add({ type: 'LA', key: key(), t: ago(60), author: officers[i % 2], fields: { raid: raids[i % 10], instance: '2dv8n1', item: 'd72', itemName: 'Cloak of the Shrouded Mists',
      character: names[i], pid: pids[i], kind: 's', roll: 50 + r(50), bonus: 10 } });
  }
  for (let i = 0; i < 4; i++) {
    add({ type: 'LL', key: key(), t: ago(60), author: officers[0], fields: { name: `Instance ${i}`, bosses: ['Lucifron', 'Magmadar', 'Gehennas', 'Garr'],
      items: Array.from({ length: 60 }, (_, k) => ({ item: (17000 + k).toString(36), boss: 1 + (k % 4), name: `Epic item ${k}` })) } });
  }
  for (let i = 0; i < 20; i++) add({ type: 'AN', key: key(), t: ago(30), author: officers[i % 2], fields: { body: `Notice ${i}: raid times change next week, please sign up early.` } });
  const drives = [];
  for (let i = 0; i < 5; i++) {
    const k = key();
    drives.push(k);
    add({ type: 'DR', key: k, t: ago(30), author: officers[0], fields: { title: `Drive ${i}`, unit: 'Arcanite Bar', goal: 100, state: 'o' } });
  }
  for (let i = 0; i < 50; i++) add({ type: 'dc', key: key(), t: ago(20), author: names[i], fields: { pid: pids[i], drive: drives[i % 5], character: names[i], amount: 1 + r(5) } });
  for (let i = 0; i < 20; i++) {
    add({ type: 'bk', key: names[i], t: ago(10), author: names[i], fields: { bags: Array.from({ length: 60 }, (_, k) => ({ id: 2000 + k * 11, count: 1 + r(20) })),
      bank: Array.from({ length: 120 }, (_, k) => ({ id: 4000 + k * 17, count: 1 + r(200) })) } });
  }
  for (let i = 0; i < 30; i++) add({ type: 'bq', key: key(), t: ago(20), author: names[i], fields: { pid: pids[i], item: 'Major Healing Potion', count: 5, note: 'for the raid on Thursday', state: 'o' } });
  add({ type: 'CFG', key: '1', t: ago(60), author: gm, fields: { officerRankMax: 1 } });
  return out;
}

module.exports = {
  createGuildNet, GuildNet, NetClient, canonical, makeRecord, sharedDb, digestsOf, guildStore,
  ADDON_DIR: path.join(__dirname, '..', '..', '..', 'addon', 'WowGuild'),
};
