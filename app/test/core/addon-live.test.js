'use strict';
// The live link in game (Live.lua): /wow live on turns on combat logging now and at every login.
const test = require('node:test');
const assert = require('node:assert');
const { WowClient } = require('./wowsim');

const LOGGING = `__logging = false
function LoggingCombat(v) if v ~= nil then __logging = v and true or false end return __logging end`;

test('/wow live on|off and logging at login', () => {
  const wow = new WowClient();
  wow.exec(LOGGING);
  wow.login();
  assert.strictEqual(wow.eval('tostring(__logging)'), 'false', 'off by default');
  wow.slash('live');
  assert.match(wow.printed(), /combat logging is off\. \/wow live on turns it on at every login/);
  wow.slash('live on');
  assert.strictEqual(wow.eval('tostring(__logging)'), 'true');
  assert.strictEqual(wow.eval('tostring(WowGuildDB.options.liveLink)'), 'true');
  assert.match(wow.printed(), /Combat logging is on/);
  // Next login: the game starts with logging off, the addon turns it on quietly.
  wow.exec('__logging = false');
  wow.fire('PLAYER_LOGIN');
  assert.strictEqual(wow.eval('tostring(__logging)'), 'true');
  wow.slash('live off');
  assert.strictEqual(wow.eval('tostring(__logging)'), 'false');
  wow.fire('PLAYER_LOGIN');
  assert.strictEqual(wow.eval('tostring(__logging)'), 'false');
  assert.strictEqual(wow.eval('__ns.debugError'), null);
});

test('/wow live on without LoggingCombat says so', () => {
  const wow = new WowClient();
  wow.exec('LoggingCombat = nil');
  wow.login();
  wow.slash('live on');
  assert.match(wow.printed(), /can't write a combat log/);
  assert.strictEqual(wow.eval('__ns.debugError'), null);
});
