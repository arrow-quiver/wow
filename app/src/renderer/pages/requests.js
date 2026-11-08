// Crafting requests: ask for an item, and crafters who know the recipe get a notification.
// Anyone else can claim an open request; the crafter can give it back ("I can't make it"), which opens it again;
// the crafter or the requester marks it delivered; the requester can cancel until it is delivered. Requests and
// claims go to guildmates through the addon.
// Data: GET /api/requests (docs/api/community.md).
import { html, useState, useEffect, useMemo } from '../lib/html.js';
import { api, useApi, useAction } from '../lib/api.js';
import { setQuery } from '../lib/router.js';
import { useSession } from '../lib/session.js';
import {
  Page, Card, Table, Button, ConfirmButton, Input, Checkbox, Tabs, Pill, Empty, Async, ClassName, TimeAgo,
} from '../components/index.js';
import { ShareHint } from '../components/ShareHint.js';

const shortTag = (bt) => String(bt || '').split('#')[0];

// What I may do with a request (the core's can* flags, the same rules its POST /api/requests/:id/:verb enforces).
const REQUEST_ACTIONS = [['claim', 'canClaim'], ['done', 'canDone'], ['withdraw', 'canWithdraw'], ['cancel', 'canCancel']];

/** The buttons a request row gets, in order: claim · done · withdraw · cancel (exported for tests). */
export function requestActions(r) {
  return r && typeof r === 'object' ? REQUEST_ACTIONS.filter(([, flag]) => r[flag]).map(([verb]) => verb) : [];
}
const TABS = [
  { id: 'open', label: 'Open', empty: 'Nothing waiting. Post a request above.' },
  { id: 'claimed', label: 'Being made', empty: 'Nothing in progress.' },
  { id: 'done', label: 'Delivered recently', empty: 'Nothing delivered in the last 7 days.' },
];

export default function RequestsPage({ query = {} }) {
  const data = useApi('/api/requests', { refreshOn: ['request'] });
  const tab = TABS.some((t) => t.id === query.tab) ? query.tab : 'open';
  return html`<${Page} title="Requests" width="wide"
      lede="Ask the guild's crafters for something. Whoever knows the recipe gets told."
      actions=${html`<${Button} variant="ghost" size="sm" icon="refresh" busy=${data.refreshing} onClick=${data.reload}>Refresh<//>`}>
    <${PostCard} prefill=${query.item || ''} onPosted=${data.reload} />
    <${Async} q=${data} loadingLabel="Loading requests…">
      ${(d) => html`<${RequestList} d=${d} tab=${tab} reload=${data.reload} />`}
    <//>
  <//>`;
}

function PostCard({ prefill, onPosted }) {
  const [item, setItem] = useState(prefill);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { if (prefill) setItem(prefill); }, [prefill]);
  const post = useAction((body) => api.post('/api/requests', body), { success: (r) => r.message || 'Request posted.' });
  const submit = async (e) => {
    e.preventDefault();
    if (!item.trim()) { setError('Name the item you need.'); return; }
    setError('');
    const r = await post.run({ item: item.trim(), notes: notes.trim() });
    if (r.ok) {
      setItem('');
      setNotes('');
      if (prefill) setQuery({ item: undefined, tab: 'open' });
      else setQuery({ tab: 'open' });
      onPosted();
    }
  };
  return html`<${Card} title="New request" class="requests-post">
    <form class="form-row" onSubmit=${submit} novalidate>
      <${Input} label="Item" value=${item} onValue=${(v) => { setItem(v); setError(''); }} maxLength="100" required
        placeholder="Exact recipe name, e.g. Copper Chain Vest" error=${error} fieldClass="requests-item" />
      <${Input} label="Notes" value=${notes} onValue=${setNotes} maxLength="200" placeholder="I have the mats, will mail them" fieldClass="requests-notes" />
      <${Button} type="submit" variant="primary" icon="plus" busy=${post.busy}>Post request<//>
    </form>
    <p class="hint mb-0">Use the recipe's exact name so crafters who know it are told.</p>
    <${ShareHint} discord />
  <//>`;
}

function RequestList({ d, tab, reload }) {
  const me = useSession().user?.id;
  const [onlyMine, setOnlyMine] = useState(false);
  const [onlyCraftable, setOnlyCraftable] = useState(false);
  const act = useAction((id, verb) => api.post(`/api/requests/${id}/${verb}`), { success: (r) => r.message });
  const [busyId, setBusyId] = useState(null);
  const run = async (id, verb) => {
    setBusyId(`${id}:${verb}`);
    const r = await act.run(id, verb);
    setBusyId(null);
    reload();
    return r;
  };

  const rows = d.requests.filter((r) => r.status === tab && (!onlyMine || r.mine || (me != null && r.crafter_id === me)) && (!onlyCraftable || r.i_can_craft));
  const craftable = d.requests.filter((r) => r.status === 'open' && r.i_can_craft && !r.mine).length;

  const columns = useMemo(() => [
    {
      key: 'item', label: 'Item', sortable: true,
      render: (r) => html`<div class="stack stack--tight requests-what">
        <span class="row"><strong>${r.item}</strong>
          ${r.mine ? html`<${Pill} kind="info">Yours<//>` : null}
          ${r.status === 'open' && r.i_can_craft && !r.mine ? html`<${Pill} kind="ok">You can make this<//>` : null}</span>
        ${r.notes ? html`<span class="muted small requests-notes-text">${r.notes}</span>` : null}
      </div>`,
    },
    { key: 'requester', label: 'For', sortable: true, value: (r) => shortTag(r.requester), render: (r) => html`<span title=${r.requester}>${shortTag(r.requester)}</span>` },
    {
      key: 'crafter', label: tab === 'open' ? 'Who can craft it' : tab === 'claimed' ? 'Being made by' : 'Made by',
      value: (r) => (r.status === 'open' ? r.crafters.length : shortTag(r.crafter)),
      render: (r) => (r.status === 'open'
        ? (r.crafters.length
          ? html`<span class="requests-crafters">${r.crafters.map((c, i) => html`<span key=${c.name} class="nowrap">${c.online ? html`<span class="dot" title="Online now"></span>` : null}<${ClassName} name=${c.name} cls=${c.class} />${i < r.crafters.length - 1 ? ', ' : ''}</span>`)}</span>`
          : html`<span class="faint">Nobody known can make this yet.</span>`)
        : html`<span title=${r.crafter || ''}>${shortTag(r.crafter) || '?'}</span>`),
    },
    { key: 'updated_at', label: tab === 'open' ? 'Asked' : 'Updated', sortable: true, width: '110px', render: (r) => html`<span class="muted"><${TimeAgo} t=${tab === 'open' ? r.created_at : r.updated_at} /></span>` },
    {
      key: 'actions', label: '', align: 'right', width: '1%',
      render: (r) => html`<div class="actions-row requests-actions">
        ${requestActions(r).map((verb) => {
          if (verb === 'claim') return html`<${Button} key=${verb} size="sm" variant=${r.i_can_craft ? 'primary' : 'secondary'} busy=${busyId === `${r.id}:claim`} onClick=${() => run(r.id, 'claim')}>I'll make it<//>`;
          if (verb === 'done') return html`<${Button} key=${verb} size="sm" variant="primary" icon="check" busy=${busyId === `${r.id}:done`} onClick=${() => run(r.id, 'done')}>Mark delivered<//>`;
          // The crafter gives the request back: it is open again for other crafters.
          if (verb === 'withdraw') {
            return html`<${ConfirmButton} key=${verb} size="sm" variant="ghost" question="Give this request back?" yes="Give it back" no="Keep it"
              title="Other crafters can take it on again." onConfirm=${() => run(r.id, 'withdraw')}>I can't make it<//>`;
          }
          return html`<${ConfirmButton} key=${verb} size="sm" variant="ghost" question="Cancel this request?" yes="Cancel it" no="Keep"
            onConfirm=${() => run(r.id, 'cancel')}>Cancel<//>`;
        })}
      </div>`,
    },
  ], [tab, busyId]);

  const current = TABS.find((t) => t.id === tab);
  return html`<${Card} flush class="requests-list">
    <div class="requests-toolbar">
      <${Tabs} tabs=${TABS.map((t) => ({ id: t.id, label: t.label, count: d.counts[t.id] }))} value=${tab}
        onChange=${(id) => setQuery({ tab: id === 'open' ? undefined : id })} label="Request status" idPrefix="requests" class="requests-tabs" />
      <div class="row requests-filters">
        ${craftable ? html`<${Pill} kind="ok">${craftable} you can make<//>` : null}
        <${Checkbox} label="I can make it" checked=${onlyCraftable} onValue=${setOnlyCraftable} />
        <${Checkbox} label="Mine" checked=${onlyMine} onValue=${setOnlyMine} />
      </div>
    </div>
    <div role="tabpanel" id=${`requests-${tab}-panel`} aria-labelledby=${`requests-${tab}`}>
      ${rows.length
        ? html`<${Table} columns=${columns} rows=${rows} rowKey=${(r) => r.id}
            rowClass=${(r) => (r.status === 'open' && r.i_can_craft && !r.mine ? 'requests-row--craftable' : undefined)} />`
        : html`<${Empty} compact icon="requests" title=${onlyMine || onlyCraftable ? 'Nothing matches these filters.' : current.empty} />`}
    </div>
    ${tab !== 'done' && rows.length ? html`<div class="requests-foot"><${ShareHint} /></div>` : null}
  <//>`;
}
