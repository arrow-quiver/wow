// The addon's Raids text (UI.lua ns.textRaids) for every sign-up status the app can send, run in the
// simulated game client (wowsim.js). Bench sign-ups are signed up, not missing.
const test = require('node:test');
const assert = require('node:assert');
const { WowClient } = require('./wowsim');

const NOW = () => Math.floor(Date.now() / 1000);

test('raids text: bench is shown as on the bench, unknown statuses as they are, only no sign-up asks to sign up', () => {
  const inbox = {
    guild: 'wow', generatedAt: NOW(),
    raids: [
      { title: 'Bench week', startsAt: NOW() + 86400, coming: 18, signup: 'bench', role: 'Tank' },
      { title: 'Bench no role', startsAt: NOW() + 2 * 86400, coming: 12, signup: 'bench' },
      { title: 'Odd status', startsAt: NOW() + 3 * 86400, coming: 4, signup: 'late' },
      { title: 'Empty status', startsAt: NOW() + 4 * 86400, coming: 2, signup: '' },
      { title: 'No sign-up', startsAt: NOW() + 5 * 86400, coming: 1 },
    ],
  };
  const wow = new WowClient({ inbox }).login();
  const raids = wow.eval('__ns.textRaids()');
  assert.match(raids, /Bench week {2}\|cff999999\w{3} \d\d \w{3} \d\d:\d\d, 18 coming\|r\n {4}\|cff999999you're on the bench\|r as Tank\n/);
  assert.match(raids, /Bench no role[^\n]*\n {4}\|cff999999you're on the bench\|r(\n|$)/);
  assert.match(raids, /Odd status[^\n]*\n {4}\|cff999999signed up: late\|r(\n|$)/);
  assert.match(raids, /Empty status[^\n]*\n {4}\|cffe8a33dnot signed up yet: sign up in the Guild Camp app\|r/);
  assert.match(raids, /No sign-up[^\n]*\n {4}\|cffe8a33dnot signed up yet: sign up in the Guild Camp app\|r/);
  assert.strictEqual((raids.match(/not signed up yet/g) || []).length, 2, 'bench and unknown statuses are not reported as missing');
  assert.strictEqual(wow.eval('__ns.debugError'), null, 'no addon errors');
});
