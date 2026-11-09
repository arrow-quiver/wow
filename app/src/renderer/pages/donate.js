// Donate: what guildies have asked the guild bank for (with today's prices, so you know what to buy), and the
// thanks board: every gold and item deposit, valued at the Auctionator price of the day it went in.
// API: docs/api/economy.md (GET /api/donations).
import { html } from '../lib/html.js';
import { useApi, qs } from '../lib/api.js';
import { setQuery, Link } from '../lib/router.js';
import { number, plural } from '../lib/format.js';
import { Page, Card, Stat, Table, Select, Empty, Async, ItemLink, Money, Pill, TimeAgo } from '../components/index.js';

const DAYS = [{ value: '7', label: 'This week' }, { value: '30', label: 'Last 30 days' }, { value: '365', label: 'This year' }];
const FROM = { auction: 'Auctionator price that day', vendor: 'What a vendor pays (no auction price that day)', gold: 'Gold' };

export default function DonatePage({ query = {} }) {
  const days = DAYS.some((d) => d.value === query.days) ? query.days : '30';
  const q = useApi(`/api/donations${qs({ days })}`, { refreshOn: ['bank'] });
  return html`<${Page} title="Donate"
      lede="Top up the guild bank with what guildies have asked for. Every gold and item you put in counts, valued at that day's auction price."
      actions=${html`<${Select} aria-label="Period" value=${days} options=${DAYS} onValue=${(v) => setQuery({ days: v === '30' ? undefined : v })} />`}>
    <${Async} q=${q} loadingLabel="Reading the guild bank…">${(d) => html`
      <div class="war-stats">
        <${Card}><${Stat} label="Given to the guild" value=${html`<${Money} copper=${d.total} compact empty="0" />`} hint=${periodText(d.days)} /><//>
        <${Card}><${Stat} label="Your gifts" value=${html`<${Money} copper=${d.mine.value} compact empty="0" />`}
          hint=${d.mine.rank ? `#${d.mine.rank} on the board, ${plural(d.mine.count, 'deposit')}` : 'Nothing yet: be the first'} /><//>
        <${Card}><${Stat} label="Open requests" value=${number(d.requests.length)} hint=${d.requests.length ? 'from guildies' : 'the bank has what people need'} /><//>
        <${Card}><${Stat} label="To fill them all" value=${html`<${Money} copper=${d.toBuy || null} compact empty="—" />`}
          hint=${d.unpricedRequests ? `plus ${plural(d.unpricedRequests, 'item')} without a price` : 'at today\'s auction prices'} /><//>
      </div>
      <div class="cols war-cols">
        <div class="stack stack--loose">
          <${Requests} rows=${d.requests} />
          <${Recent} rows=${d.recent} />
        </div>
        <div class="stack stack--loose">
          <${Board} rows=${d.board} days=${d.days} />
          <${Card} title="How it counts">
            <ul class="list-tight hint">
              <li>Put gold or items in the guild bank as usual. When anyone with the addon opens the bank, the deposit is seen.</li>
              <li>Items are valued once, at the guild's Auctionator price on the day they went in (or what a vendor pays).</li>
              <li>To buy what's asked for: open the auction house in game and use the <b>Guild Camp</b> tab. It lists these requests with prices and buys them with your OK.</li>
              <li>Bank characters moving stock don't count as gifts.</li>
            </ul>
          <//>
        </div>
      </div>`}<//>
  <//>`;
}

const periodText = (d) => (d <= 7 ? 'this week' : d >= 365 ? 'this year' : `last ${d} days`);

function Requests({ rows }) {
  const cols = [
    { key: 'item', label: 'Wanted', render: (r) => (r.item_id ? html`<${ItemLink} id=${r.item_id} name=${r.item} />` : html`<b>${r.item}</b>`) },
    { key: 'count', label: 'How many', num: true },
    { key: 'requester', label: 'For', render: (r) => html`${r.requester || '–'}${r.note ? html`<br /><span class="hint">${r.note}</span>` : null}` },
    { key: 'unit_price', label: 'Each', num: true, render: (r) => (r.unit_price ? html`<${Money} copper=${r.unit_price} compact />` : html`<span class="hint">no price</span>`) },
    { key: 'total', label: 'All of it', num: true, sortable: true,
      render: (r) => (r.total ? html`<strong><${Money} copper=${r.total} compact /></strong>${r.priced_from === 'vendor' ? html` <span class="hint" title=${FROM.vendor}>vendor</span>` : null}` : '–') },
    { key: 'created_at', label: 'Asked', render: (r) => html`<${TimeAgo} t=${r.created_at} />` },
  ];
  return html`<${Card} flush title="Wanted by the guild" sub="open bank requests">
    <${Table} dense columns=${cols} rows=${rows} rowKey=${(r) => r.id}
      empty=${html`<${Empty} compact icon="bank" title="No open requests.">When guildies ask the bank for something (<${Link} href="/bank">Bank<//>), it shows here.<//>`} />
  <//>`;
}

function Board({ rows, days }) {
  return html`<${Card} title="Thank you" sub=${`top givers, ${periodText(days)}`}>
    ${rows.length ? html`<ol class="list-lines donate-board">${rows.map((b) => html`<li key=${b.rank} class=${b.me ? 'row row--between nowrap is-me' : 'row row--between nowrap'}>
      <span class="ellipsis"><span class="donate-rank">${b.rank <= 3 ? ['🥇', '🥈', '🥉'][b.rank - 1] : `#${b.rank}`}</span> <b>${b.who}</b>${b.me ? html` <${Pill} kind="accent">you<//>` : null}</span>
      <span class="row nowrap"><span class="hint">${plural(b.count, 'gift')}</span><strong><${Money} copper=${b.value} compact /></strong></span>
    </li>`)}</ol>` : html`<p class="hint mb-0">No gifts yet. Anything you put in the guild bank shows up here.</p>`}
  <//>`;
}

function Recent({ rows }) {
  return html`<${Card} title="Recent gifts">
    ${rows.length ? html`<ol class="list-lines">${rows.map((d) => html`<li key=${d.id} class="row row--between nowrap">
      <span class="ellipsis"><b>${d.who}</b> <span class="hint">gave </span>
        ${d.kind === 'gold' ? html`<${Money} copper=${d.value} compact />`
          : html`${d.count > 1 ? `${number(d.count)} × ` : ''}<${ItemLink} id=${d.item_id} name=${d.item_name} quality=${d.quality} />`}</span>
      <span class="row nowrap">${d.kind === 'item' ? (d.value != null ? html`<span title=${FROM[d.priced_from] || ''}><${Money} copper=${d.value} compact /></span>` : html`<span class="hint" title="No price known for that day yet">priced soon</span>`) : null}
        <span class="hint"><${TimeAgo} t=${d.at} /></span></span>
    </li>`)}</ol>` : html`<p class="hint mb-0">Nothing deposited yet.</p>`}
  <//>`;
}
