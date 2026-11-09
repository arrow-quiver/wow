'use strict';
// The Coach: play style from the addon, Claude-written plans and answers (a stand-in for the Claude API
// through the core's fetch), budgets and daily limits, the JSON endpoints the app's Coach page uses, the
// background pass, and the round trip through the game. The Anthropic key is the player's own (Settings).
const test = require('node:test');
const assert = require('node:assert');
const { startCore, seedGuild, addPlayer } = require('./helpers');
const C = require('../../src/core/services/coach');
const { applyPayload, buildInbox } = require('../../src/core/services/sync');
const { parseSavedVariables } = require('../../src/shared/lua');

const PLAN = {
  headline: 'Arms for world PvP: hit hard, stay mobile', summary: 'You start fights and like PvP, so go deep Arms for burst.', spec: 'Arms', split: '31/20/0 at 60',
  talents: [{ name: 'Improved Rend', tree: 'Arms', points: 3, why: 'Early damage' }, { name: 'Tactical Mastery', tree: 'Arms', points: 5, why: 'Keep rage on stance swap' }],
  stats: ['Strength', 'Hit', 'Crit'], gear: [{ slot: 'Weapon', advice: 'Slow two-hander for big Overpower hits' }],
  next_steps: [{ title: 'Spend your talent point', detail: 'Put it in Tactical Mastery' }], tips: ['Open with Charge from max range'], confidence: 'classic',
};
const ANSWER = '**Take Deflection** for now — it’s better in duels.\n# Why\n* parry more';
const ALLOWED = ['wowhead.com', 'warcraft.wiki.gg', 'worldofwarcraft.blizzard.com', 'icy-veins.com', 'reddit.com'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, what, ms = 4000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(15);
  }
}

// A stand-in for the Claude Messages API. The first plan request pauses mid-search (pause_turn) so the
// client has to resume it. `delay` slows every reply; `failPlans` makes plan requests fail with a 500.
function fakeClaude({ delay = 0, failPlans = false } = {}) {
  const calls = [];
  let paused = false;
  const reply = (status, data) => ({ ok: status < 400, status, json: async () => data });
  const fetchImpl = async (url, opts = {}) => {
    if (!String(url).startsWith('https://api.anthropic.com/')) return reply(204, {}); // Discord and the like
    const body = JSON.parse(opts.body);
    calls.push({ url, body, headers: opts.headers });
    if (delay) await sleep(delay);
    const isAnswer = /120 words/.test(body.system);
    if (!isAnswer && failPlans) return reply(500, { error: { message: 'overloaded' } });
    if (!isAnswer && !paused) {
      paused = true;
      return reply(200, { stop_reason: 'pause_turn', content: [{ type: 'server_tool_use', name: 'web_search', input: { query: 'wow forever arms' } }],
        usage: { input_tokens: 1000, output_tokens: 10, server_tool_use: { web_search_requests: 1 } } });
    }
    const text = isAnswer ? ANSWER : JSON.stringify(PLAN);
    return reply(200, { stop_reason: 'end_turn',
      content: [{ type: 'text', text, citations: [
        { type: 'web_search_result_location', url: 'https://www.wowhead.com/forever/guide/arms', title: 'Arms guide' },
        { type: 'web_search_result_location', url: 'javascript:alert(1)', title: 'Not a web link' },
      ] }],
      usage: { input_tokens: 2000, output_tokens: 300, server_tool_use: { web_search_requests: 1 } } });
  };
  const answers = () => calls.filter((c) => /120 words/.test(c.body.system));
  const plans = () => calls.filter((c) => !/120 words/.test(c.body.system));
  return { calls, fetchImpl, answers, plans };
}

const coachPayload = (extra = {}) => ({
  coach: {
    chars: { Grom: { name: 'Grom', class: 'WARRIOR', level: 24, realm: 'Forever',
      profile: { scores: { aggression: 82, risk: 40, social: 30, pvp: 75, pace: 60 }, archetype: 'Warmonger', blurb: 'You go looking for fights.', minutes: 300, quiz: true },
      stats: { pullsPerHour: 41, deathsPerHour: 0.8 }, quiz: { aggression: 5, pvp: 4 },
      talents: { trees: [{ name: 'Arms', points: 15 }, { name: 'Fury', points: 0 }, { name: 'Protection', points: 0 }], unspent: 1, picked: [{ name: 'Improved Rend', rank: 3, max: 3 }] },
      gear: { items: [{ slot: 'MainHand', name: 'Bonebiter', ilvl: 30 }], lowestDurability: 80, freeSlots: 12 } } },
    questions: [{ id: 'q1', char: 'Grom', text: 'Deflection or Improved Charge?', at: 1 }],
    ...extra,
  },
});

// A core with the player's key and a stand-in Claude; a guild where I am the Guild Master; a guildmate.
async function setup({ claude, key = 'sk-test', timers = false, coachWaitMs } = {}) {
  const Cl = claude || fakeClaude();
  const srv = await startCore({ secrets: key ? { anthropicKey: key } : {}, fetch: Cl.fetchImpl, timers, coachWaitMs });
  const g = seedGuild(srv.db, { role: 'owner' });
  const other = addPlayer(srv.db, g.guildId, 'Jaina#2222', { role: 'officer' });
  return { srv, g, u: g.me, other, Cl, owner: srv.api };
}
// The coach notifications shown to me.
const coachEvents = (srv) => srv.events.filter((e) => e.kind === 'coach');

test('the addon\'s play style and questions are stored once; the background pass answers and plans with Claude', async (t) => {
  const { srv, g: G, u, Cl } = await setup();
  t.after(() => srv.close());
  const { db } = srv;
  const g = G.guildId;
  applyPayload(db, g, u, coachPayload());
  applyPayload(db, g, u, coachPayload()); // same question twice: stored once
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM coach_qa').get().n, 1);
  assert.strictEqual(JSON.parse(db.prepare('SELECT profile FROM coach_chars').get().profile).archetype, 'Warmonger');

  assert.strictEqual(C.inboxPart(db, g, u).pending, 2, 'one question and one first plan waiting');
  const r = await srv.ctx.services.coach.run();
  assert.deepStrictEqual({ answered: r.answered, plans: r.plans, failed: r.failed }, { answered: 1, plans: 1, failed: 0 });

  const qa = db.prepare('SELECT * FROM coach_qa').get();
  assert.strictEqual(qa.status, 'answered');
  assert.doesNotMatch(qa.answer, /\*\*|^#|’|—/m, 'plain text for the game');
  assert.match(qa.answer, /Take Deflection for now - it's better in duels/);
  assert.match(qa.answer, /^- parry more$/m);
  assert.strictEqual(JSON.parse(qa.sources)[0].url, 'https://www.wowhead.com/forever/guide/arms');

  // Both finished in the background, so I hear about each in the app.
  const evs = coachEvents(srv);
  assert.deepStrictEqual(evs.map((e) => [e.title, e.route]), [
    ['The Coach answered', '/coach'],
    ['Your build plan for Grom is ready', '/coach'],
  ]);
  assert.strictEqual(evs[0].body, 'Deflection or Improved Charge?: Take Deflection for now - it\'s better in duels.', 'the question, then the first line of the answer');
  assert.strictEqual(evs[1].body, PLAN.headline);

  // Requests use the right models, web search limited to the old sites, and the API's headers.
  const answerCall = Cl.answers()[0];
  assert.strictEqual(answerCall.url, 'https://api.anthropic.com/v1/messages');
  assert.strictEqual(answerCall.body.model, 'claude-haiku-5-5');
  assert.strictEqual(answerCall.headers['anthropic-version'], '2023-06-01');
  assert.strictEqual(answerCall.headers['x-api-key'], 'sk-test');
  assert.strictEqual(answerCall.body.tools[0].type, 'web_search_20250305');
  assert.strictEqual(answerCall.body.tools[0].max_uses, 2);
  assert.deepStrictEqual(answerCall.body.tools[0].allowed_domains, ALLOWED);
  assert.match(answerCall.body.messages[0].content, /Play style \(0-100\): aggression 82/);
  assert.match(answerCall.body.messages[0].content, /Talents: Arms 15 \/ Fury 0 \/ Protection 0, 1 unspent/);
  const planCalls = Cl.plans();
  assert.strictEqual(planCalls.length, 2, 'paused search turn was resumed');
  assert.strictEqual(planCalls[1].body.messages[1].role, 'assistant');
  assert.strictEqual(planCalls[0].body.model, 'claude-sonnet-5-5');
  assert.strictEqual(planCalls[0].body.tools[0].max_uses, 4);

  const plan = JSON.parse(db.prepare('SELECT plan FROM coach_chars').get().plan);
  assert.strictEqual(plan.spec, 'Arms'); assert.strictEqual(plan.talents.length, 2); assert.strictEqual(plan.level, 24);
  // Costs are metered: plan = 3000 in / 310 out on Sonnet + 2 searches.
  const usage = db.prepare('SELECT kind, cost_usd FROM ai_usage ORDER BY id').all();
  assert.strictEqual(usage.length, 2);
  const planCost = usage.find((x) => x.kind === 'plan').cost_usd;
  assert.ok(Math.abs(planCost - ((3000 * 2 + 310 * 10) / 1e6 + 0.02)) < 1e-9, String(planCost));

  // The game gets the plan and the answer; nothing is pending any more.
  const inbox = buildInbox(db, g, u);
  assert.strictEqual(inbox.coach.plans.Grom.headline, PLAN.headline);
  assert.strictEqual(inbox.coach.plans.Grom.sources, undefined, 'sources stay out of the game');
  assert.strictEqual(inbox.coach.answers[0].qid, 'q1');
  assert.strictEqual(inbox.coach.pending, 0);
  assert.deepStrictEqual(await srv.ctx.services.coach.run(), { answered: 0, plans: 0, failed: 0 }, 'nothing left to do');

  // Asking for a fresh plan in game queues one.
  applyPayload(db, g, u, coachPayload({ chars: { Grom: { name: 'Grom', planRequest: Math.floor(Date.now() / 1000) + 5 } }, questions: [] }));
  assert.strictEqual(C.inboxPart(db, g, u).pending, 1);
});

test('budget, daily limits and a missing key give clear answers instead of silence', async (t) => {
  // No key: questions from the game fail with a clear reason; the app is told before anything is stored.
  const bare = await setup({ key: null });
  t.after(() => bare.srv.close());
  applyPayload(bare.srv.db, bare.g.guildId, bare.u, coachPayload());
  const r = await bare.srv.ctx.services.coach.run();
  assert.strictEqual(r.failed, 1);
  assert.match(bare.srv.db.prepare('SELECT error FROM coach_qa').get().error, /Add your Anthropic API key in Settings/);
  assert.strictEqual(C.inboxPart(bare.srv.db, bare.g.guildId, bare.u).pending, 0, 'no plan counts as on its way without a key');
  const o = bare.owner;
  let res = await o.get('/api/coach');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.ai.available, false);
  assert.strictEqual(res.body.ai.hasKey, false);
  assert.match(res.body.ai.reason, /Add your Anthropic API key in Settings/);
  assert.strictEqual(res.body.character.profile.archetype, 'Warmonger', 'play style still works');
  assert.strictEqual(res.body.planBusy, false);
  res = await o.post('/api/coach/ask', { question: 'Hello?' });
  assert.strictEqual(res.status, 503);
  assert.match(res.body.error, /Add your Anthropic API key in Settings/);
  res = await o.post('/api/coach/plan', { char: 'Grom' });
  assert.strictEqual(res.status, 503);
  assert.strictEqual(bare.srv.db.prepare('SELECT COUNT(*) n FROM coach_qa').get().n, 1, 'refused questions are not stored');
  // The key is read live: adding it in Settings turns the AI on without a restart.
  bare.srv.secrets.anthropicKey = 'sk-added-later';
  res = await o.get('/api/coach');
  assert.deepStrictEqual([res.body.ai.hasKey, res.body.ai.available], [true, true]);

  // With a key: budget, then the daily limits, then switched off.
  const { srv, g: G, u, Cl, owner, other } = await setup();
  t.after(() => srv.close());
  const { db } = srv; const g = G.guildId;
  applyPayload(db, g, u, coachPayload({ questions: [] }));
  db.prepare('UPDATE guilds SET coach_budget_usd = 1').run();
  db.prepare("INSERT INTO ai_usage (guild_id, user_id, kind, cost_usd) VALUES (?,?, 'plan', 1.5)").run(g, other.id);
  assert.match(C.guard(db, g, u, 'question'), /budget for this month is used up/);
  res = await owner.get('/api/coach');
  assert.deepStrictEqual([res.body.ai.available, res.body.ai.budgetLeft], [false, false]);
  assert.match(res.body.ai.reason, /budget for this month is used up\. You can raise it in Guild settings\./);
  res = await owner.post('/api/coach/ask', { question: 'Hello?' });
  assert.strictEqual(res.status, 403);
  assert.match(res.body.error, /budget for this month is used up/);

  db.prepare('UPDATE guilds SET coach_budget_usd = 100').run();
  for (let i = 0; i < C.LIMITS.questionsPerDay; i++) db.prepare("INSERT INTO ai_usage (guild_id, user_id, kind, cost_usd) VALUES (?,?, 'question', 0)").run(g, u);
  assert.match(C.guard(db, g, u, 'question'), /today's limit of 30 questions/);
  res = await owner.post('/api/coach/ask', { question: 'Hello?' });
  assert.strictEqual(res.status, 403);
  assert.strictEqual(res.body.error, 'You\'ve reached today\'s limit of 30 questions. It resets at midnight (UTC).');
  res = await owner.get('/api/coach');
  assert.strictEqual(res.body.limits.questionsLeft, 0);
  assert.strictEqual(res.body.ai.available, true, 'the guild can still use it; only this member is out of questions');
  for (let i = 0; i < C.LIMITS.plansPerDay; i++) db.prepare("INSERT INTO ai_usage (guild_id, user_id, kind, cost_usd) VALUES (?,?, 'plan', 0)").run(g, u);
  res = await owner.post('/api/coach/plan', { char: 'Grom' });
  assert.strictEqual(res.status, 403);
  assert.match(res.body.error, /today's limit of 5 build plans/);

  db.prepare('UPDATE guilds SET coach_enabled = 0').run();
  assert.match(C.guard(db, g, u, 'plan'), /switched off/);
  res = await owner.get('/api/coach');
  assert.deepStrictEqual([res.body.ai.available, res.body.ai.enabled], [false, false]);
  assert.match(res.body.ai.reason, /switched off in Guild settings/);
  assert.throws(() => C.cleanPlan('no json here', 10, 'm'), /didn't return a plan/);
  assert.strictEqual(Cl.calls.length, 0, 'nothing was sent to Claude');
});

test('Coach endpoints: instant answers, plans with ticked talents, limits and spending', async (t) => {
  const { srv, g, u, owner, other } = await setup();
  t.after(() => srv.close());
  const { db } = srv;

  let res = await owner.get('/api/coach');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body.characters, []);
  assert.strictEqual(res.body.character, null);
  assert.strictEqual(res.body.plan, null);
  assert.deepStrictEqual(res.body.nextSteps, []);
  assert.deepStrictEqual(res.body.limits, { questionsPerDay: 30, plansPerDay: 5, questionsLeft: 30, plansLeft: 5 });
  assert.deepStrictEqual(res.body.ai, { available: true, hasKey: true, enabled: true, budgetLeft: true, reason: null });

  applyPayload(db, g.guildId, u, coachPayload({ questions: [] }));
  res = await owner.get('/api/coach');
  const ch = res.body.character;
  assert.deepStrictEqual(res.body.characters.map((c) => [c.name, c.class, c.level, c.archetype, c.hasPlan]), [['Grom', 'WARRIOR', 24, 'Warmonger', false]]);
  assert.deepStrictEqual([ch.name, ch.class, ch.level, ch.realm], ['Grom', 'WARRIOR', 24, 'Forever']);
  assert.strictEqual(ch.profile.scores.aggression, 82);
  assert.strictEqual(ch.profile.blurb, 'You go looking for fights.');
  assert.strictEqual(ch.talents.unspent, 1);
  assert.strictEqual(ch.gear.items[0].name, 'Bonebiter');
  assert.deepStrictEqual(res.body.nextSteps, [{ kind: 'talent', title: 'Spend 1 talent point', detail: 'Open your talents in game (N).' }]);

  // Asked in the app: answered while the member waits, so no notification.
  res = await owner.post('/api/coach/ask', { question: '  Best place to level at 24?  ', char: 'Grom' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.message, 'The Coach answered.');
  const q = res.body.question;
  assert.deepStrictEqual([q.status, q.source, q.char_name, q.question], ['answered', 'app', 'Grom', 'Best place to level at 24?']);
  assert.match(q.answer, /Take Deflection for now/);
  assert.deepStrictEqual(q.sources, [{ url: 'https://www.wowhead.com/forever/guide/arms', title: 'Arms guide' }], 'only web links');
  assert.strictEqual(coachEvents(srv).length, 0);

  res = await owner.post('/api/coach/plan', { char: 'Grom' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.status, 'ready');
  assert.match(res.body.message, /reaches the game after your next sync/);
  assert.strictEqual(res.body.plan.spec, 'Arms');
  assert.deepStrictEqual(res.body.plan.talents.map((x) => [x.name, x.taken, x.rank]), [['Improved Rend', true, 3], ['Tactical Mastery', false, null]]);
  assert.strictEqual(coachEvents(srv).length, 0);

  res = await owner.get('/api/coach?char=grom');
  assert.strictEqual(res.body.character.name, 'Grom', 'names match without minding case');
  assert.strictEqual(res.body.plan.headline, PLAN.headline);
  assert.strictEqual(res.body.plan.level, 24);
  assert.strictEqual(res.body.plan.talents[0].taken, true, 'talents already taken are ticked');
  assert.strictEqual(res.body.plan.sources.length, 1);
  assert.strictEqual(res.body.planBusy, false);
  assert.ok(res.body.character.plan_at);
  assert.deepStrictEqual(res.body.nextSteps.map((x) => [x.kind, x.title, x.detail]), [
    ['talent', 'Spend 1 talent point', 'Your plan says: Tactical Mastery (Arms).'],
    ['plan', 'Spend your talent point', 'Put it in Tactical Mastery'],
  ]);
  assert.deepStrictEqual(res.body.limits, { questionsPerDay: 30, plansPerDay: 5, questionsLeft: 29, plansLeft: 4 });
  assert.strictEqual(res.body.questions[0].question, 'Best place to level at 24?');
  assert.strictEqual(res.body.characters[0].hasPlan, true);

  // The key and the budget are mine, so I see what the Coach cost this month, whatever my rank.
  assert.strictEqual(res.body.usage.budgetUsd, 15);
  assert.deepStrictEqual([res.body.usage.questions, res.body.usage.plans], [1, 1]);
  assert.ok(res.body.usage.spentUsd > 0);
  assert.match(res.body.usage.month, /^\d{4}-\d{2}$/);
  // A guildmate's Coach characters are theirs: I never see them.
  applyPayload(db, g.guildId, other.id, coachPayload({ questions: [], chars: { Jainy: { name: 'Jainy', class: 'MAGE', level: 30 } } }));
  res = await owner.get('/api/coach');
  assert.deepStrictEqual(res.body.characters.map((c) => c.name), ['Grom'], 'only my own characters');
  res = await owner.post('/api/coach/plan', { char: 'Jainy' });
  assert.strictEqual(res.status, 200, 'an unknown name falls back to my own character');
  assert.strictEqual(res.body.char, 'Grom');

  // Switching the AI off in Guild settings: the Coach page says so.
  res = await owner.put('/api/guild/settings', { coach_enabled: false });
  assert.strictEqual(res.status, 200);
  res = await owner.get('/api/coach');
  assert.deepStrictEqual([res.body.ai.available, res.body.ai.enabled], [false, false]);
  res = await owner.post('/api/coach/ask', { question: 'Still there?' });
  assert.strictEqual(res.status, 403);
  assert.strictEqual(res.body.error, 'The Coach\'s AI answers are switched off in Guild settings.');
});

test('slow answers and plans finish in the background and send a coach event', async (t) => {
  const Cl = fakeClaude({ delay: 120 });
  const { srv, g, u, owner } = await setup({ claude: Cl, coachWaitMs: 10 });
  t.after(() => srv.close());
  const { db } = srv;
  applyPayload(db, g.guildId, u, coachPayload({ questions: [] }));
  // An older plan, so the background pass has no plan of its own to write.
  db.prepare("UPDATE coach_chars SET plan = ?, plan_level = level, plan_at = datetime('now', '-1 minute')").run(JSON.stringify({ headline: 'Old plan', talents: [] }));

  let res = await owner.post('/api/coach/ask', { question: 'Where do I farm Thorium?', char: 'Grom' });
  assert.strictEqual(res.status, 202);
  assert.strictEqual(res.body.question.status, 'pending');
  assert.match(res.body.message, /still thinking/);
  // The background pass leaves a question that a request is already waiting on alone.
  const r = await srv.ctx.services.coach.run();
  assert.strictEqual(r.answered, 0);
  res = await owner.get('/api/coach');
  assert.strictEqual(res.body.questions[0].status, 'pending');

  const answered = await waitFor(() => coachEvents(srv).find((e) => e.title === 'The Coach answered'), 'the answer event');
  assert.strictEqual(answered.body, 'Where do I farm Thorium?: Take Deflection for now - it\'s better in duels.');
  res = await owner.get('/api/coach');
  assert.strictEqual(res.body.questions[0].status, 'answered');
  assert.strictEqual(Cl.answers().length, 1, 'answered once');

  // Plans: pending while Claude writes, a second press joins the same request, an event when it's done.
  res = await owner.post('/api/coach/plan', { char: 'Grom' });
  assert.strictEqual(res.status, 202);
  assert.deepStrictEqual([res.body.status, res.body.char], ['pending', 'Grom']);
  res = await owner.get('/api/coach');
  assert.strictEqual(res.body.planBusy, true);
  res = await owner.post('/api/coach/plan', { char: 'Grom' });
  assert.strictEqual(res.status, 202);
  const ready = await waitFor(() => coachEvents(srv).find((e) => /build plan/.test(e.title)), 'the plan event');
  assert.strictEqual(ready.title, 'Your build plan for Grom is ready');
  assert.strictEqual(ready.body, PLAN.headline);
  res = await owner.get('/api/coach');
  assert.strictEqual(res.body.planBusy, false);
  assert.strictEqual(res.body.plan.spec, 'Arms');
  assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM ai_usage WHERE kind = 'plan'").get().n, 1, 'one plan paid for');
  assert.strictEqual(Cl.plans().length, 2, 'one request (resumed once after the paused search)');
});

test('a plan that fails in the background tells the member; one that fails at once is an error', async (t) => {
  const slow = await setup({ claude: fakeClaude({ delay: 60, failPlans: true }), coachWaitMs: 5 });
  t.after(() => slow.srv.close());
  applyPayload(slow.srv.db, slow.g.guildId, slow.u, coachPayload({ questions: [] }));
  let res = await slow.owner.post('/api/coach/plan', {});
  assert.strictEqual(res.status, 202);
  const ev = await waitFor(() => coachEvents(slow.srv)[0], 'the failure event');
  assert.strictEqual(ev.title, 'Your build plan for Grom couldn\'t be made');
  assert.match(ev.body, /Claude API 500: overloaded/);

  const quick = await setup({ claude: fakeClaude({ failPlans: true }) });
  t.after(() => quick.srv.close());
  applyPayload(quick.srv.db, quick.g.guildId, quick.u, coachPayload({ questions: [] }));
  res = await quick.owner.post('/api/coach/plan', { char: 'Grom' });
  assert.strictEqual(res.status, 502);
  assert.match(res.body.error, /Claude API 500: overloaded/);
  assert.strictEqual(coachEvents(quick.srv).length, 0);
  res = await quick.owner.get('/api/coach');
  assert.strictEqual(res.body.plan, null);
});

test('next steps come from the synced character, its professions, raids and the plan', async (t) => {
  const { srv, g, u, owner } = await setup();
  t.after(() => srv.close());
  const { db } = srv;
  const payload = coachPayload({ questions: [] });
  const grom = payload.coach.chars.Grom;
  grom.level = 40;
  grom.quiz = null;
  grom.profile.quiz = false;
  grom.talents.unspent = 2;
  grom.gear.lowestDurability = 12;
  grom.gear.freeSlots = 1;
  payload.characters = { Grom: { name: 'Grom', class: 'WARRIOR', level: 40, professions: [
    { name: 'Blacksmithing', skill: 90, max: 225 },
    { name: 'Mining', skill: 190, max: 225 },
    { name: 'Fishing', skill: 1, max: 150 },
  ] } };
  applyPayload(db, g.guildId, u, payload);
  const soon = new Date(Date.now() + 2 * 86400000).toISOString();
  const raid = db.prepare("INSERT INTO raids (guild_id, title, instance, starts_at) VALUES (?, 'Molten Core', 'Molten Core', ?)").run(g.guildId, soon).lastInsertRowid;
  db.prepare("INSERT INTO raids (guild_id, title, instance, starts_at, status) VALUES (?, 'Old raid', 'Onyxia', ?, 'cancelled')").run(g.guildId, soon);

  let res = await owner.get('/api/coach');
  assert.deepStrictEqual(res.body.nextSteps, [
    { kind: 'talent', title: 'Spend 2 talent points', detail: 'Open your talents in game (N).' },
    { kind: 'repair', title: 'Repair your gear', detail: 'Something is down to 12% durability.' },
    { kind: 'bags', title: 'Make bag space', detail: 'Only 1 free bag slot. Vendor grey items or bank what you don\'t need.' },
    { kind: 'prof', title: 'Blacksmithing is behind your level', detail: '90 of about 200. The skill-up guide in game shows what to make.' },
    { kind: 'quiz', title: 'Tell the Coach how you play', detail: 'Five quick questions. In game, type /wow coach and press \'Tune my style\'.' },
    { kind: 'raid', title: 'Sign up: Molten Core', detail: 'Pick a character and role in Guild Camp.', route: `/raids/${raid}`, at: soon },
  ]);
  db.prepare("INSERT INTO signups (raid_id, user_id, character, role, status) VALUES (?, ?, 'Grom', 'tank', 'yes')").run(raid, u);
  res = await owner.get('/api/coach');
  assert.ok(!res.body.nextSteps.some((x) => x.kind === 'raid'), 'signed up already');
});

test('the game round trip: play in game, upload, see it in the app, Claude answers, back into the game', async (t) => {
  const { WowClient } = require('./wowsim');
  const GAME = `
DUEL_WINNER_KNOCKOUT = "%1$s has defeated %2$s in a duel"
DUEL_WINNER_RETREAT = "%2$s has fled from %1$s in a duel"
__t = 1000
function GetTime() return __t end
function GetRealmName() return "Forever" end
function UnitIsPVP() return __flagged == true end
function GetPVPLifetimeStats() return __hk or 0, 0, 0 end
function GetNumTalentTabs() return 3 end
local tabs = { {"Elemental", 0}, {"Enhancement", 11}, {"Restoration", 0} }
function GetTalentTabInfo(i) return tabs[i][1], "icon", tabs[i][2], "bg" end
function GetNumTalents(tab) return tab == 2 and 2 or 0 end
function GetTalentInfo(tab, i) if i == 1 then return "Ancestral Knowledge", "icon", 1, 1, 5, 5 else return "Shield Specialization", "icon", 1, 2, 0, 5 end end
function UnitCharacterPoints() return 1 end
function GetInventoryItemLink(_, slot) if slot == 16 then return "|cff1eff00|Hitem:15223::|h[Big Stick]|h|r" end end
function GetItemInfo() return "Big Stick", nil, 2, 25 end
`;
  const wow = new WowClient({ inbox: { guild: 'wow', generatedAt: 1, coach: { plans: {}, answers: [], pending: 0, enabled: true } } });
  wow.exec(GAME);
  wow.login();
  wow.exec('__flagged = true');
  for (let i = 0; i < 120; i++) {
    if (i % 4 === 0) wow.exec('__fire("PLAYER_REGEN_DISABLED"); __t = __t + 20; __fire("PLAYER_REGEN_ENABLED")');
    wow.exec('__ns.coach.sample()');
  }
  wow.exec('__ns.coach.saveQuiz({ aggression = 5, risk = 2, social = 1, pvp = 5, pace = 3, role = "Damage", goal = "World PvP" })');
  wow.exec('__ns.coach.ask("Enhancement or Elemental for world PvP?")');
  wow.logout();
  assert.strictEqual(wow.eval('__ns.debugError'), null);

  // The app uploads the SavedVariables; the core stores the style and the question.
  const sv = parseSavedVariables(wow.saveVariablesBuffer()).WowGuildDB;
  const { srv, g, u, Cl, owner } = await setup();
  t.after(() => srv.close());
  const stats = applyPayload(srv.db, g.guildId, u, sv);
  assert.deepStrictEqual(stats.coach, { chars: 1, questions: 1 });

  let res = await owner.get('/api/coach');
  const ch = res.body.character;
  assert.deepStrictEqual([ch.name, ch.class, ch.level], ['Thrallia', 'SHAMAN', 23]);
  assert.strictEqual(ch.profile.archetype, 'Warmonger');
  assert.strictEqual(ch.talents.picked[0].name, 'Ancestral Knowledge');
  assert.strictEqual(ch.gear.items[0].name, 'Big Stick');
  assert.strictEqual(ch.quiz.goal, 'World PvP');
  assert.deepStrictEqual([res.body.questions[0].source, res.body.questions[0].status, res.body.questions[0].char_name], ['game', 'pending', 'Thrallia']);
  assert.strictEqual(res.body.nextSteps[0].title, 'Spend 1 talent point');

  // The background pass answers it and writes the first plan; I am told in the app.
  const r = await srv.ctx.services.coach.run();
  assert.deepStrictEqual([r.answered, r.plans], [1, 1]);
  assert.match(Cl.answers()[0].body.messages[0].content, /Question: Enhancement or Elemental for world PvP\?/);
  assert.match(Cl.answers()[0].body.messages[0].content, /Talents: Elemental 0 \/ Enhancement 11 \/ Restoration 0, 1 unspent/);
  assert.deepStrictEqual(coachEvents(srv).map((e) => e.title), ['The Coach answered', 'Your build plan for Thrallia is ready']);
  res = await owner.get('/api/coach');
  assert.strictEqual(res.body.questions[0].status, 'answered');
  assert.strictEqual(res.body.plan.spec, 'Arms');

  // The app writes the inbox; after a reload the game shows the answer and the plan.
  const inbox = { ...buildInbox(srv.db, g.guildId, u), generatedAt: Math.floor(Date.now() / 1000) + 10 };
  const wow2 = new WowClient({ savedVariables: wow.saveVariables(), inbox });
  wow2.exec(GAME);
  wow2.login();
  wow2.exec('__ns.coachUI.show("ask")');
  assert.strictEqual(wow2.eval('#__ns.db.coach.questions'), '0', 'the answered question leaves the queue');
  assert.match(wow2.eval('__ns.coach.answers()[1].a'), /Take Deflection for now/);
  assert.strictEqual(wow2.eval('__ns.coach.plan().spec'), 'Arms');
  assert.strictEqual(wow2.eval('__ns.debugError'), null);
});

test('input checks, and the Coach needs the guild', async (t) => {
  const loner = await startCore({ secrets: { anthropicKey: 'sk-test' } });
  t.after(() => loner.close());
  let res = await loner.api.get('/api/coach');
  assert.strictEqual(res.status, 403);
  assert.strictEqual(res.body.code, 'NO_GUILD');
  res = await loner.api.post('/api/coach/ask', { question: 'Hi' });
  assert.strictEqual(res.status, 403);

  const { srv, g, other, owner } = await setup();
  t.after(() => srv.close());

  res = await owner.post('/api/coach/ask', { question: '   ' });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, 'Type a question first.');
  res = await owner.post('/api/coach/ask', { question: ['not', 'text'] });
  assert.strictEqual(res.status, 400);
  res = await owner.post('/api/coach/plan', { char: 'Nobody' });
  assert.strictEqual(res.status, 400);
  assert.match(res.body.error, /No character data yet/);

  // Long questions are cut to 500 characters; a character that isn't yours is ignored.
  applyPayload(srv.db, g.guildId, other.id, coachPayload({ questions: [] }));
  res = await owner.post('/api/coach/ask', { question: 'x'.repeat(900), char: 'Grom' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.question.question.length, 500);
  assert.strictEqual(res.body.question.char_name, null);
  res = await owner.get('/api/coach?char=Grom');
  assert.strictEqual(res.body.character, null);
});

test('the background hook: kick() waits for timers, run() works at once, and the timers run it', async (t) => {
  const { srv, g, u, Cl } = await setup();
  t.after(() => srv.close());
  const svc = srv.ctx.services.coach;
  assert.strictEqual(typeof svc.kick, 'function');
  assert.strictEqual(typeof svc.run, 'function');
  applyPayload(srv.db, g.guildId, u, coachPayload());
  const timers = srv.ctx.timers.length;
  svc.kick();
  assert.strictEqual(srv.ctx.timers.length, timers, 'timers are off in tests: nothing scheduled');
  await sleep(30);
  assert.strictEqual(Cl.calls.length, 0);

  // With timers on, kick() answers within a moment.
  const live = await setup({ timers: true });
  t.after(() => live.srv.close());
  assert.ok(live.srv.ctx.timers.length >= 1, 'the minute timer is registered');
  applyPayload(live.srv.db, live.g.guildId, live.u, coachPayload());
  live.srv.ctx.services.coach.kick();
  live.srv.ctx.services.coach.kick(); // a second kick while one is scheduled changes nothing
  await waitFor(() => live.srv.db.prepare("SELECT status FROM coach_qa WHERE status = 'answered'").get(), 'the kicked run');
  assert.strictEqual(live.Cl.answers().length, 1);
});

test('follow-up questions: the Coach sees the last few answers about the same character, unless it is a new topic', async (t) => {
  const { srv, g: G, u, Cl, owner } = await setup();
  t.after(() => srv.close());
  applyPayload(srv.db, G.guildId, u, coachPayload({ questions: [] }));
  const ask = (question, extra = {}) => owner.post('/api/coach/ask', { char: 'Grom', question, ...extra });
  assert.strictEqual((await ask('Best place to level at 24?')).status, 200);
  let msgs = Cl.answers().at(-1).body.messages;
  assert.strictEqual(msgs.length, 1, 'the first question stands alone');
  assert.match(msgs[0].content, /Character: Grom[\s\S]*Question: Best place to level at 24\?/);

  await ask('And at level 40?');
  msgs = Cl.answers().at(-1).body.messages;
  assert.deepStrictEqual(msgs.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.match(msgs[0].content, /Character: Grom[\s\S]*Question: Best place to level at 24\?/);
  assert.strictEqual(msgs[1].content, srv.db.prepare('SELECT answer FROM coach_qa ORDER BY id LIMIT 1').get().answer);
  assert.strictEqual(msgs[2].content, 'Follow-up question: And at level 40?');

  // At most three earlier turns.
  await ask('Three?'); await ask('Four?'); await ask('Five?');
  msgs = Cl.answers().at(-1).body.messages;
  assert.strictEqual(msgs.length, 7);
  assert.match(msgs[0].content, /Question: And at level 40\?/);

  // A new topic, or questions older than three hours, start fresh.
  await ask('Totally new thing', { fresh: true });
  assert.strictEqual(Cl.answers().at(-1).body.messages.length, 1);
  srv.db.prepare("UPDATE coach_qa SET created_at = datetime('now', '-4 hours')").run();
  await ask('After a break?');
  assert.strictEqual(Cl.answers().at(-1).body.messages.length, 1);
});
