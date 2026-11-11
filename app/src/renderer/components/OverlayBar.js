// The overlay window's top bar (Ctrl+Shift+G): drag strip, the quick actions (call to arms, kill on sight, board
// post, ask the Coach, next raid), spoken alerts on/off, see-through slider and hide. And AlertsFeed: the guild feed
// (/api/activity) checked every few seconds; new lines pop up as toasts and, when on, are read out.
import { html, useState, useEffect, useRef } from '../lib/html.js';
import { api, useAction } from '../lib/api.js';
import { gc } from '../lib/gc.js';
import { navigate } from '../lib/router.js';
import { toast } from '../lib/toast.js';
import { speak, speakOn, setSpeak } from '../lib/overlay.js';
import { Icon } from './Icon.js';
import { Button } from './Button.js';
import { Modal } from './Modal.js';
import { Input, Select, Textarea } from './form.js';

const BOARD_KINDS = [['lfg', 'Looking for group'], ['wts', 'Selling'], ['wtb', 'Buying'], ['help', 'Help wanted']];

export function OverlayBar() {
  const [open, setOpen] = useState(null);
  const [talk, setTalk] = useState(speakOn());
  const [opacity, setOpacity] = useState(0.94);
  useEffect(() => { gc.settings.get().then((s) => s && s.overlayOpacity && setOpacity(s.overlayOpacity), () => {}); }, []);
  const changeOpacity = (v) => { const n = Math.min(1, Math.max(0.5, Number(v))); setOpacity(n); gc.settings.set({ overlayOpacity: n }).catch(() => {}); };
  const toggleTalk = () => { const on = !talk; setTalk(on); setSpeak(on); if (on) speak('Spoken alerts on. For the Horde!'); };
  const nextRaid = async () => {
    try {
      const r = await api.get('/api/raids');
      const next = r && Array.isArray(r.upcoming) ? r.upcoming[0] : null;
      navigate(next ? `/raids/${next.id}` : '/raids');
    } catch { navigate('/raids'); }
  };
  return html`<header class="ovl-bar2">
    <div class="ovl-brand"><img src="./assets/logo.svg" alt="" width="18" height="21" /><span>War table</span></div>
    <nav class="ovl-quick" aria-label="Quick actions">
      <button type="button" class="ovl-act" title="Call to arms" onClick=${() => setOpen('cta')}><${Icon} name="bell" /><span>Call to arms</span></button>
      <button type="button" class="ovl-act" title="Kill on sight" onClick=${() => setOpen('kos')}><${Icon} name="target" /><span>Kill on sight</span></button>
      <button type="button" class="ovl-act" title="Board post" onClick=${() => setOpen('board')}><${Icon} name="board" /><span>Board</span></button>
      <button type="button" class="ovl-act" title="Ask the Coach" onClick=${() => navigate('/overlay?ask=1')}><${Icon} name="spark" /><span>Ask</span></button>
      <button type="button" class="ovl-act" title="Next raid" onClick=${nextRaid}><${Icon} name="raids" /><span>Next raid</span></button>
    </nav>
    <div class="ovl-tools">
      <button type="button" class=${`ovl-tool${talk ? ' is-on' : ''}`} aria-pressed=${talk} title=${talk ? 'Spoken alerts: on' : 'Spoken alerts: off'} onClick=${toggleTalk}>
        <${Icon} name=${talk ? 'bell' : 'bell-off'} /></button>
      <input class="ovl-opacity" type="range" min="0.5" max="1" step="0.02" value=${opacity} aria-label="See-through" title="See-through"
        onInput=${(e) => changeOpacity(e.currentTarget.value)} />
      <button type="button" class="ovl-tool" title="Hide (Esc)" aria-label="Hide the war table" onClick=${() => gc.overlay.hide()}>×</button>
    </div>
    ${open === 'cta' ? html`<${CtaModal} onClose=${() => setOpen(null)} />` : null}
    ${open === 'kos' ? html`<${KosModal} onClose=${() => setOpen(null)} />` : null}
    ${open === 'board' ? html`<${BoardModal} onClose=${() => setOpen(null)} />` : null}
  </header>`;
}

function CtaModal({ onClose }) {
  const [zone, setZone] = useState('');
  const [needed, setNeeded] = useState('');
  const [message, setMessage] = useState('');
  const post = useAction(() => api.post('/api/ctas', { zone: zone.trim(), needed: needed === '' ? null : Number(needed), message: message.trim() }), { success: (r) => r.message });
  return html`<${Modal} open title="Call to arms" onClose=${onClose} size="sm"
      footer=${html`<${Button} onClick=${onClose}>Cancel<//><${Button} variant="primary" icon="bell" busy=${post.busy} disabled=${!zone.trim()}
        onClick=${async () => { if ((await post.run()).ok) onClose(); }}>Sound it<//>`}>
    <div class="stack">
      <${Input} label="Where" value=${zone} onValue=${setZone} maxLength="60" placeholder="Tarren Mill" required autofocus />
      <${Input} label="How many (optional)" type="number" min="1" max="40" value=${needed} onValue=${setNeeded} />
      <${Input} label="Message (optional)" value=${message} onValue=${setMessage} maxLength="200" placeholder="Alliance raiding the inn" />
      <p class="hint mb-0">Goes to Discord now, and to guild chat from your next /reload.</p>
    </div>
  <//>`;
}

function KosModal({ onClose }) {
  const [name, setName] = useState('');
  const [reason, setReason] = useState('');
  const add = useAction(() => api.post('/api/kos', { name: name.trim(), reason: reason.trim() }), { success: (r) => r.message });
  return html`<${Modal} open title="Kill on sight" onClose=${onClose} size="sm"
      footer=${html`<${Button} onClick=${onClose}>Cancel<//><${Button} variant="primary" icon="target" busy=${add.busy} disabled=${!name.trim()}
        onClick=${async () => { if ((await add.run()).ok) onClose(); }}>Add to the list<//>`}>
    <div class="stack">
      <${Input} label="Player" value=${name} onValue=${setName} maxLength="24" placeholder="Gankalot" required autofocus />
      <${Input} label="Why (optional)" value=${reason} onValue=${setReason} maxLength="100" placeholder="Camps the flight path" />
    </div>
  <//>`;
}

function BoardModal({ onClose }) {
  const [chars, setChars] = useState(null);
  const [character, setCharacter] = useState('');
  const [kind, setKind] = useState('lfg');
  const [text, setText] = useState('');
  useEffect(() => {
    api.get('/api/board').then((r) => { const list = (r && r.myCharacters) || []; setChars(list); if (list[0]) setCharacter(list[0].name); }, () => setChars([]));
  }, []);
  const post = useAction(() => api.post('/api/board', { character, kind, text: text.trim() }), { success: (r) => r.message });
  return html`<${Modal} open title="Board post" onClose=${onClose} size="sm"
      footer=${html`<${Button} onClick=${onClose}>Cancel<//><${Button} variant="primary" icon="board" busy=${post.busy} disabled=${!text.trim() || !character}
        onClick=${async () => { if ((await post.run()).ok) onClose(); }}>Post<//>`}>
    ${chars && !chars.length ? html`<p class="hint mb-0">Log in to a guild character with the addon and /reload once first.</p>` : html`<div class="stack">
      <${Select} label="Character" value=${character} onValue=${setCharacter} options=${(chars || []).map((c) => ({ value: c.name, label: c.name }))} />
      <${Select} label="Kind" value=${kind} onValue=${setKind} options=${BOARD_KINDS.map(([value, label]) => ({ value, label }))} />
      <${Textarea} label="What" rows="2" maxLength="200" value=${text} onValue=${setText} placeholder="LF2M Scarlet Monastery" />
    </div>`}
  <//>`;
}

// What gets read out: the big moments only.
const SPOKEN = new Set(['cta', 'boss', 'bounty', 'kos', 'recruit', 'celebrate']);
const EMOJI = { cta: '⚔️', boss: '💀', bounty: '💰', kos: '☠️', recruit: '🐺', celebrate: '🔥', board: '📌', raid: '🗓️', craft: '🔨' };

export function AlertsFeed({ every = 8000 }) {
  const last = useRef(null);
  useEffect(() => {
    let alive = true;
    const check = async () => {
      try {
        const r = await api.get('/api/activity?limit=10');
        const rows = (r && r.activity) || [];
        if (!alive) return;
        // The first look: what's there already isn't news (an empty feed starts at 0, so its first line is).
        if (last.current == null) { last.current = rows.length ? Math.max(...rows.map((a) => a.id)) : 0; return; }
        if (!rows.length) return;
        const top = Math.max(...rows.map((a) => a.id));
        const fresh = rows.filter((a) => a.id > last.current).sort((a, b) => a.id - b.id);
        last.current = Math.max(last.current, top);
        for (const a of fresh.slice(-4)) {
          toast(`${EMOJI[a.kind] || '•'} ${a.text}`, a.kind === 'cta' || a.kind === 'kos' ? 'warn' : 'info', { timeout: 8000 });
          if (SPOKEN.has(a.kind)) speak(a.text);
        }
      } catch { /* the core is busy or restarting: next time */ }
    };
    check();
    const t = setInterval(check, every);
    return () => { alive = false; clearInterval(t); };
  }, []);
  return null;
}
