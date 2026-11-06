// Minimal Claude Messages API client for the Coach.
// Uses Claude's server-side web search so answers about WoW: Forever (newer than the model's
// training) can be checked against Wowhead and other sites. Every call is metered in ai_usage
// so a guild can't run past its monthly budget.
const API = 'https://api.anthropic.com/v1/messages';

// USD per million tokens, and per search. Unknown models are costed as Sonnet.
const PRICES = {
  'claude-haiku-5-5': { in: 0.1, out: 0.5 },
  'claude-sonnet-5-5': { in: 2, out: 10 },
  'claude-opus-5-5': { in: 4, out: 20 },
};
const SEARCH_USD = 0.01;

function cost(model, usage, searches) {
  const p = PRICES[model] || PRICES['claude-sonnet-5-5'];
  const inTok = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
  return (inTok * p.in + (usage.output_tokens || 0) * p.out) / 1e6 + searches * SEARCH_USD;
}

function monthSpend(db, guildId) {
  return db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS usd FROM ai_usage WHERE guild_id = ? AND created_at >= date('now', 'start of month')").get(guildId).usd;
}
function todayCount(db, userId, kind) {
  return db.prepare("SELECT COUNT(*) AS n FROM ai_usage WHERE user_id = ? AND kind = ? AND created_at >= date('now')").get(userId, kind).n;
}

// Returns { text, sources: [{url,title}], usage, cost }.
async function ask(cfg, { system, messages, model, maxTokens = 1200, searches = 0, fetchImpl }) {
  if (!cfg.anthropicKey) throw new Error('The Coach needs a Claude API key (ANTHROPIC_API_KEY) on the server.');
  const f = fetchImpl || cfg.claudeFetch || fetch;
  const body = { model, max_tokens: maxTokens, system, messages: [...messages] };
  if (searches > 0) {
    body.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: searches,
      allowed_domains: ['wowhead.com', 'warcraft.wiki.gg', 'worldofwarcraft.blizzard.com', 'icy-veins.com', 'reddit.com'] }];
  }
  const total = { input_tokens: 0, output_tokens: 0 };
  let searchCount = 0; const blocks = [];
  // A long search turn can pause; resend it to let Claude finish (at most a few times).
  for (let round = 0; round < 4; round++) {
    const res = await f(API, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': cfg.anthropicKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Claude API ${res.status}: ${(data.error && data.error.message) || 'request failed'}`);
    for (const k of ['input_tokens', 'output_tokens']) total[k] += (data.usage && data.usage[k]) || 0;
    searchCount += (data.usage && data.usage.server_tool_use && data.usage.server_tool_use.web_search_requests) || 0;
    blocks.push(...(data.content || []));
    if (data.stop_reason !== 'pause_turn') break;
    body.messages = [...messages, { role: 'assistant', content: data.content }];
  }
  const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  const seen = new Map();
  for (const b of blocks) for (const c of (b.citations || [])) if (c.url && !seen.has(c.url)) seen.set(c.url, { url: c.url, title: c.title || c.url });
  return { text, sources: [...seen.values()].slice(0, 5), usage: total, searches: searchCount, cost: cost(model, total, searchCount) };
}

function record(db, { guildId, userId, kind, model, r }) {
  db.prepare('INSERT INTO ai_usage (guild_id, user_id, kind, model, input_tokens, output_tokens, searches, cost_usd) VALUES (?,?,?,?,?,?,?,?)')
    .run(guildId, userId || null, kind, model, r.usage.input_tokens, r.usage.output_tokens, r.searches, r.cost);
}

module.exports = { ask, record, cost, monthSpend, todayCount, PRICES };
