'use strict';
// The live link (main/live.js): finds the newest combat log, starts at its end, reads what the game appends.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLive, newestLog } = require('../src/main/live');

const quiet = { info() {}, warn() {}, error() {} };
const ME = 'Player-4395-0A1B2C3D,"Grom-Zuljin",0x511,0x0';
const MOB = 'Creature-0-4395-0-1-116-000ABC,"Defias Pillager",0xa48,0x0';
const stamp = () => { const d = new Date(); return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}.000`; };

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-live-'));
  fs.mkdirSync(path.join(dir, 'Logs'));
  const install = { dir, label: 'Forever' };
  return { dir, install, file: path.join(dir, 'Logs', 'WoWCombatLog.txt') };
}

test('off without a log, then follows it from its end', async () => {
  const { install, file } = setup();
  const live = createLive({ findInstalls: () => [install], myNames: async () => ['Grom'], log: quiet });
  live.tick();
  assert.strictEqual(live.state().status, 'off');
  assert.match(live.state().hint, /\/combatlog/);
  // An old session in the file is not replayed.
  fs.writeFileSync(file, `${stamp()}  PARTY_KILL,${ME},${MOB}\n`);
  const updates = []; const deaths = [];
  live.on('update', (s) => updates.push(s));
  live.on('death', (d) => deaths.push(d));
  live.tick();
  await new Promise((r) => setImmediate(r)); // names arrive
  assert.strictEqual(live.state().status, 'waiting');
  assert.strictEqual(live.state().game, 'Forever');
  assert.strictEqual(live.state().session, null);
  // New lines: a kill, then a half-written line finished on the next read.
  fs.appendFileSync(file, `${stamp()}  PARTY_KILL,${ME},${MOB}\n${stamp()}  SWING_DAMAGE,${MOB},${ME},50,-1,1,0,0,0,nil,nil,nil\n${stamp()}  UNIT_DI`);
  live.tick();
  let s = live.state();
  assert.strictEqual(s.status, 'live');
  assert.strictEqual(s.session.kills, 1);
  assert.strictEqual(deaths.length, 0);
  fs.appendFileSync(file, `ED,0000000000000000,nil,0x80000000,0x0,${ME}\n`);
  live.tick();
  s = live.state();
  assert.strictEqual(deaths.length, 1);
  assert.strictEqual(s.lastDeath.killer, 'Defias Pillager');
  assert.match(s.context.death, /Died to Defias Pillager/);
  assert.match(s.context.session, /1 kills/);
  assert.ok(updates.length >= 2);
  // The game starts the file again: read from the top.
  fs.writeFileSync(file, `${stamp()}  PARTY_KILL,${ME},${MOB}\n`);
  live.tick();
  assert.strictEqual(live.state().session.kills, 2);
});

test('newestLog picks the newest combat log and ignores other files', () => {
  const { dir, install } = setup();
  const a = path.join(dir, 'Logs', 'WoWCombatLog-110926_170000.txt');
  const b = path.join(dir, 'Logs', 'WoWCombatLog-110926_180000.txt');
  fs.writeFileSync(a, 'a'); fs.writeFileSync(b, 'bb');
  fs.writeFileSync(path.join(dir, 'Logs', 'FrameXML.log'), 'x');
  const t = Date.now() / 1000;
  fs.utimesSync(a, t - 100, t - 100);
  assert.strictEqual(newestLog([install, { dir: '/nope' }]).file, b);
  assert.strictEqual(newestLog([]), null);
});
