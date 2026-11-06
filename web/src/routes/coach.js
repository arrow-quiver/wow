// The Coach on the website: play style, AI build plan, and instant questions.
const C = require('../coach');
const V = require('../views/coach');
const ai = require('../ai');

module.exports = function coachRoutes(app, { db, cfg, needGuild, needOfficer, back, audit }) {
  const mine = (req) => db.prepare('SELECT * FROM coach_chars WHERE guild_id = ? AND user_id = ? ORDER BY updated_at DESC').all(req.guild.id, req.user.id);
  const enabled = (req) => Boolean(db.prepare('SELECT coach_enabled FROM guilds WHERE id = ?').get(req.guild.id).coach_enabled);

  app.get('/coach', needGuild, (req, res) => {
    const chars = mine(req);
    const current = chars.find((c) => c.name === req.query.char) || chars[0] || null;
    const answers = db.prepare('SELECT * FROM coach_qa WHERE guild_id = ? AND user_id = ? ORDER BY id DESC LIMIT 15').all(req.guild.id, req.user.id)
      .map((a) => ({ ...a, sources: C.parse(a.sources) || [] }));
    res.page({
      title: 'Coach', active: 'coach',
      body: V.coachPage({
        csrf: req.csrf, chars, current, answers,
        profile: current && C.parse(current.profile), talents: current && C.parse(current.talents), plan: current && C.parse(current.plan),
        planBusy: Boolean(current && cfg.anthropicKey && C.wantsPlan(db, req.user.id).some((c) => c.id === current.id)),
        left: Math.max(0, C.LIMITS.questionsPerDay - ai.todayCount(db, req.user.id, 'question')),
        enabled: enabled(req), hasKey: Boolean(cfg.anthropicKey),
      }),
    });
  });

  app.post('/coach/ask', needGuild, async (req, res) => {
    const question = String(req.body.question || '').trim().slice(0, 500);
    const char = String(req.body.char || '').slice(0, 40);
    const to = `/coach${char ? `?char=${encodeURIComponent(char)}` : ''}`;
    if (!question) return back(res, to, 'Type a question first.');
    const id = db.prepare("INSERT INTO coach_qa (guild_id, user_id, char_name, qid, source, question) VALUES (?,?,?,?, 'web', ?)")
      .run(req.guild.id, req.user.id, char || null, `web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, question).lastInsertRowid;
    const r = await C.answer(db, cfg, id);
    back(res, to, r && r.status === 'answered' ? 'The Coach answered below.' : `No answer: ${(r && r.error) || 'something went wrong'}`);
  });

  app.post('/coach/plan', needGuild, async (req, res) => {
    const char = String(req.body.char || '').slice(0, 40);
    const to = `/coach${char ? `?char=${encodeURIComponent(char)}` : ''}`;
    try { await C.plan(db, cfg, req.guild.id, req.user.id, char); back(res, to, 'Your new build plan is ready. It reaches the game after your next sync and /reload.'); } catch (e) { back(res, to, e.message); }
  });

  app.post('/settings/coach', needOfficer, (req, res) => {
    const budget = Math.max(0, Math.min(500, Number(req.body.budget) || 0));
    db.prepare('UPDATE guilds SET coach_enabled = ?, coach_budget_usd = ? WHERE id = ?').run(req.body.enabled ? 1 : 0, budget, req.guild.id);
    audit(req, 'coach settings', `${req.body.enabled ? 'on' : 'off'}, $${budget}/month`);
    back(res, '/settings', 'Coach settings saved.');
  });
};
