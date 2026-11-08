// Updates: the app's own version (check, download, restart to install, automatic updates), the addon in every
// game folder, and the release history. Everything comes from the releases on GitHub (arrow-quiver/wow): the app
// updater follows the release marked Latest, and the addon manager reads the release list (addon status
// `releases`), so this page needs no server.
import { html, useState, useEffect, useMemo, useRef } from '../lib/html.js';
import { gc, useGcEvent } from '../lib/gc.js';
import { Link } from '../lib/router.js';
import { useUpdaterStatus, useAddonStatus, updaterStatus, addonStatus } from '../lib/status.js';
import { bytes, plural } from '../lib/format.js';
import {
  Page, Card, Button, Checkbox, Notice, Pill, Progress, Tabs, Table, Empty, Loading, Spinner,
  TimeAgo, LocalTime, toast,
} from '../components/index.js';
import { updateAllText } from './addon.js';

export const RELEASES_URL = 'https://github.com/arrow-quiver/wow/releases';

// ---------- shared bits (releases.js uses ReleaseNotes too) ----------

/**
 * Release notes as people write them: paragraphs, with "- " or "* " lines shown as a list.
 *   html`<${ReleaseNotes} text=${'Fixes:\n- Tooltips\n- Faster sync'} />`
 */
export function ReleaseNotes({ text, empty = 'No release notes.', class: cls }) {
  const blocks = useMemo(() => splitNotes(text), [text]);
  if (!blocks.length) return html`<p class="muted small">${empty}</p>`;
  return html`<div class=${`updates-notes ${cls || ''}`.trim()}>
    ${blocks.map((b, i) => (b.list
      ? html`<ul key=${i}>${b.items.map((item, j) => html`<li key=${j}>${item}</li>`)}</ul>`
      : html`<p key=${i}>${b.text}</p>`))}
  </div>`;
}

// "Intro\n- one\n- two\n\nOutro" → [{ text: 'Intro' }, { list: true, items: ['one', 'two'] }, { text: 'Outro' }]
// Markdown headings ("## Fixes") become plain paragraphs.
export function splitNotes(text) {
  const out = [];
  let para = [];
  let list = null;
  const flushPara = () => { if (para.length) { out.push({ text: para.join('\n') }); para = []; } };
  const flushList = () => { if (list) { out.push({ list: true, items: list }); list = null; } };
  for (const raw of String(text || '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd().replace(/^#{1,6}\s+/, '');
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    if (bullet) { flushPara(); (list ||= []).push(bullet[1]); continue; }
    if (!line.trim()) { flushPara(); flushList(); continue; }
    if (list && /^\s{2,}\S/.test(line)) { list[list.length - 1] += ` ${line.trim()}`; continue; } // wrapped bullet
    flushList();
    para.push(line.trim());
  }
  flushPara();
  flushList();
  return out;
}

const KIND_LABEL = { app: 'App', addon: 'Addon' };

/** The release history from the addon status (newest first), with the kinds the table filters on. */
export function historyRows(addon) {
  const list = addon && addon.releases && Array.isArray(addon.releases.history) ? addon.releases.history : [];
  return list.filter((r) => r && (r.kind === 'app' || r.kind === 'addon') && r.version);
}

// Settings, kept fresh from the 'settings' channel.
function useSettings() {
  const [settings, setSettings] = useState(null);
  useEffect(() => {
    let live = true;
    gc.settings.get().then((s) => { if (live) setSettings(s); }, () => {});
    return () => { live = false; };
  }, []);
  useGcEvent('settings', (s) => { if (s && typeof s === 'object') setSettings(s); });
  return [settings, setSettings];
}

// What the app card says for each updater state: [pill kind, pill label].
const STATE_PILL = {
  dev: ['muted', 'Development build'],
  idle: ['muted', 'Not checked yet'],
  checking: ['info', 'Checking…'],
  available: ['accent', 'Update available'],
  'not-available': ['ok', 'Up to date'],
  downloading: ['info', 'Downloading'],
  downloaded: ['accent', 'Ready to install'],
  error: ['alarm', 'Problem'],
};

// ---------- page ----------

export default function UpdatesPage() {
  const upd = useUpdaterStatus();
  const addon = useAddonStatus();
  const [settings, setSettings] = useSettings();
  const [checking, setChecking] = useState(false);

  // A check the person asked for: GitHub is asked now, not the answer from the last half hour.
  const checkAll = async () => {
    setChecking(true);
    try {
      const [app] = await Promise.all([
        gc.updater.check({ force: true }).then((s) => { if (s) updaterStatus.store.set(s); return s; }),
        gc.addon.check({ force: true }).then(() => addonStatus.refresh()).catch(() => null),
      ]);
      if (app && app.state === 'not-available') toast('Guild Camp is up to date.', 'ok');
      else if (app && (app.state === 'available' || app.state === 'downloading') && app.available) toast(`Guild Camp ${app.available.version} is available.`, 'info');
    } catch (err) {
      toast(err?.message || "Couldn't check for updates.", 'alarm');
    } finally {
      setChecking(false);
    }
  };

  // Nothing checked yet (the app has only just started): ask about the app quietly. The addon is left to its own
  // schedule, because an addon check can also update the game folders.
  const askedOnOpen = useRef(false);
  useEffect(() => {
    if (!upd || askedOnOpen.current) return;
    askedOnOpen.current = true;
    if (!upd.lastCheckAt && (upd.state === 'dev' || upd.state === 'idle')) {
      gc.updater.check().then((s) => { if (s) updaterStatus.store.set(s); }, () => {});
    }
  }, [upd]);

  return html`<${Page} title="Updates" width="normal"
      lede="Guild Camp keeps itself and the addon up to date from the releases on GitHub."
      actions=${html`<${Button} icon="refresh" busy=${checking || upd?.state === 'checking' || addon?.checking} onClick=${checkAll}>Check for updates<//>`}>
    <div class="grid-2 updates-top">
      <${AppCard} upd=${upd} settings=${settings} onSettings=${setSettings} onCheck=${checkAll} checking=${checking} />
      <${AddonCard} addon=${addon} settings=${settings} />
    </div>
    <${HistoryCard} addon=${addon} onCheck=${checkAll} checking=${checking} />
  <//>`;
}

// ---------- app ----------

function AppCard({ upd, settings, onSettings, onCheck, checking }) {
  const download = async () => {
    try {
      const s = await gc.updater.download();
      if (s) updaterStatus.store.set(s);
    } catch (err) {
      toast(err?.message || "Couldn't download the update.", 'alarm');
    }
  };
  const [installing, setInstalling] = useState(false);
  const install = async () => {
    setInstalling(true);
    try {
      await gc.updater.install();
    } catch (err) {
      setInstalling(false);
      toast(err?.message || "Couldn't start the installer.", 'alarm');
    }
  };
  const setAuto = async (on) => {
    try {
      onSettings(await gc.settings.set({ appAutoUpdate: on }));
      toast(on ? 'App updates will download and install by themselves.' : 'App updates will wait for you.', 'ok');
    } catch (err) {
      toast(err?.message || "Couldn't change that setting.", 'alarm');
    }
  };

  if (!upd) {
    return html`<${Card} title="Guild Camp app"><${Loading} label="Checking the app version…" /><//>`;
  }
  const [pillKind, pillLabel] = STATE_PILL[upd.state] || STATE_PILL.idle;
  const avail = upd.available;
  const auto = settings ? settings.appAutoUpdate !== false : upd.autoUpdate !== false;
  const isDev = upd.state === 'dev';
  const releaseLink = upd.releasesUrl || `${RELEASES_URL}/latest`;

  let body;
  if (isDev) {
    body = html`
      <${Notice} kind="info" title="This is a development build.">
        It doesn't update itself. Pull the latest code and start it again instead.
      <//>
      ${avail ? html`<div class="updates-headline">
          <strong>Guild Camp ${avail.version} is out on GitHub.</strong>
          ${avail.date ? html`<span class="muted small">Published <${TimeAgo} t=${avail.date} />.</span>` : null}
        </div>
        <${ReleaseNotes} text=${avail.notes} />`
        : upd.latest ? html`<p class="muted">The newest app release on GitHub is ${upd.latest.version}, the same as or older than this build.</p>`
          : upd.lastCheckAt && !upd.error ? html`<p class="muted">No app release is on GitHub yet.</p>` : null}
      ${upd.error ? html`<${Notice} kind="warn">${upd.error}<//>` : null}`;
  } else if (upd.state === 'checking') {
    body = html`<div class="loading"><${Spinner} label="" /> Checking GitHub for a newer version…</div>`;
  } else if (upd.state === 'downloading') {
    const p = upd.progress;
    const detail = p && p.total ? `${bytes(p.transferred)} of ${bytes(p.total)}${p.bytesPerSecond ? ` · ${bytes(p.bytesPerSecond)}/s` : ''}` : 'Starting the download…';
    body = html`
      <div class="updates-headline"><strong>Downloading Guild Camp ${avail?.version || ''}</strong></div>
      <${Progress} value=${p && p.total ? p.percent : undefined} label=${detail} showValue=${!!(p && p.total)} />
      <p class="hint">You can keep using Guild Camp. It installs when the download is done and you restart.</p>
      ${avail ? html`<${ReleaseNotes} text=${avail.notes} />` : null}`;
  } else if (upd.state === 'downloaded') {
    body = html`
      <${Notice} kind="ok" title=${avail ? `Guild Camp ${avail.version} is ready.` : 'The update is ready.'}>
        It installs the next time Guild Camp starts. Restart now to get it straight away.
      <//>
      ${avail ? html`<${ReleaseNotes} text=${avail.notes} />` : null}
      <div class="form-actions">
        <${Button} variant="primary" icon="refresh" busy=${installing} onClick=${install}>Restart and install<//>
      </div>`;
  } else if (upd.state === 'available' || (upd.state === 'error' && avail)) {
    body = html`
      ${upd.error ? html`<${Notice} kind="alarm">${upd.error}<//>` : null}
      <div class="updates-headline">
        <strong>Guild Camp ${avail.version} is available.</strong>
        ${avail.date ? html`<span class="muted small">Published <${TimeAgo} t=${avail.date} />.</span>` : null}
      </div>
      <${ReleaseNotes} text=${avail.notes} />
      <div class="form-actions">
        <${Button} variant="primary" icon="download" onClick=${download}>${upd.error ? 'Try the download again' : 'Download'}<//>
        <span class="hint">You can keep playing while it downloads.</span>
      </div>`;
  } else if (upd.state === 'error') {
    body = html`
      <${Notice} kind=${/No app release/.test(upd.error || '') ? 'info' : 'alarm'}>${upd.error}<//>
      <div class="form-actions">
        <${Button} icon="refresh" busy=${checking} onClick=${onCheck}>Try again<//>
        <${Button} variant="ghost" icon="external" href=${releaseLink}>Open the releases page<//>
      </div>`;
  } else if (upd.state === 'not-available') {
    body = html`<div class="updates-uptodate">
      <span class="updates-check" aria-hidden="true">✓</span>
      <div><strong>You have the newest version.</strong>
        <div class="muted small">Guild Camp ${upd.current} is the latest release.</div></div>
    </div>`;
  } else {
    body = html`<p class="muted">Guild Camp hasn't checked for updates yet.</p>
      <div class="form-actions"><${Button} icon="refresh" busy=${checking} onClick=${onCheck}>Check now<//></div>`;
  }

  return html`<${Card} title="Guild Camp app" sub=${`version ${upd.current}`} class="updates-card"
      actions=${html`<${Pill} kind=${pillKind} dot>${pillLabel}<//>`}
      footer=${html`<div class="stack stack--tight">
        <${Checkbox} label="Download and install app updates automatically" checked=${auto} disabled=${!settings || isDev}
          onValue=${setAuto}
          hint=${isDev ? 'Development builds never update themselves.' : 'Updates download in the background and install when Guild Camp restarts.'} />
        <span class="hint">Last checked: <${TimeAgo} t=${upd.lastCheckAt} never="not yet" /></span>
      </div>`}>
    <div class="stack">${body}</div>
  <//>`;
}

// ---------- addon ----------

const INSTALL_PILL = {
  missing: ['muted', 'Not installed'],
  outdated: ['warn', 'Update ready'],
  current: ['ok', 'Up to date'],
  newer: ['info', 'Newer'],
};

function AddonCard({ addon, settings }) {
  const [updating, setUpdating] = useState(false);
  if (!addon) return html`<${Card} title="Guild Camp addon"><${Loading} label="Looking at your game folders…" /><//>`;

  const installs = Array.isArray(addon.installs) ? addon.installs : [];
  const installed = installs.filter((i) => i.installed);
  const outdated = installs.filter((i) => i.state === 'outdated');
  const latest = addon.latest;
  const fromGithub = latest && latest.source === 'remote';
  const auto = settings ? settings.addonAutoUpdate !== false : addon.autoUpdate !== false;

  const updateAll = async () => {
    setUpdating(true);
    try {
      const s = await gc.addon.updateAll();
      await addonStatus.refresh();
      toast(updateAllText(latest?.version, Boolean(s?.restartNeeded)), 'ok');
    } catch (err) {
      toast(err?.message || "Couldn't update the addon.", 'alarm');
    } finally {
      setUpdating(false);
    }
  };

  let summary;
  if (!installs.length) {
    summary = html`<${Notice} kind="warn" title="No game folder found.">Add your World of Warcraft folder on the Addon & sync page.<//>`;
  } else if (!installed.length) {
    summary = html`<${Notice} kind="info">The addon isn't installed in any game folder yet.<//>`;
  } else if (outdated.length) {
    summary = html`<${Notice} kind="warn" title=${`${plural(outdated.length, 'game folder')} ${outdated.length === 1 ? 'has' : 'have'} an older addon.`}>
      ${!auto ? 'Automatic addon updates are off, so update it here.'
        : outdated.some((i) => i.waitingForGame) ? 'Guild Camp updates it once World of Warcraft is closed, or update now.'
          : 'Guild Camp updates it at the next check, or update now.'}
    <//>`;
  } else if (installed.length < installs.length) {
    summary = html`<p class="muted updates-addon-ok">The addon is up to date wherever it is installed.</p>`;
  } else {
    summary = html`<p class="ok-text updates-addon-ok">Every game folder has the addon, up to date.</p>`;
  }

  return html`<${Card} title="Guild Camp addon" sub=${latest ? `latest ${latest.version}` : ''} class="updates-card"
      actions=${addon.checking ? html`<${Pill} kind="info" dot>Checking…<//>` : outdated.length ? html`<${Pill} kind="accent" dot>${plural(outdated.length, 'update')}<//>` : installed.length ? html`<${Pill} kind="ok" dot>Up to date<//>` : null}
      footer=${html`<div class="row row--between">
        <span class="hint">Automatic addon updates are ${auto ? 'on' : 'off'}. <${Link} href="/settings">Change<//></span>
        <${Button} size="sm" variant="ghost" href="/addon" iconRight="forward">Addon & sync<//>
      </div>`}>
    <div class="stack">
      ${addon.error ? html`<${Notice} kind="warn">${addon.error}${latest ? ' The addon versions below may be out of date.' : ''}<//>` : null}
      ${latest ? html`<div class="updates-headline">
          <strong>Addon ${latest.version}</strong>
          <span class="muted small">${fromGithub
            ? html`published <${TimeAgo} t=${addon.remote?.publishedAt} never="on GitHub" />`
            : 'comes with this version of the app'}</span>
        </div>` : null}
      ${fromGithub && addon.remote?.notes ? html`<${ReleaseNotes} text=${addon.remote.notes} />` : null}
      ${summary}
      ${installs.length ? html`<ul class="updates-installs">
        ${installs.map((i) => {
          const [kind, label] = INSTALL_PILL[i.state] || INSTALL_PILL.missing;
          return html`<li key=${i.dir}>
            <span class="updates-install-name">${i.label || i.flavor}</span>
            <span class="muted small ellipsis" title=${i.dir}>${i.dir}</span>
            <span class="spacer"></span>
            ${i.installed ? html`<span class="small num">${i.installed.version}</span>` : null}
            <${Pill} kind=${kind}>${i.busy ? 'Working…' : label}<//>
          </li>`;
        })}
      </ul>` : null}
      ${outdated.length ? html`<div class="form-actions">
        <${Button} variant="primary" icon="download" busy=${updating} onClick=${updateAll}>${outdated.length === 1 ? 'Update the addon' : 'Update all'}<//>
      </div>` : null}
    </div>
  <//>`;
}

// ---------- history ----------

function HistoryCard({ addon, onCheck, checking }) {
  const [tab, setTab] = useState('all');
  const history = historyRows(addon);
  const rows = tab === 'all' ? history : history.filter((h) => h.kind === tab);
  const count = (k) => history.filter((h) => h.kind === k).length;
  const checkedAt = addon?.releases?.checkedAt || null;

  let body;
  if (!addon) {
    body = html`<${Loading} label="Loading the release history…" />`;
  } else if (!history.length && addon.error) {
    body = html`<div class="updates-pad stack">
      <${Notice} kind="warn" title="Couldn't load the release history.">${addon.error}<//>
      <div class="form-actions"><${Button} icon="refresh" busy=${checking} onClick=${onCheck}>Try again<//></div>
    </div>`;
  } else if (!history.length) {
    body = html`<${Empty} compact icon="releases" title="Nothing has been published yet.">New app and addon versions show up here when they are released on GitHub.<//>`;
  } else {
    body = html`<${Table} dense rowKey=${(r) => r.tag || `${r.kind}-${r.version}`} rows=${rows}
      empty="Nothing of this kind has been published yet."
      columns=${[
        { key: 'version', label: 'Version', width: '150px', render: (r) => html`<span class="row nowrap">
            <${Pill} kind=${r.kind === 'app' ? 'info' : 'accent'}>${KIND_LABEL[r.kind] || r.kind}<//>
            <strong class="num">${r.version}</strong></span>` },
        { key: 'publishedAt', label: 'Published', width: '150px', render: (r) => html`<${LocalTime} t=${r.publishedAt} style="day" empty="unknown" />` },
        { key: 'notes', label: 'Notes', class: 'wrap-cell', render: (r) => html`<${ReleaseNotes} text=${r.notes} empty="No notes." class="updates-notes--compact" />` },
        { key: 'url', label: '', width: '90px', render: (r) => (r.url ? html`<${Button} size="sm" variant="ghost" icon="external" href=${r.url}>GitHub<//>` : null) },
      ]} />`;
  }

  return html`<${Card} title="Release history" flush class="updates-history"
      sub=${checkedAt ? html`from GitHub, checked <${TimeAgo} t=${checkedAt} />` : 'from GitHub'}
      actions=${history.length ? html`<${Tabs} value=${tab} onChange=${setTab} label="Release kind" idPrefix="updates-history"
        tabs=${[{ id: 'all', label: 'All', count: history.length }, { id: 'app', label: 'App', count: count('app') }, { id: 'addon', label: 'Addon', count: count('addon') }]} />` : null}>
    ${body}
  <//>`;
}
