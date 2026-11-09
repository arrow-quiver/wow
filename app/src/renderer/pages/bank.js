// Bank: the guild bank (tabs, gold, value), bank requests, bank characters (guilds without a guild bank),
// a search across your own alts' bags and banks, and the guild bank log. Requests, their answers and the bank
// characters go to guildmates through the addon. API: docs/api/economy.md.
import { html, useState, useEffect, useMemo, cx } from '../lib/html.js';
import { api, useApi, useAction, qs } from '../lib/api.js';
import { useSession } from '../lib/session.js';
import { setQuery } from '../lib/router.js';
import { plural, number } from '../lib/format.js';
import {
  Page, Card, Stat, Table, Button, ConfirmButton, Tabs, tabId, tabPanelId, Pill, Input, Checkbox, Empty, Async,
  ItemLink, ClassName, Money, TimeAgo,
} from '../components/index.js';
import { ShareHint } from '../components/ShareHint.js';

const TABS = ['guild', 'requests', 'characters', 'alts', 'log'];
const ASK_ITEM_ID = 'bank-ask-item';

// The game's words for guild bank log entries → plain English.
const LOG_VERBS = {
  deposit: 'Deposited',
  withdraw: 'Took out',
  move: 'Moved',
  repair: 'Repaired with',
  withdrawForTab: 'Took out for a tab',
  buyTab: 'Bought a tab with',
  depositSummary: 'Deposited',
};
export const logVerb = (kind) => LOG_VERBS[kind] || (kind ? kind.charAt(0).toUpperCase() + kind.slice(1) : 'Changed');

export default function BankPage({ query = {} }) {
  const { isOfficer } = useSession();
  const bank = useApi('/api/bank', { refreshOn: ['bank'] });
  const tab = TABS.includes(query.tab) ? query.tab : 'guild';
  const d = bank.data;
  const open = d ? d.requests.filter((r) => r.status === 'open').length : null;
  const go = (t) => setQuery({ tab: t === 'guild' ? undefined : t, find: t === 'alts' ? query.find : undefined });
  // Opens the Requests tab with the cursor in the Item field.
  const askTheBank = () => {
    go('requests');
    setTimeout(() => document.getElementById(ASK_ITEM_ID)?.focus(), 60);
  };

  return html`<${Page} title="Bank"
      lede="The guild's shared stock. Ask for what you need, and find what your own characters carry."
      actions=${html`
        <${Button} variant="ghost" icon="refresh" label="Refresh" busy=${bank.refreshing} onClick=${bank.reload} />
        <${Button} variant="primary" icon="plus" onClick=${askTheBank}>Ask the bank<//>`}>
    <${Async} q=${bank} loadingLabel="Opening the vault…">${(data) => html`
      <${Summary} data=${data} open=${open} />
      <div class="stack">
        <${Tabs} label="Bank sections" value=${tab} onChange=${go} tabs=${[
          { id: 'guild', label: 'Guild bank', count: data.tabs.length || undefined },
          { id: 'requests', label: 'Requests', count: open || undefined },
          { id: 'characters', label: 'Bank characters', count: data.bankCharacters.length || undefined },
          { id: 'alts', label: 'My alts' },
          { id: 'log', label: 'Log' },
        ]} />
        <div role="tabpanel" id=${tabPanelId(tab)} aria-labelledby=${tabId(tab)} class="stack stack--loose">
          ${tab === 'guild' ? html`<${GuildBankTab} data=${data} />` : null}
          ${tab === 'requests' ? html`<${RequestsTab} data=${data} isOfficer=${isOfficer} onChange=${bank.reload} />` : null}
          ${tab === 'characters' ? html`<${CharactersTab} data=${data} isOfficer=${isOfficer} onChange=${bank.reload} />` : null}
          ${tab === 'alts' ? html`<${AltsTab} find=${query.find || ''} />` : null}
          ${tab === 'log' ? html`<${LogTab} log=${data.log} />` : null}
        </div>
      </div>`}<//>
  <//>`;
}

// ---------- summary ----------

function Summary({ data, open }) {
  const nothing = data.money == null && !data.tabs.length && !data.bankCharacters.length;
  return html`<${Card} class="bank-summary">
    <div class="bank-stats">
      <${Stat} label="Guild bank gold" value=${data.money != null ? html`<${Money} copper=${data.money} compact />` : '—'}
        hint=${data.money != null ? 'In the guild bank' : 'Not read yet'} />
      <${Stat} label="Stock value" value=${html`<${Money} copper=${data.value.total || null} compact empty="—" />`}
        hint="At recent guild auction prices" />
      <${Stat} label="Last read" value=${html`<${TimeAgo} t=${data.scanned_at} never="Never" />`}
        hint="Last time someone opened it" />
      <${Stat} label="Open requests" value=${number(open || 0)} hint=${open ? 'Waiting for an officer' : 'Nothing waiting'} />
    </div>
    ${nothing ? html`<p class="hint bank-summary-note">Nothing here yet. Open the guild bank in game with the addon, or have an officer mark a bank character.</p>` : null}
  <//>`;
}

// ---------- guild bank ----------

const itemColumns = (withTab) => [
  { key: 'name', label: 'Item', sortable: true, value: (r) => r.name || `Item ${r.item_id}`, render: (r) => html`<${ItemLink} id=${r.item_id} name=${r.name} />` },
  ...(withTab ? [{ key: 'tab', label: 'Tab', sortable: true, render: (r) => html`<span class="muted">${r.tab}</span>` }] : []),
  { key: 'count', label: 'Count', num: true, sortable: true, render: (r) => number(r.count) },
  { key: 'unit', label: 'Each', num: true, sortable: true, render: (r) => html`<${Money} copper=${r.unit} />` },
  { key: 'value', label: 'Value', num: true, sortable: true, render: (r) => (r.value != null ? html`<${Money} copper=${r.value} compact />` : null) },
];

// Filters items by name (or item id).
function filterItems(items, text) {
  const t = text.trim().toLowerCase();
  if (!t) return items;
  return items.filter((i) => (i.name || '').toLowerCase().includes(t) || String(i.item_id) === t);
}

function GuildBankTab({ data }) {
  const [current, setCurrent] = useState('all');
  const [filter, setFilter] = useState('');
  const tabs = data.tabs;
  useEffect(() => { if (current !== 'all' && !tabs.some((t) => t.name === current)) setCurrent('all'); }, [tabs]);

  if (!tabs.length) {
    return html`<${Card}>
      <${Empty} icon="bank" title="The guild bank hasn't been read yet.">
        Open the guild bank in game with the addon, then log out or type /reload. Guildmates' scans arrive through the addon too.
        No guild bank? Officers can mark bank characters instead.
      <//>
    <//>`;
  }
  const all = current === 'all';
  const shown = all ? null : tabs.find((t) => t.name === current) || null;
  const rows = all ? tabs.flatMap((t) => t.items.map((i) => ({ ...i, tab: t.name, key: `${t.name}:${i.item_id}` }))) : shown.items;
  const visible = filterItems(rows, filter);
  const value = all ? data.value.guildBank : shown.value;

  return html`<div class="stack">
    <div class="bank-tabpick" role="group" aria-label="Guild bank tab">
      <button type="button" class=${cx('bank-chip', all && 'is-on')} aria-pressed=${all ? 'true' : 'false'} onClick=${() => setCurrent('all')}>
        All tabs <span class="bank-chip-n">${tabs.reduce((n, t) => n + t.items.length, 0)}</span>
      </button>
      ${tabs.map((t) => html`<button key=${t.name} type="button" class=${cx('bank-chip', current === t.name && 'is-on')}
          aria-pressed=${current === t.name ? 'true' : 'false'} onClick=${() => setCurrent(t.name)}>
        ${t.name} <span class="bank-chip-n">${t.items.length}</span>
      </button>`)}
    </div>
    <${Card} flush title=${all ? 'All tabs' : shown.name} sub=${plural(rows.length, 'kind of item', 'kinds of item')}
        actions=${html`<span class="bank-worth">Worth about <${Money} copper=${value || null} compact empty="—" /></span>
          <${Input} type="search" class="bank-filter" placeholder="Filter items" aria-label="Filter items" value=${filter} onValue=${setFilter} />`}>
      <${Table} key=${current} dense columns=${itemColumns(all)} rows=${visible} rowKey=${(r) => r.key || r.item_id}
        sort=${{ key: 'name', dir: 'asc' }} empty=${filter ? `No item in ${all ? 'the guild bank' : shown.name} matches “${filter}”.` : 'This tab is empty.'} />
    <//>
    <p class="hint">Read <${TimeAgo} t=${data.scanned_at} />. Anyone opening the guild bank with the addon updates it.</p>
  </div>`;
}

// ---------- requests ----------

function RequestsTab({ data, isOfficer, onChange }) {
  const open = data.requests.filter((r) => r.status === 'open');
  const done = data.requests.filter((r) => r.status !== 'open');
  return html`<div class="cols bank-requests">
    <div class="stack stack--loose">
      <${Card} title="Open requests" sub=${open.length ? plural(open.length, 'request') : null} flush
          footer=${open.length && isOfficer ? html`<${ShareHint} officer />` : null}>
        ${open.length
          ? html`<ul class="list-plain bank-req-list">${open.map((r) => html`<${RequestRow} key=${r.id} r=${r} isOfficer=${isOfficer} onChange=${onChange} />`)}</ul>`
          : html`<${Empty} compact icon="bank" title="No open requests." />`}
      <//>
      ${done.length ? html`<${Card} title="Handled this week" sub=${plural(done.length, 'request')} flush>
        <ul class="list-plain bank-req-list">${done.map((r) => html`<li key=${r.id} class="bank-req bank-req--done">
          <div class="bank-req-main">
            <div class="bank-req-what"><strong>${number(r.count)} × ${r.item}</strong> <span class="muted">for ${r.requester}</span></div>
            <div class="bank-req-meta">
              <${Pill} kind=${r.status === 'sent' ? 'ok' : 'muted'}>${r.status === 'sent' ? 'Sent' : 'Declined'}<//>
              <span>by ${r.handler || 'an officer'}, <${TimeAgo} t=${r.updated_at} /></span>
            </div>
          </div>
        </li>`)}</ul>
      <//>` : null}
    </div>
    <${RequestForm} onDone=${onChange} />
  </div>`;
}

function RequestRow({ r, isOfficer, onChange }) {
  const act = useAction((verb) => api.post(`/api/bank/requests/${r.id}/${verb}`), { success: (v) => v.message });
  const run = async (verb) => { if ((await act.run(verb)).ok) onChange(); };
  return html`<li class="bank-req">
    <div class="bank-req-main">
      <div class="bank-req-what"><strong>${number(r.count)} × ${r.item}</strong>${r.mine ? html` <${Pill} kind="info">Yours<//>` : null}</div>
      ${r.note ? html`<p class="bank-req-note">${r.note}</p>` : null}
      <div class="bank-req-meta"><span>For ${r.requester}, <${TimeAgo} t=${r.created_at} /></span></div>
    </div>
    <div class="actions-row bank-req-actions">
      ${isOfficer ? html`
        <${Button} size="sm" variant="primary" icon="check" busy=${act.busy} onClick=${() => run('sent')}>Mark as sent<//>
        <${Button} size="sm" variant="ghost" disabled=${act.busy} onClick=${() => run('declined')}>Decline<//>` : null}
      ${r.mine ? html`<${ConfirmButton} size="sm" variant="ghost" question="Cancel it?" onConfirm=${() => run('cancel')}>Cancel<//>` : null}
    </div>
  </li>`;
}

function RequestForm({ onDone }) {
  const [item, setItem] = useState('');
  const [count, setCount] = useState('1');
  const [note, setNote] = useState('');
  const [error, setError] = useState(null);
  const send = useAction((body) => api.post('/api/bank/requests', body), { success: (v) => v.message });
  const submit = async (e) => {
    e.preventDefault();
    if (!item.trim()) { setError('Name the item you need.'); return; }
    setError(null);
    const r = await send.run({ item: item.trim(), count: Number(count) || 1, note: note.trim() });
    if (r.ok) { setItem(''); setCount('1'); setNote(''); onDone(); }
  };
  return html`<${Card} title="Ask the bank" class="bank-ask">
    <form class="stack" onSubmit=${submit} novalidate>
      <${Input} id=${ASK_ITEM_ID} label="Item" value=${item} onValue=${(v) => { setItem(v); if (error) setError(null); }} maxLength="100"
        placeholder="Heavy Runecloth Bandage" required error=${error} />
      <${Input} label="How many" type="number" min="1" max="1000" value=${count} onValue=${setCount} />
      <${Input} label="Why" value=${note} onValue=${setNote} maxLength="200" placeholder="For raid on Thursday" hint="Optional. Officers see this." />
      <div class="form-actions">
        <${Button} type="submit" variant="primary" icon="bank" busy=${send.busy}>Send request<//>
      </div>
      <p class="hint mb-0">An officer marks it sent when it's in your mailbox.</p>
      <${ShareHint} discord />
    </form>
  <//>`;
}

// ---------- bank characters ----------

function CharactersTab({ data, isOfficer, onChange }) {
  const chars = data.bankCharacters;
  return html`<div class="stack stack--loose">
    ${chars.length ? html`
      <p class="hint mb-0">Characters that hold guild stock. Worth about <${Money} copper=${data.value.bankCharacters || null} compact empty="nothing yet" /> together.</p>
      ${chars.map((c) => html`<${Card} key=${c.name} flush
          title=${html`<${ClassName} name=${c.name} cls=${c.class} />`}
          sub=${[c.level ? `Level ${c.level}` : null, c.owner ? `${c.owner}'s character` : 'No owner', html`updated <${TimeAgo} t=${c.updated_at} />`]
            .filter(Boolean).map((x, i) => html`${i ? ' · ' : ''}${x}`)}
          actions=${html`<span class="bank-worth">Worth about <${Money} copper=${c.value || null} compact empty="—" /></span>`}>
        <${Table} dense columns=${itemColumns(false)} rows=${c.items} rowKey=${(r) => r.item_id} sort=${{ key: 'name', dir: 'asc' }}
          empty=${`Nothing known for ${c.name} yet. Its bags and bank show here once its owner logs in on it with the addon.`} />
      <//>`)}`
    : html`<${Card}><${Empty} icon="character" title="No bank characters yet.">
        No guild bank? Officers can mark the characters that hold guild stock. Their bags and bank show here once their owner logs in on them with the addon.
      <//><//>`}
    ${isOfficer ? html`<${BankCharacterEditor} onSaved=${onChange} />` : null}
  </div>`;
}

function BankCharacterEditor({ onSaved }) {
  const alts = useApi('/api/bank/alts');
  const [picked, setPicked] = useState(null);
  const [filter, setFilter] = useState('');
  const saved = useMemo(() => new Set((alts.data?.characters || []).filter((c) => c.is_bank).map((c) => c.name)), [alts.data]);
  useEffect(() => { if (alts.data) setPicked(new Set(saved)); }, [saved]);
  const save = useAction((names) => api.put('/api/bank/alts', { names }), { success: (v) => v.message });

  const changed = picked && (picked.size !== saved.size || [...picked].some((n) => !saved.has(n)));
  const toggle = (name, on) => setPicked((p) => { const n = new Set(p); if (on) n.add(name); else n.delete(name); return n; });
  const submit = async () => {
    const r = await save.run([...picked]);
    if (r.ok) { await alts.reload(); onSaved(); }
  };
  const list = (alts.data?.characters || []).filter((c) => !filter.trim() || c.name.toLowerCase().includes(filter.trim().toLowerCase())
    || (c.owner || '').toLowerCase().includes(filter.trim().toLowerCase()));

  return html`<${Card} tone="accent" title="Choose bank characters" sub="Officers"
      actions=${html`<${Input} type="search" class="bank-filter" placeholder="Find a character" aria-label="Find a character" value=${filter} onValue=${setFilter} />`}
      footer=${html`<div class="stack stack--tight">
        <div class="row row--between">
          <span class="hint">${picked ? `${plural(picked.size, 'bank character')} picked.` : ''}</span>
          <div class="actions-row">
            ${changed ? html`<${Button} variant="ghost" onClick=${() => setPicked(new Set(saved))}>Undo<//>` : null}
            <${Button} variant="primary" busy=${save.busy} disabled=${!changed} onClick=${submit}>Save bank characters<//>
          </div>
        </div>
        <${ShareHint} officer />
      </div>`}>
    <${Async} q=${alts} loadingLabel="Loading characters…">${() => (list.length
      ? html`<div class="bank-alt-grid">${list.map((c) => html`<${Checkbox} key=${c.name} class="bank-alt"
            checked=${picked?.has(c.name)} onValue=${(on) => toggle(c.name, on)}
            label=${html`<${ClassName} name=${c.name} cls=${c.class} link=${false} />`}
            hint=${[c.level ? `Level ${c.level}` : null, c.owner || 'no owner', c.items ? plural(c.items, 'item') : 'nothing known yet'].filter(Boolean).join(' · ')} />`)}</div>`
      : html`<${Empty} compact icon="character" title=${filter ? `No character matches “${filter}”.` : 'No linked characters yet.'} />`)}<//>
  <//>`;
}

// ---------- my alts ----------

function AltsTab({ find }) {
  const [text, setText] = useState(find);
  useEffect(() => setText(find), [find]);
  const results = useApi(find ? `/api/bank/search${qs({ q: find })}` : null);
  const submit = (e) => {
    e.preventDefault();
    const q = text.trim();
    setQuery({ tab: 'alts', find: q || undefined });
  };
  return html`<${Card} title="Find something on your own characters" flush>
    <form class="row bank-find" role="search" onSubmit=${submit}>
      <${Input} type="search" class="bank-find-input" placeholder="Which alt has my Runecloth?" aria-label="Item name"
        value=${text} onValue=${setText} maxLength="60" />
      <${Button} type="submit" icon="search">Find<//>
    </form>
    ${!find ? html`<p class="hint bank-pad">Searches the bags and banks of all your characters Guild Camp knows. Bank contents update when you open the bank in game.</p>`
      : html`<${Async} q=${results} loadingLabel="Searching your characters…">${(r) => html`<${Table} dense rows=${r.results}
          rowKey=${(x) => `${x.character}:${x.location}:${x.item_id}`}
          columns=${[
            { key: 'name', label: 'Item', sortable: true, render: (x) => html`<${ItemLink} id=${x.item_id} name=${x.name} />` },
            { key: 'count', label: 'Count', num: true, sortable: true, render: (x) => number(x.count) },
            { key: 'character', label: 'Character', sortable: true, render: (x) => html`<${ClassName} name=${x.character} cls=${x.class} />` },
            { key: 'location', label: 'Where', sortable: true, render: (x) => (x.location === 'bank' ? 'Bank' : 'Bags') },
          ]}
          empty=${html`<${Empty} compact icon="search" title=${`None of your characters carry “${r.q}”.`}>Bank contents update when you open the bank in game.<//>`} />`}<//>`}
  <//>`;
}

// ---------- log ----------

function LogTab({ log }) {
  if (!log.length) {
    return html`<${Card}><${Empty} icon="bank" title="No guild bank log yet.">The log is read along with the guild bank when someone opens it in game.<//><//>`;
  }
  return html`<div class="stack">
    <${Card} flush title="Guild bank log" sub="newest 40">
      <${Table} dense rows=${log} columns=${[
        { key: 'at', label: 'When', sortable: true, render: (l) => html`<span class="muted">about <${TimeAgo} t=${l.at} /></span>` },
        { key: 'who', label: 'Who', sortable: true, render: (l) => l.who || html`<span class="muted">Someone</span>` },
        { key: 'kind', label: 'What', render: (l) => logVerb(l.kind) },
        { key: 'item', label: 'Item or gold', render: (l) => (l.item_id
          ? html`<${ItemLink} id=${l.item_id} name=${l.name} count=${l.count} />`
          : l.amount != null ? html`<${Money} copper=${l.amount} compact />` : null) },
      ]} />
    <//>
    <p class="hint">Times are approximate: the game only says how many hours ago something happened.</p>
  </div>`;
}
