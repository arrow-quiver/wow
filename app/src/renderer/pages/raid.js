// One raid (or PvP premade / guild event): when and where, my sign-up, my soft reserves, who's coming with
// their readiness, the reserve list, loot given out, and the raid leader's tools (lock, cancel, close).
// Shapes: docs/api/raids.md (GET /api/raids/:id).
import { html, useState, useEffect, useMemo } from '../lib/html.js';
import { api, useApi, useAction } from '../lib/api.js';
import { plural } from '../lib/format.js';
import {
  Page, Card, Table, Button, ConfirmButton, CopyButton, Modal, Input, Select, Checkbox, Pill, Notice, Empty, ErrorBox,
  Loading, ClassName, ItemLink, LocalTime, TimeAgo, Icon, useNow, toast,
} from '../components/index.js';
import {
  KIND_LABEL, STATUS_LABEL, STATUS_PILL, ROLE_LABEL, ROLE_PLURAL, ROLES, AWARD_LABEL,
  KindPill, StatePill, RoleCounts, countdown, durationLabel,
} from './raids.js';

const OTHER_BOSS = 'Trash and other';

// Loot list items grouped by boss, in list order, with items without a boss last.
export function groupByBoss(items) {
  const groups = new Map();
  for (const it of items) {
    const key = it.boss || OTHER_BOSS;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }
  const out = [...groups].map(([boss, list]) => ({ boss, items: list }));
  out.sort((a, b) => (a.boss === OTHER_BOSS) - (b.boss === OTHER_BOSS));
  return out;
}

// "Night Cloak: Mokra (+20), Velanne" per line, for pasting into raid chat.
export function boardText(board) {
  return board.map((b) => `${b.item}: ${b.reservers.map((r) => `${r.character || r.name}${r.bonus ? ` (+${r.bonus})` : ''}`).join(', ')}`).join('\n');
}

export default function RaidPage({ params }) {
  const q = useApi(`/api/raids/${encodeURIComponent(params.id)}`, { refreshOn: ['raid'] });
  const d = q.data;

  if (q.error && !d) {
    return html`<${Page} title="Raid">
      <${ErrorBox} error=${q.error} title=${q.error.status === 404 ? 'That raid was not found.' : undefined} onRetry=${q.error.status === 404 ? undefined : q.reload}>
        <div><${Button} size="sm" icon="back" href="/raids">All raids<//></div>
      <//>
    <//>`;
  }
  if (!d) return html`<${Page} title="Raid"><${Loading} label="Loading the raid…" /><//>`;
  const raid = d.raid;
  // The loot screen is for raids (PvP premades and guild events have no loot to hand out).
  const officerOpen = d.isOfficer && (raid.kind || 'raid') === 'raid' && (raid.status === 'open' || raid.status === 'locked');

  return html`<${Page} title=${raid.title}
      actions=${officerOpen ? html`<${Button} variant="primary" icon="loot" href=${`/raids/${raid.id}/loot`}>Loot screen<//>` : null}>
    <${RaidHero} d=${d} />
    <div class="cols raid-cols">
      <div class="stack stack--loose">
        <${ReservesCard} d=${d} onSaved=${q.reload} />
        <${RosterCard} d=${d} />
        <${BoardCard} board=${d.board} />
        <${LootGivenCard} loot=${d.loot} />
      </div>
      <div class="stack stack--loose">
        <${SignupCard} d=${d} onSaved=${q.reload} />
        ${d.isOfficer ? html`<${LeaderCard} d=${d} onChanged=${q.reload} />` : null}
      </div>
    </div>
  <//>`;
}

// ---------- header ----------

function RaidHero({ d }) {
  const { raid, counts } = d;
  const now = useNow();
  const left = raid.status === 'cancelled' || raid.status === 'done' ? '' : countdown(raid.starts_at, now);
  const facts = [
    raid.instance,
    raid.size ? `${raid.size} players` : null,
    durationLabel(raid.duration_min),
    raid.scheduledBy ? `Scheduled by ${raid.scheduledBy}` : null,
  ].filter(Boolean);
  return html`<${Card} class=${`raid-hero${raid.status === 'cancelled' ? ' is-cancelled' : ''}`} tone=${raid.status === 'cancelled' ? 'alarm' : 'accent'}>
    <div class="raid-hero-grid">
      <div class="raid-hero-main">
        <div class="row"><${KindPill} kind=${raid.kind} /><${StatePill} raid=${raid} /></div>
        <h1 class="raid-hero-title">${raid.title}</h1>
        <p class="raid-hero-when">
          <${Icon} name="raids" />
          <${LocalTime} t=${raid.starts_at} style="long" />
          ${left ? html`<span class="raid-hero-left">${left}</span>` : null}
        </p>
        <p class="raid-hero-facts">${facts.join(' · ')}</p>
        ${raid.notes ? html`<p class="raid-hero-notes">${raid.notes}</p>` : null}
      </div>
      <div class="raid-hero-side">
        <div class="raid-stats">
          ${ROLES.map((r) => html`<div key=${r} class="raid-stat">
            <span class="raid-stat-value num">${counts[r]}</span><span class="raid-stat-label">${ROLE_PLURAL[r]}</span>
          </div>`)}
          <div class="raid-stat"><span class="raid-stat-value num">${counts.tentative}</span><span class="raid-stat-label">Maybe</span></div>
          <div class="raid-stat"><span class="raid-stat-value num">${counts.bench}</span><span class="raid-stat-label">Bench</span></div>
        </div>
        <${RoleCounts} counts=${counts} size=${raid.size} chips=${false} />
      </div>
    </div>
  <//>`;
}

// ---------- my sign-up ----------

function Segmented({ label, options, value, onValue, disabled, columns }) {
  return html`<fieldset class="raid-seg-field" disabled=${disabled}>
    <legend class="field-label">${label}</legend>
    <div class="raid-seg" style=${columns ? `grid-template-columns: repeat(${columns}, minmax(0, 1fr))` : undefined}>
      ${options.map((o) => html`<label key=${o.value} class=${`raid-seg-opt${String(value) === String(o.value) ? ' is-on' : ''}`}>
        <input type="radio" name=${label} value=${o.value} checked=${String(value) === String(o.value)} onChange=${() => onValue(o.value)} />
        <span>${o.label}</span>
      </label>`)}
    </div>
  </fieldset>`;
}

const ROLE_OPTIONS = ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r] }));
const STATUS_OPTIONS = ['yes', 'tentative', 'bench', 'no'].map((s) => ({ value: s, label: STATUS_LABEL[s] }));

function SignupCard({ d, onSaved }) {
  const { raid, mySignup, myCharacters } = d;
  const initial = () => ({
    character: mySignup?.character || myCharacters[0]?.name || '',
    role: mySignup?.role || 'dps',
    status: mySignup?.status || 'yes',
    note: mySignup?.note || '',
  });
  const [f, setF] = useState(initial);
  const key = mySignup ? `${mySignup.character}|${mySignup.role}|${mySignup.status}|${mySignup.note || ''}` : '';
  useEffect(() => { setF(initial()); }, [key, myCharacters.length]);
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v }));
  const save = useAction((body) => api.post(`/api/raids/${raid.id}/signup`, body), { success: (r) => r.message });

  if (!d.canSignUp) {
    return html`<${Card} title="Your sign-up">
      ${mySignup
        ? html`<p class="row"><${ClassName} name=${mySignup.character} cls=${mySignup.class} /> <${Pill} kind=${STATUS_PILL[mySignup.status]}>${STATUS_LABEL[mySignup.status]}<//>
            <span class="muted">${ROLE_LABEL[mySignup.role]}</span></p>`
        : html`<p class="muted">You didn’t sign up.</p>`}
      <p class="hint">${raid.status === 'cancelled' ? 'This was cancelled.' : 'Sign-ups are closed.'}</p>
    <//>`;
  }

  const submit = async (e) => {
    e.preventDefault();
    if (!f.character.trim()) { toast('Pick a character.', 'warn'); return; }
    const r = await save.run({ character: f.character.trim(), role: f.role, status: f.status, note: f.note.trim() });
    if (r.ok) onSaved();
  };
  const chars = myCharacters.map((c) => ({ value: c.name, label: `${c.name}${c.level ? ` (${c.level})` : ''}` }));
  if (f.character && !chars.some((c) => c.value === f.character)) chars.unshift({ value: f.character, label: f.character });

  return html`<${Card} title=${mySignup ? 'Your sign-up' : 'Sign up'} tone=${mySignup ? undefined : 'accent'}
      actions=${mySignup ? html`<${Pill} kind=${STATUS_PILL[mySignup.status]}>${STATUS_LABEL[mySignup.status]}<//>` : null}>
    <form class="stack raid-signup" onSubmit=${submit}>
      ${chars.length
        ? html`<${Select} label="Character" value=${f.character} options=${chars} onValue=${set('character')} />`
        : html`<${Input} label="Character" value=${f.character} onValue=${set('character')} maxLength="40" required
            hint="Your characters show up here once the addon has synced." />`}
      <${Segmented} label="Role" options=${ROLE_OPTIONS} value=${f.role} onValue=${set('role')} columns=${3} />
      <${Segmented} label="Coming?" options=${STATUS_OPTIONS} value=${f.status} onValue=${set('status')} columns=${2} />
      <${Input} label="Note" value=${f.note} onValue=${set('note')} maxLength="120" placeholder="Might be 15 min late" />
      <${Button} type="submit" variant="primary" busy=${save.busy} block>${mySignup ? 'Update sign-up' : 'Sign up'}<//>
    </form>
  <//>`;
}

// ---------- soft reserves ----------

function ReservesCard({ d, onSaved }) {
  const { raid, items } = d;
  const idsKey = (ids) => [...ids].sort((a, b) => a - b).join(',');
  const mineKey = idsKey(items.filter((i) => i.mine).map((i) => i.id));
  const [picked, setPicked] = useState(() => new Set(items.filter((i) => i.mine).map((i) => i.id)));
  useEffect(() => { setPicked(new Set(items.filter((i) => i.mine).map((i) => i.id))); }, [mineKey]);
  const groups = useMemo(() => groupByBoss(items), [items]);
  const save = useAction((ids) => api.post(`/api/raids/${raid.id}/reserves`, { item_ids: ids }), { success: (r) => r.message });

  if ((raid.kind || 'raid') !== 'raid') return null;
  const limit = raid.sr_limit;
  const title = 'Soft reserves';
  if (!items.length) {
    return html`<${Card} title=${title}>
      <${Empty} icon="loot" title=${`No loot list for ${raid.instance} yet.`}
        action=${d.isOfficer ? html`<${Button} icon="plus" href=${`/loot?instance=${encodeURIComponent(raid.instance)}&add=1`}>Add the items<//>` : null}>
        ${d.isOfficer ? 'Add the items so people can reserve.' : 'An officer needs to add it before anyone can reserve.'}
      <//>
    <//>`;
  }
  if (!limit) {
    return html`<${Card} title=${title}><${Notice} kind="info">This raid has no reserves. Everything is open roll.<//><//>`;
  }
  // Finished or cancelled: just my picks (the reserve list below shows everyone's).
  if (raid.status === 'done' || raid.status === 'cancelled') {
    return html`<${Card} title="Your reserves">
      ${d.myReserves.length
        ? html`<ul class="list-lines">${d.myReserves.map((r) => html`<li key=${r.id} class="row row--between nowrap">
            <span class="row nowrap"><${ItemLink} id=${r.wh_id} name=${r.name} />${r.boss ? html`<span class="muted small">${r.boss}</span>` : null}</span>
            ${r.bonus ? html`<${Pill} kind="accent" title="Your loyalty bonus for this item now">+${r.bonus}<//>` : null}
          </li>`)}</ul>`
        : html`<p class="muted">${raid.status === 'done' ? 'No open reserves. Anything you won is under “Loot given out”.' : 'You hadn’t reserved anything.'}</p>`}
    <//>`;
  }

  const editable = d.canReserve;
  const changed = idsKey(picked) !== mineKey;
  const toggle = (id, on) => setPicked((s) => {
    const next = new Set(s);
    if (on) next.add(id); else next.delete(id);
    return next;
  });
  const submit = async () => {
    const r = await save.run([...picked]);
    if (r.ok) onSaved();
  };
  const full = picked.size >= limit;

  return html`<${Card} title=${title} sub=${`${picked.size} of ${limit} picked`}
      footer=${editable ? html`<div class="row row--between">
        <span>Your bonus grows by +10 every raid you attend with the same item reserved. It resets when you win it.</span>
        <div class="actions-row">
          ${picked.size ? html`<${Button} variant="ghost" size="sm" onClick=${() => setPicked(new Set())}>Clear<//>` : null}
          <${Button} variant="primary" busy=${save.busy} disabled=${!changed} onClick=${submit}>Save reserves<//>
        </div>
      </div>` : null}>
    ${!editable ? html`<${Notice} kind="warn" class="raid-reserves-locked">${raid.status === 'locked' ? 'Reserves are locked. Your picks are shown below.' : 'Reserves are closed for this raid.'}<//>` : null}
    <p class="hint">Pick up to ${plural(limit, 'item')}. When one drops, everyone who reserved it rolls and adds their bonus.</p>
    <div class="raid-bosses">
      ${groups.map((g) => html`<fieldset key=${g.boss} class="raid-boss">
        <legend>${g.boss}</legend>
        ${g.items.map((it) => {
          const on = picked.has(it.id);
          return html`<label key=${it.id} class=${`raid-item${on ? ' is-on' : ''}${!editable || (!on && full) ? ' is-disabled' : ''}`}>
            <input type="checkbox" checked=${on} disabled=${!editable || (!on && full)} onChange=${(e) => toggle(it.id, e.currentTarget.checked)} />
            <span class="raid-item-name"><${ItemLink} id=${it.wh_id} name=${it.name} hover /></span>
            ${it.bonus ? html`<${Pill} kind="accent" title="Your loyalty bonus for this item">+${it.bonus}<//>` : null}
            ${it.reserved ? html`<span class="raid-item-count" title="People who reserved it for this raid">${it.reserved}</span>` : null}
          </label>`;
        })}
      </fieldset>`)}
    </div>
  <//>`;
}

// ---------- who's coming ----------

function consumablesText(c) {
  const parts = Object.entries(c || {}).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`);
  return parts.join(', ');
}

function RosterCard({ d }) {
  const { signups, counts } = d;
  const coming = signups.filter((s) => s.status !== 'no');
  const notComing = signups.filter((s) => s.status === 'no');
  const attended = new Set(d.attended || []);
  const done = d.raid.status === 'done';
  const columns = [
    {
      key: 'character', label: 'Character', width: '34%',
      render: (s) => html`<span class="row">
        <${ClassName} name=${s.character} cls=${s.class} />
        ${s.level ? html`<span class="muted small">${s.level}</span>` : null}
        ${s.status !== 'yes' ? html`<${Pill} kind=${STATUS_PILL[s.status]}>${STATUS_LABEL[s.status]}<//>` : null}
        ${s.mine ? html`<${Pill} kind="accent">You<//>` : null}
        ${done && attended.has(s.user_id) ? html`<${Pill} kind="ok" title="Marked as there when the raid was closed">Attended<//>` : null}
      </span>`,
    },
    {
      key: 'ilvl', label: 'Item level', num: true, width: '13%',
      render: (s) => (s.flags.noData ? html`<span class="muted small">No addon data</span>` : s.readiness.ilvl ? Math.round(s.readiness.ilvl) : '—'),
    },
    {
      key: 'repair', label: 'Repair', num: true, width: '10%',
      render: (s) => (s.flags.noData || s.readiness.durability == null ? html`<span class="muted">—</span>`
        : s.flags.lowRepair ? html`<${Pill} kind="warn" title="Needs a repair">${Math.round(s.readiness.durability)}%<//>` : `${Math.round(s.readiness.durability)}%`),
    },
    {
      key: 'consumables', label: 'Consumables', width: '22%',
      render: (s) => (s.flags.noData ? html`<span class="muted">—</span>`
        : s.flags.noConsumables ? html`<${Pill} kind="warn">None in bags<//>` : html`<span class="small">${consumablesText(s.readiness.consumables)}</span>`),
    },
    {
      key: 'note', label: 'Note',
      render: (s) => html`<span class="raid-note">
        ${s.note ? html`<span class="muted">“${s.note}”</span>` : null}
        ${s.readiness && s.readiness.at ? html`<span class="muted small">checked <${TimeAgo} t=${s.readiness.at} /></span>` : null}
      </span>`,
    },
  ];
  return html`<${Card} title=${done ? 'Who signed up' : 'Who’s coming'}
      sub=${`${plural(counts.tank, 'tank')}, ${plural(counts.healer, 'healer')}, ${counts.dps} damage`}>
    ${coming.length
      ? html`<div class="stack">${ROLES.map((role) => {
          const rows = coming.filter((s) => s.role === role);
          if (!rows.length) return null;
          return html`<section key=${role} class="raid-role-group">
            <h3 class="raid-role-title">${ROLE_PLURAL[role]} <span class="muted small">${rows.length}</span></h3>
            <${Table} class="raid-roster-table" columns=${columns} rows=${rows} rowKey=${(s) => s.user_id} dense rowClass=${(s) => (s.mine ? 'raid-row-mine' : undefined)} />
          </section>`;
        })}</div>`
      : html`<${Empty} compact icon="roster" title=${done || d.raid.status === 'cancelled' ? 'Nobody signed up.' : 'Nobody has signed up yet.'} />`}
    ${notComing.length ? html`<p class="muted small raid-not-coming"><strong>Can’t make it:</strong> ${notComing.map((s) => s.character).join(', ')}</p>` : null}
    <p class="hint">Readiness comes from the addon: item level, repair and consumables in bags at each player’s last reload.</p>
  <//>`;
}

// ---------- reserve list ----------

function BoardCard({ board }) {
  if (!board.length) return null;
  const columns = [
    { key: 'item', label: 'Item', render: (b) => html`<${ItemLink} id=${b.wh_id} name=${b.item} />` },
    { key: 'boss', label: 'Boss', render: (b) => html`<span class="muted">${b.boss || ''}</span>` },
    {
      key: 'reservers', label: 'Reserved by',
      render: (b) => html`<span class="raid-chips">${b.reservers.map((r) => html`<span key=${r.user_id} class=${`raid-chip${r.inRaid ? '' : ' is-out'}`}
          title=${r.inRaid ? undefined : 'Not signed up as coming or bench'}>
        ${r.character || r.name}${r.bonus ? html` <strong>+${r.bonus}</strong>` : null}
      </span>`)}</span>`,
    },
  ];
  return html`<${Card} title="Reserve list" sub=${plural(board.length, 'item')} flush
      actions=${html`<${CopyButton} text=${boardText(board)} label="Copy for raid chat" done="Copied. Paste it into raid chat." />`}>
    <${Table} columns=${columns} rows=${board} rowKey=${(b) => b.item_id} dense />
  <//>`;
}

// ---------- loot given out ----------

export function AwardHow({ a }) {
  return html`<span class="row nowrap">
    <${Pill} kind=${a.kind === 'sr' ? 'accent' : a.kind === 'free' ? 'muted' : 'info'}>${AWARD_LABEL[a.kind] || a.kind}<//>
    ${a.roll != null ? html`<span class="muted small">rolled ${a.roll}${a.bonus ? ` + ${a.bonus}` : ''}</span>` : null}
  </span>`;
}

function LootGivenCard({ loot }) {
  if (!loot.length) return null;
  const columns = [
    { key: 'item_name', label: 'Item', render: (a) => html`<${ItemLink} id=${a.wh_id} name=${a.item_name} />` },
    { key: 'character', label: 'To', render: (a) => a.character || html`<span class="muted">?</span>` },
    { key: 'kind', label: 'How', render: (a) => html`<${AwardHow} a=${a} />` },
  ];
  return html`<${Card} title="Loot given out" sub=${plural(loot.length, 'item')} flush>
    <${Table} columns=${columns} rows=${loot} dense />
  <//>`;
}

// ---------- raid leader ----------

function LeaderCard({ d, onChanged }) {
  const { raid } = d;
  const [closing, setClosing] = useState(false);
  const act = useAction((verb) => api.post(`/api/raids/${raid.id}/${verb}`), { success: (r) => r.message });
  const run = async (verb) => { const r = await act.run(verb); if (r.ok) onChanged(); };
  const isRaid = (raid.kind || 'raid') === 'raid';
  const open = raid.status === 'open' || raid.status === 'locked';

  return html`<${Card} title="Raid leader" class="raid-leader">
    ${open ? html`<div class="stack stack--tight">
      ${isRaid ? html`<${Button} variant="primary" icon="loot" href=${`/raids/${raid.id}/loot`} block>Open loot screen<//>` : null}
      ${isRaid && raid.sr_limit ? (raid.status === 'open'
        ? html`<${Button} icon="shield" busy=${act.busy} onClick=${() => run('lock')} block>Lock reserves<//>`
        : html`<${Button} icon="refresh" busy=${act.busy} onClick=${() => run('unlock')} block>Reopen reserves<//>`) : null}
      <${Button} icon="check" onClick=${() => setClosing(true)} block>Close ${KIND_LABEL[raid.kind] === 'Raid' ? 'raid' : 'and record attendance'}…<//>
      <${ConfirmButton} variant="ghost" size="md" icon="close" question=${`Cancel ${raid.title}?`} yes="Cancel it" no="Keep"
        onConfirm=${() => run('cancel')} class="raid-cancel">Cancel ${KIND_LABEL[raid.kind] === 'Event' ? 'event' : KIND_LABEL[raid.kind] === 'PvP' ? 'premade' : 'raid'}<//>
      <p class="hint">${isRaid && raid.sr_limit ? 'Lock reserves when the raid starts. Sign-ups stay open. ' : ''}Close it afterwards to record who was there${isRaid ? ' and update loyalty bonuses' : ''}.</p>
    </div>` : null}
    ${raid.status === 'done' ? html`<div class="stack stack--tight">
      <p class="muted">This raid is closed.${isRaid ? ' Bonuses were updated.' : ''}</p>
      ${isRaid ? html`<${Button} icon="loot" href=${`/raids/${raid.id}/loot`} block>Record late loot<//>` : null}
    </div>` : null}
    ${raid.status === 'cancelled' ? html`<p class="muted">This was cancelled. Everyone who signed up was told.</p>` : null}
    <${CloseRaidModal} open=${closing} d=${d} onClose=${() => setClosing(false)} onDone=${() => { setClosing(false); onChanged(); }} />
  <//>`;
}

function CloseRaidModal({ open, d, onClose, onDone }) {
  const { raid } = d;
  const people = d.signups.filter((s) => s.status !== 'no');
  const defaults = () => new Set(people.filter((s) => s.status === 'yes' || s.status === 'bench').map((s) => s.user_id));
  const [ticked, setTicked] = useState(defaults);
  useEffect(() => { if (open) setTicked(defaults()); }, [open]);
  const save = useAction((ids) => api.post(`/api/raids/${raid.id}/close`, { attendee_user_ids: ids }), { success: (r) => r.message });
  const toggle = (id, on) => setTicked((s) => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n; });
  const submit = async () => {
    const r = await save.run([...ticked]);
    if (r.ok) onDone();
  };
  const isRaid = (raid.kind || 'raid') === 'raid';

  return html`<${Modal} open=${open} title=${`Close ${raid.title}`} onClose=${onClose} dismissable=${!save.busy}
      footer=${html`
        <span class="muted small raid-close-count">${ticked.size} of ${people.length} ticked</span>
        <${Button} variant="ghost" onClick=${onClose} disabled=${save.busy}>Not yet<//>
        <${Button} variant="primary" busy=${save.busy} onClick=${submit}>${isRaid ? 'Close raid and update bonuses' : 'Close and record attendance'}<//>`}>
    <div class="stack">
      <p>Tick who was there.${isRaid ? ' Attending with a reserve adds +10 to that item’s bonus. Signing up “Coming” and not showing resets it.' : ''} This can’t be undone.</p>
      ${people.length
        ? html`<div class="row raid-close-tools">
            <${Button} size="sm" variant="ghost" onClick=${() => setTicked(new Set(people.map((s) => s.user_id)))}>Tick everyone<//>
            <${Button} size="sm" variant="ghost" onClick=${() => setTicked(new Set())}>Untick everyone<//>
          </div>
          <div class="raid-close-list">
            ${people.map((s) => html`<${Checkbox} key=${s.user_id} checked=${ticked.has(s.user_id)} onValue=${(on) => toggle(s.user_id, on)}
              label=${html`<span class="row nowrap"><${ClassName} name=${s.character} cls=${s.class} link=${false} />
                <span class="muted small">${ROLE_LABEL[s.role]}</span>
                ${s.status !== 'yes' ? html`<${Pill} kind=${STATUS_PILL[s.status]}>${STATUS_LABEL[s.status]}<//>` : null}</span>`} />`)}
          </div>`
        : html`<${Notice} kind="info">Nobody signed up. Closing still marks it as finished.<//>`}
    </div>
  <//>`;
}

