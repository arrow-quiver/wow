// Camp: the guild's dashboard. Who is online around the fire, calls to arms, upcoming raids and events with your
// sign-up, guild notices (officers post and remove them), a setup checklist for new members, and recent activity.
// Data: GET /api/camp (docs/api/community.md).
import { html, useState, useEffect } from '../lib/html.js';
import { api, useApi, useAction, qs } from '../lib/api.js';
import { Link } from '../lib/router.js';
import { useSyncStatus, describeSync } from '../lib/status.js';
import { classColor, className, parseTime, plural } from '../lib/format.js';
import {
  Page, Card, Button, ConfirmButton, Input, Textarea, Pill, Progress, Empty, Async, ClassName, TimeAgo, LocalTime,
  Icon, Campfire,
} from '../components/index.js';

// The roster counts as stale after 30 minutes without a scan (old campRing rule).
const STALE_MS = 30 * 60 * 1000;
const SEATS = 14;
const shortTag = (bt) => String(bt || '').split('#')[0];

export default function CampPage() {
  const camp = useApi('/api/camp', { refreshOn: ['cta', 'notice', 'raid', 'request'], interval: 60000 });
  return html`<${Page} title="Camp" width="wide"
      actions=${html`<${Button} variant="ghost" size="sm" icon="refresh" busy=${camp.refreshing} onClick=${camp.reload}>Refresh<//>`}>
    <${Async} q=${camp} loadingLabel="Gathering round the fire…">
      ${(d) => html`<${CampBody} d=${d} reload=${camp.reload} setData=${camp.setData} />`}
    <//>
  <//>`;
}

function CampBody({ d, reload, setData }) {
  const ob = d.onboarding;
  return html`
    ${ob && ob.total && ob.done < ob.total ? html`<${Onboarding} ob=${ob} />` : null}
    <${FireCard} online=${d.online} scannedAt=${d.rosterScannedAt} realm=${d.realm} guild=${d.guild} />
    <div class="cols camp-cols">
      <div class="stack stack--loose">
        <${CtaCard} ctas=${d.ctas} me=${d.me} onPosted=${(cta) => setData((x) => ({ ...x, ctas: [cta, ...x.ctas].slice(0, 8) }))} />
        <${ActivityCard} first=${d.activity} />
      </div>
      <div class="stack stack--loose">
        <${RaidsCard} raids=${d.raids} />
        <${NoticesCard} notices=${d.announcements} isOfficer=${d.isOfficer} reload=${reload} setData=${setData} />
        <${SyncCard} mySync=${d.mySync} />
      </div>
    </div>`;
}

// ---------- onboarding ----------

function Onboarding({ ob }) {
  return html`<${Card} tone="accent" class="camp-onboard" title="Get set up" sub=${`${ob.done} of ${ob.total} done`}>
    <${Progress} value=${ob.done} max=${ob.total} label="Setup progress" />
    <ol class="camp-steps">
      ${ob.steps.map((s) => html`<li key=${s.key} class=${s.done ? 'is-done' : ''}>
        <span class="camp-step-mark" aria-hidden="true">${s.done ? html`<${Icon} name="check" size=${13} />` : null}</span>
        ${s.done
          ? html`<span>${s.label}<span class="sr"> (done)</span></span>`
          : html`<${Link} href=${s.href}>${s.label}<//>`}
      </li>`)}
    </ol>
  <//>`;
}

// ---------- around the fire ----------

function RealmPill({ realm }) {
  if (!realm) return null;
  const state = realm.up === false ? ['alarm', 'Down'] : realm.up ? ['ok', 'Up'] : ['muted', 'Status unknown'];
  return html`<span class="row camp-realm">
    <strong>${realm.name}</strong>
    <${Pill} kind=${state[0]} dot>${state[1]}<//>
    ${realm.queue ? html`<${Pill} kind="warn">Login queue<//>` : null}
    ${realm.population ? html`<span class="muted small">${realm.population} population</span>` : null}
    ${realm.checkedAt ? html`<span class="faint small">checked <${TimeAgo} t=${realm.checkedAt} /></span>` : null}
  </span>`;
}

function FireCard({ online, scannedAt, realm }) {
  const scanned = parseTime(scannedAt);
  const stale = !scanned || Date.now() - scanned.getTime() > STALE_MS;
  const shown = online.slice(0, SEATS);
  const n = Math.max(shown.length, 1);
  return html`<${Card} class=${`camp-fire${stale ? ' is-stale' : ''}`} actions=${html`<${RealmPill} realm=${realm} />`}
      title=${online.length ? `${plural(online.length, 'adventurer')} around the fire` : 'The fire is quiet'}>
    <div class="camp-fire-body">
      <div class="camp-ring" role="list" aria-label="Online now">
        <${Campfire} class="camp-ring-fire" />
        ${shown.map((c, i) => {
          const a = (i / n) * Math.PI * 2 - Math.PI / 2;
          const style = `left:${(50 + Math.cos(a) * 36).toFixed(2)}%;top:${(50 + Math.sin(a) * 36).toFixed(2)}%;--cc:${classColor(c.class)}`;
          return html`<${Link} key=${c.name} role="listitem" class="camp-seat" href=${`/characters/${encodeURIComponent(c.name)}`} style=${style}
              title=${`${c.name}, level ${c.level ?? '?'} ${className(c.class)}${c.zone ? `, ${c.zone}` : ''}`}>
            <span class="camp-seat-dot" aria-hidden="true">${c.name.slice(0, 2)}</span>
            <span class="camp-seat-name">${c.name}</span>
          <//>`;
        })}
      </div>
      <div class="camp-online">
        <p class="muted camp-scanned">
          ${scanned
            ? html`Guild roster as of <${TimeAgo} t=${scannedAt} />.${stale ? ' Anyone with Guild Camp running updates it when they log out or /reload.' : ''}`
            : 'Nobody has synced yet. Install the addon from Addon & sync, then log in to the game.'}
        </p>
        ${online.length
          ? html`<ul class="list-lines camp-online-list">
              ${online.map((c) => html`<li key=${c.name} class="row nowrap">
                <span class="dot" aria-hidden="true"></span>
                <${ClassName} name=${c.name} cls=${c.class} />
                <span class="muted small nowrap">${c.level ? `${c.level}` : ''}</span>
                <span class="spacer"></span>
                <span class="muted small ellipsis" title=${c.zone || ''}>${c.zone || ''}</span>
              </li>`)}
            </ul>`
          : html`<${Empty} compact icon="camp" title="Nobody is online right now." />`}
      </div>
    </div>
  <//>`;
}

// ---------- call to arms ----------

function CtaCard({ ctas, me, onPosted }) {
  const [zone, setZone] = useState('');
  const [needed, setNeeded] = useState('5');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const post = useAction((body) => api.post('/api/ctas', body), { success: (r) => r.message || 'Horn sounded.' });

  const submit = async (e) => {
    e.preventDefault();
    if (!zone.trim()) { setError('Say where the fight is.'); return; }
    setError('');
    const r = await post.run({ zone: zone.trim(), needed: needed === '' ? null : Number(needed), message: message.trim() });
    if (r.ok) {
      setMessage('');
      onPosted(r.value.cta);
    }
  };

  return html`<${Card} title="Call to arms" sub="last 24 hours" class="camp-cta">
    <form class="stack" onSubmit=${submit} novalidate>
      <div class="camp-cta-form">
        <div class="stack stack--tight camp-cta-where">
          <${Input} label="Where" value=${zone} onValue=${(v) => { setZone(v); setError(''); }} maxLength="60"
            placeholder="The Crossroads" error=${error} required />
          ${me && me.lastZone ? html`<button type="button" class="link-btn small camp-lastzone" onClick=${() => { setZone(me.lastZone); setError(''); }}>
            Use my last zone: ${me.lastZone}
          </button>` : null}
        </div>
        <${Input} label="Need" type="number" min="1" max="40" value=${needed} onValue=${setNeeded} fieldClass="camp-cta-need" />
        <${Input} label="What's happening" value=${message} onValue=${setMessage} maxLength="200"
          placeholder="Alliance raid hitting the flight master" fieldClass="camp-cta-msg" />
      </div>
      <div class="form-actions">
        <${Button} type="submit" variant="danger" icon="bell" busy=${post.busy}>Sound the horn<//>
      </div>
      <p class="hint mb-0">Posts to Discord and notifies everyone in Guild Camp. In game, type <code>/wow cta Crossroads 5 need help</code>. It sends on your next reload or logout.</p>
    </form>
    <div class="camp-cta-list">
      ${ctas.length
        ? html`<ul class="list-lines">
            ${ctas.map((c) => html`<li key=${c.id} class="camp-cta-item">
              <div class="row">
                <strong>${c.zone}</strong>
                ${c.needed ? html`<${Pill} kind="alarm">need ${c.needed}<//>` : null}
                ${c.source === 'addon' ? html`<${Pill} kind="muted">from in game<//>` : c.source === 'discord' ? html`<${Pill} kind="muted">from Discord<//>` : null}
                <span class="spacer"></span>
                <span class="muted small"><${TimeAgo} t=${c.created_at} /></span>
              </div>
              ${c.message ? html`<p class="camp-cta-msg-text">${c.message}</p>` : null}
              <span class="muted small">${c.character ? html`<${ClassName} name=${c.character} cls=${c.class} />` : shortTag(c.battletag)}</span>
            </li>`)}
          </ul>`
        : html`<${Empty} compact icon="raids" title="No calls in the last day." />`}
    </div>
  <//>`;
}

// ---------- activity ----------

function ActivityCard({ first }) {
  const [extra, setExtra] = useState([]);
  const [more, setMore] = useState(first.length >= 12);
  const [busy, setBusy] = useState(false);
  // New dashboard data replaces what "Show more" loaded.
  useEffect(() => { setExtra([]); setMore(first.length >= 12); }, [first]);
  const rows = [...first, ...extra];
  const loadMore = async () => {
    setBusy(true);
    try {
      const last = rows[rows.length - 1];
      const r = await api.get(`/api/activity${qs({ before: last && last.id, limit: 30 })}`);
      setExtra((x) => [...x, ...r.activity]);
      setMore(r.more);
    } catch { setMore(false); } finally { setBusy(false); }
  };
  return html`<${Card} title="Around camp" class="camp-activity"
      footer=${more ? html`<${Button} variant="ghost" size="sm" busy=${busy} onClick=${loadMore}>Show more<//>` : null}>
    ${rows.length
      ? html`<ul class="list-lines">
          ${rows.map((a) => html`<li key=${a.id} class="row nowrap camp-activity-item">
            <${Icon} name=${ACTIVITY_ICON[a.kind] || 'camp'} class="camp-activity-icon" />
            <span class="camp-activity-text">${a.text}</span>
            <span class="spacer"></span>
            <span class="muted small nowrap"><${TimeAgo} t=${a.created_at} /></span>
          </li>`)}
        </ul>`
      : html`<${Empty} compact icon="camp" title="Things people do show up here: new characters, crafting requests, leveling partners." />`}
  <//>`;
}

const ACTIVITY_ICON = {
  character: 'character', member: 'partners', guild: 'camp', craft: 'crafters', buddy: 'partners',
  raid: 'raids', loot: 'loot', bank: 'bank', drive: 'drives',
};

// ---------- upcoming raids ----------

const KIND_LABEL = { raid: 'Raid', pvp: 'PvP', event: 'Event' };
const SIGNUP = { yes: ['ok', 'Coming'], tentative: ['warn', 'Maybe'], bench: ['info', 'Bench'], no: ['muted', 'Not coming'] };

function RaidsCard({ raids }) {
  return html`<${Card} title="Coming up" class="camp-raids" flush
      footer=${html`<${Link} href="/raids">All raids and events<//>`}>
    ${raids.length
      ? html`<ul class="list-plain camp-raid-list">
          ${raids.map((r) => {
            const s = r.mySignup && SIGNUP[r.mySignup.status];
            return html`<li key=${r.id} class="camp-raid">
              <div class="camp-raid-main">
                <${Link} href=${`/raids/${r.id}`} class="camp-raid-title">${r.title}<//>
                <span class="muted small"><${LocalTime} t=${r.starts_at} /> · <${TimeAgo} t=${r.starts_at} /></span>
                <span class="row small">
                  <${Pill} kind=${r.kind === 'raid' ? 'accent' : 'info'}>${KIND_LABEL[r.kind] || 'Event'}<//>
                  <span class="muted">${r.coming} coming${r.maybe ? `, ${r.maybe} maybe` : ''}</span>
                  ${r.status === 'locked' ? html`<${Pill} kind="muted">Locked<//>` : null}
                </span>
              </div>
              ${s
                ? html`<${Pill} kind=${s[0]} dot title=${r.mySignup.character ? `as ${r.mySignup.character}` : undefined}>${s[1]}<//>`
                : html`<${Button} size="sm" variant="primary" href=${`/raids/${r.id}`}>Sign up<//>`}
            </li>`;
          })}
        </ul>`
      : html`<${Empty} compact icon="raids" title="Nothing scheduled yet." />`}
  <//>`;
}

// ---------- notices ----------

function NoticesCard({ notices, isOfficer, reload, setData }) {
  const [body, setBody] = useState('');
  const post = useAction((text) => api.post('/api/announcements', { body: text }), { success: (r) => r.message || 'Notice posted.' });
  const submit = async (e) => {
    e.preventDefault();
    if (!body.trim()) return;
    const r = await post.run(body.trim());
    if (r.ok) { setBody(''); reload(); }
  };
  const remove = async (id) => {
    await api.del(`/api/announcements/${id}`);
    setData((x) => ({ ...x, announcements: x.announcements.filter((a) => a.id !== id) }));
    reload();
  };
  return html`<${Card} title="Notices" class="camp-notices">
    ${isOfficer ? html`<form class="stack stack--tight camp-notice-form" onSubmit=${submit}>
      <${Textarea} label="New notice" value=${body} onValue=${setBody} rows="3" maxLength="500"
        placeholder="Raid sign-ups open Sunday" hint="Posted to Discord too, and everyone gets a notification." />
      <div class="form-actions"><${Button} type="submit" busy=${post.busy} disabled=${!body.trim()}>Post notice<//></div>
    </form>` : null}
    ${notices.length
      ? html`<ul class="list-lines camp-notice-list">
          ${notices.map((a) => html`<li key=${a.id}>
            <p class="camp-notice-body">${a.body}</p>
            <div class="row small">
              <span class="muted">${shortTag(a.battletag)}, <${TimeAgo} t=${a.created_at} /></span>
              <span class="spacer"></span>
              ${a.canDelete ? html`<${ConfirmButton} variant="ghost" size="sm" icon="trash" question="Remove this notice?"
                  onConfirm=${() => remove(a.id)}>Remove<//>` : null}
            </div>
          </li>`)}
        </ul>`
      : html`<${Empty} compact icon="banner" title="No notices yet." />`}
  <//>`;
}

// ---------- your sync ----------

function SyncCard({ mySync }) {
  const sync = useSyncStatus();
  const s = describeSync(sync);
  return html`<${Card} title="Your sync" class="camp-sync" actions=${html`<${Pill} kind=${s.kind} dot>${s.label}<//>`}>
    <p class="mb-0">${mySync
      ? html`The server last heard from you <${TimeAgo} t=${mySync} />.`
      : html`Not synced yet. <${Link} href="/addon">Set up the addon<//>, then log in to the game.`}</p>
  <//>`;
}
