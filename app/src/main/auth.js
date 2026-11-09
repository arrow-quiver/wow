'use strict';
// Battle.net sign-in, run by the app itself (there is no Guild Camp server).
//
//   const auth = createAuth({ store, log, appVersion, credentials, openExternal });
//   auth.state()         → { available, signedIn, signingIn, battletag, region, characters, profileAt, canRefresh, error }
//   await auth.signIn()  → state, once Battle.net has sent the player back. Rejects with a plain message and a
//                          code: 'unavailable' | 'port-busy' | 'no-browser' | 'timeout' | 'cancelled' | 'bnet-error' | 'network'
//   await auth.signOut() → state (also stops a sign-in that is still waiting for the browser)
//   await auth.refresh() → state (reads the characters again with the saved token; an expired token signs out)
//   auth.cancel()        → state (stops a sign-in that is waiting for the browser)
//   auth.on('change', (state) => ...)
//
// How sign-in works (OAuth authorization code flow):
//   1. A small web server starts on 127.0.0.1:47615 (and [::1]:47615 when the PC has IPv6), only while signing in.
//   2. The system browser opens Battle.net's sign-in page (openExternal) with a random `state`.
//   3. Battle.net sends the browser back to http://localhost:47615/auth/callback?code=…&state=…
//      (the redirect URI registered at develop.battle.net). A reply whose state doesn't match is refused.
//   4. The app trades the code for an access token (HTTP Basic with the client id and secret built into the
//      installer, see credentials.js), reads the BattleTag, shows "You're signed in" in the browser and stops
//      the web server. Then it reads the player's World of Warcraft characters (at most 6 seconds).
//   It gives up after 3 minutes. Calling signIn() again starts over.
//
// What is kept:
//   - the access token, encrypted by the store: secret 'bnetToken' = JSON { accessToken, expiresAt }
//   - the BattleTag and characters: <userData>/bnet-profile.json
// Battle.net tokens last about a day and can't be renewed without the browser. The player stays signed in with
// what was read last time; refresh() with an expired token signs out and says why (state().canRefresh tells the
// UI whether a refresh can still work).
//
// Characters: [{ name, realm, realm_slug, level, class, race, faction, namespace, guild }] from the Retail
// (profile-<region>), Classic (profile-classic-<region>) and Classic Era (profile-classic1x-<region>) profiles.
// `class` is the game's token (WARRIOR, MAGE, …); `guild` is the guild name, read for the highest-level characters.
//
// Plain Node: Electron's shell.openExternal is injected, so this is tested without Electron.

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { EventEmitter } = require('events');
const { writeFileAtomic } = require('./store');

const PORT = 47615;
const CALLBACK_PATH = '/auth/callback';
// Registered at develop.battle.net for the client id built into the installer. Battle.net only sends the browser back here.
const REDIRECT_URI = `http://localhost:${PORT}${CALLBACK_PATH}`;
const SCOPE = 'openid wow.profile';
const REGIONS = ['eu', 'us', 'kr', 'tw'];
const DEFAULT_REGION = 'eu';
const TOKEN_SECRET = 'bnetToken';
const PROFILE_FILE = 'bnet-profile.json';

const SIGN_IN_TIMEOUT_MS = 3 * 60 * 1000;
const PROFILE_TIMEOUT_MS = 6000;
const HTTP_TIMEOUT_MS = 10000;
const DEFAULT_TOKEN_LIFE_MS = 24 * 60 * 60 * 1000;
// A token this close to its end counts as expired: a refresh started now would fail half-way.
const EXPIRY_SKEW_MS = 60 * 1000;
const MAX_CHARACTERS = 200;
const GUILD_LOOKUPS = 10;

// Blizzard's documented OAuth endpoints serve every region except China.
const DEFAULT_ENDPOINTS = Object.freeze({
  authorize: 'https://oauth.battle.net/authorize',
  token: 'https://oauth.battle.net/token',
  userinfo: 'https://oauth.battle.net/userinfo',
  api: (region) => `https://${region}.api.blizzard.com`,
});

const CLASS_TOKENS = {
  1: 'WARRIOR', 2: 'PALADIN', 3: 'HUNTER', 4: 'ROGUE', 5: 'PRIEST', 6: 'DEATHKNIGHT', 7: 'SHAMAN',
  8: 'MAGE', 9: 'WARLOCK', 10: 'MONK', 11: 'DRUID', 12: 'DEMONHUNTER', 13: 'EVOKER',
};

const EXPIRED_MESSAGE = 'Your Battle.net sign-in has expired. Sign in again to update your BattleTag and characters.';

const quietLog = { info() {}, warn() {}, error() {} };

// ---------------------------------------------------------------------------------------------
// Pure helpers (exported for tests)

const userError = (message, code) => Object.assign(new Error(message), code ? { code } : {});

const clip = (v, max) => String(v == null ? '' : v).replace(/[\x00-\x1f]+/g, ' ').trim().slice(0, max);

const str = (v, max) => (typeof v === 'string' || typeof v === 'number' ? String(v).trim().slice(0, max) || null : null);

const int = (v, lo, hi) => {
  if (v == null || v === '' || typeof v === 'boolean' || typeof v === 'object') return null;
  const x = Number(v);
  return Number.isFinite(x) ? Math.min(hi, Math.max(lo, Math.trunc(x))) : null;
};

// With locale=en_GB names are strings; without it Blizzard sends { en_GB: '…', … }.
const text = (v) => {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') return v.en_GB || v.en_US || Object.values(v).find((x) => typeof x === 'string') || null;
  return null;
};

const lower = (v) => String(v || '').toLocaleLowerCase('en');
const realmSlug = (v) => lower(String(v || '').trim()).replace(/['’]/g, '').replace(/\s+/g, '-');

function faction(v) {
  const x = lower(v && typeof v === 'object' ? v.type || text(v.name) : v);
  return x === 'horde' ? 'Horde' : x === 'alliance' ? 'Alliance' : null;
}

function classToken(cls) {
  if (cls && typeof cls === 'object') {
    if (CLASS_TOKENS[cls.id]) return CLASS_TOKENS[cls.id];
    cls = text(cls.name);
  }
  const t = str(cls, 30);
  return t ? t.toUpperCase().replace(/[\s_-]+/g, '') : null;
}

function normaliseRegion(v) {
  const r = lower(v).trim();
  return REGIONS.includes(r) ? r : null;
}

/** The profiles read for a region, in the order characters are listed. */
function profileNamespaces(region) {
  const r = normaliseRegion(region) || DEFAULT_REGION;
  return [
    { ns: `profile-${r}`, label: 'Retail' },
    { ns: `profile-classic-${r}`, label: 'Classic' },
    { ns: `profile-classic1x-${r}`, label: 'Classic Era' },
  ];
}

/** "profile-classic1x-eu" → "Classic Era", "profile-classic-eu" → "Classic", "profile-eu" → "Retail". */
function gameLabel(namespace) {
  const ns = lower(namespace);
  if (ns.startsWith('profile-classic1x-')) return 'Classic Era';
  if (ns.startsWith('profile-classic-')) return 'Classic';
  if (/^profile-[a-z]{2}$/.test(ns)) return 'Retail';
  return 'World of Warcraft';
}

function authorizeUrl({ authorize = DEFAULT_ENDPOINTS.authorize, clientId, redirectUri, state }) {
  const q = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: SCOPE, state });
  return `${authorize}?${q}`;
}

/**
 * One character as Guild Camp keeps it, from a Blizzard profile entry or from bnet-profile.json.
 * Returns null when it has no name or realm.
 */
function cleanCharacter(c, namespace) {
  if (!c || typeof c !== 'object') return null;
  const name = str(text(c.name), 40);
  const realmObj = c.realm && typeof c.realm === 'object' ? c.realm : null;
  const realm = str(realmObj ? text(realmObj.name) : c.realm, 60);
  const slug = str((realmObj && realmObj.slug) || c.realm_slug || realmSlug(realm), 60);
  const ns = str(namespace || c.namespace, 60);
  if (!name || !slug || !ns) return null;
  return {
    name,
    realm: realm || slug,
    realm_slug: slug,
    level: int(c.level, 0, 1000),
    class: classToken(c.playable_class || c.class),
    race: str(c.playable_race ? text(c.playable_race.name) : c.race, 40),
    faction: faction(c.faction),
    namespace: ns,
    guild: str(c.guild && typeof c.guild === 'object' ? text(c.guild.name) : c.guild, 60),
  };
}

/** Characters from one /profile/user/wow answer. */
function charactersFromProfile(data, namespace) {
  const out = [];
  for (const account of Array.isArray(data && data.wow_accounts) ? data.wow_accounts : []) {
    for (const c of Array.isArray(account && account.characters) ? account.characters : []) {
      const ch = cleanCharacter(c, namespace);
      if (ch) out.push(ch);
    }
  }
  return out;
}

// Retail, Classic, Classic Era; then highest level first; then by name.
function sortCharacters(list, region) {
  const order = profileNamespaces(region).map((p) => p.ns);
  const rank = (ns) => { const i = order.indexOf(ns); return i === -1 ? order.length : i; };
  return [...list].sort((a, b) => rank(a.namespace) - rank(b.namespace)
    || (b.level || 0) - (a.level || 0)
    || a.name.localeCompare(b.name, 'en'));
}

// Settles with whatever finished before the deadline; the rest is left behind.
function settleBy(promises, ms) {
  return new Promise((resolve) => {
    const done = new Array(promises.length).fill(undefined);
    let left = promises.length;
    let timer = null;
    const finish = () => { if (timer) clearTimeout(timer); resolve(done); };
    if (!left) { finish(); return; }
    timer = setTimeout(finish, Math.max(0, ms));
    if (timer.unref) timer.unref();
    promises.forEach((p, i) => {
      Promise.resolve(p).then((value) => ({ ok: true, value }), (error) => ({ ok: false, error })).then((r) => {
        done[i] = r;
        left -= 1;
        if (!left) finish();
      });
    });
  });
}

function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// For text between tags (the page puts nothing inside attributes).
const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

// The page the browser shows after Battle.net sends it back. Self-contained: no scripts, no outside files.
function callbackPage({ title, body, ok = false }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Guild Camp</title>
<style>
  html { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #18222e; color: #f3ead6;
    font: 17px/1.5 "Segoe UI", system-ui, sans-serif; }
  main { max-width: 440px; padding: 32px 24px; text-align: center; }
  svg { width: 64px; height: 75px; }
  h1 { margin: 16px 0 8px; font-size: 26px; line-height: 1.2; color: ${ok ? '#eaa93a' : '#f3ead6'}; }
  p { margin: 0; color: #c8bfa9; }
</style></head>
<body><main>
<svg viewBox="0 0 120 140" aria-hidden="true"><path fill="#eaa93a" d="M60 18 C75 45 92 62 86 92 C82 112 68 120 60 120 C52 120 38 112 34 92 C28 62 45 45 60 18Z"/><path fill="#ffe0a3" d="M60 52 C68 68 76 78 73 96 C71 108 65 113 60 113 C55 113 49 108 47 96 C44 78 52 68 60 52Z"/><rect fill="#8a5f3a" x="22" y="118" width="76" height="9" rx="4.5" transform="rotate(-10 60 122)"/><rect fill="#8a5f3a" x="22" y="118" width="76" height="9" rx="4.5" transform="rotate(10 60 122)"/></svg>
<h1>${esc(title)}</h1>
<p>${esc(body)}</p>
</main></body></html>
`;
}

const PAGES = {
  signedIn: (tag) => ({ ok: true, title: "You're signed in", body: `Signed in as ${tag}. Go back to Guild Camp. You can close this tab.` }),
  cancelled: { title: 'Sign-in cancelled', body: 'Nothing changed. You can close this tab and go back to Guild Camp.' },
  bnetError: { title: "Sign-in didn't work", body: "Battle.net couldn't sign you in. Go back to Guild Camp and try again." },
  failed: { title: "Sign-in didn't finish", body: "Battle.net didn't accept the sign-in. Go back to Guild Camp and try again." },
  mismatch: { title: "This sign-in doesn't match", body: "This page isn't from the sign-in Guild Camp opened. Go back to Guild Camp and press Sign in with Battle.net again." },
  over: { title: 'This sign-in is over', body: 'It already finished, timed out or was cancelled. Go back to Guild Camp to sign in again.' },
  noCode: { title: "Sign-in didn't finish", body: "Battle.net didn't send a sign-in code. Go back to Guild Camp and try again." },
  notFound: { title: 'Nothing here', body: 'This address is only used while Guild Camp signs you in to Battle.net.' },
  badHost: { title: 'Not allowed', body: 'Open this page from the Battle.net sign-in that Guild Camp started.' },
  broken: { title: 'Something went wrong', body: 'Go back to Guild Camp and try again.' },
};

// ---------------------------------------------------------------------------------------------
// Network helpers

// Turns fetch's own failures (TypeError "fetch failed", TimeoutError) into a sentence for people.
function networkError(err) {
  if (err && err.code && typeof err.message === 'string' && !(err instanceof TypeError)) return err;
  const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
  return userError(timedOut
    ? "Battle.net didn't answer in time. Check your internet connection and try again."
    : "Guild Camp couldn't reach Battle.net. Check your internet connection and try again.", 'network');
}

async function discard(res) {
  try { if (res && res.body && typeof res.body.cancel === 'function') await res.body.cancel(); } catch { /* nothing to free */ }
}

async function readJson(res) {
  try { return await res.json(); } catch { return null; }
}

// ---------------------------------------------------------------------------------------------
// Loopback server helpers

function listenOn(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (err) => reject(err);
    server.once('error', onError);
    server.listen({ port, host }, () => {
      server.off('error', onError);
      resolve();
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    let finished = false;
    const done = () => { if (!finished) { finished = true; resolve(); } };
    try {
      server.close(done);
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    } catch {
      done();
      return;
    }
    // Never hang a sign-in on a socket that won't let go.
    const t = setTimeout(done, 2000);
    if (t.unref) t.unref();
  });
}

function sendPage(res, status, page) {
  return new Promise((resolve) => {
    if (res.writableEnded || res.destroyed) { resolve(); return; }
    res.on('finish', resolve);
    res.on('close', resolve);
    const html = callbackPage(page);
    res.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(html),
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      Connection: 'close',
    });
    res.end(html);
  });
}

// ---------------------------------------------------------------------------------------------

/**
 * @param {object} deps
 * @param {object} deps.store            createStore() result: get(), on('change'), getSecret(), setSecret(), file
 * @param {object} [deps.log]
 * @param {string} [deps.appVersion]
 * @param {{clientId: string, clientSecret: string}|null} [deps.credentials]  loadBnetCredentials(); null → no sign-in
 * @param {(url: string) => Promise<void>} [deps.openExternal]  opens the system browser (shell.openExternal)
 * For tests: fetch, endpoints { authorize, token, userinfo, api(region)|'http://host/{region}' }, port, timeoutMs,
 * profileTimeoutMs, profileFile (null keeps the profile in memory only), now.
 */
function createAuth({
  store, log, appVersion, credentials, openExternal,
  fetch, endpoints, port, timeoutMs, profileTimeoutMs, profileFile, now,
} = {}) {
  if (!store || typeof store.get !== 'function' || typeof store.getSecret !== 'function') throw new TypeError('createAuth needs a store.');
  const emitter = new EventEmitter();
  const logger = log || quietLog;
  const doFetch = fetch || globalThis.fetch;
  const ep = { ...DEFAULT_ENDPOINTS, ...(endpoints || {}) };
  const clock = typeof now === 'function' ? now : Date.now;
  const listenPort = Number.isInteger(port) ? port : PORT;
  const redirectUri = `http://localhost:${listenPort}${CALLBACK_PATH}`;
  const waitMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : SIGN_IN_TIMEOUT_MS;
  const profileMs = Number(profileTimeoutMs) > 0 ? Number(profileTimeoutMs) : PROFILE_TIMEOUT_MS;
  const userAgent = `GuildCamp/${appVersion || '0.0.0'}`;
  const creds = credentials && typeof credentials.clientId === 'string' && credentials.clientId
    && typeof credentials.clientSecret === 'string' && credentials.clientSecret
    ? { clientId: credentials.clientId, clientSecret: credentials.clientSecret }
    : null;
  const file = profileFile !== undefined
    ? profileFile
    : (typeof store.file === 'string' ? path.join(path.dirname(store.file), PROFILE_FILE) : null);
  const allowedHosts = new Set([`localhost:${listenPort}`, `127.0.0.1:${listenPort}`, `[::1]:${listenPort}`]);
  const apiBase = (region) => (typeof ep.api === 'function' ? ep.api(region) : String(ep.api).replace('{region}', region)).replace(/\/+$/, '');

  let pending = null; // the sign-in waiting for the browser
  let refreshing = null;
  let error = null;
  let lastEmitted = null;
  // Changes whenever the kept sign-in changes, so a refresh that started before it doesn't write old data.
  let epoch = 0;
  let profile = loadProfile();

  // ---- what is kept ------------------------------------------------------------------------

  function readToken() {
    let raw = null;
    try { raw = store.getSecret(TOKEN_SECRET); } catch { raw = null; }
    if (!raw) return null;
    try {
      const t = JSON.parse(raw);
      if (t && typeof t.accessToken === 'string' && t.accessToken) {
        return { accessToken: t.accessToken, expiresAt: Number.isFinite(Number(t.expiresAt)) && Number(t.expiresAt) > 0 ? Number(t.expiresAt) : null };
      }
    } catch { /* not JSON */ }
    return null;
  }

  const isExpired = (token) => Boolean(token && token.expiresAt && token.expiresAt - EXPIRY_SKEW_MS <= clock());

  function loadProfile() {
    if (!file) return null;
    if (!readToken()) {
      // No token (signed out, or it can't be decrypted on this PC): what was read with it goes too.
      removeProfileFile();
      return null;
    }
    let data;
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    } catch (err) {
      if (err.code !== 'ENOENT') logger.warn(`Couldn't read your saved Battle.net profile (${err.message}). Sign in again to see it.`);
      return null;
    }
    const battletag = data && str(data.battletag, 64);
    if (!battletag) return null;
    const region = normaliseRegion(data.region) || DEFAULT_REGION;
    const characters = (Array.isArray(data.characters) ? data.characters : []).map((c) => cleanCharacter(c)).filter(Boolean).slice(0, MAX_CHARACTERS);
    return {
      battletag,
      accountId: str(data.accountId, 40),
      region,
      characters: sortCharacters(characters, region),
      profileAt: str(data.profileAt, 40),
    };
  }

  function saveProfile() {
    if (!file || !profile) return;
    try {
      writeFileAtomic(file, `${JSON.stringify({ version: 1, ...profile }, null, 2)}\n`);
    } catch (err) {
      logger.warn(`Couldn't save your Battle.net characters (${err.message}). They are kept until Guild Camp closes.`);
    }
  }

  function removeProfileFile() {
    if (!file) return;
    try { fs.rmSync(file, { force: true }); } catch (err) { logger.warn(`Couldn't remove the saved Battle.net profile (${err.message}).`); }
  }

  function currentRegion() {
    let settings = null;
    try { settings = store.get(); } catch { settings = null; }
    return normaliseRegion(settings && settings.bnetRegion) || DEFAULT_REGION;
  }

  // ---- state ---------------------------------------------------------------------------------

  function state() {
    const token = profile ? readToken() : null;
    const signedIn = Boolean(profile && token);
    return {
      available: Boolean(creds),
      signedIn,
      signingIn: Boolean(pending),
      battletag: signedIn ? profile.battletag : null,
      region: signedIn ? profile.region : currentRegion(),
      characters: signedIn ? profile.characters.map((c) => ({ ...c })) : [],
      profileAt: signedIn ? profile.profileAt : null,
      canRefresh: signedIn && !isExpired(token),
      error,
    };
  }

  function emitIfChanged() {
    const s = state();
    const key = JSON.stringify(s);
    if (key !== lastEmitted) {
      lastEmitted = key;
      emitter.emit('change', s);
    }
    return s;
  }

  function forget(reason) {
    epoch += 1;
    try { store.setSecret(TOKEN_SECRET, null); } catch (err) { logger.warn(`Couldn't remove the Battle.net token (${err.message}).`); }
    profile = null;
    removeProfileFile();
    error = reason || null;
    return emitIfChanged();
  }

  // ---- Battle.net calls ----------------------------------------------------------------------

  async function exchangeCode(code) {
    const basic = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64');
    let res;
    try {
      res = await doFetch(ep.token, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basic}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
          'User-Agent': userAgent,
        },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }).toString(),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
    } catch (err) {
      throw networkError(err);
    }
    const data = await readJson(res);
    if (!res.ok) {
      const detail = clip(data && (data.error_description || data.error), 160);
      throw userError(`Battle.net didn't accept the sign-in (${res.status}${detail ? `: ${detail}` : ''}). Try again.`, 'bnet-error');
    }
    const accessToken = data && typeof data.access_token === 'string' ? data.access_token : '';
    if (!accessToken) throw userError("Battle.net didn't send a sign-in token. Try again.", 'bnet-error');
    const seconds = Number(data.expires_in);
    return { accessToken, expiresAt: clock() + (Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_TOKEN_LIFE_MS) };
  }

  async function readUserInfo(accessToken, ms = HTTP_TIMEOUT_MS) {
    let res;
    try {
      res = await doFetch(ep.userinfo, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', 'User-Agent': userAgent },
        signal: AbortSignal.timeout(ms),
      });
    } catch (err) {
      throw networkError(err);
    }
    if (res.status === 401) {
      await discard(res);
      throw userError(EXPIRED_MESSAGE, 'expired');
    }
    const data = await readJson(res);
    if (!res.ok) throw userError(`Battle.net couldn't tell Guild Camp your BattleTag (${res.status}). Try again.`, 'bnet-error');
    const battletag = data && str(data.battletag, 64);
    if (!battletag) throw userError("Battle.net didn't send your BattleTag. Try again.", 'bnet-error');
    return { battletag, accountId: str(data.id != null ? data.id : data.sub, 40) };
  }

  /**
   * The player's characters in every profile of the region, plus the guild of the highest-level ones.
   * Never throws. Everything is cut off after profileMs; a profile that answers 404 or 403 has no characters.
   * → { ok (at least one profile answered), unauthorized (the token was refused), late (nothing answered in time), characters }
   */
  async function readCharacters(accessToken, region) {
    const base = apiBase(region);
    const deadline = Date.now() + profileMs;
    const left = () => Math.max(1, deadline - Date.now());
    let unauthorized = false;
    const get = async (pathname, ns) => {
      const res = await doFetch(`${base}${pathname}?namespace=${encodeURIComponent(ns)}&locale=en_GB`, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', 'User-Agent': userAgent },
        signal: AbortSignal.timeout(left()),
      });
      if (res.status === 404 || res.status === 403) { await discard(res); return null; }
      if (res.status === 401) { unauthorized = true; await discard(res); throw userError('refused', 'expired'); }
      if (!res.ok) { await discard(res); throw new Error(`HTTP ${res.status}`); }
      return res.json();
    };

    const spaces = profileNamespaces(region);
    const answers = await settleBy(spaces.map((sp) => get('/profile/user/wow', sp.ns)), left());
    const seen = new Set();
    let characters = [];
    let answered = 0;
    let late = 0;
    answers.forEach((a, i) => {
      if (!a || (!a.ok && a.error && ['TimeoutError', 'AbortError'].includes(a.error.name))) { late += 1; return; }
      if (!a.ok) return;
      answered += 1;
      for (const c of charactersFromProfile(a.value, spaces[i].ns)) {
        const key = `${c.namespace}|${c.realm_slug}|${lower(c.name)}`;
        if (seen.has(key) || characters.length >= MAX_CHARACTERS) continue;
        seen.add(key);
        characters.push(c);
      }
    });

    // The guild of the highest-level characters (the account profile doesn't say).
    const picks = [...characters].sort((a, b) => (b.level || 0) - (a.level || 0)).slice(0, GUILD_LOOKUPS);
    if (picks.length && !unauthorized && Date.now() < deadline) {
      const sums = await settleBy(picks.map((c) => get(
        `/profile/wow/character/${encodeURIComponent(c.realm_slug)}/${encodeURIComponent(lower(c.name))}`, c.namespace,
      )), left());
      sums.forEach((r, i) => {
        if (!r || !r.ok || !r.value) return;
        const g = r.value.guild;
        picks[i].guild = str(g && typeof g === 'object' ? text(g.name) : null, 60);
        if (!picks[i].faction) picks[i].faction = faction(r.value.faction);
        if (!picks[i].race && r.value.race) picks[i].race = str(text(r.value.race.name), 40);
      });
    }
    characters = sortCharacters(characters, region);

    return { ok: answered > 0 && !unauthorized, unauthorized, late: late > 0 && !answered, characters };
  }

  // Why the character list didn't load, for state().error.
  function charactersNote(chars, { signingIn = false } = {}) {
    if (chars.ok || chars.unauthorized) return null;
    if (signingIn) {
      return chars.late
        ? "You're signed in, but Battle.net didn't send your characters in time. Try Refresh in Settings later."
        : "You're signed in, but Battle.net had a problem sending your characters. Try Refresh in Settings later.";
    }
    return chars.late
      ? "Battle.net didn't send your characters in time. Your list is as it was. Try again later."
      : 'Battle.net had a problem sending your characters. Your list is as it was. Try again later.';
  }

  // ---- sign-in -------------------------------------------------------------------------------

  // Ends a sign-in: stops its web server and settles its promise (with the state after it, or err).
  // `quiet` leaves state().error alone (the player cancelled it themselves).
  function finishFlow(flow, err, { quiet = false } = {}) {
    if (flow.done) return flow.closing;
    flow.done = true;
    clearTimeout(flow.timer);
    flow.closing = Promise.all(flow.servers.map(closeServer)).then(() => {});
    if (pending === flow) pending = null;
    if (err && !quiet) error = err.message;
    const s = emitIfChanged();
    if (err) {
      if (!quiet) logger.warn(`Battle.net sign-in stopped: ${err.message}`);
      flow.reject(err);
    } else {
      flow.resolve(s);
    }
    return flow.closing;
  }

  function stopPending(err, opts) {
    const flow = pending;
    if (!flow) return Promise.resolve();
    return finishFlow(flow, err, opts) || Promise.resolve();
  }

  async function handleRequest(flow, req, res) {
    let url;
    try { url = new URL(req.url || '/', `http://localhost:${listenPort}`); } catch { await sendPage(res, 400, PAGES.notFound); return; }
    if (url.pathname !== CALLBACK_PATH) { await sendPage(res, 404, PAGES.notFound); return; }
    if (req.method !== 'GET') { await sendPage(res, 405, PAGES.notFound); return; }
    // Battle.net sends the browser to localhost. Anything else is a page trying to reach this server.
    if (!allowedHosts.has(lower(req.headers.host))) { await sendPage(res, 400, PAGES.badHost); return; }
    if (flow.done || flow.handled) { await sendPage(res, 410, PAGES.over); return; }

    const q = url.searchParams;
    if (!sameSecret(q.get('state') || '', flow.state)) {
      // An old tab, or something that isn't Battle.net. Refuse it; the real reply can still arrive.
      logger.warn('Refused a Battle.net reply that did not belong to this sign-in.');
      await sendPage(res, 400, PAGES.mismatch);
      return;
    }

    const bnetError = q.get('error');
    if (bnetError) {
      flow.handled = true;
      const cancelled = bnetError === 'access_denied';
      await sendPage(res, 200, cancelled ? PAGES.cancelled : PAGES.bnetError);
      const detail = clip(q.get('error_description') || bnetError, 160);
      finishFlow(flow, cancelled
        ? userError('You cancelled the Battle.net sign-in.', 'cancelled')
        : userError(`Battle.net couldn't sign you in (${detail}). Try again.`, 'bnet-error'), { quiet: cancelled });
      return;
    }

    const code = q.get('code');
    if (!code || code.length > 4096) { await sendPage(res, 400, PAGES.noCode); return; }
    flow.handled = true;
    clearTimeout(flow.timer); // the browser is back; the calls below have their own time limits

    let token;
    let who;
    try {
      token = await exchangeCode(code);
      who = await readUserInfo(token.accessToken);
    } catch (err) {
      await sendPage(res, 502, PAGES.failed);
      finishFlow(flow, err);
      return;
    }
    if (flow.done) { await sendPage(res, 410, PAGES.over); return; } // cancelled while Battle.net answered

    await sendPage(res, 200, PAGES.signedIn(who.battletag));
    // Done with the browser: stop listening now, while the characters load.
    Promise.all(flow.servers.map(closeServer)).catch(() => {});

    const chars = await readCharacters(token.accessToken, flow.region);
    if (flow.done) return; // signed out or started over while the characters loaded

    try {
      store.setSecret(TOKEN_SECRET, JSON.stringify(token));
    } catch (err) {
      finishFlow(flow, userError(`Guild Camp couldn't save your sign-in (${err.message}).`, 'save-failed'));
      return;
    }
    epoch += 1;
    profile = {
      battletag: who.battletag,
      accountId: who.accountId,
      region: flow.region,
      characters: chars.ok ? chars.characters : [],
      profileAt: chars.ok ? new Date(clock()).toISOString() : null,
    };
    saveProfile();
    error = charactersNote(chars, { signingIn: true });
    logger.info(chars.ok
      ? `Signed in to Battle.net. Found ${chars.characters.length} character${chars.characters.length === 1 ? '' : 's'}.`
      : "Signed in to Battle.net. The character list didn't load.");
    finishFlow(flow, null);
  }

  async function signIn() {
    if (!creds) {
      throw userError("Battle.net sign-in isn't part of this copy of Guild Camp. Everything else works without it.", 'unavailable');
    }
    if (typeof openExternal !== 'function') throw userError("Guild Camp can't open your web browser for Battle.net.", 'no-browser');
    // Pressing the button again starts over: the old sign-in stops and its port is freed first.
    if (pending) await stopPending(userError('Sign-in started again.', 'cancelled'), { quiet: true });

    let resolveFn;
    let rejectFn;
    const promise = new Promise((resolve, reject) => { resolveFn = resolve; rejectFn = reject; });
    const flow = {
      state: crypto.randomBytes(24).toString('base64url'),
      region: currentRegion(),
      servers: [],
      timer: null,
      handled: false,
      done: false,
      closing: null,
      resolve: resolveFn,
      reject: rejectFn,
    };
    const handler = (req, res) => {
      handleRequest(flow, req, res).catch(async (err) => {
        logger.warn(`Battle.net sign-in page failed: ${err.message}`);
        await sendPage(res, 500, PAGES.broken).catch(() => {});
      });
    };

    // 1. The web server Battle.net sends the browser back to.
    const v4 = http.createServer(handler);
    try {
      await listenOn(v4, listenPort, '127.0.0.1');
    } catch (err) {
      throw portFailed(err);
    }
    flow.servers.push(v4);
    // Browsers may try [::1] first for "localhost". Listen there too when the PC has IPv6, so the reply can't
    // land on another program.
    const v6 = http.createServer(handler);
    try {
      await listenOn(v6, listenPort, '::1');
      flow.servers.push(v6);
    } catch (err) {
      if (err && err.code === 'EADDRINUSE') {
        await closeServer(v4);
        throw portFailed(err);
      }
      // No IPv6 on this PC: 127.0.0.1 is enough.
    }

    error = null;
    pending = flow;
    flow.timer = setTimeout(() => {
      finishFlow(flow, userError("Battle.net sign-in took too long, so Guild Camp stopped waiting. Press Sign in with Battle.net to try again.", 'timeout'));
    }, waitMs);
    emitIfChanged();

    // 2. The browser.
    const url = authorizeUrl({ authorize: ep.authorize, clientId: creds.clientId, redirectUri, state: flow.state });
    logger.info('Opened Battle.net sign-in in your web browser.');
    try {
      await openExternal(url);
    } catch (err) {
      finishFlow(flow, userError(`Guild Camp couldn't open your web browser (${clip(err && err.message, 120) || 'unknown problem'}).`, 'no-browser'));
    }
    return promise;
  }

  // The port Battle.net sends the browser back to can't be used. Said in state().error too.
  function portFailed(err) {
    const out = err && (err.code === 'EADDRINUSE' || err.code === 'EACCES')
      ? userError(`Guild Camp needs port ${listenPort} on this PC to finish signing in, but another program is using it. `
        + 'Close other copies of Guild Camp (or the program using that port) and try again.', 'port-busy')
      : userError(`Guild Camp couldn't get ready for Battle.net sign-in (${clip(err && err.message, 120)}).`, 'port-busy');
    error = out.message;
    logger.warn(`Battle.net sign-in couldn't start: ${out.message}`);
    emitIfChanged();
    return out;
  }

  async function cancel() {
    await stopPending(userError('Sign-in was cancelled.', 'cancelled'), { quiet: true });
    return emitIfChanged();
  }

  async function signOut() {
    await stopPending(userError('Sign-in was cancelled.', 'cancelled'), { quiet: true });
    const had = Boolean(profile || readToken());
    forget(null);
    if (had) logger.info('Signed out of Battle.net. Guild Camp forgot your BattleTag and characters.');
    return state();
  }

  // ---- refresh -------------------------------------------------------------------------------

  async function refresh() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const token = readToken();
      if (!profile || !token) return emitIfChanged();
      if (isExpired(token)) {
        logger.info('The Battle.net sign-in has expired. Signed out.');
        return forget(EXPIRED_MESSAGE);
      }
      const startedAt = epoch;
      const region = currentRegion();
      const [who, chars] = await Promise.all([
        readUserInfo(token.accessToken, profileMs).catch((err) => err),
        readCharacters(token.accessToken, region),
      ]);
      if (startedAt !== epoch || !profile) return state(); // signed out or in again meanwhile
      if ((who instanceof Error && who.code === 'expired') || chars.unauthorized) {
        logger.info('Battle.net no longer accepts the saved sign-in. Signed out.');
        return forget(EXPIRED_MESSAGE);
      }
      const next = { ...profile };
      if (!(who instanceof Error) && who.battletag) next.battletag = who.battletag;
      if (chars.ok) {
        next.region = region;
        next.characters = chars.characters;
        next.profileAt = new Date(clock()).toISOString();
        error = null;
      } else {
        error = who instanceof Error && who.code === 'network'
          ? `${who.message} Your list is as it was.`
          : charactersNote(chars);
      }
      profile = next;
      saveProfile();
      return emitIfChanged();
    })();
    try {
      return await refreshing;
    } finally {
      refreshing = null;
    }
  }

  // A new region in Settings: read the characters there, when the saved sign-in still works.
  if (typeof store.on === 'function') {
    store.on('change', (_settings, keys) => {
      if (!Array.isArray(keys) || !keys.includes('bnetRegion')) return;
      const s = state();
      if (s.signedIn && s.canRefresh && profile && profile.region !== currentRegion()) {
        refresh().catch((err) => logger.warn(`Couldn't read your characters in the new region: ${err.message}`));
      } else {
        emitIfChanged();
      }
    });
  }

  lastEmitted = JSON.stringify(state());
  return Object.assign(emitter, { state, signIn, signOut, refresh, cancel });
}

// Legacy: main.js (server version) still sets permissions on this partition until it is rewritten.
// The sign-in no longer uses an embedded window.
const AUTH_PARTITION = 'persist:auth';

module.exports = {
  createAuth,
  authorizeUrl,
  profileNamespaces,
  gameLabel,
  cleanCharacter,
  charactersFromProfile,
  sortCharacters,
  callbackPage,
  PORT,
  CALLBACK_PATH,
  REDIRECT_URI,
  SCOPE,
  REGIONS,
  DEFAULT_REGION,
  TOKEN_SECRET,
  PROFILE_FILE,
  EXPIRED_MESSAGE,
  DEFAULT_ENDPOINTS,
  AUTH_PARTITION,
};
