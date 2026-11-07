// Device tokens, invite codes, the signed Battle.net sign-in state, and the Battle.net
// OAuth calls (authorization code flow).
//
// Tokens are shown to the client once and stored only as a sha256 hash.
//   gcd_…   device token, one per signed-in Guild Camp app (devices table)
//   wowg_…  legacy sync key from the old companion (api_tokens table), accepted on sync paths only
const crypto = require('crypto');

const DEVICE_PREFIX = 'gcd_';
const LEGACY_PREFIX = 'wowg_';
const STATE_TTL_MS = 10 * 60 * 1000;

function hashToken(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

// A new device token. `raw` goes to the app once; `hash` and `prefix` are stored.
function newDeviceToken() {
  const raw = DEVICE_PREFIX + crypto.randomBytes(32).toString('base64url');
  return { raw, hash: hashToken(raw), prefix: raw.slice(0, 12) };
}

// 'device' | 'legacy' | null, from the token's prefix and shape.
function tokenKind(raw) {
  if (typeof raw !== 'string' || raw.length > 200 || !/^[\w-]+$/.test(raw)) return null;
  if (raw.startsWith(DEVICE_PREFIX)) return 'device';
  if (raw.startsWith(LEGACY_PREFIX)) return 'legacy';
  return null;
}

// Hash used to look up a legacy wowg_ sync key in api_tokens (same scheme as the old site).
const legacyTokenHash = hashToken;

function inviteCode() {
  return crypto.randomBytes(6).toString('base64url');
}

// Constant-time string comparison (hashes both sides first, so different lengths are safe too).
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const x = crypto.createHash('sha256').update(a).digest();
  const y = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(x, y);
}

function mac(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

// --- Battle.net sign-in state ---
// The state carries the device details from GET /auth/bnet through Battle.net and back,
// signed with SESSION_SECRET so nobody can forge or alter it. Format: <base64url JSON>.<hmac>
// Payload: { nonce, device: { name, platform, appVersion }, exp }.
function signState(cfg, device, now = Date.now()) {
  const payload = {
    nonce: crypto.randomBytes(16).toString('base64url'),
    device: {
      name: device && device.name ? String(device.name) : null,
      platform: device && device.platform ? String(device.platform) : null,
      appVersion: device && device.appVersion ? String(device.appVersion) : null,
    },
    exp: now + STATE_TTL_MS,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return { state: `${body}.${mac(body, cfg.sessionSecret)}`, nonce: payload.nonce };
}

// The payload, or null when the state is missing, altered or older than 10 minutes.
function readState(cfg, state, now = Date.now()) {
  if (typeof state !== 'string' || state.length > 2000) return null;
  const i = state.lastIndexOf('.');
  if (i < 1) return null;
  const body = state.slice(0, i);
  const expected = Buffer.from(mac(body, cfg.sessionSecret));
  const given = Buffer.from(state.slice(i + 1));
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
  if (!payload || typeof payload !== 'object' || typeof payload.exp !== 'number' || payload.exp < now) return null;
  return payload;
}

// --- Battle.net OAuth ---
const BNET_AUTH = 'https://oauth.battle.net/authorize';
const BNET_TOKEN = 'https://oauth.battle.net/token';
const BNET_USERINFO = 'https://oauth.battle.net/userinfo';
// wow.profile lets the server read the player's WoW characters once, at sign-in, to find their guild.
const BNET_SCOPE = 'openid wow.profile';

function bnetEnabled(cfg) {
  return Boolean(cfg.bnetClientId && cfg.bnetClientSecret);
}

function bnetAuthorizeUrl(cfg, state) {
  const p = new URLSearchParams({
    client_id: cfg.bnetClientId,
    redirect_uri: `${cfg.baseUrl}/auth/bnet/callback`,
    response_type: 'code',
    scope: BNET_SCOPE,
    state,
  });
  return `${BNET_AUTH}?${p}`;
}

// Trades the callback's code for the player's Battle.net id, BattleTag and access token.
// The access token (wow.profile) is used once, right away, to read the player's WoW characters
// (services/membership.js refreshBnetProfile). It is never stored.
async function bnetExchange(cfg, code, fetchImpl = cfg.fetch || globalThis.fetch) {
  const basic = Buffer.from(`${cfg.bnetClientId}:${cfg.bnetClientSecret}`).toString('base64');
  const res = await fetchImpl(BNET_TOKEN, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: `${cfg.baseUrl}/auth/bnet/callback`,
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Battle.net token exchange failed (${res.status})`);
  const { access_token: accessToken } = await res.json();
  if (!accessToken) throw new Error('Battle.net sent no access token');
  const ui = await fetchImpl(BNET_USERINFO, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(10000) });
  if (!ui.ok) throw new Error(`Battle.net userinfo failed (${ui.status})`);
  const info = await ui.json(); // { id, battletag }
  if (!info || info.id == null || !info.battletag) throw new Error('Battle.net sent no BattleTag');
  return { bnetId: String(info.id), battletag: String(info.battletag).slice(0, 40), accessToken: String(accessToken) };
}

module.exports = {
  DEVICE_PREFIX, LEGACY_PREFIX, STATE_TTL_MS, BNET_SCOPE,
  hashToken, newDeviceToken, tokenKind, legacyTokenHash, inviteCode, safeEqual,
  signState, readState, bnetEnabled, bnetAuthorizeUrl, bnetExchange,
};
