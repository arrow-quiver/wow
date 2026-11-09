// Prices: the guild price index built from members' Auctionator scans. Search an item, see its latest price and
// two-week trend, and what the guild bank's stock is worth. API: docs/api/economy.md (GET /api/prices).
import { html, useState, useEffect, useRef } from '../lib/html.js';
import { useApi, qs } from '../lib/api.js';
import { setQuery } from '../lib/router.js';
import { money, number, plural } from '../lib/format.js';
import {
  Page, Card, Stat, Table, Button, Input, Empty, Async, ItemLink, Money,
} from '../components/index.js';

// ---------- scan days ----------

// Scan days are calendar days ("2026-11-07"), not moments, so they are shown as written: "today", "yesterday" or
// "7 Nov". (Converting them to the viewer's time zone would show the day before for anyone west of UTC.)
export function dayLabel(day, now = new Date()) {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return '';
  const pad = (n) => String(n).padStart(2, '0');
  const local = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  if (day === local(now)) return 'today';
  if (day === local(new Date(now.getTime() - 86400000))) return 'yesterday';
  const d = new Date(`${day}T00:00:00Z`);
  const sameYear = d.getUTCFullYear() === now.getFullYear();
  return d.toLocaleDateString(undefined, { timeZone: 'UTC', day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
}

function Day({ day }) {
  if (!day) return html`<span class="muted">—</span>`;
  return html`<time datetime=${day}>${dayLabel(day)}</time>`;
}

// ---------- sparkline ----------

const W = 120;
const H = 28;

// Points for a polyline through the prices, scaled into the box (2px padding top and bottom).
export function sparkPoints(prices, w = W, h = H) {
  if (!prices || prices.length < 2) return [];
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  return prices.map((p, i) => [
    Math.round((i / (prices.length - 1)) * w * 10) / 10,
    Math.round((h - 2 - ((p - lo) / (hi - lo || 1)) * (h - 4)) * 10) / 10,
  ]);
}

/** A small price-over-time line drawn with inline SVG. history: [{ day, price }] oldest first. */
export function Sparkline({ history }) {
  const prices = (history || []).map((x) => x.price);
  const pts = sparkPoints(prices);
  if (!pts.length) return html`<span class="muted small">${prices.length === 1 ? 'One scan' : '—'}</span>`;
  const line = pts.map((p) => p.join(',')).join(' ');
  const area = `M0,${H} L${pts.map((p) => p.join(',')).join(' L')} L${W},${H} Z`;
  const [lx, ly] = pts[pts.length - 1];
  const label = `Price on the last ${prices.length} scan days, from ${money(prices[0])} to ${money(prices[prices.length - 1])}`;
  return html`<svg class="prices-spark" viewBox=${`0 0 ${W} ${H}`} width=${W} height=${H} role="img" aria-label=${label}>
    <title>${label}</title>
    <path class="prices-spark-area" d=${area} />
    <polyline class="prices-spark-line" points=${line} />
    <circle class="prices-spark-dot" cx=${lx} cy=${ly} r="2.4" />
  </svg>`;
}

function Change({ value }) {
  if (value == null) return html`<span class="muted">—</span>`;
  if (value === 0) return html`<span class="prices-change">0%</span>`;
  const up = value > 0;
  return html`<span class=${`prices-change ${up ? 'prices-change--up' : 'prices-change--down'}`}
      title=${`${up ? 'Up' : 'Down'} ${Math.abs(value)}% over the trend shown`}>
    <span aria-hidden="true">${up ? '▲' : '▼'}</span> ${Math.abs(value)}%<span class="sr">${up ? ' up' : ' down'}</span>
  </span>`;
}

// ---------- page ----------

export default function PricesPage({ query = {} }) {
  const q = String(query.q || '').trim();
  const prices = useApi(`/api/prices${qs({ q })}`);
  // Keep showing the previous answer while a new search loads, so the page (and the search box) stay put.
  const last = useRef(null);
  if (prices.data) last.current = prices.data;
  const data = prices.data || (prices.error ? null : last.current);
  const lede = data && data.stats
    ? (data.stats.items
      ? `${plural(data.stats.items, 'item')} priced from Auctionator scans, yours and those guildmates share. Newest from ${dayLabel(data.stats.newest)}.`
      : 'No prices yet. Scan the auction house with Auctionator and Guild Camp adds the prices by itself.')
    : 'Auction prices from Auctionator scans, yours and those guildmates share.';

  return html`<${Page} title="Prices" lede=${lede}
      actions=${html`<${Button} variant="ghost" icon="refresh" label="Refresh" busy=${prices.refreshing} onClick=${prices.reload} />`}>
    ${data && (data.stats.items || data.bank.priced || data.bank.unpriced) ? html`<${Overview} data=${data} />` : null}
    <${Search} q=${q} busy=${prices.loading} />
    ${data
      ? html`<${Results} data=${data} q=${data.q} stale=${prices.loading} />`
      : html`<${Async} q=${prices} loadingLabel="Checking the auction house…">${() => null}<//>`}
  <//>`;
}

function Overview({ data }) {
  const b = data.bank;
  return html`<div class="prices-overview">
    <div class="stack">
      <${Card}>
        <${Stat} label="Items priced" value=${number(data.stats.items || 0)}
          hint=${data.stats.newest ? `Newest scan ${dayLabel(data.stats.newest)}` : 'No scans yet'} />
      <//>
      <${Card}>
        <${Stat} label="Bank stock value" value=${html`<${Money} copper=${b.total || null} compact empty="—" />`}
          hint=${b.priced || b.unpriced
            ? `${plural(b.priced, 'stack')} priced${b.unpriced ? `, ${number(b.unpriced)} without a recent price` : ''}`
            : 'Nothing in the guild bank or on bank characters yet'} />
        <dl class="prices-split">
          <div><dt>Guild bank</dt><dd><${Money} copper=${b.guildBank || null} compact empty="—" /></dd></div>
          <div><dt>Bank characters</dt><dd><${Money} copper=${b.bankCharacters || null} compact empty="—" /></dd></div>
        </dl>
      <//>
    </div>
    <${Card} title="Most valuable stacks" class="prices-top">
      ${b.top.length
        ? html`<ol class="list-lines prices-top-list">${b.top.map((x) => html`<li key=${x.item_id} class="row row--between nowrap">
            <span class="prices-top-item">
              <span class="ellipsis"><${ItemLink} id=${x.item_id} name=${x.name} count=${x.count} /></span>
              <span class="hint ellipsis">${x.character ? `on ${x.character}` : x.tab ? `${x.tab} tab` : ''}</span>
            </span>
            <${Money} copper=${x.value} compact />
          </li>`)}</ol>`
        : html`<p class="muted mb-0">Nothing priced in the bank yet.</p>`}
    <//>
  </div>`;
}

function Search({ q, busy }) {
  const [text, setText] = useState(q);
  const timer = useRef(0);
  useEffect(() => setText(q), [q]);
  useEffect(() => () => clearTimeout(timer.current), []);
  // Searches as you type, after a short pause.
  const onValue = (v) => {
    setText(v);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setQuery({ q: v.trim() || undefined }), 350);
  };
  const submit = (e) => {
    e.preventDefault();
    clearTimeout(timer.current);
    setQuery({ q: text.trim() || undefined });
  };
  return html`<form class="row prices-search" role="search" onSubmit=${submit}>
    <${Input} type="search" class="prices-search-input" placeholder="Search an item, e.g. Runecloth, or an item number" aria-label="Item"
      value=${text} onValue=${onValue} maxLength="60" />
    <${Button} type="submit" icon="search" busy=${busy}>Search<//>
    ${q ? html`<${Button} variant="ghost" onClick=${() => { setText(''); setQuery({ q: undefined }); }}>Clear<//>` : null}
  </form>`;
}

function Results({ data, q, stale }) {
  const rows = q ? data.results : data.held;
  const columns = [
    { key: 'name', label: 'Item', sortable: true, value: (r) => r.name || `Item ${r.item_id}`, render: (r) => html`<${ItemLink} id=${r.item_id} name=${r.name} />` },
    { key: 'latest', label: 'Latest', num: true, sortable: true, value: (r) => r.latest?.price ?? null, render: (r) => html`<${Money} copper=${r.latest?.price ?? null} />` },
    { key: 'change', label: 'Change', num: true, sortable: true, render: (r) => html`<${Change} value=${r.change} />` },
    { key: 'trend', label: 'Last 14 scans', render: (r) => html`<${Sparkline} history=${r.history} />`, width: '140px' },
    { key: 'day', label: 'Last scan', sortable: true, value: (r) => r.latest?.day ?? null, render: (r) => html`<${Day} day=${r.latest?.day} />` },
    ...(q ? [] : [{ key: 'holders', label: 'Held by', num: true, sortable: true, title: 'How many bags, banks and guild bank tabs hold it', render: (r) => number(r.holders) }]),
  ];
  if (!q && !data.stats.items) {
    return html`<${Card}><${Empty} icon="prices" title="No prices yet.">
      Scan the auction house in game with Auctionator, then log out or type /reload. Prices guildmates share through the addon show up here too.
    <//><//>`;
  }
  return html`<${Card} flush class=${stale ? 'prices-stale' : undefined}
      title=${q ? html`Matches for “${q}”` : 'What the guild holds'}
      sub=${q ? plural(rows.length, 'item') : 'Items in members’ bags and the guild bank with recent auction prices'}>
    <${Table} key=${q} dense columns=${columns} rows=${rows} rowKey=${(r) => r.item_id}
      sort=${q ? { key: 'name', dir: 'asc' } : undefined}
      empty=${q
        ? html`<${Empty} compact icon="search" title=${`No scanned item matches “${q}”.`}>Item names are learned from what people carry, so very rare items may only show by number.<//>`
        : 'Nothing the guild holds has a recent price yet.'} />
  <//>`;
}
