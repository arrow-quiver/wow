const { esc, ago } = require('./layout');

const csrfField = (csrf) => `<input type="hidden" name="_csrf" value="${esc(csrf)}">`;
const DIMS = [
  ['aggression', 'Aggression', 'How readily you start fights'],
  ['risk', 'Risk taking', 'How often fights go wrong'],
  ['social', 'Social', 'Time spent grouped'],
  ['pvp', 'PvP focus', 'Flagged, battlegrounds, kills, duels'],
  ['pace', 'Pace', 'Fighting and questing per hour'],
];
const CLASS_COLOURS = { WARRIOR: '#C69B6D', PALADIN: '#F48CBA', HUNTER: '#AAD372', ROGUE: '#FFF468', PRIEST: '#FFFFFF', SHAMAN: '#0070DD', MAGE: '#3FC7EB', WARLOCK: '#8788EE', DRUID: '#FF7C0A', DEATHKNIGHT: '#C41E3A', MONK: '#00FF98', DEMONHUNTER: '#A330C9', EVOKER: '#33937F' };
const title = (s) => String(s || '').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

function coachPage({ csrf, chars, current, profile, talents, plan, answers, left, enabled, hasKey, planBusy }) {
  const picker = chars.length > 1 ? `<nav class="chip-row" aria-label="Characters">${chars.map((c) => `<a class="chip${current && c.name === current.name ? ' is-on' : ''}" href="/coach?char=${encodeURIComponent(c.name)}">${esc(c.name)} <span class="muted">${esc(c.level || '')}</span></a>`).join('')}</nav>` : '';
  const ai = !hasKey ? '<p class="warn">The AI part of the Coach isn’t set up yet (no Claude API key on the server). Play-style tracking still works.</p>'
    : !enabled ? '<p class="warn">An officer has switched the Coach’s AI off.</p>' : '';
  if (!current) {
    return `<h1>Coach</h1><p class="lede">Your personal guide: it learns how you play, then suggests talents, stats, gear and what to do next.</p>${ai}
    <section class="setting"><h2>Getting started</h2><ol class="steps-list">
      <li>Update the addon to 0.8.0 or newer (<a href="/get">downloads</a>).</li>
      <li>In game, open the guild window and press <strong>Coach</strong>. Answer the five quick questions about how you like to play.</li>
      <li>Play as normal. The addon watches how you fight, group and PvP (outside combat only), and the Coach gets sharper the more you play.</li>
      <li>Log out or /reload with the companion running. Your plan appears here and in game.</li></ol></section>`;
  }
  const colour = CLASS_COLOURS[String(current.class || '').toUpperCase()] || 'inherit';
  const scores = (profile && profile.scores) || {};
  const picked = new Set(((talents && talents.picked) || []).map((t) => String(t.name).toLowerCase()));
  const bars = DIMS.map(([k, label, hint]) => {
    const v = Math.max(0, Math.min(100, Number(scores[k]) || 0));
    return `<li><div class="style-label"><span>${label}</span><span class="muted">${scores[k] == null ? '–' : v}</span></div>
      <div class="bar style-bar" role="meter" aria-valuenow="${v}" aria-valuemin="0" aria-valuemax="100" aria-label="${label}"><span style="width:${v}%"></span></div>
      <p class="hint">${hint}</p></li>`;
  }).join('');
  const trees = (talents && talents.trees) || [];

  const planHtml = !plan ? `<p class="muted">${hasKey && enabled ? (planBusy ? 'Your first plan is being written. Refresh in a minute.' : 'No plan yet.') : 'Plans need the Coach AI.'}</p>`
    : plan.error ? `<p class="warn">The last plan couldn’t be made: ${esc(plan.error)}</p>`
    : `<p class="plan-headline">${esc(plan.headline)}</p>
      <p>${esc(plan.summary)}</p>
      <p>${plan.spec ? `<span class="pill">${esc(plan.spec)}</span> ` : ''}${plan.split ? `<span class="pill">${esc(plan.split)}</span> ` : ''}
        <span class="muted">${plan.confidence === 'forever' ? 'Checked against WoW: Forever sources.' : 'Based on Classic Era. WoW: Forever may differ.'} Made at level ${esc(plan.level || '?')}, ${ago(new Date(plan.at * 1000).toISOString())}.</span></p>
      <div class="coach-grid">
        <div><h3>Talents, in order</h3><ol class="talent-list">${(plan.talents || []).map((t) => `<li class="${picked.has(String(t.name).toLowerCase()) ? 'is-done' : ''}">
          <strong>${esc(t.name)}</strong> <span class="muted">${esc(t.tree)} · ${esc(t.points)} pt${t.points === 1 ? '' : 's'}</span><br><span class="hint">${esc(t.why)}</span></li>`).join('')}</ol></div>
        <div>
          ${(plan.stats || []).length ? `<h3>Stats that matter most</h3><ol class="stat-chips">${plan.stats.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>` : ''}
          ${(plan.next_steps || []).length ? `<h3>Do next</h3><ul class="board">${plan.next_steps.map((n) => `<li><strong>${esc(n.title)}</strong><br><span class="muted">${esc(n.detail)}</span></li>`).join('')}</ul>` : ''}
          ${(plan.gear || []).length ? `<h3>Gear</h3><ul class="board">${plan.gear.map((g) => `<li><strong>${esc(g.slot)}</strong>: ${esc(g.advice)}</li>`).join('')}</ul>` : ''}
          ${(plan.tips || []).length ? `<h3>For how you play</h3><ul class="board">${plan.tips.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
        </div>
      </div>
      ${(plan.sources || []).length ? `<p class="hint">Sources: ${plan.sources.map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a>`).join(' · ')}</p>` : ''}`;

  return `<h1>Coach</h1>
  <p class="lede">Your personal guide. It learns how you play, then suggests talents, stats, gear and what to do next.</p>
  ${ai}${picker}
  <section class="setting coach-hero">
    <div class="coach-who">
      <p class="coach-name" style="color:${colour}">${esc(current.name)}</p>
      <p class="muted">Level ${esc(current.level || '?')} ${esc(title(current.class))}${trees.length ? ` · ${trees.map((t) => `${esc(t.name)} ${esc(t.points)}`).join(' / ')}` : ''}${talents && talents.unspent ? ` · <strong>${esc(talents.unspent)} talent point${talents.unspent === 1 ? '' : 's'} to spend</strong>` : ''}</p>
      ${profile && profile.archetype ? `<p class="archetype">${esc(profile.archetype)}</p><p>${esc(profile.blurb || '')}</p>` : '<p class="muted">Play a little and answer the in-game quiz to get your play style.</p>'}
      ${profile && profile.minutes != null ? `<p class="hint">Based on ${esc(Math.round(profile.minutes))} minutes of play${profile.quiz ? ' and your quiz answers' : ''}. Updated ${ago(current.updated_at)}.</p>` : ''}
    </div>
    <ul class="style-bars">${bars}</ul>
  </section>

  <section class="setting">
    <h2>Build plan</h2>
    ${planHtml}
    ${hasKey && enabled ? `<form method="post" action="/coach/plan">${csrfField(csrf)}<input type="hidden" name="char" value="${esc(current.name)}">
      <button class="btn btn-small" data-busy="Writing your plan… this takes up to a minute">${plan && !plan.error ? 'Make a fresh plan' : 'Make my plan'}</button></form>` : ''}
  </section>

  <section class="setting">
    <h2>Ask the Coach</h2>
    ${hasKey && enabled ? `<form method="post" action="/coach/ask" class="ask-form">${csrfField(csrf)}<input type="hidden" name="char" value="${esc(current.name)}">
      <label class="sr" for="q">Your question</label>
      <textarea id="q" name="question" rows="2" maxlength="500" required placeholder="e.g. Should I take Improved Charge or Deflection for world PvP?"></textarea>
      <div class="actions-row"><button class="btn btn-primary" data-busy="Thinking…">Ask</button><span class="hint">${esc(left)} questions left today. You can also ask in game.</span></div>
    </form>` : ''}
    <ul class="qa-list">${answers.map((a) => `<li class="qa"><p class="q">${esc(a.question)} <span class="muted">${a.source === 'game' ? 'from the game · ' : ''}${ago(a.created_at)}</span></p>
      ${a.status === 'pending' ? '<p class="muted">Waiting for an answer…</p>' : a.status === 'failed' ? `<p class="warn">${esc(a.error)}</p>` : `<p class="a">${esc(a.answer).replace(/\n/g, '<br>')}</p>`}
      ${a.sources && a.sources.length ? `<p class="hint">${a.sources.map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a>`).join(' · ')}</p>` : ''}</li>`).join('') || '<li class="empty">No questions yet.</li>'}</ul>
  </section>`;
}

module.exports = { coachPage, DIMS };
