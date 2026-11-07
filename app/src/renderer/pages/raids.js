// Raids: what's coming up (one card per raid, PvP premade or guild event), past raids, and the officers'
// "Schedule" form. Shapes: docs/api/raids.md. The labels and small helpers here are shared with raid.js,
// raid-loot.js and loot.js.
import { html, useState, useEffect } from '../lib/html.js';
import { api, useApi, useAction } from '../lib/api.js';
import { useSession } from '../lib/session.js';
import { navigate, setQuery, Link } from '../lib/router.js';
import { fromLocalInput, parseTime, plural } from '../lib/format.js';
import {
  Page, Card, Table, Button, Modal, Input, Select, Pill, Progress, LocalTime, Empty, Async, useNow,
} from '../components/index.js';

// ---------- shared labels and helpers ----------

export const KIND_LABEL = { raid: 'Raid', pvp: 'PvP', event: 'Event' };
export const KIND_PILL = { raid: 'accent', pvp: 'alarm', event: 'info' };
export const STATUS_LABEL = { yes: 'Coming', tentative: 'Maybe', bench: 'Bench', no: 'Can’t make it' };
export const STATUS_PILL = { yes: 'ok', tentative: 'warn', bench: 'info', no: 'muted' };
export const ROLE_LABEL = { tank: 'Tank', healer: 'Healer', dps: 'Damage' };
export const ROLE_PLURAL = { tank: 'Tanks', healer: 'Healers', dps: 'Damage' };
export const ROLES = ['tank', 'healer', 'dps'];
export const AWARD_LABEL = { sr: 'Reserve', ms: 'Main spec', os: 'Off spec', free: 'Free roll' };

// [pill kind, label] for a raid's state. Only raids have reserves; other kinds just open and close.
export function raidState(raid) {
  if (raid.status === 'cancelled') return ['alarm', 'Cancelled'];
  if (raid.status === 'done') return ['muted', 'Finished'];
  if ((raid.kind || 'raid') !== 'raid' || !raid.sr_limit) return ['ok', 'Sign-ups open'];
  return raid.status === 'locked' ? ['warn', 'Reserves locked'] : ['ok', 'Reserves open'];
}

// "in 2 d 4 h", "in 35 min", "Starting now", "Started 40 min ago"; '' once it is long past.
export function countdown(startsAt, now = Date.now()) {
  const d = parseTime(startsAt);
  if (!d) return '';
  const diff = d.getTime() - now;
  const mins = Math.round(Math.abs(diff) / 60000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const days = Math.floor(h / 24);
  if (diff > 0) {
    if (mins < 1) return 'Starting now';
    if (mins < 60) return `in ${mins} min`;
    if (h < 24) return m && h < 6 ? `in ${h} h ${m} min` : `in ${h} h`;
    return h % 24 ? `in ${days} d ${h % 24} h` : `in ${days} d`;
  }
  if (mins < 1) return 'Starting now';
  if (mins < 60) return `Started ${mins} min ago`;
  if (h < 12) return `Started ${h} h ago`;
  return '';
}

export function durationLabel(min) {
  const n = Number(min) || 0;
  if (!n) return '';
  const h = Math.floor(n / 60);
  const m = n % 60;
  return h ? `${h} h${m ? ` ${m} min` : ''}` : `${m} min`;
}

export const coming = (c) => (c ? c.tank + c.healer + c.dps : 0);

export function KindPill({ kind }) {
  const k = kind || 'raid';
  return html`<${Pill} kind=${KIND_PILL[k] || 'muted'}>${KIND_LABEL[k] || k}<//>`;
}

export function StatePill({ raid }) {
  const [kind, label] = raidState(raid);
  return html`<${Pill} kind=${kind} dot>${label}<//>`;
}

// My sign-up as a pill; "Not signed up" for raids still open.
export function SignupPill({ signup, raid }) {
  if (signup) return html`<${Pill} kind=${STATUS_PILL[signup.status] || 'muted'}>${STATUS_LABEL[signup.status] || signup.status}<//>`;
  if (raid && (raid.status === 'done' || raid.status === 'cancelled')) return html`<span class="muted small">Didn’t sign up</span>`;
  return html`<span class="muted small">Not signed up</span>`;
}

// Tanks / healers / damage coming, plus a bar against the raid size when there is one.
// chips={false} shows only the bar (or the total) when the role numbers are already on screen.
export function RoleCounts({ counts, size, compact = false, chips = true }) {
  const total = coming(counts);
  return html`<div class=${compact ? 'raids-roles raids-roles--compact' : 'raids-roles'}>
    ${chips ? html`<div class="raids-role-chips">
      ${ROLES.map((r) => html`<span key=${r} class=${`raids-role raids-role--${r}`} title=${`${ROLE_PLURAL[r]} coming`}>
        <strong class="num">${counts ? counts[r] : 0}</strong> ${counts && counts[r] === 1 ? ROLE_LABEL[r].toLowerCase() : ROLE_PLURAL[r].toLowerCase()}
      </span>`)}
    </div>` : null}
    ${size
      ? html`<${Progress} value=${Math.min(total, size)} max=${size} size="sm" kind=${total >= size ? 'ok' : undefined}
          label=${`${total} of ${size} coming`} valueText=${counts && counts.tentative ? `${counts.tentative} maybe` : ''} />`
      : html`<span class="muted small">${plural(total, 'person', 'people')} coming${counts && counts.tentative ? `, ${counts.tentative} maybe` : ''}</span>`}
  </div>`;
}

// ---------- page ----------

// ?schedule=1 opens the Schedule form (officers), e.g. from a link on the Camp page.
export default function RaidsPage({ query = {} }) {
  const { isOfficer } = useSession();
  const q = useApi('/api/raids', { refreshOn: ['raid'] });
  const [scheduling, setScheduling] = useState(query.schedule === '1');
  useEffect(() => { if (query.schedule === '1') setScheduling(true); }, [query.schedule]);
  const stopScheduling = () => { setScheduling(false); if (query.schedule) setQuery({ schedule: undefined }); };
  const schedule = isOfficer ? html`<${Button} variant="primary" icon="plus" onClick=${() => setScheduling(true)}>Schedule<//>` : null;

  return html`<${Page} title="Raids" actions=${schedule}
      lede="Raids, PvP premades and guild events. Times are shown in your own time zone.">
    <${Async} q=${q} loadingLabel="Loading raids…">${(data) => html`
      <section class="stack" aria-labelledby="raids-upcoming">
        <h2 id="raids-upcoming" class="raids-heading">Coming up</h2>
        ${data.upcoming.length
          ? html`<div class="raids-grid">${data.upcoming.map((r) => html`<${RaidCard} key=${r.id} raid=${r} />`)}</div>`
          : html`<${Empty} icon="raids" title="Nothing scheduled yet."
              action=${isOfficer ? html`<${Button} variant="primary" icon="plus" onClick=${() => setScheduling(true)}>Schedule a raid<//>` : null}>
              ${isOfficer ? 'Schedule a raid, PvP premade or guild event. Discord gets a post straight away.' : 'Officers schedule raids here. You will get a notification when one is posted.'}
            <//>`}
      </section>
      <${PastRaids} rows=${data.past} />
      <${ScheduleModal} open=${scheduling && isOfficer} instances=${data.instances} onClose=${stopScheduling} />
    `}<//>
  <//>`;
}

function RaidCard({ raid }) {
  const now = useNow();
  const d = parseTime(raid.starts_at);
  const open = () => navigate(`/raids/${raid.id}`);
  const off = raid.status === 'cancelled';
  const left = off ? '' : countdown(raid.starts_at, now);
  const meta = [raid.instance, raid.size ? `${raid.size} players` : null, durationLabel(raid.duration_min)].filter(Boolean).join(' · ');
  return html`<article class=${`card raids-card${off ? ' is-cancelled' : ''}`} role="link" tabIndex="0" aria-label=${`${raid.title}, ${KIND_LABEL[raid.kind] || 'Raid'}`}
      onClick=${open} onKeyDown=${(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } }}>
    <div class="raids-card-top">
      <div class="raids-date" aria-hidden="true">
        <span class="raids-date-day">${d ? d.toLocaleDateString(undefined, { weekday: 'short' }) : ''}</span>
        <span class="raids-date-num">${d ? d.getDate() : ''}</span>
        <span class="raids-date-month">${d ? d.toLocaleDateString(undefined, { month: 'short' }) : ''}</span>
      </div>
      <div class="raids-card-main">
        <div class="row">
          <${KindPill} kind=${raid.kind} />
          ${raid.status !== 'open' ? html`<${StatePill} raid=${raid} />` : null}
        </div>
        <h3 class="raids-card-title ellipsis" title=${raid.title}>${raid.title}</h3>
        <p class="raids-card-meta ellipsis">${meta}</p>
        <p class="raids-card-when"><${LocalTime} t=${raid.starts_at} style="full" />${left ? html` · <strong>${left}</strong>` : null}</p>
      </div>
    </div>
    <${RoleCounts} counts=${raid.counts} size=${raid.size} compact />
    <div class="raids-card-foot">
      <${SignupPill} signup=${raid.mySignup} raid=${raid} />
      ${raid.kind === 'raid' && raid.sr_limit && raid.mySignup && raid.mySignup.status !== 'no'
        ? html`<span class="muted small">${raid.myReserves} of ${raid.sr_limit} reserves picked</span>` : null}
    </div>
  </article>`;
}

function PastRaids({ rows }) {
  if (!rows.length) return null;
  const columns = [
    { key: 'starts_at', label: 'When', sortable: true, width: '190px', render: (r) => html`<${LocalTime} t=${r.starts_at} style="full" />` },
    { key: 'title', label: 'Name', sortable: true, render: (r) => html`<${Link} href=${`/raids/${r.id}`}>${r.title}<//>` },
    { key: 'kind', label: 'Type', render: (r) => html`<${KindPill} kind=${r.kind} />` },
    { key: 'instance', label: 'Where', sortable: true },
    {
      key: 'status', label: 'Status', sortable: true,
      render: (r) => (r.status === 'open' || r.status === 'locked'
        ? html`<${Pill} kind="warn" title="An officer can close it to record attendance and update bonuses.">Not closed<//>`
        : html`<${StatePill} raid=${r} />`),
    },
    { key: 'coming', label: 'Coming', num: true, sortable: true, value: (r) => coming(r.counts), render: (r) => coming(r.counts) },
    { key: 'mine', label: 'You', value: (r) => (r.mySignup ? r.mySignup.status : ''), render: (r) => html`<${SignupPill} signup=${r.mySignup} raid=${r} />` },
  ];
  return html`<${Card} title="Past raids" sub=${`last ${rows.length}`} flush>
    <${Table} columns=${columns} rows=${rows} onRowClick=${(r) => navigate(`/raids/${r.id}`)} />
  <//>`;
}

// ---------- schedule ----------

const DURATIONS = [60, 90, 120, 150, 180, 210, 240, 300, 360].map((m) => ({ value: String(m), label: durationLabel(m) }));
const KIND_OPTIONS = [
  { value: 'raid', label: 'Raid (with soft reserves)' },
  { value: 'pvp', label: 'PvP premade' },
  { value: 'event', label: 'Guild event' },
];
const PLACEHOLDER = {
  raid: ['Molten Core, week 3', 'Molten Core'],
  pvp: ['Tarren Mill premade', 'Tarren Mill'],
  event: ['Fishing contest', 'Booty Bay'],
};

function todayLocal() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const blank = () => ({ kind: 'raid', title: '', instance: '', date: todayLocal(), time: '20:00', duration: '180', size: '', srLimit: '2', notes: '' });

function ScheduleModal({ open, instances = [], onClose }) {
  const [f, setF] = useState(blank);
  const [errors, setErrors] = useState({});
  const set = (key) => (value) => { setF((x) => ({ ...x, [key]: value })); setErrors((e) => ({ ...e, [key]: null })); };
  const save = useAction((body) => api.post('/api/raids', body), { success: (r) => r.message });

  const close = () => { if (!save.busy) { onClose(); setErrors({}); } };
  const submit = async (e) => {
    e?.preventDefault();
    const errs = {};
    if (!f.title.trim()) errs.title = 'Give it a name.';
    if (!f.instance.trim()) errs.instance = 'Say where it is.';
    // The date and time are in this computer's time zone; the server stores UTC.
    const startsAt = f.date && f.time ? fromLocalInput(`${f.date}T${f.time}`) : null;
    if (!startsAt) errs.when = 'Pick a date and a start time.';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    const r = await save.run({
      kind: f.kind, title: f.title.trim(), instance: f.instance.trim(), starts_at: startsAt,
      duration_min: Number(f.duration), size: f.size === '' ? null : Number(f.size),
      sr_limit: f.kind === 'raid' ? Number(f.srLimit || 0) : 0, notes: f.notes.trim(),
    });
    if (r.ok) {
      onClose();
      setF(blank());
      navigate(`/raids/${r.value.raid.id}`);
    }
  };
  const [titleHint, placeHint] = PLACEHOLDER[f.kind] || PLACEHOLDER.raid;

  return html`<${Modal} open=${open} title="Schedule" onClose=${close} size="lg" dismissable=${!save.busy}
      footer=${html`
        <${Button} variant="ghost" onClick=${close} disabled=${save.busy}>Cancel<//>
        <${Button} variant="primary" busy=${save.busy} onClick=${submit}>Schedule ${KIND_LABEL[f.kind] === 'Event' ? 'event' : KIND_LABEL[f.kind] === 'PvP' ? 'premade' : 'raid'}<//>`}>
    <form class="stack" onSubmit=${submit}>
      <div class="form-grid raids-form">
        <${Select} label="Type" value=${f.kind} options=${KIND_OPTIONS} onValue=${set('kind')} />
        <${Input} label="Name" value=${f.title} onValue=${set('title')} maxLength="60" required placeholder=${titleHint} error=${errors.title} />
        <${Input} label=${f.kind === 'raid' ? 'Instance' : 'Place'} value=${f.instance} onValue=${set('instance')} maxLength="60" required
          list="raids-instances" placeholder=${placeHint} error=${errors.instance}
          hint=${f.kind === 'raid' ? 'Use the loot list’s name so people can reserve from it.' : undefined} />
        <datalist id="raids-instances">${instances.map((i) => html`<option key=${i} value=${i} />`)}</datalist>
        <${Input} label="Date" type="date" value=${f.date} onValue=${set('date')} required error=${errors.when} />
        <${Input} label="Starts at" type="time" value=${f.time} onValue=${set('time')} required hint="Your local time." />
        <${Select} label="Length" value=${f.duration} options=${DURATIONS} onValue=${set('duration')} />
        <${Input} label="Players" type="number" min="5" max="40" value=${f.size} onValue=${set('size')} placeholder="20" hint="Leave empty for no limit." />
        ${f.kind === 'raid'
          ? html`<${Input} label="Reserves each" type="number" min="0" max="5" value=${f.srLimit} onValue=${set('srLimit')} hint="0 means everything is open roll." />`
          : null}
        <${Input} fieldClass="wide" label="Notes" value=${f.notes} onValue=${set('notes')} maxLength="300" placeholder="Bring fire resistance" />
      </div>
      <p class="hint">Everyone sees the time in their own time zone. Discord gets a post straight away and a reminder an hour before.</p>
      <button type="submit" hidden></button>
    </form>
  <//>`;
}
