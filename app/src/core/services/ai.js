// Minimal Claude Messages API client for the Coach. Ported from the old web/src/ai.js.
// Uses Claude's server-side web search so answers about WoW: Forever (newer than the model's
// training) can be checked against Wowhead and other sites. Every call is metered in ai_usage
// so a guild can't run past its monthly budget.
//
// Exports
//   ask(cfg, { system, messages, model, maxTokens = 1200, searches = 0, fetchImpl })
//       → { text, sources: [{url, title}] (max 5), usage: {input_tokens, output_tokens}, searches, cost }
//       Throws HttpError 503 without cfg.anthropicKey, 502 when Claude can't be reached or refuses.
//   record(db, { guildId, userId, kind: 'plan'|'question', model, r })   one ai_usage row for an ask() result
//       Searches only SEARCH_SITES. A site Claude's search can't read (the API refuses the whole request with
//       "domains are not accessible") is dropped for this run of the app and the request sent again without it.
//   SEARCH_SITES: WoW: Forever guides and item databases, Wowhead first
//   cost(model, usage, searches) → USD          monthSpend(db, guildId) → USD this calendar month (UTC)
//   todayCount(db, userId, kind) → calls today (UTC)                     PRICES (USD per million tokens)
// Injected dependencies: outside HTTP goes through fetchImpl, else cfg.fetch, else global fetch.
const { HttpError } = require('../http');

const API = 'https://api.anthropic.com/v1/messages';

// USD per million tokens, and per search. Unknown models are costed as Sonnet.
const PRICES = {
  'claude-haiku-5-5': { in: 0.1, out: 0.5 },
  'claude-sonnet-5-5': { in: 2, out: 10 },
  'claude-opus-5-5': { in: 4, out: 20 },
};
const SEARCH_USD = 0.01;

// Where the Coach's web search may look: WoW: Forever guides and databases. Reddit and some other sites block
// Claude's search; listing one makes the API refuse the whole request, so they are left out (and any site the
// API refuses later is dropped at run time, below).
const SEARCH_SITES = ['wowhead.com', 'warcraft.wiki.gg', 'worldofwarcraft.blizzard.com', 'method.gg', 'mobalytics.gg',
  'warcrafttavern.com', 'icy-veins.com'];
const refusedSites = new Set();

// "The following domains are not accessible to our user agent: ['reddit.com']" → ['reddit.com']
function refusedDomains(message) {
  if (!/domains are not accessible/i.test(String(message || ''))) return [];
  const list = /\[([^\]]*)\]/.exec(message);
  return list ? [...list[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1].toLowerCase()) : [];
}
const searchTool = (searches) => {
  const sites = SEARCH_SITES.filter((d) => !refusedSites.has(d));
  return sites.length ? [{ type: 'web_search_20250305', name: 'web_search', max_uses: searches, allowed_domains: sites }] : null;
};

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

async function ask(cfg, { system, messages, model, maxTokens = 1200, searches = 0, fetchImpl }) {
  if (!cfg.anthropicKey) throw new HttpError(503, 'The Coach\'s AI answers are off. Add your Anthropic API key in Settings to turn them on.');
  const f = fetchImpl || cfg.fetch || globalThis.fetch;
  const body = { model, max_tokens: maxTokens, system, messages: [...messages] };
  const setTools = () => { const t = searches > 0 && searchTool(searches); if (t) body.tools = t; else delete body.tools; };
  setTools();
  let retries = 0;
  const total = { input_tokens: 0, output_tokens: 0 };
  let searchCount = 0; const blocks = [];
  // A long search turn can pause; resend it to let Claude finish (at most a few times).
  for (let round = 0; round < 4; round++) {
    let res;
    try {
      res = await f(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': cfg.anthropicKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(90000),
      });
    } catch (e) {
      throw new HttpError(502, 'Could not reach the Claude API. Try again in a minute.');
    }
    const data = await res.json().catch(() => ({}));
    const refused = res.status === 400 && body.tools ? refusedDomains(data.error && data.error.message) : [];
    if (refused.length && retries < 2) {
      // A search site blocks Claude's search: leave it out from now on, and ask again.
      retries += 1; round -= 1;
      for (const d of refused) { refusedSites.add(d); for (const s of SEARCH_SITES) if (s === d || s.endsWith(`.${d}`) || d.endsWith(`.${s}`)) refusedSites.add(s); }
      setTools();
      continue;
    }
    if (!res.ok) throw new HttpError(502, `Claude API ${res.status}: ${(data.error && data.error.message) || 'request failed'}`);
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

module.exports = { ask, record, cost, monthSpend, todayCount, PRICES, SEARCH_SITES, refusedDomains, _refusedSites: refusedSites };
