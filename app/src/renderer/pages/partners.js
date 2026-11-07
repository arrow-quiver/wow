// Leveling partners (the old "buddies"): post where you're questing and when, so guildies within a few levels can
// come along. A new post for the same character replaces the old one; posts disappear after 3 days.
// Data: GET /api/partners (docs/api/community.md).
import { html, useState, useEffect, useMemo } from '../lib/html.js';
import { api, useApi, useAction } from '../lib/api.js';
import {
  Page, Card, Button, ConfirmButton, Input, Select, Pill, Empty, Async, ClassName, TimeAgo,
} from '../components/index.js';

const shortTag = (bt) => String(bt || '').split('#')[0];
// "Near your level": within this many levels of one of your characters.
const NEAR = 3;

export default function PartnersPage() {
  const data = useApi('/api/partners');
  return html`<${Page} title="Partners" width="wide"
      lede="Post where you're questing and when. Anyone within a few levels can come along."
      actions=${html`<${Button} variant="ghost" size="sm" icon="refresh" busy=${data.refreshing} onClick=${data.reload}>Refresh<//>`}>
    <${Async} q=${data} loadingLabel="Looking for company…">
      ${(d) => html`
        <${PostCard} chars=${d.myCharacters} onPosted=${data.reload} />
        <${PostList} posts=${d.posts} chars=${d.myCharacters} reload=${data.reload} />`}
    <//>
  <//>`;
}

function PostCard({ chars, onPosted }) {
  const [character, setCharacter] = useState(chars[0] ? chars[0].name : '');
  const [zone, setZone] = useState('');
  const [when, setWhen] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { if (!character && chars[0]) setCharacter(chars[0].name); }, [chars]);
  const post = useAction((body) => api.post('/api/partners', body), { success: (r) => r.message || 'Posted.' });
  const submit = async (e) => {
    e.preventDefault();
    if (!character.trim()) { setError('Pick the character you are leveling.'); return; }
    setError('');
    const r = await post.run({ character: character.trim(), zone: zone.trim(), when_text: when.trim(), note: note.trim() });
    if (r.ok) { setNote(''); onPosted(); }
  };
  const current = chars.find((c) => c.name === character);
  return html`<${Card} title="Find a partner" class="partners-post">
    <form class="stack" onSubmit=${submit} novalidate>
      <div class="form-grid partners-form">
        ${chars.length
          ? html`<${Select} label="Character" value=${character} onValue=${(v) => { setCharacter(v); if (!zone) { const c = chars.find((x) => x.name === v); if (c && c.zone) setZone(c.zone); } }}
              options=${chars.map((c) => ({ value: c.name, label: `${c.name} (${c.level ?? '?'})` }))} />`
          : html`<${Input} label="Character" value=${character} onValue=${(v) => { setCharacter(v); setError(''); }} maxLength="40" required
              placeholder="Your character's name" error=${error} hint="Your characters show here after your first sync." />`}
        <${Input} label="Zone" value=${zone} onValue=${setZone} maxLength="60" placeholder="Stonetalon Mountains"
          hint=${current && current.zone && current.zone !== zone ? html`<button type="button" class="link-btn" onClick=${() => setZone(current.zone)}>Use ${current.zone}</button>` : null} />
        <${Input} label="When" value=${when} onValue=${setWhen} maxLength="60" placeholder="Tonight 8pm" />
        <${Input} label="Note" value=${note} onValue=${setNote} maxLength="140" placeholder="Doing the Venture Co. chain" />
      </div>
      ${chars.length && error ? html`<p class="field-error" role="alert">${error}</p>` : null}
      <div class="form-actions">
        <${Button} type="submit" variant="primary" icon="partners" busy=${post.busy}>Post<//>
        <span class="hint">A new post for the same character replaces your old one. Posts show for 3 days.</span>
      </div>
    </form>
  <//>`;
}

function PostList({ posts, chars, reload }) {
  const levels = useMemo(() => chars.map((c) => c.level).filter((l) => l != null), [chars]);
  const close = useAction((id) => api.post(`/api/partners/${id}/close`), { success: (r) => r.message || 'Post removed.' });
  if (!posts.length) {
    return html`<${Empty} icon="partners" title="Nobody has posted yet. Be the first." />`;
  }
  return html`<div class="partners-grid">
    ${posts.map((p) => {
      const near = !p.mine && p.level != null && levels.some((l) => Math.abs(l - p.level) <= NEAR);
      return html`<${Card} key=${p.id} class=${`partners-card${p.mine ? ' is-mine' : ''}`}>
        <div class="stack stack--tight">
          <div class="row nowrap">
            <${ClassName} name=${p.character} cls=${p.class} class="partners-name" />
            <${Pill} kind="muted">level ${p.level ?? '?'}<//>
            ${near ? html`<${Pill} kind="ok">Near your level<//>` : null}
            ${p.mine ? html`<${Pill} kind="info">Yours<//>` : null}
          </div>
          <div class="partners-where">
            ${p.zone ? html`<strong>${p.zone}</strong>` : html`<span class="muted">Anywhere</span>`}
            ${p.when_text ? html`<span class="muted"> · ${p.when_text}</span>` : null}
          </div>
          ${p.note ? html`<p class="partners-note">${p.note}</p>` : null}
          <div class="row small">
            <span class="muted">${shortTag(p.battletag)}, <${TimeAgo} t=${p.created_at} /></span>
            <span class="spacer"></span>
            ${p.mine ? html`<${ConfirmButton} variant="ghost" size="sm" icon="trash" question="Remove this post?"
                onConfirm=${async () => { if ((await close.run(p.id)).ok) reload(); }}>Remove<//>` : null}
          </div>
        </div>
      <//>`;
    })}
  </div>`;
}
