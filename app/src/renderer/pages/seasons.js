// Seasons: this month's guild leaderboard from what guildies actually did (donations at that day's auction price,
// kills in the open world, crafting requests filled, raids), with titles, streaks, badges and the hall of fame.
// Every app works it out the same way from the guild's shared data. API: docs/api/seasons.md.
import { html } from '../lib/html.js';
import { useApi, qs, api, useAction } from '../lib/api.js';
import { setQuery } from '../lib/router.js';
import { number, plural } from '../lib/format.js';
import { Page, Card, Stat, Table, Button, Select, Empty, Async, Pill, Notice } from '../components/index.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthName = (m) => { const [y, mo] = String(m).split('-').map(Number); return `${MONTHS[mo - 1] || ''} ${y || ''}`.trim(); };
const ICON = { donor: '💰', pvp: '⚔️', crafter: '🔨', raider: '🛡️' };
const BADGE_ICON = { gold: '💰', kills: '⚔️', crafts: '🔨', raids: '🛡️', streak: '🔥' };
const WHAT = { gold: 'gold given', kills: 'kills', crafts: 'crafts', raids: 'raids', streak: 'weeks in a row' };
const fmt = (what, v) => (what === 'gold' ? `${number(Math.round(v))}g` : number(v));

export default function SeasonsPage({ query = {} }) {
  const q = useApi(`/api/seasons${qs({ month: query.month })}`, { interval: 60000 });
  return html`<${Page} title="Seasons"
      lede="Every month the guild starts fresh. Give to the bank, fight in the open world, craft for guildies and raid: it all counts."
      actions=${q.data ? html`<${MonthPicker} data=${q.data} />` : null}>
    <${Async} q=${q} loadingLabel="Adding up the season…">${(d) => html`<${Season} d=${d} reload=${q.reload} />`}<//>
  <//>`;
}

function MonthPicker({ data }) {
  const options = [{ value: '', label: 'This season' }, ...data.hall.map((h) => ({ value: h.month, label: monthName(h.month) }))];
  if (!data.current && !options.some((o) => o.value === data.month)) options.push({ value: data.month, label: monthName(data.month) });
  return html`<${Select} aria-label="Season" value=${data.current ? '' : data.month} options=${options} onValue=${(v) => setQuery({ month: v || undefined })} />`;
}

function Season({ d, reload }) {
  const announce = useAction(() => api.post('/api/seasons/announce', { month: d.month }), { success: 'Posted the winners to Discord.' });
  return html`
    <div class="season-hero">
      <div>
        <p class="season-kicker">${d.current ? 'Season in progress' : 'Final standings'}</p>
        <h2 class="season-title">${monthName(d.month)}</h2>
        <p class="hint mb-0">${d.current ? `${plural(d.daysLeft, 'day')} left · ${plural(d.players.length, 'guildie')} on the board` : `${plural(d.players.length, 'guildie')} took part`}</p>
      </div>
      ${d.mvp ? html`<div class="season-mvp"><span class="season-crown" aria-hidden="true">👑</span><div><span class="hint">${d.current ? 'Leading' : 'MVP'}</span><br /><b>${d.mvp.name}</b> <span class="hint">${number(d.mvp.score)} points</span></div></div>` : null}
      ${d.canAnnounce ? html`<${Button} variant="primary" icon="bell" busy=${announce.busy} onClick=${async () => { const r = await announce.run(); if (r.ok) reload(); }}>
        ${d.announced ? 'Announce again' : 'Announce the winners'}<//>` : null}
    </div>
    ${!d.discord && d.canAnnounce ? html`<${Notice} kind="info">Add the guild's Discord webhook in Settings → Discord to announce winners and post shout-outs.<//>` : null}
    <div class="war-stats">
      ${d.categories.map((c) => { const l = d.leaders[c.id]; return html`<${Card} key=${c.id}><${Stat}
        label=${html`<span aria-hidden="true">${ICON[c.id]}</span> ${c.title}`}
        value=${l ? l.name : '—'} hint=${l ? `${fmt(c.unit === 'gold' ? 'gold' : c.unit, l.value)} ${c.unit === 'gold' ? 'given' : c.unit}` : c.label} /><//>`; })}
    </div>
    <div class="cols war-cols">
      <div class="stack stack--loose">
        <${Board} d=${d} />
        <${Hall} rows=${d.hall} />
      </div>
      <div class="stack stack--loose">
        <${Me} d=${d} />
        <${Badges} d=${d} />
        <${HowItCounts} d=${d} />
      </div>
    </div>`;
}

function Board({ d }) {
  const cols = [
    { key: 'rank', label: '#', num: true, render: (p) => (p.rank <= 3 ? ['🥇', '🥈', '🥉'][p.rank - 1] : p.rank) },
    { key: 'name', label: 'Guildie', render: (p) => html`<b class=${p.class ? `cc-${String(p.class).toLowerCase()}` : ''}>${p.name}</b>${p.userId === d.me ? html` <${Pill} kind="accent">you<//>` : null}
      ${p.titles.length ? html`<br />${p.titles.map((t) => html`<${Pill} key=${t} kind=${t === 'MVP' ? 'warn' : 'muted'}>${t}<//> `)}` : null}` },
    { key: 'gold', label: 'Given', num: true, render: (p) => (p.gold ? `${number(Math.round(p.gold))}g` : '–') },
    { key: 'kills', label: 'Kills', num: true, render: (p) => p.kills || '–' },
    { key: 'crafts', label: 'Crafts', num: true, render: (p) => p.crafts || '–' },
    { key: 'raids', label: 'Raids', num: true, render: (p) => p.raids || '–' },
    { key: 'streak', label: 'Streak', num: true, render: (p) => (p.streak >= 2 ? html`🔥 ${p.streak}${p.bonus ? html` <span class="hint">+${Math.round(p.bonus * 100)}%</span>` : null}` : p.streak || '–') },
    { key: 'score', label: 'Points', num: true, render: (p) => html`<strong>${number(p.score)}</strong>` },
  ];
  return html`<${Card} flush title="The board" sub=${d.current ? 'this month so far' : monthName(d.month)}>
    <${Table} dense columns=${cols} rows=${d.players} rowKey=${(p) => p.userId}
      empty=${html`<${Empty} compact icon="trophy" title="Nobody on the board yet.">The first gift, kill, craft or raid of the month puts you on top.<//>`} />
  <//>`;
}

function Me({ d }) {
  const m = d.mine;
  const have = new Set(d.myBadges.map((b) => b.id));
  const next = d.allBadges.filter((b) => !have.has(b.id))[0];
  return html`<${Card} title="You">
    ${m ? html`<div class="row row--between"><${Stat} label="Place" value=${`#${m.rank}`} hint=${`of ${d.players.length}`} />
      <${Stat} label="Points" value=${number(m.score)} hint=${m.bonus ? `incl. +${Math.round(m.bonus * 100)}% streak` : 'this season'} />
      <${Stat} label="Streak" value=${m.streak >= 2 ? `🔥 ${m.streak}` : String(m.streak)} hint="weeks in a row" /></div>
      ${m.titles.length ? html`<p class="mb-0">${m.titles.map((t) => html`<${Pill} key=${t} kind="warn">${t}<//> `)}</p>` : null}`
      : html`<p class="hint">Not on the board yet this season. Anything you give, craft, raid or kill counts.</p>`}
    ${next ? html`<p class="hint mb-0">Next badge: <b>${BADGE_ICON[next.what]} ${next.name}</b> at ${fmt(next.what, next.n)} ${WHAT[next.what]}.</p>` : null}
  <//>`;
}

function Badges({ d }) {
  const have = new Set(d.myBadges.map((b) => b.id));
  return html`<${Card} title="Badges" sub=${`${d.myBadges.length} of ${d.allBadges.length} earned`}>
    <ul class="season-badges">${d.allBadges.map((b) => html`<li key=${b.id} class=${have.has(b.id) ? 'is-earned' : ''} title=${`${fmt(b.what, b.n)} ${WHAT[b.what]}`}>
      <span class="season-badge-icon" aria-hidden="true">${BADGE_ICON[b.what]}</span><span>${b.name}<br /><span class="hint">${fmt(b.what, b.n)} ${WHAT[b.what]}</span></span>
    </li>`)}</ul>
  <//>`;
}

function Hall({ rows }) {
  return html`<${Card} title="Hall of fame" sub="past seasons' winners">
    ${rows.length ? html`<ol class="list-lines">${rows.map((h) => html`<li key=${h.month}>
      <div class="row row--between nowrap"><b>${monthName(h.month)}</b><span>👑 <b>${h.mvp.name}</b> <span class="hint">${number(h.mvp.score)} points</span></span></div>
      <p class="hint mb-0">${['donor', 'pvp', 'crafter', 'raider'].filter((k) => h.leaders[k]).map((k) => `${ICON[k]} ${h.leaders[k].name}`).join('  ·  ')}</p>
    </li>`)}</ol>` : html`<p class="hint mb-0">The first season's winners land here when the month ends.</p>`}
  <//>`;
}

function HowItCounts({ d }) {
  const p = d.points;
  return html`<${Card} title="How it counts">
    <ul class="list-tight hint">
      <li>💰 ${p.gold} point per gold you give to the guild bank (items at that day's Auctionator price).</li>
      <li>⚔️ ${p.kill} points per kill in the open world (from the war map).</li>
      <li>🔨 ${p.craft} points per crafting request you fill.</li>
      <li>🛡️ ${p.raid} points per raid you attend.</li>
      <li>🔥 Points in weeks in a row: +${Math.round(d.streak.step * 100)}% per extra week, up to +${Math.round(d.streak.max * 100)}%.</li>
      <li>Titles go to the leader of each category, MVP to the top score. Badges are for life, and show on your in-game tooltip.</li>
    </ul>
  <//>`;
}
