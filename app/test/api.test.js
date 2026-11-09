'use strict';
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const { createApi, ApiError } = require('../src/main/api');

let server;
let base;
const seen = [];

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
        case '/api/no-guild': return send(403, { error: "Guild Camp hasn't seen your guild yet.", code: 'NO_GUILD', retryAfter: 60 });
        case '/api/odd-error': return send(400, ['not', 'an', 'object']);
        case '/api/unauthorized': return send(401, { error: 'Sign in again.' });
        case '/api/html-error': return send(502, '<html><body>Bad gateway</body></html>', 'text/html');
        case '/api/slow': return setTimeout(() => send(200, { ok: true }), 400);
        case '/updates/file.bin': return send(200, Buffer.from([1, 2, 3, 255]), 'application/octet-stream');
        case '/api/raw': return send(200, Buffer.from(body, 'latin1').length.toString(), 'text/plain');
        default: return send(404, { error: 'No such thing.' });
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

// The app's client for the local core: its address and its launch token.
function makeApi(overrides = {}) {
  let token = overrides.token === undefined ? 'gcd_testtoken123456' : overrides.token;
  const api = createApi({
    getBase: () => (overrides.server !== undefined ? overrides.server : `${base}/`),
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

  test("JSON error replies keep the core's code and other fields (err.body)", async () => {
    await assert.rejects(makeApi().request('GET', '/api/no-guild'), (err) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.status, 403);
      assert.equal(err.message, "Guild Camp hasn't seen your guild yet.");
      assert.equal(err.code, 'NO_GUILD');
      assert.equal(err.autoJoin, undefined, 'there is no joining any more');
      assert.equal(err.body.retryAfter, 60);
      return true;
    });
    // A plain { error } reply has no code; odd shapes never break the error.
    await assert.rejects(makeApi().request('POST', '/api/forbidden', {}), (err) => err.code === undefined && err.body.error === 'Only officers can do that.');
    await assert.rejects(makeApi().request('GET', '/api/odd-error'), (err) => err.status === 400 && err.body === undefined && err.code === undefined);
    await assert.rejects(makeApi().request('GET', '/api/html-error'), (err) => err.body === undefined);
  });

  test('non-JSON error pages get a plain message instead of HTML', async () => {
    await assert.rejects(makeApi().request('GET', '/api/html-error'), (err) => {
      assert.equal(err.status, 502);
      assert.ok(!err.message.includes('<html>'));
      assert.match(err.message, /couldn't reach an outside service/);
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

  test("network errors become ApiError status 0 'Guild Camp couldn't reach its own data service (…)'", async () => {
    // A port that was just closed: connection refused.
    const tmp = http.createServer();
    await new Promise((r) => tmp.listen(0, '127.0.0.1', r));
    const port = tmp.address().port;
    await new Promise((r) => tmp.close(r));
    const api = makeApi({ server: `http://127.0.0.1:${port}` });
    await assert.rejects(api.request('GET', '/api/echo'), (err) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.status, 0);
      assert.match(err.message, /^Guild Camp couldn't reach its own data service \(connection refused\)\. Restart Guild Camp\.$/);
      return true;
    });
  });

  test('fetch failures are mapped with the injected fetch too', async () => {
    const fetch = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); };
    const api = makeApi({ server: 'https://nowhere.invalid', opts: { fetch } });
    await assert.rejects(api.request('GET', '/api/me'), { status: 0, message: /\(address not found\)/ });
  });

  test('the core not started yet → plain message', async () => {
    await assert.rejects(makeApi({ server: '' }).request('GET', '/api/me'), { status: 0, message: /data service hasn't started\. Restart Guild Camp\./ });
  });

  test('getServer still works as the old name for getBase', async () => {
    const api = createApi({ getServer: () => base, getToken: () => 'tok', appVersion: '1.0.0' });
    assert.equal((await api.request('GET', '/api/echo')).auth, 'Bearer tok');
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
