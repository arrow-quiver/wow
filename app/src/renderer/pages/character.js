// Character: class, level, race and guild rank; professions with skill bars; recipes by profession (searchable);
// raid readiness (item level, repair, consumables); PvP, reputations and currencies; the player's other characters.
// Your own characters get "Make this my main". Data: GET /api/characters/:name (docs/api/community.md).
import { html, useState, useMemo, useEffect } from '../lib/html.js';
import { api, useApi, useAction } from '../lib/api.js';
import { Link } from '../lib/router.js';
import { classColor, className, number } from '../lib/format.js';
import {
  Page, Card, Button, Input, Tabs, Pill, Progress, Empty, Async, ClassName, SpellLink, Money, TimeAgo, Stat,
} from '../components/index.js';

const shortTag = (bt) => String(bt || '').split('#')[0];
const STANDING = ['', 'Hated', 'Hostile', 'Unfriendly', 'Neutral', 'Friendly', 'Honored', 'Revered', 'Exalted'];
const CONSUMABLE_LABEL = { flask: 'Flasks', elixir: 'Elixirs', potion: 'Potions', food: 'Food', bandage: 'Bandages', other: 'Other' };

export default function CharacterPage({ params = {} }) {
  const name = params.name || '';
  const q = useApi(name ? `/api/characters/${encodeURIComponent(name)}` : null, { refreshOn: [] });
  const c = q.data && q.data.character;
  const makeMain = useAction(() => api.post(`/api/characters/${encodeURIComponent(c.name)}/main`), { success: (r) => r.message });
  const actions = q.data && q.data.canMakeMain
    ? html`<${Button} variant="primary" size="sm" icon="check" busy=${makeMain.busy}
        onClick=${async () => { if ((await makeMain.run()).ok) q.reload(); }}>Make this my main<//>`
    : null;
  const missing = q.error && q.error.status === 404 && !q.data;
  return html`<${Page} title=${c ? c.name : name || 'Character'} back="/roster" actions=${actions}>
    ${missing
      ? html`<${Empty} icon="character" title=${`${name} isn't on the guild roster yet.`}
          action=${html`<${Button} href="/roster" icon="roster">Back to the roster<//>`}>
          Characters show up after your addon reads the guild roster in game, or once their player shares them with Guild Camp.
        <//>`
      : html`<${Async} q=${q} loadingLabel="Looking up the character…" errorTitle="Couldn't open this character.">
          ${(d) => html`<${CharacterBody} d=${d} />`}
        <//>`}
  <//>`;
}

function CharacterBody({ d }) {
  const c = d.character;
  const x = c.extras || {};
  return html`
    <${Header} c=${c} alts=${d.alts} isMine=${d.isMine} />
    <div class="grid-2 character-top">
      <${ReadinessCard} r=${c.readiness} />
      <${ProfessionsCard} profs=${d.professions} />
    </div>
    <${RecipesCard} recipes=${d.recipes} />
    ${x.pvp || (x.reputations && x.reputations.length) || (x.currencies && x.currencies.length)
      ? html`<div class="grid-3 character-extras">
          <${PvpCard} p=${x.pvp} />
          <${RepsCard} reps=${x.reputations || []} />
          <${CurrencyCard} list=${x.currencies || []} />
        </div>`
      : html`<p class="hint">PvP rank, reputations and currencies show here once this character syncs with addon 0.5 or newer.</p>`}`;
}

// ---------- header ----------

function Header({ c, alts, isMine }) {
  const facts = [
    c.rank ? html`<${Pill} kind="info">${c.rank}<//>` : null,
    // Only an alt when the player has picked a main among their other characters.
    c.is_main ? html`<${Pill} kind="accent">Main<//>` : alts.some((a) => a.is_main) ? html`<${Pill} kind="muted">Alt<//>` : null,
    c.is_bank ? html`<${Pill} kind="info">Bank character<//>` : null,
    c.online ? html`<${Pill} kind="ok" dot>Online<//>` : c.last_seen ? html`<span class="muted">Seen <${TimeAgo} t=${c.last_seen} /></span>` : null,
  ].filter(Boolean);
  return html`<${Card} class="character-head">
    <div class="character-hero" style=${`--cc:${classColor(c.class)}`}>
      <div class="character-crest" aria-hidden="true">${c.name.slice(0, 2)}</div>
      <div class="character-id">
        <h2 class="character-name">${c.name}</h2>
        <p class="character-line">
          Level ${c.level ?? '?'} ${c.race || ''} ${className(c.class)}${c.zone ? html`<span class="muted">, ${c.online ? 'in' : 'last in'} ${c.zone}</span>` : null}
        </p>
        <div class="row">${facts}</div>
      </div>
      <dl class="character-meta">
        <div><dt>Player</dt><dd>${c.battletag ? html`<span title=${c.battletag}>${shortTag(c.battletag)}${isMine ? ' (you)' : ''}</span>` : html`<span class="faint" title="This player doesn't use Guild Camp, or hasn't shared with you yet">not known</span>`}</dd></div>
        ${c.faction ? html`<div><dt>Faction</dt><dd>${c.faction}</dd></div>` : null}
        ${isMine && c.money != null ? html`<div><dt>Gold</dt><dd><${Money} copper=${c.money} /></dd></div>` : null}
        ${c.updated_at ? html`<div><dt>Synced</dt><dd><${TimeAgo} t=${c.updated_at} /></dd></div>` : null}
      </dl>
    </div>
    ${alts.length ? html`<div class="row character-alts">
      <span class="muted small">Same player:</span>
      ${alts.map((a) => html`<span key=${a.name} class="character-alt">
        <${ClassName} name=${a.name} cls=${a.class} /> <span class="muted small">${a.level ?? ''}</span>
        ${a.is_main ? html` <${Pill} kind="accent">Main<//>` : null}
      </span>`)}
    </div>` : null}
  <//>`;
}

// ---------- readiness ----------

function ReadinessCard({ r }) {
  if (!r) {
    return html`<${Card} title="Raid readiness">
      <${Empty} compact icon="shield" title="No readiness yet. The addon records it at each /reload." />
    <//>`;
  }
  const cons = Object.entries(r.consumables || {}).filter(([, n]) => n);
  const lowRepair = r.durability != null && r.durability < 30;
  return html`<${Card} title="Raid readiness" sub=${r.at ? html`as of <${TimeAgo} t=${r.at} />` : null}>
    <div class="stack">
      <div class="row character-ready-stats">
        <${Stat} label="Item level" value=${r.ilvl ? Math.round(r.ilvl) : '?'} />
        <div class="character-repair">
          <${Progress} value=${r.durability ?? 0} max=${100} label="Repair" valueText=${r.durability != null ? `${Math.round(r.durability)}%` : 'unknown'}
            kind=${lowRepair ? 'alarm' : 'ok'} />
          ${lowRepair ? html`<span class="warn-text small">Needs repairs before the raid.</span>` : null}
        </div>
      </div>
      <div>
        <h3 class="character-sub">Consumables in bags</h3>
        ${cons.length
          ? html`<div class="row">${cons.map(([k, n]) => html`<${Pill} key=${k} kind="muted">${n} ${(CONSUMABLE_LABEL[k] || k).toLowerCase()}<//>`)}</div>`
          : html`<span class="warn-text small">No consumables.</span>`}
      </div>
    </div>
  <//>`;
}

// ---------- professions and recipes ----------

function ProfessionsCard({ profs }) {
  return html`<${Card} title="Professions">
    ${profs.length
      ? html`<div class="stack">
          ${profs.map((p) => html`<${Progress} key=${p.name} value=${p.skill || 0} max=${p.max_skill || 300} label=${p.name}
            valueText=${`${p.skill ?? '?'} / ${p.max_skill ?? '?'}`} />`)}
        </div>`
      : html`<${Empty} compact icon="crafters" title="No professions synced. Open each profession window once in game, then /reload." />`}
  <//>`;
}

function RecipesCard({ recipes }) {
  const groups = useMemo(() => {
    const m = new Map();
    for (const r of recipes) {
      if (!m.has(r.profession)) m.set(r.profession, []);
      m.get(r.profession).push(r);
    }
    return m;
  }, [recipes]);
  const profs = [...groups.keys()];
  const [tab, setTab] = useState(profs[0] || '');
  const [filter, setFilter] = useState('');
  useEffect(() => { if (!groups.has(tab)) setTab(profs[0] || ''); }, [groups]);
  const needle = filter.trim().toLowerCase();
  const shown = (groups.get(tab) || []).filter((r) => !needle || r.name.toLowerCase().includes(needle));

  if (!recipes.length) {
    return html`<${Card} title="Recipes">
      <${Empty} compact icon="crafters" title="No recipes synced. Open each profession window once in game, then /reload." />
    <//>`;
  }
  return html`<${Card} title="Recipes" sub=${`${number(recipes.length)} known`}
      actions=${html`<${Input} type="search" placeholder="Search recipes" aria-label="Search recipes" value=${filter} onValue=${setFilter} class="character-recipe-search" />`}>
    <div class="stack">
      <${Tabs} tabs=${profs.map((p) => ({ id: p, label: p, count: groups.get(p).length }))} value=${tab} onChange=${setTab}
        label="Professions" idPrefix="recipes" />
      ${shown.length
        ? html`<ul class="character-recipes" role="tabpanel">
            ${shown.map((r) => html`<li key=${r.name}><${SpellLink} id=${r.recipe_id} name=${r.name} /></li>`)}
          </ul>`
        : html`<${Empty} compact icon="search" title=${`No ${tab} recipes match "${filter.trim()}".`} />`}
      <p class="hint mb-0">Looking for someone to craft something? <${Link} href="/crafters">Search every crafter in the guild<//>.</p>
    </div>
  <//>`;
}

// ---------- PvP, reputations, currencies ----------

function PvpCard({ p }) {
  if (!p) return html`<${Card} title="PvP"><p class="muted mb-0">No PvP data yet.</p><//>`;
  const facts = [
    p.rankName ? ['Rank', html`<strong>${p.rankName}</strong>${p.rank ? html` <span class="muted">(${p.rank})</span>` : null}`] : null,
    p.highestRank ? ['Highest rank', p.highestRank] : null,
    p.honor != null ? ['Honor', number(p.honor)] : null,
    p.honorLevel ? ['Honor level', p.honorLevel] : null,
    p.hk != null ? ['Honorable kills', number(p.hk)] : null,
    p.weekHk != null ? ['This week', `${number(p.weekHk)} kills${p.weekContribution ? `, ${number(p.weekContribution)} honor` : ''}`] : null,
    p.lastWeekRank ? ["Last week's standing", p.lastWeekRank] : null,
  ].filter(Boolean);
  return html`<${Card} title="PvP">
    <dl class="character-facts">${facts.map(([k, v]) => html`<div key=${k}><dt>${k}</dt><dd>${v}</dd></div>`)}</dl>
  <//>`;
}

function RepsCard({ reps }) {
  // Same filter as the old site: skip plain Neutral factions with no progress.
  const shown = reps.filter((r) => (r.standing && r.standing !== 4) || r.value);
  return html`<${Card} title="Reputations" sub=${shown.length ? `${shown.length}` : null}>
    ${shown.length
      ? html`<ul class="list-lines character-reps">
          ${shown.map((r) => {
            const pct = r.max ? Math.max(0, Math.min(100, Math.round((r.value / r.max) * 100))) : null;
            return html`<li key=${r.name}>
              <div class="row nowrap"><strong class="ellipsis">${r.name}</strong><span class="spacer"></span><span class="muted small nowrap">${STANDING[r.standing] || ''}</span></div>
              ${pct != null ? html`<${Progress} value=${pct} size="sm" label=${`${r.name}: ${pct}% to the next standing`} />` : null}
            </li>`;
          })}
        </ul>`
      : html`<p class="muted mb-0">No reputations synced yet.</p>`}
  <//>`;
}

function CurrencyCard({ list }) {
  return html`<${Card} title="Currencies">
    ${list.length
      ? html`<ul class="list-lines">
          ${list.map((cc) => html`<li key=${cc.name} class="row nowrap">
            <span class="ellipsis">${cc.name}</span><span class="spacer"></span>
            <strong class="num">${number(cc.qty)}</strong>${cc.max ? html`<span class="muted small nowrap"> of ${number(cc.max)}</span>` : null}
          </li>`)}
        </ul>`
      : html`<p class="muted mb-0">No currencies synced yet.</p>`}
  <//>`;
}
