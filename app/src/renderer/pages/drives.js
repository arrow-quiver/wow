// Supply drives: pool effort toward a shared goal (crates for faction rep, mats for raid consumables, gold for the
// bank). Members log what they hand in; officers start and close drives. Drives and hand-ins go to guildmates
// through the addon. API: docs/api/economy.md.
import { html, useState } from '../lib/html.js';
import { api, useApi, useAction } from '../lib/api.js';
import { useSession } from '../lib/session.js';
import { number, plural } from '../lib/format.js';
import {
  Page, Card, Table, Button, ConfirmButton, Modal, Pill, Input, Select, Textarea, Empty, Async,
  LocalTime, toast,
} from '../components/index.js';
import { ShareHint } from '../components/ShareHint.js';

export default function DrivesPage() {
  const { isOfficer } = useSession();
  const drives = useApi('/api/drives', { refreshOn: ['drive'] });
  const [starting, setStarting] = useState(false);

  return html`<${Page} title="Drives"
      lede="Pool effort toward a shared goal: loot crates for faction rep, mats for raid consumables, gold for the bank."
      actions=${isOfficer ? html`<${Button} variant="primary" icon="plus" onClick=${() => setStarting(true)}>Start a drive<//>` : null}>
    <${Async} q=${drives} loadingLabel="Counting crates…">${(d) => html`
      ${d.open.length
        ? html`<div class="drives-grid">${d.open.map((drive) => html`<${DriveCard} key=${drive.id} drive=${drive}
            myCharacters=${d.myCharacters} isOfficer=${isOfficer} onChange=${drives.reload} />`)}</div>`
        : html`<${Card}><${Empty} icon="drives" title="No drives running."
            action=${isOfficer ? html`<${Button} variant="primary" icon="plus" onClick=${() => setStarting(true)}>Start a drive<//>` : null}>
            ${isOfficer ? 'Start one when the guild needs something collected.' : 'Officers start drives when the guild needs something collected.'}
          <//><//>`}
      ${d.past.length ? html`<${PastDrives} drives=${d.past} />` : null}`}<//>
    ${isOfficer ? html`<${StartDrive} open=${starting} onClose=${() => setStarting(false)} onDone=${drives.reload} />` : null}
  <//>`;
}

// A drive's progress bar (the shared .progress look) without a visible caption: the card shows the numbers.
function Bar({ drive, size }) {
  return html`<div class=${`progress progress--${size}${drive.status === 'done' ? ' progress--ok' : ''}`} role="progressbar"
      aria-label=${`${drive.title}: ${drive.pct}% of the goal`} aria-valuemin="0" aria-valuemax=${drive.goal}
      aria-valuenow=${Math.min(drive.total, drive.goal)} aria-valuetext=${`${number(drive.total)} of ${number(drive.goal)} ${drive.unit}`}>
    <span class="progress-bar" style=${`width:${drive.pct}%`}></span>
  </div>`;
}

// ---------- an open drive ----------

function DriveCard({ drive, myCharacters, isOfficer, onChange }) {
  const close = async () => {
    const r = await api.post(`/api/drives/${drive.id}/close`);
    toast(r.message, 'ok');
    onChange();
  };
  const left = Math.max(0, drive.goal - drive.total);
  return html`<${Card} class="drive" title=${drive.title}
      sub=${drive.creator ? `started by ${drive.creator}` : null}
      actions=${isOfficer ? html`<${ConfirmButton} size="sm" variant="ghost" question="Close this drive?" yes="Close" onConfirm=${close}>Close<//>` : null}>
    <div class="stack">
      ${drive.notes ? html`<p class="drive-notes">${drive.notes}</p>` : null}
      <div class="drive-progress">
        <div class="drive-count">
          <span class="drive-total">${number(drive.total)}</span>
          <span class="muted">of ${number(drive.goal)} ${drive.unit}</span>
          <span class="spacer"></span>
          <strong class="drive-pct">${drive.pct}%</strong>
        </div>
        <${Bar} drive=${drive} size="lg" />
        <div class="drive-facts hint">
          <span>${left ? `${number(left)} ${drive.unit} to go` : 'Goal reached'}</span>
          <span>${plural(drive.contributors, 'giver')}</span>
          ${drive.mine ? html`<span class="drive-mine">You gave ${number(drive.mine)}</span>` : null}
        </div>
      </div>
      <${GiveForm} drive=${drive} myCharacters=${myCharacters} onDone=${onChange} />
      <${Leaderboard} drive=${drive} />
    </div>
  <//>`;
}

function GiveForm({ drive, myCharacters, onDone }) {
  const [amount, setAmount] = useState('');
  const [character, setCharacter] = useState(myCharacters[0] || '');
  const [note, setNote] = useState('');
  const [error, setError] = useState(null);
  const give = useAction((body) => api.post(`/api/drives/${drive.id}/give`, body), { success: (v) => (v.reached ? `🎉 ${v.message}` : v.message) });
  const submit = async (e) => {
    e.preventDefault();
    const n = Math.trunc(Number(amount));
    if (!(n >= 1)) { setError('How many did you hand in?'); return; }
    setError(null);
    const r = await give.run({ amount: n, character: character.trim(), note: note.trim() });
    if (r.ok) { setAmount(''); setNote(''); onDone(); }
  };
  return html`<form class="stack stack--tight" onSubmit=${submit} novalidate>
    <div class="drive-give">
      <${Input} label="Handed in" type="number" min="1" placeholder="10" value=${amount} error=${error}
        onValue=${(v) => { setAmount(v); if (error) setError(null); }} fieldClass="drive-give-amount" />
      ${myCharacters.length
        ? html`<${Select} label="Character" options=${myCharacters} value=${character} onValue=${setCharacter} fieldClass="drive-give-char" />`
        : html`<${Input} label="Character" value=${character} onValue=${setCharacter} maxLength="40" placeholder="Optional" fieldClass="drive-give-char" />`}
      <${Input} label="Note" value=${note} onValue=${setNote} maxLength="120" placeholder="Optional" fieldClass="drive-give-note" />
      <${Button} type="submit" variant="primary" busy=${give.busy}>Log it<//>
    </div>
    <${ShareHint} />
  </form>`;
}

function Leaderboard({ drive }) {
  if (!drive.leaderboard.length) return html`<p class="hint mb-0">Nobody has logged anything yet. Be the first.</p>`;
  const top = drive.leaderboard[0].amount || 1;
  return html`<div class="drive-board">
    <h3 class="drive-board-title">Top givers</h3>
    <ol class="list-plain drive-leaders">
      ${drive.leaderboard.map((b, i) => html`<li key=${b.who} class="drive-leader">
        <span class="drive-rank">${i + 1}</span>
        <span class="drive-who ellipsis">${b.who}</span>
        <span class="drive-bar" aria-hidden="true"><span style=${`width:${Math.max(4, Math.round((b.amount / top) * 100))}%`}></span></span>
        <strong class="num">${number(b.amount)}</strong>
      </li>`)}
    </ol>
  </div>`;
}

// ---------- finished drives ----------

function PastDrives({ drives }) {
  return html`<${Card} flush title="Finished" sub=${plural(drives.length, 'drive')}>
    <${Table} dense rows=${drives} sort=${{ key: 'created_at', dir: 'desc' }} columns=${[
      { key: 'title', label: 'Drive', sortable: true, render: (d) => html`<strong>${d.title}</strong>${d.notes ? html`<div class="hint ellipsis drive-past-notes">${d.notes}</div>` : null}` },
      { key: 'status', label: 'Result', sortable: true, render: (d) => (d.status === 'done'
        ? html`<${Pill} kind="ok" dot>Goal reached<//>` : html`<${Pill} kind="muted">Closed<//>`) },
      { key: 'total', label: 'Collected', num: true, sortable: true, render: (d) => html`${number(d.total)} <span class="muted">of ${number(d.goal)} ${d.unit}</span>` },
      { key: 'pct', label: '', width: '110px', render: (d) => html`<${Bar} drive=${d} size="sm" />` },
      { key: 'contributors', label: 'Givers', num: true, sortable: true },
      { key: 'top', label: 'Top giver', render: (d) => (d.leaderboard[0] ? html`${d.leaderboard[0].who} <span class="muted">(${number(d.leaderboard[0].amount)})</span>` : html`<span class="muted">—</span>`) },
      { key: 'created_at', label: 'Started', sortable: true, render: (d) => html`<${LocalTime} t=${d.created_at} style="day" />` },
    ]} />
  <//>`;
}

// ---------- start a drive (officers) ----------

function StartDrive({ open, onClose, onDone }) {
  const blank = { title: '', unit: '', goal: '', notes: '' };
  const [form, setForm] = useState(blank);
  const [error, setError] = useState(null);
  const start = useAction((body) => api.post('/api/drives', body), { success: (v) => v.message });
  const set = (k) => (v) => { setForm((f) => ({ ...f, [k]: v })); if (error) setError(null); };
  const submit = async (e) => {
    e?.preventDefault();
    const goal = Math.trunc(Number(form.goal));
    if (!form.title.trim() || !form.unit.trim() || !(goal >= 1)) { setError('Give the drive a name, what you’re collecting, and a goal.'); return; }
    const r = await start.run({ title: form.title.trim(), unit: form.unit.trim(), goal, notes: form.notes.trim() });
    if (r.ok) { setForm(blank); onClose(); onDone(); }
  };
  return html`<${Modal} open=${open} title="Start a supply drive" onClose=${onClose} dismissable=${!start.busy}
      footer=${html`
        <${Button} variant="ghost" onClick=${onClose} disabled=${start.busy}>Cancel<//>
        <${Button} variant="primary" busy=${start.busy} onClick=${submit}>Start drive<//>`}>
    <form class="stack" onSubmit=${submit} novalidate>
      <${Input} label="Name" value=${form.title} onValue=${set('title')} maxLength="80" placeholder="Durotar supply crates" required />
      <div class="grid-2">
        <${Input} label="Collecting" value=${form.unit} onValue=${set('unit')} maxLength="40" placeholder="crates" required hint="What people hand in, e.g. crates, potions, gold." />
        <${Input} label="Goal" type="number" min="1" value=${form.goal} onValue=${set('goal')} placeholder="200" required />
      </div>
      <${Textarea} label="Notes" rows="3" value=${form.notes} onValue=${set('notes')} maxLength="300"
        placeholder="Hand in at the Razor Hill camp, then log it here" hint="Optional. Where to hand things in, and why." />
      ${error ? html`<p class="field-error" role="alert">${error}</p>` : null}
      <${ShareHint} officer discord />
      <button type="submit" hidden></button>
    </form>
  <//>`;
}
