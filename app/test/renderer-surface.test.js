'use strict';
// The renderer only uses what the main process and the local core still offer (docs/PIVOT.md removed the
// server-only parts: membership, invites, devices, server events ...). Static checks over src/renderer:
//   - every event channel a page or lib subscribes to is one the preload bridge forwards (gc.on throws
//     for any other, and the catch around it would hide the page never updating);
//   - every gc.<ns>.<method>() / gc.invoke('<ns>.<method>') is an IPC method main/ipc.js answers;
//   - every '/api/...' path the renderer asks for is a route the core serves.
// The dev mocks (lib/mock.js, lib/mocks/) are left out: they stand in for the main process.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { METHOD_NAMES, EVENT_CHANNELS } = require('../src/main/ipc');
const { createCore } = require('../src/core');
const { createApp } = require('../src/core/app');

const RENDERER = path.join(__dirname, '..', 'src', 'renderer');

function rendererFiles(dir = RENDERER) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'mocks' || e.name === 'vendor') continue;
      out.push(...rendererFiles(p));
    } else if (e.name.endsWith('.js') && e.name !== 'mock.js') {
      out.push(p);
    }
  }
  return out;
}

// Source without comments (so documentation that names an old channel does not count).
function code(file) {
  return fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

const SOURCES = rendererFiles().map((file) => ({ file: path.relative(RENDERER, file).replace(/\\/g, '/'), text: code(file) }));

function matches(re) {
  const out = [];
  for (const s of SOURCES) for (const m of s.text.matchAll(re)) out.push({ file: s.file, value: m[1] });
  return out;
}

test('renderer: every event channel it subscribes to is one the main process still sends', () => {
  const subs = matches(/\b(?:gc\.on|on|listen|useChannel|liveStatus|useGcEvent)\(\s*['"]([a-z][a-z:-]*)['"]/g)
    .filter((m) => !['click', 'change', 'input', 'keydown', 'resize'].includes(m.value));
  assert.ok(subs.length >= 6, `found ${subs.length} subscriptions`);
  const bad = subs.filter((m) => !EVENT_CHANNELS.includes(m.value));
  assert.deepStrictEqual(bad, [], 'channels the preload bridge does not forward');
  for (const gone of ['membership', 'events', 'invite', 'device']) {
    assert.ok(!subs.some((m) => m.value === gone), `nothing listens to the removed "${gone}" channel`);
  }
});

// The IPC namespaces, plus the ones the server pivot removed (a call into them must fail this test).
const NAMESPACES = new Set([...METHOD_NAMES.map((n) => n.split('.')[0]), 'membership', 'events', 'invites', 'devices', 'companion']);

test('renderer: every IPC method it calls is one main/ipc.js answers', () => {
  const calls = [
    ...matches(/\bgc\.invoke\(\s*['"]([a-zA-Z]+\.[a-zA-Z]+)['"]/g),
    ...matches(/\bgc\.([a-z]+\.[a-zA-Z]+)\(/g),
  ].filter((m) => NAMESPACES.has(m.value.split('.')[0])); // gc.methods.includes() and the like are not calls
  assert.ok(calls.length >= 10, `found ${calls.length} calls`);
  const bad = calls.filter((m) => !METHOD_NAMES.includes(m.value));
  assert.deepStrictEqual(bad, [], 'IPC methods main/ipc.js does not answer');
});

test("renderer: the Requests page has a control for every action the core allows on a request, so a crafter can give a claimed request back (canWithdraw)", () => {
  const core = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'routes', 'community.js'), 'utf8');
  const block = /const allowed = \(r, me\) => \(\{([\s\S]*?)\}\);/.exec(core);
  assert.ok(block, "core/routes/community.js still has allowed(r, me)");
  const flags = [...block[1].matchAll(/\b(can[A-Z]\w*)\s*:/g)].map((m) => m[1]);
  assert.ok(flags.includes('canWithdraw') && flags.length >= 4, `found ${flags.join(', ')}`);
  const page = SOURCES.find((s) => s.file === 'pages/requests.js').text;
  assert.deepStrictEqual(flags.filter((f) => !page.includes(f)), [], 'flags the Requests page never reads');
  // Each one posts its verb: claim, done, cancel, withdraw.
  for (const verb of flags.map((f) => f.slice(3).toLowerCase())) assert.ok(page.includes(`'${verb}'`), `the page posts "${verb}"`);
});

test('renderer: every /api path it asks for is a route the local core serves', async () => {
  const literal = /['`](\/api\/[^'`]*)['`]/g;
  const paths = matches(literal).map((m) => ({
    ...m,
    // A trailing `${qs(...)}` query helper or ?query is not part of the route.
    path: m.value.replace(/\$\{\s*qs\(.*$/, '').replace(/\?.*$/, ''),
  }));
  // Any other `${...}` stands for one path segment: `/api/raids/${id}/${verb}` is served by /api/raids/:id/lock.
  const PLACEHOLDER = /\$\{[^}]*\}/g;
  const escape = (x) => x.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
  assert.ok(paths.length >= 30, `found ${paths.length} paths`);
  const core = await createCore({ dbFile: ':memory:', timers: false });
  try {
    const app = createApp(core.ctx, { token: 'x'.repeat(40) });
    const routes = app.router.stack.filter((l) => l.route);
    const served = (p) => {
      const re = new RegExp(`^${p.split(PLACEHOLDER).map(escape).join('[^/]+')}$`);
      return routes.some((l) => l.match(p.replace(PLACEHOLDER, 'x')) || re.test(l.route.path));
    };
    const bad = paths.filter((p) => !served(p.path));
    assert.deepStrictEqual(bad.map((p) => `${p.file}: ${p.value}`), [], 'paths the core has no route for');
  } finally {
    await core.close();
  }
});
