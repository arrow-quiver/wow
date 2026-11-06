// The Coach: play style from the addon, Claude-written plans and answers, budgets and limits.
const test = require('node:test');
const assert = require('node:assert');
const dbm = require('../src/db');
const C = require('../src/coach');
const ai = require('../src/ai');
const { applyPayload, buildInbox } = require('../src/sync');
const { createApp, config } = require('../src/server');

const PLAN = {
  headline: 'Arms for world PvP: hit hard, stay mobile', summary: 'You start fights and like PvP, so go deep Arms for burst.', spec: 'Arms', split: '31/20/0 at 60',
  talents: [{ name: 'Improved Rend', tree: 'Arms', points: 3, why: 'Early damage' }, { name: 'Tactical Mastery', tree: 'Arms', points: 5, why: 'Keep rage on stance swap' }],
  stats: ['Strength', 'Hit', 'Crit'], gear: [{ slot: 'Weapon', advice: 'Slow two-hander for big Overpower hits' }],
  next_steps: [{ title: 'Spend your talent point', detail: 'Put it in Tactical Mastery' }], tips: ['Open with Charge from max range'], confidence: 'classic',
};

function fakeClaude() {
  const calls = [];
  let paused = false;
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push({ url, body, headers: opts.headers });
    const isAnswer = /120 words/.test(body.system);
    if (!isAnswer && !paused) { paused = true; return { ok: true, status: 200, json: async () => ({ stop_reason: 'pause_turn', content: [{ type: 'server_tool_use', name: 'web_search', input: { query: 'wow forever arms' } }], usage: { input_tokens: 1000, output_tokens: 10, server_tool_use: { web_search_requests: 1 } } }) }; }
    const text = isAnswer ? '**Take Deflection** for now — it’s better in duels.\n# Why\n* parry more' : JSON.stringify(PLAN);
    return { ok: true, status: 200, json: async () => ({ stop_reason: 'end_turn',
      content: [{ type: 'text', text, citations: [{ type: 'web_search_result_location', url: 'https://www.wowhead.com/forever/guide/arms', title: 'Arms guide' }] }],
      usage: { input_tokens: 2000, output_tokens: 300, server_tool_use: { web_search_requests: 1 } } }) };
  };
  return { calls, fetchImpl };
}

function setup() {
  const db = dbm.open(':memory:');
  const u = db.prepare("INSERT INTO users (bnet_id, battletag) VALUES ('a','J#1')").run().lastInsertRowid;
  const g = db.prepare("INSERT INTO guilds (name, invite_code) VALUES ('wow','i')").run().lastInsertRowid;
  db.prepare("INSERT INTO memberships (user_id, guild_id, role) VALUES (?,?,'owner')").run(u, g);
  return { db, u, g };
}
const coachPayload = (extra = {}) => ({
  coach: {
    chars: { Grom: { name: 'Grom', class: 'WARRIOR', level: 24, realm: 'Forever',
      profile: { scores: { aggression: 82, risk: 40, social: 30, pvp: 75, pace: 60 }, archetype: 'Warmonger', blurb: 'You go looking for fights.', minutes: 300, quiz: true },
      stats: { pullsPerHour: 41, deathsPerHour: 0.8 }, quiz: { aggression: 5, pvp: 4 },
      talents: { trees: [{ name: 'Arms', points: 15 }, { name: 'Fury', points: 0 }, { name: 'Protection', points: 0 }], unspent: 1, picked: [{ name: 'Improved Rend', rank: 3, max: 3 }] },
      gear: { items: [{ slot: 'MainHand', name: 'Bonebiter', ilvl: 30 }] } } },
    questions: [{ id: 'q1', char: 'Grom', text: 'Deflection or Improved Charge?', at: 1 }],
    ...extra,
  },
});

test('the addon\'s play style and questions are stored once; answers and plans come from Claude', async () => {
  const { db, u, g } = setup();
  applyPayload(db, g, u, coachPayload());
  applyPayload(db, g, u, coachPayload()); // same question twice: stored once
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM coach_qa').get().n, 1);
  assert.strictEqual(JSON.parse(db.prepare('SELECT profile FROM coach_chars').get().profile).archetype, 'Warmonger');

  const Cl = fakeClaude();
  const sent = [];
  const cfg = { anthropicKey: 'sk-test', claudeFetch: Cl.fetchImpl };
  C.setKeyPresent(true);
  assert.strictEqual(C.inboxPart(db, g, u).pending, 2, 'one question and one first plan waiting');
  const r = await C.processPending(db, cfg, { notify: (...a) => sent.push(a) });
  assert.deepStrictEqual({ answered: r.answered, plans: r.plans }, { answered: 1, plans: 1 });

  const qa = db.prepare('SELECT * FROM coach_qa').get();
  assert.strictEqual(qa.status, 'answered');
  assert.doesNotMatch(qa.answer, /\*\*|^#|’|—/m, 'plain text for the game');
  assert.match(qa.answer, /Take Deflection for now - it's better in duels/);
  assert.match(qa.answer, /^- parry more$/m);
  assert.strictEqual(JSON.parse(qa.sources)[0].url, 'https://www.wowhead.com/forever/guide/arms');
  assert.strictEqual(sent.length, 1); assert.deepStrictEqual(sent[0][3], { userIds: [u] });

  // Requests use the right models, web search, and the API's headers.
  const answerCall = Cl.calls.find((c) => /120 words/.test(c.body.system));
  assert.strictEqual(answerCall.body.model, 'claude-haiku-5-5');
  assert.strictEqual(answerCall.headers['anthropic-version'], '2023-06-01');
  assert.strictEqual(answerCall.body.tools[0].type, 'web_search_20250305');
  assert.match(answerCall.body.messages[0].content, /Play style \(0-100\): aggression 82/);
  assert.match(answerCall.body.messages[0].content, /Talents: Arms 15 \/ Fury 0 \/ Protection 0, 1 unspent/);
  const planCalls = Cl.calls.filter((c) => !/120 words/.test(c.body.system));
  assert.strictEqual(planCalls.length, 2, 'paused search turn was resumed');
  assert.strictEqual(planCalls[1].body.messages[1].role, 'assistant');
  assert.strictEqual(planCalls[0].body.model, 'claude-sonnet-5-5');

  const plan = JSON.parse(db.prepare('SELECT plan FROM coach_chars').get().plan);
  assert.strictEqual(plan.spec, 'Arms'); assert.strictEqual(plan.talents.length, 2); assert.strictEqual(plan.level, 24);
  // Costs are metered: plan = 3000 in/310 out on Sonnet + 2 searches.
  const usage = db.prepare('SELECT kind, cost_usd FROM ai_usage ORDER BY id').all();
  assert.strictEqual(usage.length, 2);
  const planCost = usage.find((x) => x.kind === 'plan').cost_usd;
  assert.ok(Math.abs(planCost - ((3000 * 2 + 310 * 10) / 1e6 + 0.02)) < 1e-9, String(planCost));

  // The game gets the plan and the answer; nothing is pending any more.
  const inbox = buildInbox(db, g, u);
  assert.strictEqual(inbox.coach.plans.Grom.headline, PLAN.headline);
  assert.strictEqual(inbox.coach.answers[0].qid, 'q1');
  assert.strictEqual(inbox.coach.pending, 0);

  // Asking for a fresh plan in game queues one; three more levels does too.
  applyPayload(db, g, u, coachPayload({ chars: { Grom: { name: 'Grom', planRequest: Math.floor(Date.now() / 1000) + 5 } }, questions: [] }));
  assert.strictEqual(C.inboxPart(db, g, u).pending, 1);
});

test('budget, daily limits, and a missing key give clear answers instead of silence', async () => {
  const { db, u, g } = setup();
  applyPayload(db, g, u, coachPayload());
  C.setKeyPresent(false);
  await C.processPending(db, { anthropicKey: '' });
  assert.match(db.prepare('SELECT error FROM coach_qa').get().error, /no Claude API key/);

  db.prepare('UPDATE guilds SET coach_budget_usd = 1').run();
  db.prepare("INSERT INTO ai_usage (guild_id, user_id, kind, cost_usd) VALUES (?,?, 'plan', 1.5)").run(g, u);
  assert.match(C.guard(db, g, u, 'question'), /budget for this month is used up/);
  db.prepare('UPDATE guilds SET coach_budget_usd = 100').run();
  for (let i = 0; i < C.LIMITS.questionsPerDay; i++) db.prepare("INSERT INTO ai_usage (guild_id, user_id, kind, cost_usd) VALUES (?,?, 'question', 0)").run(g, u);
  assert.match(C.guard(db, g, u, 'question'), /today's limit of 30 questions/);
  db.prepare('UPDATE guilds SET coach_enabled = 0').run();
  assert.match(C.guard(db, g, u, 'plan'), /switched off/);
  assert.throws(() => C.cleanPlan('no json here', 10, 'm'), /didn't return a plan/);
});

test('Coach page: instant answers on the website, officer settings', async () => {
  const db = dbm.open(':memory:');
  const Cl = fakeClaude();
  const cfg = { ...config({}), devLogin: true, timers: false, anthropicKey: 'sk-test', claudeFetch: Cl.fetchImpl, pushSend: async () => {} };
  const app = createApp(cfg, db);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const url = `http://127.0.0.1:${srv.address().port}`;
  try {
    const res = await fetch(`${url}/login/dev`, { method: 'POST', body: new URLSearchParams({ battletag: 'Owner#1' }), redirect: 'manual' });
    const cookie = res.headers.get('set-cookie').split(';')[0];
    const csrf = /name="_csrf" value="([^"]+)"/.exec(await (await fetch(`${url}/`, { headers: { cookie } })).text())[1];
    const post = (p, body) => fetch(url + p, { method: 'POST', headers: { cookie }, body: new URLSearchParams({ _csrf: csrf, ...body }), redirect: 'manual' });
    const get = async (p) => (await fetch(url + p, { headers: { cookie } })).text();
    await post('/guild/create', { name: 'wow', faction: 'Horde' });
    assert.match(await get('/coach'), /Getting started/);
    const gid = db.prepare('SELECT id FROM guilds').get().id; const uid = db.prepare('SELECT id FROM users').get().id;
    applyPayload(db, gid, uid, coachPayload({ questions: [] }));
    let page = await get('/coach');
    assert.match(page, /Warmonger/);
    assert.match(page, /aria-valuenow="82"/);
    const asked = await post('/coach/ask', { question: 'Best place to level at 24?', char: 'Grom' });
    assert.strictEqual(asked.status, 302);
    page = await get('/coach?char=Grom');
    assert.match(page, /Best place to level at 24\?/);
    assert.match(page, /Take Deflection for now/);
    await post('/coach/plan', { char: 'Grom' });
    page = await get('/coach?char=Grom');
    assert.match(page, /Arms for world PvP/);
    assert.match(page, /class="is-done">\s*<strong>Improved Rend/, 'talents already taken are ticked');
    assert.match(await get('/settings'), /Coach \(Claude AI\)/);
    await post('/settings/coach', { budget: '25' });
    assert.deepStrictEqual({ ...db.prepare('SELECT coach_enabled, coach_budget_usd FROM guilds').get() }, { coach_enabled: 0, coach_budget_usd: 25 });
  } finally { srv.close(); }
});

test('the companion keeps checking until the Coach has answered, then saves the inbox', async () => {
  const http = require('http'); const fs = require('fs'); const os = require('os'); const path = require('path');
  const { followCoach } = require('../../companion/companion');
  let calls = 0;
  const srv = http.createServer((req, res) => {
    if (req.url === '/api/inbox') { calls += 1; res.end(JSON.stringify({ coach: { pending: calls < 3 ? 1 : 0 } })); return; }
    if (req.url === '/api/inbox.lua') { res.end('WowGuildInbox = { coach = { answers = { { q = "hi", a = "hello" } } } }\n'); return; }
    res.statusCode = 404; res.end('{}');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const game = fs.mkdtempSync(path.join(os.tmpdir(), 'game-'));
  try {
    const ok = await followCoach({ siteUrl: `http://127.0.0.1:${srv.address().port}`, syncKey: 'wowg_x' }, game, { every: 5, tries: 10 });
    assert.strictEqual(ok, true);
    assert.strictEqual(calls, 3);
    assert.match(fs.readFileSync(path.join(game, 'Interface', 'AddOns', 'WowGuild', 'Data', 'Inbox.lua'), 'utf8'), /hello/);
  } finally { srv.close(); }
});
