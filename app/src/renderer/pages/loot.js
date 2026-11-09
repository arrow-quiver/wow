// Loot: the loot list for each instance (by boss, with Wowhead tooltips), my reserve bonuses, the loot history,
// and for officers a paste box to add items ("Boss | Item" lines) and a way to remove them.
// Shapes: docs/api/raids.md (GET /api/loot).
import { html, useState, useEffect, useMemo } from '../lib/html.js';
import { api, useApi, useAction } from '../lib/api.js';
import { useSession } from '../lib/session.js';
import { setQuery, Link } from '../lib/router.js';
import { plural } from '../lib/format.js';
import {
  Page, Card, Table, Button, ConfirmButton, Input, Textarea, Pill, Tabs, Empty, Async, ItemLink, TimeAgo, tabPanelId, tabId,
} from '../components/index.js';
import { ShareHint } from '../components/ShareHint.js';
import { groupByBoss, AwardHow } from './raid.js';

// ?instance=<name> picks that list; &add=1 also opens the officers' "Add items" form for it.
export default function LootPage({ query = {} }) {
  const { isOfficer } = useSession();
  const q = useApi('/api/loot', { refreshOn: ['raid'] });
  const [adding, setAdding] = useState(query.add === '1');
  useEffect(() => { if (query.add === '1') setAdding(true); }, [query.add]);

  return html`<${Page} title="Loot"
      lede="Loot lists for each instance, your reserve bonuses, and everything the guild has handed out."
      actions=${isOfficer ? html`<${Button} icon="plus" onClick=${() => setAdding((v) => !v)}>Add items<//>` : null}>
    <${Async} q=${q} loadingLabel="Loading loot…">${(data) => html`
      <div class="cols loot-cols">
        <div class="stack stack--loose">
          <${ListsCard} lists=${data.lists} focus=${query.instance} isOfficer=${isOfficer} onChanged=${q.reload}
            onAdd=${() => setAdding(true)} />
          <${HistoryCard} history=${data.history} />
        </div>
        <div class="stack stack--loose">
          ${isOfficer && (adding || !data.lists.length)
            ? html`<${AddItemsCard} lists=${data.lists} focus=${query.instance} onAdded=${(instance) => { q.reload(); setQuery({ instance }); }}
                onClose=${data.lists.length ? () => { setAdding(false); if (query.add) setQuery({ add: undefined }); } : null} />`
            : null}
          <${BonusesCard} rows=${data.myLoyalty} />
        </div>
      </div>
    `}<//>
  <//>`;
}

// ---------- loot lists ----------

function ListsCard({ lists, focus, isOfficer, onChanged, onAdd }) {
  const names = lists.map((l) => l.instance);
  const current = names.includes(focus) ? focus : names[0];
  const list = lists.find((l) => l.instance === current);
  const groups = useMemo(() => (list ? groupByBoss(list.items) : []), [list]);
  const remove = useAction((item) => api.del(`/api/loot/items/${item.id}`), { success: (r) => r.message });

  if (!lists.length) {
    return html`<${Card} title="Loot lists">
      <${Empty} icon="loot" title="No loot lists yet."
        action=${isOfficer ? html`<${Button} variant="primary" icon="plus" onClick=${onAdd}>Add items<//>` : null}>
        ${isOfficer ? 'Paste the items for an instance, one per line, so raiders can reserve them.' : 'Officers add the items for each instance here.'}
      <//>
    <//>`;
  }
  // Tab ids must be safe for CSS selectors, so use the list's position rather than its name.
  const idOf = (name) => `i${names.indexOf(name)}`;
  return html`<${Card} title="Loot lists" sub=${plural(lists.length, 'instance')} class="loot-lists">
    <${Tabs} label="Instances" idPrefix="loot" value=${idOf(current)}
      tabs=${lists.map((l) => ({ id: idOf(l.instance), label: l.instance, count: l.items.length }))}
      onChange=${(id) => setQuery({ instance: names[Number(id.slice(1))] })} />
    <div role="tabpanel" id=${tabPanelId(idOf(current), 'loot')} aria-labelledby=${tabId(idOf(current), 'loot')} class="loot-panel">
      <div class="loot-bosses">
        ${groups.map((g) => html`<section key=${g.boss} class="loot-boss">
          <h3 class="loot-boss-name">${g.boss} <span class="muted small">${g.items.length}</span></h3>
          <ul class="loot-items">
            ${g.items.map((it) => html`<li key=${it.id} class="loot-item">
              <${ItemLink} id=${it.wh_id} name=${it.name} />
              ${isOfficer ? html`<${ConfirmButton} variant="ghost" size="sm" icon="trash" label=${`Remove ${it.name}`} question="Remove?" yes="Remove"
                  class="loot-remove" onConfirm=${async () => { if ((await remove.run(it)).ok) onChanged(); }} />` : null}
            </li>`)}
          </ul>
        </section>`)}
      </div>
    </div>
  <//>`;
}

function AddItemsCard({ lists, focus, onAdded, onClose }) {
  const [instance, setInstance] = useState(focus || '');
  const [text, setText] = useState('');
  useEffect(() => { if (focus) setInstance(focus); }, [focus]);
  const add = useAction((body) => api.post('/api/loot/items', body), { success: (r) => r.message });
  const submit = async (e) => {
    e.preventDefault();
    const r = await add.run({ instance: instance.trim(), text });
    if (r.ok) { setText(''); onAdded(r.value.instance); }
  };
  return html`<${Card} title="Add items" tone="accent"
      actions=${onClose ? html`<${Button} variant="ghost" size="sm" icon="close" label="Close" onClick=${onClose} />` : null}>
    <form class="stack" onSubmit=${submit}>
      <${Input} label="Instance" value=${instance} onValue=${setInstance} list="loot-instances" maxLength="60" required placeholder="Molten Core" />
      <datalist id="loot-instances">${lists.map((l) => html`<option key=${l.instance} value=${l.instance} />`)}</datalist>
      <${Textarea} label="Items" value=${text} onValue=${setText} rows="8" required class="loot-paste"
        placeholder=${'Lucifron | Felheart Gloves | 16805\nMagmadar | Striker\'s Mark\nCore Leather'}
        hint="One item per line. Put the boss first if you like: Boss | Item. Add | 12345 or a Wowhead link at the end for hover tooltips." />
      <div class="form-actions">
        <${Button} type="submit" variant="primary" busy=${add.busy} disabled=${!instance.trim() || !text.trim()}>Add items<//>
      </div>
      <${ShareHint} officer />
    </form>
  <//>`;
}

// ---------- my bonuses ----------

function BonusesCard({ rows }) {
  return html`<${Card} title="Your reserve bonuses">
    ${rows.length
      ? html`<ul class="list-lines loot-bonuses">${rows.map((r) => html`<li key=${r.item_id} class="row row--between nowrap">
          <span class="stack stack--tight loot-bonus-name">
            <${ItemLink} id=${r.wh_id} name=${r.name} />
            <span class="muted small">${r.instance}${r.boss ? ` · ${r.boss}` : ''}</span>
          </span>
          <${Pill} kind="accent">+${r.bonus}<//>
        </li>`)}</ul>`
      : html`<p class="muted">None yet. Reserve an item and attend: each raid adds +10 until you win it.</p>`}
  <//>`;
}

// ---------- history ----------

function HistoryCard({ history }) {
  const columns = [
    { key: 'item_name', label: 'Item', sortable: true, render: (h) => html`<${ItemLink} id=${h.wh_id} name=${h.item_name} />` },
    { key: 'character', label: 'To', sortable: true, render: (h) => h.character || html`<span class="muted">?</span>` },
    { key: 'kind', label: 'How', sortable: true, render: (h) => html`<${AwardHow} a=${h} />` },
    { key: 'title', label: 'Raid', sortable: true, render: (h) => (h.raid_id ? html`<${Link} href=${`/raids/${h.raid_id}`}>${h.title || 'Raid'}<//>` : html`<span class="muted">—</span>`) },
    { key: 'created_at', label: 'When', sortable: true, render: (h) => html`<${TimeAgo} t=${h.created_at} />` },
  ];
  return html`<${Card} title="Loot history" sub=${history.length ? `last ${history.length}` : null} flush>
    <${Table} columns=${columns} rows=${history} dense empty="Nothing handed out yet." />
  <//>`;
}
