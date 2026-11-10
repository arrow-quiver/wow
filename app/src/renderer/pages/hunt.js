// The hunt: the guild's kill-on-sight list and officers' bounties. Kills of either, by guildies' addons, earn
// season points. Data: GET /api/hunt (docs/api/war.md, "Kill on sight and bounties").
import { html, useState } from '../lib/html.js';
import { api, useApi, useAction } from '../lib/api.js';
import { Page, Card, Button, ConfirmButton, Input, Pill, Empty, Async, TimeAgo, LocalTime } from '../components/index.js';
import { ShareHint } from '../components/ShareHint.js';
import { number, plural } from '../lib/format.js';

const STATUS = { open: ['warn', 'Open'], claimed: ['ok', 'Claimed'], expired: ['muted', 'Ran out'], closed: ['muted', 'Closed'] };

export default function HuntPage() {
  const q = useApi('/api/hunt');
  return html`<${Page} title="The hunt"
      lede="Alliance players the guild hunts, and bounties on their heads. Your addon warns you when one is near and counts your kills."
      actions=${html`<${Button} variant="ghost" size="sm" icon="refresh" busy=${q.refreshing} onClick=${q.reload}>Refresh<//>`}>
    <${Async} q=${q} loadingLabel="Sharpening blades…">${(d) => html`
      <div class="cols war-cols">
        <div class="stack stack--loose">
          <${Bounties} d=${d} reload=${q.reload} />
        </div>
        <div class="stack stack--loose">
          <${Kos} d=${d} reload=${q.reload} />
          <${Card} title="How it works">
            <ul class="list-tight hint">
              <li>Each kill of a kill-on-sight target: ${d.kosPoints} season points (on top of the usual 2 for a kill).</li>
              <li>A player bounty goes to the first guildie who kills them; a zone bounty pays every kill there, up to its number of kills.</li>
              <li>Your kills count when your addon sees the game's honorable kill line, in the open world.</li>
              <li>In game: <code>/wow kos</code>, <code>/wow kos add Name reason</code>, <code>/wow bounties</code>.</li>
            </ul>
          <//>
        </div>
      </div>`}
    <//>
  <//>`;
}

function Kos({ d, reload }) {
  const [name, setName] = useState('');
  const [reason, setReason] = useState('');
  const add = useAction(() => api.post('/api/kos', { name: name.trim(), reason: reason.trim() }), { success: (r) => r.message });
  const remove = useAction((n) => api.post(`/api/kos/${encodeURIComponent(n)}/remove`, {}), { success: (r) => r.message });
  return html`<${Card} title="Kill on sight" sub=${plural(d.kos.length, 'player')}>
    <form class="stack" novalidate onSubmit=${async (e) => { e.preventDefault(); if ((await add.run()).ok) { setName(''); setReason(''); reload(); } }}>
      <div class="form-grid hunt-form">
        <${Input} label="Player" value=${name} onValue=${setName} maxLength="24" placeholder="Gankalot" required />
        <${Input} label="Why (optional)" value=${reason} onValue=${setReason} maxLength="100" placeholder="Camps the Crossroads" />
      </div>
      <div class="form-actions"><${Button} type="submit" variant="primary" icon="target" busy=${add.busy} disabled=${!name.trim()}>Add to the list<//></div>
      <${ShareHint} />
    </form>
    ${d.kos.length ? html`<ol class="list-lines">${d.kos.map((k) => html`<li key=${k.name} class="row row--between nowrap">
      <span class="ellipsis"><b class="hunt-name">${k.name}</b>${k.reason ? html` <span class="hint">— ${k.reason}</span>` : null}<br />
        <span class="hint">${k.addedBy ? `added by ${k.addedBy}, ` : ''}<${TimeAgo} t=${k.addedAt} />${k.kills ? ` · slain ${plural(k.kills, 'time')}` : ''}</span></span>
      <${ConfirmButton} variant="ghost" size="sm" question=${`Take ${k.name} off the list?`} onConfirm=${async () => { if ((await remove.run(k.name)).ok) reload(); }}>Take off<//>
    </li>`)}</ol>` : html`<${Empty} compact icon="target" title="Nobody on the list." />`}
  <//>`;
}

function Bounties({ d, reload }) {
  const close = useAction((id) => api.post(`/api/bounties/${id}/close`, {}), { success: (r) => r.message });
  const open = d.bounties.filter((b) => b.status === 'open');
  const past = d.bounties.filter((b) => b.status !== 'open');
  const row = (b) => html`<li key=${b.key} class="hunt-bounty">
    <div class="row row--between nowrap">
      <span><b class="hunt-points">${number(b.points)}</b> <span class="hint">points</span> ${b.target ? html`for <b>${b.target}</b>` : html`each kill in <b>${b.zone}</b>`}</span>
      <${Pill} kind=${STATUS[b.status][0]}>${STATUS[b.status][1]}<//>
    </div>
    ${b.note ? html`<div class="hint">${b.note}</div>` : null}
    <div class="hint">${b.status === 'open' ? html`until <${LocalTime} t=${new Date(b.ends * 1000).toISOString()} />` : null}${!b.target ? ` · ${b.claims.length} of ${b.cap} kills paid` : ''}</div>
    ${b.claims.length ? html`<div class="small">${b.claims.map((c) => `${c.name || '?'} (${c.target})`).join(', ')}</div>` : null}
    ${d.canPost && b.status === 'open' ? html`<${ConfirmButton} variant="ghost" size="sm" question="Close this bounty?" onConfirm=${async () => { if ((await close.run(b.id)).ok) reload(); }}>Close<//>` : null}
  </li>`;
  return html`
    ${d.canPost ? html`<${NewBounty} reload=${reload} />` : null}
    <${Card} title="Bounties" sub=${plural(open.length, 'open bounty', 'open bounties')}>
      ${open.length ? html`<ul class="stack hunt-list">${open.map(row)}</ul>` : html`<${Empty} compact icon="trophy" title="No bounties up.">${d.canPost ? 'Put one up above.' : 'Officers put bounties up here.'}<//>`}
    <//>
    ${past.length ? html`<${Card} title="Past bounties"><ul class="stack hunt-list">${past.slice(0, 20).map(row)}</ul><//>` : null}`;
}

function NewBounty({ reload }) {
  const [kind, setKind] = useState('player');
  const [target, setTarget] = useState('');
  const [points, setPoints] = useState(50);
  const [cap, setCap] = useState(10);
  const [days, setDays] = useState(7);
  const [note, setNote] = useState('');
  const post = useAction(() => api.post('/api/bounties', kind === 'player' ? { target, points, days, note } : { zone: target, points, cap, days, note }), { success: (r) => r.message });
  return html`<${Card} title="Put up a bounty" sub="officers">
    <form class="stack" novalidate onSubmit=${async (e) => { e.preventDefault(); if ((await post.run()).ok) { setTarget(''); setNote(''); reload(); } }}>
      <div class="row" role="group" aria-label="Bounty on">
        <${Button} size="sm" variant=${kind === 'player' ? 'primary' : 'ghost'} aria-pressed=${kind === 'player'} onClick=${() => setKind('player')}>On a player<//>
        <${Button} size="sm" variant=${kind === 'zone' ? 'primary' : 'ghost'} aria-pressed=${kind === 'zone'} onClick=${() => setKind('zone')}>Kills in a zone<//>
      </div>
      <div class="form-grid hunt-form">
        <${Input} label=${kind === 'player' ? 'Player' : 'Zone'} value=${target} onValue=${setTarget} maxLength=${kind === 'player' ? 24 : 60}
          placeholder=${kind === 'player' ? 'Stabby' : 'Hillsbrad Foothills'} required />
        <${Input} label=${kind === 'player' ? 'Points' : 'Points a kill'} type="number" min="1" max="1000" value=${points} onValue=${(v) => setPoints(Number(v) || 0)} />
        ${kind === 'zone' ? html`<${Input} label="Kills paid" type="number" min="1" max="100" value=${cap} onValue=${(v) => setCap(Number(v) || 1)} />` : null}
        <${Input} label="Days" type="number" min="1" max="30" value=${days} onValue=${(v) => setDays(Number(v) || 7)} />
      </div>
      <${Input} label="Note (optional)" value=${note} onValue=${setNote} maxLength="100" placeholder="Ganking our lowbies at the Crossroads" />
      <div class="form-actions"><${Button} type="submit" variant="primary" icon="trophy" busy=${post.busy} disabled=${!target.trim() || !points}>Put it up<//>
        <span class="hint">Goes to every guildie's addon, and to Discord.</span></div>
    </form>
  <//>`;
}
