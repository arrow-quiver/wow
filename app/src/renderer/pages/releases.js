// Releases (guild owner only): publish an addon update from a WowGuild folder, or build and publish the app from
// a source checkout, with the build output live on screen. Everything here reaches every guild member.
import { html, useState, useEffect, useRef, useCallback } from '../lib/html.js';
import { gc, useGcEvent, isMock } from '../lib/gc.js';
import { useSession } from '../lib/session.js';
import {
  Page, Card, Button, ConfirmButton, CopyButton, Checkbox, Textarea, Input, Notice, Pill, Loading, ErrorBox, Empty,
  TimeAgo, LocalTime, Spinner, toast,
} from '../components/index.js';
import { ReleaseNotes } from './updates.js';

const MAX_NOTES = 4000; // same limit as src/main/publisher.js
const LOG_KEEP = 600;

// ---------- version helpers (display only; the main process works out the real version) ----------

const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function parseVersion(v) {
  const m = VERSION_RE.exec(String(v ?? '').trim());
  return m ? { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || null } : null;
}

// Mirrors shared/version.js bump(): patch/minor/major graduate a pre-release; beta starts or continues a beta series.
export function bumpVersion(v, kind) {
  const p = parseVersion(v);
  if (!p) return null;
  const n = { ...p, pre: null };
  if (kind === 'major') { if (!(p.pre && p.minor === 0 && p.patch === 0)) { n.major++; n.minor = 0; n.patch = 0; } }
  else if (kind === 'minor') { if (!(p.pre && p.patch === 0)) { n.minor++; n.patch = 0; } }
  else if (kind === 'patch') { if (!p.pre) n.patch++; }
  else if (kind === 'beta') {
    const m = p.pre && /^beta(?:\.(\d+))?$/.exec(p.pre);
    if (m) n.pre = `beta.${Number(m[1] || 0) + 1}`;
    else { if (!p.pre) n.patch++; n.pre = 'beta.1'; }
  } else return null;
  return `${n.major}.${n.minor}.${n.patch}${n.pre ? `-${n.pre}` : ''}`;
}

// -1 | 0 | 1, pre-releases below their release (enough for "is this newer than the server's?").
export function compareVersions(a, b) {
  const pa = parseVersion(a); const pb = parseVersion(b);
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0;
  for (const k of ['major', 'minor', 'patch']) if (pa[k] !== pb[k]) return pa[k] < pb[k] ? -1 : 1;
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1;
  if (!pb.pre) return -1;
  const xa = pa.pre.split('.'); const xb = pb.pre.split('.');
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    if (xa[i] === undefined) return -1;
    if (xb[i] === undefined) return 1;
    const na = /^\d+$/.test(xa[i]); const nb = /^\d+$/.test(xb[i]);
    if (na && nb && +xa[i] !== +xb[i]) return +xa[i] < +xb[i] ? -1 : 1;
    if (na !== nb) return na ? -1 : 1;
    if (xa[i] !== xb[i]) return xa[i] < xb[i] ? -1 : 1;
  }
  return 0;
}

// The version a choice leads to: 'none' keeps it, 'exact' uses the typed one.
function targetVersion(current, choice, exact) {
  if (choice === 'none') return current || null;
  if (choice === 'exact') return parseVersion(exact) ? exact.trim() : null;
  return bumpVersion(current, choice);
}

// What publisher.publish* expects as `bump`.
const bumpArg = (choice, exact) => (choice === 'none' ? null : choice === 'exact' ? exact.trim() : choice);

// publisher:log payloads are { t, kind, level, line } (older builds and the preview send strings or { kind, line }).
function toLine(entry, i) {
  if (entry && typeof entry === 'object') return { id: i, t: entry.t || null, kind: entry.kind || null, level: entry.level || 'info', line: String(entry.line ?? '') };
  return { id: i, t: null, kind: null, level: 'info', line: String(entry ?? '') };
}

const canCancel = () => typeof window !== 'undefined' && Array.isArray(window.gc?.methods) && window.gc.methods.includes('publisher.cancel');

// ---------- data ----------

function usePublisher() {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const seq = useRef(0);
  const load = useCallback(async () => {
    const id = ++seq.current;
    try {
      const data = await gc.publisher.status();
      if (id === seq.current) setState({ data, error: null, loading: false });
      return data;
    } catch (error) {
      if (id === seq.current) setState((s) => ({ ...s, error, loading: false }));
      return null;
    }
  }, []);
  useEffect(() => { load(); }, [load]);
  // A release published elsewhere (CI, the script) shows up straight away.
  useGcEvent('server-event', (ev) => { if (ev && ev.kind === 'release') load(); });
  return { ...state, reload: load };
}

// ---------- page ----------

export default function ReleasesPage() {
  const session = useSession();
  if (session.loaded && !session.isOwner) {
    return html`<${Page} title="Releases" width="narrow">
      <${Card}>
        <${Empty} icon="releases" title="Only the guild owner publishes releases."
          action=${html`<${Button} href="/updates" icon="updates">See updates<//>`}>
          New versions of the app and the addon reach you by themselves. The Updates page shows what you have.
        <//>
      <//>
    <//>`;
  }
  return html`<${OwnerReleases} />`;
}

function OwnerReleases() {
  const pub = usePublisher();
  const st = pub.data;
  const [lines, setLines] = useState([]);
  const [running, setRunning] = useState(null); // 'addon' | 'app' while a job this page started is running
  const [cancelling, setCancelling] = useState(false);
  const seeded = useRef(false);

  // Seed the log from the main process once (a build may have started before the page opened).
  useEffect(() => {
    if (!st || seeded.current) return;
    seeded.current = true;
    if (Array.isArray(st.log) && st.log.length) setLines(st.log.map(toLine));
  }, [st]);

  useGcEvent('publisher:log', (entry) => {
    setLines((prev) => {
      const next = [...prev, toLine(entry, (prev.length ? prev[prev.length - 1].id : 0) + 1)];
      return next.length > LOG_KEEP ? next.slice(next.length - LOG_KEEP) : next;
    });
  });

  // A job started before this page opened (or from another window): follow it until it ends.
  const busyElsewhere = Boolean(st?.building) && !running;
  useEffect(() => {
    if (!busyElsewhere) return undefined;
    const t = setInterval(() => pub.reload(), 2000);
    return () => clearInterval(t);
  }, [busyElsewhere]);

  const busyKind = running || (st?.building ? st.job?.kind || 'app' : null);

  const start = async (kind, fn) => {
    setLines([]);
    setRunning(kind);
    try {
      const out = await fn();
      if (out && out.version) {
        toast(kind === 'app'
          ? `Guild Camp ${out.version} is live. Members get it at their next update check.`
          : `Addon ${out.version} is live. Members' apps install it by themselves.`, 'ok');
      }
      return { ok: true, value: out };
    } catch (err) {
      if (err?.code === 'cancelled') toast('Cancelled. Nothing was published.', 'info');
      else toast(err?.message || 'Publishing failed. The log says why.', 'alarm');
      return { ok: false, error: err };
    } finally {
      setRunning(null);
      setCancelling(false);
      pub.reload();
    }
  };

  const cancel = async () => {
    setCancelling(true);
    try {
      await gc.invoke('publisher.cancel');
    } catch (err) {
      setCancelling(false);
      toast(err?.message || "Couldn't cancel.", 'alarm');
    }
  };

  if (!st) {
    return html`<${Page} title="Releases">
      ${pub.error ? html`<${ErrorBox} error=${pub.error} title="Couldn't load the release tools." onRetry=${pub.reload} />` : html`<${Loading} label="Looking for your source folders…" />`}
    <//>`;
  }

  return html`<${Page} title="Releases" width="wide"
      lede="Publish new versions of the addon and the app to your guild's server."
      actions=${html`<${Button} icon="refresh" onClick=${pub.reload} busy=${pub.loading}>Refresh<//>`}>
    <div class="releases">
      <${Notice} kind="warn" title="Publishing reaches every guild member.">
        Their apps download the new version by themselves, usually within the hour. Test a build in game before you publish it.
      <//>
      ${!st.canPublish && st.reason ? html`<${Notice} kind="alarm">${st.reason}<//>` : null}

      <${PublishedCard} st=${st} />

      <div class="grid-2 releases-forms">
        <${AddonForm} st=${st} busyKind=${busyKind} onStart=${start} />
        <${AppForm} st=${st} busyKind=${busyKind} onStart=${start} onRepoChanged=${pub.reload} />
      </div>

      <${LogCard} lines=${lines} busyKind=${busyKind} job=${st.job} cancelling=${cancelling}
        onCancel=${canCancel() ? cancel : null} onClear=${() => setLines([])} />

      <${CommandLineCard} st=${st} />
    </div>
  <//>`;
}

// ---------- what is live ----------

function PublishedCard({ st }) {
  const pub = st.published;
  const item = (label, rel, local, localLabel) => html`<div class="releases-live">
    <span class="releases-live-label">${label}</span>
    ${rel
      ? html`<span class="releases-live-version">${rel.version}</span>
        ${rel.source === 'bundled'
          ? html`<span class="muted small">Bundled with the server. Nothing published yet.</span>`
          : html`<span class="muted small">published <${TimeAgo} t=${rel.publishedAt} never="some time ago" />${rel.publishedAt ? html` · <${LocalTime} t=${rel.publishedAt} style="day" />` : null}</span>`}`
      : html`<span class="releases-live-version muted">none</span><span class="muted small">Nothing published yet.</span>`}
    ${local ? html`<span class="small">
        ${localLabel} <strong>${local}</strong>
        ${rel && compareVersions(local, rel.version) > 0 ? html` <${Pill} kind="accent">not published yet<//>` : null}
        ${rel && compareVersions(local, rel.version) < 0 ? html` <${Pill} kind="warn">older than the server<//>` : null}
      </span>` : null}
  </div>`;
  return html`<${Card} title="Live on the server" sub=${st.server || ''}>
    ${st.publishedError ? html`<${Notice} kind="alarm" title="Couldn't read what the server has.">${st.publishedError}<//>` : null}
    <div class="grid-2">
      ${item('App', pub?.app, st.appSource?.version || (st.repoDir ? st.appVersion : null), 'Your checkout:')}
      ${item('Addon', pub?.addon, st.addonSource?.version, 'Your addon folder:')}
    </div>
  <//>`;
}

// ---------- shared form pieces ----------

function BumpPicker({ name, current, value, onChange, exact, onExact, allowKeep = true, disabled }) {
  const options = [
    allowKeep && { id: 'none', label: 'Keep', version: current || '?' },
    { id: 'patch', label: 'Patch', version: bumpVersion(current, 'patch') },
    { id: 'minor', label: 'Minor', version: bumpVersion(current, 'minor') },
    { id: 'major', label: 'Major', version: bumpVersion(current, 'major') },
    { id: 'beta', label: 'Beta', version: bumpVersion(current, 'beta') },
    { id: 'exact', label: 'Exact', version: 'type it' },
  ].filter(Boolean);
  return html`<fieldset class="releases-bump" disabled=${disabled}>
    <legend class="field-label">Version</legend>
    <div class="releases-seg" role="radiogroup">
      ${options.map((o) => html`<label key=${o.id} class=${`releases-seg-opt${value === o.id ? ' is-on' : ''}`}>
        <input type="radio" name=${name} value=${o.id} checked=${value === o.id} onChange=${() => onChange(o.id)} />
        <span class="releases-seg-label">${o.label}</span>
        <span class="releases-seg-version">${o.version || '?'}</span>
      </label>`)}
    </div>
    ${value === 'exact' ? html`<${Input} label="Exact version" value=${exact} onValue=${onExact} placeholder="1.2.3" spellcheck="false"
        error=${exact && !parseVersion(exact) ? 'Use a version like 1.2.3 or 1.2.3-beta.1.' : ''} />` : null}
  </fieldset>`;
}

function NotesField({ value, onValue, suggestion, disabled }) {
  const over = value.length > MAX_NOTES;
  return html`<div class="stack stack--tight">
    <${Textarea} label="Release notes" rows="5" value=${value} onValue=${onValue} disabled=${disabled}
      placeholder="What changed, in a few short lines. Members see this in the app."
      error=${over ? `Keep the notes under ${MAX_NOTES.toLocaleString('en')} characters.` : ''}
      hint=${`${value.length.toLocaleString('en')} / ${MAX_NOTES.toLocaleString('en')} characters`} />
    ${suggestion && suggestion.trim() !== value.trim() ? html`<div class="row">
      <${Button} size="sm" variant="ghost" icon="edit" disabled=${disabled} onClick=${() => onValue(suggestion)}>Use the changes from git<//>
    </div>` : null}
  </div>`;
}

// "C:\Users\calvi\OneDrive\Documentos\GitHub\wow\addon\WowGuild" → "C:\…\GitHub\wow\addon\WowGuild": the end of a
// path says which folder it is, so that part stays when it has to be cut.
export function shortPath(p, max = 46) {
  const s = String(p || '');
  if (s.length <= max) return s;
  const sep = s.includes('\\') ? '\\' : '/';
  const parts = s.split(/[\\/]+/).filter(Boolean);
  const head = /^[A-Za-z]:$/.test(parts[0]) ? parts[0] : s.startsWith(sep) ? '' : parts[0];
  const tail = [];
  for (let i = parts.length - 1; i > 0; i--) {
    const next = [parts[i], ...tail].join(sep);
    if (tail.length && head.length + next.length + 3 > max) break;
    tail.unshift(parts[i]);
  }
  return `${head}${sep}…${sep}${tail.join(sep)}`;
}

function PathLine({ path, empty, children }) {
  return html`<div class="releases-path">
    <span class="releases-path-text mono" title=${path || ''}>${path ? shortPath(path) : html`<span class="muted">${empty}</span>`}</span>
    <div class="releases-path-actions">${children}</div>
  </div>`;
}

// ---------- addon ----------

function AddonForm({ st, busyKind, onStart }) {
  const [custom, setCustom] = useState(null); // { dir, version } picked with "Choose folder…"
  const [choice, setChoice] = useState('patch');
  const [exact, setExact] = useState('');
  const [notes, setNotes] = useState('');
  const [touched, setTouched] = useState(false);
  const [force, setForce] = useState(false);
  const [picking, setPicking] = useState(false);

  const source = custom || st.addonSource;
  const current = source?.version || null;
  // The server's bundled addon (source 'bundled') isn't published: any first upload replaces it,
  // so it must not ask for "Roll back".
  const pa = st.published?.addon;
  const live = pa && pa.source !== 'bundled' ? pa.version || null : null;
  const target = targetVersion(current, choice, exact);
  const notNewer = Boolean(live && target && compareVersions(target, live) <= 0);
  const suggestion = st.changelog?.addon || '';

  // Prefill the notes from git until the owner types their own.
  useEffect(() => { if (!touched && suggestion) setNotes(suggestion); }, [suggestion]);
  useEffect(() => { if (!notNewer) setForce(false); }, [notNewer]);

  const pick = async () => {
    setPicking(true);
    try {
      const dir = await gc.app.pickFolder({ title: 'Choose the WowGuild addon folder', defaultPath: source?.dir || st.repoDir || undefined });
      if (!dir) return;
      if (isMock) { setCustom({ dir, version: st.addonSource?.version || '0.0.0' }); return; }
      const pv = await gc.publisher.publishAddon({ sourceDir: dir, preview: true });
      setCustom({ dir: pv.dir, version: pv.version });
      if (pv.problem) toast(pv.problem, 'warn');
    } catch (err) {
      toast(err?.message || "That folder doesn't have the addon in it.", 'alarm');
    } finally {
      setPicking(false);
    }
  };

  const busy = busyKind === 'addon';
  const blocked = Boolean(busyKind) || !st.canPublish;
  const problem = !source ? 'Choose the WowGuild addon folder first.'
    : !current ? 'WowGuild.toc has no "## Version:" line.'
      : !target ? (choice === 'exact' ? 'Type the exact version to publish.' : "That version can't be worked out.")
        : notes.length > MAX_NOTES ? 'The release notes are too long.'
          : notNewer && !force ? `The server already has ${live}. Choose a bump, or tick "Roll back".` : null;

  const publish = () => onStart('addon', () => gc.publisher.publishAddon({
    sourceDir: source.dir, bump: bumpArg(choice, exact), notes, force: notNewer && force,
  })).then((r) => {
    if (r.ok) {
      if (custom && r.value?.version) setCustom({ ...custom, version: r.value.version });
      setChoice('patch'); setExact(''); setForce(false); setTouched(false); setNotes('');
    }
  });

  return html`<${Card} title="Publish an addon update" class="releases-card"
      actions=${busy ? html`<${Pill} kind="info" dot>Publishing…<//>` : null}>
    <div class="stack">
      <div class="field">
        <span class="field-label">Addon folder</span>
        <${PathLine} path=${source?.dir} empty="No addon folder found.">
          <${Button} size="sm" icon="folder" busy=${picking} disabled=${blocked} onClick=${pick}>Choose…<//>
          ${custom ? html`<${Button} size="sm" variant="ghost" disabled=${blocked} onClick=${() => setCustom(null)}>Use the checkout's<//>` : null}
        <//>
        <p class="field-hint">${source
          ? html`WowGuild.toc says <strong>${current || 'no version'}</strong>${live ? html`. The server has ${live}.` : '. Nothing is published yet.'}`
          : 'Pick the WowGuild folder: addon\\WowGuild in your checkout, or any copy of it.'}</p>
      </div>

      <${BumpPicker} name="addon-bump" current=${current} value=${choice} onChange=${setChoice} exact=${exact} onExact=${setExact} disabled=${blocked} />

      ${notNewer ? html`<${Checkbox} label=${`Roll back: publish ${target} even though the server has ${live}`} checked=${force} onValue=${setForce} disabled=${blocked}
        hint="New installs get this version. Members who already have a newer one can use Repair on the Addon & sync page." />` : null}

      <${NotesField} value=${notes} onValue=${(v) => { setNotes(v); setTouched(true); }} suggestion=${suggestion} disabled=${blocked} />

      <div class="form-actions">
        <${ConfirmButton} variant="primary" confirmVariant="primary" size="md" icon="upload" busy=${busy}
          disabled=${blocked || Boolean(problem)} question=${`Publish addon ${target} to every member?`} yes="Publish" no="Not yet"
          onConfirm=${() => { publish(); }}>
          ${target ? `Publish addon ${target}` : 'Publish addon'}
        <//>
        ${problem && !busyKind ? html`<span class="hint">${problem}</span>` : null}
        ${busyKind && !busy ? html`<span class="hint">Wait for the app build to finish.</span>` : null}
      </div>
    </div>
  <//>`;
}

// ---------- app ----------

function AppForm({ st, busyKind, onStart, onRepoChanged }) {
  const [choice, setChoice] = useState('patch');
  const [exact, setExact] = useState('');
  const [notes, setNotes] = useState('');
  const [touched, setTouched] = useState(false);
  const [picking, setPicking] = useState(false);

  // appSource is the checkout's app/package.json; appVersion (the documented field) falls back to the running app.
  const current = st.appSource?.version || (st.repoDir ? st.appVersion : null) || null;
  const live = st.published?.app?.version || null;
  const target = targetVersion(current, choice, exact);
  const notNewer = Boolean(live && target && compareVersions(target, live) <= 0);
  const suggestion = st.changelog?.app || '';
  useEffect(() => { if (!touched && suggestion) setNotes(suggestion); }, [suggestion]);

  const setRepo = async (dir) => {
    setPicking(true);
    try {
      await gc.publisher.setRepoDir(dir);
      await onRepoChanged();
      toast(dir ? 'Source folder saved.' : 'Guild Camp will find the source folder by itself.', 'ok');
    } catch (err) {
      toast(err?.message || "That folder can't be used.", 'alarm');
    } finally {
      setPicking(false);
    }
  };
  const pick = async () => {
    const dir = await gc.app.pickFolder({ title: 'Choose your Guild Camp source folder (the one with app and addon)', defaultPath: st.repoDir || undefined }).catch(() => null);
    if (dir) await setRepo(dir);
  };

  const busy = busyKind === 'app';
  const blocked = Boolean(busyKind) || !st.canPublish;
  const problem = !st.repoDir ? 'Choose the source folder first.'
    : !current ? "app/package.json has no version."
      : !target ? (choice === 'exact' ? 'Type the exact version to publish.' : "That version can't be worked out.")
        : notes.length > MAX_NOTES ? 'The release notes are too long.'
          : notNewer ? `The server already has ${live}. Choose a newer version.` : null;

  const publish = () => onStart('app', () => gc.publisher.publishApp({ bump: bumpArg(choice, exact), notes })).then((r) => {
    if (r.ok) { setChoice('patch'); setExact(''); setTouched(false); setNotes(''); }
  });

  return html`<${Card} title="Publish an app update" class="releases-card"
      actions=${busy ? html`<${Pill} kind="info" dot>${st.job?.step === 'upload' ? 'Uploading…' : 'Building…'}<//>` : null}>
    <div class="stack">
      <div class="field">
        <span class="field-label">Source folder</span>
        <${PathLine} path=${st.repoDir} empty="No source folder yet.">
          <${Button} size="sm" icon="folder" busy=${picking} disabled=${Boolean(busyKind)} onClick=${pick}>${st.repoDir ? 'Change…' : 'Choose…'}<//>
          ${st.repoSource === 'chosen' && !st.isPackaged ? html`<${Button} size="sm" variant="ghost" disabled=${Boolean(busyKind)} onClick=${() => setRepo(null)}>Find it by itself<//>` : null}
        <//>
        <p class="field-hint">${st.repoDir
          ? html`app/package.json says <strong>${current || 'no version'}</strong>${st.repoSource === 'detected' ? ' (found next to this app)' : ''}.${st.runningVersion ? ` You are running ${st.runningVersion}.` : ''}`
          : 'A copy of the Guild Camp source code with npm install done. The build runs there.'}</p>
      </div>
      ${st.repoProblem ? html`<${Notice} kind="warn">${st.repoProblem}<//>` : null}

      <${BumpPicker} name="app-bump" current=${current} value=${choice} onChange=${setChoice} exact=${exact} onExact=${setExact}
        allowKeep=${true} disabled=${blocked || !st.repoDir} />

      <${NotesField} value=${notes} onValue=${(v) => { setNotes(v); setTouched(true); }} suggestion=${suggestion} disabled=${blocked || !st.repoDir} />

      <p class="hint">The build runs <code>npm run dist</code> and takes a few minutes. Keep Guild Camp open until it says the release is live.
        The app never moves people to an older version, so ship fixes as a new version.</p>

      <div class="form-actions">
        <${ConfirmButton} variant="primary" confirmVariant="primary" size="md" icon="build" busy=${busy}
          disabled=${blocked || Boolean(problem)} question=${`Build ${target} and publish it to every member?`} yes="Build and publish" no="Not yet"
          onConfirm=${() => { publish(); }}>
          ${target ? `Build and publish ${target}` : 'Build and publish'}
        <//>
        ${problem && !busyKind ? html`<span class="hint">${problem}</span>` : null}
        ${busyKind && !busy ? html`<span class="hint">Wait for the addon to finish publishing.</span>` : null}
      </div>
    </div>
  <//>`;
}

// ---------- build log ----------

function elapsed(fromIso, now) {
  const start = Date.parse(fromIso || '');
  if (!start) return '';
  const s = Math.max(0, Math.round((now - start) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

function useSecondTick(active) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

function LogCard({ lines, busyKind, job, cancelling, onCancel, onClear }) {
  const box = useRef(null);
  const stick = useRef(true); // follow new lines unless the reader scrolled up
  const [startedAt, setStartedAt] = useState(null);
  const now = useSecondTick(Boolean(busyKind));

  useEffect(() => {
    if (busyKind) setStartedAt((s) => s || job?.startedAt || new Date().toISOString());
    else setStartedAt(null);
  }, [busyKind, job?.startedAt]);

  useEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const onScroll = () => {
    const el = box.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  if (!lines.length && !busyKind) return null;
  const text = lines.map((l) => l.line).join('\n');
  const failed = !busyKind && lines.some((l) => l.level === 'error');

  return html`<${Card} title=${busyKind === 'app' ? 'App build' : busyKind === 'addon' ? 'Publishing the addon' : 'Last publish'} flush class="releases-log-card"
      sub=${busyKind && startedAt ? `running for ${elapsed(startedAt, now)}` : ''}
      actions=${html`<div class="row nowrap">
        ${busyKind ? html`<${Spinner} size="sm" label="Working" />` : failed ? html`<${Pill} kind="alarm" dot>Failed<//>` : lines.length ? html`<${Pill} kind="ok" dot>Finished<//>` : null}
        ${busyKind && onCancel ? html`<${Button} size="sm" variant="danger" busy=${cancelling} onClick=${onCancel}>Cancel<//>` : null}
        ${lines.length ? html`<${CopyButton} text=${text} label="Copy" done="Log copied." />` : null}
        ${!busyKind && lines.length ? html`<${Button} size="sm" variant="ghost" onClick=${onClear}>Clear<//>` : null}
      </div>`}>
    <div class="releases-log mono" ref=${box} onScroll=${onScroll} role="log" aria-live="polite" aria-label="Build output">
      ${lines.length ? lines.map((l) => html`<div key=${l.id} class=${`releases-log-line is-${l.level}`}>${l.line}</div>`)
        : html`<div class="releases-log-line muted">Starting…</div>`}
    </div>
  <//>`;
}

// ---------- command line ----------

function Command({ cmd, label }) {
  return html`<div class="releases-cmd">
    ${label ? html`<span class="releases-cmd-label">${label}</span>` : null}
    <div class="releases-cmd-row">
      <code class="releases-cmd-text">${cmd}</code>
      <${CopyButton} text=${cmd} label="Copy" done="Command copied." />
    </div>
  </div>`;
}

function CommandLineCard({ st }) {
  const sep = st.repoDir && st.repoDir.includes('\\') ? '\\' : '/';
  const docs = st.repoDir ? [st.repoDir.replace(/[\\/]+$/, ''), 'docs', 'RELEASING.md'].join(sep) : null;
  const openDocs = async () => {
    try { await gc.app.openPath(docs); } catch (err) { toast(err?.message || "Couldn't open the guide.", 'alarm'); }
  };
  return html`<${Card} title="From the command line" sub="the same releases, from a terminal or CI"
      actions=${docs ? html`<${Button} size="sm" variant="ghost" icon="external" onClick=${openDocs}>Open RELEASING.md<//>` : null}>
    <div class="stack">
      <p class="muted">Run these at the root of the source checkout. They need the publish token: set <code>PUBLISH_TOKEN</code> on the server
        and the same value as <code>GUILDCAMP_PUBLISH_TOKEN</code> on your computer (or in <code>.release.json</code>).
        ${st.server ? html` Point them at this server with <code>GUILDCAMP_SERVER=${st.server}</code>.` : null}</p>
      <div class="stack releases-cmds">
        <${Command} label="Check what's published" cmd="node scripts/release.js status" />
        <${Command} label="Publish the addon" cmd='node scripts/release.js addon --bump patch --notes "What changed"' />
        <${Command} label="Build and publish the app" cmd="node scripts/release.js app --bump minor --notes-from-git" />
        <${Command} label="Both at once" cmd='node scripts/release.js all --bump patch --notes "What changed"' />
      </div>
      <h4 class="releases-subhead">Let GitHub Actions do it</h4>
      <p class="muted">These bump the version, commit, tag (<code>addon-v…</code> or <code>app-v…</code>) and push. The release workflow then builds and publishes on GitHub's Windows machines.</p>
      <div class="stack releases-cmds">
        <${Command} label="Addon through CI" cmd="node scripts/release.js addon --bump patch --tag-only --push" />
        <${Command} label="App through CI" cmd="node scripts/release.js app --bump minor --tag-only --push" />
      </div>
      <p class="hint">${docs ? 'docs/RELEASING.md' : 'docs/RELEASING.md in the source checkout'} explains first-time setup, rolling back, and what each error means.</p>
    </div>
  <//>`;
}
