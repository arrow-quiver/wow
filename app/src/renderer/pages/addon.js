// "Addon & sync": the sync engine's state, the Guild Camp addon in every game folder (install, update, repair,
// remove), game folder management, what's new in the addon, recent uploads and the sync/addon log.
// Everything here is live: statuses arrive on the 'sync', 'addon', 'settings' and 'log' channels.
import { html, useState, useEffect, useMemo, useRef, useCallback } from '../lib/html.js';
import { gc, useGcEvent } from '../lib/gc.js';
import { useSyncStatus, useAddonStatus, describeSync, addonStatus as addonLive } from '../lib/status.js';
import { plural } from '../lib/format.js';
import {
  Page, Card, Table, Button, ConfirmButton, Checkbox, Notice, Pill, Empty, Loading, TimeAgo, LocalTime, Icon, toast,
} from '../components/index.js';

const LOG_LINES = 200;

// ---------- helpers (exported for tests) ----------

/**
 * The addon buttons a game folder gets, in order. "Open folder" is always there and not listed.
 * install · update · repair · uninstall
 */
export function installActions(inst, latest) {
  if (!inst) return [];
  if (inst.state === 'missing') return latest ? ['install'] : [];
  if (inst.damaged) return latest ? ['repair', 'uninstall'] : ['uninstall'];
  if (inst.state === 'outdated') return latest ? ['update', 'uninstall'] : ['uninstall'];
  return latest ? ['repair', 'uninstall'] : ['uninstall'];
}

/** Log lines shown on this page: the sync engine, the addon manager and game folder detection. */
export function isSyncOrAddonLine(line) {
  const scope = String((line && line.scope) || '');
  return /^(sync|addon|wow)(:|$)/.test(scope);
}

const normPath = (p) => String(p || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();

/** The custom folder (from settings.extraWowFolders) an install was found through, or null. */
export function customFolderFor(inst, folders) {
  if (!inst || !Array.isArray(folders)) return null;
  const root = normPath(inst.root);
  const dir = normPath(inst.dir);
  return folders.find((f) => {
    const n = normPath(f);
    return n && (n === root || n === dir || dir.startsWith(`${n}\\`));
  }) || null;
}

/** Custom folders where no game was found. */
export function unusedFolders(installs, folders) {
  if (!Array.isArray(folders)) return [];
  const used = new Set((installs || []).map((i) => customFolderFor(i, folders)).filter(Boolean));
  return folders.filter((f) => !used.has(f));
}

const RESULT_WORDS = [
  ['characters', 'character'], ['roster', 'roster row'], ['recipes', 'recipe'], ['prices', 'price'],
  ['inventory', 'bag item'], ['bank', 'bank item'], ['ctas', 'call to arms', 'calls to arms'],
];

/** "2 characters, 9 roster rows, 141 recipes" from a sync result; '' when there is nothing to say. */
export function describeResult(result) {
  if (!result || typeof result !== 'object') return '';
  return RESULT_WORDS
    .filter(([key]) => Number.isFinite(Number(result[key])) && result[key] !== null && result[key] !== '')
    .map(([key, one, many]) => plural(Number(result[key]), one, many))
    .join(', ');
}

const STATE_PILL = {
  missing: { kind: 'muted', label: 'Not installed' },
  outdated: { kind: 'warn', label: 'Update ready' },
  current: { kind: 'ok', label: 'Up to date' },
  newer: { kind: 'info', label: 'Newer than ours' },
};

const ACTION_TEXT = {
  install: { busy: 'Installing…', done: (v, label) => `Addon ${v} installed in ${label}. Start the game or type /reload to load it.` },
  update: { busy: 'Updating…', done: (v, label) => `Addon updated to ${v} in ${label}. Type /reload in the game to load it.` },
  repair: { busy: 'Repairing…', done: (v, label) => `Addon ${v} reinstalled in ${label}.` },
  uninstall: { busy: 'Removing…', done: (_v, label) => `Addon removed from ${label}.` },
};

const SCOPE_LABEL = (scope) => String(scope || '').replace(/:/g, ' · ');

function logTime(t) {
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ---------- page ----------

// Sections other pages can link to: /addon?section=games|activity|notes|log
const SECTIONS = ['summary', 'games', 'activity', 'notes', 'log'];

export default function AddonPage({ query = {} }) {
  const sync = useSyncStatus();
  const addon = useAddonStatus();
  const [settings, setSettings] = useState(null);
  const [info, setInfo] = useState(null);
  const [lines, setLines] = useState(null);
  const [pending, setPending] = useState({}); // dir → action, until the main process reports busy
  const [syncing, setSyncing] = useState(false);
  const [checking, setChecking] = useState(false);
  const [updatingAll, setUpdatingAll] = useState(false);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    let live = true;
    gc.settings.get().then((s) => live && setSettings(s), () => {});
    gc.app.info().then((i) => live && setInfo(i), () => {});
    gc.log.recent().then((all) => live && setLines((all || []).filter(isSyncOrAddonLine).slice(-LOG_LINES)), () => live && setLines([]));
    // The app checks for addon updates when it starts; if that hasn't happened yet, do it now so the page shows
    // what the server has.
    addonLive.refresh().then((s) => {
      if (live && s && !s.lastCheckAt && !s.checking) gc.addon.check().catch(() => {});
    });
    return () => { live = false; };
  }, []);

  // Scroll to a linked section once the cards above it have their content (so it doesn't move away again).
  const ready = Boolean(addon) && lines !== null;
  useEffect(() => {
    if (!ready || !SECTIONS.includes(query.section)) return;
    document.getElementById(`addon-${query.section}`)?.scrollIntoView({ block: 'start' });
  }, [ready, query.section]);

  useGcEvent('settings', (s) => { if (s && typeof s === 'object') setSettings(s); });
  useGcEvent('log', (line) => {
    if (isSyncOrAddonLine(line)) setLines((prev) => [...(prev || []), line].slice(-LOG_LINES));
  });

  const installs = addon?.installs || [];
  const latest = addon?.latest || null;
  const folders = settings?.extraWowFolders || [];
  const outdated = installs.filter((i) => i.state === 'outdated');
  const anyBusy = installs.some((i) => i.busy) || Object.keys(pending).length > 0;

  // ---- actions --------------------------------------------------------------------------------

  const runInstallAction = useCallback(async (inst, action) => {
    setPending((p) => ({ ...p, [inst.dir]: action }));
    try {
      const s = await gc.addon[action](inst.dir);
      const after = s?.installs?.find((i) => i.dir === inst.dir);
      const v = after?.installed?.version || latest?.version || '';
      toast(ACTION_TEXT[action].done(v, inst.label), 'ok');
    } catch (err) {
      toast(err?.message || 'That did not work. Please try again.', 'alarm');
    } finally {
      setPending((p) => { const next = { ...p }; delete next[inst.dir]; return next; });
      addonLive.refresh();
    }
  }, [latest?.version]);

  const syncNow = async () => {
    setSyncing(true);
    try {
      const s = await gc.sync.now();
      if (s?.state === 'error' && s.lastError) toast(s.lastError, 'alarm');
    } catch (err) {
      toast(err?.message || 'Sync did not start. Please try again.', 'alarm');
    } finally {
      setSyncing(false);
    }
  };

  const setSyncEnabled = async (on) => {
    try {
      await gc.sync.setEnabled(on);
      setSettings((s) => (s ? { ...s, syncEnabled: on } : s));
      toast(on ? 'Sync is on. Guild Camp uploads after you log out or type /reload.' : 'Sync is off. Nothing is uploaded until you turn it back on.', 'ok');
    } catch (err) {
      toast(err?.message || 'Could not change that setting.', 'alarm');
    }
  };

  const setAutoUpdate = async (on) => {
    try {
      setSettings(await gc.settings.set({ addonAutoUpdate: on }));
    } catch (err) {
      toast(err?.message || 'Could not change that setting.', 'alarm');
    }
  };

  const checkAddon = async () => {
    setChecking(true);
    try {
      const s = await gc.addon.check();
      if (s?.error) toast(s.error, 'warn');
      else {
        const behind = (s?.installs || []).filter((i) => i.state === 'outdated').length;
        toast(behind ? `Addon ${s.latest?.version} is ready for ${plural(behind, 'game folder')}.` : `The addon is up to date${s?.latest ? ` (${s.latest.version})` : ''}.`, 'ok');
      }
    } catch (err) {
      toast(err?.message || 'Could not check for addon updates.', 'alarm');
    } finally {
      setChecking(false);
    }
  };

  const updateAll = async () => {
    setUpdatingAll(true);
    try {
      await gc.addon.updateAll();
      toast(`Addon updated to ${latest?.version || 'the newest version'}. Type /reload in the game to load it.`, 'ok');
    } catch (err) {
      toast(err?.message || 'Could not update the addon.', 'alarm');
    } finally {
      setUpdatingAll(false);
      addonLive.refresh();
    }
  };

  const addFolder = async () => {
    setAdding(true);
    try {
      const dir = await gc.app.pickFolder({ title: 'Choose your World of Warcraft folder' });
      if (!dir) return;
      const before = installs.length;
      const found = await gc.wow.addFolder(dir);
      const s = await addonLive.refresh();
      const count = (s?.installs || found || []).length;
      if (count > before) toast(`Found ${plural(count - before, 'game folder')} there.`, 'ok');
      else toast("No game was found in that folder. Pick the folder that holds _forever_ or _retail_.", 'warn');
    } catch (err) {
      toast(err?.message || 'Could not add that folder.', 'alarm');
    } finally {
      setAdding(false);
    }
  };

  const removeFolder = async (folder) => {
    try {
      await gc.wow.removeFolder(folder);
      await addonLive.refresh();
      toast('Folder removed from the list. Its files were not touched.', 'ok');
    } catch (err) {
      toast(err?.message || 'Could not remove that folder.', 'alarm');
    }
  };

  const openFolder = async (inst) => {
    try { await gc.addon.openFolder(inst.dir); } catch (err) { toast(err?.message || 'Could not open that folder.', 'alarm'); }
  };

  const openLog = async () => {
    try { await gc.app.openPath(info.logFile); } catch (err) { toast(err?.message || 'Could not open the log file.', 'alarm'); }
  };

  // ---- render ---------------------------------------------------------------------------------

  const actions = html`
    <${Button} icon="refresh" busy=${checking || addon?.checking} onClick=${checkAddon}>Check for addon updates<//>
    <${Button} variant="primary" icon="sync" busy=${syncing || sync?.state === 'syncing'}
      disabled=${!sync || sync.state === 'signed-out' || sync.state === 'off'} onClick=${syncNow}>Sync now<//>`;

  return html`<${Page} title="Addon & sync" actions=${actions}
      lede="Guild Camp keeps the Guild Camp addon up to date in each game folder, and uploads what it saves when you log out or type /reload.">
    <div class="grid-2 addon-summary" id="addon-summary">
      <${SyncCard} sync=${sync} settings=${settings} onToggle=${setSyncEnabled} />
      <${AddonCard} addon=${addon} settings=${settings} outdated=${outdated} busy=${updatingAll || anyBusy}
        updatingAll=${updatingAll} onUpdateAll=${updateAll} onToggle=${setAutoUpdate} />
    </div>

    <section class="stack" id="addon-games" aria-labelledby="addon-games-title">
      <div class="row row--between">
        <h2 id="addon-games-title" class="addon-section-title">Game folders</h2>
        <${Button} icon="folder" busy=${adding} onClick=${addFolder}>Add a game folder<//>
      </div>
      ${!addon ? html`<${Loading} label="Looking for World of Warcraft…" />` : null}
      ${addon && !installs.length ? html`<${NoGame} onAdd=${addFolder} adding=${adding} />` : null}
      ${installs.length ? html`<div class="addon-installs">
        ${installs.map((inst) => html`<${InstallCard} key=${inst.dir} inst=${inst} latest=${latest}
          pending=${pending[inst.dir]} custom=${customFolderFor(inst, folders)}
          onAction=${runInstallAction} onOpen=${openFolder} onRemoveFolder=${removeFolder} />`)}
      </div>` : null}
      ${unusedFolders(installs, folders).map((f) => html`<${Notice} key=${f} kind="warn" title="No game found in a folder you added.">
        <div class="addon-folder-line"><code>${f}</code></div>
        <div class="row">
          <span>Pick the folder that holds <code>_forever_</code> or <code>_retail_</code> instead.</span>
          <${Button} size="sm" icon="minus" onClick=${() => removeFolder(f)}>Remove from the list<//>
        </div><//>`)}
    </section>

    <div class="cols">
      <${ActivityCard} sync=${sync} />
      <${WhatsNewCard} addon=${addon} />
    </div>

    <${LogCard} lines=${lines} info=${info} onOpen=${openLog} />
  <//>`;
}

// ---------- summary cards ----------

function SyncCard({ sync, settings, onToggle }) {
  const d = describeSync(sync);
  const enabled = settings ? settings.syncEnabled !== false : sync?.enabled !== false;
  const result = describeResult(sync?.lastResult);
  return html`<${Card} title="Sync" class="addon-card">
    <div class="stack">
      <div class="addon-big">
        <${Pill} kind=${d.kind} dot>${d.label}<//>
        ${sync?.lastSyncAt ? html`<span class="muted">Last upload <${TimeAgo} t=${sync.lastSyncAt} /></span>` : null}
      </div>
      ${result ? html`<p class="hint mb-0">Last upload had ${result}.</p>` : null}
      ${sync?.state === 'error' && sync.lastError ? html`<${Notice} kind="alarm" title="The last upload failed.">
        ${sync.lastError}${sync.nextRetryAt ? html` Trying again <${TimeAgo} t=${sync.nextRetryAt} />.` : null}<//>` : null}
      ${sync?.state === 'signed-out' ? html`<${Notice} kind="info">Sign in to sync your characters with the guild.
        <${Button} size="sm" variant="ghost" href="/welcome">Sign in<//><//>` : null}
      ${sync?.state === 'no-game' ? html`<${Notice} kind="warn">Guild Camp can't find World of Warcraft. Add your game folder below.<//>` : null}
      ${sync && !['error', 'signed-out', 'no-game', 'off'].includes(sync.state) && !sync.lastSyncAt
        ? html`<p class="hint mb-0">Log out of a character or type <code>/reload</code> in the game, and Guild Camp uploads within a few seconds.</p>` : null}
      <${Checkbox} label="Sync while Guild Camp is running" checked=${enabled} disabled=${!sync} onValue=${onToggle}
        hint="Uploads your characters, professions and the guild roster after each /reload, and brings guild news back into the game." />
    </div>
  <//>`;
}

function AddonCard({ addon, settings, outdated, busy, updatingAll, onUpdateAll, onToggle }) {
  if (!addon) return html`<${Card} title="Addon" class="addon-card"><${Loading} label="Checking the addon…" /><//>`;
  const { latest, installs = [] } = addon;
  const withAddon = installs.filter((i) => i.state !== 'missing').length;
  const auto = settings ? settings.addonAutoUpdate !== false : addon.autoUpdate;
  const source = latest?.source === 'remote' ? 'from the guild server' : 'built into Guild Camp';
  return html`<${Card} title="Addon" class="addon-card"
      actions=${outdated.length ? html`<${Button} size="sm" variant="primary" icon="download" busy=${updatingAll} disabled=${busy && !updatingAll}
        onClick=${onUpdateAll}>${outdated.length === 1 ? 'Update' : `Update all (${outdated.length})`}<//>` : null}>
    <div class="stack">
      <div class="addon-big">
        ${latest
          ? html`<span><span class="muted">Newest</span> <strong class="addon-version">${latest.version}</strong> <span class="muted">${source}</span></span>`
          : html`<span class="muted">No addon is available yet.</span>`}
      </div>
      ${installs.length ? html`<p class="hint mb-0">
        ${withAddon ? `Installed in ${withAddon} of ${plural(installs.length, 'game folder')}. ` : "Not installed in any game folder yet. "}
        ${outdated.length ? html`<strong>${plural(outdated.length, 'copy', 'copies')} can be updated.</strong>` : withAddon ? 'All up to date.' : null}
        ${addon.lastCheckAt ? html` Checked <${TimeAgo} t=${addon.lastCheckAt} />.` : null}</p>` : null}
      ${addon.error ? html`<${Notice} kind="warn" title="Couldn't check the server for addon updates.">
        ${addon.error}${addon.bundled ? ` Guild Camp can still install the addon it came with (${addon.bundled.version}).` : ''}<//>` : null}
      <${Checkbox} label="Update the addon automatically" checked=${auto} onValue=${onToggle}
        hint="Guild Camp checks every hour and updates game folders that already have the addon. It never installs it anywhere new." />
    </div>
  <//>`;
}

// ---------- game folders ----------

function NoGame({ onAdd, adding }) {
  return html`<${Empty} icon="game" title="World of Warcraft wasn't found."
      action=${html`<${Button} variant="primary" icon="folder" busy=${adding} onClick=${onAdd}>Add a game folder<//>`}>
    Guild Camp looked for a <code>World of Warcraft</code> folder in the usual places on every drive: Program Files,
    Program Files (x86), Games, Battle.net and the top of the drive. If your game is somewhere else, add its folder:
    the one that holds <code>_forever_</code> or <code>_retail_</code>.
  <//>`;
}

function InstallCard({ inst, latest, pending, custom, onAction, onOpen, onRemoveFolder }) {
  const action = inst.action || pending || null;
  const busy = Boolean(inst.busy || pending);
  const pill = inst.damaged ? { kind: 'alarm', label: 'Needs repair' } : STATE_PILL[inst.state] || STATE_PILL.missing;
  const list = installActions(inst, latest);
  const have = inst.installed?.version;

  const button = (name) => {
    const isBusy = busy && action === name;
    const off = busy && !isBusy;
    if (name === 'install') {
      return html`<${Button} key=${name} variant="primary" size="sm" icon="download" busy=${isBusy} disabled=${off}
        onClick=${() => onAction(inst, 'install')}>${isBusy ? ACTION_TEXT.install.busy : `Install addon ${latest.version}`}<//>`;
    }
    if (name === 'update') {
      return html`<${Button} key=${name} variant="primary" size="sm" icon="download" busy=${isBusy} disabled=${off}
        onClick=${() => onAction(inst, 'update')}>${isBusy ? ACTION_TEXT.update.busy : `Update to ${latest.version}`}<//>`;
    }
    if (name === 'repair') {
      // On a newer copy (a test build, say) repairing means going back to the published version: ask first.
      if (inst.state === 'newer' && !isBusy) {
        return html`<${ConfirmButton} key=${name} size="sm" icon="refresh" disabled=${off} confirmVariant="primary"
          question=${`Replace ${have} with ${latest.version}?`} onConfirm=${() => onAction(inst, 'repair')}>Reinstall ${latest.version}<//>`;
      }
      return html`<${Button} key=${name} variant=${inst.damaged ? 'primary' : 'secondary'} size="sm" icon="refresh" busy=${isBusy} disabled=${off}
        title="Reinstall the addon files, for when something in the game looks broken."
        onClick=${() => onAction(inst, 'repair')}>${isBusy ? ACTION_TEXT.repair.busy : 'Repair'}<//>`;
    }
    if (name === 'uninstall') {
      if (isBusy) return html`<${Button} key=${name} size="sm" busy>${ACTION_TEXT.uninstall.busy}<//>`;
      return html`<${ConfirmButton} key=${name} size="sm" variant="ghost" icon="trash" disabled=${off}
        question=${`Remove the addon from ${inst.label}?`} yes="Remove" onConfirm=${() => onAction(inst, 'uninstall')}>Uninstall<//>`;
    }
    return null;
  };

  return html`<${Card} class=${`addon-install ${inst.state === 'outdated' || inst.damaged ? 'card--accent' : ''}`}
      title=${html`<span class="addon-install-title"><${Icon} name="game" />${inst.label}</span>`}
      actions=${html`<${Pill} kind=${pill.kind} dot>${pill.label}<//>`}
      footer=${html`<div class="actions-row">
        ${list.map(button)}
        <span class="spacer"></span>
        <${Button} size="sm" variant="ghost" icon="folder" onClick=${() => onOpen(inst)}>Open folder<//>
        ${custom ? html`<${ConfirmButton} size="sm" variant="ghost" icon="minus" disabled=${busy} confirmVariant="primary"
          title=${`Stop looking in ${custom}. Nothing is deleted.`}
          question="Stop using this folder?" yes="Remove" onConfirm=${() => onRemoveFolder(custom)}>Remove folder<//>` : null}
      </div>`}>
    <div class="stack stack--tight">
      <div class="addon-install-body">
        <div class="addon-install-where">
          <span class="addon-install-path" title=${inst.dir}>${inst.dir}</span>
          <span class="hint">${custom ? 'In a folder you added.' : 'Found automatically.'}</span>
        </div>
        <dl class="addon-versions">
          <div><dt>Installed</dt><dd>${inst.damaged ? html`<span class="warn-text">damaged</span>` : have || html`<span class="muted">not installed</span>`}</dd></div>
          <div><dt>Newest</dt><dd>${latest?.version || html`<span class="muted">none yet</span>`}</dd></div>
        </dl>
      </div>
      ${inst.damaged && !busy ? html`<${Notice} kind="warn">The addon folder is missing its WowGuild.toc file, so the game won't load it. Repair puts it back.<//>` : null}
      ${inst.error && !busy ? html`<${Notice} kind="alarm" title="The last change didn't work.">${inst.error}<//>` : null}
    </div>
  <//>`;
}

// ---------- activity, what's new, log ----------

const fileError = (f) => f.lastError || f.error || null;

/** A saved-variables path shown from its game folder: "WTF\Account\NAME\SavedVariables\WowGuild.lua". */
export function shortFile(file, install) {
  const f = String(file || '');
  const base = String(install || '').replace(/[\\/]+$/, '');
  if (!base) return f;
  const lower = f.toLowerCase();
  const prefix = base.toLowerCase();
  return lower.startsWith(`${prefix}\\`) || lower.startsWith(`${prefix}/`) ? f.slice(base.length + 1) : f;
}

function fileStatus(f) {
  const err = fileError(f);
  if (err) return html`<${Pill} kind="alarm" title=${err}>Problem<//>`;
  if (f.lastUploadAt) return html`<${Pill} kind="ok">Uploaded<//>`;
  return html`<${Pill} kind="muted">Waiting<//>`;
}

const RECENT_KIND = { upload: 'Upload', inbox: 'Guild news', coach: 'Coach answer' };

function ActivityCard({ sync }) {
  const files = sync?.files || [];
  // sync.recent is newest first.
  const recent = Array.isArray(sync?.recent) ? sync.recent.slice(0, 8) : [];
  const columns = [
    { key: 'account', label: 'Account', sortable: true, render: (f) => html`<div class="addon-file">
        <strong>${f.account || 'Unknown account'}</strong>
        <span class="addon-file-path" title=${f.file}>${shortFile(f.file, f.install)}</span>
      </div>` },
    { key: 'label', label: 'Game', sortable: true, value: (f) => f.label || f.install, render: (f) => html`<span class="nowrap">${f.label || f.install || '—'}</span>` },
    { key: 'lastUploadAt', label: 'Last upload', sortable: true, render: (f) => html`<${TimeAgo} t=${f.lastUploadAt} never="Not yet" />` },
    { key: 'status', label: 'Status', render: (f) => html`<div class="stack stack--tight">${fileStatus(f)}
        ${fileError(f) ? html`<span class="hint addon-file-error">${fileError(f)}${f.nextRetryAt ? html` Trying again <${TimeAgo} t=${f.nextRetryAt} />.` : null}</span>` : null}</div>` },
  ];
  return html`<${Card} id="addon-activity" title="Recent sync activity" sub=${files.length ? plural(files.length, 'saved file') : null} flush>
    ${!sync ? html`<${Loading} />` : html`<${Table} columns=${columns} rows=${files} rowKey=${(f) => f.file}
        sort=${{ key: 'lastUploadAt', dir: 'desc' }}
        empty=${html`<${Empty} compact icon="sync" title="No saved game data yet.">
          Once the addon is installed, log in to a character and type <code>/reload</code>. Each account's file shows up here.<//>`} />`}
    ${recent.length ? html`<ul class="list-lines addon-recent" aria-label="Latest sync events">
      ${recent.map((r, i) => {
        const bad = r.ok === false || Boolean(r.error);
        const where = [r.account, r.label].filter(Boolean).join(' · ');
        return html`<li key=${i} class="row nowrap">
          <${Icon} name=${bad ? 'alert' : 'ok'} class=${bad ? 'addon-recent-bad' : 'addon-recent-ok'} />
          <span class="addon-recent-kind">${RECENT_KIND[r.kind] || 'Sync'}</span>
          <span class="ellipsis" title=${r.message || ''}>${r.message || r.error || (bad ? 'Failed.' : 'Done.')}</span>
          <span class="spacer"></span>
          ${where ? html`<span class="hint nowrap">${where}</span>` : null}
          <span class="hint nowrap"><${TimeAgo} t=${r.at || r.t} /></span>
        </li>`;
      })}
    </ul>` : null}
  <//>`;
}

function WhatsNewCard({ addon }) {
  const remote = addon?.remote;
  const notes = String(remote?.notes || '').split(/\r?\n/).map((l) => l.replace(/^\s*[-*•]\s*/, '').trim()).filter(Boolean);
  return html`<${Card} id="addon-notes" title=${remote ? `What's new in ${remote.version}` : "What's new"}
      sub=${remote?.publishedAt ? html`<${LocalTime} t=${remote.publishedAt} style="day" />` : null}>
    ${!addon ? html`<${Loading} />` : null}
    ${addon && notes.length ? html`<ul class="addon-notes">${notes.map((n, i) => html`<li key=${i}>${n}</li>`)}</ul>` : null}
    ${addon && remote && !notes.length ? html`<p class="muted mb-0">No notes came with this version.</p>` : null}
    ${addon && !remote ? html`<p class="muted mb-0">${addon.bundled
      ? `You have the addon that came with Guild Camp (${addon.bundled.version}). Notes show here when the guild publishes an update.`
      : 'Notes show here when the guild publishes an addon update.'}</p>` : null}
  <//>`;
}

function LogCard({ lines, info, onOpen }) {
  const box = useRef(null);
  const stick = useRef(true);
  const shown = lines || [];
  // Follow new lines while scrolled to the bottom; leave the view alone when someone is reading further up.
  useEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [shown.length]);
  const onScroll = (e) => {
    const el = e.currentTarget;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };
  const problems = useMemo(() => shown.filter((l) => l.level !== 'info').length, [shown]);
  return html`<${Card} id="addon-log" title="Sync and addon log" sub=${problems ? plural(problems, 'warning') : null} flush
      actions=${info?.logFile ? html`<${Button} size="sm" icon="external" onClick=${onOpen}>Open log file<//>` : null}>
    ${lines === null ? html`<${Loading} />` : null}
    ${lines && !lines.length ? html`<${Empty} compact icon="info" title="Nothing logged yet." />` : null}
    ${shown.length ? html`<div class="addon-log" ref=${box} onScroll=${onScroll} role="log" aria-label="Sync and addon log" tabindex="0">
      ${shown.map((l, i) => html`<div key=${`${l.t}-${i}`} class=${`addon-log-line addon-log-line--${l.level}`}>
        <time class="addon-log-time" datetime=${l.t}>${logTime(l.t)}</time>
        <span class="addon-log-scope">${SCOPE_LABEL(l.scope)}</span>
        <span class="addon-log-msg">${l.msg}</span>
      </div>`)}
    </div>` : null}
    ${info?.logFile ? html`<p class="hint addon-log-file">Full log: <code>${info.logFile}</code>. Send this file when asking for help with sync.</p>` : null}
  <//>`;
}
