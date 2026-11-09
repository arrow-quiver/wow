// Officer tools (/admin, officers only): the roster and addon versions this PC knows, backups of this PC's Guild
// Camp data (make one, list them, show one in its folder), Blizzard's game data, the audit log, and the Guild
// Master's fresh start. Data: GET /api/admin (docs/api/admin.md).
import { html, useState, useEffect, useMemo } from '../lib/html.js';
import { api, useApi, useAction, qs } from '../lib/api.js';
import { gc } from '../lib/gc.js';
import { useSession } from '../lib/session.js';
import { bytes, number, parseTime, plural } from '../lib/format.js';
import { roleForRank, ROLE_NAMES } from '../lib/status.js';
import {
  Page, Card, Stat, Table, Tabs, Button, Input, Modal, Notice, Pill, Empty, Async, ClassName, TimeAgo, toast,
} from '../components/index.js';

// ---------- helpers (shared with Guild settings) ----------

export const usd = (n) => `$${Number(n || 0).toFixed(2)}`;

// "Thrall#1234" → ["Thrall", "#1234"]
function splitTag(battletag) {
  const s = String(battletag || '');
  const i = s.indexOf('#');
  return i < 0 ? [s, ''] : [s.slice(0, i), s.slice(i)];
}

const ROLE_PILL = { owner: 'accent', officer: 'info', member: 'muted' };
const ROLE_ORDER = { owner: 0, officer: 1, member: 2 };
export function RolePill({ role }) {
  if (!role) return html`<span class="muted small">—</span>`;
  return html`<${Pill} kind=${ROLE_PILL[role] || 'muted'}>${ROLE_NAMES[role] || role}<//>`;
}

// A version someone reported: red when older than the newest release, grey "not yet" when missing.
function VersionCell({ v, outdated, latest }) {
  if (!v) return html`<span class="faint" title="Not shared with this PC yet">—</span>`;
  if (outdated) return html`<${Pill} kind="alarm" title=${latest ? `Older than ${latest}` : 'Outdated'}>${v}<//>`;
  return html`<span class="admin-version">${v}</span>`;
}

function LastSync({ m }) {
  if (m.neverSynced) return html`<${Pill} kind="muted">never<//>`;
  if (m.stale) return html`<${Pill} kind="warn" dot title="Nothing new for over a week"><${TimeAgo} t=${m.last_sync_at} /><//>`;
  return html`<${TimeAgo} t=${m.last_sync_at} />`;
}

export function RealmLine({ status, realm }) {
  if (!realm) return html`<span class="muted">Not known yet. The addon reads it from the game.</span>`;
  if (!status) return html`<span><strong>${realm}</strong> <span class="muted small">status not checked</span></span>`;
  if (status.found === false) return html`<span><strong>${realm}</strong> <${Pill} kind="warn">Blizzard doesn't list this realm yet<//></span>`;
  return html`<span class="row">
    <strong>${status.name || realm}</strong>
    ${status.up === true ? html`<${Pill} kind="ok" dot>Up<//>` : status.up === false ? html`<${Pill} kind="alarm" dot>Down<//>` : html`<${Pill} kind="muted">Unknown<//>`}
    ${status.queue ? html`<${Pill} kind="warn">Login queue<//>` : null}
    ${status.population ? html`<span class="muted small">${status.population} population</span>` : null}
    ${status.checkedAt ? html`<span class="muted small">checked <${TimeAgo} t=${status.checkedAt} /></span>` : null}
  </span>`;
}

/** Counts for the summary tiles (exported for tests). */
export function adminSummary(data, officerRankMax) {
  const roster = data?.roster || [];
  const members = data?.members || [];
  const outdated = new Set([
    ...roster.filter((c) => c.addonOutdated).map((c) => `c:${c.name}`),
    ...members.filter((m) => m.addonOutdated || m.appOutdated).map((m) => `m:${m.id}`),
  ]).size;
  return {
    characters: roster.length,
    online: roster.filter((c) => c.online).length,
    officers: roster.filter((c) => ['owner', 'officer'].includes(roleForRank(c.rank_index, officerRankMax))).length,
    people: members.length,
    outdated,
    backups: (data?.backups || []).length,
    newestBackup: (data?.backups || [])[0] || null,
  };
}

// ---------- page ----------

// ?section=<id> scrolls to that card (links from elsewhere, and the smoke run's screenshots).
const SECTIONS = ['roster', 'backups', 'blizzard', 'audit', 'reset'];

export default function AdminPage({ query = {} }) {
  const session = useSession();
  const q = useApi('/api/admin');
  const ready = q.data !== undefined;
  useEffect(() => {
    if (!ready || !SECTIONS.includes(query.section)) return;
    document.getElementById(`admin-${query.section}`)?.scrollIntoView({ block: 'start' });
  }, [ready, query.section]);

  return html`<${Page} title="Officer tools" width="normal"
      lede="What this PC knows about the roster and addon versions, backups, game data and the audit log."
      actions=${html`<${Button} icon="refresh" busy=${q.refreshing} onClick=${q.reload}>Refresh<//>`}>
    <${Async} q=${q} loadingLabel="Loading officer tools…">
      ${(data) => html`<${AdminBody} data=${data} reload=${q.reload} setData=${q.setData} guild=${session.guild} />`}
    <//>
  <//>`;
}

function AdminBody({ data, reload, setData, guild }) {
  const rankMax = guild?.officer_rank_max ?? null;
  return html`<div class="stack stack--loose admin">
    <${Summary} data=${data} rankMax=${rankMax} />
    <${RosterVersions} data=${data} rankMax=${rankMax} />
    <div class="grid-2 admin-pair">
      <${Backups} data=${data} setData=${setData} />
      <${GameData} blizzard=${data.blizzard} gameData=${data.gameData} setData=${setData} />
    </div>
    <${AuditLog} first=${data.audit} />
    ${data.isOwner ? html`<${FreshStart} guildName=${guild?.name} backupsEnabled=${data.backupsEnabled} onDone=${reload} />` : null}
  </div>`;
}

// ---------- summary tiles ----------

function Summary({ data, rankMax }) {
  const s = adminSummary(data, rankMax);
  return html`<div class="card admin-summary">
    <${Stat} label="On the roster" value=${number(s.characters)}
      hint=${s.characters ? `${s.online} online now · ${plural(s.officers, 'officer')} by rank` : 'No roster scan yet'} />
    <${Stat} label="Using Guild Camp" value=${number(s.people)} hint="Players this PC knows" />
    <${Stat} label="Need an update" value=${number(s.outdated)}
      hint=${s.outdated ? 'Older addon or app than the newest' : 'Nobody known to be behind'} />
    <${Stat} label="Last backup" value=${s.newestBackup ? html`<${TimeAgo} t=${s.newestBackup.created} />` : '—'}
      hint=${data.backupsEnabled ? `${plural(s.backups, 'copy', 'copies')} on this PC` : 'Backups are off'} />
  </div>`;
}

// ---------- roster and versions ----------

function RosterVersions({ data, rankMax }) {
  const [tab, setTab] = useState('roster');
  const latest = data.latest || {};
  const roster = data.roster || [];
  const members = data.members || [];

  const rosterColumns = useMemo(() => [
    {
      key: 'name', label: 'Character', sortable: true,
      render: (c) => html`<span class="row nowrap">
        ${c.online ? html`<span class="dot" title="Online now"></span>` : html`<span class="roster-dot-off" aria-hidden="true"></span>`}
        <${ClassName} name=${c.name} cls=${c.class} />
        ${c.level ? html`<span class="muted small">${c.level}</span>` : null}
        ${c.mine ? html`<${Pill} kind="accent">You<//>` : null}
      </span>`,
    },
    { key: 'rank_index', label: 'Rank', sortable: true, value: (c) => c.rank_index ?? null, render: (c) => c.rank || html`<span class="muted small">—</span>` },
    { key: 'role', label: 'Role', sortable: true, value: (c) => ROLE_ORDER[roleForRank(c.rank_index, rankMax)] ?? null, render: (c) => html`<${RolePill} role=${roleForRank(c.rank_index, rankMax)} />` },
    {
      key: 'last_seen', label: 'Seen', sortable: true,
      value: (c) => (c.online ? Number.MAX_SAFE_INTEGER : parseTime(c.last_seen)?.getTime() ?? null),
      render: (c) => (c.online ? html`<span class="ok-text">now</span>` : html`<${TimeAgo} t=${c.last_seen} never="—" />`),
    },
    { key: 'addon_version', label: 'Addon', render: (c) => html`<${VersionCell} v=${c.addon_version} outdated=${c.addonOutdated} latest=${latest.addon} />` },
  ], [rankMax, latest.addon]);

  const memberColumns = useMemo(() => [
    {
      key: 'battletag', label: 'Player', sortable: true, value: (m) => String(m.battletag || '').toLowerCase(),
      render: (m) => {
        const [name, tag] = splitTag(m.battletag);
        return html`<span class="admin-member"><strong>${name}</strong><span class="muted small">${tag}</span>${m.isMe ? html` <span class="muted small">(you)</span>` : null}</span>`;
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
  ], [latest.addon, latest.app]);

  const sub = [latest.addon && `addon ${latest.addon}`, latest.app && `app ${latest.app}`].filter(Boolean).join(' · ');
  return html`<${Card} id="admin-roster" title="Roster and versions" sub=${sub ? `Newest: ${sub}` : null} flush
      footer=${html`<div class="admin-legend">
        <span>What this PC knows. Guildmates' versions show up here once their addon shares them with yours.</span>
        <span><${Pill} kind="alarm">red<//> older than the newest version: they can update under Updates and Addon & sync</span>
      </div>`}>
    <div class="admin-tabs">
      <${Tabs} label="Roster and versions" value=${tab} onChange=${setTab} idPrefix="admin" tabs=${[
        { id: 'roster', label: 'Characters', count: roster.length || undefined },
        { id: 'people', label: 'Guild Camp players', count: members.length || undefined },
      ]} />
    </div>
    <div role="tabpanel" id=${`admin-${tab}-panel`} aria-labelledby=${`admin-${tab}`}>
      ${tab === 'roster'
        ? html`<${Table} columns=${rosterColumns} rows=${roster} rowKey=${(c) => c.name} dense
            empty=${html`<${Empty} compact icon="roster" title="No roster yet.">Open the guild roster in game, then log out or type /reload.<//>`} />`
        : html`<${Table} columns=${memberColumns} rows=${members} rowKey=${(m) => m.id} dense
            rowClass=${(m) => (m.neverSynced ? 'is-muted' : undefined)}
            empty="Nobody yet. Guildmates show up here once their addon shares with yours." />`}
    </div>
  <//>`;
}

// ---------- backups (of this PC's Guild Camp data) ----------

function Backups({ data, setData }) {
  const make = useAction(() => api.post('/api/admin/backups'));
  const list = data.backups || [];

  const makeNow = async () => {
    const r = await make.run();
    if (!r.ok) return;
    setData((d) => ({ ...d, backups: r.value.backups }));
    toast(r.value.message || 'Backup made.', 'ok');
  };
  const show = async (b) => {
    try { await gc.app.showItemInFolder(b.path); } catch (err) { toast(err?.message || "Couldn't show the backup.", 'alarm'); }
  };
  const openFolder = async () => {
    try {
      await gc.app.openPath(data.backupDir);
    } catch (err) {
      // The folder appears with the first backup.
      if (err?.status === 404) toast('There are no backups yet. Make one first.', 'warn');
      else toast(err?.message || "Couldn't open the backups folder.", 'alarm');
    }
  };

  const columns = [
    { key: 'file', label: 'Copy', render: (b) => html`<span class="admin-file" title=${b.path || b.file}>${b.file}</span>` },
    { key: 'size', label: 'Size', num: true, render: (b) => bytes(b.size) },
    { key: 'created', label: 'Made', render: (b) => html`<${TimeAgo} t=${b.created} />` },
    {
      key: 'show', label: html`<span class="sr">Show in folder</span>`, align: 'right',
      render: (b) => (b.path ? html`<${Button} size="sm" variant="ghost" icon="folder" label=${`Show ${b.file} in its folder`} onClick=${() => show(b)} />` : null),
    },
  ];

  return html`<${Card} id="admin-backups" title="Backups" sub="on this PC" flush
      actions=${data.backupsEnabled ? html`<${Button} size="sm" icon="plus" busy=${make.busy} onClick=${makeNow}>Make a backup now<//>` : null}
      footer=${data.backupsEnabled
        ? html`<div class="row row--between admin-backup-foot">
            <span>Guild Camp copies its data every day and keeps the last 14 copies. Guildmates keep their own.</span>
            ${data.backupDir ? html`<${Button} size="sm" variant="ghost" icon="folder" onClick=${openFolder}>Open backups folder<//>` : null}
          </div>`
        : null}>
    ${!data.backupsEnabled
      ? html`<div class="admin-pad"><${Notice} kind="info" title="Backups are off.">Guild Camp keeps its data in memory right now, so there is no file to copy.<//></div>`
      : html`<${Table} columns=${columns} rows=${list} rowKey=${(b) => b.file} dense
          empty=${html`<${Empty} compact icon="shield" title="No backups yet. The first one is made shortly after Guild Camp starts." />`} />`}
  <//>`;
}

// ---------- Blizzard and game data ----------

function Fact({ label, children }) {
  return html`<div class="admin-fact"><dt>${label}</dt><dd>${children}</dd></div>`;
}

function GameData({ blizzard = {}, gameData = {}, setData }) {
  const check = useAction(() => api.post('/api/admin/blizzard'));
  const refresh = useAction(() => api.post('/api/admin/gamedata/refresh'));
  const st = blizzard.status;
  const on = Boolean(blizzard.configured);

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

  let reach;
  if (!on) reach = html`<${Pill} kind="muted">Off in this copy<//>`;
  else if (!st) reach = html`<${Pill} kind="muted">Not checked yet<//>`;
  else reach = st.ok ? html`<${Pill} kind="ok" dot>Reachable<//>` : html`<${Pill} kind="alarm" dot>Not reachable<//>`;

  return html`<${Card} id="admin-blizzard" title="Blizzard game data"
      actions=${on ? html`<${Button} size="sm" icon="refresh" busy=${check.busy} onClick=${runCheck}>Check now<//>` : null}>
    ${!on ? html`<${Notice} kind="info" class="admin-gap-bottom">${`${blizzard.note || 'This copy of Guild Camp has no Battle.net app built in, so Blizzard game data is off.'} Everything else works without it.`}<//>` : null}
    <dl class="admin-facts">
      <${Fact} label="Game data API">${reach}<//>
      ${on ? html`<${Fact} label="WoW: Forever">${st && st.forever
        ? html`<span class="row"><${Pill} kind="ok">Available<//><span class="muted small">${st.forever}</span></span>`
        : html`<span class="muted">Not in Blizzard's API yet. Checked daily.</span>`}<//>` : null}
      ${st && st.tokenGold ? html`<${Fact} label=${`Retail token (${String(st.region || blizzard.region || '').toUpperCase()})`}>${number(st.tokenGold)}g<//>` : null}
      ${on ? html`<${Fact} label="Last checked">${st ? html`<${TimeAgo} t=${st.checkedAt} />` : html`<span class="muted">Shortly after Guild Camp starts.</span>`}<//>` : null}
      <${Fact} label="Item data">
        <span>${gameData.namespaces?.label || 'Nothing yet'}<span class="muted small"> · ${number(gameData.itemsKnown || 0)} items known</span></span>
      <//>
      <${Fact} label="Realm"><${RealmLine} status=${gameData.realm_status} realm=${gameData.realm} /><//>
      ${on ? html`<${Fact} label="Official guild list">${gameData.official_roster_note
        ? html`<span>${gameData.official_roster_note} <span class="muted small">· <${TimeAgo} t=${gameData.official_roster_at} /></span></span>`
        : html`<span class="muted">${gameData.liveData ? 'Not fetched yet.' : 'Arrives once Blizzard adds WoW: Forever.'}</span>`}<//>` : null}
    </dl>
    ${on ? html`<div class="form-actions admin-gap">
      <${Button} size="sm" icon="sync" busy=${refresh.busy} onClick=${runRefresh}>Refresh realm and guild list<//>
      <${Button} size="sm" variant="ghost" href="/guild-settings?section=realm">Realm settings<//>
    </div>` : null}
  <//>`;
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
      render: (a) => (a.battletag ? html`<strong title=${a.battletag}>${a.name}</strong>` : html`<span class="muted">Guild Camp</span>`),
    },
    { key: 'action', label: 'What', render: (a) => html`<span class="admin-action">${a.action}</span>` },
    { key: 'detail', label: 'Detail', class: 'wrap-cell', render: (a) => (a.detail ? html`<span class="muted">${a.detail}</span>` : null) },
  ];
  return html`<${Card} id="admin-audit" title="Audit log" sub="changes made in Guild Camp, newest first" flush
      footer=${next ? html`<${Button} size="sm" busy=${more.busy} onClick=${loadMore}>Load more<//>` : entries.length ? 'No older entries.' : null}>
    <${Table} columns=${columns} rows=${entries} dense empty="Nothing yet." />
  <//>`;
}

// ---------- fresh start (Guild Master) ----------

// What comes back after a fresh start (the core's reply says the same: docs/api/admin.md).
export const FRESH_START_HINT = 'Your unsent changes stay. Your characters, the roster and guild data shared in game come back '
  + 'after you log out or type /reload. Data from before the wipe is ignored if an old game folder (for example Retail '
  + 'testing) shows it again.';

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

  return html`<${Card} id="admin-reset" title="Fresh start" sub="Guild Master only" tone="alarm">
    <div class="admin-danger">
      <div>
        <p>Wipes the game data on this PC: characters, roster, raids and loot, bank, prices, drives, requests, calls to arms
          and activity. People, roles and settings stay. Guildmates' copies are not touched.</p>
        <p class="hint mb-0">${backupsEnabled ? 'A backup is made first. ' : ''}${FRESH_START_HINT}</p>
      </div>
      <${Button} variant="danger" icon="trash" onClick=${() => setOpen(true)}>Wipe game data…<//>
    </div>
    <${Modal} open=${open} title="Wipe the game data on this PC?" onClose=${close} dismissable=${!wipe.busy} size="sm"
      footer=${html`
        <${Button} variant="ghost" disabled=${wipe.busy} onClick=${close}>Cancel<//>
        <${Button} variant="danger" icon="trash" busy=${wipe.busy} disabled=${!matches} onClick=${go}>Wipe game data<//>`}>
      <div class="stack">
        <p class="mb-0">Everything synced to this PC is removed for a fresh start. ${backupsEnabled ? 'A backup is made first, so it can be restored.' : 'Guild Camp keeps its data in memory right now, so no backup can be made.'}</p>
        <${Input} label=${`Type “${name}” to confirm`} hint="Capital letters don't matter." value=${typed} onValue=${setTyped}
          autocomplete="off" spellcheck=${false} placeholder=${name}
          onKeyDown=${(e) => { if (e.key === 'Enter' && matches && !wipe.busy) go(); }} />
      </div>
    <//>
  <//>`;
}
