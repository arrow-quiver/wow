// Recruiting: who the guild has been in touch with, how each recruiter is doing, and (officers) the ad and the
// message the addon's recruiting desk uses. The finding happens in game: /wow recruit. Data: GET /api/recruiting
// (docs/api/community.md, "Recruiting").
import { html, useState, useEffect } from '../lib/html.js';
import { api, useApi, useAction } from '../lib/api.js';
import { Page, Card, Stat, Button, Input, Textarea, Checkbox, Pill, Empty, Async, Table, ClassName, TimeAgo } from '../components/index.js';
import { number } from '../lib/format.js';

const PILL = { c: 'muted', i: 'warn', n: 'muted', j: 'ok' };
const FILTERS = [['all', 'Everyone'], ['i', 'Interested'], ['c', 'Contacted'], ['j', 'Joined'], ['n', 'No thanks']];
const CLASS_NAMES = { WARRIOR: 'Warrior', PALADIN: 'Paladin', HUNTER: 'Hunter', ROGUE: 'Rogue', PRIEST: 'Priest', SHAMAN: 'Shaman', MAGE: 'Mage', WARLOCK: 'Warlock', DRUID: 'Druid' };

export default function RecruitingPage() {
  const q = useApi('/api/recruiting');
  return html`<${Page} title="Recruiting" width="wide"
      lede="Find players without a guild in game with /wow recruit: one click per /who search, you send each message yourself."
      actions=${html`<${Button} variant="ghost" size="sm" icon="refresh" busy=${q.refreshing} onClick=${q.reload}>Refresh<//>`}>
    <${Async} q=${q} loadingLabel="Counting recruits…">${(d) => html`<${Recruiting} d=${d} reload=${q.reload} />`}<//>
  <//>`;
}

function Recruiting({ d, reload }) {
  const [filter, setFilter] = useState('all');
  const rows = filter === 'all' ? d.recruits : d.recruits.filter((r) => r.state === filter);
  const cols = [
    { key: 'name', label: 'Player', render: (r) => html`<${ClassName} name=${r.name} cls=${r.class} /> <span class="hint">${r.level || ''}</span>` },
    { key: 'zone', label: 'Where', render: (r) => html`<span class="hint">${r.zone || ''}</span>` },
    { key: 'recruiter', label: 'Found by', render: (r) => r.recruiter || html`<span class="hint">?</span>` },
    { key: 'state', label: '', render: (r) => html`<span class="row nowrap"><${Pill} kind=${PILL[r.state]}>${r.stateLabel}<//>
      ${r.stayed ? html`<${Pill} kind="ok">stayed a week<//>` : r.left ? html`<${Pill} kind="muted">left<//>` : null}</span>` },
    { key: 'at', label: 'When', render: (r) => html`<${TimeAgo} t=${new Date(r.at * 1000).toISOString()} />` },
  ];
  return html`
    <div class="war-stats">
      <${Card}><${Stat} label="Contacted" value=${number(d.recruits.length)} hint="nobody gets messaged twice" /><//>
      <${Card}><${Stat} label="Interested" value=${number(d.stats.counts.i)} hint="officers: invite in game" /><//>
      <${Card}><${Stat} label="Joined" value=${number(d.stats.counts.j)} hint=${`${d.recruits.filter((r) => r.stayed).length} stayed a week`} /><//>
      <${Card}><${Stat} label="Points a recruit" value=${number(d.points)} hint=${`when they stay ${d.stayDays} days`} /><//>
    </div>
    <div class="cols war-cols">
      <div class="stack stack--loose">
        <${Card} flush title="Recruits">
          <div class="row board-filter" role="group" aria-label="Show">
            ${FILTERS.map(([k, label]) => html`<${Button} key=${k} size="sm" variant=${filter === k ? 'primary' : 'ghost'} aria-pressed=${filter === k} onClick=${() => setFilter(k)}>${label}<//>`)}
          </div>
          <${Table} dense columns=${cols} rows=${rows} rowKey=${(r) => r.name}
            empty=${html`<${Empty} compact icon="partners" title="Nobody yet.">In game: /wow recruit, then Scan.<//>`} />
        <//>
      </div>
      <div class="stack stack--loose">
        <${Card} title="Top recruiters">
          ${d.stats.recruiters.length ? html`<ol class="list-lines">${d.stats.recruiters.slice(0, 10).map((s) => html`<li key=${s.name} class="row row--between nowrap">
            <b>${s.name}</b><span class="hint">${s.contacted} contacted · ${s.joined} joined · ${s.stayed} stayed</span></li>`)}</ol>`
            : html`<p class="hint mb-0">Nobody has recruited yet.</p>`}
        <//>
        ${d.canEdit ? html`<${Settings} d=${d} reload=${reload} />` : html`<${Card} title="The ad and message"><p class="small">${d.settings.ad}</p><p class="hint mb-0">Officers set these.</p><//>`}
        <${Card} title="How it works">
          <ul class="list-tight hint">
            <li>In game, <code>/wow recruit</code> opens the desk. Each Scan click runs one /who search; players with no guild that nobody in the guild has contacted go in the queue.</li>
            <li>Message opens your chat box with the message filled in, and you press Enter. Up to 30 a day, so nobody reports it as spam.</li>
            <li>A "yes" reply marks them interested and online officers get an Invite button. A "no" marks them no thanks.</li>
            <li>Whoever found them earns ${d.points} season points once they've stayed ${d.stayDays} days.</li>
          </ul>
        <//>
      </div>
    </div>`;
}

function Settings({ d, reload }) {
  const [s, setS] = useState(d.settings);
  useEffect(() => setS(d.settings), [d.settings]);
  const wanted = new Set(String(s.classes || '').split(',').filter(Boolean));
  const toggle = (c) => { const w = new Set(wanted); if (w.has(c)) w.delete(c); else w.add(c); setS({ ...s, classes: [...w].join(',') }); };
  const save = useAction(() => api.put('/api/recruiting/settings', s), { success: (r) => r.message });
  return html`<${Card} title="The ad and message" sub="officers">
    <form class="stack" novalidate onSubmit=${async (e) => { e.preventDefault(); if ((await save.run()).ok) reload(); }}>
      <${Textarea} label="Channel ad (LookingForGroup, then General)" rows="3" maxLength="255" value=${s.ad} onValue=${(v) => setS({ ...s, ad: v })} />
      <${Textarea} label="Message to a player ({name} is their name)" rows="3" maxLength="200" value=${s.msg} onValue=${(v) => setS({ ...s, msg: v })} />
      <div class="form-grid hunt-form">
        <${Input} label="From level" type="number" min="1" max="60" value=${s.minLevel} onValue=${(v) => setS({ ...s, minLevel: Number(v) || 1 })} />
        <${Input} label="To level" type="number" min="1" max="60" value=${s.maxLevel} onValue=${(v) => setS({ ...s, maxLevel: Number(v) || 60 })} />
      </div>
      <fieldset class="stack stack--tight"><legend class="small">Classes we want (shown first)</legend>
        <div class="row recruit-classes">${d.classes.map((c) => html`<${Checkbox} key=${c} label=${CLASS_NAMES[c]} checked=${wanted.has(c)} onValue=${() => toggle(c)} />`)}</div>
      </fieldset>
      <p class="hint mb-0">No links: Blizzard counts links to strangers as advertising. Share your Discord once they join.</p>
      <div class="form-actions"><${Button} type="submit" variant="primary" busy=${save.busy}>Save for the guild<//></div>
    </form>
  <//>`;
}
