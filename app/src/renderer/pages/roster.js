// Roster: every character from your in-game roster scans, plus characters of players who use Guild Camp.
// Filter by name, zone, rank or player; show only who is online, or only mains. Click a row for the character page.
// The Guild Master and officers (from in-game ranks and the guild's officer_rank_max) are marked by their rank.
// Data: GET /api/roster (docs/api/community.md).
import { html, useMemo } from '../lib/html.js';
import { useApi } from '../lib/api.js';
import { useSession } from '../lib/session.js';
import { roleForRank, ROLE_NAMES } from '../lib/status.js';
import { navigate, setQuery } from '../lib/router.js';
import { CLASSES, className, plural, parseTime } from '../lib/format.js';
import {
  Page, Card, Table, Input, Select, Checkbox, Pill, Async, Empty, Button, ClassName, TimeAgo, Stat,
} from '../components/index.js';

const shortTag = (bt) => String(bt || '').split('#')[0];

// Exported for tests: the filter the page applies.
export function filterRoster(chars, { q = '', cls = '', online = false, mains = false } = {}) {
  const needle = String(q).trim().toLowerCase();
  return chars.filter((c) => {
    if (online && !c.online) return false;
    if (mains && !c.is_main) return false;
    if (cls && String(c.class || '').toUpperCase() !== cls) return false;
    if (!needle) return true;
    return [c.name, c.zone, c.rank, shortTag(c.battletag)].some((v) => v && String(v).toLowerCase().includes(needle));
  });
}

export default function RosterPage({ query = {} }) {
  const roster = useApi('/api/roster', { interval: 60000 });
  const filters = { q: query.q || '', cls: query.class || '', online: query.online === '1', mains: query.mains === '1' };
  return html`<${Page} title="Roster" width="wide"
      actions=${html`<${Button} variant="ghost" size="sm" icon="refresh" busy=${roster.refreshing} onClick=${roster.reload}>Refresh<//>`}>
    <${Async} q=${roster} loadingLabel="Reading the roster…">
      ${(d) => html`<${RosterBody} d=${d} filters=${filters} />`}
    <//>
  <//>`;
}

function RosterBody({ d, filters }) {
  const { guild } = useSession();
  const rankMax = guild?.officer_rank_max ?? null;
  const rows = useMemo(() => filterRoster(d.characters, filters), [d.characters, filters.q, filters.cls, filters.online, filters.mains]);
  const classes = useMemo(() => {
    const present = new Set(d.characters.map((c) => String(c.class || '').toUpperCase()).filter(Boolean));
    return CLASSES.filter((c) => present.has(c)).map((c) => ({ value: c, label: className(c) }));
  }, [d.characters]);
  const filtered = filters.q || filters.cls || filters.online || filters.mains;
  // A linked character only counts as an alt when its player has picked a main.
  const hasMain = useMemo(() => new Set(d.characters.filter((c) => c.is_main && c.user_id).map((c) => c.user_id)), [d.characters]);

  const columns = useMemo(() => [
    {
      key: 'name', label: 'Name', sortable: true,
      render: (c) => html`<span class="row nowrap roster-name">
        ${c.online ? html`<span class="dot" title="Online now"></span>` : html`<span class="roster-dot-off" aria-hidden="true"></span>`}
        <${ClassName} name=${c.name} cls=${c.class} />
        ${c.is_main ? html`<${Pill} kind="accent">Main<//>` : c.user_id && hasMain.has(c.user_id) ? html`<${Pill} kind="muted">Alt<//>` : null}
        ${c.is_bank ? html`<${Pill} kind="info">Bank<//>` : null}
      </span>`,
    },
    { key: 'level', label: 'Level', num: true, sortable: true, width: '70px' },
    { key: 'class', label: 'Class', sortable: true, value: (c) => className(c.class), render: (c) => (c.class ? className(c.class) : '') },
    {
      key: 'rank', label: 'Rank', sortable: true, value: (c) => c.rank_index ?? null,
      render: (c) => {
        const role = roleForRank(c.rank_index, rankMax);
        // The role only needs saying when the rank's own name doesn't say it already.
        const same = role && String(c.rank || '').trim().toLowerCase() === ROLE_NAMES[role].toLowerCase();
        return html`<span class="row nowrap roster-rank">${c.rank || ''}${role && role !== 'member' && !same
          ? html`<${Pill} kind=${role === 'owner' ? 'accent' : 'info'} title="Their rank makes them this in Guild Camp">${ROLE_NAMES[role]}<//>` : null}</span>`;
      },
    },
    { key: 'zone', label: 'Zone', sortable: true, render: (c) => html`<span class="ellipsis roster-zone" title=${c.zone || ''}>${c.zone || ''}</span>` },
    { key: 'battletag', label: 'Player', sortable: true, value: (c) => shortTag(c.battletag) || null,
      render: (c) => (c.battletag ? html`<span title=${c.battletag}>${shortTag(c.battletag)}</span>` : html`<span class="faint" title="This player doesn't use Guild Camp, or hasn't shared with you yet">—</span>`) },
    {
      key: 'last_seen', label: 'Seen', sortable: true,
      // Online first, then most recently seen.
      value: (c) => (c.online ? Number.MAX_SAFE_INTEGER : parseTime(c.last_seen)?.getTime() ?? null),
      render: (c) => (c.online
        ? html`<span class="ok-text">now</span>`
        : c.last_seen ? html`<span class="muted"><${TimeAgo} t=${c.last_seen} /></span>`
          : c.in_official_roster ? html`<span class="muted" title="From Blizzard's official guild list">in guild</span>` : ''),
    },
  ], [hasMain, rankMax]);

  return html`
    <div class="roster-stats">
      <${Stat} label="Characters" value=${d.counts.total} />
      <${Stat} label="Online now" value=${d.counts.online} />
      <${Stat} label="With Guild Camp" value=${d.counts.linked} />
      <${Stat} label="Mains" value=${d.counts.mains} />
      <p class="muted small roster-scanned">
        ${d.scannedAt ? html`Roster as of <${TimeAgo} t=${d.scannedAt} />. ` : 'No roster scan yet. '}A player name means that player uses Guild Camp.
      </p>
    </div>
    <${Card} flush class="roster-card"
        title=${filtered ? `${plural(rows.length, 'character')} shown` : plural(d.characters.length, 'character')}
        actions=${html`<div class="row roster-filters">
          <${Input} type="search" placeholder="Name, zone, rank or player" value=${filters.q} aria-label="Filter the roster"
            onValue=${(v) => setQuery({ q: v || undefined })} class="roster-search" />
          <${Select} aria-label="Class" value=${filters.cls} placeholder="All classes" options=${[{ value: '', label: 'All classes' }, ...classes]}
            onValue=${(v) => setQuery({ class: v || undefined })} class="roster-class" />
          <${Checkbox} label="Online only" checked=${filters.online} onValue=${(v) => setQuery({ online: v ? '1' : undefined })} />
          <${Checkbox} label="Mains only" checked=${filters.mains} onValue=${(v) => setQuery({ mains: v ? '1' : undefined })} />
        </div>`}>
      ${d.characters.length
        ? html`<${Table} columns=${columns} rows=${rows} rowKey=${(c) => c.name}
            dense
            rowClass=${(c) => (c.online ? 'roster-online' : undefined)}
            onRowClick=${(c) => navigate(`/characters/${encodeURIComponent(c.name)}`)}
            empty=${html`<${Empty} compact icon="search" title="No characters match these filters." />`} />`
        : html`<${Empty} icon="roster" title="No characters yet.">The roster fills in after your first sync. Open the guild roster in game, then log out or type /reload.<//>`}
    <//>`;
}
