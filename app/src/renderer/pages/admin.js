// Officer tools (/admin, officers only): sync health, backups, Blizzard and game data, Coach AI usage,
// the audit log, and the owner's fresh start. Server shapes: docs/api/admin.md.
import { html, useState, useEffect, useMemo } from '../lib/html.js';
import { api, useApi, useAction, qs } from '../lib/api.js';
import { gc } from '../lib/gc.js';
import { useSession } from '../lib/session.js';
import { bytes, number, parseTime, plural } from '../lib/format.js';
import {
  Page, Card, Stat, Table, Button, Input, Modal, Notice, Pill, Progress, Empty, Async, TimeAgo, toast,
} from '../components/index.js';

// ---------- helpers ----------

export const usd = (n) => `$${Number(n || 0).toFixed(2)}`;

// "Thrall#1234" → ["Thrall", "#1234"]
function splitTag(battletag) {
  const s = String(battletag || '');
  const i = s.indexOf('#');
  return i < 0 ? [s, ''] : [s.slice(0, i), s.slice(i)];
}

const ROLE_PILL = { owner: ['accent', 'Owner'], officer: ['info', 'Officer'], member: ['muted', 'Member'] };
export function RolePill({ role }) {
  const [kind, label] = ROLE_PILL[role] || ['muted', role || 'Unknown'];
  return html`<${Pill} kind=${kind}>${label}<//>`;
}

// A version a member reported: red when older than the newest release, grey "not yet" when missing.
function VersionCell({ v, outdated, latest }) {
  if (!v) return html`<span class="muted small">not yet</span>`;
  if (outdated) return html`<${Pill} kind="alarm" title=${latest ? `Older than ${latest}` : 'Outdated'}>${v}<//>`;
  return html`<span class="admin-version">${v}</span>`;
}

function LastSync({ m }) {
  if (m.neverSynced) {
    return html`<span class="row nowrap">
      <${Pill} kind="muted">never<//>
      ${!m.devices && !m.sync_keys ? html`<span class="muted small">not signed in</span>` : null}
    </span>`;
  }
  if (m.stale) return html`<${Pill} kind="warn" dot title="No sync for over a week"><${TimeAgo} t=${m.last_sync_at} /><//>`;
  return html`<${TimeAgo} t=${m.last_sync_at} />`;
}

// ---------- page ----------

// ?section=<id> scrolls to that card (links from elsewhere, and the smoke run's screenshots).
const SECTIONS = ['sync', 'backups', 'blizzard', 'ai', 'audit', 'reset'];

export default function AdminPage({ query = {} }) {
  const session = useSession();
  const q = useApi('/api/admin', { refreshOn: ['release'] });
  const ready = q.data !== undefined;
  useEffect(() => {
    if (!ready || !SECTIONS.includes(query.section)) return;
    document.getElementById(`admin-${query.section}`)?.scrollIntoView({ block: 'start' });
  }, [ready, query.section]);

  return html`<${Page} title="Officer tools" width="normal"
      lede="Who is syncing, backups, game data and the guild's audit log."
      actions=${html`<${Button} icon="refresh" busy=${q.refreshing} onClick=${q.reload}>Refresh<//>`}>
    <${Async} q=${q} loadingLabel="Loading officer tools…">
      ${(data) => html`<${AdminBody} data=${data} reload=${q.reload} setData=${q.setData} guildName=${session.guild?.name} />`}
    <//>
  <//>`;
}

function AdminBody({ data, reload, setData, guildName }) {
  return html`<div class="stack stack--loose admin">
    <${Summary} data=${data} />
    <${SyncHealth} members=${data.members} latest=${data.latest} />
    <div class="grid-2 admin-pair">
      <${Backups} data=${data} setData=${setData} />
      <div class="stack stack--loose">
        <${GameData} blizzard=${data.blizzard} gameData=${data.gameData} setData=${setData} />
        <${AiUsage} ai=${data.ai} />
      </div>
    </div>
    <${AuditLog} first=${data.audit} />
    ${data.isOwner ? html`<${FreshStart} guildName=${guildName} backupsEnabled=${data.backupsEnabled} onDone=${reload} />` : null}
  </div>`;
}

// ---------- summary tiles ----------

function Summary({ data }) {
  const members = data.members || [];
  const synced = members.filter((m) => !m.neverSynced && !m.stale).length;
  const outdated = members.filter((m) => m.addonOutdated || m.appOutdated).length;
  const newest = (data.backups || [])[0];
  const ai = data.ai || {};
  return html`<div class="card admin-summary">
    <${Stat} label="Synced this week" value=${`${synced} of ${members.length}`}
      hint=${members.length - synced ? `${plural(members.length - synced, 'member')} behind` : 'Everyone is up to date'} />
    <${Stat} label="Need an update" value=${number(outdated)}
      hint=${outdated ? 'Addon or app is older than the latest' : 'All on the latest versions'} />
    <${Stat} label="Last backup" value=${newest ? html`<${TimeAgo} t=${newest.created} />` : '—'}
      hint=${data.backupsEnabled ? `${plural((data.backups || []).length, 'copy', 'copies')} kept` : 'Backups are off'} />
    <${Stat} label="Coach this month" value=${usd(ai.spentUsd)} hint=${`of ${usd(ai.coach_budget_usd)} budget`} />
  </div>`;
}

// ---------- sync health ----------

function SyncHealth({ members = [], latest = {} }) {
  const showCompanion = members.some((m) => m.companion_version);
  const columns = useMemo(() => {
    const cols = [
      {
        key: 'battletag', label: 'Member', sortable: true, value: (m) => m.battletag.toLowerCase(),
        render: (m) => {
          const [name, tag] = splitTag(m.battletag);
          return html`<span class="admin-member"><strong>${name}</strong><span class="muted small">${tag}</span></span>`;
        },
      },
      { key: 'role', label: 'Role', render: (m) => html`<${RolePill} role=${m.role} />` },
      { key: 'characters', label: 'Characters', num: true, sortable: true },
      {
        key: 'last_sync_at', label: 'Last sync', sortable: true,
        value: (m) => (m.last_sync_at ? parseTime(m.last_sync_at)?.getTime() : null),
        render: (m) => html`<${LastSync} m=${m} />`,
      },
      { key: 'addon_version', label: 'Addon', render: (m) => html`<${VersionCell} v=${m.addon_version} outdated=${m.addonOutdated} latest=${latest.addon} />` },
      { key: 'app_version', label: 'App', render: (m) => html`<${VersionCell} v=${m.app_version} outdated=${m.appOutdated} latest=${latest.app} />` },
    ];
    if (showCompanion) {
      cols.push({
        key: 'companion_version', label: 'Old companion', title: 'The companion was replaced by the Guild Camp app',
        render: (m) => (m.companion_version
          ? html`<${Pill} kind=${m.legacyCompanion ? 'warn' : 'muted'} title=${m.legacyCompanion ? 'Still uses the old companion instead of the app' : 'Used the old companion before'}>${m.companion_version}<//>`
          : html`<span class="muted small">—</span>`),
      });
    }
    cols.push({ key: 'discord_linked', label: 'Discord', render: (m) => (m.discord_linked ? html`<${Pill} kind="ok">linked<//>` : html`<span class="muted small">no</span>`) });
    return cols;
  }, [showCompanion, latest.addon, latest.app]);

  const sub = [latest.addon && `addon ${latest.addon}`, latest.app && `app ${latest.app}`].filter(Boolean).join(' · ');
  return html`<${Card} id="admin-sync" title="Sync health" sub=${sub ? `Latest: ${sub}` : 'No releases published yet'} flush
      footer=${html`<div class="admin-legend">
        <span><${Pill} kind="alarm">red<//> outdated: ask them to update in Guild Camp under Updates</span>
        <span><${Pill} kind="warn">amber<//> no sync for a week</span>
        <span><${Pill} kind="muted">grey<//> never synced</span>
      </div>`}>
    <${Table} columns=${columns} rows=${members} rowClass=${(m) => (m.neverSynced ? 'is-muted' : undefined)}
      empty="Nobody is in the guild yet." />
  <//>`;
}

// ---------- backups ----------

function Backups({ data, setData }) {
  const make = useAction(() => api.post('/api/admin/backups'));
  const [saving, setSaving] = useState(null);
  const list = data.backups || [];

  const makeNow = async () => {
    const r = await make.run();
    if (!r.ok) return;
    setData((d) => ({ ...d, backups: r.value.backups }));
    toast(r.value.message || 'Backup made.', 'ok');
  };
  const download = async (file) => {
    setSaving(file);
    try {
      const saved = await gc.api.download(`/api/admin/backups/${encodeURIComponent(file)}`, file);
      if (saved) toast(`Saved to ${saved}`, 'ok');
    } catch (err) {
      toast(err?.message || "Couldn't download the backup.", 'alarm');
    } finally {
      setSaving(null);
    }
  };

  const columns = [
    { key: 'file', label: 'Copy', render: (b) => html`<span class="admin-file">${b.file}</span>` },
    { key: 'size', label: 'Size', num: true, render: (b) => bytes(b.size) },
    { key: 'created', label: 'Made', render: (b) => html`<${TimeAgo} t=${b.created} />` },
  ];
  if (data.canDownloadBackups) {
    columns.push({
      key: 'dl', label: html`<span class="sr">Download</span>`, align: 'right',
      render: (b) => html`<${Button} size="sm" variant="ghost" icon="download" busy=${saving === b.file}
        label=${`Download ${b.file}`} onClick=${() => download(b.file)} />`,
    });
  }

  return html`<${Card} id="admin-backups" title="Backups" sub="kept on the server" flush
      actions=${data.backupsEnabled ? html`<${Button} size="sm" icon="plus" busy=${make.busy} onClick=${makeNow}>Make a backup now<//>` : null}
      footer=${data.backupsEnabled
        ? `The database is copied every day and the last 14 copies are kept. ${data.canDownloadBackups ? 'As owner you can download them.' : 'The guild owner can download them.'}`
        : null}>
    ${!data.backupsEnabled
      ? html`<div class="admin-pad"><${Notice} kind="info" title="Backups are off.">This server keeps its data in memory, so there is no database file to copy.<//></div>`
      : html`<${Table} columns=${columns} rows=${list} rowKey=${(b) => b.file} dense
          empty=${html`<${Empty} compact icon="shield" title="No backups yet.">The first one runs shortly after the server starts.<//>`} />`}
  <//>`;
}

// ---------- Blizzard and game data ----------

function Fact({ label, children }) {
  return html`<div class="admin-fact"><dt>${label}</dt><dd>${children}</dd></div>`;
}

export function RealmLine({ status, realm }) {
  if (!realm) return html`<span class="muted">Not set. Add it in Guild settings.</span>`;
  if (!status) return html`<span><strong>${realm}</strong> <span class="muted small">not checked yet</span></span>`;
  if (status.found === false) return html`<span><strong>${realm}</strong> <${Pill} kind="warn">Blizzard doesn't list this realm yet<//></span>`;
  return html`<span class="row">
    <strong>${status.name || realm}</strong>
    ${status.up === true ? html`<${Pill} kind="ok" dot>Up<//>` : status.up === false ? html`<${Pill} kind="alarm" dot>Down<//>` : html`<${Pill} kind="muted">Unknown<//>`}
    ${status.queue ? html`<${Pill} kind="warn">Login queue<//>` : null}
    ${status.population ? html`<span class="muted small">${status.population} population</span>` : null}
    ${status.checkedAt ? html`<span class="muted small">checked <${TimeAgo} t=${status.checkedAt} /></span>` : null}
  </span>`;
}

function GameData({ blizzard = {}, gameData = {}, setData }) {
  const check = useAction(() => api.post('/api/admin/blizzard'));
  const refresh = useAction(() => api.post('/api/admin/gamedata/refresh'));
  const st = blizzard.status;

  const runCheck = async () => {
    const r = await check.run();
    if (!r.ok) return;
    setData((d) => ({ ...d, blizzard: r.value.blizzard, gameData: r.value.gameData || d.gameData }));
    toast(r.value.message || 'Blizzard API checked.', 'ok');
  };
  const runRefresh = async () => {
    const r = await refresh.run();
    if (!r.ok) return;
    setData((d) => ({ ...d, gameData: r.value.gameData || d.gameData }));
    toast(r.value.message || 'Refreshed.', r.value.log && r.value.log.length ? 'ok' : 'info');
  };

  let api_;
  if (!blizzard.configured) api_ = html`<${Pill} kind="muted">No Battle.net app on the server<//>`;
  else if (!st) api_ = html`<${Pill} kind="muted">Not checked yet<//>`;
  else api_ = st.ok ? html`<${Pill} kind="ok" dot>Reachable<//>` : html`<${Pill} kind="alarm" dot>Not reachable<//>`;

  return html`<${Card} id="admin-blizzard" title="Blizzard game data"
      actions=${html`<${Button} size="sm" icon="refresh" busy=${check.busy} onClick=${runCheck}>Check now<//>`}>
    <dl class="admin-facts">
      <${Fact} label="Game data API">${api_}<//>
      <${Fact} label="WoW: Forever">${st && st.forever
        ? html`<span class="row"><${Pill} kind="ok">Available<//><span class="muted small">${st.forever}</span></span>`
        : html`<span class="muted">Not in Blizzard's API yet. Checked daily.</span>`}<//>
      ${st && st.tokenGold ? html`<${Fact} label=${`Retail token (${String(st.region || blizzard.region || '').toUpperCase()})`}>${number(st.tokenGold)}g<//>` : null}
      <${Fact} label="Last checked">${st ? html`<${TimeAgo} t=${st.checkedAt} />` : html`<span class="muted">Shortly after the server starts.</span>`}<//>
      <${Fact} label="Item data">
        <span>${gameData.namespaces?.label || 'Nothing yet'}<span class="muted small"> · ${number(gameData.itemsKnown || 0)} items known</span></span>
      <//>
      <${Fact} label="Realm"><${RealmLine} status=${gameData.realm_status} realm=${gameData.realm} /><//>
      <${Fact} label="Official guild list">${gameData.official_roster_note
        ? html`<span>${gameData.official_roster_note} <span class="muted small">· <${TimeAgo} t=${gameData.official_roster_at} /></span></span>`
        : html`<span class="muted">${gameData.liveData ? 'Not fetched yet.' : 'Arrives once Blizzard adds WoW: Forever.'}</span>`}<//>
    </dl>
    <div class="form-actions admin-gap">
      <${Button} size="sm" icon="sync" busy=${refresh.busy} onClick=${runRefresh}>Refresh realm and guild list<//>
      <${Button} size="sm" variant="ghost" href="/guild-settings">Set the realm<//>
    </div>
  <//>`;
}

// ---------- Coach AI usage ----------

function AiUsage({ ai = {} }) {
  const budget = Number(ai.coach_budget_usd) || 0;
  const spent = Number(ai.spentUsd) || 0;
  const over = budget > 0 ? spent >= budget : spent > 0;
  return html`<${Card} id="admin-ai" title="Coach AI usage" sub=${monthLabel(ai.month)}
      actions=${html`<${Button} size="sm" variant="ghost" href="/guild-settings">Change budget<//>`}>
    <div class="stack">
      <${Progress} value=${budget > 0 ? Math.min(spent, budget) : over ? 1 : 0} max=${budget > 0 ? budget : 1}
        label="Spent this month" valueText=${`${usd(spent)} of ${usd(budget)}`} kind=${over ? 'alarm' : undefined} />
      ${!ai.hasKey ? html`<${Notice} kind="warn">No Claude API key on the server yet, so plans and answers are off. Play-style tracking still works.<//>` : null}
      ${ai.hasKey && !ai.coach_enabled ? html`<${Notice} kind="info">Coach AI is switched off in Guild settings.<//>` : null}
      ${over && ai.hasKey && ai.coach_enabled ? html`<${Notice} kind="alarm">The budget is used up. The Coach pauses until next month, or raise the budget.<//>` : null}
      <p class="hint mb-0">Each member can ask ${ai.limits?.questionsPerDay ?? 30} questions and make ${ai.limits?.plansPerDay ?? 5} plans a day.</p>
    </div>
  <//>`;
}

function monthLabel(month) {
  const m = /^(\d{4})-(\d{2})$/.exec(month || '');
  if (!m) return '';
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 15)).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

// ---------- audit log ----------

function AuditLog({ first }) {
  const [entries, setEntries] = useState(first?.entries || []);
  const [next, setNext] = useState(first?.nextBefore ?? null);
  const more = useAction((before) => api.get(`/api/admin/audit${qs({ before })}`));
  // A reload of the page data starts the list over.
  useEffect(() => { setEntries(first?.entries || []); setNext(first?.nextBefore ?? null); }, [first]);

  const loadMore = async () => {
    const r = await more.run(next);
    if (!r.ok) return;
    setEntries((list) => [...list, ...r.value.entries.filter((e) => !list.some((x) => x.id === e.id))]);
    setNext(r.value.nextBefore ?? null);
  };

  const columns = [
    { key: 'created_at', label: 'When', width: '130px', render: (a) => html`<${TimeAgo} t=${a.created_at} />` },
    {
      key: 'name', label: 'Who', width: '160px',
      render: (a) => (a.battletag ? html`<strong title=${a.battletag}>${a.name}</strong>` : html`<span class="muted">system</span>`),
    },
    { key: 'action', label: 'What', render: (a) => html`<span class="admin-action">${a.action}</span>` },
    { key: 'detail', label: 'Detail', class: 'wrap-cell', render: (a) => (a.detail ? html`<span class="muted">${a.detail}</span>` : null) },
  ];
  return html`<${Card} id="admin-audit" title="Audit log" sub="officer and account actions, newest first" flush
      footer=${next ? html`<${Button} size="sm" busy=${more.busy} onClick=${loadMore}>Load more<//>` : entries.length ? 'No older entries.' : null}>
    <${Table} columns=${columns} rows=${entries} dense empty="Nothing yet." />
  <//>`;
}

// ---------- fresh start (owner) ----------

function FreshStart({ guildName, backupsEnabled, onDone }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const wipe = useAction((confirm) => api.post('/api/admin/reset', { confirm }));
  const name = guildName || '';
  const matches = typed.trim().toLowerCase() === name.trim().toLowerCase() && !!name;

  const close = () => { if (!wipe.busy) { setOpen(false); setTyped(''); } };
  const go = async () => {
    const r = await wipe.run(typed.trim());
    if (!r.ok) return;
    toast(r.value.message, 'ok', { timeout: 12000 });
    setOpen(false);
    setTyped('');
    onDone?.();
  };

  return html`<${Card} id="admin-reset" title="Fresh start" sub="owner only" tone="alarm">
    <div class="admin-danger">
      <div>
        <p>Wipes all game data: characters, roster, raids and loot, bank, prices, drives, requests, calls to arms and activity.
          Members, roles, settings, devices, the invite link and notifications stay.</p>
        <p class="hint mb-0">${backupsEnabled ? 'A backup is made first. ' : ''}Data from before the wipe is ignored if an old game folder (for example Retail testing) uploads it again.</p>
      </div>
      <${Button} variant="danger" icon="trash" onClick=${() => setOpen(true)}>Wipe game data…<//>
    </div>
    <${Modal} open=${open} title="Wipe all game data?" onClose=${close} dismissable=${!wipe.busy} size="sm"
      footer=${html`
        <${Button} variant="ghost" disabled=${wipe.busy} onClick=${close}>Cancel<//>
        <${Button} variant="danger" icon="trash" busy=${wipe.busy} disabled=${!matches} onClick=${go}>Wipe game data<//>`}>
      <div class="stack">
        <p class="mb-0">Everything players synced is removed for a fresh start. ${backupsEnabled ? 'A backup of the database is made first, so it can be restored.' : 'This server keeps its data in memory, so no backup can be made.'}</p>
        <${Input} label=${`Type “${name}” to confirm`} hint="Capital letters don't matter." value=${typed} onValue=${setTyped}
          autocomplete="off" spellcheck=${false} placeholder=${name}
          onKeyDown=${(e) => { if (e.key === 'Enter' && matches && !wipe.busy) go(); }} />
      </div>
    <//>
  <//>`;
}
