// Domain services (app/src/core/services), called directly against an in-memory database.
// Ported from the old web/test/*.test.js assertions that called these modules, plus sanity
// checks for what the old tests left out.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { open } = require('../../src/core/db');
const S = require('../../src/shared/sharing');
const sharing = require('../../src/core/sharing');
const { seedGuild } = require('./helpers');
const { shareKit } = require('./share-kit');
const { applyPayload, buildInbox, toLua } = require('../../src/core/services/sync');
const E = require('../../src/core/services/economy');
const C = require('../../src/core/services/coach');
const ai = require('../../src/core/services/ai');
const R = require('../../src/core/services/raids');
const G = require('../../src/core/services/gamedata');
const blizzard = require('../../src/core/services/blizzard');
const backup = require('../../src/core/services/backup');
const { resetGuild } = require('../../src/core/services/reset');
const { buildIcs, feedRaids } = require('../../src/core/services/calendar');
const { HttpError } = require('../../src/core/http');
const shared = require('../../src/shared/lua');
const { WowClient } = require('./wowsim');

const NOW = () => Math.floor(Date.now() / 1000);
const TODAY = () => Math.floor((Date.now() - Date.UTC(2020, 0, 1)) / 86400000);

// One guild with one owner. Extra members via addMember.
function freshDb() {
  const db = open(':memory:');
  const u = db.prepare("INSERT INTO users (bnet_id, battletag) VALUES ('dev:J#1','J#1')").run().lastInsertRowid;
  const g = db.prepare("INSERT INTO guilds (name, invite_code) VALUES ('wow','inv')").run().lastInsertRowid;
  db.prepare("INSERT INTO memberships (user_id, guild_id, role) VALUES (?,?,'owner')").run(u, g);
  const addMember = (bt, role = 'member') => {
    const id = db.prepare('INSERT INTO users (bnet_id, battletag) VALUES (?,?)').run(`dev:${bt}`, bt).lastInsertRowid;
    db.prepare('INSERT INTO memberships (user_id, guild_id, role) VALUES (?,?,?)').run(id, g, role);
    return id;
  };
  return { db, u, g, addMember };
}
const tmpDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const json = (o) => ({ ok: true, status: 200, json: async () => o, text: async () => JSON.stringify(o) });

// ====================================================================== sync

test('sync: toLua is the shared serialiser, and only objects are accepted', () => {
  assert.strictEqual(toLua, shared.toLua);
  const { db, u, g } = freshDb();
  for (const bad of [null, 'text', 5, []]) {
    assert.throws(() => applyPayload(db, g, u, bad), (e) => e instanceof HttpError && e.status === 400);
  }
  const stats = applyPayload(db, g, u, {});
  assert.deepStrictEqual({ ...stats, coach: undefined }, { characters: 0, roster: 0, recipes: 0, ctas: [], inventory: 0, bank: 0, prices: 0, coach: undefined, shared: { imported: 0, ignored: 0, acked: 0, refused: 0, checks: 0, checkpoints: 0, posts: [], ctas: [] } });
});

test('sync: characters, professions, recipes, roster and calls to arms are stored once', () => {
  const { db, u, g, addMember } = freshDb();
  const other = addMember('Other#2');
  const at = NOW() - 60;
  const payload = {
    characters: {
      Thrallia: { name: 'Thrallia', class: 'SHAMAN', race: 'Orc', level: 23, faction: 'Horde', zone: 'The Barrens', money: 123456, realm: 'Forever', guild: 'wow',
        updated: at, professions: [{ name: 'Alchemy', skill: 120, max: 150 }], recipes: { Alchemy: [{ id: 1, name: 'Minor Healing Potion' }, 'Elixir of Lion\'s Strength'] },
        pvp: { rank: 2, rankName: 'Scout', hk: 120 }, reputations: [{ name: 'Orgrimmar', standing: 5, value: 100, max: 3000 }] },
    },
    roster: { scannedAt: at, guild: 'wow', members: [{ name: 'Thrallia', level: 23, class: 'SHAMAN', rank: 'Officer', online: true }, { name: 'Grommash', level: 60, class: 'WARRIOR', rank: 'Member', online: false }] },
    ctaQueue: [{ at, character: 'Thrallia', zone: 'Crossroads', msg: 'Alliance raid', needed: 5 }, { at, character: 'Thrallia', zone: '' }],
  };
  const stats = applyPayload(db, g, u, payload);
  assert.deepStrictEqual([stats.characters, stats.roster, stats.recipes, stats.ctas.length], [1, 2, 2, 1]);
  assert.deepStrictEqual({ ...stats.ctas[0], id: 1 }, { id: 1, zone: 'Crossroads', character: 'Thrallia', message: 'Alliance raid', needed: 5 });
  const me = db.prepare("SELECT * FROM characters WHERE name = 'Thrallia'").get();
  assert.deepStrictEqual([me.user_id, me.level, me.rank, me.online, me.money], [u, 23, 'Officer', 1, 123456]);
  assert.strictEqual(JSON.parse(me.extras).pvp.rankName, 'Scout');
  assert.deepStrictEqual({ ...db.prepare('SELECT realm, game_guild FROM guilds').get() }, { realm: 'Forever', game_guild: 'wow' });
  assert.strictEqual(db.prepare('SELECT user_id FROM characters WHERE name = ?').get('Grommash').user_id, null, 'roster rows are unclaimed');
  assert.match(db.prepare("SELECT text FROM activity WHERE kind = 'character'").get().text, /Thrallia linked their character/);

  // The same upload again: no duplicate call to arms, no second activity line.
  assert.strictEqual(applyPayload(db, g, u, payload).ctas.length, 0);
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM ctas').get().n, 1);
  assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM activity WHERE kind = 'character'").get().n, 1);

  // Someone else uploading the same character name never takes it over.
  applyPayload(db, g, other, { characters: { Thrallia: { name: 'Thrallia', level: 60 } } });
  const after = db.prepare("SELECT user_id, level FROM characters WHERE name = 'Thrallia'").get();
  assert.deepStrictEqual({ ...after }, { user_id: u, level: 23 });
  // An older roster scan is ignored.
  applyPayload(db, g, u, { roster: { scannedAt: at - 3600, members: [{ name: 'Late', level: 1 }] } });
  assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM characters WHERE name = 'Late'").get().n, 0);
});

test('sync: the shopping list and reagents price the inbox and report stock back', () => {
  const { db, u, g } = freshDb();
  applyPayload(db, g, u, {
    characters: {
      Thrallia: { name: 'Thrallia', inventory: { bags: [{ id: 2589, name: 'Linen Cloth', count: 2 }] } },
      Altie: { name: 'Altie', inventory: { bank: [{ id: 2589, name: 'Linen Cloth', count: 7 }] } },
    },
    guildBank: { scannedAt: NOW(), money: 0, tabs: [{ name: 'Mats', items: [{ id: 2589, name: 'Linen Cloth', count: 20 }] }] },
    prices: { items: [[2589, 12, TODAY()], [2840, 55, TODAY()]] },
    reagentIds: [2589, 2840, 2835],
    shopping: [{ name: 'Linen Belt', qty: 6, prof: 'Blacksmithing', reagents: [{ id: 2589, name: 'Linen Cloth', qty: 1 }] }],
  });
  const inbox = buildInbox(db, g, u);
  assert.deepStrictEqual(inbox.prices.sort((a, b) => a.id - b.id), [{ id: 2589, price: 12 }, { id: 2840, price: 55 }]);
  assert.deepStrictEqual(inbox.stock, [{ id: 2589, chars: [{ name: 'Altie', count: 7 }, { name: 'Thrallia', count: 2 }], guildBank: 20 }]);
  assert.strictEqual(inbox.guild, 'wow');
  assert.ok(inbox.generatedAt >= NOW() - 5);
  for (const k of ['holdings', 'crafters', 'raids', 'announcements', 'canCraft', 'myRequests', 'buddies', 'coach']) assert.ok(k in inbox, k);
});

test('sync: the inbox carries holdings and guild crafters for item tooltips', () => {
  const { db, u, g } = freshDb();
  applyPayload(db, g, u, {
    characters: { Altie: { name: 'Altie', inventory: { bank: [{ id: 2589, name: 'Linen Cloth', count: 7 }] }, recipes: { Tailoring: [{ name: 'Linen Belt' }] } } },
    guildBank: { scannedAt: NOW(), tabs: [{ name: 'Mats', items: [{ id: 2589, name: 'Linen Cloth', count: 40 }] }] },
  });
  const inbox = buildInbox(db, g, u);
  assert.deepStrictEqual(inbox.holdings, [{ id: 2589, chars: [{ name: 'Altie', count: 7 }], guildBank: 40 }]);
  assert.deepStrictEqual(inbox.crafters, [{ name: 'Linen Belt', who: 'Altie' }]);
});

// ====================================================================== economy

test('economy: money formats copper the way players read it', () => {
  assert.strictEqual(E.money(1234567), '123g 45s 67c');
  assert.strictEqual(E.money(5000), '50s');
  assert.strictEqual(E.money(7), '7c');
  assert.strictEqual(E.money(10000), '1g 0s');
  assert.strictEqual(E.money(-250), '-2s 50c');
  assert.strictEqual(E.money(null), '');
  assert.strictEqual(E.dayToDate(0), '2020-01-01');
});

const GUILD_BANK_MOCK = `
local gb = {
  [1] = { name = "Mats", slots = { [1] = {"|Hitem:14047|h[Runecloth]|h", 20}, [2] = {"|Hitem:14047|h[Runecloth]|h", 10}, [5] = {"|Hitem:13444|h[Major Mana Potion]|h", 4} } },
  [2] = { name = "Raid", slots = { [1] = {"|Hitem:13457|h[Greater Fire Protection Potion]|h", 6} } },
}
function GetNumGuildBankTabs() return 2 end
function GetGuildBankTabInfo(t) return gb[t].name, "icon", true end
function GetGuildBankItemLink(t, s) local x = gb[t].slots[s]; return x and x[1] end
function GetGuildBankItemInfo(t, s) local x = gb[t].slots[s]; return "tex", x and x[2] or 0 end
function QueryGuildBankTab() end
function QueryGuildBankLog() end
function GetGuildBankMoney() return 1234567 end
function GetNumGuildBankTransactions(t) return t == 1 and 1 or 0 end
function GetGuildBankTransaction(t, i) return "deposit", "Grommash", "|Hitem:14047|h[Runecloth]|h", 10, 1, nil, 0, 0, 0, 3 end
function GetNumGuildBankMoneyTransactions() return 1 end
function GetGuildBankMoneyTransaction(i) return "withdraw", "Thrallia", 50000, 0, 0, 1, 0 end
`;

test('economy: bags, bank and guild bank from the addon are stored with prices and the bank log', () => {
  const wow = new WowClient();
  wow.exec(GUILD_BANK_MOCK);
  wow.login();
  wow.fire('BANKFRAME_OPENED');
  wow.fire('GUILDBANKFRAME_OPENED');
  wow.fire('GUILDBANKFRAME_CLOSED');
  wow.logout();
  const sv = wow.db();

  const { db, u, g } = freshDb();
  sv.prices = { items: [[14047, 120, TODAY()], [13444, 900, TODAY() - 1]] };
  const stats = applyPayload(db, g, u, sv);
  assert.strictEqual(stats.bank, 3);
  assert.strictEqual(stats.prices, 2);
  assert.ok(stats.inventory > 0);
  assert.strictEqual(db.prepare('SELECT name FROM item_names WHERE item_id = 14047').get().name, 'Runecloth');
  assert.strictEqual(db.prepare('SELECT count FROM inventory WHERE location = ? AND item_id = 14047').get('bank').count, 35);
  assert.strictEqual(db.prepare('SELECT bank_money FROM guilds').get().bank_money, 1234567);
  assert.strictEqual(E.latestPrices(db, g, [14047])[14047].price, 120);
  assert.deepStrictEqual(E.latestPrices(db, g, []), {});
  assert.strictEqual(E.searchPrices(db, g, 'rune')[0].name, 'Runecloth');
  assert.strictEqual(E.searchPrices(db, g, '14047')[0].item_id, 14047, 'an item id finds the item');
  assert.deepStrictEqual(E.searchPrices(db, g, '100%'), [], 'LIKE wildcards are literal');
  // Uploading the same log again doesn't duplicate it, and an older bank scan doesn't overwrite a newer one.
  applyPayload(db, g, u, sv);
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM bank_log').get().n, 2);
  const older = JSON.parse(JSON.stringify(sv)); older.guildBank.scannedAt -= 3600; older.guildBank.tabs = [];
  applyPayload(db, g, u, older);
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM guild_bank').get().n, 3);
});

test('economy: the lowest price of a day wins, prices older than 30 days drop out, history is oldest first', () => {
  const { db, u, g } = freshDb();
  applyPayload(db, g, u, { prices: { items: [[2589, 15, TODAY()], [2589, 12, TODAY()], [2589, 20, TODAY() - 2], [2589, 'x', TODAY()], [3000, 50, TODAY() - 40]] } });
  assert.strictEqual(E.latestPrices(db, g, [2589])[2589].price, 12);
  assert.deepStrictEqual(E.latestPrices(db, g, [3000]), {}, 'a 40-day-old scan is too old');
  assert.ok(E.latestPrices(db, g, [3000], 60)[3000]);
  const h = E.priceHistory(db, g, 2589);
  assert.deepStrictEqual(h.history.map((x) => x.price), [20, 12]);
  assert.strictEqual(h.latest.price, 12);
});

// ====================================================================== coach

const PLAN = {
  headline: 'Arms for world PvP: hit hard, stay mobile', summary: 'You start fights and like PvP, so go deep Arms for burst.', spec: 'Arms', split: '31/20/0 at 60',
  talents: [{ name: 'Improved Rend', tree: 'Arms', points: 3, why: 'Early damage' }, { name: 'Tactical Mastery', tree: 'Arms', points: 5, why: 'Keep rage on stance swap' }],
  stats: ['Strength', 'Hit', 'Crit'], gear: [{ slot: 'Weapon', advice: 'Slow two-hander for big Overpower hits' }],
  next_steps: [{ title: 'Spend your talent point', detail: 'Put it in Tactical Mastery' }], tips: ['Open with Charge from max range'], confidence: 'classic',
};

// A stand-in for the Claude API. The first plan call pauses mid-search, like a long web search turn.
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

test('coach: play style and questions are stored once; answers and plans come from Claude', async () => {
  const { db, u, g } = freshDb();
  applyPayload(db, g, u, coachPayload());
  applyPayload(db, g, u, coachPayload()); // same question twice: stored once
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM coach_qa').get().n, 1);
  assert.strictEqual(JSON.parse(db.prepare('SELECT profile FROM coach_chars').get().profile).archetype, 'Warmonger');

  const Cl = fakeClaude();
  const sent = [];
  const cfg = { anthropicKey: 'sk-test', fetch: Cl.fetchImpl };
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
  // The notification has the ctx.emit shape: (guildId, 'coach', { title, body, route, userIds }).
  assert.strictEqual(sent.length, 1);
  assert.deepStrictEqual(sent[0].slice(0, 2), [g, 'coach']);
  assert.deepStrictEqual({ ...sent[0][2], body: undefined }, { title: 'The Coach answered', body: undefined, route: '/coach', userIds: [u] });
  assert.match(sent[0][2].body, /^Deflection or Improved Charge\?: Take Deflection/);

  // Requests use the right models, web search, and the API's headers.
  const answerCall = Cl.calls.find((c) => /120 words/.test(c.body.system));
  assert.strictEqual(answerCall.url, 'https://api.anthropic.com/v1/messages');
  assert.strictEqual(answerCall.body.model, 'claude-haiku-5-5');
  assert.strictEqual(answerCall.headers['anthropic-version'], '2023-06-01');
  assert.strictEqual(answerCall.headers['x-api-key'], 'sk-test');
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
  assert.strictEqual(inbox.coach.plans.Grom.sources, undefined, 'sources stay out of the game');
  assert.strictEqual(inbox.coach.answers[0].qid, 'q1');
  assert.strictEqual(inbox.coach.pending, 0);
  assert.strictEqual(inbox.coach.enabled, true);

  // Asking for a fresh plan in game queues one.
  applyPayload(db, g, u, coachPayload({ chars: { Grom: { name: 'Grom', planRequest: NOW() + 5 } }, questions: [] }));
  assert.strictEqual(C.inboxPart(db, g, u).pending, 1);
});

test('coach: budget, daily limits, and a missing key give clear answers instead of silence', async () => {
  const { db, u, g } = freshDb();
  applyPayload(db, g, u, coachPayload());
  C.setKeyPresent(false);
  await C.processPending(db, { anthropicKey: '' });
  assert.match(db.prepare('SELECT error FROM coach_qa').get().error, /Anthropic API key in Settings/);
  assert.strictEqual(C.inboxPart(db, g, u).pending, 0, 'without a key, plans never count as pending');

  db.prepare('UPDATE guilds SET coach_budget_usd = 1').run();
  db.prepare("INSERT INTO ai_usage (guild_id, user_id, kind, cost_usd) VALUES (?,?, 'plan', 1.5)").run(g, u);
  assert.match(C.guard(db, g, u, 'question'), /budget for this month is used up/);
  db.prepare('UPDATE guilds SET coach_budget_usd = 100').run();
  for (let i = 0; i < C.LIMITS.questionsPerDay; i++) db.prepare("INSERT INTO ai_usage (guild_id, user_id, kind, cost_usd) VALUES (?,?, 'question', 0)").run(g, u);
  assert.match(C.guard(db, g, u, 'question'), /today's limit of 30 questions/);
  assert.strictEqual(C.guard(db, g, u, 'plan'), null);
  db.prepare('UPDATE guilds SET coach_enabled = 0').run();
  assert.match(C.guard(db, g, u, 'plan'), /switched off/);
  await assert.rejects(C.plan(db, { anthropicKey: 'k' }, g, u, 'Grom'), (e) => e.status === 403 && /switched off/.test(e.message));
  await assert.rejects(C.plan(db, { anthropicKey: 'k' }, g, 999, null), (e) => e.status === 400 && /No character data yet/.test(e.message));
  assert.throws(() => C.cleanPlan('no json here', 10, 'm'), /didn't return a plan/);
  assert.throws(() => C.cleanPlan('{ broken json }', 10, 'm'), /didn't return a plan/);
});

test('coach: a plan that fails is not retried every minute, and is shown as an error', async () => {
  const { db, u, g } = freshDb();
  applyPayload(db, g, u, coachPayload({ questions: [] }));
  C.setKeyPresent(true);
  const failing = async () => ({ ok: false, status: 529, json: async () => ({ error: { message: 'Overloaded' } }) });
  const r = await C.processPending(db, { anthropicKey: 'k', fetch: failing });
  assert.deepStrictEqual(r, { answered: 0, plans: 0, failed: 1 });
  const plan = JSON.parse(db.prepare('SELECT plan FROM coach_chars').get().plan);
  assert.match(plan.error, /Claude API 529: Overloaded/);
  assert.deepStrictEqual(C.wantsPlan(db, u), [], 'no retry until the next request or level');
  assert.match(C.inboxPart(db, g, u).plans.Grom.error, /Overloaded/);
  C.setKeyPresent(false);
});

test('coach: forGame strips markdown and smart punctuation; charContext describes the character', () => {
  assert.strictEqual(C.forGame('## Tip\n**Use** `Charge` — then… “run”\n* one\n\n\n\nend'), 'Tip\nUse Charge - then... "run"\n- one\n\nend');
  assert.match(C.charContext(null), /No character data yet/);
  assert.strictEqual(C.parse('{bad'), null);
  assert.deepStrictEqual(C.parse('{"a":1}'), { a: 1 });
});

test('coach: what the addon learns in game reaches the server and the Coach prompt', () => {
  const COACH_GAME = `
function GetRealmName() return "Forever" end
function GetNumTalentTabs() return 3 end
local tabs = { {"Elemental", 0}, {"Enhancement", 11}, {"Restoration", 0} }
function GetTalentTabInfo(i) return tabs[i][1], "icon", tabs[i][2], "bg" end
function GetNumTalents(tab) return tab == 2 and 2 or 0 end
function GetTalentInfo(tab, i) if i == 1 then return "Ancestral Knowledge", "icon", 1, 1, 5, 5 else return "Shield Specialization", "icon", 1, 2, 0, 5 end end
function UnitCharacterPoints() return 1 end
function GetInventoryItemLink(_, slot) if slot == 16 then return "|cff1eff00|Hitem:15223::|h[Big Stick]|h|r" end end
function GetItemInfo() return "Big Stick", nil, 2, 25 end
`;
  const wow = new WowClient();
  wow.exec(COACH_GAME);
  wow.login();
  wow.exec('__ns.coach.saveQuiz({ aggression = 5, risk = 2, social = 1, pvp = 5, pace = 3, role = "Damage", goal = "World PvP" })');
  wow.exec('__ns.coach.ask("Enhancement or Elemental for world PvP?")');
  wow.logout();
  assert.strictEqual(wow.eval('__ns.debugError'), null);

  const { db, u, g } = freshDb();
  const stats = applyPayload(db, g, u, wow.db());
  assert.deepStrictEqual(stats.coach, { chars: 1, questions: 1 });
  const row = db.prepare('SELECT * FROM coach_chars').get();
  assert.deepStrictEqual([row.name, row.class, row.level], ['Thrallia', 'SHAMAN', 23]);
  assert.strictEqual(JSON.parse(row.talents).picked[0].name, 'Ancestral Knowledge');
  assert.strictEqual(JSON.parse(row.gear).items[0].name, 'Big Stick');
  assert.match(C.charContext(row), /Talents: Elemental 0 \/ Enhancement 11 \/ Restoration 0, 1 unspent/);
  assert.match(C.charContext(row), /Their own answers: .*goal=World PvP/);
  assert.strictEqual(db.prepare('SELECT question FROM coach_qa').get().question, 'Enhancement or Elemental for world PvP?');

  // A character on another realm is left out.
  applyPayload(db, g, u, { characters: { Thrallia: { name: 'Thrallia', realm: 'Forever', guild: 'wow' } } });
  assert.deepStrictEqual(C.applyCoach(db, g, u, { chars: { Alt: { name: 'Alt', realm: 'Ragnaros' } } }, 'Forever'), { chars: 0, questions: 0 });
});

// ====================================================================== ai

test('ai: costs per model, and clear errors without a key or when Claude fails', async () => {
  assert.ok(Math.abs(ai.cost('claude-haiku-5-5', { input_tokens: 1e6, output_tokens: 1e6 }, 1) - 0.61) < 1e-9);
  assert.strictEqual(ai.cost('unknown-model', { input_tokens: 1e6 }, 0), ai.PRICES['claude-sonnet-5-5'].in, 'unknown models cost as Sonnet');
  await assert.rejects(ai.ask({ anthropicKey: '' }, { model: 'm', messages: [] }), (e) => e.status === 503 && /Anthropic API key in Settings/.test(e.message));
  const down = async () => { throw new TypeError('fetch failed'); };
  await assert.rejects(ai.ask({ anthropicKey: 'k', fetch: down }, { model: 'm', messages: [] }), (e) => e.status === 502 && /Could not reach/.test(e.message));
  const refused = async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'invalid x-api-key' } }) });
  await assert.rejects(ai.ask({ anthropicKey: 'k' }, { model: 'm', messages: [], fetchImpl: refused }), /Claude API 401: invalid x-api-key/);
});

// ====================================================================== raids

// A database built by hand, the way the old server stored raids (no shared records): for the tests that only read rows.
function raidSetup() {
  const { db, u: a, g, addMember } = freshDb();
  const b = addMember('Bravo#2');
  const c = addMember('Charlie#3');
  R.importItems(db, g, 'Hyjal Summit', 'Rage Winterchill | Frost Greaves\nAnetheron | Night Cloak\nArchimonde | Tear of the Earth\n\nLoose Trinket');
  const items = Object.fromEntries(R.itemsForInstance(db, g, 'Hyjal Summit').map((i) => [i.name, i.id]));
  const raid = (n) => {
    const id = db.prepare("INSERT INTO raids (guild_id, title, instance, starts_at, sr_limit) VALUES (?,?, 'Hyjal Summit', ?, 2)").run(g, `Week ${n}`, new Date(Date.now() + n * 86400000).toISOString()).lastInsertRowid;
    return R.raidFor(db, g, id);
  };
  const signup = (r, uid, ch, status = 'yes', role = 'dps') => db.prepare('INSERT INTO signups (raid_id, user_id, character, role, status) VALUES (?,?,?,?,?)').run(r.id, uid, ch, role, status);
  return { db, g, a, b, c, items, raid, signup };
}

// Raids through shared records (docs/SHARING.md §10), on a bare database: me (Velanne, an officer) queue the
// raids, closes, awards and the loot list; guildmates' sign-ups arrive the way an upload brings them in. The
// rows (raids, signups, reserves, attendance, loot_log, loyalty) are the projection of those records.
function sharedRaids() {
  const db = open(':memory:');
  const g = seedGuild(db, { role: 'officer', character: 'Velanne' });
  const ctx = { db, cfg: {}, log: { info() {}, warn() {}, error() {} }, emit() {}, outboxChanged() {} };
  const kit = shareKit({ db, ctx });
  const queue = (args) => sharing.queue(db, ctx, args);
  const list = R.lootListOf(db, g.guildId, 'Hyjal Summit');
  R.mergeLootLines(list, R.parseLootLines('Rage Winterchill | Frost Greaves | 30871\nAnetheron | Night Cloak\nArchimonde | Tear of the Earth\n\nLoose Trinket'));
  queue({ type: 'LL', key: list.key, fields: R.lootListFields(list) });
  const rows = R.itemsForInstance(db, g.guildId, 'Hyjal Summit');
  const items = Object.fromEntries(rows.map((i) => [i.name, i.id]));
  const keys = Object.fromEntries(rows.map((i) => [i.name, R.itemKeyOf(i)]));
  const [a, b, c] = ['Alpha', 'Bravo', 'Charlie'].map((n) => kit.mate(n));
  const fresh = (r) => R.raidFor(db, g.guildId, r.id);
  const raid = (n, srLimit = 2) => {
    const key = sharing.newKey();
    kit.tick(60);
    queue({ type: 'RD', key, fields: { kind: 'r', title: `Week ${n}`, instance: 'Hyjal Summit', startsAt: kit.now() + 86400, srLimit } });
    return R.raidByKey(db, g.guildId, key);
  };
  const signup = (r, mate, picks = [], status = 'yes') => kit.signup(r.share_id, mate, { status, reserves: picks.map((name) => keys[name]) });
  const close = (r, mates) => {
    kit.tick(60);
    const fields = sharing.raidCloseFields(db, g.guildId, r.share_id, mates.map((m) => m.id));
    queue({ type: 'RT', key: r.share_id, fields });
    return fields;
  };
  const award = (r, { itemId, itemName, mate, kind }) => {
    kit.tick(60);
    const out = R.awardFields(db, fresh(r), { itemId, itemName, userId: mate && mate.id, character: mate && mate.name, kind, pid: mate && mate.pid });
    queue({ type: 'LA', key: sharing.newKey(), fields: out.fields });
    if (out.item && mate) R.clearRolls(db, r, out.item.id);
    return out;
  };
  return { db, g, kit, items, keys, a, b, c, raid, fresh, signup, close, award, done: () => { kit.restore(); db.close(); } };
}

test('raids: loot list lines, one shared list per instance, and its limits', () => {
  const s = sharedRaids();
  try {
    const { db, g, keys } = s;
    assert.deepStrictEqual(Object.keys(keys).sort(), ['Frost Greaves', 'Loose Trinket', 'Night Cloak', 'Tear of the Earth']);
    assert.strictEqual(keys['Frost Greaves'], S.itemKey(30871));
    assert.strictEqual(keys['Night Cloak'], S.itemKey('Night Cloak'));
    const lines = R.parseLootLines('Archimonde | tear of the earth | 30000\nKaz | Boots | https://www.wowhead.com/item=12345\nToo long ' + 'x'.repeat(100));
    assert.deepStrictEqual(lines, [{ boss: 'Archimonde', name: 'tear of the earth', itemId: 30000 }, { boss: 'Kaz', name: 'Boots', itemId: 12345 }]);
    const list = R.lootListOf(db, g.guildId, 'Hyjal Summit');
    assert.strictEqual(R.mergeLootLines(list, lines), 1, 'only Boots is new');
    assert.deepStrictEqual(list.items.find((i) => i.name === 'Tear of the Earth'), { key: keys['Tear of the Earth'], boss: 'Archimonde', name: 'Tear of the Earth' },
      'an item already on the list keeps its key, so reserves and bonuses on it stay');
    const fields = R.lootListFields(list);
    assert.deepStrictEqual(fields.bosses, ['Rage Winterchill', 'Anetheron', 'Archimonde', 'Kaz']);
    assert.deepStrictEqual(fields.items.at(-1), { item: S.itemKey(12345), boss: 4, name: 'Boots' });
    sharing.queue(db, null, { type: 'LL', key: list.key, fields });
    const byName = Object.fromEntries(R.itemsForInstance(db, g.guildId, 'Hyjal Summit').map((i) => [i.name, i]));
    assert.strictEqual(byName.Boots.wh_id, 12345);
    assert.strictEqual(byName.Boots.boss, 'Kaz');
    assert.strictEqual(byName['Frost Greaves'].id, s.items['Frost Greaves'], 'rows keep their ids');
    // Without an id on the list, the Wowhead id comes from item names the guild has seen.
    db.prepare("INSERT INTO item_names (item_id, name) VALUES (777, 'Night Cloak')").run();
    assert.strictEqual(R.itemsForInstance(db, g.guildId, 'Hyjal Summit').find((i) => i.name === 'Night Cloak').wh_id, 777);

    // What a shared list can hold.
    const big = { key: 'abcdef', name: 'Big', items: Array.from({ length: 151 }, (_, i) => ({ key: S.itemKey(`x${i}`), boss: null, name: `x${i}` })) };
    assert.throws(() => R.lootListFields(big), (e) => e.status === 400 && /up to 150 items/.test(e.message));
    const bosses = { key: 'abcdef', name: 'Big', items: Array.from({ length: 41 }, (_, i) => ({ key: S.itemKey(`y${i}`), boss: `Boss ${i}`, name: `y${i}` })) };
    assert.throws(() => R.lootListFields(bosses), (e) => e.status === 400 && /up to 40 bosses/.test(e.message));
    // A list typed in before sharing: its rows, keyed by game item id or name.
    db.prepare("INSERT INTO loot_items (guild_id, instance, boss, name, item_id) VALUES (?, 'Onyxia''s Lair', 'Onyxia', 'Head of Onyxia', 18423), (?, 'Onyxia''s Lair', NULL, 'Scale', NULL)").run(g.guildId, g.guildId);
    assert.deepStrictEqual(R.lootListOf(db, g.guildId, "onyxia's lair"), {
      key: S.instanceKey("Onyxia's Lair"), name: "Onyxia's Lair",
      items: [{ key: S.itemKey('Scale'), boss: null, name: 'Scale' }, { key: S.itemKey(18423), boss: 'Onyxia', name: 'Head of Onyxia' }],
    });
  } finally { s.done(); }
});

test('raids: reserve picks (limit, locking, unknown items) and the sign-up record they ride on', () => {
  const s = sharedRaids();
  try {
    const { db, g, items, keys } = s;
    const r = s.raid(1);
    assert.deepStrictEqual(R.reserveKeys(db, r, [items['Frost Greaves'], items['Night Cloak'], items['Frost Greaves']]), [keys['Frost Greaves'], keys['Night Cloak']]);
    assert.throws(() => R.reserveKeys(db, r, [items['Frost Greaves'], items['Night Cloak'], items['Tear of the Earth']]), /up to 2/);
    assert.throws(() => R.reserveKeys(db, r, [99999]), (e) => e.status === 400 && /isn’t on this raid’s loot list/.test(e.message));
    assert.throws(() => R.reserveKeys(db, { ...r, status: 'locked' }, []), (e) => e.status === 409 && /locked/.test(e.message));
    assert.throws(() => R.reserveKeys(db, { ...r, sr_limit: 1 }, [items['Frost Greaves'], items['Night Cloak']]), /up to 1 item\./);

    const su = R.signupFields(null, { character: 'Velanne', role: 'healer', status: 'bench', note: 'late' });
    assert.deepStrictEqual(su, { character: 'Velanne', role: 'h', status: 'b', note: 'late', reserves: [], reservesAt: null, prev: [], prevAt: null });
    const stored = { id: 'su:x', t: 100, pending: false, del: false, fields: { ...su, reserves: ['aa'], reservesAt: 90 } };
    assert.deepStrictEqual(R.signupFields(stored, { character: 'Velalt', role: 'tank', status: 'yes' }).reserves, ['aa'], 'a sign-up change keeps the reserves');
    assert.strictEqual(R.reserveFields(db, g.guildId, stored, ['aa'], 200), null, 'the same picks change nothing');
    assert.deepStrictEqual(R.reserveFields(db, g.guildId, stored, ['bb'], 200), { ...stored.fields, reserves: ['bb'], reservesAt: 200, prev: ['aa'], prevAt: 90 });
    const pending = { ...stored, pending: true, fields: { ...stored.fields, prev: ['zz'], prevAt: 50 } };
    assert.deepStrictEqual(R.reserveFields(db, g.guildId, pending, ['bb'], 200), { ...pending.fields, reserves: ['bb'], reservesAt: 200 },
      'picks that never left this computer are not "the replaced list": the earlier prev stays');
  } finally { s.done(); }
});

test('raids: SR+ bonus grows each attended raid, resets on win, switch and no-show (through the shared records)', () => {
  const s = sharedRaids();
  try {
    const { db, g, a, b, c, items, keys } = s;
    const greaves = items['Frost Greaves'];
    const cloak = items['Night Cloak'];
    // Week 1: A and B reserve greaves, C reserves cloak. Everyone attends except C (signed yes).
    const w1 = s.raid(1);
    s.signup(w1, a, ['Frost Greaves']); s.signup(w1, b, ['Frost Greaves']); s.signup(w1, c, ['Night Cloak']);
    const f1 = s.close(w1, [a, b]);
    assert.deepStrictEqual([f1.attendees.length, f1.noShows], [2, [c.pid]]);
    assert.strictEqual(R.bonusOf(db, g.guildId, a.id, greaves), 10);
    assert.strictEqual(R.bonusOf(db, g.guildId, b.id, greaves), 10);
    assert.strictEqual(R.bonusOf(db, g.guildId, c.id, cloak), 0, 'no-show gets no bonus');
    assert.strictEqual(s.fresh(w1).status, 'done');
    assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM attendance WHERE raid_id = ?').get(w1.id).n, 2);

    // Week 2: same reserves; greaves drops, rolls include bonus, A wins.
    const w2 = s.raid(2);
    s.signup(w2, a, ['Frost Greaves']); s.signup(w2, b, ['Frost Greaves']);
    const board = R.reserveBoard(db, w2);
    assert.deepStrictEqual(board.map((x) => [x.item, x.reservers.map((p) => [p.character, p.bonus])]), [['Frost Greaves', [['Alpha', 10], ['Bravo', 10]]]]);
    const seq = [0.5, 0.2]; // A rolls 51, B rolls 21
    const rolls = R.rollItem(db, w2, greaves, () => seq.shift());
    assert.deepStrictEqual(rolls.map((r) => [r.character, r.roll, r.bonus, r.total]), [['Alpha', 51, 10, 61], ['Bravo', 21, 10, 31]]);
    const won = s.award(w2, { itemId: greaves, mate: a, kind: 'sr' });
    assert.deepStrictEqual(won.fields, { raid: w2.share_id, instance: S.instanceKey('Hyjal Summit'), item: keys['Frost Greaves'], itemName: 'Frost Greaves', character: 'Alpha', pid: a.pid, kind: 's', roll: 51, bonus: 10 });
    assert.deepStrictEqual(R.rollsFor(db, w2, greaves), [], 'rolls are cleared once the item is given');
    assert.deepStrictEqual(R.myReserves(db, w2, a.id), [], 'the reserve is fulfilled');
    assert.strictEqual(R.bonusOf(db, g.guildId, a.id, greaves), 0, 'the winner resets at once');
    s.close(w2, [a, b]);
    assert.strictEqual(R.bonusOf(db, g.guildId, a.id, greaves), 0, 'winner resets');
    assert.strictEqual(R.bonusOf(db, g.guildId, b.id, greaves), 20, 'loser keeps growing');
    const log = db.prepare('SELECT item_name, character, kind, roll, bonus, user_id FROM loot_log').all();
    assert.deepStrictEqual(log.map((x) => ({ ...x })), [{ item_name: 'Frost Greaves', character: 'Alpha', kind: 'sr', roll: 51, bonus: 10, user_id: a.id }]);

    // Week 3: B attends but switches to the cloak → greaves streak ends.
    const w3 = s.raid(3);
    s.signup(w3, b, ['Night Cloak']);
    s.close(w3, [b]);
    assert.strictEqual(R.bonusOf(db, g.guildId, b.id, greaves), 0);
    assert.strictEqual(R.bonusOf(db, g.guildId, b.id, cloak), 10);

    // A guildmate whose records arrive late changes nothing: the rows are the same for any arrival order.
    const before = db.prepare('SELECT user_id, item_id, bonus FROM loyalty ORDER BY user_id, item_id').all().map((x) => ({ ...x }));
    sharing.reproject(db, g.guildId, `LY:${S.instanceKey('Hyjal Summit')}`);
    assert.deepStrictEqual(db.prepare('SELECT user_id, item_id, bonus FROM loyalty ORDER BY user_id, item_id').all().map((x) => ({ ...x })), before);
  } finally { s.done(); }
});

test('raids: people not in the raid are left out of rolls; free-text awards keep no loyalty', () => {
  const s = sharedRaids();
  try {
    const { db, a, b, items } = s;
    const r = s.raid(1);
    s.signup(r, a, ['Night Cloak']); s.signup(r, b, ['Night Cloak'], 'tentative');
    assert.deepStrictEqual(R.rollItem(db, r, items['Night Cloak']).map((x) => x.character), ['Alpha']);
    const ring = s.award(r, { itemName: '  Random Ring ', mate: b, kind: 'os' });
    assert.strictEqual(ring.name, 'Random Ring');
    assert.deepStrictEqual([ring.fields.item, ring.fields.kind, ring.fields.roll, ring.fields.bonus], [S.itemKey('Random Ring'), 'o', null, 0]);
    const row = db.prepare("SELECT item_id, roll, bonus, kind FROM loot_log WHERE item_name = 'Random Ring'").get();
    assert.deepStrictEqual({ ...row }, { item_id: null, roll: null, bonus: 0, kind: 'os' });
    assert.throws(() => R.awardFields(db, r, { itemName: ' ', kind: 'ms' }), (e) => e.status === 400 && /Pick an item/.test(e.message));
    assert.strictEqual(R.rollsFor(db, r, items['Night Cloak']).length, 1, 'an unrelated award leaves the rolls');
  } finally { s.done(); }
});

test('raids: local start time converts to UTC using the client offset', () => {
  assert.strictEqual(R.toUtc('2026-12-09T20:00', '-120', 0), '2026-12-09T18:00:00.000Z');
  assert.strictEqual(R.toUtc('2026-12-09T20:00', -120, 0), '2026-12-09T18:00:00.000Z');
  assert.strictEqual(R.toUtc('2026-12-09T20:00', '', -120), '2026-12-09T18:00:00.000Z');
  assert.strictEqual(R.toUtc('2026-12-09T20:00', undefined, 60), '2026-12-09T21:00:00.000Z');
  assert.strictEqual(R.toUtc('2026-12-09T20:00', null, -120), '2026-12-09T18:00:00.000Z');
  assert.strictEqual(R.toUtc('2026-12-09T20:00', 'x', undefined), '2026-12-09T20:00:00.000Z');
  assert.strictEqual(R.toUtc('nonsense', '0', 0), null);
  assert.strictEqual(R.toUtc('2026-12-09 20:00', '0', 0), null);
});

test('raids: addon readiness reaches the sign-up list, raids reach the addon', () => {
  const { db, g, a, b, raid, signup, items } = raidSetup();
  const wow = new WowClient();
  wow.login();
  wow.logout();
  const sv = wow.db();
  assert.deepStrictEqual(sv.characters.Thrallia.readiness.consumables, { potion: 5, bandage: 10 });
  applyPayload(db, g, a, sv);
  const r = raid(1);
  signup(r, a, 'Thrallia');
  signup(r, b, 'Bravo', 'yes', 'tank');
  R.setReserves(db, r, a, [items['Night Cloak']]);
  const list = R.signupsFor(db, r);
  assert.deepStrictEqual(list.map((s) => s.character), ['Bravo', 'Thrallia'], 'tanks first');
  const s = list[1];
  assert.strictEqual(s.ready.ilvl, 58.2);
  assert.strictEqual(s.ready.durability, 50);
  assert.strictEqual(s.class, 'SHAMAN');
  assert.deepStrictEqual(R.roleCounts(list), { tank: 1, healer: 0, dps: 1 });
  const inbox = buildInbox(db, g, a);
  assert.strictEqual(inbox.raids[0].title, 'Week 1');
  assert.strictEqual(inbox.raids[0].signup, 'yes');
  assert.strictEqual(inbox.raids[0].coming, 2);
  assert.ok(Math.abs(inbox.raids[0].startsAt - (NOW() + 86400)) < 10);
  assert.deepStrictEqual(inbox.raids[0].reserves, [{ name: 'Night Cloak', bonus: 0 }]);
  // The addon's panel shows the raid without errors.
  const wow2 = new WowClient({ inbox: { ...inbox, latestAddon: '0.11.0', site: 'http://127.0.0.1' } });
  wow2.login();
  wow2.slash('');
  assert.strictEqual(wow2.eval('__ns.debugError'), null);
});

test('raids: the one-hour reminder fires once, to the app, and to Discord only for raids I made', async () => {
  const { db, g, a, b, signup } = raidSetup();
  const soonId = db.prepare("INSERT INTO raids (guild_id, title, instance, starts_at, created_by) VALUES (?, 'Soon', 'Hyjal Summit', ?, ?)").run(g, new Date(Date.now() + 30 * 60000).toISOString(), a).lastInsertRowid;
  const theirsId = db.prepare("INSERT INTO raids (guild_id, title, instance, starts_at, created_by) VALUES (?, 'Theirs', 'Hyjal Summit', ?, ?)").run(g, new Date(Date.now() + 40 * 60000).toISOString(), b).lastInsertRowid;
  db.prepare("INSERT INTO raids (guild_id, title, instance, starts_at) VALUES (?, 'Later', 'Hyjal Summit', ?)").run(g, new Date(Date.now() + 3 * 3600000).toISOString());
  db.prepare("INSERT INTO raids (guild_id, title, instance, starts_at, status) VALUES (?, 'Off', 'Hyjal Summit', ?, 'cancelled')").run(g, new Date(Date.now() + 20 * 60000).toISOString());
  signup({ id: soonId }, a, 'Alpha', 'yes', 'tank');
  signup({ id: soonId }, b, 'Bravo', 'tentative', 'healer');
  const notified = []; const posted = [];
  const deps = { notify: (...x) => notified.push(x), discord: async (raid, content) => { posted.push([raid.id, content]); return true; }, meId: a };
  assert.strictEqual(await R.remind(db, {}, deps), 2);
  assert.strictEqual(await R.remind(db, {}, deps), 0);
  assert.deepStrictEqual(notified, [
    [g, 'raid', { title: '⏰ Soon starts in an hour', body: '1 tanks, 0 healers, 0 damage signed up.', route: `/raids/${soonId}` }],
    [g, 'raid', { title: '⏰ Theirs starts in an hour', body: '0 tanks, 0 healers, 0 damage signed up.', route: `/raids/${theirsId}` }],
  ]);
  // Each app posts only what its own player does: the raid someone else made is theirs to post.
  assert.strictEqual(posted.length, 1);
  assert.strictEqual(posted[0][0], soonId);
  assert.match(posted[0][1], /^⏰ \*\*Soon\*\* starts <t:\d+:R>\. 1 tank, 0 healers, 0 damage signed up\. Sign up in Guild Camp\.$/);
});

// ====================================================================== gamedata + blizzard

// A stand-in for Blizzard's API. `realmUp` can be flipped between calls.
function fakeBlizzard(state = { realmUp: true, ns: 'forever' }) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('oauth.battle.net')) return json({ access_token: 't' });
    const u = new URL(url); const ns = u.searchParams.get('namespace') || '';
    const p = u.pathname;
    if (p === '/data/wow/item/14047') return json({ name: 'Runecloth', quality: { type: 'COMMON' }, level: 50, required_level: 0, item_class: { name: 'Trade Goods' }, item_subclass: { name: 'Cloth' }, inventory_type: { name: 'Non-equippable' } });
    if (p === '/data/wow/item/19019') return json({ name: 'Thunderfury, Blessed Blade of the Windseeker', quality: { type: 'LEGENDARY' }, level: 80, required_level: 60, item_class: { name: 'Weapon' }, item_subclass: { name: 'Sword' }, inventory_type: { name: 'One-Hand' } });
    if (p.startsWith('/data/wow/item/')) return { ok: false, status: 404 };
    if (!ns.includes(state.ns)) return { ok: false, status: 404 };
    if (p === '/data/wow/realm/index') return json({ realms: [{ name: 'Living Flame', slug: 'living-flame' }, { name: "Zul'jin", slug: 'zuljin' }] });
    if (p === '/data/wow/realm/zuljin') return json({ connected_realm: { href: `https://eu.api.blizzard.com/data/wow/connected-realm/42?namespace=${ns}` } });
    if (p === '/data/wow/connected-realm/42') return json({ status: { type: state.realmUp ? 'UP' : 'DOWN' }, has_queue: state.realmUp, population: { name: 'Full' } });
    if (p === '/data/wow/connected-realm/42/auctions/index') return json({ auctions: [{ id: 2, name: 'Alliance Auction House' }, { id: 6, name: 'Horde Auction House' }, { id: 7, name: 'Blackwater Auction House' }] });
    if (p === '/data/wow/connected-realm/42/auctions/6') return json({ auctions: [
      { id: 1, item: { id: 13444 }, buyout: 80000, quantity: 20 }, { id: 2, item: { id: 13444 }, buyout: 3900, quantity: 1 },
      { id: 3, item: { id: 13510 }, bid: 100, quantity: 1 }, { id: 4, item: { id: 13510 }, buyout: 400000, quantity: 1 },
    ] });
    if (p === '/data/wow/guild/zuljin/wow/roster') return json({ members: [
      { character: { name: 'Grommash', level: 60, playable_class: { id: 1 } }, rank: 0 },
      { character: { name: 'Newbie', level: 12, playable_class: { id: 8 } }, rank: 4 },
    ] });
    return { ok: false, status: 404 };
  };
  return { calls, fetchImpl, state };
}
const BNET = { bnetClientId: 'id', bnetClientSecret: 'sec', bnetRegion: 'eu' };

test('gamedata: Blizzard auction house prices arrive once the API has the guild game, for its faction', async () => {
  const { db, u, g } = freshDb();
  applyPayload(db, g, u, { characters: { Grommash: { name: 'Grommash', class: 'WARRIOR', level: 60, guild: 'wow', realm: "Zul'jin" } } });
  db.prepare("UPDATE guilds SET faction = 'Horde' WHERE id = ?").run(g);
  const B = fakeBlizzard({ realmUp: true, ns: 'forever' });
  await G.run(db, BNET, { fetchImpl: B.fetchImpl });
  assert.ok(!B.calls.some((c) => c.includes('/auctions')), 'nothing asked while Forever is not in the API');

  blizzard.save(db, { foreverKey: 'forever', forever: 'static-forever-eu', region: 'eu' });
  const log = await G.run(db, BNET, { fetchImpl: B.fetchImpl });
  assert.ok(log.includes('Auction house: 2 items from Horde Auction House'), log.join(' | '));
  assert.equal(JSON.parse(db.prepare('SELECT realm_status FROM guilds').get().realm_status).connectedRealm, 42);
  const rows = db.prepare('SELECT item_id, price, quantity FROM ah_prices WHERE guild_id = ? ORDER BY item_id').all(g).map((r) => ({ ...r }));
  assert.deepEqual(rows, [{ item_id: 13444, price: 3900, quantity: 21 }, { item_id: 13510, price: 400000, quantity: 1 }], 'lowest buyout per unit; bid-only auctions skipped');

  const n = B.calls.length;
  await G.run(db, BNET, { fetchImpl: B.fetchImpl });
  assert.ok(!B.calls.slice(n).some((c) => c.includes('/auctions')), 'at most hourly');
  db.prepare("UPDATE guilds SET wowhead_game = 'retail' WHERE id = ?").run(g);
  await G.run(db, BNET, { fetchImpl: B.fetchImpl, only: 'auctions' });
  assert.ok(!B.calls.slice(n).some((c) => c.includes('/auctions')), 'not for Retail guilds');
});

test('gamedata: namespaces fall back to Classic Era items until Forever is in the API', () => {
  assert.deepStrictEqual(G.namespaces(null, 'forever', 'eu'), { static: 'static-classic1x-eu', dynamic: null, profile: null, label: 'Classic Era item data (Forever not in the API yet)' });
  const f = G.namespaces({ foreverKey: 'forever' }, 'forever', 'us');
  assert.strictEqual(f.static, 'static-forever-us');
  assert.strictEqual(f.profile, 'profile-forever-us');
  assert.strictEqual(G.namespaces(null, 'retail', 'eu').dynamic, 'dynamic-eu');
  assert.strictEqual(G.namespaces(null, 'classic', 'us').profile, 'profile-classic1x-us');
  assert.strictEqual(G.slug("Zul'jin"), 'zuljin');
  assert.strictEqual(G.slug('Living Flame'), 'living-flame');
});

test('gamedata: item details fill in names for items the guild has seen', async () => {
  const { db, u, g } = freshDb();
  applyPayload(db, g, u, { characters: { Grommash: { name: 'Grommash', inventory: { bags: [{ id: 14047, count: 20 }] } } } });
  db.prepare('INSERT INTO prices (guild_id, item_id, day, price) VALUES (?,?,?,?)').run(g, 19019, '2026-11-03', 5000000);
  db.prepare('INSERT INTO prices (guild_id, item_id, day, price) VALUES (?,?,?,?)').run(g, 99999, '2026-11-03', 1);
  const ids = G.missingItemIds(db).sort((a, b) => a - b);
  assert.deepStrictEqual(ids, [14047, 19019, 99999]);
  const B = fakeBlizzard();
  assert.deepStrictEqual(await G.run(db, {}, { fetchImpl: B.fetchImpl }), ['Blizzard game data is off: this copy of Guild Camp has no Battle.net app built in.']);
  const log = await G.run(db, BNET, { fetchImpl: B.fetchImpl, only: 'items' });
  assert.match(log[0], /2 of 3 items filled from static-classic1x-eu/);
  assert.strictEqual(db.prepare('SELECT name FROM item_names WHERE item_id = 19019').get().name, 'Thunderfury, Blessed Blade of the Windseeker');
  const tf = db.prepare('SELECT * FROM item_info WHERE item_id = 19019').get();
  assert.strictEqual(tf.quality, 'LEGENDARY'); assert.strictEqual(tf.req_level, 60); assert.strictEqual(tf.slot, 'One-Hand');
  assert.strictEqual(db.prepare('SELECT found FROM item_info WHERE item_id = 99999').get().found, 0, 'unknown items are remembered so they are not asked for again');
  assert.deepStrictEqual(G.missingItemIds(db), []);
  assert.strictEqual(B.calls.filter((c) => c.includes('oauth')).length, 1, 'one token for the whole run');
});

test('gamedata: the addon reports the realm; realm status and official roster arrive once Forever is in the API', async () => {
  const { db, u, g } = freshDb();
  applyPayload(db, g, u, { characters: { Grommash: { name: 'Grommash', class: 'WARRIOR', level: 58, guild: 'wow', realm: "Zul'jin" } } });
  const row = db.prepare('SELECT realm, game_guild FROM guilds WHERE id = ?').get(g);
  assert.deepStrictEqual({ ...row }, { realm: "Zul'jin", game_guild: 'wow' });

  const B = fakeBlizzard({ realmUp: true, ns: 'forever' });
  // Before Forever appears: nothing realm-related is asked for. cfg.fetch is the stand-in here.
  db.prepare('INSERT INTO prices (guild_id, item_id, day, price) VALUES (?,?,?,?)').run(g, 14047, '2026-11-03', 100);
  await G.run(db, { ...BNET, fetch: B.fetchImpl });
  assert.ok(B.calls.some((c) => c.includes('/data/wow/item/14047')), 'cfg.fetch is used when no fetchImpl is given');
  assert.ok(!B.calls.some((c) => c.includes('/realm/')));

  blizzard.save(db, { foreverKey: 'forever', forever: 'static-forever-eu', region: 'eu' });
  const sent = [];
  const notify = (gid, kind, msg) => sent.push([gid, kind, msg]);
  B.state.realmUp = false;
  await G.run(db, BNET, { fetchImpl: B.fetchImpl, notify });
  let st = JSON.parse(db.prepare('SELECT realm_status FROM guilds').get().realm_status);
  assert.strictEqual(st.up, false); assert.strictEqual(st.slug, 'zuljin');
  assert.strictEqual(sent.length, 0);
  // Official roster: new member added, linked character's level only goes up.
  const chars = Object.fromEntries(db.prepare('SELECT name, level, class, user_id, in_official_roster FROM characters').all().map((c) => [c.name, c]));
  assert.strictEqual(chars.Newbie.class, 'MAGE'); assert.strictEqual(chars.Newbie.user_id, null);
  assert.strictEqual(chars.Grommash.level, 60); assert.strictEqual(chars.Grommash.user_id, u);
  assert.strictEqual(chars.Grommash.in_official_roster, 1);
  assert.match(db.prepare('SELECT official_roster_note FROM guilds').get().official_roster_note, /2 members/);

  // Realm comes back up: everyone gets told (ctx.emit shape, kind 'notice').
  B.state.realmUp = true;
  await G.run(db, BNET, { fetchImpl: B.fetchImpl, notify, only: 'realm' });
  st = JSON.parse(db.prepare('SELECT realm_status FROM guilds').get().realm_status);
  assert.strictEqual(st.up, true); assert.strictEqual(st.queue, true); assert.strictEqual(st.population, 'Full');
  assert.strictEqual(sent.length, 1);
  assert.deepStrictEqual(sent[0].slice(0, 2), [g, 'notice']);
  assert.match(sent[0][2].title, /Zul'jin is back up/);
  assert.match(sent[0][2].body, /queue/);
  assert.strictEqual(sent[0][2].route, '/');

  // A guild Blizzard doesn't know is noted, not an error.
  db.prepare("UPDATE guilds SET game_guild = 'Nobody'").run();
  await G.run(db, BNET, { fetchImpl: B.fetchImpl, only: 'roster' });
  assert.match(db.prepare('SELECT official_roster_note FROM guilds').get().official_roster_note, /Guild "Nobody" not found on Zul'jin/);
});

test('blizzard: the watcher reads the token price and spots a Forever namespace', async () => {
  const calls = [];
  const fake = async (url) => {
    calls.push(url);
    if (url.includes('oauth')) return json({ access_token: 't' });
    if (url.includes('/token/index')) return json({ price: 2500000000 });
    if (url.includes('static-camelot-eu')) return json({});
    return { ok: false, status: 404 };
  };
  const s = await blizzard.check({ bnetClientId: 'id', bnetClientSecret: 'sec' }, fake);
  assert.strictEqual(s.ok, true);
  assert.strictEqual(s.tokenGold, 250000);
  assert.strictEqual(s.forever, 'static-camelot-eu');
  assert.strictEqual(s.foreverKey, 'camelot');
  assert.strictEqual(s.classicEra, false);
  const viaCfg = await blizzard.check({ bnetClientId: 'id', bnetClientSecret: 'sec', fetch: fake });
  assert.strictEqual(viaCfg.forever, 'static-camelot-eu', 'cfg.fetch works too');
  const none = await blizzard.check({}, fake);
  assert.strictEqual(none.ok, false);
  assert.match(none.notes[0], /no Battle.net app built in/);
  const db = open(':memory:');
  assert.strictEqual(blizzard.load(db), null);
  blizzard.save(db, s);
  assert.strictEqual(blizzard.load(db).forever, 'static-camelot-eu');
  await assert.rejects(blizzard.token({ bnetClientId: 'a', bnetClientSecret: 'b' }, async () => ({ ok: false, status: 401 })), /token 401/);
});

// ====================================================================== reset + backup

test('reset: fresh start wipes game data, keeps people, and ignores stale or off-realm uploads', () => {
  const { db, u, g } = freshDb();
  db.prepare("INSERT INTO api_tokens (user_id, guild_id, token_hash, prefix) VALUES (?,?,'h','wowg_x')").run(u, g);
  db.prepare("INSERT INTO devices (user_id, guild_id, token_hash, prefix) VALUES (?,?,'dh','gcd_x')").run(u, g);
  const before = NOW() - 3600;
  const retail = {
    characters: { Testy: { name: 'Testy', class: 'MAGE', level: 80, realm: 'Ragnaros', guild: 'Test Guild', updated: before,
      inventory: { bags: [{ id: 2589, name: 'Linen Cloth', count: 5 }] }, professions: { Tailoring: { name: 'Tailoring', skill: 300, max: 300 } }, recipes: { Tailoring: [{ name: 'Linen Belt' }] } } },
    roster: { scannedAt: before, guild: 'Test Guild', members: [{ name: 'Testy', level: 80, class: 'MAGE', online: true }] },
    guildBank: { scannedAt: before, guild: 'Test Guild', money: 100, tabs: [{ name: 'T', items: [{ id: 2589, name: 'Linen Cloth', count: 1 }] }] },
    prices: { items: [[2589, 100, 2000]] },
    ctaQueue: [{ at: before, character: 'Testy', zone: 'Orgrimmar', msg: 'test', needed: 5 }],
  };
  applyPayload(db, g, u, retail);
  db.prepare("INSERT INTO raids (guild_id, title, instance, starts_at, created_by) VALUES (?, 'Test raid', 'MC', '2026-11-10T19:00:00Z', ?)").run(g, u);
  assert.ok(db.prepare('SELECT COUNT(*) n FROM characters').get().n > 0);
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM professions').get().n, 1);

  const dir = tmpDir('gc-bk-');
  try {
    const r = resetGuild(db, g, dir);
    assert.ok(fs.existsSync(r.backup), 'backup written first');
    assert.strictEqual(r.removed.characters, 1);
    for (const t of ['characters', 'inventory', 'recipes', 'professions', 'raids', 'guild_bank', 'prices', 'ctas', 'activity', 'sync_log'])
      assert.strictEqual(db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n, 0, t);
    assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM memberships').get().n, 1);
    assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM api_tokens').get().n, 1);
    assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM devices').get().n, 1, 'signed-in apps stay signed in');
    assert.strictEqual(db.prepare('SELECT invite_code FROM guilds').get().invite_code, 'inv');
    assert.ok(db.prepare('SELECT reset_at FROM guilds').get().reset_at);
    assert.strictEqual(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }

  // The old Retail file uploads again: none of it comes back.
  applyPayload(db, g, u, retail);
  for (const t of ['characters', 'guild_bank', 'prices', 'ctas']) assert.strictEqual(db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n, 0, `stale ${t}`);

  // First Forever login after the wipe: accepted, and it sets the realm.
  const now = NOW() + 5;
  applyPayload(db, g, u, {
    characters: { Grom: { name: 'Grom', class: 'WARRIOR', level: 1, realm: 'Forever Realm', guild: 'wow', updated: now } },
    roster: { scannedAt: now, guild: 'wow', members: [{ name: 'Grom', level: 1, class: 'WARRIOR', online: true }] },
    prices: { items: [[2589, 120, TODAY()]] },
  });
  assert.deepStrictEqual(db.prepare('SELECT name FROM characters').all().map((c) => c.name), ['Grom']);
  assert.strictEqual(db.prepare('SELECT realm FROM guilds').get().realm, 'Forever Realm');
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM prices').get().n, 1);

  // Retail played after launch: characters, roster and prices from that upload are kept out.
  applyPayload(db, g, u, { ...retail, characters: { Testy: { ...retail.characters.Testy, updated: now } }, roster: { ...retail.roster, scannedAt: now }, prices: { items: [[999, 5, TODAY()]] } });
  assert.deepStrictEqual(db.prepare('SELECT name FROM characters').all().map((c) => c.name), ['Grom']);
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM prices WHERE item_id = 999').get().n, 0);

  // Without a backup folder (in-memory database) the reset still runs.
  assert.strictEqual(resetGuild(db, g, null).backup, null);
});

test('backup: consistent snapshots, and old ones rotate out', () => {
  const dir = tmpDir('gc-wowbk-');
  const db = open(path.join(dir, 'guildcamp.db'));
  try {
    db.prepare("INSERT INTO guilds (name, invite_code) VALUES ('wow','x')").run();
    const bdir = backup.backupDir(path.join(dir, 'guildcamp.db'));
    assert.strictEqual(bdir, path.join(dir, 'backups'));
    assert.deepStrictEqual(backup.listBackups(bdir), [], 'no folder yet');
    for (let d = 1; d <= 4; d++) backup.runBackup(db, bdir, { keep: 2, now: new Date(Date.UTC(2026, 10, d, 3)) });
    const list = backup.listBackups(bdir);
    assert.deepStrictEqual(list.map((b) => b.file), ['guildcamp-20261104-030000.db', 'guildcamp-20261103-030000.db']);
    assert.ok(list[0].bytes > 0 && !Number.isNaN(Date.parse(list[0].at)));
    assert.strictEqual(list[0].path, path.join(bdir, list[0].file), 'the full path, for "show in folder"');
    // Same second again: the existing file is returned, not overwritten.
    assert.strictEqual(backup.runBackup(db, bdir, { now: new Date(Date.UTC(2026, 10, 4, 3)) }), path.join(bdir, 'guildcamp-20261104-030000.db'));
    const copy = open(path.join(bdir, list[0].file));
    assert.strictEqual(copy.prepare('SELECT name FROM guilds').get().name, 'wow');
    copy.close();
    assert.strictEqual(backup.backupIfDue(db, bdir, 24 * 365 * 10), null, 'fresh backup means nothing is due');
    const due = backup.backupIfDue(db, bdir, 0);
    assert.ok(due && fs.existsSync(due), 'an old enough backup makes a new one');
    assert.ok(backup.isBackupName('guildcamp-20261104-030000.db'));
    assert.ok(!backup.isBackupName('../guildcamp.db'));
    assert.ok(!backup.isBackupName('wow-20261104-030000.db'));
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ====================================================================== calendar

test('calendar: the export is valid iCalendar with reminders and cancellations', () => {
  const ics = buildIcs({ guildName: 'wow', raids: [
    { id: 7, created_at: '2026-12-01 10:00:00', title: 'Hyjal, week 1', instance: 'Hyjal Summit', starts_at: '2026-12-09T18:00:00.000Z', duration_min: 180, coming: 12, signup: 'yes', notes: 'Bring flasks; and food' },
    { id: 8, title: 'Old', instance: 'MC', starts_at: '2026-12-10T18:00:00.000Z', cancelled_at: '2026-12-01', status: 'cancelled', kind: 'pvp' },
  ] });
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /END:VCALENDAR\r\n$/);
  assert.match(ics, /UID:raid-7-wow-20261201T100000Z@guildcamp\.app/);
  assert.match(ics, /UID:raid-8-wow-20261210T180000Z@guildcamp\.app/, 'without created_at the start time keeps the UID stable');
  assert.match(ics, /DTSTART:20261209T180000Z/);
  assert.match(ics, /DTEND:20261209T210000Z/);
  assert.match(ics, /SUMMARY:Raid: Hyjal\\, week 1/);
  assert.match(ics, /SUMMARY:PvP: Old/);
  assert.match(ics, /STATUS:CANCELLED/);
  assert.match(ics, /BEGIN:VALARM[\s\S]*TRIGGER:-PT30M/);
  assert.match(ics.replace(/\r\n /g, ''), /DESCRIPTION:You’re coming\. 12 coming\.\\nBring flasks\\; and food\\nSign up in Guild Camp\./);
  assert.doesNotMatch(ics, /https?:\/\//, 'no server address anywhere');
  for (const line of ics.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, `line too long: ${line}`);
});

test('calendar: the export lists the guild\'s raids from the last 30 days on, with my sign-up', () => {
  const { db, u, g, addMember } = freshDb();
  const b = addMember('Bravo#2');
  const add = (title, days) => db.prepare("INSERT INTO raids (guild_id, title, instance, starts_at) VALUES (?,?, 'MC', ?)").run(g, title, new Date(Date.now() + days * 86400000).toISOString()).lastInsertRowid;
  add('Long ago', -40);
  const recent = add('Last week', -7);
  const next = add('Next week', 7);
  db.prepare("INSERT INTO signups (raid_id, user_id, character, role, status) VALUES (?,?, 'Me', 'dps', 'yes'), (?,?, 'Bravo', 'tank', 'yes'), (?,?, 'Bravo', 'tank', 'tentative')").run(next, u, next, b, recent, b);
  const rows = feedRaids(db, g, u);
  assert.deepStrictEqual(rows.map((r) => [r.title, r.signup, r.coming]), [['Last week', null, 0], ['Next week', 'yes', 2]]);
  const ics = buildIcs({ guildName: 'wow', raids: rows });
  assert.match(ics, /You haven’t signed up yet/);
});
