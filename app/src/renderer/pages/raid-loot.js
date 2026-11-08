// The raid leader's loot screen (officers): pick the item that dropped, see who reserved it and their bonus,
// roll (1–100 plus bonus, made here on the raid leader's PC), give it to the winner. Anything else that drops is
// recorded as main spec, off spec or a free roll. Big buttons, so it works on a laptop mid-raid. Awards go to
// guildmates through the addon. Shapes: docs/api/raids.md (GET /api/raids/:id/loot).
import { html, useState, useEffect, useMemo } from '../lib/html.js';
import { api, useApi, useAction } from '../lib/api.js';
import { useSession } from '../lib/session.js';
import { plural } from '../lib/format.js';
import {
  Page, Card, Table, Button, Input, Select, Pill, Notice, Empty, ErrorBox, Loading, ItemLink, TimeAgo,
} from '../components/index.js';
import { ShareHint } from '../components/ShareHint.js';
import { KindPill, StatePill } from './raids.js';
import { AwardHow } from './raid.js';

const OTHER = 'other';
const KIND_OPTIONS = [
  { value: 'ms', label: 'Main spec' },
  { value: 'os', label: 'Off spec' },
  { value: 'free', label: 'Free roll' },
];
const SOMEONE_ELSE = '__someone';

// ?item=<loot item id> (or ?item=other) opens with that item picked.
export default function RaidLootPage({ params, query = {} }) {
  const { isOfficer, loaded } = useSession();
  const id = encodeURIComponent(params.id);
  const q = useApi(isOfficer ? `/api/raids/${id}/loot` : null, { refreshOn: ['raid'] });
  const fromQuery = (v) => (v === OTHER ? OTHER : Number(v) || null);
  const [selected, setSelected] = useState(() => fromQuery(query.item));
  // The page stays mounted when only the query changes (a link to another item on the same raid).
  useEffect(() => { if (query.item) setSelected(fromQuery(query.item)); }, [query.item]);
  const d = q.data;

  // Keep the selection on an item that is still reserved; otherwise pick the first one.
  useEffect(() => {
    if (!d) return;
    const ids = d.board.map((b) => b.item_id);
    if (selected === OTHER) return;
    if (!ids.includes(selected)) setSelected(ids.length ? ids[0] : OTHER);
  }, [d]);

  if (loaded && !isOfficer) {
    return html`<${Page} title="Loot screen">
      <${Notice} kind="info" title="Officers run the loot screen.">You can see reserves and loot given out on the raid page.<//>
      <div><${Button} icon="back" href=${`/raids/${params.id}`}>Back to the raid<//></div>
    <//>`;
  }
  if (q.error && !d) {
    return html`<${Page} title="Loot screen">
      <${ErrorBox} error=${q.error} onRetry=${q.error.status === 404 ? undefined : q.reload}>
        <div><${Button} size="sm" icon="back" href="/raids">All raids<//></div>
      <//>
    <//>`;
  }
  if (!d) return html`<${Page} title="Loot screen"><${Loading} label="Loading the loot screen…" /><//>`;

  const { raid, board } = d;
  const current = board.find((b) => b.item_id === selected) || null;
  const cancelled = raid.status === 'cancelled';

  return html`<${Page} title=${`Loot: ${raid.title}`} width="wide"
      actions=${html`<${Button} icon="raids" href=${`/raids/${raid.id}`}>Raid page<//>`}>
    <div class="row raid-loot-intro">
      <${KindPill} kind=${raid.kind} /><${StatePill} raid=${raid} />
      <span class="muted">Pick the item that dropped. Rolls are 1–100 plus each player’s bonus. Announce the winner in raid chat.</span>
    </div>
    ${cancelled ? html`<${Notice} kind="alarm">This raid was cancelled, so loot can’t be given out here.<//>` : null}
    <div class="raid-loot-layout">
      <${Card} title="Reserved items" sub=${plural(board.length, 'item')} flush class="raid-loot-items">
        ${board.length
          ? html`<ul class="raid-loot-list" role="listbox" aria-label="Reserved items">
              ${board.map((b) => {
                const inRaid = b.reservers.filter((r) => r.inRaid).length;
                return html`<li key=${b.item_id}>
                  <button type="button" role="option" aria-selected=${selected === b.item_id ? 'true' : 'false'}
                      class=${`raid-loot-pick${selected === b.item_id ? ' is-on' : ''}`} onClick=${() => setSelected(b.item_id)}>
                    <span class="raid-loot-pick-name"><${ItemLink} id=${b.wh_id} name=${b.item} hover /></span>
                    <span class="raid-loot-pick-meta">${b.boss ? `${b.boss} · ` : ''}${plural(inRaid, 'reserver')} here${b.reservers.length > inRaid ? `, ${b.reservers.length - inRaid} away` : ''}</span>
                    ${b.rolls.length ? html`<${Pill} kind="info" class="raid-loot-pick-pill">Rolled<//>` : null}
                  </button>
                </li>`;
              })}
            </ul>`
          : html`<${Empty} compact icon="loot" title="No reserved items left." />`}
        <div class="raid-loot-other">
          <button type="button" class=${`raid-loot-pick raid-loot-pick--other${selected === OTHER ? ' is-on' : ''}`} onClick=${() => setSelected(OTHER)}>
            <span class="raid-loot-pick-name">Something else dropped</span>
            <span class="raid-loot-pick-meta">Main spec, off spec or a free roll</span>
          </button>
        </div>
      <//>
      <div class="raid-loot-stage">
        ${current
          ? html`<${ItemStage} key=${current.item_id} raid=${raid} item=${current} attending=${d.attending} disabled=${cancelled} onDone=${q.reload} />`
          : html`<${FreeAward} raid=${raid} items=${d.items} attending=${d.attending} disabled=${cancelled} onDone=${q.reload} />`}
      </div>
    </div>
    <${GivenOut} awarded=${d.awarded} />
    <${ShareHint} officer discord class="raid-loot-share" />
  <//>`;
}

// ---------- a reserved item: reservers, roll, give ----------

function ItemStage({ raid, item, attending, disabled, onDone }) {
  const roll = useAction(() => api.post(`/api/raids/${raid.id}/roll`, { item_id: item.item_id }), { success: (r) => r.message });
  const give = useAction((body) => api.post(`/api/raids/${raid.id}/award`, { item_id: item.item_id, ...body }), { success: (r) => r.message });
  const [other, setOther] = useState({ user: '', kind: 'ms' });
  const doRoll = async () => { if ((await roll.run()).ok) onDone(); };
  const doGive = async (body) => { if ((await give.run(body)).ok) onDone(); };
  const rolls = item.rolls || [];
  const present = item.reservers.filter((r) => r.inRaid);
  const away = item.reservers.filter((r) => !r.inRaid);
  const people = attending.map((a) => ({ value: String(a.user_id), label: a.character }));

  return html`<${Card} class="raid-loot-card">
    <div class="raid-loot-head">
      <div class="raid-loot-item-title"><${ItemLink} id=${item.wh_id} name=${item.item} /></div>
      ${item.boss ? html`<span class="muted">${item.boss}</span>` : null}
    </div>

    <section class="raid-loot-section">
      <h3 class="raid-loot-label">Reserved by</h3>
      <div class="raid-loot-reservers">
        ${present.map((r) => html`<span key=${r.user_id} class="raid-loot-reserver">
          <strong>${r.character || r.name}</strong>${r.bonus ? html`<${Pill} kind="accent">+${r.bonus}<//>` : null}
        </span>`)}
        ${away.map((r) => html`<span key=${r.user_id} class="raid-loot-reserver is-out" title="Not signed up as coming or bench, so they don’t roll">
          ${r.character || r.name}${r.bonus ? ` +${r.bonus}` : ''} <span class="small">(not in raid)</span>
        </span>`)}
        ${!present.length && !away.length ? html`<span class="muted">Nobody</span>` : null}
      </div>
    </section>

    <div class="raid-loot-roll">
      <${Button} size="lg" variant=${rolls.length ? 'secondary' : 'primary'} icon="refresh" busy=${roll.busy} disabled=${disabled || !present.length}
        onClick=${doRoll}>${rolls.length ? 'Roll again' : 'Roll'}<//>
      ${!present.length ? html`<span class="muted">Nobody who reserved it is in the raid. Give it below instead.</span>` : null}
    </div>

    ${rolls.length ? html`<ol class="raid-loot-rolls">
      ${rolls.map((r, i) => html`<li key=${r.user_id} class=${i === 0 ? 'is-top' : ''}>
        <span class="raid-loot-rank">${i + 1}</span>
        <span class="raid-loot-who">${r.character || r.name}</span>
        <span class="raid-loot-math muted">${r.roll}${r.bonus ? ` + ${r.bonus}` : ''}</span>
        <span class="raid-loot-total num">${r.total}</span>
        <${Button} size=${i === 0 ? 'lg' : 'md'} variant=${i === 0 ? 'primary' : 'secondary'} busy=${give.busy} disabled=${disabled}
          onClick=${() => doGive({ user_id: r.user_id, kind: 'sr' })}>Give to ${r.character || r.name}<//>
      </li>`)}
    </ol>` : null}

    <section class="raid-loot-section raid-loot-else">
      <h3 class="raid-loot-label">Give it without a roll</h3>
      <div class="form-row">
        <${Select} label="To" value=${other.user} placeholder="Pick someone" options=${people} onValue=${(v) => setOther((o) => ({ ...o, user: v }))} />
        <${Select} label="As" value=${other.kind} options=${[{ value: 'sr', label: 'Reserve' }, ...KIND_OPTIONS]} onValue=${(v) => setOther((o) => ({ ...o, kind: v }))} />
        <${Button} busy=${give.busy} disabled=${disabled || !other.user} onClick=${() => doGive({ user_id: Number(other.user), kind: other.kind })}>Give<//>
      </div>
    </section>
  <//>`;
}

// ---------- anything else that dropped ----------

function FreeAward({ raid, items, attending, disabled, onDone }) {
  const [f, setF] = useState({ item: '', user: attending[0] ? String(attending[0].user_id) : '', name: '', kind: 'ms' });
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v }));
  const give = useAction((body) => api.post(`/api/raids/${raid.id}/award`, body), { success: (r) => r.message });
  const people = useMemo(() => [...attending.map((a) => ({ value: String(a.user_id), label: a.character })), { value: SOMEONE_ELSE, label: 'Someone else…' }], [attending]);
  const someoneElse = f.user === SOMEONE_ELSE || !attending.length;
  const ready = f.item.trim() && (someoneElse ? f.name.trim() : f.user);

  const submit = async (e) => {
    e.preventDefault();
    if (!ready) return;
    const body = { item_name: f.item.trim(), kind: f.kind };
    if (someoneElse) body.character = f.name.trim(); else body.user_id = Number(f.user);
    const r = await give.run(body);
    if (r.ok) { setF((x) => ({ ...x, item: '', name: '' })); onDone(); }
  };

  return html`<${Card} title="Give an item without reserves" class="raid-loot-card">
    <form class="stack" onSubmit=${submit}>
      <${Input} label="Item" value=${f.item} onValue=${set('item')} list="raid-loot-items" maxLength="100" required
        placeholder=${items[0] ? items[0].name : 'Item name'} hint=${items.length ? `Start typing to pick from the ${raid.instance} loot list, or type any name.` : 'Type the item’s name.'} />
      <datalist id="raid-loot-items">${items.map((i) => html`<option key=${i.id} value=${i.name} />`)}</datalist>
      <div class="form-row">
        ${attending.length ? html`<${Select} label="To" value=${f.user} options=${people} onValue=${set('user')} />` : null}
        ${someoneElse ? html`<${Input} label=${attending.length ? 'Character' : 'To (character)'} value=${f.name} onValue=${set('name')} maxLength="40" required placeholder="Character name" />` : null}
      </div>
      <fieldset class="raid-loot-kinds">
        <legend class="field-label">As</legend>
        <div class="raid-seg" style="grid-template-columns: repeat(3, minmax(0, 1fr))">
          ${KIND_OPTIONS.map((o) => html`<label key=${o.value} class=${`raid-seg-opt raid-seg-opt--lg${f.kind === o.value ? ' is-on' : ''}`}>
            <input type="radio" name="award-kind" value=${o.value} checked=${f.kind === o.value} onChange=${() => set('kind')(o.value)} />
            <span>${o.label}</span>
          </label>`)}
        </div>
      </fieldset>
      <div><${Button} type="submit" size="lg" variant="primary" busy=${give.busy} disabled=${disabled || !ready}>Record it<//></div>
    </form>
  <//>`;
}

// ---------- given out tonight ----------

function GivenOut({ awarded }) {
  const columns = [
    { key: 'item_name', label: 'Item', render: (a) => html`<${ItemLink} id=${a.wh_id} name=${a.item_name} />` },
    { key: 'character', label: 'To', render: (a) => a.character || html`<span class="muted">?</span>` },
    { key: 'kind', label: 'How', render: (a) => html`<${AwardHow} a=${a} />` },
    { key: 'created_at', label: 'When', render: (a) => html`<${TimeAgo} t=${a.created_at} />` },
  ];
  return html`<${Card} title="Given out" sub=${awarded.length ? plural(awarded.length, 'item') : null} flush>
    <${Table} columns=${columns} rows=${awarded} dense empty="Nothing given out yet." />
  <//>`;
}
