'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createLog, redact } = require('../src/main/log');

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-log-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

test('writes lines to guildcamp.log with level and scope', () => {
  const log = createLog(dir);
  log.info('hello', 'world');
  log.warn('careful');
  log.scope('sync').error('broke', new Error('disk full'));
  assert.equal(log.file, path.join(dir, 'guildcamp.log'));
  const text = fs.readFileSync(log.file, 'utf8');
  assert.match(text, /INFO {2}\[app\] hello world/);
  assert.match(text, /WARN {2}\[app\] careful/);
  assert.match(text, /ERROR \[sync\] broke disk full/);
  assert.match(text, /\n {4}at /, 'error stack is kept in the file');
});

test('recent() returns the ring buffer, capped at ringSize, as copies', () => {
  const log = createLog(dir, { ringSize: 5 });
  for (let i = 0; i < 12; i++) log.info(`line ${i}`);
  const recent = log.recent();
  assert.equal(recent.length, 5);
  assert.deepEqual(recent.map((l) => l.msg), ['line 7', 'line 8', 'line 9', 'line 10', 'line 11']);
  for (const l of recent) {
    assert.deepEqual(Object.keys(l).sort(), ['level', 'msg', 'scope', 't']);
    assert.ok(!Number.isNaN(Date.parse(l.t)));
  }
  recent[0].msg = 'changed';
  assert.equal(log.recent()[0].msg, 'line 7');
});

test('default ring keeps 500 lines', () => {
  const log = createLog(dir);
  for (let i = 0; i < 520; i++) log.info(i);
  assert.equal(log.recent().length, 500);
  assert.equal(log.recent()[0].msg, '20');
});

test("emits 'line' for every new line", () => {
  const log = createLog(dir);
  const lines = [];
  log.on('line', (l) => lines.push(l));
  log.scope('auth').info('signed in');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].scope, 'auth');
  assert.equal(lines[0].level, 'info');
  assert.equal(lines[0].msg, 'signed in');
});

test('nested scopes join with a colon', () => {
  const log = createLog(dir);
  log.scope('sync').scope('upload').info('x');
  assert.equal(log.recent()[0].scope, 'sync:upload');
});

test('rotates at maxBytes and keeps 3 files in total', () => {
  const log = createLog(dir, { maxBytes: 1000 });
  const line = 'x'.repeat(200);
  for (let i = 0; i < 40; i++) log.info(`${i} ${line}`);
  const files = fs.readdirSync(dir).sort();
  assert.deepEqual(files, ['guildcamp.1.log', 'guildcamp.2.log', 'guildcamp.log']);
  for (const f of files) assert.ok(fs.statSync(path.join(dir, f)).size <= 1000, `${f} stays under the limit`);
  // Newest lines are in the current file, older ones in .1, oldest kept in .2.
  assert.match(fs.readFileSync(path.join(dir, 'guildcamp.log'), 'utf8'), /39 x/);
  const n1 = Number(/(\d+) x/.exec(fs.readFileSync(path.join(dir, 'guildcamp.1.log'), 'utf8'))[1]);
  const n2 = Number(/(\d+) x/.exec(fs.readFileSync(path.join(dir, 'guildcamp.2.log'), 'utf8'))[1]);
  assert.ok(n2 < n1 && n1 < 39);
});

test('the default limit is 1 MB', () => {
  const log = createLog(dir);
  const big = 'y'.repeat(100 * 1024);
  for (let i = 0; i < 11; i++) log.info(big);
  assert.ok(fs.existsSync(path.join(dir, 'guildcamp.1.log')), 'rotated after passing 1 MB');
  assert.ok(fs.statSync(path.join(dir, 'guildcamp.log')).size < 1024 * 1024);
});

test('picks up the size of an existing log file', () => {
  fs.writeFileSync(path.join(dir, 'guildcamp.log'), 'z'.repeat(990));
  const log = createLog(dir, { maxBytes: 1000 });
  log.info('this pushes it over');
  assert.ok(fs.existsSync(path.join(dir, 'guildcamp.1.log')));
  assert.equal(fs.readFileSync(path.join(dir, 'guildcamp.1.log'), 'utf8'), 'z'.repeat(990));
});

test('hides tokens', () => {
  const log = createLog(dir);
  log.info('token gcd_SECRETsecret123 and Bearer abc.def and https://x/auth/app/done#token=gcd_zzz');
  const msg = log.recent()[0].msg;
  assert.ok(!msg.includes('SECRETsecret123'));
  assert.ok(!msg.includes('abc.def'));
  assert.ok(!msg.includes('gcd_zzz'));
  assert.ok(!fs.readFileSync(log.file, 'utf8').includes('SECRETsecret123'));
  assert.equal(redact('?code=abc&x=1'), '?code=[hidden]&x=1');
});

test('never throws, even when the folder cannot be written', () => {
  const blocker = path.join(dir, 'not-a-dir');
  fs.writeFileSync(blocker, 'file in the way');
  const log = createLog(path.join(blocker, 'logs'));
  assert.doesNotThrow(() => {
    log.info('still works');
    log.error(new Error('x'));
    log.warn({ circular: undefined });
  });
  assert.equal(log.recent().length, 3);
});

test('formats objects and errors', () => {
  const log = createLog(dir);
  const circular = {};
  circular.self = circular;
  log.info({ a: 1 }, new Error('boom'), circular, undefined);
  assert.equal(log.recent()[0].msg, '{"a":1} boom [object Object] undefined');
});
