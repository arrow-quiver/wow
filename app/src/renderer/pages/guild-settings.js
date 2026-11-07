// Guild settings (/guild-settings, officers only): how people join (automatic matching, officers from in-game
// ranks, the invite link), members and roles, Discord (channel webhook and slash commands), item tooltips, the
// realm and official Blizzard data, and Coach AI.
// Server shapes: docs/api/core.md (guild, settings, members), docs/api/admin.md (status, game data refresh)
// and the Discord domain's GET /api/discord + POST /api/discord/register.
import { html, useState, useEffect, useMemo } from '../lib/html.js';
import { api, useApi, useAction } from '../lib/api.js';
import { useSession } from '../lib/session.js';
import { parseTime, plural } from '../lib/format.js';
import {
  Page, Card, Table, Button, ConfirmButton, CopyButton, Input, Select, Checkbox, Notice, Pill, Progress, Async,
  ClassName, TimeAgo, toast,
} from '../components/index.js';
import { RolePill, RealmLine, usd } from './admin.js';

// Same rule as the server (routes/guild.js), so a typo is caught before saving.
const WEBHOOK_RE = /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\/[\w/-]+$/;
const FALLBACK_GAMES = [
  { value: 'forever', label: 'WoW: Forever' },
  { value: 'retail', label: 'Retail' },
  { value: 'classic', label: 'Classic' },
];

// PUT /api/guild/settings with a toast of the server's messages. Resolves the saved guild, or null.
function useSaveSettings(onGuild) {
  const save = useAction((body) => api.put('/api/guild/settings', body));
  const run = async (body) => {
    const r = await save.run(body);
    if (!r.ok) return null;
    if (r.value?.guild) onGuild(r.value.guild);
    toast((r.value?.messages || []).join(' ') || 'Saved.', 'ok');
    return r.value?.guild || null;
  };
  return { run, busy: save.busy };
}

// ---------- joining the guild (exported for tests) ----------

// guilds.auto_join: how people who sign in get into the guild without an invite link.
export const AUTO_JOIN_OPTIONS = [
  { value: 'roster', label: 'Automatically, when their character is in the guild roster (recommended)',
    hint: 'They sign in with Battle.net and Guild Camp adds them once one of their characters shows up in the roster.' },
  { value: 'verified', label: 'Only when Battle.net confirms their character',
    hint: 'Stricter: their Battle.net account must list a character that is in the guild.' },
  { value: 'off', label: 'Only with an invite link',
    hint: 'Nobody is added by themselves. Send the invite link instead.' },
];

// guilds.officer_rank_max: members whose in-game rank index is at or below it (0 = Guild Master) are officers here.
export const OFFICER_RANK_OPTIONS = [
  { value: '', label: 'Off' },
  { value: '0', label: 'Guild Master only' },
  { value: '1', label: 'Guild Master and 1 rank below' },
  { value: '2', label: 'Guild Master and 2 ranks below' },
  { value: '3', label: 'Guild Master and 3 ranks below' },
];

// officer_rank_max (null | 0–9) → select value ('' | '0'–'9'). A server that doesn't send it yet means 1, its default.
export function rankToValue(n) {
  if (n === undefined) return '1';
  if (n === null || n === '') return '';
  const i = Number(n);
  return Number.isInteger(i) && i >= 0 && i <= 9 ? String(i) : '';
}

// Select value → officer_rank_max for PUT /api/guild/settings.
export function valueToRank(v) {
  if (v === '' || v === null || v === undefined) return null;
  const i = Number(v);
  return Number.isInteger(i) && i >= 0 && i <= 9 ? i : null;
}

// The select's options, plus the saved value when it is one this list doesn't offer (4–9).
export function officerRankOptions(current) {
  const v = rankToValue(current);
  if (OFFICER_RANK_OPTIONS.some((o) => o.value === v)) return OFFICER_RANK_OPTIONS;
  return [...OFFICER_RANK_OPTIONS, { value: v, label: `Guild Master and ${v} ranks below` }];
}

// The PUT /api/guild/settings body for the Joining card: only what changed (each change is audited).
export function joiningChanges(guild, autoJoin, rankValue) {
  const body = {};
  if (autoJoin !== (guild?.auto_join || 'roster')) body.auto_join = autoJoin;
  if (rankValue !== rankToValue(guild?.officer_rank_max)) body.officer_rank_max = valueToRank(rankValue);
  return body;
}

// ---------- page ----------

// ?section=<id> scrolls to that card (links from elsewhere, and the smoke run's screenshots).
const SECTIONS = ['joining', 'invite', 'members', 'discord', 'tooltips', 'coach', 'realm'];

export default function GuildSettingsPage({ query = {} }) {
  const g = useApi('/api/guild');
  const status = useApi('/api/admin/status');
  const ready = g.data !== undefined;
  useEffect(() => {
    if (!ready || !SECTIONS.includes(query.section)) return;
    // Wait a frame so the member list below has a chance to render first.
    const t = setTimeout(() => document.getElementById(`guild-settings-${query.section}`)?.scrollIntoView({ block: 'start' }), 150);
    return () => clearTimeout(t);
  }, [ready, query.section]);
  const setGuild = (guild) => g.setData((d) => ({ ...d, guild: { ...(d?.guild || {}), ...guild } }));

  return html`<${Page} title="Guild settings" width="normal"
      lede="Choose how people join, manage roles, and connect the guild to Discord and Blizzard's game data.">
    <${Async} q=${g} loadingLabel="Loading guild settings…">
      ${(data) => html`<div class="stack stack--loose guild-settings">
        <div class="grid-2 guild-settings-pair">
          <${JoiningCard} guild=${data.guild} onGuild=${setGuild} />
          <${InviteCard} guild=${data.guild} memberCount=${data.memberCount} onGuild=${setGuild} />
        </div>
        <${MembersCard} />
        <div class="grid-2 guild-settings-pair">
          <${WebhookCard} guild=${data.guild} onGuild=${setGuild} />
          <${DiscordAppCard} />
        </div>
        <div class="grid-2 guild-settings-pair">
          <div class="stack stack--loose">
            <${TooltipsCard} guild=${data.guild} options=${data.options?.wowheadGames} onGuild=${setGuild} />
            <${CoachCard} guild=${data.guild} ai=${status.data?.ai} onGuild=${setGuild} />
          </div>
          <${RealmCard} guild=${data.guild} status=${status} onGuild=${setGuild} />
        </div>
      </div>`}
    <//>
  <//>`;
}

// ---------- joining the guild ----------

function JoiningCard({ guild, onGuild }) {
  const [autoJoin, setAutoJoin] = useState(guild.auto_join || 'roster');
  const [rank, setRank] = useState(rankToValue(guild.officer_rank_max));
  const save = useSaveSettings(onGuild);
  useEffect(() => {
    setAutoJoin(guild.auto_join || 'roster');
    setRank(rankToValue(guild.officer_rank_max));
  }, [guild.auto_join, guild.officer_rank_max]);

  const changes = joiningChanges(guild, autoJoin, rank);
  const changed = Object.keys(changes).length > 0;
  const submit = async (e) => {
    e?.preventDefault();
    if (changed) await save.run(changes);
  };

  return html`<${Card} id="guild-settings-joining" title="Joining the guild">
    <form class="stack" onSubmit=${submit}>
      <p class="mb-0">Everyone signs in to Guild Camp with Battle.net. Choose how they get into ${guild.name || 'the guild'}.</p>
      <fieldset class="guild-settings-choices">
        <legend class="sr">How people join</legend>
        ${AUTO_JOIN_OPTIONS.map((o) => html`<label key=${o.value} class=${`check guild-settings-choice${autoJoin === o.value ? ' is-on' : ''}`}>
          <input type="radio" name="guild-auto-join" value=${o.value} checked=${autoJoin === o.value} onChange=${() => setAutoJoin(o.value)} />
          <span class="check-text"><span>${o.label}</span><span class="field-hint">${o.hint}</span></span>
        </label>`)}
      </fieldset>
      <${Select} label="Officers from in-game ranks" options=${officerRankOptions(guild.officer_rank_max)} value=${rank} onValue=${setRank}
        hint="People with these ranks in game become officers here, and go back to member when they lose the rank. Roles you set by hand stay as they are." />
      <div class="form-actions">
        <${Button} type="submit" variant="primary" busy=${save.busy} disabled=${!changed}>Save<//>
      </div>
    </form>
  <//>`;
}

// ---------- invite link ----------

function InviteCard({ guild, memberCount, onGuild }) {
  const replace = async () => {
    const r = await api.post('/api/guild/invite/reset');
    onGuild({ invite_code: r.invite_code, inviteUrl: r.inviteUrl });
    toast(r.message || 'New invite link made. The old one no longer works.', 'ok');
  };
  return html`<${Card} id="guild-settings-invite" title="Invite link" sub=${memberCount ? `${memberCount} in the guild` : null}>
    <p>For anyone Guild Camp can't match by itself. They open the link, sign in with Battle.net, and they're in.</p>
    <div class="guild-settings-link">
      <input class="input guild-settings-link-text" readonly value=${guild.inviteUrl || ''} aria-label="Invite link"
        onFocus=${(e) => e.currentTarget.select()} />
      <${CopyButton} text=${guild.inviteUrl} label="Copy" done="Invite link copied." />
      <${ConfirmButton} icon="refresh" question="Make a new link? The current one stops working." yes="Replace" onConfirm=${replace}>Replace link<//>
    </div>
  <//>`;
}

// ---------- members ----------

function MembersCard() {
  const session = useSession();
  const q = useApi('/api/members');
  const meId = session.user?.id;
  const isOwner = session.isOwner;

  const act = async (m, verb) => {
    const r = await api.post(`/api/members/${m.id}/${verb}`);
    toast(r.message || 'Done.', 'ok');
    await q.reload();
  };

  const columns = useMemo(() => [
    {
      key: 'battletag', label: 'BattleTag', sortable: true, value: (m) => m.battletag.toLowerCase(),
      render: (m) => html`<span class="guild-settings-who">
        <strong>${m.battletag}</strong>${m.id === meId ? html` <span class="muted small">(you)</span>` : null}
      </span>`,
    },
    { key: 'role', label: 'Role', render: (m) => html`<${RolePill} role=${m.role} />` },
    {
      key: 'main', label: 'Main', sortable: true, value: (m) => m.main?.name || null,
      render: (m) => (m.main
        ? html`<span class="row nowrap"><${ClassName} name=${m.main.name} cls=${m.main.class} />${m.main.level ? html`<span class="muted small">${m.main.level}</span>` : null}</span>`
        : html`<span class="muted small">none yet</span>`),
    },
    {
      key: 'versions', label: 'Addon / app',
      render: (m) => html`<span class="guild-settings-versions">
        <span title="Addon">${m.addon_version || html`<span class="muted">—</span>`}</span>
        <span class="muted">/</span>
        <span title="App">${m.app_version || (m.companion_version ? html`<span class="muted" title="Old companion">companion ${m.companion_version}</span>` : html`<span class="muted">—</span>`)}</span>
      </span>`,
    },
    {
      key: 'last_sync_at', label: 'Last sync', sortable: true, value: (m) => (m.last_sync_at ? parseTime(m.last_sync_at)?.getTime() : null),
      render: (m) => html`<${TimeAgo} t=${m.last_sync_at} />`,
    },
    {
      key: 'actions', label: html`<span class="sr">Actions</span>`, align: 'right',
      render: (m) => html`<${MemberActions} m=${m} meId=${meId} isOwner=${isOwner} act=${act} />`,
    },
  ], [meId, isOwner]);

  return html`<${Card} id="guild-settings-members" title="Members" sub=${q.data ? plural(q.data.members.length, 'person', 'people') : null} flush
      footer="Officers can make members officers and remove members. Only the owner can demote or remove officers. Nobody can remove the owner.">
    <${Async} q=${q} loadingLabel="Loading members…">
      ${(data) => html`<${Table} columns=${columns} rows=${data.members} empty="Nobody has joined yet." />`}
    <//>
  <//>`;
}

// Buttons follow the server's role rules (routes/guild.js), so nobody sees a button that would be refused.
function MemberActions({ m, meId, isOwner, act }) {
  const [busy, setBusy] = useState(null);
  const run = async (verb) => {
    setBusy(verb);
    try { await act(m, verb); } catch (err) { toast(err?.message || 'That did not work.', 'alarm'); } finally { setBusy(null); }
  };
  if (m.role === 'owner') return html`<span class="muted small">Guild owner</span>`;
  const canRemove = m.id !== meId && (m.role === 'member' || isOwner);
  return html`<span class="actions-row guild-settings-actions">
    ${m.role === 'member' ? html`<${Button} size="sm" variant="ghost" busy=${busy === 'promote'} onClick=${() => run('promote')}>Make officer<//>` : null}
    ${m.role === 'officer' && isOwner ? html`<${Button} size="sm" variant="ghost" busy=${busy === 'demote'} onClick=${() => run('demote')}>Make member<//>` : null}
    ${canRemove ? html`<${ConfirmButton} size="sm" variant="ghost" question=${`Remove ${m.name || m.battletag}? Their devices are signed out.`}
        yes="Remove" onConfirm=${() => act(m, 'remove')}>Remove<//>` : null}
  </span>`;
}

// ---------- Discord ----------

function WebhookCard({ guild, onGuild }) {
  const [url, setUrl] = useState(guild.discord_webhook || '');
  const [error, setError] = useState(null);
  const save = useSaveSettings(onGuild);
  useEffect(() => { setUrl(guild.discord_webhook || ''); }, [guild.discord_webhook]);

  const submit = async (e) => {
    e?.preventDefault();
    const v = url.trim();
    if (v && !WEBHOOK_RE.test(v)) { setError("That isn't a Discord webhook URL."); return; }
    setError(null);
    await save.run({ discord_webhook: v });
  };
  const remove = async () => {
    setError(null);
    const saved = await save.run({ discord_webhook: '' });
    if (saved) setUrl('');
  };
  const changed = url.trim() !== (guild.discord_webhook || '');

  return html`<${Card} id="guild-settings-discord" title="Discord channel posts"
      actions=${guild.discord_webhook ? html`<${Pill} kind="ok" dot>Connected<//>` : html`<${Pill} kind="muted">Not set<//>`}>
    <form class="stack" onSubmit=${submit}>
      <p class="mb-0">Calls to arms, notices and crafting requests get posted to a Discord channel.
        Make a webhook in Discord (channel settings → Integrations → Webhooks) and paste its URL here.</p>
      <${Input} label="Webhook URL" type="url" value=${url} error=${error} placeholder="https://discord.com/api/webhooks/…"
        onValue=${(v) => { setUrl(v); if (error) setError(null); }} spellcheck=${false} autocomplete="off" />
      <div class="form-actions">
        <${Button} type="submit" variant="primary" busy=${save.busy} disabled=${!changed || !url.trim()}>Save webhook<//>
        ${guild.discord_webhook ? html`<${ConfirmButton} size="md" variant="ghost" question="Stop posting to Discord?" yes="Remove" onConfirm=${remove}>Remove<//>` : null}
      </div>
    </form>
  <//>`;
}

function DiscordAppCard() {
  const q = useApi('/api/discord');
  const register = useAction(() => api.post('/api/discord/register'));
  const runRegister = async () => {
    const r = await register.run();
    if (!r.ok) return;
    toast(r.value?.message || `${r.value?.registered ?? 'The'} commands registered.`, 'ok');
  };

  let body;
  if (q.loading && !q.data) body = html`<p class="muted mb-0">Checking Discord…</p>`;
  else if (q.error && !q.data) {
    body = html`<${Notice} kind=${q.error.status === 404 ? 'info' : 'warn'}>
      ${q.error.status === 404 ? "This server doesn't offer Discord commands yet." : q.error.message}
    <//>`;
  } else if (!q.data?.configured) {
    body = html`<${Notice} kind="info" title="Not set up yet.">
      Whoever runs the server needs to add the Discord app details (app ID, public key and bot token) to its settings.
    <//>`;
  } else {
    const d = q.data;
    body = html`<div class="stack">
      <p class="mb-0">Members can use <code>/online</code>, <code>/raids</code>, <code>/craft</code>, <code>/price</code>,
        <code>/cta</code> and <code>/signup</code> straight from Discord. Each member links their own Discord once in Settings.</p>
      <ol class="guild-settings-steps">
        <li>
          <span><strong>Invite the app</strong> to your Discord server. Inviting it as a bot also lets it put raids in Discord's Events list.</span>
          ${d.invite_url ? html`<${Button} size="sm" icon="external" href=${d.invite_url}>Invite the app<//>` : null}
        </li>
        <li>
          <span><strong>Register the commands</strong> so they show up when people type <code>/</code>.</span>
          <${Button} size="sm" icon="refresh" busy=${register.busy} onClick=${runRegister}>Register slash commands<//>
        </li>
      </ol>
      <p class="hint mb-0">${d.server_linked
        ? html`<${Pill} kind="ok" dot>Your Discord server is connected<//>`
        : html`The server connects by itself the first time someone runs <code>/link</code> in it.`}</p>
    </div>`;
  }
  return html`<${Card} title="Discord commands">${body}<//>`;
}

// ---------- item tooltips ----------

function TooltipsCard({ guild, options, onGuild }) {
  const games = options && options.length ? options : FALLBACK_GAMES;
  const [game, setGame] = useState(guild.wowhead_game || 'forever');
  const save = useSaveSettings(onGuild);
  useEffect(() => { setGame(guild.wowhead_game || 'forever'); }, [guild.wowhead_game]);
  return html`<${Card} id="guild-settings-tooltips" title="Item tooltips">
    <p>Hovering an item anywhere in Guild Camp shows its Wowhead tooltip. Pick the game your guild plays so the stats match.</p>
    <div class="form-row">
      <${Select} label="Wowhead database" options=${games} value=${game} onValue=${setGame} />
      <${Button} busy=${save.busy} disabled=${game === guild.wowhead_game} onClick=${() => save.run({ wowhead_game: game })}>Save<//>
    </div>
  <//>`;
}

// ---------- Coach AI ----------

function CoachCard({ guild, ai, onGuild }) {
  const [enabled, setEnabled] = useState(Boolean(guild.coach_enabled));
  const [budget, setBudget] = useState(String(guild.coach_budget_usd ?? 15));
  const [error, setError] = useState(null);
  const save = useSaveSettings(onGuild);
  useEffect(() => {
    setEnabled(Boolean(guild.coach_enabled));
    setBudget(String(guild.coach_budget_usd ?? 15));
  }, [guild.coach_enabled, guild.coach_budget_usd]);

  const submit = async (e) => {
    e?.preventDefault();
    const n = Number(budget);
    if (budget.trim() === '' || !Number.isFinite(n) || n < 0 || n > 500) { setError('Set a monthly Coach budget between $0 and $500.'); return; }
    setError(null);
    await save.run({ coach_enabled: enabled, coach_budget_usd: n });
  };
  const spent = Number(ai?.spentUsd) || 0;
  const cap = Number(guild.coach_budget_usd) || 0;

  return html`<${Card} id="guild-settings-coach" title="Coach AI">
    <form class="stack" onSubmit=${submit}>
      <p class="mb-0">The Coach writes build plans and answers questions with Claude. The budget caps what the guild spends each month.</p>
      ${ai && !ai.hasKey ? html`<${Notice} kind="warn">No Claude API key on the server yet, so plans and answers are off. Play-style tracking still works.<//>` : null}
      <${Checkbox} label="Coach AI on" checked=${enabled} onValue=${setEnabled} />
      <div class="form-row">
        <${Input} label="Monthly budget (USD)" type="number" min="0" max="500" step="1" value=${budget} error=${error}
          onValue=${(v) => { setBudget(v); if (error) setError(null); }} />
        <${Button} type="submit" busy=${save.busy}>Save<//>
      </div>
      ${ai ? html`<${Progress} value=${cap > 0 ? Math.min(spent, cap) : 0} max=${cap > 0 ? cap : 1} label="Spent this month"
          valueText=${`about ${usd(spent)} of ${usd(cap)}`} kind=${cap > 0 && spent >= cap ? 'alarm' : undefined} />
        <p class="hint mb-0">Each member can ask ${ai.limits?.questionsPerDay ?? 30} questions and make ${ai.limits?.plansPerDay ?? 5} plans a day.</p>` : null}
    </form>
  <//>`;
}

// ---------- realm and official Blizzard data ----------

function RealmCard({ guild, status, onGuild }) {
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

  return html`<${Card} id="guild-settings-realm" title="Realm and official Blizzard data"
      actions=${html`<${Button} size="sm" icon="sync" busy=${refresh.busy} onClick=${runRefresh}>Refresh now<//>`}>
    <form class="stack" onSubmit=${submit}>
      <p class="mb-0">Guild Camp reads Blizzard's free game data: item names and stats${live
        ? ', whether your realm is up (with a notification when it comes back), and the official guild list.'
        : ' now, and your realm status and the official guild list once Blizzard adds WoW: Forever to its API.'}</p>
      <div class="form-grid">
        <${Input} label="Realm" value=${realm} onValue=${setRealm} maxLength="60" placeholder="Filled in by the addon" />
        <${Input} label="Guild name in game" value=${gameGuild} onValue=${setGameGuild} maxLength="60" placeholder=${guild.name || 'wow'} />
      </div>
      <div class="form-actions">
        <${Button} type="submit" variant="primary" busy=${save.busy} disabled=${!changed}>Save<//>
        <span class="hint">Saving clears the old realm status. Use Refresh now to fetch it again.</span>
      </div>
    </form>
    <div class="guild-settings-status">
      ${status.error && !status.data ? html`<${Notice} kind="warn">${status.error.message}<//>` : null}
      ${gd ? html`<dl class="admin-facts">
        <div class="admin-fact"><dt>Using</dt><dd>${gd.namespaces?.label || 'nothing yet'}<span class="muted small"> · ${gd.itemsKnown || 0} items known</span></dd></div>
        <div class="admin-fact"><dt>Realm</dt><dd><${RealmLine} status=${gd.realm_status} realm=${gd.realm} /></dd></div>
        <div class="admin-fact"><dt>Official guild list</dt><dd>${gd.official_roster_note
          ? html`${gd.official_roster_note} <span class="muted small">· <${TimeAgo} t=${gd.official_roster_at} /></span>`
          : html`<span class="muted">${live ? 'Not fetched yet.' : 'Arrives once Blizzard adds WoW: Forever.'}</span>`}</dd></div>
      </dl>` : status.loading ? html`<p class="muted mb-0">Loading game data status…</p>` : null}
    </div>
  <//>`;
}
