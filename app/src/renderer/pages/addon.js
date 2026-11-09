// "Addon & sync": the sync engine's state, sharing in game (what waits to go out, what the game didn't send,
// changes in my name this PC didn't make), the Guild Camp addon in every game folder (install, update, repair,
// remove), game folder management, what's new in the addon, recent syncs and the sync/addon log.
// Sync means: Guild Camp reads what the addon saved (WowGuildDB, written when you log out or type /reload) into
// its own data on this PC, and writes my changes back for the addon (WowGuild_Inbox, read at login or /reload),
// which shares them with guildmates in game (docs/SHARING.md).
// Everything here is live: statuses arrive on the 'sync', 'addon', 'settings' and 'log' channels; sharing comes
// from GET /api/share/status (lib/status.js shareStatus).
import { html, cx, useState, useEffect, useMemo, useRef, useCallback } from '../lib/html.js';
import { gc, useGcEvent } from '../lib/gc.js';
import { api } from '../lib/api.js';
import {
  useSyncStatus, useAddonStatus, describeSync, addonStatus as addonLive,
  useShareStatus, shareStatus as shareLive, shareGroups, shareStateLabel, readyLine, needsGameRestart, SHARE_LINES,
} from '../lib/status.js';
import { plural, number } from '../lib/format.js';
import {
  Page, Card, Table, Button, ConfirmButton, Checkbox, Notice, Pill, Empty, Loading, TimeAgo, LocalTime, Icon, Stat, toast,
} from '../components/index.js';
import { AuthorChecks } from '../components/AuthorChecks.js';
import { NoGuild } from '../components/NoGuild.js';
import { refreshSession } from '../lib/session.js';

const LOG_LINES = 200;

// ---------- helpers (exported for tests) ----------

/**
 * The addon buttons a game folder gets, in order. "Open folder" is always there and not listed.
 * install · update · repair · uninstall
 */
export function installActions(inst, latest) {
  if (!inst) return [];
  // Another game, not turned on: Guild Camp leaves it alone (only removing a copy already there is offered).
  if (inst.inUse === false) return inst.state === 'missing' ? [] : ['uninstall'];
  if (inst.state === 'missing') return latest ? ['install'] : [];
  if (inst.damaged) return latest ? ['repair', 'uninstall'] : ['uninstall'];
  if (inst.state === 'outdated') return latest ? ['update', 'uninstall'] : ['uninstall'];
  return latest ? ['repair', 'uninstall'] : ['uninstall'];
}

/** settings.otherGameFolders with `dir` turned on or off (paths compare like Windows does). */
export function withOtherFolder(list, dir, on) {
  const rest = (Array.isArray(list) ? list : []).filter((d) => normPath(d) !== normPath(dir));
  return on ? [...rest, dir] : rest;
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

// The game reads new addon folders and each addon's file list only when it starts, so some changes need a restart
// (the main process says restartNeeded).
export const RESTART_LINE = "Restart World of Warcraft to load it. A /reload isn't enough this time.";

const ACTION_TEXT = {
  install: { busy: 'Installing…', done: (v, label) => `Addon ${v} installed in ${label}. Start the game to load it.` },
  update: { busy: 'Updating…', done: (v, label) => `Addon updated to ${v} in ${label}. Type /reload in the game to load it.` },
  repair: { busy: 'Repairing…', done: (v, label) => `Addon ${v} reinstalled in ${label}.` },
  uninstall: { busy: 'Removing…', done: (_v, label) => `Addon removed from ${label}.` },
};

/** The toast after an addon change in one game folder; restartNeeded comes from the main process. */
export function actionDoneText(action, version, label, restartNeeded = false) {
  const words = ACTION_TEXT[action];
  if (!words) return 'Done.';
  if (restartNeeded && action !== 'uninstall') {
    return action === 'update'
      ? `Addon updated to ${version} in ${label}. ${RESTART_LINE}`
      : `Addon ${version} ${action === 'install' ? 'installed' : 'reinstalled'} in ${label}. ${RESTART_LINE}`;
  }
  return words.done(version, label);
}

/** The toast after "Update all" (Addon & sync and Updates pages). */
export function updateAllText(version, restartNeeded = false) {
  return `Addon updated to ${version || 'the newest version'}. ${restartNeeded ? RESTART_LINE : 'Type /reload in the game to load it.'}`;
}

/**
 * The Sync card's notice while a news folder made during the running game session waits for a game restart
 * (sync status restartNeeded and restartFolders); '' otherwise.
 */
export function restartNoticeText(sync) {
  if (!needsGameRestart(sync)) return '';
  const folders = Array.isArray(sync.restartFolders) ? sync.restartFolders : [];
  const labels = [...new Set(folders.map((f) => f && f.label).filter((l) => typeof l === 'string' && l))];
  const where = labels.length ? ` in ${labels.join(' and ')}` : '';
  return `Guild Camp added its news folder${where} while the game was running. Restart World of Warcraft to load it. A /reload isn't enough the first time. Your changes for the guild wait until then.`;
}

/** A game folder whose automatic install or update waits for World of Warcraft to close, as one line; '' otherwise. */
export function waitingText(inst) {
  if (!inst || !inst.waitingForGame) return '';
  return inst.state === 'missing'
    ? 'Guild Camp installs the addon here once World of Warcraft is closed. You can also install it now.'
    : 'Guild Camp updates the addon here once World of Warcraft is closed. You can also update it now.';
}

const SCOPE_LABEL = (scope) => String(scope || '').replace(/:/g, ' · ');

function logTime(t) {
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ---------- page ----------

// Sections other pages can link to: /addon?section=sharing|games|activity|notes|log
const SECTIONS = ['summary', 'sharing', 'games', 'activity', 'notes', 'log'];

export default function AddonPage({ query = {} }) {
  const sync = useSyncStatus();
  const addon = useAddonStatus();
  const share = useShareStatus();
  const groups = shareGroups(share?.data);
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
    // the newest version on GitHub.
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
  const outdated = installs.filter((i) => i.state === 'outdated' && i.inUse !== false);
  const anyBusy = installs.some((i) => i.busy) || Object.keys(pending).length > 0;

  // ---- actions --------------------------------------------------------------------------------

  const runInstallAction = useCallback(async (inst, action) => {
    setPending((p) => ({ ...p, [inst.dir]: action }));
    try {
      const s = await gc.addon[action](inst.dir);
      const after = s?.installs?.find((i) => i.dir === inst.dir);
      const v = after?.installed?.version || latest?.version || '';
      toast(actionDoneText(action, v, inst.label, Boolean(s?.restartNeeded)), 'ok');
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
      toast(on ? 'Sync is on. Guild Camp reads the game data after you log out or type /reload.' : 'Sync is off. Guild Camp stops reading the game data and sending guild news until you turn it back on.', 'ok');
    } catch (err) {
      toast(err?.message || 'Could not change that setting.', 'alarm');
    }
  };

  const setFolderInUse = async (inst, on) => {
    try {
      setSettings(await gc.settings.set({ otherGameFolders: withOtherFolder(settings?.otherGameFolders, inst.dir, on) }));
      toast(on ? `Guild Camp now syncs ${inst.label} too.` : `Guild Camp leaves ${inst.label} alone now.`, 'ok');
      try { await addonLive.refresh(); } catch { /* the next status event brings it */ }
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
        const behind = (s?.installs || []).filter((i) => i.state === 'outdated' && i.inUse !== false).length;
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
      const s = await gc.addon.updateAll();
      toast(updateAllText(latest?.version, Boolean(s?.restartNeeded)), 'ok');
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
      disabled=${!sync || sync.state === 'off' || sync.state === 'no-game'} onClick=${syncNow}>Sync now<//>`;

  return html`<${Page} title="Addon & sync" actions=${actions}
      lede="Guild Camp keeps the addon up to date in each game folder. It reads what the addon saves when you log out or type /reload, and hands your changes back to the game, which shares them with your guild.">
    <${AuthorChecks} checks=${groups.checks} />
    <div class="grid-2 addon-summary" id="addon-summary">
      <${SyncCard} sync=${sync} settings=${settings} onToggle=${setSyncEnabled} />
      <${AddonCard} addon=${addon} settings=${settings} outdated=${outdated} busy=${updatingAll || anyBusy}
        updatingAll=${updatingAll} onUpdateAll=${updateAll} onToggle=${setAutoUpdate} />
    </div>

    <${SharingCard} share=${share} groups=${groups} />

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
          onAction=${runInstallAction} onOpen=${openFolder} onRemoveFolder=${removeFolder} onUse=${setFolderInUse} />`)}
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

// ---------- summary cards (SyncCard and ShareSection are exported for tests) ----------

// No character has a guild saved, but the roster scan named one: ask before Guild Camp sets it up.
export function RosterGuildOffer({ note, offer }) {
  const [busy, setBusy] = useState(false);
  const accept = async () => {
    setBusy(true);
    try {
      await api.post('/api/sync/roster-guild', { name: offer.name });
      await refreshSession();
      try { await gc.sync.now(); } catch { /* the guild is set up; the next /reload syncs it */ }
      toast(`Guild Camp set up ${offer.name}.`, 'ok');
    } catch (err) {
      toast(err?.message || `Could not set up ${offer.name}.`, 'alarm');
    } finally { setBusy(false); }
  };
  return html`<${Notice} kind="info" title=${`Is ${offer.name} your guild?`}>
    ${note} If that's your guild, Guild Camp can set it up now.
    <div class="roster-guild-action"><${Button} size="sm" variant="primary" icon="camp" busy=${busy} onClick=${accept}>Use ${offer.name}<//></div>
  <//>`;
}

export function SyncCard({ sync, settings, onToggle }) {
  const d = describeSync(sync);
  const enabled = settings ? settings.syncEnabled !== false : sync?.enabled !== false;
  const result = describeResult(sync?.lastResult);
  const guild = sync?.lastResult?.guild?.name || null;
  return html`<${Card} title="Sync" class="addon-card">
    <div class="stack">
      <div class="addon-big">
        <${Pill} kind=${d.kind} dot>${d.label}<//>
        ${sync?.lastSyncAt ? html`<span class="muted">Last sync <${TimeAgo} t=${sync.lastSyncAt} /></span>` : null}
      </div>
      ${result ? html`<p class="hint mb-0">Last sync had ${result}${guild ? ` for ${guild}` : ''}.</p>` : null}
      ${sync?.state === 'error' && sync.lastError ? html`<${Notice} kind="alarm" title="The last sync failed.">
        ${sync.lastError}${sync.nextRetryAt ? html` Trying again <${TimeAgo} t=${sync.nextRetryAt} />.` : null}<//>` : null}
      ${sync?.guildNote && sync.state !== 'error' ? (sync.guildOffer?.name
        ? html`<${RosterGuildOffer} note=${sync.guildNote} offer=${sync.guildOffer} />`
        : html`<${Notice} kind="info" title="Waiting for your guild.">${sync.guildNote}<//>`) : null}
      ${sync?.state === 'no-game' ? html`<${Notice} kind="warn">Guild Camp can't find World of Warcraft. Add your game folder below.<//>` : null}
      ${restartNoticeText(sync) && sync.state !== 'off' ? html`<${Notice} kind="info">${restartNoticeText(sync)}<//>` : null}
      ${sync && !['error', 'no-game', 'off'].includes(sync.state) && !sync.lastSyncAt && !sync.guildNote
        ? html`<p class="hint mb-0">Log out of a character or type <code>/reload</code> in the game, and Guild Camp syncs within a few seconds.</p>` : null}
      <${Checkbox} label="Sync while Guild Camp is running" checked=${enabled} disabled=${!sync} onValue=${onToggle}
        hint="Reads your characters, professions and guild data after each /reload, and hands your changes back to the addon to share with your guild." />
    </div>
  <//>`;
}

function AddonCard({ addon, settings, outdated, busy, updatingAll, onUpdateAll, onToggle }) {
  if (!addon) return html`<${Card} title="Addon" class="addon-card"><${Loading} label="Checking the addon…" /><//>`;
  const { latest, installs = [] } = addon;
  const withAddon = installs.filter((i) => i.state !== 'missing').length;
  const auto = settings ? settings.addonAutoUpdate !== false : addon.autoUpdate;
  const source = latest?.source === 'remote' ? 'on GitHub' : 'built into Guild Camp';
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
      ${addon.error ? html`<${Notice} kind="warn" title="Couldn't check GitHub for addon updates.">
        ${addon.error}${addon.bundled ? ` Guild Camp can still install the addon it came with (${addon.bundled.version}).` : ''}<//>` : null}
      <${Checkbox} label="Update the addon automatically" checked=${auto} onValue=${onToggle}
        hint="Guild Camp checks every hour and updates game folders that already have the addon, while World of Warcraft is closed. It never installs it anywhere new." />
    </div>
  <//>`;
}

// ---------- sharing in game ----------

// How many entries a list shows before "Show all".
const SHARE_LIST_MAX = 8;

function SharingCard({ share, groups }) {
  const data = share && share.data;
  const on = Boolean(data && data.enabled);
  const pill = !data ? null : on ? html`<${Pill} kind="ok" dot>On<//>` : html`<${Pill} kind="muted" dot>Not started yet<//>`;
  let body;
  if (!share) body = html`<${Loading} label="Reading what is shared…" />`;
  else if (share.noGuild) body = html`<${NoGuild} compact here error=${share.error} />`;
  else if (!data) {
    body = html`<${Notice} kind="warn" title="Guild Camp couldn't read what is shared.">
      ${share.error?.message || 'Please try again.'}
      <div class="share-retry"><${Button} size="sm" icon="refresh" onClick=${() => shareLive.refresh()}>Try again<//></div>
    <//>`;
  } else {
    body = html`<div class="stack">
      <div class="share-stats">
        <${Stat} label="Guildmates heard" value=${number(data.peers || 0)} />
        <${Stat} label="Records" value=${number(data.records || 0)} />
        <${Stat} label="Last exchange" value=${html`<${TimeAgo} t=${data.lastExchange} never="Not yet" />`} />
      </div>
      <p class="hint mb-0">${on
        ? SHARE_LINES.newData
        : 'Nothing shared yet. Log in to the game with the Guild Camp addon, then log out or type /reload. The numbers show here after that.'}</p>
      <${ShareSection} title="Waiting to go out" entries=${groups.waiting} cancel
        empty="Nothing is waiting. Changes you make in Guild Camp show here until the game sends them." />
      ${groups.refused.length ? html`<${ShareSection} title="Not sent" entries=${groups.refused} kind="refused" />` : null}
      ${groups.sent.length ? html`<${ShareSection} title="Sent in the last day" entries=${groups.sent} kind="sent" folded />` : null}
    </div>`;
  }
  return html`<${Card} id="addon-sharing" title="Sharing in game" class="share-card" actions=${pill}>${body}<//>`;
}

export function ShareSection({ title, entries, empty, cancel = false, kind = 'waiting', folded = false }) {
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState(!folded);
  const shown = all ? entries : entries.slice(0, SHARE_LIST_MAX);
  const head = html`<span>${title}</span>${entries.length ? html` <span class="share-count">${entries.length}</span>` : null}`;
  // "Saved. It goes to your guild …" is every ready change's note: say it once above the list instead (with the
  // restart wording while the game needs a restart to load the news folder).
  const sync = useSyncStatus();
  const ready = kind === 'waiting' && entries.some((e) => e.state === 'queued');
  const list = entries.length
    ? html`${ready ? html`<p class="hint mb-0">${readyLine(sync)}</p>` : null}
      <ul class="share-list">
        ${shown.map((e) => html`<${ShareEntry} key=${e.op} entry=${e} cancel=${cancel && (e.state === 'queued' || e.state === 'waiting')} />`)}
      </ul>
      ${entries.length > shown.length ? html`<button type="button" class="link-btn small" onClick=${() => setAll(true)}>
        Show all ${entries.length}</button>` : null}`
    : html`<p class="muted mb-0 share-empty">${empty}</p>`;
  if (folded) {
    return html`<section class=${cx('share-section', `share-section--${kind}`)}>
      <button type="button" class="share-section-title share-fold" aria-expanded=${open ? 'true' : 'false'} onClick=${() => setOpen(!open)}>
        <${Icon} name=${open ? 'back' : 'forward'} class=${cx('share-fold-icon', open && 'is-open')} />${head}
      </button>
      ${open ? list : null}
    </section>`;
  }
  return html`<section class=${cx('share-section', `share-section--${kind}`)}>
    <h3 class="share-section-title">${head}</h3>
    ${list}
  </section>`;
}

function ShareEntry({ entry, cancel }) {
  const st = shareStateLabel(entry);
  const dropIt = async () => {
    try {
      const r = await api.post(`/api/share/outbox/${encodeURIComponent(entry.op)}/cancel`);
      toast((r && r.message) || 'Change dropped. It will not be sent.', 'ok');
    } catch (err) {
      toast(err?.message || 'That did not work. Please try again.', 'alarm');
    } finally {
      shareLive.refresh();
    }
  };
  return html`<li class=${cx('share-entry', `share-entry--${entry.state}`)}>
    <div class="share-entry-main">
      <span class="share-entry-summary">${entry.summary || 'A guild change'}</span>
      ${entry.note && !(entry.state === 'queued' && entry.note === SHARE_LINES.saved) ? html`<span class="share-entry-note">${entry.note}</span>` : null}
    </div>
    <div class="share-entry-side">
      <${Pill} kind=${st.kind} dot>${st.label}<//>
      <span class="hint nowrap"><${TimeAgo} t=${entry.sentAt || entry.createdAt} /></span>
      ${cancel ? html`<${ConfirmButton} size="sm" variant="ghost" icon="close" question="Cancel this change?" yes="Yes, cancel" no="Keep it"
          title="Don't send this change. Guild Camp shows things as they were before it."
          onConfirm=${dropIt}>Cancel<//>` : null}
    </div>
  </li>`;
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

function InstallCard({ inst, latest, pending, custom, onAction, onOpen, onRemoveFolder, onUse }) {
  const other = inst.mainGame === false;
  const unused = inst.inUse === false;
  const action = inst.action || pending || null;
  const busy = Boolean(inst.busy || pending);
  const pill = unused ? { kind: 'muted', label: 'Not used' } : inst.damaged ? { kind: 'alarm', label: 'Needs repair' } : STATE_PILL[inst.state] || STATE_PILL.missing;
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

  return html`<${Card} class=${`addon-install ${(inst.state === 'outdated' && inst.inUse !== false) || inst.damaged ? 'card--accent' : ''}`}
      title=${html`<span class="addon-install-title"><${Icon} name="game" />${inst.label}</span>`}
      actions=${html`<${Pill} kind=${pill.kind} dot>${pill.label}<//>`}
      footer=${html`<div class="actions-row">
        ${list.map(button)}
        ${unused ? html`<${Button} size="sm" variant="primary" icon="plus" disabled=${busy} onClick=${() => onUse(inst, true)}>Use with Guild Camp<//>` : null}
        <span class="spacer"></span>
        ${other && !unused ? html`<${ConfirmButton} size="sm" variant="ghost" icon="minus" disabled=${busy} confirmVariant="primary"
          question=${`Stop using ${inst.label} with Guild Camp?`} yes="Stop using" onConfirm=${() => onUse(inst, false)}>Stop using<//>` : null}
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
      ${unused ? html`<p class="hint mb-0">Guild Camp is for WoW Forever, so it leaves this game alone: no sync and no automatic addon installs or updates. Turn it on only if your guild plays here too.</p>` : null}
      ${inst.damaged && !busy ? html`<${Notice} kind="warn">The addon folder is missing its WowGuild.toc file, so the game won't load it. Repair puts it back.<//>` : null}
      ${waitingText(inst) && !busy ? html`<${Notice} kind="info" title="Waiting for World of Warcraft to close.">${waitingText(inst)}<//>` : null}
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
  if (f.lastUploadAt) return html`<${Pill} kind="ok">Synced<//>`;
  return html`<${Pill} kind="muted">Waiting<//>`;
}

const RECENT_KIND = { upload: 'Sync', inbox: 'Guild news', coach: 'Coach answer', guild: 'Guild' };

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
    { key: 'lastUploadAt', label: 'Last sync', sortable: true, render: (f) => html`<${TimeAgo} t=${f.lastUploadAt} never="Not yet" />` },
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
      ? `You have the addon that came with Guild Camp (${addon.bundled.version}). Notes show here when a newer version comes out.`
      : 'Notes show here when a new version of the addon comes out.'}</p>` : null}
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
