// The weekly guild digest: the guild's week (Monday to Sunday, UTC) in one page. The Guild Master's app posts it to
// Discord on Sunday evening; any officer can post it by hand. Data: GET /api/digest (docs/api/community.md).
import { html, useState } from '../lib/html.js';
import { api, useApi, useAction } from '../lib/api.js';
import { Page, Card, Stat, Button, Empty, Async, Pill, Money, LocalTime } from '../components/index.js';
import { number } from '../lib/format.js';

export default function DigestPage() {
  const [week, setWeek] = useState('');
  const q = useApi(`/api/digest${week ? `?week=${week}` : ''}`);
  return html`<${Page} title="Weekly digest"
      lede="The guild's week at a glance. It goes to Discord on Sunday evening.">
    <${Async} q=${q} loadingLabel="Putting the week together…">${(d) => html`<${Digest} d=${d} setWeek=${setWeek} reload=${q.reload} />`}<//>
  <//>`;
}

function Digest({ d, setWeek, reload }) {
  const post = useAction(() => api.post('/api/digest/post', { week: d.week, force: d.posted }), { success: (r) => r.message });
  return html`
    <div class="row row--between">
      <${Button} size="sm" variant="ghost" icon="back" onClick=${() => setWeek(d.previous)}>Week before<//>
      <b>Week of ${d.week}${d.current ? html` <${Pill} kind="info">this week<//>` : null}</b>
      <${Button} size="sm" variant="ghost" icon="forward" disabled=${!d.next} onClick=${() => d.next && setWeek(d.next)}>Week after<//>
    </div>
    <div class="war-stats">
      <${Card}><${Stat} label="Raids" value=${number(d.raids.length)} hint=${d.raids.map((r) => r.title).join(', ') || 'none this week'} /><//>
      <${Card}><${Stat} label="Alliance slain" value=${number(d.war.kills)} hint=${`${number(d.war.deaths)} deaths · ${number(d.ctas)} calls to arms`} /><//>
      <${Card}><${Stat} label="Donations" value=${html`<${Money} copper=${d.donations.value} empty="0g" />`} hint=${d.donations.top ? `most generous: ${d.donations.top.name}` : `${number(d.donations.count)} this week`} /><//>
      <${Card}><${Stat} label="Crafts made" value=${number(d.crafts)} hint=${`${number(d.board)} new board posts`} /><//>
    </div>
    <div class="cols war-cols">
      <div class="stack stack--loose">
        <${Card} title="Top of the week" sub="season points earned this week">
          ${d.top.length ? html`<ol class="list-lines">${d.top.map((p, i) => html`<li key=${p.name} class="row row--between"><span>${['🥇', '🥈', '🥉'][i]} <b>${p.name}</b></span><span>${number(p.points)} points</span></li>`)}</ol>`
            : html`<${Empty} compact icon="trophy" title="No points yet this week." />`}
        <//>
        <${Card} title="Raids">
          ${d.raids.length ? html`<ol class="list-lines">${d.raids.map((r) => html`<li key=${r.startsAt} class="row row--between"><span><b>${r.title}</b> <span class="hint"><${LocalTime} t=${r.startsAt} /></span></span>
            <span>${r.done ? `${number(r.attended)} came` : html`<${Pill} kind="muted">coming up<//>`}</span></li>`)}</ol>`
            : html`<p class="hint mb-0">No raids this week.</p>`}
        <//>
        <${Card} title="The guild">
          <p class="mb-0">${number(d.members.total)} members, ${number(d.members.atMax)} characters at level 60.
            ${d.members.joined.length ? html` Welcome <b>${d.members.joined.join(', ')}</b>!` : ' Nobody new this week.'}</p>
        <//>
      </div>
      <div class="stack stack--loose">
        <${Card} title="On Discord" sub=${d.posted ? 'posted this week' : 'not posted yet'}>
          <pre class="digest-text">${d.text}</pre>
          ${d.canPost ? html`<${Button} variant="primary" disabled=${!d.discord} busy=${post.busy}
              onClick=${async () => { if ((await post.run()).ok) reload(); }}>${d.posted ? 'Post it again' : 'Post to Discord now'}<//>
            ${!d.discord ? html`<p class="hint">Add the guild's Discord webhook in Settings first.</p>` : null}`
            : html`<p class="hint mb-0">The Guild Master's Guild Camp posts it on Sunday evening. Officers can post it by hand.</p>`}
        <//>
      </div>
    </div>`;
}
