// Guild settings (/guild-settings, everyone): which in-game ranks are officers here and which other ranks pass on
// officer changes in game (relay_rank_max; only the Guild Master changes them; they spread to guildmates through
// the addon), item tooltips, the Coach's AI (your own key and budget), the realm and Blizzard's game data, and a
// read-only list of members with the role their rank gives.
// Data: GET /api/guild, PUT /api/guild/settings, GET /api/roster, GET /api/members, GET /api/coach (usage),
// GET /api/meta (whether Blizzard game data is built in) and, for officers, GET /api/admin/status +
// POST /api/admin/gamedata/refresh.
import { html, useState, useEffect, useMemo } from '../lib/html.js';
import { api, useApi, useAction } from '../lib/api.js';
import { useSession, refreshSession } from '../lib/session.js';
import { parseTime, plural } from '../lib/format.js';
import { Link } from '../lib/router.js';
import { roleForRank, isNoGuild } from '../lib/status.js';
import {
  Page, Card, Table, Button, Input, Select, Checkbox, Notice, Progress, Async, ClassName, TimeAgo, toast,
} from '../components/index.js';
import { ShareHint } from '../components/ShareHint.js';
import { NoGuild } from '../components/NoGuild.js';
import { RolePill, RealmLine, usd } from './admin.js';

const FALLBACK_GAMES = [
  { value: 'forever', label: 'WoW: Forever' },
  { value: 'retail', label: 'Retail' },
  { value: 'classic', label: 'Classic' },
];
// How many "Guild Master and N ranks below" choices to offer when the roster doesn't show more ranks.
const MIN_RANK_CHOICES = 3;
const MAX_RANK = 9;

/**
 * After a saved PUT /api/guild/settings answer: this page's copy of the guild, a toast of the core's messages, and
 * the app's session, which every other page reads the guild from (item tooltips' Wowhead database, which ranks are
 * officers). The core doesn't announce these settings, so without this other pages keep the old ones until a
 * restart. Exported for tests. → the saved guild, or null.
 */
export function settingsSaved(value, onGuild) {
  if (value?.guild && typeof onGuild === 'function') onGuild(value.guild);
  toast((value?.messages || []).join(' ') || 'Saved.', 'ok');
  refreshSession().catch(() => { /* the session keeps what it had */ });
  return value?.guild || null;
}

// PUT /api/guild/settings with a toast of the core's messages. Resolves the saved guild, or null.
function useSaveSettings(onGuild) {
  const save = useAction((body) => api.put('/api/guild/settings', body));
  const run = async (body) => {
    const r = await save.run(body);
    return r.ok ? settingsSaved(r.value, onGuild) : null;
  };
  return { run, busy: save.busy };
}

// ---------- officer ranks (exported for tests) ----------

// guilds.officer_rank_max: characters whose in-game rank index is at or below it are officers here (rank 0, the
// Guild Master, is always the guild's owner). "Off" (null) and 0 mean the same thing: only the Guild Master.

// officer_rank_max (null | 0–9) → select value ('0'–'9'). Off is shown as '0'; the core's default is 1.
export function rankToValue(n) {
  if (n === undefined) return '1';
  if (n === null || n === '') return '0';
  const i = Number(n);
  return Number.isInteger(i) && i >= 0 && i <= MAX_RANK ? String(i) : '0';
}

// Select value → officer_rank_max for PUT /api/guild/settings.
export function valueToRank(v) {
  if (v === '' || v === null || v === undefined) return 0;
  const i = Number(v);
  return Number.isInteger(i) && i >= 0 && i <= MAX_RANK ? i : 0;
}

/** The PUT body for the officer ranks card: {} when nothing changes (Off and 0 count as the same). */
export function rankChange(guild, value) {
  const next = valueToRank(value);
  return next === valueToRank(rankToValue(guild?.officer_rank_max)) ? {} : { officer_rank_max: next };
}

function rankLabel(n, names) {
  if (n === 0) return 'Only the Guild Master';
  const below = [];
  for (let i = 1; i <= n; i++) below.push(names && names.get(i));
  if (below.every(Boolean)) {
    if (n === 1) return `Guild Master and ${below[0]}`;
    if (n === 2) return `Guild Master, ${below[0]} and ${below[1]}`;
    return `Guild Master and the ${n} ranks below (${below.join(', ')})`;
  }
  return `Guild Master and ${n} rank${n === 1 ? '' : 's'} below`;
}

/**
 * The officer rank choices. `names` maps rank index → in-game rank name (from the roster) so the choices read like
 * the game; without names they say "Guild Master and 2 ranks below". Offers at least 3 ranks below the Guild
 * Master, every rank the roster shows, and the saved value.
 */
export function officerRankOptions(current, names = null) {
  const saved = Number(rankToValue(current));
  const known = names ? Math.max(0, ...[...names.keys()].filter((k) => Number.isInteger(k))) : 0;
  const top = Math.min(MAX_RANK, Math.max(MIN_RANK_CHOICES, known, saved));
  const out = [];
  for (let n = 0; n <= top; n++) out.push({ value: String(n), label: rankLabel(n, names) });
  return out;
}

/**
 * The guild's ranks from the roster: [{ index, name, characters, online, role }] by rank, with the role each
 * rank gives under `officerRankMax`. Characters without a known rank index are left out.
 */
export function rankRows(characters, officerRankMax) {
  const map = new Map();
  for (const c of characters || []) {
    const i = c && c.rank_index;
    if (i === null || i === undefined || !Number.isInteger(Number(i))) continue;
    const idx = Number(i);
    if (!map.has(idx)) map.set(idx, { index: idx, name: null, characters: 0, online: 0 });
    const row = map.get(idx);
    row.characters += 1;
    if (c.online) row.online += 1;
    if (!row.name && c.rank) row.name = String(c.rank);
  }
  return [...map.values()].sort((a, b) => a.index - b.index)
    .map((r) => ({ ...r, name: r.name || (r.index === 0 ? 'Guild Master' : `Rank ${r.index}`), role: roleForRank(r.index, officerRankMax) }));
}

const rankNames = (rows) => new Map(rows.map((r) => [r.index, r.name]));

// ---------- who passes on officer changes (exported for tests) ----------

// guilds.relay_rank_max (docs/SHARING.md §5): besides officers, characters at this in-game rank or above pass on
// officer changes (a new raid, a notice, loot) to guildmates in game. null = officers only. A value at or above
// the officer ranks adds nobody, so it reads as "officers only".

const officerMaxOf = (guild) => valueToRank(rankToValue(guild?.officer_rank_max));

/** relay_rank_max → select value: 'none' or '0'–'9'. */
export function relayToValue(relay, officerRankMax) {
  if (relay === null || relay === undefined || relay === '') return 'none';
  const n = Number(relay);
  if (!Number.isInteger(n) || n < 0 || n > MAX_RANK) return 'none';
  const officers = Number.isInteger(Number(officerRankMax)) && officerRankMax !== null && officerRankMax !== '' ? Number(officerRankMax) : 0;
  return n <= officers ? 'none' : String(n);
}

/** Select value → relay_rank_max for PUT /api/guild/settings (null = officers only). */
export function valueToRelay(v) {
  if (v === 'none' || v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= MAX_RANK ? n : null;
}

/** The PUT body for the relay card: {} when nothing changes. */
export function relayChange(guild, value) {
  const officers = officerMaxOf(guild);
  const now = valueToRelay(relayToValue(guild?.relay_rank_max, officers));
  const next = valueToRelay(relayToValue(valueToRelay(value), officers));
  return now === next ? {} : { relay_rank_max: next };
}

function relayLabel(n, officers, names) {
  if (n === null) return 'Only officers';
  const extra = [];
  for (let i = officers + 1; i <= n; i++) extra.push(names && names.get(i));
  const k = extra.length;
  if (extra.every(Boolean)) {
    if (k === 1) return `Officers and ${extra[0]}`;
    if (k === 2) return `Officers, ${extra[0]} and ${extra[1]}`;
    return `Officers and the ${k} ranks below them (${extra.join(', ')})`;
  }
  return `Officers and ${k} rank${k === 1 ? '' : 's'} below them`;
}

/**
 * The relay choices: "Only officers", then each rank below the officer ranks, named as in the game when the roster
 * knows the names. Offers at least 2 ranks below the officers, every rank the roster shows, and the saved value.
 */
export function relayOptions(guild, names = null) {
  const officers = officerMaxOf(guild);
  const saved = valueToRelay(relayToValue(guild?.relay_rank_max, officers));
  const known = names ? Math.max(0, ...[...names.keys()].filter((k) => Number.isInteger(k))) : 0;
  const top = Math.min(MAX_RANK, Math.max(officers + 2, known, saved ?? 0));
  const out = [{ value: 'none', label: relayLabel(null, officers, names) }];
  for (let n = officers + 1; n <= top; n++) out.push({ value: String(n), label: relayLabel(n, officers, names) });
  return out;
}

// ---------- page ----------

// ?section=<id> scrolls to that card (links from elsewhere, and the smoke run's screenshots).
const SECTIONS = ['ranks', 'relay', 'tooltips', 'coach', 'realm', 'members'];

export default function GuildSettingsPage({ query = {} }) {
  const session = useSession();
  const g = useApi('/api/guild');
  const roster = useApi('/api/roster');
  const ready = g.data !== undefined;
  useEffect(() => {
    if (!ready || !SECTIONS.includes(query.section)) return undefined;
    // Wait a moment so the cards below have their content and the page doesn't jump away again.
    const t = setTimeout(() => document.getElementById(`guild-settings-${query.section}`)?.scrollIntoView({ block: 'start' }), 200);
    return () => clearTimeout(t);
  }, [ready, query.section]);
  const setGuild = (guild) => g.setData((d) => ({ ...d, guild: { ...(d?.guild || {}), ...guild } }));

  return html`<${Page} title="Guild settings" width="normal"
      lede="Which ranks are officers and who passes on their changes, item tooltips, the Coach, and Blizzard's game data. Roles come from your in-game guild ranks.">
    ${g.error && isNoGuild(g.error) ? html`<${NoGuild} error=${g.error} />` : html`<${Async} q=${g} loadingLabel="Loading guild settings…">
      ${(data) => html`<div class="stack stack--loose guild-settings">
        <div class="guild-settings-trust">
          <${OfficerRanksCard} guild=${data.guild} roster=${roster} isOwner=${session.isOwner} onGuild=${setGuild} />
          <${RelayCard} guild=${data.guild} roster=${roster} isOwner=${session.isOwner} onGuild=${setGuild} />
        </div>
        <div class="grid-2 guild-settings-pair">
          <div class="stack stack--loose">
            <${TooltipsCard} guild=${data.guild} options=${data.options?.wowheadGames} onGuild=${setGuild} />
            <${CoachCard} guild=${data.guild} onGuild=${setGuild} />
          </div>
          <${RealmCard} guild=${data.guild} isOfficer=${session.isOfficer} onGuild=${setGuild} />
        </div>
        <${MembersCard} guild=${data.guild} roster=${roster} />
      </div>`}
    <//>`}
  <//>`;
}

// ---------- officer ranks ----------

function OfficerRanksCard({ guild, roster, isOwner, onGuild }) {
  const [value, setValue] = useState(rankToValue(guild.officer_rank_max));
  const save = useSaveSettings(onGuild);
  useEffect(() => { setValue(rankToValue(guild.officer_rank_max)); }, [guild.officer_rank_max]);

  const savedRows = useMemo(() => rankRows(roster.data?.characters, guild.officer_rank_max), [roster.data, guild.officer_rank_max]);
  const names = useMemo(() => rankNames(savedRows), [savedRows]);
  const options = officerRankOptions(guild.officer_rank_max, names);
  const change = rankChange(guild, value);
  const changed = Object.keys(change).length > 0;
  // While the Guild Master picks, the table shows the roles the new choice would give.
  const shown = changed ? rankRows(roster.data?.characters, valueToRank(value)) : savedRows;
  const savedLabel = (options.find((o) => o.value === rankToValue(guild.officer_rank_max)) || options[0]).label;

  const submit = async (e) => {
    e?.preventDefault();
    if (changed) await save.run(change);
  };

  const columns = [
    { key: 'index', label: 'Rank', width: '70px', render: (r) => html`<span class="num muted">${r.index}</span>` },
    { key: 'name', label: 'Name in game', render: (r) => html`<strong>${r.name}</strong>` },
    { key: 'characters', label: 'Characters', num: true, render: (r) => html`${r.characters}${r.online ? html` <span class="muted small">(${r.online} online)</span>` : null}` },
    { key: 'role', label: 'Role in Guild Camp', render: (r) => html`<${RolePill} role=${r.role} />` },
  ];

  return html`<${Card} id="guild-settings-ranks" title="Officer ranks" class="guild-settings-ranks"
      sub=${isOwner ? null : 'set by the Guild Master'}>
    <div class="guild-settings-ranks-grid">
      <form class="stack" onSubmit=${submit}>
        <p class="mb-0">Your rank in the in-game guild decides your role here. The Guild Master is always in charge.
          Officers can schedule raids, post notices, run drives and hand out loot.</p>
        ${isOwner ? html`
          <${Select} label="Officers are" options=${options} value=${value} onValue=${setValue}
            hint="Pick the lowest rank that should count as an officer. Everyone at that rank or above is one." />
          <div class="form-actions">
            <${Button} type="submit" variant="primary" busy=${save.busy} disabled=${!changed}>Save<//>
            ${changed ? html`<${Button} variant="ghost" onClick=${() => setValue(rankToValue(guild.officer_rank_max))}>Undo<//>` : null}
          </div>
          <p class="hint mb-0">Saving changes roles here at once. Guildmates' Guild Camp follows your choice when the addon passes it on.</p>
          <${ShareHint} gm />`
        : html`
          <div class="guild-settings-current">
            <span class="field-label">Officers are</span>
            <strong>${savedLabel}</strong>
          </div>
          <p class="hint mb-0">Only the Guild Master can change this. Their choice reaches you through the addon, after you log in to WoW or type /reload.</p>`}
      </form>
      <div class="guild-settings-ranks-table">
        ${roster.error && !roster.data ? html`<${Notice} kind="warn">${roster.error.message}<//>` : null}
        ${roster.data
          ? (shown.length
            ? html`<${Table} columns=${columns} rows=${shown} rowKey=${(r) => r.index} dense
                rowClass=${(r) => (r.role === 'member' ? undefined : 'guild-settings-rank--lead')} />`
            : html`<p class="muted mb-0">The ranks show here after your first sync. Open the guild roster in game, then log out or type /reload.</p>`)
          : roster.loading ? html`<p class="muted mb-0">Reading the roster…</p>` : null}
        ${changed && shown.length ? html`<p class="hint mb-0">These are the roles after you save.</p>` : null}
      </div>
    </div>
  <//>`;
}

// ---------- who passes on officer changes ----------

function RelayCard({ guild, roster, isOwner, onGuild }) {
  const officers = officerMaxOf(guild);
  const [value, setValue] = useState(relayToValue(guild.relay_rank_max, officers));
  const save = useSaveSettings(onGuild);
  useEffect(() => { setValue(relayToValue(guild.relay_rank_max, officers)); }, [guild.relay_rank_max, officers]);

  const names = useMemo(() => rankNames(rankRows(roster.data?.characters, guild.officer_rank_max)), [roster.data, guild.officer_rank_max]);
  const options = relayOptions(guild, names);
  const change = relayChange(guild, value);
  const changed = Object.keys(change).length > 0;
  const savedValue = relayToValue(guild.relay_rank_max, officers);
  const savedLabel = (options.find((o) => o.value === savedValue) || options[0]).label;

  const submit = async (e) => {
    e?.preventDefault();
    if (changed) await save.run(change);
  };

  return html`<${Card} id="guild-settings-relay" title="Who passes on officer changes" class="guild-settings-relay"
      sub=${isOwner ? null : 'set by the Guild Master'}>
    <form class="stack" onSubmit=${submit}>
      <p class="mb-0">New raids, notices and loot travel from guildmate to guildmate in game. Officers always pass them on.
        Letting more ranks do it too spreads changes faster when no officer is online, but means trusting more people.</p>
      ${isOwner ? html`
        <${Select} label="Passed on by" options=${options} value=${value} onValue=${setValue} />
        <div class="form-actions">
          <${Button} type="submit" variant="primary" busy=${save.busy} disabled=${!changed}>Save<//>
          ${changed ? html`<${Button} variant="ghost" onClick=${() => setValue(savedValue)}>Undo<//>` : null}
        </div>
        <${ShareHint} gm />`
      : html`
        <div class="guild-settings-current">
          <span class="field-label">Passed on by</span>
          <strong>${savedLabel}</strong>
        </div>
        <p class="hint mb-0">Only the Guild Master can change this.</p>`}
    </form>
  <//>`;
}

// ---------- item tooltips ----------

function TooltipsCard({ guild, options, onGuild }) {
  const games = options && options.length ? options : FALLBACK_GAMES;
  const [game, setGame] = useState(guild.wowhead_game || 'forever');
  const save = useSaveSettings(onGuild);
  useEffect(() => { setGame(guild.wowhead_game || 'forever'); }, [guild.wowhead_game]);
  return html`<${Card} id="guild-settings-tooltips" title="Item tooltips">
    <p>Hover over an item anywhere in Guild Camp to see its Wowhead tooltip. Pick the game you play so the stats match.</p>
    <div class="form-row">
      <${Select} label="Wowhead database" options=${games} value=${game} onValue=${setGame} />
      <${Button} busy=${save.busy} disabled=${game === guild.wowhead_game} onClick=${() => save.run({ wowhead_game: game })}>Save<//>
    </div>
  <//>`;
}

// ---------- Coach AI (this PC: your own key, your own budget) ----------

function CoachCard({ guild, onGuild }) {
  const coach = useApi('/api/coach', { refreshOn: ['coach'] });
  const [enabled, setEnabled] = useState(Boolean(guild.coach_enabled));
  const [budget, setBudget] = useState(String(guild.coach_budget_usd ?? 15));
  const [error, setError] = useState(null);
  const save = useSaveSettings((saved) => { onGuild(saved); coach.reload(); });
  useEffect(() => {
    setEnabled(Boolean(guild.coach_enabled));
    setBudget(String(guild.coach_budget_usd ?? 15));
  }, [guild.coach_enabled, guild.coach_budget_usd]);

  const submit = async (e) => {
    e?.preventDefault();
    const n = Number(budget);
    if (budget.trim() === '' || !Number.isFinite(n) || n < 0 || n > 500) { setError('Set a monthly budget between $0 and $500.'); return; }
    setError(null);
    await save.run({ coach_enabled: enabled, coach_budget_usd: n });
  };
  const d = coach.data;
  const usage = d?.usage;
  const spent = Number(usage?.spentUsd) || 0;
  const cap = Number(guild.coach_budget_usd) || 0;
  const changed = enabled !== Boolean(guild.coach_enabled) || Number(budget) !== Number(guild.coach_budget_usd ?? 15);

  return html`<${Card} id="guild-settings-coach" title="Coach AI">
    <form class="stack" onSubmit=${submit}>
      <p class="mb-0">The Coach writes build plans and answers questions with Claude, using your own Anthropic API key.
        The budget caps what you spend each month. These choices are for this PC only.</p>
      ${d && d.ai && !d.ai.hasKey ? html`<${Notice} kind="info" title="No API key yet.">
        Add your Anthropic API key in Settings to turn on plans and answers. Play-style tracking works without it.
        <div class="guild-settings-notice-action"><${Button} size="sm" icon="key" href="/settings?section=coach">Add your key in Settings<//></div>
      <//>` : null}
      <${Checkbox} label="Coach AI on" checked=${enabled} onValue=${setEnabled}
        hint="Off stops new plans and answers. Your play style and next steps keep working." />
      <div class="form-row">
        <${Input} label="Monthly budget (USD)" type="number" min="0" max="500" step="1" value=${budget} error=${error}
          onValue=${(v) => { setBudget(v); if (error) setError(null); }} />
        <${Button} type="submit" busy=${save.busy} disabled=${!changed}>Save<//>
      </div>
      ${usage ? html`<${Progress} value=${cap > 0 ? Math.min(spent, cap) : 0} max=${cap > 0 ? cap : 1} label="Spent this month"
          valueText=${`about ${usd(spent)} of ${usd(cap)}`} kind=${cap > 0 && spent >= cap ? 'alarm' : undefined} />
        <p class="hint mb-0">${plural(usage.questions || 0, 'question')} and ${plural(usage.plans || 0, 'plan')} this month.
          You can ask ${d.limits?.questionsPerDay ?? 30} questions and make ${d.limits?.plansPerDay ?? 5} plans a day.</p>` : null}
    </form>
  <//>`;
}

// ---------- realm and Blizzard game data ----------

function RealmCard({ guild, isOfficer, onGuild }) {
  const meta = useApi('/api/meta', { focus: false });
  const blizzard = meta.data ? Boolean(meta.data.blizzard) : null; // null while asking
  const status = useApi(isOfficer && blizzard ? '/api/admin/status' : null);
  const [realm, setRealm] = useState(guild.realm || '');
  const [gameGuild, setGameGuild] = useState(guild.game_guild || '');
  const save = useSaveSettings(onGuild);
  const refresh = useAction(() => api.post('/api/admin/gamedata/refresh'));
  useEffect(() => { setRealm(guild.realm || ''); setGameGuild(guild.game_guild || ''); }, [guild.realm, guild.game_guild]);

  const gd = status.data?.gameData;
  const live = Boolean(gd?.liveData);
  const changed = realm.trim() !== (guild.realm || '') || gameGuild.trim() !== (guild.game_guild || '');

  const submit = async (e) => {
    e?.preventDefault();
    const saved = await save.run({ realm: realm.trim(), game_guild: gameGuild.trim() });
    if (saved) status.reload();
  };
  const runRefresh = async () => {
    const r = await refresh.run();
    if (!r.ok) return;
    if (r.value?.gameData) status.setData((d) => ({ ...(d || {}), gameData: r.value.gameData }));
    toast(r.value?.message || 'Refreshed.', r.value?.log?.length ? 'ok' : 'info');
  };

  const canEdit = isOfficer && blizzard;
  return html`<${Card} id="guild-settings-realm" title="Realm and game data"
      actions=${canEdit ? html`<${Button} size="sm" icon="sync" busy=${refresh.busy} onClick=${runRefresh}>Refresh now<//>` : null}>
    <div class="stack">
      <dl class="admin-facts">
        <div class="admin-fact"><dt>Realm</dt><dd><${RealmLine} status=${guild.realm_status} realm=${guild.realm} /></dd></div>
        <div class="admin-fact"><dt>Guild in game</dt><dd>${guild.game_guild || guild.name || html`<span class="muted">Not known yet</span>`}</dd></div>
      </dl>
      ${blizzard === false ? html`<${Notice} kind="info" title="Blizzard game data is off.">
        This copy of Guild Camp has no Battle.net app built in, so realm status and the official guild list aren't available.
        Item tooltips and everything else still work.
      <//>` : null}
      ${blizzard && !isOfficer ? html`<p class="hint mb-0">Guild Camp reads your realm and guild name from the game. Officers can refresh realm status here.</p>` : null}
      ${canEdit ? html`<form class="stack" onSubmit=${submit}>
        <p class="mb-0">Guild Camp reads Blizzard's free game data: item names and stats${live
          ? ', whether your realm is up (with a notification when it comes back), and the official guild list.'
          : ' now, and your realm status and the official guild list once Blizzard adds WoW: Forever to its API.'}</p>
        <div class="form-grid">
          <${Input} label="Realm" value=${realm} onValue=${setRealm} maxLength="60" placeholder="Read from the game" />
          <${Input} label="Guild name in game" value=${gameGuild} onValue=${setGameGuild} maxLength="60" placeholder=${guild.name || ''} />
        </div>
        <div class="form-actions">
          <${Button} type="submit" variant="primary" busy=${save.busy} disabled=${!changed}>Save<//>
          <span class="hint">The addon fills these in. Change them only if they're wrong.</span>
        </div>
      </form>` : null}
      ${canEdit ? html`<div class="guild-settings-status">
        ${status.error && !status.data ? html`<${Notice} kind="warn">${status.error.message}<//>` : null}
        ${gd ? html`<dl class="admin-facts">
          <div class="admin-fact"><dt>Item data</dt><dd>${gd.namespaces?.label || 'Nothing yet'}<span class="muted small"> · ${gd.itemsKnown || 0} items known</span></dd></div>
          <div class="admin-fact"><dt>Official guild list</dt><dd>${gd.official_roster_note
            ? html`${gd.official_roster_note} <span class="muted small">· <${TimeAgo} t=${gd.official_roster_at} /></span>`
            : html`<span class="muted">${live ? 'Not fetched yet.' : 'Arrives once Blizzard adds WoW: Forever.'}</span>`}</dd></div>
        </dl>` : status.loading ? html`<p class="muted mb-0">Loading game data status…</p>` : null}
      </div>` : null}
    </div>
  <//>`;
}

// ---------- members (read-only: roles come from in-game ranks) ----------

function MembersCard({ guild, roster }) {
  const q = useApi('/api/members');
  const names = useMemo(() => rankNames(rankRows(roster.data?.characters, guild.officer_rank_max)), [roster.data, guild.officer_rank_max]);
  const elsewhere = roster.data ? roster.data.characters.filter((c) => !c.user_id && c.rank).length : 0;

  const columns = useMemo(() => [
    {
      key: 'battletag', label: 'Player', sortable: true, value: (m) => String(m.battletag || '').toLowerCase(),
      render: (m) => html`<span class="guild-settings-who">
        <strong>${m.battletag}</strong>${m.isMe ? html` <span class="muted small">(you)</span>` : null}
      </span>`,
    },
    {
      key: 'role', label: 'Role', sortable: true, value: (m) => ({ owner: 0, officer: 1, member: 2 }[m.role] ?? 3),
      render: (m) => html`<${RolePill} role=${m.role} />`,
    },
    {
      key: 'rank_index', label: 'Rank in game', sortable: true, value: (m) => m.rank_index ?? null,
      render: (m) => (m.rank_index == null
        ? html`<span class="muted small">not seen yet</span>`
        : html`${names.get(m.rank_index) || `Rank ${m.rank_index}`}`),
    },
    {
      key: 'main', label: 'Main', sortable: true, value: (m) => m.main?.name || null,
      render: (m) => (m.main
        ? html`<span class="row nowrap"><${ClassName} name=${m.main.name} cls=${m.main.class} />${m.main.level ? html`<span class="muted small">${m.main.level}</span>` : null}</span>`
        : html`<span class="muted small">none yet</span>`),
    },
    { key: 'characters', label: 'Characters', num: true, sortable: true },
    {
      key: 'last_sync_at', label: 'Last sync', sortable: true, value: (m) => (m.last_sync_at ? parseTime(m.last_sync_at)?.getTime() : null),
      render: (m) => html`<${TimeAgo} t=${m.last_sync_at} never="not yet" />`,
    },
  ], [names]);

  return html`<${Card} id="guild-settings-members" title="Members" sub=${q.data ? plural(q.data.members.length, 'player') : null} flush
      footer=${html`<span>Roles follow in-game ranks, so there is nothing to change here. Promote or demote people in game.
        ${elsewhere ? html` <${Link} href="/roster">${plural(elsewhere, 'more character')}<//> on the roster ${elsewhere === 1 ? 'belongs' : 'belong'} to players who haven't shared with Guild Camp yet.` : null}</span>`}>
    <${Async} q=${q} loadingLabel="Loading members…">
      ${(data) => html`<${Table} columns=${columns} rows=${data.members} rowKey=${(m) => m.id}
        sort=${{ key: 'role', dir: 'asc' }} empty="Nobody yet. Guildmates show up here once their addon shares with yours." />`}
    <//>
  <//>`;
}
