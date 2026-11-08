// Crafters: search any recipe to see who in the guild can make it (and ask them), a summary of everyone's
// professions, your shopping list from the addon (where your mats are, guild bank stock, prices, total), and other
// members' shopping lists with what they would cost. Data: GET /api/crafters?q= (docs/api/community.md).
import { html, useState, useEffect, useMemo } from '../lib/html.js';
import { useApi, qs } from '../lib/api.js';
import { navigate, setQuery } from '../lib/router.js';
import { plural } from '../lib/format.js';
import {
  Page, Card, Table, Button, Input, Pill, Empty, Async, Modal, ClassName, SpellLink, ItemLink, Money, TimeAgo,
} from '../components/index.js';

const shortTag = (bt) => String(bt || '').split('#')[0];

export default function CraftersPage({ query = {} }) {
  const q = String(query.q || '').trim();
  const data = useApi(`/api/crafters${qs({ q })}`);
  return html`<${Page} title="Crafters" width="wide">
    <${SearchCard} q=${q} />
    <${Async} q=${data} loadingLabel="Asking around camp…">
      ${(d) => html`<${CraftersBody} d=${d} />`}
    <//>
  <//>`;
}

function SearchCard({ q }) {
  const [text, setText] = useState(q);
  useEffect(() => setText(q), [q]);
  const submit = (e) => {
    e.preventDefault();
    setQuery({ q: text.trim() || undefined }, { replace: false });
  };
  return html`<${Card} class="crafters-search">
    <form class="form-row" role="search" onSubmit=${submit}>
      <${Input} type="search" value=${text} onValue=${setText} maxLength="60" aria-label="Search recipes"
        placeholder="Search a recipe, e.g. Heavy Silk Bandage" autoFocus fieldClass="crafters-search-field" class="crafters-search-input" />
      <${Button} type="submit" variant="primary" icon="search">Search<//>
      ${q ? html`<${Button} variant="ghost" onClick=${() => setQuery({ q: undefined }, { replace: false })}>Clear<//>` : null}
    </form>
    <p class="hint mb-0">Recipes show up once their owner opens that profession window in game. Guildmates' recipes arrive through the addon.</p>
  <//>`;
}

function CraftersBody({ d }) {
  return html`
    ${d.q ? html`<${ResultsCard} q=${d.q} results=${d.results} /> ` : html`<${ProfessionsCard} professions=${d.professions} />`}
    <${ShoppingCard} shop=${d.shopping} />
    <${GuildListsCard} lists=${d.lists} />`;
}

// ---------- search results ----------

function CrafterList({ crafters }) {
  return html`<span class="crafters-who">
    ${crafters.map((c, i) => html`<span key=${c.name} class="nowrap">
      ${c.online ? html`<span class="dot" title="Online now"></span>` : null}<${ClassName} name=${c.name} cls=${c.class} />${i < crafters.length - 1 ? ', ' : ''}
    </span>`)}
  </span>`;
}

function ResultsCard({ q, results }) {
  const columns = useMemo(() => [
    {
      key: 'recipe', label: 'Recipe', sortable: true,
      render: (r) => html`<span class="stack stack--tight crafters-recipe"><${SpellLink} id=${r.recipeId} name=${r.recipe} />
        ${r.profession ? html`<span class="muted small">${r.profession}</span>` : null}</span>`,
    },
    { key: 'crafters', label: 'Who can make it', value: (r) => r.crafters.length, render: (r) => html`<${CrafterList} crafters=${r.crafters} />` },
    {
      key: 'online', label: 'Online', num: true, sortable: true, width: '80px',
      value: (r) => r.crafters.filter((c) => c.online).length,
      render: (r) => { const n = r.crafters.filter((c) => c.online).length; return n ? html`<${Pill} kind="ok">${n}<//>` : html`<span class="faint">0</span>`; },
    },
    {
      key: 'act', label: '', align: 'right', width: '120px',
      render: (r) => html`<${Button} size="sm" icon="requests" onClick=${(e) => { e.stopPropagation(); navigate(`/requests${qs({ item: r.recipe })}`); }}>Request<//>`,
    },
  ], []);
  return html`<${Card} flush title=${results.length ? `Who can make "${q}"` : `Nobody has a recipe matching "${q}"`}
      sub=${results.length ? plural(results.length, 'recipe') : null}>
    ${results.length
      ? html`<${Table} columns=${columns} rows=${results} rowKey=${(r) => r.recipe} />`
      : html`<${Empty} icon="search" title="No matches."
          action=${html`<${Button} icon="requests" onClick=${() => navigate(`/requests${qs({ item: q })}`)}>Post a request anyway<//>`}>
          Try part of the name. Recipes only show up once their owner has opened that profession window in game.
        <//>`}
  <//>`;
}

// ---------- professions summary ----------

function ProfessionsCard({ professions }) {
  const columns = useMemo(() => [
    { key: 'name', label: 'Profession', sortable: true, render: (p) => html`<strong>${p.name}</strong>`, width: '180px' },
    { key: 'count', label: 'Crafters', num: true, sortable: true, width: '90px' },
    { key: 'best', label: 'Best skill', num: true, sortable: true, width: '100px', value: (p) => (p.crafters[0] ? p.crafters[0].skill : null),
      render: (p) => (p.crafters[0] ? `${p.crafters[0].skill ?? '?'}` : '') },
    {
      key: 'crafters', label: 'Who',
      render: (p) => html`<span class="crafters-who">
        ${p.crafters.map((c, i) => html`<span key=${c.name} class="nowrap">
          <${ClassName} name=${c.name} cls=${c.class} /> <span class="muted small">${c.skill ?? ''}</span>${i < p.crafters.length - 1 ? ', ' : ''}
        </span>`)}
      </span>`,
    },
  ], []);
  return html`<${Card} flush title="Guild professions" sub=${professions.length ? plural(professions.length, 'profession') : null}>
    ${professions.length
      ? html`<${Table} columns=${columns} rows=${professions} rowKey=${(p) => p.name} sort=${{ key: 'name', dir: 'asc' }} />`
      : html`<${Empty} icon="crafters" title="No professions synced yet.">Open each profession window once in game, then /reload.<//>`}
  <//>`;
}

// ---------- shopping lists ----------

function MatsTable({ mats, mine }) {
  const columns = [
    { key: 'name', label: 'Mat', sortable: true, render: (m) => html`<${ItemLink} id=${m.id} name=${m.name} />` },
    { key: 'need', label: 'Need', num: true, sortable: true, width: '80px' },
    mine ? {
      key: 'chars', label: 'Where you have it',
      render: (m) => (m.chars.length ? m.chars.map((c) => `${c.name} ${c.n}`).join(', ') : html`<span class="faint">none on your characters</span>`),
    } : null,
    mine ? { key: 'guildBank', label: 'Guild bank', num: true, sortable: true, width: '100px', render: (m) => (m.guildBank ? m.guildBank : '') } : null,
    { key: 'price', label: 'Each', num: true, sortable: true, width: '120px', render: (m) => html`<${Money} copper=${m.price} />` },
    { key: 'cost', label: 'Cost', num: true, sortable: true, width: '130px', value: (m) => (m.price != null ? m.price * m.need : null),
      render: (m) => html`<${Money} copper=${m.price != null ? m.price * m.need : null} empty="" />` },
  ].filter(Boolean);
  return html`<${Table} columns=${columns} rows=${mats} rowKey=${(m) => m.id} dense />`;
}

function Total({ total, unpriced }) {
  if (!total && unpriced) return html`<span class="muted">No prices yet for these mats.</span>`;
  return html`<span class="crafters-total">About <${Money} copper=${total} />${unpriced ? html`<span class="muted small"> + ${plural(unpriced, 'mat')} with no price</span>` : null}</span>`;
}

function ShoppingCard({ shop }) {
  if (!shop) {
    return html`<${Card} title="Your shopping list">
      <p class="muted mb-0">Nothing on your list. In game, open a profession and use <strong>+5 list</strong> in the skill-up guide,
        or type <code>/wow list</code>. Your list shows here after the next sync.</p>
    <//>`;
  }
  return html`<${Card} flush title="Your shopping list" sub=${html`from the addon, <${TimeAgo} t=${shop.updatedAt} />`}
      actions=${html`<${Total} total=${shop.total} unpriced=${shop.unpriced} />`}
      footer=${html`Prices come from Auctionator scans, yours and those guildmates share. Manage the list in game with <code>/wow list</code>.`}>
    <div class="crafters-shop-items">
      <span class="muted small">Making:</span>
      ${shop.items.map((e) => html`<${Pill} key=${e.name} kind="accent">${e.qty} × ${e.name}<//>`)}
    </div>
    <${MatsTable} mats=${shop.mats} mine />
  <//>`;
}

function GuildListsCard({ lists }) {
  const [open, setOpen] = useState(null);
  const columns = useMemo(() => [
    {
      key: 'who', label: 'Member', sortable: true, value: (l) => (l.main ? l.main.name : shortTag(l.battletag)),
      render: (l) => html`<span class="stack stack--tight">
        ${l.main ? html`<${ClassName} name=${l.main.name} cls=${l.main.class} />` : html`<strong>${shortTag(l.battletag)}</strong>`}
        ${l.main && l.main.name !== shortTag(l.battletag) ? html`<span class="muted small">${shortTag(l.battletag)}</span>` : null}</span>`,
    },
    { key: 'items', label: 'Making', render: (l) => l.items.map((e) => `${e.qty} × ${e.name}`).join(', ') },
    { key: 'mats', label: 'Mats', num: true, sortable: true, width: '70px', value: (l) => l.mats.length, render: (l) => l.mats.length },
    {
      key: 'total', label: 'Total', num: true, sortable: true, width: '170px',
      render: (l) => html`<span class="stack stack--tight">
        <${Money} copper=${l.total || null} empty=${l.unpriced ? 'no prices' : '0c'} />
        ${l.total && l.unpriced ? html`<span class="muted small">+ ${plural(l.unpriced, 'mat')} with no price</span>` : null}
      </span>`,
    },
    { key: 'updatedAt', label: 'Updated', sortable: true, width: '110px', render: (l) => html`<span class="muted"><${TimeAgo} t=${l.updatedAt} /></span>` },
  ], []);
  return html`<${Card} flush title="Guild shopping lists" sub=${lists.length ? plural(lists.length, 'member') : null}>
    ${lists.length
      ? html`<${Table} columns=${columns} rows=${lists} rowKey=${(l) => l.user_id} onRowClick=${setOpen} />`
      : html`<${Empty} compact icon="crafters" title="Nobody else has a shopping list right now." />`}
    <${Modal} open=${!!open} size="lg" onClose=${() => setOpen(null)}
        title=${open ? `${open.main ? open.main.name : shortTag(open.battletag)}'s shopping list` : ''}
        footer=${html`<${Button} onClick=${() => setOpen(null)}>Close<//>`}>
      ${open ? html`<div class="stack">
        <div class="row">
          ${open.items.map((e) => html`<${Pill} key=${e.name} kind="accent">${e.qty} × ${e.name}<//>`)}
          <span class="spacer"></span>
          <${Total} total=${open.total} unpriced=${open.unpriced} />
        </div>
        <${MatsTable} mats=${open.mats} />
        <p class="hint mb-0">Got spare mats? Mail them to ${open.main ? open.main.name : shortTag(open.battletag)} in game.</p>
      </div>` : null}
    <//>
  <//>`;
}
