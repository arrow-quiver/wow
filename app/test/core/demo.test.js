'use strict';
// The demo guild for screenshot runs (--smoke --smoke-seed): every page's endpoint has data.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startCore } = require('./helpers');
const { loadDemo } = require('../../src/core/demo');
const { SMOKE_API_PATHS } = require('../../src/main/main');

test('the demo guild fills every page the smoke run looks at, without sending a notification', async () => {
  const c = await startCore();
  try {
    const { guildId, me } = await loadDemo(c.core);
    const session = c.core.session();
    assert.deepEqual([session.user.battletag, session.guild.name, session.role], ['Calvin#1234', 'Just Now WoW', 'owner']);
    assert.ok(guildId > 0 && me > 0);
    for (const p of SMOKE_API_PATHS) {
      const r = await c.api.get(p);
      assert.equal(r.status, 200, `${p}: ${JSON.stringify(r.body).slice(0, 200)}`);
    }
    const camp = (await c.api.get('/api/camp')).body;
    assert.ok(camp.online.length >= 5);
    assert.ok(camp.ctas.length >= 2);
    assert.ok(camp.raids.length >= 2);
    const raids = (await c.api.get('/api/raids')).body;
    assert.ok(raids.upcoming.some((r) => r.status === 'locked'));
    assert.ok(raids.past.some((r) => r.status === 'done'));
    const detail = (await c.api.get(`/api/raids/${raids.upcoming.find((r) => r.title === 'Molten Core, week 2').id}`)).body;
    assert.ok(detail.signups.length >= 6);
    assert.ok(detail.board.length >= 2);
    assert.ok((await c.api.get('/api/bank')).body.tabs.length === 4);
    assert.ok((await c.api.get('/api/prices')).body.held.length > 5);
    assert.ok((await c.api.get('/api/drives')).body.open.length === 2);
    assert.ok((await c.api.get('/api/coach')).body.plan.headline);
    assert.ok((await c.api.get('/api/members')).body.members.length >= 7);
    const roles = Object.fromEntries((await c.api.get('/api/members')).body.members.map((m) => [m.name, m.role]));
    assert.deepEqual([roles.Calvin, roles.Velanne, roles.Grom || roles.Mokra], ['owner', 'officer', 'member']);
    assert.deepEqual(c.events, [], 'loading the demo is quiet');
  } finally {
    await c.close();
  }
});
