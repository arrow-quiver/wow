// Coach: play style, the AI build plan, next steps and questions to the Coach, for one of my characters.
// Data: GET /api/coach?char=<name>, POST /api/coach/ask, POST /api/coach/plan (docs/api/coach.md).
// AI answers use the player's own Anthropic API key (Settings) and budget (Guild settings). Slow answers and plans
// finish in the background; the page reloads on 'coach' events and checks every few seconds while one is on its way.
import { html, useState, useEffect, cx } from '../lib/html.js';
import { api, useApi, useAction, qs } from '../lib/api.js';
import { Link, setQuery } from '../lib/router.js';
import { classInfo, className, plural } from '../lib/format.js';
import { useSyncStatus, syncStatus, needsGameRestart } from '../lib/status.js';
import {
  Page, Card, Button, Textarea, Checkbox, Notice, Pill, Progress, Empty, Loading, Spinner, Async, Icon,
  ClassName, TimeAgo, LocalTime, toast,
} from '../components/index.js';

// The five play-style scores (0-100), in the order the addon shows them.
export const DIMS = [
  { key: 'aggression', label: 'Aggression', hint: 'How readily you start fights' },
  { key: 'risk', label: 'Risk taking', hint: 'How often fights go wrong' },
  { key: 'social', label: 'Social', hint: 'Time spent grouped' },
  { key: 'pvp', label: 'PvP focus', hint: 'Flagged, battlegrounds, kills, duels' },
  { key: 'pace', label: 'Pace', hint: 'Fighting and questing per hour' },
];

// The addon's archetypes (Coach.lua), for profiles uploaded without a description.
const ARCHETYPES = {
  Warmonger: 'You go looking for fights and enjoy taking other players down.',
  Duelist: 'You love PvP, but you pick your fights and win them on skill.',
  Berserker: 'Big pulls, fast kills, and the occasional run back from the spirit healer.',
  Guardian: 'Steady and safe: the player a group can rely on.',
  Companion: 'Better with friends: you spend most of your time in a group.',
  Trailblazer: 'Efficient and quick, always pushing on to the next level.',
  'Lone Wanderer': 'Calm, independent and thorough. You play at your own pace.',
  Adventurer: 'A well-rounded player who enjoys a bit of everything.',
};

const POLL_MS = 5000;
const ASK_BOX_ID = 'coach-question';
const usd = (n) => `$${(Number(n) || 0).toFixed(2)}`;
const score = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Math.max(0, Math.min(100, Math.round(Number(v)))));
const list = (v) => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : []);

// "Arms 15 / Fury 0 / Protection 0"
export function treeLine(talents) {
  return list(talents && talents.trees).filter((t) => t && t.name).map((t) => `${t.name} ${t.points ?? 0}`).join(' / ');
}

// Stable key for a next step, so a tick survives reloads while the step stays the same.
const stepKey = (s) => `${s.kind}:${s.title}`;

// Ticked next steps live in this browser only (a personal checklist), per character.
function useTicks(charName, steps) {
  const storeKey = `gc.coach.ticks.${charName || ''}`;
  const read = () => {
    try { return new Set(JSON.parse(localStorage.getItem(storeKey) || '[]')); } catch { return new Set(); }
  };
  const [ticks, setTicks] = useState(read);
  useEffect(() => { setTicks(read()); }, [storeKey]);
  const toggle = (key, on) => {
    const next = new Set(ticks);
    if (on) next.add(key); else next.delete(key);
    // Forget ticks for steps that are gone (done in game, or a new plan).
    const live = new Set(steps.map(stepKey));
    const kept = [...next].filter((k) => live.has(k));
    setTicks(new Set(kept));
    try { localStorage.setItem(storeKey, JSON.stringify(kept)); } catch { /* storage unavailable: ticks last until reload */ }
  };
  return [ticks, toggle];
}

// ---------- page ----------

export default function CoachPage({ query = {} }) {
  const [poll, setPoll] = useState(0);
  const coach = useApi(`/api/coach${qs({ char: query.char })}`, { refreshOn: ['coach'], interval: poll });
  const d = coach.data;
  // While a plan or an answer is on its way, check every few seconds (events arrive every 20 s at most).
  const waiting = Boolean(d && (d.planBusy || (d.questions || []).some((x) => x.status === 'pending')));
  useEffect(() => { setPoll(waiting ? POLL_MS : 0); }, [waiting]);

  // The question box sits at the end of a long page; the top bar jumps straight to it.
  const canAsk = Boolean(d && d.character && d.ai && d.ai.available);
  const goAsk = () => {
    const box = document.getElementById(ASK_BOX_ID);
    if (!box) return;
    box.scrollIntoView({ behavior: 'smooth', block: 'center' });
    box.focus({ preventScroll: true });
  };

  return html`<${Page} title="Coach" width="normal"
      actions=${canAsk ? html`<${Button} icon="spark" onClick=${goAsk}>Ask a question<//>` : null}
      lede="Your personal guide. It learns how you play, then suggests talents, stats, gear and what to do next.">
    <${Async} q=${coach} loadingLabel="Loading your Coach…">
      ${(data) => html`<${CoachBody} data=${data} reload=${coach.reload} />`}
    <//>
  <//>`;
}

function CoachBody({ data, reload }) {
  const ch = data.character;
  return html`<div class="stack stack--loose coach">
    <${AiNotice} ai=${data.ai} hasCharacter=${!!ch} />
    ${!ch ? html`<${GettingStarted} />` : html`
      ${data.characters.length > 1 ? html`<${CharacterPicker} characters=${data.characters} current=${ch.name} />` : null}
      <${StyleCard} ch=${ch} />
      <${WeekCard} ch=${ch} ai=${data.ai} reload=${reload} />
      <div class="cols coach-cols">
        <${PlanCard} data=${data} reload=${reload} />
        <div class="stack">
          <${StepsCard} ch=${ch} steps=${data.nextSteps || []} />
          ${data.usage ? html`<${UsageCard} usage=${data.usage} />` : null}
        </div>
      </div>
      <${AskCard} data=${data} reload=${reload} />`}
  </div>`;
}

// ---------- AI availability ----------

/** What the "AI is off" notice says: { title, text, link: { href, label } | null } (exported for tests). */
export function aiNoticeText(ai, hasCharacter) {
  if (!ai || ai.available) return null;
  const still = hasCharacter
    ? 'Your play style and next steps still work.'
    : 'Play-style tracking and next steps still work once you sync.';
  if (!ai.hasKey) {
    return { title: 'Add your API key to turn on AI answers.', text: `The Coach answers with your own Anthropic API key, so you only pay for what you ask. ${still}`,
      link: { href: '/settings?section=coach', label: 'Add your key in Settings' } };
  }
  if (!ai.enabled) {
    return { title: 'The Coach AI is switched off.', text: `Turn it back on in Guild settings. ${still}`,
      link: { href: '/guild-settings?section=coach', label: 'Open Guild settings' } };
  }
  if (!ai.budgetLeft) {
    return { title: "This month's Coach budget is used up.", text: `Plans and answers are back next month, or raise your budget in Guild settings. ${still}`,
      link: { href: '/guild-settings?section=coach', label: 'Change the budget' } };
  }
  return { title: 'The Coach AI is off.', text: `${ai.reason || 'Build plans and answers are off for now.'} ${still}`, link: null };
}

function AiNotice({ ai, hasCharacter }) {
  const n = aiNoticeText(ai, hasCharacter);
  if (!n) return null;
  return html`<${Notice} kind=${ai.hasKey ? 'warn' : 'info'} title=${n.title}>${n.text}${n.link ? html` <${Link} href=${n.link.href}>${n.link.label}<//>` : null}<//>`;
}

// ---------- no data yet ----------

function GettingStarted() {
  return html`<${Card} class="coach-start">
    <div class="coach-start-head">
      <span class="coach-start-icon" aria-hidden="true"><${Icon} name="coach" /></span>
      <div>
        <h2 class="coach-start-title">No Coach data yet</h2>
        <p class="muted">The Coach learns from how you play in game. Setting it up takes a few minutes.</p>
      </div>
    </div>
    <ol class="coach-start-steps">
      <li><strong>Install the addon.</strong> Guild Camp installs and updates it for you on the Addon & sync page.</li>
      <li><strong>Open the Coach in game.</strong> Type <code>/wow coach</code>, then press <em>Tune my style</em> and answer five quick questions about how you like to play.</li>
      <li><strong>Play as normal.</strong> The addon watches how you fight, group and PvP, only outside combat. The more you play, the sharper it gets.</li>
      <li><strong>Log out or type <code>/reload</code></strong> while Guild Camp is running. Your play style, build plan and next steps show up here and in game.</li>
    </ol>
    <div class="actions-row">
      <${Button} href="/addon" icon="addon">Open Addon & sync<//>
    </div>
  <//>`;
}

// ---------- character picker ----------

function CharacterPicker({ characters, current }) {
  return html`<div class="coach-chars" role="group" aria-label="Your characters">
    ${characters.map((c) => {
      const on = c.name === current;
      const [, colour] = classInfo(c.class);
      return html`<button type="button" key=${c.name} class=${cx('coach-char', on && 'is-on')} aria-pressed=${on ? 'true' : 'false'}
          onClick=${() => { if (!on) setQuery({ char: c.name }); }}>
        <span class="cname" style=${`--cc:${colour}`}>${c.name}</span>
        <span class="coach-char-sub">${c.level ? `Level ${c.level}` : className(c.class)}${c.archetype ? ` · ${c.archetype}` : ''}</span>
      </button>`;
    })}
  </div>`;
}

// ---------- play style ----------

function StyleCard({ ch }) {
  const p = ch.profile || null;
  const scores = (p && p.scores) || {};
  const trees = treeLine(ch.talents);
  const unspent = Number(ch.talents && ch.talents.unspent) || 0;
  const blurb = p && (p.blurb || ARCHETYPES[p.archetype]);
  return html`<${Card} class="coach-style">
    <div class="coach-style-grid">
      <div class="coach-who">
        <div class="coach-name"><${ClassName} name=${ch.name} cls=${ch.class} /></div>
        <p class="coach-sub">
          ${ch.level ? `Level ${ch.level} ` : ''}${className(ch.class)}${ch.realm ? html` <span class="faint">· ${ch.realm}</span>` : null}
          ${trees ? html`<br /><span class="muted">${trees}</span>` : null}
        </p>
        ${unspent ? html`<p><${Pill} kind="accent" dot>${plural(unspent, 'talent point')} to spend<//></p>` : null}
        ${p && p.archetype ? html`
          <p class="coach-archetype-label">Play style</p>
          <p class="coach-archetype">The ${p.archetype}</p>
          ${blurb ? html`<p class="coach-blurb">${blurb}</p>` : null}`
        : html`<p class="muted">Play a little and answer the quiz in game (<code>/wow coach</code>) to get your play style.</p>`}
        <p class="hint">
          ${p && p.minutes != null ? `Based on ${plural(Math.round(p.minutes), 'minute')} of play${p.quiz ? ' and your quiz answers' : ''}. ` : ''}Updated <${TimeAgo} t=${ch.updated_at} />.
        </p>
      </div>
      <ul class="coach-bars" aria-label="Play style scores">
        ${DIMS.map((dim) => {
          const v = score(scores[dim.key]);
          return html`<li key=${dim.key}>
            <${Progress} label=${dim.label} value=${v ?? 0} valueText=${v === null ? '–' : String(v)} showValue />
            <span class="hint">${dim.hint}</span>
          </li>`;
        })}
      </ul>
    </div>
    <${Observed} stats=${ch.stats} />
  <//>`;
}

// What the addon saw, in plain words. Only the numbers it actually sent.
function Observed({ stats }) {
  if (!stats || typeof stats !== 'object') return null;
  const n = (v, digits = 1) => (Number.isFinite(Number(v)) ? Number(Number(v).toFixed(digits)).toLocaleString('en') : null);
  const pct = (v) => (Number.isFinite(Number(v)) ? `${Math.round(Number(v) * 100)}%` : null);
  const items = [
    ['Fights an hour', n(stats.pullsPerHour)],
    ['Deaths an hour', n(stats.deathsPerHour)],
    ['Quests an hour', n(stats.questsPerHour)],
    ['Honour kills', n(stats.honorKills, 0)],
    ['Duels won / lost', stats.duelsWon != null || stats.duelsLost != null ? `${n(stats.duelsWon, 0) ?? 0} / ${n(stats.duelsLost, 0) ?? 0}` : null],
    ['Time grouped', pct(stats.groupedShare)],
    ['Time flagged for PvP', pct(stats.flaggedShare)],
  ].filter(([, v]) => v !== null);
  if (!items.length) return null;
  return html`<dl class="coach-observed" aria-label="What the addon saw">
    ${items.map(([label, value]) => html`<div key=${label}><dt>${label}</dt><dd>${value}</dd></div>`)}
  </dl>`;
}

// ---------- build plan (PlanCard is exported for tests) ----------

// When a new plan reaches the game. While a game folder's news folder (WowGuild_Inbox) was made during the game session
// that still runs (sync status restartNeeded), that session never loads it, also not after a /reload.
export const PLAN_LINE = 'A new plan reaches the game after your next sync and /reload.';
export const PLAN_LINE_RESTART = "A new plan reaches the game after you restart World of Warcraft. A /reload isn't enough the first time.";
// The core's reply when a plan is ready (core/routes/coach.js), and what it says while the game needs a restart.
export const PLAN_READY = 'Your new build plan is ready. It reaches the game after your next sync and /reload.';
export const PLAN_READY_RESTART = "Your new build plan is ready. It reaches the game after you restart World of Warcraft. A /reload isn't enough the first time.";

/** The plan card's "reaches the game" line, with the restart wording while the game needs one. */
export function planLine(sync) {
  return needsGameRestart(sync) ? PLAN_LINE_RESTART : PLAN_LINE;
}

/** The core's reply after making a plan: its "ready" line gets the restart wording while the game needs one. */
export function planReply(message, sync) {
  return message === PLAN_READY && needsGameRestart(sync) ? PLAN_READY_RESTART : message;
}

export function PlanCard({ data, reload }) {
  const { character: ch, plan, planBusy, ai, limits } = data;
  const sync = useSyncStatus();
  const make = useAction(() => api.post('/api/coach/plan', { char: ch.name }));
  const good = plan && !plan.error ? plan : null;
  const canMake = ai.available && limits.plansLeft > 0;

  const onMake = async () => {
    const r = await make.run();
    if (!r.ok) return;
    toast(planReply(r.value.message, syncStatus.get()), r.value.status === 'ready' ? 'ok' : 'info');
    reload();
  };

  const button = ai.available ? html`<${Button} variant=${good ? 'secondary' : 'primary'} icon="spark" size="sm"
      busy=${make.busy || planBusy} disabled=${!canMake} onClick=${onMake}>${good ? 'Make a new plan' : 'Make my plan'}<//>` : null;
  const footer = !ai.available
    ? 'Build plans need the Coach AI.'
    : limits.plansLeft > 0
      ? `${limits.plansLeft} of ${limits.plansPerDay} plans left today. ${planLine(sync)}`
      : "You've made today's plans. More tomorrow (the limit resets at midnight UTC).";
  const sub = good && good.level
    ? html`made at level ${good.level}${good.at ? html`, <${TimeAgo} t=${good.at} />` : null}`
    : null;

  let body;
  if (!plan && planBusy) {
    body = html`<${Loading} label="The Coach is writing your plan. This can take a minute." />`;
  } else if (!plan) {
    body = html`<${Empty} icon="build" title="No plan yet.">
      ${ai.available
        ? 'Press Make my plan and the Coach writes one from your play style, talents and gear: talents in order, stats, gear and tips.'
        : 'When the Coach AI is on, it writes a plan from your play style, talents and gear.'}
    <//>`;
  } else {
    body = html`
      ${planBusy ? html`<${Notice} kind="info" icon="spark">A fresh plan is being written. This one stays until it's ready.<//>` : null}
      ${plan.error ? html`<${Notice} kind="warn" title="The last plan couldn't be made.">${plan.error}<//>` : html`<${PlanBody} plan=${plan} />`}`;
  }

  return html`<${Card} class="coach-plan" title="Build plan" sub=${sub} actions=${button} footer=${html`<span class="hint">${footer}</span>`}>
    <div class="stack">${body}</div>
  <//>`;
}

function PlanBody({ plan }) {
  const talents = list(plan.talents);
  const stats = list(plan.stats);
  const gear = list(plan.gear);
  const tips = list(plan.tips);
  const sources = list(plan.sources);
  return html`<div class="stack">
    <div>
      ${plan.headline ? html`<p class="coach-headline">${plan.headline}</p>` : null}
      ${plan.summary ? html`<p class="coach-summary">${plan.summary}</p>` : null}
      <div class="row">
        ${plan.spec ? html`<${Pill} kind="accent">${plan.spec}<//>` : null}
        ${plan.split ? html`<${Pill} kind="muted">${plan.split}<//>` : null}
        <span class="hint">${plan.confidence === 'forever' ? 'Checked against WoW: Forever sources.' : 'Based on Classic Era. WoW: Forever may differ.'}</span>
      </div>
    </div>
    <div class="grid-2 coach-plan-grid">
      <section>
        <h3 class="coach-h">Talents, in order</h3>
        ${talents.length ? html`<ol class="coach-talents">
          ${talents.map((t, i) => html`<li key=${i} class=${cx(t.taken && 'is-taken')}>
            <span class="coach-talent-mark" aria-hidden="true">${t.taken ? html`<${Icon} name="check" />` : i + 1}</span>
            <span class="coach-talent-main">
              <span><strong>${t.name}</strong>${t.taken ? html`<span class="sr"> (taken)</span>` : null}
                <span class="muted small"> ${[t.tree, plural(t.points || 1, 'point')].filter(Boolean).join(' · ')}</span></span>
              ${t.why ? html`<span class="hint">${t.why}</span>` : null}
            </span>
          </li>`)}
        </ol>
        <p class="hint">Ticked talents are ones you already have.</p>` : html`<p class="muted">No talent order in this plan.</p>`}
      </section>
      <section class="stack">
        ${stats.length ? html`<div>
          <h3 class="coach-h">Stats that matter most</h3>
          <ol class="coach-statlist">${stats.map((s, i) => html`<li key=${i}><span class="coach-stat-n">${i + 1}</span>${s}</li>`)}</ol>
        </div>` : null}
        ${gear.length ? html`<div>
          <h3 class="coach-h">Gear</h3>
          <ul class="list-lines">${gear.map((g, i) => html`<li key=${i}><strong>${g.slot || 'Any slot'}</strong>: ${g.advice}</li>`)}</ul>
        </div>` : null}
        ${tips.length ? html`<div>
          <h3 class="coach-h">For how you play</h3>
          <ul class="coach-tips">${tips.map((t, i) => html`<li key=${i}>${t}</li>`)}</ul>
        </div>` : null}
      </section>
    </div>
    ${sources.length ? html`<${Sources} sources=${sources} />` : null}
  </div>`;
}

function Sources({ sources }) {
  return html`<p class="hint coach-sources">Sources:
    ${sources.map((s, i) => html`${i ? ' · ' : ' '}<a key=${s.url} href=${s.url} target="_blank" rel="noopener noreferrer">${s.title || s.url}<${Icon} name="external" class="coach-ext" /></a>`)}
  </p>`;
}

// ---------- next steps ----------

function StepsCard({ ch, steps }) {
  const [ticks, toggle] = useTicks(ch.name, steps);
  const left = steps.filter((s) => !ticks.has(stepKey(s))).length;
  return html`<${Card} class="coach-steps-card" title="Next steps" sub=${steps.length ? `${left} to do` : null}
      footer=${html`<span class="hint">The game shows these too, plus class trainer reminders. Ticks stay on this computer.</span>`}>
    ${steps.length ? html`<ul class="coach-steps">
      ${steps.map((s) => {
        const key = stepKey(s);
        const done = ticks.has(key);
        const hint = html`${s.detail}${s.at ? html` <${LocalTime} t=${s.at} />.` : null}`;
        return html`<li key=${key} class=${cx('coach-step', done && 'is-done', `coach-step--${s.kind}`)}>
          <${Checkbox} label=${s.title} hint=${hint} checked=${done} onValue=${(on) => toggle(key, on)} />
          ${s.route ? html`<${Button} href=${s.route} size="sm" variant="ghost" iconRight="forward">Open<//>` : null}
        </li>`;
      })}
    </ul>` : html`<${Empty} compact icon="ok" title="Nothing to do right now. Nice work." />`}
  <//>`;
}

// ---------- spending (your own key and budget) ----------

function UsageCard({ usage }) {
  const budget = Number(usage.budgetUsd) || 0;
  const spent = Number(usage.spentUsd) || 0;
  const over = budget > 0 && spent >= budget;
  return html`<${Card} class="coach-usage" title="Coach spending" sub="this month"
      footer=${html`<${Link} href="/guild-settings">Change the budget in Guild settings<//>`}>
    <div class="stack stack--tight">
      <p class="coach-usage-big"><strong>${usd(spent)}</strong> <span class="muted">of ${usd(budget)}</span></p>
      <${Progress} label="Monthly Coach budget used" value=${budget > 0 ? Math.min(spent, budget) : 0} max=${budget > 0 ? budget : 1} kind=${over ? 'alarm' : undefined} />
      <p class="hint">${plural(usage.questions || 0, 'question')} and ${plural(usage.plans || 0, 'plan')} so far, on your own API key.</p>
    </div>
  <//>`;
}

// ---------- questions ----------

function AskCard({ data, reload }) {
  const { character: ch, questions = [], ai, limits } = data;
  const [text, setText] = useState('');
  const [fresh, setFresh] = useState(false);
  const ask = useAction((question) => api.post('/api/coach/ask', { char: ch.name, question, fresh }));
  // Follow-ups: the Coach sees this character's last answers from the past 3 hours (services/coach.js).
  const recent = questions.find((x) => x.status === 'answered' && x.char_name === ch.name && ageMs(x.created_at) < 3 * 3600 * 1000);
  const outOfQuestions = limits.questionsLeft <= 0;

  const submit = async (e) => {
    e?.preventDefault();
    const question = text.trim();
    if (!question) { toast('Type a question first.', 'warn'); return; }
    const r = await ask.run(question);
    if (!r.ok) return;
    setText('');
    setFresh(false);
    const status = r.value.question && r.value.question.status;
    toast(r.value.message, status === 'answered' ? 'ok' : status === 'failed' ? 'alarm' : 'info');
    reload();
  };

  return html`<${Card} class="coach-ask" title="Ask the Coach" sub=${`about ${ch.name}`}>
    <div class="stack">
      ${ai.available ? html`<form class="coach-ask-form" onSubmit=${submit}>
        <${Textarea} id=${ASK_BOX_ID} label="Your question" class="coach-ask-box" rows="3" maxLength="500" value=${text} onValue=${setText}
          disabled=${outOfQuestions || ask.busy}
          placeholder="For example: Should I take Improved Charge or Deflection for world PvP?"
          onKeyDown=${(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit(e); }} />
        ${recent ? html`<${Checkbox} class="coach-fresh" label="Start a new topic"
          hint=${fresh ? 'The Coach won’t look at your earlier questions.' : `Otherwise this follows on from “${clipText(recent.question, 60)}”.`}
          checked=${fresh} onValue=${setFresh} />` : null}
        <div class="actions-row">
          <${Button} type="submit" variant="primary" icon="spark" busy=${ask.busy} disabled=${outOfQuestions || !text.trim()}>
            ${ask.busy ? 'Thinking…' : 'Ask'}
          <//>
          <span class="hint">${outOfQuestions
            ? "You've used today's questions. They reset at midnight (UTC)."
            : `${plural(limits.questionsLeft, 'question')} left today. You can also ask in game with /wow coach.`}</span>
        </div>
      </form>` : html`<p class="muted">Questions need the Coach AI. Answers you already have stay below.</p>`}
      ${questions.length ? html`<ul class="coach-qa-list">
        ${questions.map((q) => html`<${QuestionItem} key=${q.id} q=${q} />`)}
      </ul>` : html`<${Empty} compact icon="coach" title="No questions yet. Ask about talents, gear, where to level, or how to beat a class in PvP." />`}
    </div>
  <//>`;
}

const ageMs = (t) => {
  const d = t ? new Date(String(t).includes('T') ? t : `${String(t).replace(' ', 'T')}Z`) : null;
  return d && !Number.isNaN(d.getTime()) ? Date.now() - d.getTime() : Infinity;
};
const clipText = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));

function QuestionItem({ q }) {
  const sources = list(q.sources);
  return html`<li class=${cx('coach-qa', `coach-qa--${q.status}`)}>
    <div class="coach-q">
      <p class="coach-q-text">${q.question}</p>
      <p class="coach-q-meta">
        ${q.char_name ? html`<span>${q.char_name}</span>` : null}
        ${q.source === 'game' ? html`<${Pill} kind="info">from the game<//>` : null}
        <${TimeAgo} t=${q.created_at} />
      </p>
    </div>
    ${q.status === 'pending' ? html`<p class="coach-a-wait"><${Spinner} size="xs" label="" />
        ${q.source === 'game' ? 'Waiting for the Coach. Answers usually arrive within a minute.' : "Thinking… The answer shows here when it's ready."}</p>`
      : q.status === 'failed' ? html`<p class="coach-a-failed"><${Icon} name="alert" /> ${q.error || "The Coach couldn't answer this one."}</p>`
        : html`<p class="coach-a">${q.answer}</p>`}
    ${sources.length ? html`<${Sources} sources=${sources} />` : null}
  </li>`;
}

// For tests.
export const _test = { score, stepKey, ARCHETYPES };

// ---------- the weekly report: how I actually played (the live link), against last week ----------
function trend(cur, prev, lowerIsBetter) {
  if (cur == null || prev == null || cur === prev) return null;
  const better = lowerIsBetter ? cur < prev : cur > prev;
  return html`<span class=${better ? 'week-up' : 'week-down'}>${cur > prev ? '▲' : '▼'} ${Math.abs(Math.round((cur - prev) * 10) / 10)}</span>`;
}

function WeekCard({ ch, ai, reload }) {
  const q = useApi(`/api/coach/report?char=${encodeURIComponent(ch.name)}`);
  const ask = useAction((text) => api.post('/api/coach/ask', {
    char: ch.name, fresh: true, live: text, question: 'Here is my week. What should I work on first, and how?',
  }), { success: 'Asked. The answer shows under Ask.' });
  const r = q.data;
  if (!r) return null;
  const w = r.week; const p = r.lastWeek;
  if (!w.sessions) {
    return html`<${Card} title="Your week" sub="measured from the combat log">
      <p class="hint mb-0">${r.tips[0] || 'Turn on the live link (Settings → Overlay & live) and type /wow live on in game: the Coach then measures how you actually play.'}</p>
    <//>`;
  }
  return html`<${Card} title="Your week" sub=${`${w.hours} hours over ${w.sessions} session${w.sessions === 1 ? '' : 's'}, measured from the combat log`}
      actions=${ai && ai.available && r.text ? html`<${Button} size="sm" variant="primary" icon="spark" busy=${ask.busy}
        onClick=${async () => { if ((await ask.run(r.text)).ok) reload(); }}>Ask the Coach about my week<//>` : null}>
    <div class="week-grid">
      <div><span class="hint">Kills / hour</span><b>${w.killsPerHour ?? '–'}</b>${trend(w.killsPerHour, p.killsPerHour, false)}</div>
      <div><span class="hint">Deaths / hour</span><b>${w.deathsPerHour ?? '–'}</b>${trend(w.deathsPerHour, p.deathsPerHour, true)}</div>
      <div><span class="hint">PvP won : lost</span><b>${w.pvpKills} : ${w.pvpDeaths}</b></div>
      <div><span class="hint">In combat</span><b>${Math.round(w.fightShare * 100)}%</b></div>
    </div>
    ${r.style ? html`<p class="week-labels">${r.style.labels.map((l) => html`<${Pill} key=${l} kind="muted">${l}<//> `)}</p>` : null}
    <ul class="list-tight">${r.tips.map((t) => html`<li key=${t}>${t}</li>`)}</ul>
  <//>`;
}
