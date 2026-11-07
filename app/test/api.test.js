'use strict';
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApi, ApiError } = require('../src/main/api');
const { createAuth } = require('../src/main/auth');
const { createStore } = require('../src/main/store');

let server;
let base;
const seen = [];
const validTokens = new Map(); // token → battletag

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      const send = (status, data, type = 'application/json') => {
        res.writeHead(status, { 'Content-Type': type });
        res.end(typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data));
      };
      switch (req.url.split('?')[0]) {
        case '/api/echo': return send(200, { method: req.method, auth: req.headers.authorization || null, version: req.headers['x-app-version'], accept: req.headers.accept, type: req.headers['content-type'] || null, body: body ? JSON.parse(body) : null });
        case '/api/empty': res.writeHead(204); return res.end();
        case '/api/text': return send(200, 'plain words', 'text/plain');
        case '/api/bad-json': return send(200, '{nope', 'application/json');
        case '/api/forbidden': return send(403, { error: 'Only officers can do that.' });
        case '/api/no-guild': return send(409, { error: 'None of your characters are in Just Now WoW yet.', code: 'NO_GUILD_MATCH', autoJoin: { status: 'no-match', reason: 'None of your characters are in Just Now WoW yet.', detected: null }, retryAfter: 60 });
        case '/api/odd-error': return send(400, ['not', 'an', 'object']);
        case '/api/unauthorized': return send(401, { error: 'Sign in again.' });
        case '/api/html-error': return send(502, '<html><body>Bad gateway</body></html>', 'text/html');
        case '/api/slow': return setTimeout(() => send(200, { ok: true }), 400);
        case '/updates/file.bin': return send(200, Buffer.from([1, 2, 3, 255]), 'application/octet-stream');
        case '/api/raw': return send(200, Buffer.from(body, 'latin1').length.toString(), 'text/plain');
        // Minimal auth endpoints for the auth service tests below.
        case '/api/me': {
          const token = (req.headers.authorization || '').replace('Bearer ', '');
          if (!validTokens.has(token)) return send(401, { error: 'Sign in again.' });
          return send(200, { user: { id: 1, battletag: validTokens.get(token) }, guild: { id: 1, name: 'Forever Camp' }, role: 'owner', device: { id: 3 }, notifyPrefs: { raids: true } });
        }
        case '/api/auth/dev': {
          const { battletag } = JSON.parse(body || '{}');
          if (!battletag) return send(400, { error: 'BattleTag needed.' });
          const token = `gcd_dev${validTokens.size}xxxxxxxxxxxx`;
          validTokens.set(token, battletag);
          return send(200, { token, user: { battletag } });
        }
        case '/api/auth/signout': {
          validTokens.delete((req.headers.authorization || '').replace('Bearer ', ''));
          return send(200, { ok: true });
        }
        default: return send(404, { error: 'No such thing.' });
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

function makeApi(overrides = {}) {
  let token = overrides.token === undefined ? 'gcd_testtoken123456' : overrides.token;
  const api = createApi({
    getServer: () => (overrides.server !== undefined ? overrides.server : `${base}/`),
    getToken: () => token,
    appVersion: '0.11.0',
    ...overrides.opts,
  });
  api.setToken = (t) => { token = t; };
  return api;
}

describe('request', () => {
  test('sends the device token, app version and JSON headers', async () => {
    const api = makeApi();
    const res = await api.request('post', '/api/echo', { hello: 'world' });
    assert.deepEqual(res, {
      method: 'POST',
      auth: 'Bearer gcd_testtoken123456',
      version: '0.11.0',
      accept: 'application/json',
      type: 'application/json',
      body: { hello: 'world' },
    });
  });

  test('no Authorization header when signed out or with auth: false', async () => {
    assert.equal((await makeApi({ token: null }).request('GET', '/api/echo')).auth, null);
    assert.equal((await makeApi().request('GET', '/api/echo', null, { auth: false })).auth, null);
  });

  test('GET never sends a body', async () => {
    const res = await makeApi().request('GET', '/api/echo', { ignored: true });
    assert.equal(res.body, null);
  });

  test('empty replies resolve to null, text replies to the text', async () => {
    const api = makeApi();
    assert.equal(await api.request('DELETE', '/api/empty'), null);
    assert.equal(await api.request('GET', '/api/text'), 'plain words');
    assert.equal(await api.request('GET', '/api/echo', null, { raw: true }).then((t) => typeof t), 'string');
  });

  test('a JSON reply that cannot be parsed is an ApiError', async () => {
    await assert.rejects(makeApi().request('GET', '/api/bad-json'), (err) => err instanceof ApiError && /could not read/.test(err.message));
  });

  test('Buffer bodies are sent as raw bytes', async () => {
    const res = await makeApi().request('PUT', '/api/raw', Buffer.from([0, 1, 2, 3, 4]), { contentType: 'application/zip' });
    assert.equal(res, 5);
    assert.equal(seen.at(-1).headers['content-type'], 'application/zip');
  });

  test('JSON {error} bodies become ApiError(status, error)', async () => {
    await assert.rejects(makeApi().request('POST', '/api/forbidden', {}), (err) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.status, 403);
      assert.equal(err.message, 'Only officers can do that.');
      return true;
    });
    await assert.rejects(makeApi().request('GET', '/api/missing'), { status: 404, message: 'No such thing.' });
  });

  test("JSON error replies keep the server's code, autoJoin result and other fields (err.body)", async () => {
    await assert.rejects(makeApi().request('POST', '/api/no-guild', {}), (err) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.status, 409);
      assert.equal(err.message, 'None of your characters are in Just Now WoW yet.');
      assert.equal(err.code, 'NO_GUILD_MATCH');
      assert.deepEqual(err.autoJoin, { status: 'no-match', reason: 'None of your characters are in Just Now WoW yet.', detected: null });
      assert.equal(err.body.retryAfter, 60);
      return true;
    });
    // A plain { error } reply has no code; odd shapes never break the error.
    await assert.rejects(makeApi().request('POST', '/api/forbidden', {}), (err) => err.code === undefined && err.autoJoin === undefined && err.body.error === 'Only officers can do that.');
    await assert.rejects(makeApi().request('GET', '/api/odd-error'), (err) => err.status === 400 && err.body === undefined && err.code === undefined);
    await assert.rejects(makeApi().request('GET', '/api/html-error'), (err) => err.body === undefined);
  });

  test('non-JSON error pages get a plain message instead of HTML', async () => {
    await assert.rejects(makeApi().request('GET', '/api/html-error'), (err) => {
      assert.equal(err.status, 502);
      assert.ok(!err.message.includes('<html>'));
      assert.match(err.message, /not responding properly/);
      return true;
    });
  });

  test("401 with a token emits 'unauthorized' with that token", async () => {
    const api = makeApi();
    const events = [];
    api.on('unauthorized', (info) => events.push(info));
    await assert.rejects(api.request('GET', '/api/unauthorized'), { status: 401, message: 'Sign in again.' });
    assert.deepEqual(events, [{ path: '/api/unauthorized', token: 'gcd_testtoken123456' }]);
  });

  test("401 without a token does not emit 'unauthorized'", async () => {
    const api = makeApi({ token: null });
    let fired = false;
    api.on('unauthorized', () => { fired = true; });
    await assert.rejects(api.request('GET', '/api/unauthorized'), { status: 401 });
    assert.equal(fired, false);
  });

  test('times out with a plain message (status 0)', async () => {
    const api = makeApi({ opts: { timeout: 100 } });
    await assert.rejects(api.request('GET', '/api/slow'), (err) => {
      assert.equal(err.status, 0);
      assert.match(err.message, /took too long/);
      return true;
    });
  });

  test('a per-call timeout overrides the default', async () => {
    const api = makeApi({ opts: { timeout: 100 } });
    assert.deepEqual(await api.request('GET', '/api/slow', null, { timeout: 2000 }), { ok: true });
  });

  test("network errors become ApiError status 0 'Can't reach the guild server (…)'", async () => {
    // A port that was just closed: connection refused.
    const tmp = http.createServer();
    await new Promise((r) => tmp.listen(0, '127.0.0.1', r));
    const port = tmp.address().port;
    await new Promise((r) => tmp.close(r));
    const api = makeApi({ server: `http://127.0.0.1:${port}` });
    await assert.rejects(api.request('GET', '/api/echo'), (err) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.status, 0);
      assert.match(err.message, /^Can't reach the guild server \(127\.0\.0\.1:\d+: connection refused\)/);
      return true;
    });
  });

  test('fetch failures are mapped with the injected fetch too', async () => {
    const fetch = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); };
    const api = makeApi({ server: 'https://nowhere.invalid', opts: { fetch } });
    await assert.rejects(api.request('GET', '/api/me'), { status: 0, message: /nowhere\.invalid: address not found/ });
  });

  test('no server configured → plain message', async () => {
    await assert.rejects(makeApi({ server: '' }).request('GET', '/api/me'), { status: 0, message: /No guild server is set/ });
  });

  test('refuses bad paths and methods', async () => {
    const api = makeApi();
    await assert.rejects(api.request('GET', 'https://evil.example/api'), { status: 0 });
    await assert.rejects(api.request('GET', '//evil.example/api'), { status: 0 });
    await assert.rejects(api.request('TRACE', '/api/echo'), /Unsupported/);
  });

  test('reads the token fresh for every call', async () => {
    const api = makeApi();
    api.setToken('gcd_secondtoken99999');
    assert.equal((await api.request('GET', '/api/echo')).auth, 'Bearer gcd_secondtoken99999');
  });
});

describe('download', () => {
  test('resolves with a Buffer of the file', async () => {
    const buf = await makeApi().download('/updates/file.bin');
    assert.ok(Buffer.isBuffer(buf));
    assert.deepEqual([...buf], [1, 2, 3, 255]);
    assert.equal(seen.at(-1).headers.authorization, 'Bearer gcd_testtoken123456');
  });

  test('errors are ApiErrors', async () => {
    await assert.rejects(makeApi().download('/updates/missing.zip'), { status: 404 });
  });
});

// ---------------------------------------------------------------------------------------------
// The auth service on top of the real api client (sign-in window parts need Electron and are
// covered by the smoke run; the URL parsing is tested in ipc.test.js).
describe('auth service', () => {
  const quiet = { info() {}, warn() {}, error() {} };
  let dir;

  function setup() {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-auth-'));
    const store = createStore(dir);
    store.set({ serverUrl: base });
    const api = createApi({ getServer: () => store.get().serverUrl, getToken: () => store.getSecret('deviceToken'), appVersion: '0.11.0' });
    const cleared = [];
    const auth = createAuth({ store, api, log: quiet, appVersion: '0.11.0', hostname: 'TEST-PC', electron: { session: { fromPartition: () => ({ clearStorageData: async () => cleared.push(true) }) } } });
    const changes = [];
    auth.on('change', (s) => changes.push(s));
    return { store, api, auth, changes, cleared };
  }

  after(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  test('starts signed out', async () => {
    const { auth, store } = setup();
    const s = auth.state();
    assert.equal(s.signedIn, false);
    assert.equal(s.user, null);
    assert.equal(s.server, store.get().serverUrl);
    assert.equal((await auth.refresh()).signedIn, false);
  });

  test('devSignIn stores the token (never returned) and loads /api/me', async () => {
    const { auth, store, changes } = setup();
    const s = await auth.devSignIn('  Dev#1234 ');
    assert.equal(s.signedIn, true);
    assert.equal(s.user.battletag, 'Dev#1234');
    assert.equal(s.guild.name, 'Forever Camp');
    assert.equal(s.role, 'owner');
    assert.equal(JSON.stringify(s).includes('gcd_'), false, 'the token never leaves the main process');
    assert.match(store.getSecret('deviceToken'), /^gcd_dev/);
    const devCall = seen.filter((r) => r.url === '/api/auth/dev').at(-1);
    assert.deepEqual(JSON.parse(devCall.body), { battletag: 'Dev#1234', device: { name: 'TEST-PC', platform: process.platform, appVersion: '0.11.0' } });
    assert.equal(devCall.headers.authorization, undefined);
    assert.ok(changes.some((c) => c.signedIn && c.user));
  });

  test('devSignIn needs a BattleTag', async () => {
    const { auth } = setup();
    await assert.rejects(auth.devSignIn('   '), /Enter a BattleTag/);
  });

  test('the profile is cached so the app knows who you are while offline', async () => {
    const { auth, store } = setup();
    await auth.devSignIn('Cache#1');
    store.set({ serverUrl: 'http://127.0.0.1:9' }); // nothing listens on the discard port
    const again = createAuth({ store, api: createApi({ getServer: () => store.get().serverUrl, getToken: () => store.getSecret('deviceToken'), appVersion: '0.11.0', timeout: 2000 }), log: quiet, appVersion: '0.11.0', electron: {} });
    assert.equal(again.state().user.battletag, 'Cache#1');
    const s = await again.refresh();
    assert.equal(s.signedIn, true);
    assert.equal(s.offline, true);
    assert.match(s.error, /Can't reach the guild server/);
    assert.equal(s.user.battletag, 'Cache#1');
  });

  test('a 401 (device revoked) signs out and says why', async () => {
    const { auth, store, changes } = setup();
    await auth.devSignIn('Revoked#1');
    validTokens.delete(store.getSecret('deviceToken'));
    const s = await auth.refresh();
    assert.equal(s.signedIn, false);
    assert.equal(s.user, null);
    assert.match(s.error, /expired or was removed/);
    assert.equal(store.getSecret('deviceToken'), null);
    assert.equal(store.getSecret('me'), null);
    assert.equal(changes.at(-1).signedIn, false);
  });

  test('a stale 401 for an old token does not sign out a newer sign-in', async () => {
    const { auth, api, store } = setup();
    await auth.devSignIn('Fresh#1');
    api.emit('unauthorized', { path: '/api/x', token: 'gcd_someoldtoken0000' });
    assert.equal(auth.state().signedIn, true);
    assert.ok(store.getSecret('deviceToken'));
  });

  test('signOut tells the server, forgets the token and clears Battle.net cookies', async () => {
    const { auth, store, cleared } = setup();
    await auth.devSignIn('Bye#1');
    const token = store.getSecret('deviceToken');
    const s = await auth.signOut();
    assert.equal(s.signedIn, false);
    assert.equal(s.error, null);
    assert.equal(store.getSecret('deviceToken'), null);
    assert.equal(validTokens.has(token), false, 'server revoked it');
    assert.deepEqual(cleared, [true]);
  });

  test('signOut still works when the server is unreachable', async () => {
    const { auth, store } = setup();
    await auth.devSignIn('Offline#1');
    store.set({ serverUrl: 'http://127.0.0.1:9' });
    const s = await auth.signOut();
    assert.equal(s.signedIn, false);
    assert.equal(store.getSecret('deviceToken'), null);
  });

  test("'change' only fires when the state really changes", async () => {
    const { auth, changes } = setup();
    await auth.devSignIn('Quiet#1');
    const n = changes.length;
    await auth.refresh();
    await auth.refresh();
    assert.equal(changes.length, n);
  });
});
