// The guild bulletin board: looking for group, selling, buying, help wanted. Posts go to guildmates through the
// addon and stay up for a week; your own you can take down. Data: GET /api/board (docs/api/community.md, "Guild life").
import { html, useState, useEffect } from '../lib/html.js';
import { api, useApi, useAction } from '../lib/api.js';
import { Page, Card, Button, ConfirmButton, Input, Select, Pill, Empty, Async, ClassName, TimeAgo, Money } from '../components/index.js';
import { ShareHint } from '../components/ShareHint.js';

const KINDS = [['lfg', 'Looking for group'], ['wts', 'Selling'], ['wtb', 'Buying'], ['help', 'Help wanted']];
const PILL = { lfg: 'info', wts: 'ok', wtb: 'warn', help: 'muted' };

export default function BoardPage() {
  const q = useApi('/api/board');
  const [filter, setFilter] = useState('all');
  return html`<${Page} title="Bulletin board" width="wide"
      lede="Looking for a group, selling, buying or need a hand? Put it on the board for the whole guild."
      actions=${html`<${Button} variant="ghost" size="sm" icon="refresh" busy=${q.refreshing} onClick=${q.reload}>Refresh<//>`}>
    <${Async} q=${q} loadingLabel="Reading the board…">
      ${(d) => html`
        <${PostForm} chars=${d.myCharacters} onPosted=${q.reload} />
        <div class="row board-filter" role="group" aria-label="Show">
          ${[['all', 'Everything'], ...KINDS].map(([k, label]) => html`<${Button} key=${k} size="sm" variant=${filter === k ? 'primary' : 'ghost'}
            aria-pressed=${filter === k} onClick=${() => setFilter(k)}>${label}${k !== 'all' ? ` (${d.posts.filter((p) => p.kind === k).length})` : ''}<//>`)}
        </div>
        <${Posts} posts=${filter === 'all' ? d.posts : d.posts.filter((p) => p.kind === filter)} reload=${q.reload} />`}
    <//>
  <//>`;
}

function PostForm({ chars, onPosted }) {
  const [character, setCharacter] = useState(chars[0] ? chars[0].name : '');
  const [kind, setKind] = useState('lfg');
  const [text, setText] = useState('');
  const [gold, setGold] = useState('');
  useEffect(() => { if (!character && chars[0]) setCharacter(chars[0].name); }, [chars]);
  const post = useAction((body) => api.post('/api/board', body), { success: (r) => r.message });
  const priced = kind === 'wts' || kind === 'wtb';
  const submit = async (e) => {
    e.preventDefault();
    const price = priced && gold !== '' ? Math.round(Number(gold) * 10000) : null;
    if ((await post.run({ character, kind, text: text.trim(), price })).ok) { setText(''); setGold(''); onPosted(); }
  };
  if (!chars.length) {
    return html`<${Card} title="Put up a post"><p class="hint mb-0">Log in to World of Warcraft on a character in the guild and /reload once, then post here.</p><//>`;
  }
  return html`<${Card} title="Put up a post">
    <form class="stack" onSubmit=${submit} novalidate>
      <div class="form-grid board-form">
        <${Select} label="Character" value=${character} onValue=${setCharacter} options=${chars.map((c) => ({ value: c.name, label: `${c.name} (${c.level ?? '?'})` }))} />
        <${Select} label="Kind" value=${kind} onValue=${setKind} options=${KINDS.map(([value, label]) => ({ value, label }))} />
        <${Input} label="What" value=${text} onValue=${setText} maxLength="200" required
          placeholder=${{ lfg: 'LF2M Scarlet Monastery, tank and healer', wts: 'Mooncloth, 4 left', wtb: 'Arcanite Bar x2', help: 'Need a hand with the Ashenvale escort' }[kind]} />
        ${priced ? html`<${Input} label="Price (gold)" type="number" min="0" step="0.01" value=${gold} onValue=${setGold} placeholder="optional" />` : null}
      </div>
      <div class="form-actions">
        <${Button} type="submit" variant="primary" icon="board" busy=${post.busy} disabled=${!text.trim()}>Post<//>
        <span class="hint">Posts stay up for a week. With a Discord webhook set, the guild sees it there too.</span>
      </div>
      <${ShareHint} />
    </form>
  <//>`;
}

function Posts({ posts, reload }) {
  const remove = useAction((id) => api.post(`/api/board/${id}/remove`, {}), { success: (r) => r.message });
  if (!posts.length) return html`<${Empty} icon="board" title="Nothing on the board.">Be the first to put something up.<//>`;
  return html`<div class="partners-grid">
    ${posts.map((p) => html`<${Card} key=${p.id} class=${`board-card${p.mine ? ' is-mine' : ''}`}>
      <div class="stack stack--tight">
        <div class="row nowrap"><${Pill} kind=${PILL[p.kind]}>${p.kindLabel}<//>${p.mine ? html`<${Pill} kind="info">Yours<//>` : null}</div>
        <p class="board-text">${p.text}</p>
        ${p.price ? html`<div><${Money} copper=${p.price} /></div>` : null}
        <div class="row small">
          <span class="muted"><${ClassName} name=${p.character} cls=${p.class} />${p.level ? ` ${p.level}` : ''}, <${TimeAgo} t=${p.created_at} /></span>
          <span class="spacer"></span>
          ${p.mine ? html`<${ConfirmButton} variant="ghost" size="sm" icon="trash" question="Take this post down?"
            onConfirm=${async () => { if ((await remove.run(p.id)).ok) reload(); }}>Take down<//>` : null}
        </div>
      </div>
    <//>`)}
  </div>`;
}
