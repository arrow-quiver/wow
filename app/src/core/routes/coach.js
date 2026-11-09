// The Coach in the app: play style, AI build plans, next steps and questions to Claude.
// Ported from the old web/src/routes/coach.js; the Claude work lives in services/coach.js and services/ai.js.
//
//   GET  /api/coach?char=<name>   everything the Coach page shows for one of my characters
//   POST /api/coach/ask           { char, question } → answered at once when Claude is quick, otherwise pending
//   POST /api/coach/plan          { char } → a fresh build plan (ready, or pending while Claude writes it)
//
// Background work: ctx.services.coach = { kick(), run() }.
//   run()  processes waiting questions and wanted plans now (services/coach.processPending) → Promise<result>.
//   kick() schedules run() soon. The sync route calls it after an upload brings in-game questions or plan
//          requests. A no-op while cfg.timers is off (tests call run() themselves).
// With cfg.timers on, run() also repeats every minute, like the old server.
//
// Requests from the app wait at most cfg.coachWaitMs (default 12 s, under the app's 20 s request limit)
// for Claude. Anything slower finishes in the background and sends a 'coach' event when it is done.
const C = require('../services/coach');
const ai = require('../services/ai');
const { HttpError, str, needGuild, parseJson } = require('../http');

const RUN_EVERY_MS = 60 * 1000;
const KICK_DELAY_MS = 500;
const DEFAULT_WAIT_MS = 12000;
const RECENT_QUESTIONS = 15;
const NO_KEY = 'The Coach\'s AI answers are off. Add your Anthropic API key in Settings to turn them on.';
const LATE = Symbol('late');

// Resolves { value } or { error } when `promise` settles within `ms`, otherwise LATE.
function within(promise, ms) {
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve(LATE), ms); });
  return Promise.race([promise.then((value) => ({ value }), (error) => ({ error })), late])
    .finally(() => clearTimeout(timer));
}

// Claude's citations, kept to web links the app can open in the browser.
function cleanSources(v) {
  const list = Array.isArray(v) ? v : [];
  return list
    .filter((s) => s && typeof s.url === 'string' && /^https?:\/\/[^\s]+$/i.test(s.url))
    .slice(0, 5)
    .map((s) => ({ url: s.url, title: String(s.title || s.url).slice(0, 200) }));
}

// A stored plan for JSON: talents the character already has are marked `taken` (any rank), with the
// rank they have now. A plan that couldn't be made is { error, at }.
function planJson(plan, talents) {
  if (!plan || typeof plan !== 'object') return null;
  if (plan.error) return { error: String(plan.error), at: plan.at ?? null };
  const picked = new Map();
  for (const t of Array.isArray(talents && talents.picked) ? talents.picked : Object.values((talents && talents.picked) || {})) {
    if (t && t.name) picked.set(String(t.name).toLowerCase(), Number(t.rank) || 0);
  }
  return {
    ...plan,
    talents: (Array.isArray(plan.talents) ? plan.talents : []).map((t) => {
      const rank = picked.get(String(t.name || '').toLowerCase()) || 0;
      return { ...t, taken: rank > 0, rank: rank || null };
    }),
    sources: cleanSources(plan.sources),
  };
}

function questionJson(row) {
  return {
    id: row.id,
    char_name: row.char_name ?? null,
    source: row.source,
    question: row.question,
    answer: row.answer ?? null,
    sources: cleanSources(parseJson(row.sources, [])),
    status: row.status,
    error: row.error ?? null,
    created_at: row.created_at,
    answered_at: row.answered_at ?? null,
  };
}

// The character's coach_chars row for JSON, with the addon's JSON columns parsed.
function characterJson(c) {
  if (!c) return null;
  return {
    name: c.name,
    class: c.class ?? null,
    level: c.level ?? null,
    realm: c.realm ?? null,
    profile: parseJson(c.profile, null),
    stats: parseJson(c.stats, null),
    quiz: parseJson(c.quiz, null),
    talents: parseJson(c.talents, null),
    gear: parseJson(c.gear, null),
    plan_at: c.plan_at ?? null,
    plan_level: c.plan_level ?? null,
    plan_requested_at: c.plan_requested_at ?? null,
    updated_at: c.updated_at,
  };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const numberOrNull = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
// Professions that don't need levelling alongside the character (the addon skips them too).
const SECONDARY = new Set(['Fishing', 'Cooking', 'First Aid']);

// What to do next, worked out from synced data. Same rules and wording as the addon's Coach
// (addon/WowGuild/Coach.lua nextSteps), minus the class trainer reminder, which only the game can see.
//   kind: talent | repair | bags | prof | quiz | raid | plan;  route/at only on some steps.
function nextSteps(db, guildId, userId, ch, plan) {
  const steps = [];
  const add = (kind, title, detail, extra = {}) => steps.push({ kind, title, detail, ...extra });
  const t = ch.talents || {};
  const g = ch.gear || {};
  const level = Number(ch.level) || 1;
  const goodPlan = plan && !plan.error ? plan : null;

  const unspent = Number(t.unspent) || 0;
  if (unspent > 0) {
    const next = goodPlan && (goodPlan.talents.find((x) => !x.taken) || goodPlan.talents[0]);
    add('talent', `Spend ${plural(unspent, 'talent point')}`,
      next ? `Your plan says: ${next.name}${next.tree ? ` (${next.tree})` : ''}.` : 'Open your talents in game (N).');
  }
  const durability = numberOrNull(g.lowestDurability);
  if (durability !== null && durability < 25) {
    add('repair', 'Repair your gear', `Something is down to ${Math.round(durability)}% durability.`);
  }
  const free = numberOrNull(g.freeSlots);
  if (free !== null && free < 4) {
    add('bags', 'Make bag space', `Only ${plural(free, 'free bag slot')}. Vendor grey items or bank what you don't need.`);
  }
  const profs = db.prepare(`SELECT p.name, p.skill, p.max_skill FROM professions p JOIN characters c ON c.id = p.character_id
    WHERE c.guild_id = ? AND c.name = ? AND (c.user_id = ? OR c.user_id IS NULL) ORDER BY p.name`).all(guildId, ch.name, userId);
  for (const p of profs) {
    const cap = Math.min(level * 5, p.max_skill || 300);
    if (p.skill != null && p.max_skill > 75 && p.skill < cap - 30 && !SECONDARY.has(p.name)) {
      add('prof', `${p.name} is behind your level`, `${p.skill} of about ${cap}. The skill-up guide in game shows what to make.`);
    }
  }
  const quizDone = (ch.quiz && typeof ch.quiz === 'object' && Object.keys(ch.quiz).length) || (ch.profile && ch.profile.quiz === true);
  if (!quizDone) {
    add('quiz', 'Tell the Coach how you play', "Five quick questions. In game, type /wow coach and press 'Tune my style'.");
  }
  const raid = db.prepare(`SELECT r.id, r.title, r.starts_at FROM raids r
    WHERE r.guild_id = ? AND r.status = 'open' AND r.starts_at > ?
      AND NOT EXISTS (SELECT 1 FROM signups s WHERE s.raid_id = r.id AND s.user_id = ?)
    ORDER BY r.starts_at LIMIT 1`).get(guildId, new Date().toISOString(), userId);
  if (raid) add('raid', `Sign up: ${raid.title}`, 'Pick a character and role in Guild Camp.', { route: `/raids/${raid.id}`, at: raid.starts_at });
  for (const s of (goodPlan && Array.isArray(goodPlan.next_steps) ? goodPlan.next_steps : [])) {
    if (s && s.title) add('plan', s.title, s.detail || '');
  }
  return steps;
}

function register(app, ctx) {
  const { db, cfg } = ctx;
  const log = ctx.log || console;
  const waitMs = () => (Number.isFinite(Number(cfg.coachWaitMs)) ? Number(cfg.coachWaitMs) : DEFAULT_WAIT_MS);
  // inboxPart only counts plans as pending when they can actually be written.
  C.setKeyPresent(() => Boolean(cfg.anthropicKey));

  const q = {
    // Every upload refreshes all of an account's coach characters at once, so ties are normal: the
    // character played most recently (characters.last_seen from the same upload) comes first, then level.
    chars: db.prepare(`SELECT cc.* FROM coach_chars cc LEFT JOIN characters ch ON ch.guild_id = cc.guild_id AND ch.name = cc.name
      WHERE cc.guild_id = ? AND cc.user_id = ? ORDER BY cc.updated_at DESC, ch.last_seen DESC, cc.level DESC, cc.id`),
    questions: db.prepare('SELECT * FROM coach_qa WHERE guild_id = ? AND user_id = ? ORDER BY id DESC LIMIT ?'),
    question: db.prepare('SELECT * FROM coach_qa WHERE id = ?'),
    insert: db.prepare("INSERT INTO coach_qa (guild_id, user_id, char_name, qid, source, question) VALUES (?,?,?,?, 'app', ?)"),
    guild: db.prepare('SELECT coach_enabled, coach_budget_usd FROM guilds WHERE id = ?'),
    usage: db.prepare("SELECT kind, COUNT(*) AS n FROM ai_usage WHERE guild_id = ? AND created_at >= date('now', 'start of month') GROUP BY kind"),
  };

  // ---- background work ----
  // Notifications for plans written while nobody was waiting on a request.
  const planReady = (guildId, userId, name, p) => ctx.emit(guildId, 'coach', {
    title: `Your build plan for ${name} is ready`, body: (p && p.headline) || 'Open the Coach to see it.', route: '/coach', userId });
  const planFailed = (guildId, userId, name, e) => ctx.emit(guildId, 'coach', {
    title: `Your build plan for ${name} couldn't be made`, body: String((e && e.message) || e), route: '/coach', userId });

  async function run() {
    try {
      const r = await C.processPending(db, cfg, { notify: ctx.emit, onPlan: (c, p) => planReady(c.guild_id, c.user_id, c.name, p) });
      if (r.answered || r.plans || r.failed) log.info(`Coach: ${r.answered} answered, ${r.plans} plans, ${r.failed} failed`);
      return r;
    } catch (e) {
      log.warn('Coach failed:', e && e.message ? e.message : e);
      return { answered: 0, plans: 0, failed: 0, error: String((e && e.message) || e) };
    }
  }
  let kickTimer = null;
  function kick() {
    if (!cfg.timers || kickTimer) return;
    kickTimer = setTimeout(() => {
      const i = ctx.timers.indexOf(kickTimer);
      if (i >= 0) ctx.timers.splice(i, 1);
      kickTimer = null;
      run();
    }, KICK_DELAY_MS);
    if (kickTimer.unref) kickTimer.unref();
    ctx.timers.push(kickTimer);
  }
  ctx.services.coach = { kick, run };
  if (cfg.timers) {
    const t = setInterval(run, RUN_EVERY_MS);
    if (t.unref) t.unref();
    ctx.timers.push(t);
  }

  // Whether the AI part can run for this guild right now, and why not.
  function aiState(guildId) {
    const g = q.guild.get(guildId) || { coach_enabled: 0, coach_budget_usd: 0 };
    const hasKey = Boolean(cfg.anthropicKey);
    const enabled = Boolean(g.coach_enabled);
    const spent = ai.monthSpend(db, guildId);
    const budgetLeft = spent < g.coach_budget_usd;
    let reason = null;
    if (!hasKey) reason = NO_KEY;
    else if (!enabled) reason = 'The Coach\'s AI answers are switched off in Guild settings.';
    else if (!budgetLeft) reason = 'Your Coach budget for this month is used up. You can raise it in Guild settings.';
    return { available: !reason, hasKey, enabled, budgetLeft, reason, spent, budget: g.coach_budget_usd };
  }

  function limits(userId) {
    const questions = ai.todayCount(db, userId, 'question');
    const plans = ai.todayCount(db, userId, 'plan');
    return {
      questionsPerDay: C.LIMITS.questionsPerDay,
      plansPerDay: C.LIMITS.plansPerDay,
      questionsLeft: Math.max(0, C.LIMITS.questionsPerDay - questions),
      plansLeft: Math.max(0, C.LIMITS.plansPerDay - plans),
    };
  }

  // Refuses before anything is stored or sent to Claude, with the reason in plain words.
  function mustRun(req, kind) {
    if (!cfg.anthropicKey) throw new HttpError(503, NO_KEY);
    const blocked = C.guard(db, req.guild.id, req.user.id, kind);
    if (blocked) throw new HttpError(403, blocked);
  }

  app.get('/api/coach', needGuild, (req, res) => {
    const guildId = req.guild.id;
    const userId = req.user.id;
    const rows = q.chars.all(guildId, userId);
    const wanted = str(req.query.char, 40);
    const row = (wanted && (rows.find((c) => c.name === wanted) || rows.find((c) => c.name.toLowerCase() === wanted.toLowerCase()))) || rows[0] || null;
    const state = aiState(guildId);
    const character = characterJson(row);
    const plan = row ? planJson(parseJson(row.plan, null), character.talents) : null;
    // A plan counts as on its way while one is being written, or while the background pass will write
    // one (no plan yet, asked for in game, or 3+ levels since the last one) and can.
    const planBusy = Boolean(row && (C.isPlanning(row.id)
      || (state.available && cfg.timers && C.wantsPlan(db, userId).some((c) => c.id === row.id))));
    // The key and the budget are the player's own, so everyone sees what this month cost.
    const counts = Object.fromEntries(q.usage.all(guildId).map((u) => [u.kind, u.n]));
    const usage = {
      month: new Date().toISOString().slice(0, 7),
      spentUsd: Math.round(state.spent * 10000) / 10000,
      budgetUsd: state.budget,
      questions: counts.question || 0,
      plans: counts.plan || 0,
    };
    res.json({
      characters: rows.map((c) => {
        const p = parseJson(c.profile, null);
        return { name: c.name, class: c.class ?? null, level: c.level ?? null, realm: c.realm ?? null,
          updated_at: c.updated_at, archetype: (p && p.archetype) || null, hasPlan: Boolean(c.plan) };
      }),
      character,
      plan,
      planBusy,
      nextSteps: row ? nextSteps(db, guildId, userId, character, plan) : [],
      questions: q.questions.all(guildId, userId, RECENT_QUESTIONS).map(questionJson),
      limits: limits(userId),
      ai: { available: state.available, hasKey: state.hasKey, enabled: state.enabled, budgetLeft: state.budgetLeft, reason: state.reason },
      usage,
    });
  });

  app.post('/api/coach/ask', needGuild, async (req, res) => {
    const question = str(req.body.question, 500);
    if (!question) throw new HttpError(400, 'Type a question first.');
    mustRun(req, 'question');
    const c = C.charFor(db, req.guild.id, req.user.id, str(req.body.char, 40));
    const qid = `app-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const id = Number(q.insert.run(req.guild.id, req.user.id, c ? c.name : null, qid, question).lastInsertRowid);
    // live: what the app's live link saw (a death recap, or this session so far), for this question only.
    const work = C.answer(db, cfg, id, { fresh: req.body.fresh === true, extra: str(req.body.live, 2500) || '' });
    const done = await within(work, waitMs());
    if (done === LATE) {
      // Still thinking: answer in the background and tell the member when it's there.
      work.then((r) => {
        if (!r) return;
        if (r.status === 'answered') ctx.emit(r.guild_id, 'coach', C.answeredNote(r));
        else if (r.status === 'failed') ctx.emit(r.guild_id, 'coach', { title: 'The Coach couldn\'t answer', body: r.error || 'Try asking again.', route: '/coach', userId: r.user_id });
      }).catch((e) => log.warn('Coach answer failed:', e && e.message ? e.message : e));
      return res.status(202).json({ question: questionJson(q.question.get(id)), message: 'The Coach is still thinking. The answer shows here when it\'s ready.' });
    }
    const row = questionJson(q.question.get(id));
    res.json({ question: row, message: row.status === 'answered' ? 'The Coach answered.' : `No answer: ${row.error || 'something went wrong.'}` });
  });

  app.post('/api/coach/plan', needGuild, async (req, res) => {
    const c = C.charFor(db, req.guild.id, req.user.id, str(req.body.char, 40));
    if (!c) throw new HttpError(400, 'No character data yet. Log in with the addon and sync once.');
    if (!C.isPlanning(c.id)) mustRun(req, 'plan');
    const work = C.plan(db, cfg, req.guild.id, req.user.id, c.name);
    const done = await within(work, waitMs());
    if (done === LATE) {
      work.then((p) => planReady(req.guild.id, req.user.id, c.name, p), (e) => planFailed(req.guild.id, req.user.id, c.name, e));
      return res.status(202).json({ status: 'pending', char: c.name,
        message: 'The Coach is writing your plan. It can take a minute; it shows here when it\'s ready.' });
    }
    if (done.error) throw done.error;
    const fresh = db.prepare('SELECT talents FROM coach_chars WHERE id = ?').get(c.id);
    res.json({ status: 'ready', char: c.name, plan: planJson(done.value, parseJson(fresh && fresh.talents, null)),
      message: 'Your new build plan is ready. It reaches the game after your next sync and /reload.' });
  });
}

module.exports = { register, nextSteps, planJson, cleanSources };
