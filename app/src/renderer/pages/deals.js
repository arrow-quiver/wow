// Deal hunter: what to buy on the auction house now and sell again for more, from my own Auctionator scans.
// API: docs/api/economy.md (GET /api/deals). Money in the URL is in copper (min, budget, max).
import { html, useState, useEffect } from '../lib/html.js';
import { useApi, qs } from '../lib/api.js';
import { setQuery } from '../lib/router.js';
import { money, parseMoney, plural, number } from '../lib/format.js';
import {
  Page, Card, Stat, Table, Button, CopyButton, Input, Select, Empty, Async, ItemLink, Money, Notice, Pill,
} from '../components/index.js';
import { Sparkline, dayLabel } from './prices.js';

const SURE = {
  certain: ['ok', 'Certain', 'A vendor pays more than this costs'],
  high: ['ok', 'Likely', 'Plenty of history, sells most days, steady price'],
  medium: ['warn', 'Fair', 'Some risk: less history, fewer sales or a swinging price'],
  low: ['muted', 'Risky', 'Little history or rarely listed: it may not sell at this price'],
};
const FLAG_KIND = { low: 'accent', falling: 'warn', slow: 'warn', swingy: 'warn' };

function Sure({ value }) {
  const [kind, label, title] = SURE[value] || SURE.low;
  return html`<${Pill} kind=${kind} dot title=${title}>${label}<//>`;
}

function Flags({ flags }) {
  if (!flags || !flags.length) return null;
  return html`<span class="deals-flags">${flags.map((f) => html`<${Pill} key=${f.kind} kind=${FLAG_KIND[f.kind] || 'muted'} title=${f.text}>${f.text}<//>`)}</span>`;
}

// ---------- page ----------

export default function DealsPage({ query = {} }) {
  const params = { realm: query.realm, min_profit: query.min, budget: query.budget, max_price: query.max };
  const deals = useApi(`/api/deals${qs(params)}`);
  const d = deals.data;
  const lede = d && d.realm
    ? `Buy these on ${d.realm}'s auction house and sell them again for more. From your Auctionator scan ${dayLabel(d.scan.day)}.`
    : 'What to buy on the auction house now and sell again for more, worked out from your own Auctionator scans.';
  return html`<${Page} title="Deal hunter" lede=${lede}
      actions=${html`<${Button} variant="ghost" icon="refresh" label="Refresh" busy=${deals.refreshing} onClick=${deals.reload} />`}>
    <${Async} q=${deals} loadingLabel="Hunting for deals…">${(data) => html`<${Deals} data=${data} query=${query} />`}<//>
  <//>`;
}

function Deals({ data, query }) {
  if (!data.realm) {
    return html`<${Card}><${Empty} icon="prices" title="No auction house scans yet.">
      In game, open the auction house with Auctionator and run a full scan, then log out or type /reload. Guild Camp reads
      Auctionator's history and finds items listed well below their usual price. Scan every day or two: the more history,
      the better the advice.
    <//><//>`;
  }
  const total = data.deals.reduce((s, x) => s + x.profit, 0) + data.vendor.reduce((s, x) => s + x.profit, 0);
  const best = [...data.deals, ...data.vendor].sort((a, b) => b.profit - a.profit)[0];
  return html`
    ${data.notes.map((n) => html`<${Notice} key=${n} kind="warn">${n}<//>`)}
    <${Filters} data=${data} query=${query} />
    <div class="deals-stats">
      <${Card}><${Stat} label="Deals" value=${number(data.deals.length + data.vendor.length)}
        hint=${`from ${plural(data.scan.items, 'item')} in your newest scan`} /><//>
      <${Card}><${Stat} label="Profit, one of each" value=${html`<${Money} copper=${total || null} compact empty="—" />`}
        hint="after the auction house's 5% cut" /><//>
      <${Card}><${Stat} label="Best deal" value=${best ? html`<${Money} copper=${best.profit} compact />` : '—'}
        hint=${best ? html`<${ItemLink} id=${best.item_id} name=${best.name} quality=${best.quality} />` : 'Nothing worth it right now'} /><//>
    </div>
    ${data.plan ? html`<${Plan} data=${data} />` : null}
    ${data.vendor.length ? html`<${Vendor} rows=${data.vendor} />` : null}
    <${Card} flush title="Buy to resell" sub=${data.deals.length ? 'best first: profit weighed by how sure it is' : null}>
      <${Table} dense columns=${columns()} rows=${data.deals} rowKey=${(r) => r.item_id}
        empty=${html`<${Empty} compact icon="search" title="No deals in this scan.">
          Nothing is listed at least 20% under its usual price with enough profit. Lower “Profit at least”, or scan again later.<//>`} />
    <//>
    <${HowItWorks} rules=${data.rules} />`;
}

function columns() {
  return [
    { key: 'name', label: 'Item', sortable: true, value: (r) => r.name || `Item ${r.item_id}`,
      render: (r) => html`<div class="deals-item"><${ItemLink} id=${r.item_id} name=${r.name} quality=${r.quality} /><${Flags} flags=${r.flags} /></div>` },
    { key: 'buy', label: 'Buy now', num: true, sortable: true, render: (r) => html`<${Money} copper=${r.buy} />` },
    { key: 'worth', label: 'Usually', num: true, sortable: true, title: 'The usual price over the last 30 days (the lower of the 30-day and 7-day medians)',
      render: (r) => html`<${Money} copper=${r.worth} />` },
    { key: 'trend', label: 'Last 14 days', width: '136px', render: (r) => html`<${Sparkline} history=${r.history} />` },
    { key: 'profit', label: 'Profit', num: true, sortable: true, title: 'Selling at the usual price, after the 5% cut',
      render: (r) => html`<strong><${Money} copper=${r.profit} /></strong> <span class="hint">${r.roi}%</span>` },
    { key: 'confidence', label: 'How sure', sortable: true, render: (r) => html`<${Sure} value=${r.sure} />` },
    { key: 'listed_days', label: 'Sells', num: true, sortable: true, title: 'Days it was listed in the last 14 (more days, easier to sell)',
      render: (r) => html`<span class="hint">${r.listed_days}/14 days</span>` },
    { key: 'copy', label: '', render: (r) => (r.name ? html`<${CopyButton} text=${r.name} label="Copy name" done=${`Copied “${r.name}”. Paste it into the auction house search.`} variant="ghost" />` : null) },
  ];
}

function Vendor({ rows }) {
  return html`<${Card} title="Vendor flips" sub="listed below what a vendor pays: buy and sell to any vendor">
    <ol class="list-lines deals-vendor">${rows.map((r) => html`<li key=${r.item_id} class="row row--between nowrap">
      <span class="ellipsis"><${ItemLink} id=${r.item_id} name=${r.name} quality=${r.quality} /></span>
      <span class="row nowrap">
        <span class="hint">buy <${Money} copper=${r.buy} compact />, vendor pays <${Money} copper=${r.sell_price} compact /></span>
        <strong>+<${Money} copper=${r.profit} compact /></strong>
      </span>
    </li>`)}</ol>
  <//>`;
}

function Plan({ data }) {
  const byId = new Map([...data.vendor, ...data.deals].map((d) => [d.item_id, d]));
  const items = data.plan.items.map((id) => byId.get(id)).filter(Boolean);
  return html`<${Card} tone="accent" title=${`With ${money(data.plan.budget)} to spend`}
      sub=${items.length ? `buy ${plural(items.length, 'item')} for ${money(data.plan.spend)}, about ${money(data.plan.profit)} profit` : 'nothing fits that budget'}>
    ${items.length ? html`<ol class="deals-plan">${items.map((d) => html`<li key=${d.item_id}>
      <${ItemLink} id=${d.item_id} name=${d.name} quality=${d.quality} /> <span class="hint">for</span> <${Money} copper=${d.buy} compact />
    </li>`)}</ol>` : null}
  <//>`;
}

function Filters({ data, query }) {
  const [min, setMin] = useState(query.min ? money(Number(query.min)) : '');
  const [budget, setBudget] = useState(query.budget ? money(Number(query.budget)) : '');
  const [max, setMax] = useState(query.max ? money(Number(query.max)) : '');
  const [bad, setBad] = useState(null);
  useEffect(() => { setMin(query.min ? money(Number(query.min)) : ''); }, [query.min]);
  const apply = (e) => {
    e.preventDefault();
    const read = (t, label) => { if (!String(t).trim()) return undefined; const c = parseMoney(t); if (c == null || c < 0) throw label; return c || undefined; };
    try {
      setQuery({ min: read(min, 'Profit at least'), budget: read(budget, 'Spend up to'), max: read(max, 'Max price each') });
      setBad(null);
    } catch (label) { setBad(`${label}: write an amount like 5g, 50s or 2g 50s.`); }
  };
  return html`<form class="deals-filters" onSubmit=${apply}>
    ${data.realms.length > 1 ? html`<${Select} label="Auction house" value=${data.realm}
      options=${data.realms.map((r) => ({ value: r.key, label: `${r.key} (${dayLabel(r.newest)})` }))}
      onValue=${(v) => setQuery({ realm: v })} />` : null}
    <${Input} label="Profit at least" placeholder=${money(data.rules.min_profit)} value=${min} onValue=${setMin} />
    <${Input} label="Spend up to" placeholder="e.g. 200g" value=${budget} onValue=${setBudget} />
    <${Input} label="Max price each" placeholder="any" value=${max} onValue=${setMax} />
    <${Button} type="submit" icon="search">Find deals<//>
    ${bad ? html`<p class="field-error deals-bad" role="alert">${bad}</p>` : null}
  </form>`;
}

function HowItWorks({ rules }) {
  return html`<details class="deals-how card">
    <summary>How deals are picked</summary>
    <ul>
      <li>Only items in your <strong>newest scan</strong> count. Older listings may be gone.</li>
      <li><strong>Usually</strong> is the lower of the 30-day and 7-day median price, so a falling price isn't over-valued.</li>
      <li>A deal is listed at least ${Math.round(rules.min_discount * 100)}% under its usual price, with ${rules.min_history_days}+ days of history,
        and makes at least ${money(rules.min_profit)} after the auction house's ${Math.round(rules.ah_cut * 100)}% cut.</li>
      <li><strong>How sure</strong> weighs how much history there is, how many days it was listed (how easily it sells) and how steady the price is.</li>
      <li>The price shown is the cheapest single listing. Check the auction house before you buy several, and remember the deposit if it doesn't sell.</li>
    </ul>
  </details>`;
}
