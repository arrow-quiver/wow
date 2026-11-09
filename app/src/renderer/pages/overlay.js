// The Coach overlay: a small always-on-top window over the game (main/overlay.js, opened with a hotkey). The live
// link's session and last death (main/live.js through gc.live), what to do next, and a quick Ask box. Answers show
// here at once; the game sees them after its next /reload.
import { html, useState, useEffect, cx } from '../lib/html.js';
import { api, useApi, useAction } from '../lib/api.js';
import { gc, useGcEvent } from '../lib/gc.js';
import { number, plural } from '../lib/format.js';
import { Button, Textarea, Checkbox, Pill, Spinner, Icon, Loading } from '../components/index.js';

const STATUS = {
  live: ['ok', 'Live'],
  waiting: ['warn', 'Waiting for a fight'],
  off: ['muted', 'Live link off'],
};
const hotkeyLabel = (k) => String(k || '').replace('CommandOrControl', 'Ctrl').replace('CmdOrCtrl', 'Ctrl').replace(/\+/g, '+');

function useLive() {
  const [state, setState] = useState(null);
  useEffect(() => {
    let alive = true;
    gc.live.state().then((s) => alive && setState(s), () => alive && setState({ status: 'off' }));
    return () => { alive = false; };
  }, []);
  useGcEvent('live', (s) => setState(s));
  return state;
}

export default function OverlayPage() {
  const live = useLive();
  const coach = useApi('/api/coach', { interval: 30000 });
  const [hotkey, setHotkey] = useState('');
  useEffect(() => { gc.settings.get().then((s) => setHotkey(s && s.overlayHotkey), () => {}); }, []);
  const ch = coach.data && coach.data.character;
  return html`<div class="ovl">
    <header class="ovl-bar">
      <span class="ovl-title"><${Icon} name="coach" /> Coach${ch ? html` <span class="ovl-who">· ${ch.name}</span>` : null}</span>
      <button class="ovl-x" type="button" title="Hide (Esc)" aria-label="Hide the overlay" onClick=${() => gc.overlay.hide()}>×</button>
    </header>
    <div class="ovl-body">
      <${LiveCard} live=${live} />
      ${live && live.lastDeath ? html`<${DeathCard} live=${live} ch=${ch} onAsked=${coach.reload} />` : null}
      ${coach.data ? html`<${NextCard} data=${coach.data} />` : coach.loading ? html`<${Loading} label="Reading your Coach…" />` : null}
      ${ch ? html`<${AskCard} data=${coach.data} live=${live} reload=${coach.reload} />` : null}
      <p class="ovl-foot">Answers reach the game after your next /reload.${hotkey ? ` ${hotkeyLabel(hotkey)} shows or hides this.` : ''} Esc hides it.</p>
    </div>
  </div>`;
}

function LiveCard({ live }) {
  if (!live) return html`<section class="ovl-card"><${Spinner} size="xs" label="" /> Checking the live link…</section>`;
  const [kind, label] = STATUS[live.status] || STATUS.off;
  const s = live.session;
  return html`<section class="ovl-card">
    <div class="ovl-row"><h2 class="ovl-h">This session</h2><${Pill} kind=${kind} dot>${label}<//></div>
    ${s ? html`<dl class="ovl-stats">
      <div><dt>Playing</dt><dd>${s.minutes} min</dd></div>
      <div><dt>Kills</dt><dd>${number(s.kills)}${s.pvpKills ? html` <span class="hint">${s.pvpKills} PvP</span>` : null}</dd></div>
      <div><dt>Deaths</dt><dd>${number(s.deaths)}</dd></div>
      <div><dt>Kills / hour</dt><dd>${s.killsPerHour == null ? '–' : s.killsPerHour}</dd></div>
    </dl>` : null}
    ${live.hint ? html`<p class="ovl-hint">${live.hint}</p>` : null}
  </section>`;
}

function DeathCard({ live, ch, onAsked }) {
  const d = live.lastDeath;
  const [answer, setAnswer] = useState(null);
  const ask = useAction(() => api.post('/api/coach/ask', {
    char: ch ? ch.name : undefined, fresh: true, live: (live.context && live.context.death) || '',
    question: d.killer ? `Why did I die to ${d.killer}${d.pvp ? ' (a player)' : ''}? What should I do differently?` : 'Why did I die? What should I do differently?',
  }));
  const why = async () => {
    const r = await ask.run();
    if (r.ok) { setAnswer(r.value.question); onAsked(); }
  };
  return html`<section class="ovl-card ovl-death">
    <div class="ovl-row"><h2 class="ovl-h">You died${d.killer ? ` to ${d.killer}` : ''}</h2>${d.pvp ? html`<${Pill} kind="warn">PvP<//>` : null}</div>
    <p class="hint">${d.killingBlow && d.killingBlow.spell ? `${d.killingBlow.spell} for ${number(d.killingBlow.amount)}. ` : ''}${number(d.damageTaken)} damage in ${d.seconds}s${d.healed ? `, healed ${number(d.healed)}` : ', no healing'}.</p>
    ${d.sources && d.sources.length ? html`<ul class="ovl-sources">${d.sources.slice(0, 4).map((x) => html`<li key=${`${x.who}${x.spell}`}>
      <span>${x.spell || 'Melee'} <span class="hint">${x.who}</span></span><b>${number(x.amount)}</b></li>`)}</ul>` : null}
    ${answer && answer.status === 'answered' ? html`<p class="ovl-answer">${answer.answer}</p>`
      : answer && answer.status === 'pending' ? html`<p class="hint"><${Spinner} size="xs" label="" /> Still thinking… it shows on the Coach page when ready.</p>`
        : html`<${Button} size="sm" variant="primary" icon="spark" busy=${ask.busy} onClick=${why}>${ask.busy ? 'Thinking…' : 'Why did I die?'}<//>`}
  </section>`;
}

function nextTalent(plan, talents) {
  if (!plan || !Array.isArray(plan.talents)) return null;
  const have = {};
  for (const t of (talents && talents.picked) || []) have[String(t.name).toLowerCase()] = t.rank || 0;
  return plan.talents.find((t) => (have[String(t.name).toLowerCase()] || 0) < (t.points || 1)) || null;
}

function NextCard({ data }) {
  const ch = data.character;
  if (!ch) return html`<section class="ovl-card"><p class="hint mb-0">Log in to a character with the addon and /reload once, and the Coach gets to know you.</p></section>`;
  const t = nextTalent(data.plan, ch.talents);
  const steps = (data.nextSteps || []).slice(0, 3);
  return html`<section class="ovl-card">
    <h2 class="ovl-h">Next up</h2>
    ${t ? html`<p class="ovl-talent"><span class="hint">Talent</span> <b>${t.name}</b> <span class="hint">${t.tree}${t.why ? ` · ${t.why}` : ''}</span></p>` : null}
    ${steps.length ? html`<ol class="ovl-steps">${steps.map((s) => html`<li key=${s.title}><b>${s.title}</b>${s.detail ? html`<br /><span class="hint">${s.detail}</span>` : null}</li>`)}</ol>`
      : html`<p class="hint mb-0">Nothing urgent. Go have fun.</p>`}
  </section>`;
}

function AskCard({ data, live, reload }) {
  const ch = data.character;
  const [text, setText] = useState('');
  const [useSession, setUseSession] = useState(true);
  const [last, setLast] = useState(null);
  const ask = useAction((question) => api.post('/api/coach/ask', {
    char: ch.name, question, live: useSession && live && live.context ? live.context.session || '' : '',
  }));
  const submit = async (e) => {
    e?.preventDefault();
    const q = text.trim();
    if (!q) return;
    const r = await ask.run(q);
    if (!r.ok) return;
    setText(''); setLast(r.value.question); reload();
  };
  if (!data.ai || !data.ai.available) {
    return html`<section class="ovl-card"><p class="hint mb-0">${(data.ai && data.ai.reason) || 'Questions need your Claude API key: add it in Settings → Coach.'}</p></section>`;
  }
  const shown = last || (data.questions || []).find((q) => q.status === 'answered');
  return html`<section class="ovl-card">
    <h2 class="ovl-h">Ask</h2>
    <form onSubmit=${submit} class="stack">
      <${Textarea} class="ovl-ask" rows="2" maxLength="500" value=${text} onValue=${setText} aria-label="Your question"
        placeholder="Quick question about ${ch.name}…" onKeyDown=${(e) => { if (e.key === 'Enter' && !e.shiftKey) submit(e); }} />
      <div class="ovl-row">
        ${live && live.session ? html`<${Checkbox} label="Include this session" checked=${useSession} onValue=${setUseSession} />` : html`<span></span>`}
        <${Button} type="submit" size="sm" variant="primary" icon="spark" busy=${ask.busy} disabled=${!text.trim()}>${ask.busy ? 'Thinking…' : 'Ask'}<//>
      </div>
    </form>
    ${shown ? html`<div class=${cx('ovl-qa', shown.status !== 'answered' && 'is-wait')}>
      <p class="ovl-q">${shown.question}</p>
      ${shown.status === 'answered' ? html`<p class="ovl-answer">${shown.answer}</p>`
        : shown.status === 'failed' ? html`<p class="hint">${shown.error}</p>`
          : html`<p class="hint"><${Spinner} size="xs" label="" /> Thinking… it shows here when it's ready.</p>`}
    </div>` : null}
    ${data.limits ? html`<p class="hint mb-0">${plural(data.limits.questionsLeft, 'question')} left today.</p>` : null}
  </section>`;
}
