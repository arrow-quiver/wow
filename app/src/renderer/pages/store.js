// The guild bank store: spend the season points you've earned on what officers put up. An order is a guild bank
// request; officers send or decline it here or in the Bank page. API: docs/api/seasons.md ("The guild bank store").
import { html, useState, useEffect } from '../lib/html.js';
import { useApi, api, useAction } from '../lib/api.js';
import { Link } from '../lib/router.js';
import { number, plural } from '../lib/format.js';
import { Page, Card, Stat, Table, Button, Input, Empty, Async, Pill, ItemLink, TimeAgo } from '../components/index.js';

const STATUS = { open: ['warn', 'Waiting for an officer'], sent: ['ok', 'Sent'], declined: ['muted', 'Declined, points back'], cancelled: ['muted', 'Cancelled'] };

export default function StorePage() {
  const q = useApi('/api/store', { refreshOn: ['bank'] });
  return html`<${Page} title="Guild bank store"
      lede="Spend the season points you've earned (giving, crafting, raiding, fighting) on things from the guild bank.">
    <${Async} q=${q} loadingLabel="Opening the store…">${(d) => html`<${Store} d=${d} reload=${q.reload} />`}<//>
  <//>`;
}

function Store({ d, reload }) {
  return html`
    <div class="war-stats">
      <${Card}><${Stat} label="Points to spend" value=${number(d.balance.available)} hint="earned in seasons, minus what you've bought" /><//>
      <${Card}><${Stat} label="Earned" value=${number(d.balance.earned)} hint=${html`all time · <${Link} href="/seasons">Seasons<//>`} /><//>
      <${Card}><${Stat} label="Held" value=${number(d.balance.held)} hint="open orders" /><//>
      <${Card}><${Stat} label="Spent" value=${number(d.balance.spent)} hint="orders sent to you" /><//>
    </div>
    <div class="cols war-cols">
      <div class="stack stack--loose">
        <${Items} d=${d} reload=${reload} />
        ${d.canEdit ? html`<${Pending} rows=${d.pending} reload=${reload} />` : null}
        <${Mine} rows=${d.mine} reload=${reload} />
      </div>
      <div class="stack stack--loose">
        ${d.canEdit ? html`<${Editor} items=${d.items} reload=${reload} />` : null}
        <${Card} title="How it works">
          <ul class="list-tight hint">
            <li>Every season point you've ever earned can be spent here (streak bonuses aside).</li>
            <li>Ordering holds the points. An officer sends the item from the guild bank (by mail) and marks it sent.</li>
            <li>A declined or cancelled order gives the points back.</li>
            <li>Orders are ordinary bank requests, so officers see them in game too.</li>
          </ul>
        <//>
      </div>
    </div>`;
}

function ItemCard({ it, available, reload }) {
  const [count, setCount] = useState(1);
  const order = useAction(() => api.post('/api/store/order', { key: it.key, count }), { success: (r) => r.message });
  const total = it.cost * count;
  const canBuy = it.left > 0 && available >= it.cost;
  return html`<li class="store-item">
    <div class="store-item-name">${it.itemId ? html`<${ItemLink} id=${it.itemId} name=${it.item} />` : html`<b>${it.item}</b>`}</div>
    <div class="row row--between nowrap"><span class="store-cost">${number(it.cost)} <span class="hint">points</span></span>
      <span class="hint">${it.left ? `${it.left} left` : 'sold out'}</span></div>
    <div class="row nowrap">
      <${Input} type="number" min="1" max=${Math.max(1, it.left)} value=${count} class="store-qty" aria-label=${`How many ${it.item}`}
        onValue=${(v) => setCount(Math.max(1, Math.min(Math.max(1, it.left), Number(v) || 1)))} />
      <${Button} size="sm" variant="primary" disabled=${!canBuy || available < total} busy=${order.busy}
        onClick=${async () => { const r = await order.run(); if (r.ok) { setCount(1); reload(); } }}>${available < total && canBuy ? 'Not enough points' : `Order for ${number(total)}`}<//>
    </div>
  </li>`;
}

function Items({ d, reload }) {
  return html`<${Card} title="For sale" sub=${plural(d.items.length, 'item')}>
    ${d.items.length ? html`<ul class="store-grid">${d.items.map((it) => html`<${ItemCard} key=${it.key} it=${it} available=${d.balance.available} reload=${reload} />`)}</ul>`
      : html`<${Empty} compact icon="gift" title="The store is empty.">${d.canEdit ? 'Put something up with the list on the right.' : 'Officers put items up for points here.'}<//>`}
  <//>`;
}

function Pending({ rows, reload }) {
  const act = useAction((id, verb) => api.post(`/api/bank/requests/${id}/${verb}`, {}), { success: (r) => r.message });
  const cols = [
    { key: 'requester', label: 'For', render: (o) => html`<b>${o.requester}</b><br /><span class="hint">${number(o.balance.available)} points left after</span>` },
    { key: 'item', label: 'Item', render: (o) => html`${o.count > 1 ? `${o.count} × ` : ''}${o.item}${o.note ? html`<br /><span class="hint">${o.note}</span>` : null}` },
    { key: 'total', label: 'Points', num: true, render: (o) => number(o.total) },
    { key: 'actions', label: '', render: (o) => html`<span class="row nowrap">
      <${Button} size="sm" variant="primary" onClick=${async () => { if ((await act.run(o.id, 'sent')).ok) reload(); }}>Sent<//>
      <${Button} size="sm" onClick=${async () => { if ((await act.run(o.id, 'declined')).ok) reload(); }}>Decline<//></span>` },
  ];
  return html`<${Card} flush title="Orders to send" sub="officers: mail the item from the guild bank, then mark it sent">
    <${Table} dense columns=${cols} rows=${rows} rowKey=${(o) => o.id} empty=${html`<${Empty} compact icon="bank" title="No orders waiting." />`} />
  <//>`;
}

function Mine({ rows, reload }) {
  const cancel = useAction((id) => api.post(`/api/bank/requests/${id}/cancel`, {}), { success: 'Order cancelled. Your points are back.' });
  return html`<${Card} title="Your orders">
    ${rows.length ? html`<ol class="list-lines">${rows.map((o) => html`<li key=${o.id} class="row row--between nowrap">
      <span class="ellipsis">${o.count > 1 ? `${o.count} × ` : ''}<b>${o.item}</b> <span class="hint">${number(o.total)} points · <${TimeAgo} t=${o.created_at} /></span></span>
      <span class="row nowrap"><${Pill} kind=${STATUS[o.status][0]}>${STATUS[o.status][1]}<//>
        ${o.status === 'open' ? html`<${Button} size="sm" onClick=${async () => { if ((await cancel.run(o.id)).ok) reload(); }}>Cancel<//>` : null}</span>
    </li>`)}</ol>` : html`<p class="hint mb-0">Nothing ordered yet.</p>`}
  <//>`;
}

function Editor({ items, reload }) {
  const [rows, setRows] = useState(items);
  useEffect(() => setRows(items), [items]);
  const save = useAction(() => api.put('/api/store', { items: rows.filter((r) => r.item && r.cost) }), { success: 'Store saved and shared with the guild.' });
  const set = (i, k, v) => setRows(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  return html`<${Card} title="Store items" sub="officers: what you sell, for how many points">
    <div class="stack">
      ${rows.map((r, i) => html`<div key=${r.key || `new${i}`} class="store-edit-row">
        <${Input} value=${r.item} placeholder="Item name" aria-label="Item" onValue=${(v) => set(i, 'item', v)} />
        <${Input} type="number" min="1" value=${r.cost || ''} placeholder="Points" aria-label="Points" onValue=${(v) => set(i, 'cost', Number(v) || 0)} />
        <${Input} type="number" min="0" value=${r.stock ?? 0} placeholder="Stock" aria-label="Stock" onValue=${(v) => set(i, 'stock', Number(v) || 0)} />
        <button type="button" class="store-x" aria-label=${`Remove ${r.item || 'item'}`} onClick=${() => setRows(rows.filter((_, j) => j !== i))}>×</button>
      </div>`)}
      ${rows.length < 25 ? html`<${Button} size="sm" icon="plus" onClick=${() => setRows([...rows, { item: '', cost: 50, stock: 1 }])}>Add an item<//>` : null}
      <${Button} variant="primary" busy=${save.busy} onClick=${async () => { if ((await save.run()).ok) reload(); }}>Save the store<//>
      <p class="hint mb-0">Item, price in points, and how many you have to give. Stock counts down as orders come in.</p>
    </div>
  <//>`;
}
