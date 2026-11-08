'use strict';
// Battle.net sign-in run by the app (src/main/auth.js) against a fake Battle.net on this PC. The tests play the
// browser: they read the address the app "opened", then call the app's loopback server on 127.0.0.1:47615
// themselves, as Battle.net's redirect would.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

const {
  createAuth, authorizeUrl, gameLabel, cleanCharacter, charactersFromProfile, profileNamespaces, callbackPage,
  PORT, REDIRECT_URI, TOKEN_SECRET, PROFILE_FILE, EXPIRED_MESSAGE,
} = require('../src/main/auth');
const { createStore } = require('../src/main/store');

const CREDS = { clientId: 'test-client-id', clientSecret: 'test-client-secret' };
const quiet = { info() {}, warn() {}, error() {} };
// Port 47615 is the one registered at develop.battle.net. Some sandboxes block that range of ports; then the tests
// run the same flow on a free port (the redirect address follows the port).
let TEST_PORT = PORT;
let REDIRECT = REDIRECT_URI;

function canListen(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

// ---------------------------------------------------------------------------------------------
// A fake Battle.net: OAuth token + userinfo, and the profile API.

const char = (name, realm, cls, race, level, extra = {}) => ({
  character: { href: 'https://example/x' }, name, id: Math.floor(Math.random() * 1e6),
  realm: { key: { href: 'x' }, name: realm, id: 1, slug: realm.toLowerCase().replace(/\s+/g, '-') },
  playable_class: { key: { href: 'x' }, name: cls[0], id: cls[1] }, playable_race: { key: { href: 'x' }, name: race, id: 2 },
  gender: { type: 'MALE', name: 'Male' }, faction: { type: 'HORDE', name: 'Horde' }, level, ...extra,
});

const fake = {
  base: '',
  issued: new Map(), // access token → { revoked }
  calls: [],
  profiles: {}, // namespace → body | status number | 'hang'
  guilds: {}, // "realm/name" → guild name
  battletag: 'Zulgar#1234',
  tokenStatus: 200,
  expiresIn: 86399,
  next: 1,
  reset() {
    this.calls = [];
    this.battletag = 'Zulgar#1234';
    this.tokenStatus = 200;
    this.expiresIn = 86399;
    this.profiles = {
      'profile-eu': { wow_accounts: [{ id: 1, characters: [char('Thrallson', 'Draenor', ['Shaman', 7], 'Orc', 80)] }] },
      'profile-classic-eu': 404,
      'profile-classic1x-eu': {
        wow_accounts: [{
          id: 2,
          characters: [
            char('Mokra', 'Mirage Raceway', ['Priest', 5], 'Undead', 23),
            char('Zulgar', 'Mirage Raceway', ['Warrior', 1], 'Orc', 60),
            char('Zulgar', 'Mirage Raceway', ['Warrior', 1], 'Orc', 60), // listed twice: kept once
            { name: '', realm: { name: 'Nowhere', slug: 'nowhere' } }, // unusable: dropped
          ],
        }],
      },
      'profile-us': { wow_accounts: [{ id: 3, characters: [char('Yankee', 'Stormrage', ['Mage', 8], 'Troll', 70)] }] },
      'profile-classic-us': 403,
      'profile-classic1x-us': 404,
    };
    this.guilds = { 'mirage-raceway/zulgar': 'Just Now WoW' };
  },
};

let fakeServer;
let tmpRoot;

before(async () => {
  if (!(await canListen(PORT))) {
    TEST_PORT = await freePort();
    REDIRECT = `http://localhost:${TEST_PORT}/auth/callback`;
  }
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-bnet-'));
  fake.reset();
  fakeServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://fake');
      fake.calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body });
      const send = (status, data) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      const bearer = (req.headers.authorization || '').replace(/^Bearer /, '');
      const tokenOk = fake.issued.has(bearer) && !fake.issued.get(bearer).revoked;

      if (req.method === 'POST' && url.pathname === '/token') {
        const basic = Buffer.from((req.headers.authorization || '').replace(/^Basic /, ''), 'base64').toString();
        const form = new URLSearchParams(body);
        if (basic !== `${CREDS.clientId}:${CREDS.clientSecret}`) return send(401, { error: 'invalid_client' });
        if (fake.tokenStatus !== 200) return send(fake.tokenStatus, { error: 'server_error', error_description: 'Try later' });
        if (form.get('grant_type') !== 'authorization_code' || form.get('redirect_uri') !== REDIRECT || form.get('code') !== 'good-code') {
          return send(400, { error: 'invalid_grant', error_description: 'Invalid authorization code' });
        }
        const token = `tok-${fake.next++}`;
        fake.issued.set(token, { revoked: false });
        return send(200, { access_token: token, token_type: 'bearer', expires_in: fake.expiresIn, scope: 'wow.profile openid', sub: '123' });
      }
      if (req.method === 'GET' && url.pathname === '/userinfo') {
        if (!tokenOk) return send(401, { error: 'invalid_token' });
        return send(200, { sub: '123', id: 123, battletag: fake.battletag });
      }
      if (req.method === 'GET' && url.pathname === '/profile/user/wow') {
        if (!tokenOk) return send(401, { code: 401, type: 'BLZWEBAPI00000401', detail: 'Unauthorized' });
        const answer = fake.profiles[url.searchParams.get('namespace')];
        if (answer === 'hang') return undefined; // never answers
        if (typeof answer === 'number') return send(answer, { code: answer, detail: 'Not Found' });
        if (!answer) return send(404, { code: 404, detail: 'Not Found' });
        return send(200, answer);
      }
      const m = url.pathname.match(/^\/profile\/wow\/character\/([^/]+)\/([^/]+)$/);
      if (req.method === 'GET' && m) {
        if (!tokenOk) return send(401, { code: 401 });
        const guild = fake.guilds[`${decodeURIComponent(m[1])}/${decodeURIComponent(m[2])}`];
        if (!guild) return send(404, { code: 404 });
        return send(200, { name: m[2], guild: { name: guild, id: 9, realm: { slug: m[1] } }, faction: { type: 'HORDE' } });
      }
      return send(404, { error: 'nope' });
    });
  });
  await new Promise((resolve) => fakeServer.listen(0, '127.0.0.1', resolve));
  fake.base = `http://127.0.0.1:${fakeServer.address().port}`;
});

after(async () => {
  fakeServer.closeAllConnections();
  await new Promise((resolve) => fakeServer.close(resolve));
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------
// Helpers

function makeAuth(opts = {}) {
  const dir = opts.dir || fs.mkdtempSync(path.join(tmpRoot, 'ud-'));
  const store = opts.store || createStore(dir);
  const opened = [];
  const changes = [];
  const auth = createAuth({
    store,
    log: quiet,
    appVersion: '0.12.0',
    credentials: opts.credentials === undefined ? CREDS : opts.credentials,
    openExternal: opts.openExternal || (async (url) => { opened.push(url); }),
    endpoints: { authorize: 'https://oauth.battle.net/authorize', token: `${fake.base}/token`, userinfo: `${fake.base}/userinfo`, api: () => fake.base },
    port: TEST_PORT,
    ...(opts.auth || {}),
  });
  auth.on('change', (s) => changes.push(s));
  return { dir, store, auth, opened, changes };
}

// A promise's outcome, without an unhandled rejection while the test is busy elsewhere.
const outcome = (p) => p.then((value) => ({ value }), (error) => ({ error }));

async function waitFor(fn, ms = 4000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

// The browser's request to the loopback server (a fresh connection each time, like a new tab).
function browserGet(query, { host = '127.0.0.1', headers = {}, pathname = '/auth/callback' } = {}) {
  const qs = typeof query === 'string' ? query : new URLSearchParams(query).toString();
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port: TEST_PORT, path: `${pathname}${qs ? `?${qs}` : ''}`, method: 'GET', agent: false, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

// Resolves once nothing listens on the loopback port any more.
async function portIsFree(ms = 4000) {
  const end = Date.now() + ms;
  for (;;) {
    const open = await new Promise((resolve) => {
      const s = net.connect({ host: '127.0.0.1', port: TEST_PORT });
      s.once('connect', () => { s.destroy(); resolve(true); });
      s.once('error', () => resolve(false));
    });
    if (!open) return true;
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 20));
  }
}

function stateFrom(openedUrl) {
  return new URL(openedUrl).searchParams.get('state');
}

async function signInFully(ctx, code = 'good-code') {
  const p = outcome(ctx.auth.signIn());
  await waitFor(() => ctx.opened.length);
  const page = await browserGet({ code, state: stateFrom(ctx.opened.at(-1)) });
  const result = await p;
  return { page, result };
}

// ---------------------------------------------------------------------------------------------

describe('sign-in through the browser', () => {
  test('opens Battle.net, takes the reply, keeps the BattleTag and characters, and closes the port', async (t) => {
    if (TEST_PORT !== PORT) t.diagnostic(`Port ${PORT} can't be used here, so these tests use port ${TEST_PORT}.`);
    fake.reset();
    const ctx = makeAuth();
    assert.deepEqual(ctx.auth.state(), {
      available: true, signedIn: false, signingIn: false, battletag: null, region: 'eu', characters: [], profileAt: null, canRefresh: false, error: null,
    });

    const p = outcome(ctx.auth.signIn());
    await waitFor(() => ctx.opened.length);
    assert.equal(ctx.auth.state().signingIn, true);
    assert.ok(ctx.changes.some((s) => s.signingIn), "'change' says a sign-in is waiting");

    const opened = new URL(ctx.opened[0]);
    assert.equal(`${opened.origin}${opened.pathname}`, 'https://oauth.battle.net/authorize');
    assert.equal(opened.searchParams.get('client_id'), CREDS.clientId);
    assert.equal(opened.searchParams.get('redirect_uri'), REDIRECT);
    assert.equal(opened.searchParams.get('response_type'), 'code');
    assert.equal(opened.searchParams.get('scope'), 'openid wow.profile');
    const state = opened.searchParams.get('state');
    assert.match(state, /^[A-Za-z0-9_-]{32}$/);
    assert.equal(opened.searchParams.has('client_secret'), false, 'the secret never goes to the browser');

    const page = await browserGet({ code: 'good-code', state });
    assert.equal(page.status, 200);
    assert.match(page.headers['content-type'], /text\/html/);
    assert.match(page.headers['content-security-policy'], /default-src 'none'/);
    assert.match(page.body, /You're signed in/);
    assert.match(page.body, /Zulgar#1234/);
    assert.doesNotMatch(page.body, /<script/i);

    const { value: s, error } = await p;
    assert.equal(error, undefined);
    assert.equal(s.signedIn, true);
    assert.equal(s.signingIn, false);
    assert.equal(s.battletag, 'Zulgar#1234');
    assert.equal(s.region, 'eu');
    assert.equal(s.canRefresh, true);
    assert.equal(s.error, null);
    assert.ok(Date.parse(s.profileAt) > Date.now() - 60000);
    assert.deepEqual(s.characters, [
      { name: 'Thrallson', realm: 'Draenor', realm_slug: 'draenor', level: 80, class: 'SHAMAN', race: 'Orc', faction: 'Horde', namespace: 'profile-eu', guild: null },
      { name: 'Zulgar', realm: 'Mirage Raceway', realm_slug: 'mirage-raceway', level: 60, class: 'WARRIOR', race: 'Orc', faction: 'Horde', namespace: 'profile-classic1x-eu', guild: 'Just Now WoW' },
      { name: 'Mokra', realm: 'Mirage Raceway', realm_slug: 'mirage-raceway', level: 23, class: 'PRIEST', race: 'Undead', faction: 'Horde', namespace: 'profile-classic1x-eu', guild: null },
    ]);

    // The token exchange used HTTP Basic and the registered redirect address; the profile calls the token.
    const tokenCall = fake.calls.find((c) => c.path === '/token');
    assert.equal(tokenCall.headers.authorization, `Basic ${Buffer.from('test-client-id:test-client-secret').toString('base64')}`);
    assert.equal(new URLSearchParams(tokenCall.body).get('redirect_uri'), REDIRECT);
    const profileCalls = fake.calls.filter((c) => c.path === '/profile/user/wow');
    assert.deepEqual(profileCalls.map((c) => c.query.namespace).sort(), ['profile-classic-eu', 'profile-classic1x-eu', 'profile-eu']);
    assert.ok(profileCalls.every((c) => c.query.locale === 'en_GB' && /^Bearer tok-/.test(c.headers.authorization)));
    assert.match(profileCalls[0].headers['user-agent'], /^GuildCamp\/0\.12\.0/);

    // The token is kept as a secret, never in the state; the characters in bnet-profile.json.
    const token = JSON.parse(ctx.store.getSecret(TOKEN_SECRET));
    assert.match(token.accessToken, /^tok-/);
    assert.ok(token.expiresAt > Date.now() + 23 * 3600 * 1000);
    assert.equal(JSON.stringify(s).includes(token.accessToken), false);
    const saved = JSON.parse(fs.readFileSync(path.join(ctx.dir, PROFILE_FILE), 'utf8'));
    assert.equal(saved.battletag, 'Zulgar#1234');
    assert.equal(saved.characters.length, 3);
    assert.equal(JSON.stringify(saved).includes(token.accessToken), false);

    assert.equal(ctx.changes.at(-1).signedIn, true);
    assert.equal(await portIsFree(), true, 'the loopback server stops once the browser is back');

    // A late second visit (reload of the tab) finds nothing listening.
    await assert.rejects(browserGet({ code: 'good-code', state }), (err) => err.code === 'ECONNREFUSED');

    // After a restart the sign-in is still there.
    const again = makeAuth({ dir: ctx.dir });
    const restored = again.auth.state();
    assert.equal(restored.signedIn, true);
    assert.equal(restored.battletag, 'Zulgar#1234');
    assert.deepEqual(restored.characters, s.characters);
  });

  test('a reply with the wrong state is refused and the real one still works', async () => {
    fake.reset();
    const ctx = makeAuth();
    const p = outcome(ctx.auth.signIn());
    await waitFor(() => ctx.opened.length);
    const state = stateFrom(ctx.opened[0]);

    const wrong = await browserGet({ code: 'good-code', state: `${state.slice(0, -1)}${state.endsWith('A') ? 'B' : 'A'}` });
    assert.equal(wrong.status, 400);
    assert.match(wrong.body, /doesn't match/);
    const missing = await browserGet({ code: 'good-code' });
    assert.equal(missing.status, 400);
    assert.equal(fake.calls.filter((c) => c.path === '/token').length, 0, 'no code was traded');
    assert.equal(ctx.auth.state().signingIn, true, 'still waiting for the real reply');

    const ok = await browserGet({ code: 'good-code', state });
    assert.equal(ok.status, 200);
    const { value } = await p;
    assert.equal(value.signedIn, true);
    assert.equal(await portIsFree(), true);
  });

  test('only the callback address on localhost answers', async () => {
    fake.reset();
    const ctx = makeAuth();
    const p = outcome(ctx.auth.signIn());
    await waitFor(() => ctx.opened.length);
    const state = stateFrom(ctx.opened[0]);

    const other = await browserGet('', { pathname: '/favicon.ico' });
    assert.equal(other.status, 404);
    // A web page trying to reach the loopback server through another host name.
    const rebind = await browserGet({ code: 'good-code', state }, { headers: { Host: `evil.example:${TEST_PORT}` } });
    assert.equal(rebind.status, 400);
    assert.equal(fake.calls.filter((c) => c.path === '/token').length, 0);
    // Battle.net sends the browser to localhost:47615.
    const ok = await browserGet({ code: 'good-code', state }, { headers: { Host: `localhost:${TEST_PORT}` } });
    assert.equal(ok.status, 200);
    assert.equal((await p).value.signedIn, true);
    assert.equal(await portIsFree(), true);
  });

  test('cancelling on the Battle.net page', async () => {
    fake.reset();
    const ctx = makeAuth();
    const p = outcome(ctx.auth.signIn());
    await waitFor(() => ctx.opened.length);
    const page = await browserGet({ error: 'access_denied', error_description: 'The user denied', state: stateFrom(ctx.opened[0]) });
    assert.equal(page.status, 200);
    assert.match(page.body, /cancelled/);
    const { error } = await p;
    assert.equal(error.code, 'cancelled');
    assert.match(error.message, /cancelled/);
    const s = ctx.auth.state();
    assert.equal(s.signedIn, false);
    assert.equal(s.signingIn, false);
    assert.equal(s.error, null, 'cancelling yourself is not an error');
    assert.equal(await portIsFree(), true);
  });

  test('Battle.net refusing the code: the browser and the app both say so', async () => {
    fake.reset();
    const ctx = makeAuth();
    const p = outcome(ctx.auth.signIn());
    await waitFor(() => ctx.opened.length);
    const page = await browserGet({ code: 'stale-code', state: stateFrom(ctx.opened[0]) });
    assert.equal(page.status, 502);
    assert.match(page.body, /didn't accept/);
    const { error } = await p;
    assert.equal(error.code, 'bnet-error');
    assert.match(error.message, /^Battle\.net didn't accept the sign-in \(400: Invalid authorization code\)\. Try again\.$/);
    assert.equal(ctx.auth.state().signedIn, false);
    assert.equal(ctx.auth.state().error, error.message);
    assert.equal(ctx.store.getSecret(TOKEN_SECRET), null);
    assert.equal(await portIsFree(), true);
  });

  test('gives up after the time limit and frees the port', async () => {
    fake.reset();
    const ctx = makeAuth({ auth: { timeoutMs: 250 } });
    const started = Date.now();
    const { error } = await outcome(ctx.auth.signIn());
    assert.ok(Date.now() - started >= 200);
    assert.equal(error.code, 'timeout');
    assert.match(error.message, /took too long/);
    const s = ctx.auth.state();
    assert.equal(s.signingIn, false);
    assert.equal(s.signedIn, false);
    assert.match(s.error, /took too long/);
    assert.equal(await portIsFree(), true);
    // The tab Battle.net returns to afterwards finds nothing.
    await assert.rejects(browserGet({ code: 'good-code', state: stateFrom(ctx.opened[0]) }), (err) => err.code === 'ECONNREFUSED');
  });

  test('pressing Sign in again starts over: the first sign-in stops, the new one works', async () => {
    fake.reset();
    const ctx = makeAuth();
    const first = outcome(ctx.auth.signIn());
    await waitFor(() => ctx.opened.length === 1);
    const second = outcome(ctx.auth.signIn());
    const { error } = await first;
    assert.equal(error.code, 'cancelled');
    await waitFor(() => ctx.opened.length === 2);
    const [s1, s2] = ctx.opened.map(stateFrom);
    assert.notEqual(s1, s2);

    const old = await browserGet({ code: 'good-code', state: s1 });
    assert.equal(old.status, 400, "the first sign-in's reply no longer counts");
    const ok = await browserGet({ code: 'good-code', state: s2 });
    assert.equal(ok.status, 200);
    assert.equal((await second).value.signedIn, true);
    assert.equal(ctx.auth.state().error, null);
    assert.equal(await portIsFree(), true);
  });

  test('explains when another program has the port', async () => {
    fake.reset();
    const blocker = net.createServer();
    await new Promise((resolve) => blocker.listen(TEST_PORT, '127.0.0.1', resolve));
    try {
      const ctx = makeAuth();
      const { error } = await outcome(ctx.auth.signIn());
      assert.equal(error.code, 'port-busy');
      assert.match(error.message, new RegExp(`needs port ${TEST_PORT} on this PC`));
      assert.match(error.message, /another program is using it/);
      assert.equal(ctx.opened.length, 0, 'the browser is not opened when the reply could not arrive');
      assert.equal(ctx.auth.state().signingIn, false);
      assert.equal(ctx.auth.state().error, error.message);
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  });

  test("the browser not opening ends the sign-in", async () => {
    fake.reset();
    const ctx = makeAuth({ openExternal: async () => { throw new Error('No default browser'); } });
    const { error } = await outcome(ctx.auth.signIn());
    assert.equal(error.code, 'no-browser');
    assert.match(error.message, /couldn't open your web browser \(No default browser\)/);
    assert.equal(ctx.auth.state().signingIn, false);
    assert.equal(await portIsFree(), true);
  });

  test('a slow profile does not hold up sign-in', async () => {
    fake.reset();
    fake.profiles['profile-classic-eu'] = 'hang';
    const ctx = makeAuth({ auth: { profileTimeoutMs: 400 } });
    const started = Date.now();
    const { result } = await signInFully(ctx);
    assert.ok(Date.now() - started < 3000);
    assert.equal(result.value.signedIn, true);
    assert.deepEqual(result.value.characters.map((c) => c.name), ['Thrallson', 'Zulgar', 'Mokra']);
    assert.equal(result.value.error, null, 'the profiles that answered are enough');
    assert.equal(await portIsFree(), true);
  });

  test('no profile answers: signed in anyway, with a plain note', async () => {
    fake.reset();
    for (const ns of Object.keys(fake.profiles)) fake.profiles[ns] = 500;
    const ctx = makeAuth();
    const { result } = await signInFully(ctx);
    assert.equal(result.value.signedIn, true);
    assert.equal(result.value.battletag, 'Zulgar#1234');
    assert.deepEqual(result.value.characters, []);
    assert.equal(result.value.profileAt, null);
    assert.match(result.value.error, /^You're signed in, but Battle\.net had a problem sending your characters\. Try Refresh in Settings later\.$/);
    assert.equal(await portIsFree(), true);
  });

  test('the region in Settings decides where characters come from', async () => {
    fake.reset();
    const ctx = makeAuth();
    ctx.store.set({ bnetRegion: 'us' });
    assert.equal(ctx.auth.state().region, 'us');
    const { result } = await signInFully(ctx);
    assert.equal(result.value.region, 'us');
    assert.deepEqual(result.value.characters.map((c) => [c.name, c.namespace]), [['Yankee', 'profile-us']]);
    assert.deepEqual(fake.calls.filter((c) => c.path === '/profile/user/wow').map((c) => c.query.namespace).sort(),
      ['profile-classic-us', 'profile-classic1x-us', 'profile-us']);
    assert.equal(await portIsFree(), true);
  });
});

describe('without built-in credentials (dev builds)', () => {
  test('available is false and signIn explains, without opening anything', async () => {
    const ctx = makeAuth({ credentials: null });
    assert.equal(ctx.auth.state().available, false);
    const { error } = await outcome(ctx.auth.signIn());
    assert.equal(error.code, 'unavailable');
    assert.match(error.message, /Everything else works without it/);
    assert.equal(ctx.opened.length, 0);
    assert.equal(await portIsFree(), true);
    // Half-filled credentials count as none.
    assert.equal(makeAuth({ credentials: { clientId: 'x', clientSecret: '' } }).auth.state().available, false);
  });
});

describe('sign out and refresh', () => {
  test('signOut forgets the token, the BattleTag and the characters', async () => {
    fake.reset();
    const ctx = makeAuth();
    await signInFully(ctx);
    const s = await ctx.auth.signOut();
    assert.equal(s.signedIn, false);
    assert.equal(s.battletag, null);
    assert.deepEqual(s.characters, []);
    assert.equal(s.error, null);
    assert.equal(ctx.store.getSecret(TOKEN_SECRET), null);
    assert.equal(fs.existsSync(path.join(ctx.dir, PROFILE_FILE)), false);
    assert.equal(ctx.changes.at(-1).signedIn, false);
    assert.equal(makeAuth({ dir: ctx.dir }).auth.state().signedIn, false, 'still signed out after a restart');
    await ctx.auth.signOut(); // twice is fine
  });

  test('signOut also stops a sign-in that is waiting for the browser', async () => {
    fake.reset();
    const ctx = makeAuth();
    const p = outcome(ctx.auth.signIn());
    await waitFor(() => ctx.opened.length);
    await ctx.auth.signOut();
    const { error } = await p;
    assert.equal(error.code, 'cancelled');
    assert.equal(ctx.auth.state().signingIn, false);
    assert.equal(ctx.auth.state().error, null);
    assert.equal(await portIsFree(), true);
  });

  test('cancel() stops a waiting sign-in', async () => {
    fake.reset();
    const ctx = makeAuth();
    const p = outcome(ctx.auth.signIn());
    await waitFor(() => ctx.opened.length);
    const s = await ctx.auth.cancel();
    assert.equal(s.signingIn, false);
    assert.equal((await p).error.code, 'cancelled');
    assert.equal(await portIsFree(), true);
  });

  test('refresh reads the characters and BattleTag again with the saved token', async () => {
    fake.reset();
    const ctx = makeAuth();
    const { result } = await signInFully(ctx);
    const before = result.value.profileAt;
    fake.battletag = 'Zulgar#5678';
    fake.profiles['profile-classic-eu'] = { wow_accounts: [{ characters: [char('Newbie', 'Gehennas', ['Rogue', 4], 'Orc', 12)] }] };
    await new Promise((r) => setTimeout(r, 5));
    const s = await ctx.auth.refresh();
    assert.equal(s.signedIn, true);
    assert.equal(s.battletag, 'Zulgar#5678');
    assert.deepEqual(s.characters.map((c) => c.name), ['Thrallson', 'Newbie', 'Zulgar', 'Mokra']);
    assert.ok(Date.parse(s.profileAt) > Date.parse(before));
    assert.equal(s.error, null);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(ctx.dir, PROFILE_FILE), 'utf8')).characters.map((c) => c.name), ['Thrallson', 'Newbie', 'Zulgar', 'Mokra']);
    // Two refreshes at once share one round of calls.
    const n = fake.calls.length;
    await Promise.all([ctx.auth.refresh(), ctx.auth.refresh()]);
    assert.equal(fake.calls.filter((c, i) => i >= n && c.path === '/userinfo').length, 1);
  });

  test('refresh with a token Battle.net no longer accepts signs out and says why', async () => {
    fake.reset();
    const ctx = makeAuth();
    await signInFully(ctx);
    const token = JSON.parse(ctx.store.getSecret(TOKEN_SECRET)).accessToken;
    fake.issued.get(token).revoked = true;
    const s = await ctx.auth.refresh();
    assert.equal(s.signedIn, false);
    assert.equal(s.error, EXPIRED_MESSAGE);
    assert.match(s.error, /^Your Battle\.net sign-in has expired\. Sign in again/);
    assert.deepEqual(s.characters, []);
    assert.equal(ctx.store.getSecret(TOKEN_SECRET), null);
    assert.equal(fs.existsSync(path.join(ctx.dir, PROFILE_FILE)), false);
    assert.equal(ctx.changes.at(-1).error, EXPIRED_MESSAGE);
  });

  test('a token past its end date signs out on refresh without asking Battle.net', async () => {
    fake.reset();
    let clock = Date.now();
    const ctx = makeAuth({ auth: { now: () => clock } });
    await signInFully(ctx);
    assert.equal(ctx.auth.state().canRefresh, true);
    clock += 25 * 3600 * 1000; // a day later
    const s0 = ctx.auth.state();
    assert.equal(s0.signedIn, true, 'still shows who you are');
    assert.equal(s0.canRefresh, false, 'but a refresh would need a new sign-in');
    const n = fake.calls.length;
    const s = await ctx.auth.refresh();
    assert.equal(fake.calls.length, n);
    assert.equal(s.signedIn, false);
    assert.equal(s.error, EXPIRED_MESSAGE);
  });

  test('refresh while Battle.net has trouble keeps the list and says so', async () => {
    fake.reset();
    const ctx = makeAuth();
    const { result } = await signInFully(ctx);
    for (const ns of Object.keys(fake.profiles)) fake.profiles[ns] = 503;
    const s = await ctx.auth.refresh();
    assert.equal(s.signedIn, true);
    assert.deepEqual(s.characters, result.value.characters);
    assert.equal(s.profileAt, result.value.profileAt);
    assert.match(s.error, /^Battle\.net had a problem sending your characters\. Your list is as it was\./);
  });

  test('refresh signed out does nothing', async () => {
    const ctx = makeAuth();
    const n = fake.calls.length;
    const s = await ctx.auth.refresh();
    assert.equal(s.signedIn, false);
    assert.equal(fake.calls.length, n);
  });

  test('changing the region re-reads the characters there', async () => {
    fake.reset();
    const ctx = makeAuth();
    await signInFully(ctx);
    ctx.store.set({ bnetRegion: 'us' });
    const s = await waitFor(() => { const x = ctx.auth.state(); return x.region === 'us' ? x : null; });
    assert.deepEqual(s.characters.map((c) => c.name), ['Yankee']);
  });

  test('a saved profile without its token (another PC, or the token could not be read) is dropped', async () => {
    fake.reset();
    const ctx = makeAuth();
    await signInFully(ctx);
    ctx.store.setSecret(TOKEN_SECRET, null);
    const again = makeAuth({ dir: ctx.dir });
    assert.equal(again.auth.state().signedIn, false);
    assert.equal(fs.existsSync(path.join(ctx.dir, PROFILE_FILE)), false);
  });
});

describe('helpers', () => {
  test('authorizeUrl, namespaces and game labels', () => {
    assert.equal(PORT, 47615);
    assert.equal(REDIRECT_URI, 'http://localhost:47615/auth/callback', 'the address registered at develop.battle.net');
    const u = new URL(authorizeUrl({ clientId: 'abc', redirectUri: REDIRECT, state: 'xyz' }));
    assert.equal(u.origin + u.pathname, 'https://oauth.battle.net/authorize');
    assert.deepEqual(Object.fromEntries(u.searchParams), { client_id: 'abc', redirect_uri: REDIRECT, response_type: 'code', scope: 'openid wow.profile', state: 'xyz' });
    assert.deepEqual(profileNamespaces('KR').map((p) => p.ns), ['profile-kr', 'profile-classic-kr', 'profile-classic1x-kr']);
    assert.deepEqual(profileNamespaces('cn').map((p) => p.ns), ['profile-eu', 'profile-classic-eu', 'profile-classic1x-eu'], 'unknown regions fall back to EU');
    assert.equal(gameLabel('profile-eu'), 'Retail');
    assert.equal(gameLabel('profile-classic-us'), 'Classic');
    assert.equal(gameLabel('profile-classic1x-tw'), 'Classic Era');
    assert.equal(gameLabel('something'), 'World of Warcraft');
  });

  test('characters are read defensively', () => {
    assert.equal(cleanCharacter(null), null);
    assert.equal(cleanCharacter({ name: 'NoRealm' }, 'profile-eu'), null);
    assert.equal(cleanCharacter({ name: 'NoNamespace', realm: 'X' }), null);
    // Without locale=en_GB Blizzard sends names per language.
    assert.deepEqual(cleanCharacter({ name: 'Grüm', realm: { name: { en_GB: "Zul'jin", de_DE: "Zul'jin" } }, playable_class: { id: 99, name: { en_GB: 'Death Knight' } }, level: '62', faction: 'ALLIANCE' }, 'profile-eu'),
      { name: 'Grüm', realm: "Zul'jin", realm_slug: 'zuljin', level: 62, class: 'DEATHKNIGHT', race: null, faction: 'Alliance', namespace: 'profile-eu', guild: null });
    // The saved shape reads back as it was.
    const saved = { name: 'Zulgar', realm: 'Mirage Raceway', realm_slug: 'mirage-raceway', level: 60, class: 'WARRIOR', race: 'Orc', faction: 'Horde', namespace: 'profile-classic1x-eu', guild: 'Just Now WoW' };
    assert.deepEqual(cleanCharacter(saved), saved);
    assert.deepEqual(charactersFromProfile({ wow_accounts: 'nope' }, 'profile-eu'), []);
    assert.deepEqual(charactersFromProfile(null, 'profile-eu'), []);
  });

  test('the page shown in the browser escapes what it is given', () => {
    const html = callbackPage({ title: '<b>Hi</b>', body: '"quoted" & <script>x</script>' });
    assert.doesNotMatch(html, /<b>Hi<\/b>|<script>/);
    assert.match(html, /&lt;b&gt;Hi&lt;\/b&gt;/);
    assert.match(html, /&quot;quoted&quot; &amp; &lt;script&gt;/);
  });

  test('createAuth needs a store', () => {
    assert.throws(() => createAuth({}), /needs a store/);
  });
});
