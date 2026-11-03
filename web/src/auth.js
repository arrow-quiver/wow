// Sessions (HMAC-signed cookie), Battle.net OAuth, and companion API tokens.
const crypto = require('crypto');

function sign(value, secret) {
  const mac = crypto.createHmac('sha256', secret).update(value).digest('base64url');
  return `${value}.${mac}`;
}

function unsign(signed, secret) {
  if (!signed || typeof signed !== 'string') return null;
  const i = signed.lastIndexOf('.');
  if (i < 1) return null;
  const value = signed.slice(0, i);
  const expected = sign(value, secret);
  const a = Buffer.from(expected);
  const b = Buffer.from(signed);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return value;
}

function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

// Session payload: "<userId>:<expiresEpoch>:<csrf>"
function makeSession(userId, secret, days = 30) {
  const exp = Math.floor(Date.now() / 1000) + days * 86400;
  const csrf = crypto.randomBytes(16).toString('base64url');
  return sign(`${userId}:${exp}:${csrf}`, secret);
}

function readSession(cookieValue, secret) {
  const v = unsign(cookieValue, secret);
  if (!v) return null;
  const [uid, exp, csrf] = v.split(':');
  if (!uid || Number(exp) < Date.now() / 1000) return null;
  return { userId: Number(uid), csrf };
}

// Companion tokens: shown once, stored as sha256.
function newApiToken() {
  const raw = 'wowg_' + crypto.randomBytes(24).toString('base64url');
  return { raw, hash: hashToken(raw), prefix: raw.slice(0, 10) };
}
function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function inviteCode() {
  return crypto.randomBytes(6).toString('base64url');
}

// --- Battle.net OAuth (authorization code flow) ---
const BNET_AUTH = 'https://oauth.battle.net/authorize';
const BNET_TOKEN = 'https://oauth.battle.net/token';
const BNET_USERINFO = 'https://oauth.battle.net/userinfo';

function bnetAuthorizeUrl(cfg, state) {
  const p = new URLSearchParams({
    client_id: cfg.bnetClientId,
    redirect_uri: `${cfg.baseUrl}/auth/bnet/callback`,
    response_type: 'code',
    scope: 'openid',
    state,
  });
  return `${BNET_AUTH}?${p}`;
}

async function bnetExchange(cfg, code) {
  const basic = Buffer.from(`${cfg.bnetClientId}:${cfg.bnetClientSecret}`).toString('base64');
  const res = await fetch(BNET_TOKEN, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: `${cfg.baseUrl}/auth/bnet/callback`,
    }),
  });
  if (!res.ok) throw new Error(`Battle.net token exchange failed (${res.status})`);
  const { access_token } = await res.json();
  const ui = await fetch(BNET_USERINFO, { headers: { Authorization: `Bearer ${access_token}` } });
  if (!ui.ok) throw new Error(`Battle.net userinfo failed (${ui.status})`);
  const info = await ui.json(); // { id, battletag }
  return { bnetId: String(info.id), battletag: info.battletag };
}

module.exports = {
  sign, unsign, parseCookies, makeSession, readSession,
  newApiToken, hashToken, inviteCode, bnetAuthorizeUrl, bnetExchange,
};
