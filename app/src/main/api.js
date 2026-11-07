'use strict';
// HTTP client for the guild server. Every server call the app makes goes through here, so the
// device token is added in one place and errors always come back as ApiError {status, message}.
// When the server's error reply is JSON, the error also carries it: err.body (the whole object),
// err.code (body.code, e.g. 'NO_GUILD_MATCH') and err.autoJoin (body.autoJoin, the guild match result
// a 409 from POST /api/sync includes).
//
//   const api = createApi({ getServer, getToken, appVersion, fetch, log });
//   await api.request('GET', '/api/me');
//   await api.request('POST', '/api/sync', payload, { timeout: 120000 });
//   await api.request('GET', '/api/releases', null, { auth: false });
//   const buf = await api.download('/updates/addon/WowGuild-0.11.1.zip');
//   api.on('unauthorized', ({ path, token }) => ...)   // a 401 for a request that carried a token
//
// Plain Node (no Electron). Uses the injected fetch (defaults to global fetch).

const { EventEmitter } = require('events');

const DEFAULT_TIMEOUT = 20000;
const DOWNLOAD_TIMEOUT = 5 * 60 * 1000;
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

// Plain-English wording for common low-level network failures.
const NETWORK_REASONS = {
  ENOTFOUND: 'address not found',
  EAI_AGAIN: 'address lookup failed',
  ECONNREFUSED: 'connection refused',
  ECONNRESET: 'connection dropped',
  ETIMEDOUT: 'connection timed out',
  EHOSTUNREACH: 'server unreachable',
  ENETUNREACH: 'no network',
  UND_ERR_CONNECT_TIMEOUT: 'connection timed out',
  UND_ERR_SOCKET: 'connection dropped',
  CERT_HAS_EXPIRED: 'its security certificate has expired',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'its security certificate is not trusted',
  SELF_SIGNED_CERT_IN_CHAIN: 'its security certificate is not trusted',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'its security certificate is not trusted',
  ERR_TLS_CERT_ALTNAME_INVALID: 'its security certificate is for a different address',
};

const STATUS_MESSAGES = {
  400: "The server didn't accept that request.",
  401: 'You are not signed in, or your sign-in has expired. Sign in again.',
  403: "You don't have permission to do that.",
  404: "The server couldn't find that.",
  409: 'That clashes with something that already exists.',
  413: 'That is too large for the server to accept.',
  429: 'Too many requests. Wait a moment and try again.',
  500: 'The guild server had a problem. Try again in a moment.',
  502: 'The guild server is not responding properly right now. Try again in a moment.',
  503: 'The guild server is busy or restarting. Try again in a moment.',
  504: 'The guild server took too long to answer. Try again in a moment.',
};

function hostOf(server) {
  try { return new URL(server).host; } catch { return String(server || 'unknown'); }
}

function networkError(err, server) {
  if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    return new ApiError(0, `The guild server took too long to answer (${hostOf(server)}). Try again in a moment.`);
  }
  const cause = (err && err.cause) || {};
  const code = cause.code || (err && err.code) || '';
  const reason = NETWORK_REASONS[code] || (code ? code : (cause.message || (err && err.message) || 'unknown error'));
  return new ApiError(0, `Can't reach the guild server (${hostOf(server)}: ${reason}). Check your internet connection and the server address in Settings.`);
}

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

function errorFromBody(status, text) {
  let message = '';
  let body = null;
  if (text) {
    try {
      const parsed = JSON.parse(text);
      if (isPlainObject(parsed)) body = parsed;
      if (body && typeof body.error === 'string') message = body.error;
      else if (body && typeof body.message === 'string') message = body.message;
    } catch {
      // Not JSON (a proxy error page, say). Don't show raw HTML to people.
    }
  }
  if (!message) message = STATUS_MESSAGES[status] || `The guild server answered with an error (${status}).`;
  const err = new ApiError(status, message.slice(0, 500));
  if (body) {
    err.body = body;
    if (typeof body.code === 'string' && /^[A-Za-z][\w-]{0,63}$/.test(body.code)) err.code = body.code;
    if (isPlainObject(body.autoJoin)) err.autoJoin = body.autoJoin;
  }
  return err;
}

function isBinary(body) {
  return Buffer.isBuffer(body) || body instanceof Uint8Array || body instanceof ArrayBuffer;
}

/**
 * @param {object} deps
 * @param {() => string} deps.getServer   base URL, e.g. https://guild.example.com
 * @param {() => string|null} deps.getToken device token (gcd_…) or null when signed out
 * @param {string} deps.appVersion         sent as X-App-Version
 * @param {typeof fetch} [deps.fetch]
 * @param {object} [deps.log]
 * @param {number} [deps.timeout=20000]
 */
function createApi({ getServer, getToken, appVersion, fetch: fetchImpl, log, timeout = DEFAULT_TIMEOUT } = {}) {
  const emitter = new EventEmitter();
  const doFetch = fetchImpl || globalThis.fetch;

  function baseUrl() {
    const server = String((getServer && getServer()) || '').trim().replace(/\/+$/, '');
    if (!server) throw new ApiError(0, 'No guild server is set. Add the server address in Settings.');
    return server;
  }

  function checkPath(p) {
    if (typeof p !== 'string' || !p.startsWith('/') || p.startsWith('//') || p.length > 4096) {
      throw new ApiError(0, `Bad server path: ${String(p).slice(0, 80)}`);
    }
  }

  async function send(method, p, body, opts, accept) {
    const verb = String(method || 'GET').toUpperCase();
    if (!METHODS.includes(verb)) throw new ApiError(0, `Unsupported request method: ${verb}`);
    checkPath(p);
    const server = baseUrl();
    const token = opts.auth === false ? null : (getToken && getToken()) || null;
    const headers = { Accept: accept, 'X-App-Version': String(appVersion || '0.0.0'), ...(opts.headers || {}) };
    if (token) headers.Authorization = `Bearer ${token}`;

    let payload;
    if (body !== undefined && body !== null && verb !== 'GET') {
      if (isBinary(body) || typeof body === 'string' || (body && typeof body.pipe === 'function')) {
        payload = body;
        if (!headers['Content-Type']) headers['Content-Type'] = opts.contentType || 'application/octet-stream';
      } else {
        payload = JSON.stringify(body);
        headers['Content-Type'] = 'application/json';
      }
    }

    const limit = Number(opts.timeout) > 0 ? Number(opts.timeout) : timeout;
    let signal = AbortSignal.timeout(limit);
    if (opts.signal) signal = AbortSignal.any([signal, opts.signal]);

    const init = { method: verb, headers, body: payload, signal };
    if (payload && typeof payload.pipe === 'function') init.duplex = 'half';

    let res;
    try {
      res = await doFetch(server + p, init);
    } catch (err) {
      const e = networkError(err, server);
      if (log) log.warn(`${verb} ${p} failed: ${e.message}`);
      throw e;
    }

    if (!res.ok) {
      let text = '';
      try { text = await res.text(); } catch { /* body lost; status is enough */ }
      const e = errorFromBody(res.status, text);
      if (res.status === 401 && token) emitter.emit('unauthorized', { path: p, token });
      if (log && res.status >= 500) log.warn(`${verb} ${p} → ${res.status}: ${e.message}`);
      throw e;
    }
    return res;
  }

  /**
   * @param {string} method GET|POST|PUT|PATCH|DELETE
   * @param {string} path   server path starting with "/" (e.g. /api/me)
   * @param {*} [body]      object → JSON; Buffer/string/stream → sent as-is (opts.contentType)
   * @param {object} [opts] { timeout, auth: false, raw: true (resolve with the response text), headers, contentType, signal }
   */
  async function request(method, path, body, opts = {}) {
    const res = await send(method, path, body, opts, opts.raw ? '*/*' : 'application/json');
    let text;
    try {
      text = await res.text();
    } catch (err) {
      throw networkError(err, baseUrl());
    }
    if (opts.raw) return text;
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      const type = res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-type') || '' : '';
      if (/json/i.test(type)) throw new ApiError(res.status, 'The guild server sent a reply Guild Camp could not read.');
      return text;
    }
  }

  /** GET a file and resolve with its bytes as a Buffer. */
  async function download(path, opts = {}) {
    const res = await send('GET', path, null, { timeout: DOWNLOAD_TIMEOUT, ...opts }, '*/*');
    try {
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      throw networkError(err, baseUrl());
    }
  }

  return Object.assign(emitter, { request, download, ApiError });
}

module.exports = { createApi, ApiError, networkError, errorFromBody };
