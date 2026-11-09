// Dungeon groups: put a group together for a dungeon (now or later) with the roles you need; guildmates join with a
// role. First come, first in; anyone past a role's free spots waits and moves up when someone leaves. Groups go to
// guildmates through the addon, who can also join in game with /wow lfg.
// Data: GET /api/dungeons (docs/api/dungeons.md).
import { html, useState, useEffect, useMemo } from '../lib/html.js';
import { api, useApi, useAction } from '../lib/api.js';
import { fromLocalInput } from '../lib/format.js';
import {
  Page, Card, Button, ConfirmButton, Input, Select, Pill, Empty, Async, ClassName, LocalTime, Icon,
} from '../components/index.js';
import { ShareHint } from '../components/ShareHint.js';

const shortTag = (bt) => String(bt || '').split('#')[0];
const ROLES = [{ value: 'tank', label: 'Tank' }, { value: 'healer', label: 'Healer' }, { value: 'dps', label: 'Damage' }];
const ROLE_LABEL = { tank: 'Tank', healer: 'Healer', dps: 'Damage' };
const ROLE_ICON = { tank: '🛡️', healer: '✚', dps: '⚔️' };

// Dungeons with their usual level range, for the picker and "fits your level". Any other name can be typed.
export const DUNGEONS = [
  ['Ragefire Chasm', 13, 18], ['Wailing Caverns', 17, 24], ['The Deadmines', 17, 26], ['Shadowfang Keep', 22, 30],
  ['Blackfathom Deeps', 24, 32], ['The Stockade', 24, 32], ['Gnomeregan', 29, 38], ['Razorfen Kraul', 29, 38],
  ['Scarlet Monastery', 34, 45], ['Razorfen Downs', 37, 46], ['Uldaman', 41, 51], ['Zul\'Farrak', 44, 54],
  ['Maraudon', 46, 55], ['Sunken Temple', 50, 60], ['Blackrock Depths', 52, 60], ['Lower Blackrock Spire', 55, 60],
  ['Upper Blackrock Spire', 58, 60], ['Dire Maul', 56, 60], ['Scholomance', 58, 60], ['Stratholme', 58, 60],
].map(([name, min, max]) => ({ name, min, max }));

/** Does a level fit a dungeon's usual range (a few levels either side)? null when the dungeon isn't known. */
export function fitsLevel(dungeon, level) {
  const d = DUNGEONS.find((x) => x.name.toLowerCase() === String(dungeon || '').trim().toLowerCase());
  if (!d || level == null) return null;
  return level >= d.min - 2 && level <= d.max + 2;
}

/** The buttons a group card gets, in order (the core's can* flags). */
export function groupActions(g) {
  if (!g || typeof g !== 'object') return [];
  return [['join', 'canJoin'], ['leave', 'canLeave'], ['done', 'canDone'], ['cancel', 'canCancel']].filter(([, f]) => g[f]).map(([v]) => v);
}

export default function DungeonsPage() {
  const data = useApi('/api/dungeons', { refreshOn: ['cta'] });
  return html`<${Page} title="Dungeons" width="wide"
      lede="Put a group together for a dungeon, or jump into one a guildmate started."
      actions=${html`<${Button} variant="ghost" size="sm" icon="refresh" busy=${data.refreshing} onClick=${data.reload}>Refresh<//>`}>
    <${Async} q=${data} loadingLabel="Looking for groups…">
      ${(d) => html`
        <${NewGroupCard} chars=${d.myCharacters} onPosted=${data.reload} />
        <${GroupList} groups=${d.groups} chars=${d.myCharacters} reload=${data.reload} />`}
    <//>
  <//>`;
}

function NewGroupCard({ chars, onPosted }) {
  const [character, setCharacter] = useState(chars[0] ? chars[0].name : '');
  const [dungeon, setDungeon] = useState('');
  const [role, setRole] = useState('dps');
  const [when, setWhen] = useState('');
  const [slots, setSlots] = useState({ tank: 1, healer: 1, dps: 3 });
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { if (!character && chars[0]) setCharacter(chars[0].name); }, [chars]);
  const post = useAction((body) => api.post('/api/dungeons', body), { success: (r) => r.message || 'Group posted.' });
  const current = chars.find((c) => c.name === character);
  const suggestions = useMemo(() => (current && current.level != null
    ? DUNGEONS.filter((d) => fitsLevel(d.name, current.level)) : DUNGEONS), [current]);
  const size = slots.tank + slots.healer + slots.dps;
  const submit = async (e) => {
    e.preventDefault();
    if (!dungeon.trim()) { setError('Name the dungeon.'); return; }
    setError('');
    const r = await post.run({ character, dungeon: dungeon.trim(), role, startsAt: when ? fromLocalInput(when) : null, slots, note: note.trim() });
    if (r.ok) { setNote(''); setWhen(''); onPosted(); }
  };
  const count = (k) => html`<${Select} label=${ROLE_LABEL[k]} value=${String(slots[k])} fieldClass="dungeons-slot"
    onValue=${(v) => setSlots({ ...slots, [k]: Number(v) })} options=${[0, 1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ value: String(n), label: String(n) }))} />`;
  if (!chars.length) {
    return html`<${Card} title="Start a group"><p class="muted mb-0">Log in to World of Warcraft on a character in your guild first, then log out or type /reload.</p><//>`;
  }
  return html`<${Card} title="Start a group" class="dungeons-post">
    <form class="stack" onSubmit=${submit} novalidate>
      <div class="form-grid dungeons-form">
        <${Select} label="Character" value=${character} onValue=${setCharacter}
          options=${chars.map((c) => ({ value: c.name, label: `${c.name} (${c.level ?? '?'})` }))} />
        <${Input} label="Dungeon" value=${dungeon} onValue=${(v) => { setDungeon(v); setError(''); }} maxLength="60" required
          list="dungeon-names" placeholder=${suggestions[0] ? suggestions[0].name : 'The Deadmines'} error=${error} />
        <datalist id="dungeon-names">${suggestions.map((d) => html`<option key=${d.name} value=${d.name}>${d.min}–${d.max}</option>`)}</datalist>
        <${Select} label="Your role" value=${role} onValue=${setRole} options=${ROLES} />
        <${Input} label="When" type="datetime-local" value=${when} onValue=${setWhen} hint="Leave empty for right now." />
      </div>
      <div class="row dungeons-slots">
        ${count('tank')}${count('healer')}${count('dps')}
        <span class="muted small">${size} in the group, you included.</span>
      </div>
      <${Input} label="Note" value=${note} onValue=${setNote} maxLength="140" placeholder="Quest run, bring the VC quests" />
      <div class="form-actions">
        <${Button} type="submit" variant="primary" icon="dungeons" busy=${post.busy}>Post group<//>
        <span class="hint">Guildmates online with Guild Camp hear about it in game.</span>
      </div>
      <${ShareHint} />
    </form>
  <//>`;
}

function GroupList({ groups, chars, reload }) {
  if (!groups.length) return html`<${Empty} icon="dungeons" title="No groups right now. Start one above." />`;
  return html`<div class="dungeons-grid">
    ${groups.map((g) => html`<${GroupCard} key=${g.key} g=${g} chars=${chars} reload=${reload} />`)}
  </div>`;
}

function GroupCard({ g, chars, reload }) {
  const [character, setCharacter] = useState(chars[0] ? chars[0].name : '');
  const firstOpen = ['tank', 'healer', 'dps'].find((r) => g.open[r] > 0) || 'dps';
  const [role, setRole] = useState(firstOpen);
  const act = useAction((verb, body) => api.post(`/api/dungeons/${g.key}/${verb}`, body), { success: (r) => r.message });
  const [busy, setBusy] = useState(null);
  const run = async (verb, body) => {
    setBusy(verb);
    await act.run(verb, body);
    setBusy(null);
    reload();
  };
  const me = chars.find((c) => c.name === character);
  const fits = me ? fitsLevel(g.dungeon, me.level) : null;
  const people = [{ ...g.leader, waiting: false, leader: true }, ...g.members];
  const empty = ['tank', 'healer', 'dps'].flatMap((r) => Array.from({ length: g.open[r] }, () => r));
  return html`<${Card} class=${`dungeons-card${g.mine ? ' is-mine' : ''}${g.joined ? ' is-joined' : ''}`}>
    <div class="stack stack--tight">
      <div class="row nowrap">
        <strong class="dungeons-name">${g.dungeon}</strong>
        ${g.state === 'full' ? html`<${Pill} kind="ok">Full<//>` : html`<${Pill} kind="muted">${empty.length} open<//>`}
        ${g.mine ? html`<${Pill} kind="info">Yours<//>` : null}
        ${g.joined ? html`<${Pill} kind=${g.joined.waiting ? 'warn' : 'ok'}>${g.joined.waiting ? 'Waiting' : "You're in"}<//>` : null}
        ${!g.mine && !g.joined && fits === true ? html`<${Pill} kind="ok">Fits your level<//>` : null}
        ${g.pending ? html`<${Pill} kind="muted" title="Goes to your guild the next time you log in or type /reload.">Not sent yet<//>` : null}
      </div>
      <div class="muted small">
        ${g.over ? 'Started ' : ''}<${LocalTime} t=${g.startsAt} style="long" />
      </div>
      ${g.note ? html`<p class="dungeons-note">${g.note}</p>` : null}
      <ul class="dungeons-people">
        ${people.map((p) => html`<li key=${p.character} class=${p.mine ? 'is-me' : ''}>
          <span class="dungeons-role" title=${ROLE_LABEL[p.role]}>${ROLE_ICON[p.role]}</span>
          <${ClassName} name=${p.character} cls=${p.class} />
          ${p.level != null ? html`<span class="muted small">${p.level}</span>` : null}
          ${p.leader ? html`<span class="muted small">leader, ${shortTag(p.battletag)}</span>` : null}
        </li>`)}
        ${empty.map((r, i) => html`<li key=${`open-${r}-${i}`} class="is-open">
          <span class="dungeons-role">${ROLE_ICON[r]}</span><span class="faint">${ROLE_LABEL[r]} wanted</span>
        </li>`)}
      </ul>
      ${g.waiting.length ? html`<div class="small muted">Waiting: ${g.waiting.map((p, i) => html`<span key=${p.character}><${ClassName} name=${p.character} cls=${p.class} /> (${ROLE_LABEL[p.role]})${i < g.waiting.length - 1 ? ', ' : ''}</span>`)}</div>` : null}
      ${g.canJoin ? html`<div class="row dungeons-join">
        ${chars.length > 1 ? html`<${Select} value=${character} onValue=${setCharacter} aria-label="Character"
          options=${chars.map((c) => ({ value: c.name, label: `${c.name} (${c.level ?? '?'})` }))} />` : null}
        <${Select} value=${role} onValue=${setRole} aria-label="Role"
          options=${ROLES.map((r) => ({ ...r, label: `${r.label}${g.open[r.value] ? '' : ' (waiting list)'}` }))} />
        <${Button} size="sm" variant="primary" busy=${busy === 'join'} onClick=${() => run('join', { character, role })}>Join<//>
      </div>` : null}
      <div class="row small">
        ${g.mine && people.length > 1 ? html`<span class="muted"><${Icon} name="partners" /> Invite: ${g.members.map((m) => m.character).join(', ')}</span>` : null}
        <span class="spacer"></span>
        ${groupActions(g).filter((v) => v !== 'join').map((verb) => {
          if (verb === 'leave') return html`<${ConfirmButton} key=${verb} size="sm" variant="ghost" question="Leave this group?" yes="Leave" no="Stay" onConfirm=${() => run('leave')}>Leave<//>`;
          if (verb === 'done') return html`<${Button} key=${verb} size="sm" variant="secondary" icon="check" busy=${busy === 'done'} onClick=${() => run('done')}>Done<//>`;
          return html`<${ConfirmButton} key=${verb} size="sm" variant="ghost" icon="trash" question="Call this group off?" yes="Call it off" no="Keep it" onConfirm=${() => run('cancel')}>Call off<//>`;
        })}
      </div>
    </div>
  <//>`;
}
