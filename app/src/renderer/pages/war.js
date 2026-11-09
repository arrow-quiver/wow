// War: where the guild fights in the open world. The guild's deaths and kills from everyone's addon (the "wm"
// records, with map positions), the hotspots, and my own deaths from the live link (who killed me, and whether the
// guild's Discord was told). API: docs/api/war.md (GET /api/war).
import { html, useState } from '../lib/html.js';
import { useApi, qs, api, useAction } from '../lib/api.js';
import { setQuery, Link } from '../lib/router.js';
import { number, plural } from '../lib/format.js';
import { Page, Card, Stat, Table, Button, Select, Empty, Async, Notice, Pill, TimeAgo } from '../components/index.js';

const DAYS = [{ value: '1', label: 'Today' }, { value: '7', label: 'Last 7 days' }, { value: '30', label: 'Last 30 days' }];
const coord = (v) => Math.round(v / 10);

export default function WarPage({ query = {} }) {
  const days = DAYS.some((d) => d.value === query.days) ? query.days : '7';
  const q = useApi(`/api/war${qs({ days })}`, { interval: 30000 });
  return html`<${Page} title="War"
      lede="Where the guild fights in the open world: every death and kill with the Guild Camp addon, and who keeps killing you."
      actions=${html`<${Select} aria-label="Period" value=${days} options=${DAYS} onValue=${(v) => setQuery({ days: v === '7' ? undefined : v })} />`}>
    <${Async} q=${q} loadingLabel="Reading the war map…">${(data) => html`<${War} data=${data} zoneQuery=${query.zone} />`}<//>
  <//>`;
}

function War({ data, zoneQuery }) {
  const zones = data.zones;
  const zone = zones.find((z) => String(z.mapId) === String(zoneQuery)) || zones[0] || null;
  return html`
    ${data.alerts ? null : html`<${Notice} kind="info" title="Discord alerts are off.">
      Add your guild's Discord webhook in <${Link} href="/settings?section=discord">Settings → Discord<//>, and your deaths to players
      are posted there as they happen, so guildmates nearby can come and help.<//>`}
    <div class="war-stats">
      <${Card}><${Stat} label="Guild deaths" value=${number(data.guild.deaths)} hint=${`in the open world, ${periodText(data.days)}`} /><//>
      <${Card}><${Stat} label="Guild kills" value=${number(data.guild.kills)} hint="honorable kills" /><//>
      <${Card}><${Stat} label="Guildies fighting" value=${number(data.guild.players)} hint="with the addon's war map" /><//>
      <${Card}><${Stat} label="Your deaths to players" value=${number(data.mine.pvpDeaths)} hint=${`of ${plural(data.mine.deaths, 'death')} the live link saw`} /><//>
    </div>
    <div class="cols war-cols">
      <div class="stack stack--loose">
        ${zone ? html`<${MapCard} zones=${zones} zone=${zone} hotspots=${data.hotspots} />`
          : html`<${Card}><${Empty} icon="war" title="No fights on the map yet.">
              Deaths and kills show up here once guildies with the addon fight in the open world. Each one's addon shares them
              (at most every 5 minutes), and they also show as pins on the in-game world map.<//><//>`}
        <${Recent} rows=${data.mine.recent} />
      </div>
      <div class="stack stack--loose">
        <${Hotspots} rows=${data.hotspots} />
        <${Nemeses} rows=${data.mine.nemeses} />
        <${HowItWorks} />
      </div>
    </div>`;
}

const periodText = (d) => (d === 1 ? 'today' : `last ${d} days`);

function MapCard({ zones, zone, hotspots }) {
  const [hover, setHover] = useState(null);
  const hot = hotspots.filter((h) => h.mapId === zone.mapId);
  return html`<${Card} title=${zone.zone} sub=${`${plural(zone.deaths, 'death')}, ${plural(zone.kills, 'kill')}`}
      actions=${zones.length > 1 ? html`<${Select} aria-label="Zone" value=${String(zone.mapId)}
        options=${zones.map((z) => ({ value: String(z.mapId), label: `${z.zone} (${z.deaths + z.kills})` }))}
        onValue=${(v) => setQuery({ zone: v })} />` : null}>
    <div class="war-map" role="img" aria-label=${`Map of ${zone.zone} with ${zone.deaths} deaths and ${zone.kills} kills`}>
      <svg viewBox="0 0 1000 667" preserveAspectRatio="none" aria-hidden="true">
        ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => html`<line key=${`v${i}`} class="war-grid" x1=${i * 100} y1="0" x2=${i * 100} y2="667" />`)}
        ${[1, 2, 3, 4, 5].map((i) => html`<line key=${`h${i}`} class="war-grid" x1="0" y1=${i * 111} x2="1000" y2=${i * 111} />`)}
        ${hot.map((h) => html`<circle key=${`hs${h.x}-${h.y}`} class="war-hot" cx=${h.x} cy=${h.y * 0.667} r="46" />`)}
        ${zone.marks.map((m, i) => html`<circle key=${i} class=${m.kind === 'k' ? 'war-dot war-dot--kill' : 'war-dot war-dot--death'}
          cx=${m.x} cy=${m.y * 0.667} r=${hover === i ? 13 : 9} onMouseEnter=${() => setHover(i)} onMouseLeave=${() => setHover(null)} />`)}
      </svg>
      ${hover != null && zone.marks[hover] ? html`<div class="war-tip">
        <b>${zone.marks[hover].who || 'A guildmate'}</b> ${zone.marks[hover].kind === 'k' ? 'got a kill' : 'died'} at
        ${coord(zone.marks[hover].x)}, ${coord(zone.marks[hover].y)} · <${TimeAgo} t=${zone.marks[hover].at} /></div>` : null}
    </div>
    <p class="hint war-legend"><span class="war-key war-key--death"></span> death <span class="war-key war-key--kill"></span> kill
      <span class="war-key war-key--hot"></span> hotspot · positions are map coordinates, as in game (0–100)</p>
  <//>`;
}

function Hotspots({ rows }) {
  return html`<${Card} title="Hotspots" sub="where it keeps kicking off">
    ${rows.length ? html`<ol class="list-lines">${rows.map((h) => html`<li key=${`${h.mapId}-${h.x}-${h.y}`} class="row row--between nowrap">
      <span class="ellipsis"><${Link} href=${`/war?zone=${h.mapId}`}>${h.zone}<//> <span class="hint">${coord(h.x)}, ${coord(h.y)}</span></span>
      <span class="row nowrap">${h.deaths ? html`<${Pill} kind="alarm">${plural(h.deaths, 'death')}<//>` : null}
        ${h.kills ? html`<${Pill} kind="ok">${plural(h.kills, 'kill')}<//>` : null}<span class="hint"><${TimeAgo} t=${h.last} /></span></span>
    </li>`)}</ol>` : html`<p class="hint mb-0">Two or more fights in the same spot make a hotspot.</p>`}
  <//>`;
}

function Nemeses({ rows }) {
  return html`<${Card} title="Your nemeses" sub="players who killed you most">
    ${rows.length ? html`<ol class="list-lines">${rows.map((n) => html`<li key=${n.name} class="row row--between nowrap">
      <b class="ellipsis">${n.name}</b><span class="hint">${plural(n.kills, 'kill')}</span></li>`)}</ol>`
      : html`<p class="hint mb-0">Nobody yet. The live link names who killed you (Settings → Overlay & live).</p>`}
  <//>`;
}

function Recent({ rows }) {
  const help = useAction(() => api.post('/api/war/help', {}), { success: 'Posted to the guild\'s Discord.' });
  const cols = [
    { key: 'at', label: 'When', render: (r) => html`<${TimeAgo} t=${r.at} />` },
    { key: 'character', label: 'Character' },
    { key: 'killer', label: 'Killed by', render: (r) => (r.killer ? html`<b>${r.killer}</b>${r.enemies.length > 1 ? html` <span class="hint">+${r.enemies.length - 1}</span>` : null}${r.pvp ? html` <${Pill} kind="warn">PvP<//>` : null}` : html`<span class="hint">unknown</span>`) },
    { key: 'spell', label: 'Killing blow', render: (r) => (r.spell ? html`${r.spell}${r.amount ? html` <span class="hint">${number(r.amount)}</span>` : null}` : '–') },
    { key: 'zone', label: 'Where', render: (r) => r.zone || html`<span class="hint">–</span>` },
    { key: 'posted', label: 'Discord', render: (r) => (r.posted ? html`<${Pill} kind="ok">Posted<//>` : html`<span class="hint">–</span>`) },
  ];
  return html`<${Card} flush title="Your recent deaths" sub="from the live link"
      actions=${rows.some((r) => r.pvp) ? html`<${Button} size="sm" icon="bell" busy=${help.busy} onClick=${() => help.run()}>Call for help<//>` : null}>
    <${Table} dense columns=${cols} rows=${rows} rowKey=${(r) => `${r.character}${r.at}`}
      empty=${html`<${Empty} compact icon="war" title="No deaths seen.">Turn on the live link in Settings → Overlay & live, and type /wow live on in game.<//>`} />
  <//>`;
}

function HowItWorks() {
  return html`<${Card} title="How it works">
    <ul class="list-tight hint">
      <li><b>War map:</b> when players kill you or you get an honorable kill in the open world, your addon marks the spot and shares it with the
        guild. Guildies see the marks here and as pins on the in-game world map (<code>/wow war off</code> hides them).</li>
      <li><b>Discord alerts:</b> when the live link sees you die to players, the app posts who and where to the guild's Discord
        (at most every 2 minutes). Turn it off in Settings → Overlay & live.</li>
      <li><b>Call for help:</b> in game, a popup after a death to players sends a call to arms; here and on the overlay, the
        button posts to Discord.</li>
    </ul>
  <//>`;
}
