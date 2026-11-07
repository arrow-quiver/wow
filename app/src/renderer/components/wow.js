// WoW-flavoured bits: ClassName, Money, ItemLink, SpellLink, TimeAgo, LocalTime.
import { html, cx, useEffect, useReducer } from '../lib/html.js';
import { Link } from '../lib/router.js';
import { useSession } from '../lib/session.js';
import { classInfo, moneyParts, money, qualityClass, timeAgo, localTime, localDateTime, parseTime } from '../lib/format.js';
import { guildGame, itemUrl, spellUrl, wowheadData } from '../lib/wowhead.js';

/**
 * A character name in its class colour, linking to the character page.
 *   <ClassName name="Grimtusk" cls="WARRIOR" />    (cls also accepts "Warrior"; `link={false}` for plain text)
 */
export function ClassName({ name, cls, link = true, title, children, class: extra }) {
  const [label, color] = classInfo(cls);
  const text = children ?? name;
  const style = `--cc:${color}`;
  if (!link || !name) return html`<span class=${cx('cname', extra)} style=${style} title=${title || label}>${text}</span>`;
  return html`<${Link} href=${`/characters/${encodeURIComponent(name)}`} class=${cx('cname', extra)} style=${style} title=${title || label}>${text}<//>`;
}

/**
 * Copper as coloured coins: <Money copper=${1234567} /> → 123● 45● 67●
 * `empty` is shown when copper is null (default "no price"). `compact` hides zero silver/copper after gold.
 */
export function Money({ copper, empty = 'no price', compact = false, class: cls }) {
  const p = moneyParts(copper);
  if (!p) return empty ? html`<span class="muted">${empty}</span>` : null;
  const coins = [];
  // Same rules as money(): silver once there is gold, copper unless it is a trailing zero.
  if (p.g) coins.push(['g', p.g.toLocaleString('en'), 'gold']);
  if ((p.g || p.s) && !(compact && p.s === 0)) coins.push(['s', p.s, 'silver']);
  if (!(p.g || p.s) || p.c) coins.push(['c', p.c, 'copper']);
  const spoken = `${p.neg ? 'minus ' : ''}${coins.map(([, n, w]) => `${n} ${w}`).join(' ')}`;
  return html`<span class=${cx('coins', p.neg && 'coins--neg', cls)} title=${money(copper)} aria-label=${spoken}>
    ${p.neg ? html`<span aria-hidden="true">−</span>` : null}
    ${coins.map(([k, n]) => html`<span class=${`coin coin--${k}`} aria-hidden="true">${n}</span>`)}
  </span>`;
}

function useGame(game) {
  const { guild } = useSession();
  return game || guildGame(guild);
}

/**
 * An item with a Wowhead tooltip on hover and keyboard focus (drawn by lib/tooltip.js).
 *   <ItemLink id=${19019} name="Thunderfury" quality=${5} count=${2} />
 * - Renders <a href="https://www.wowhead.com/<game>/item=<id>" data-wowhead="item=<id>&domain=<game>"> in the
 *   item's quality colour; clicking opens Wowhead in the browser.
 * - The game comes from the guild (guild.wowhead_game; default Classic) unless `game` is given.
 * - `hover` renders a non-link span (e.g. inside a checkbox label, so clicking still ticks the box).
 * - Without an id it renders the plain name.
 */
export function ItemLink({ id, name, quality, count, game, hover = false, class: cls }) {
  const g = useGame(game);
  const label = name || (id ? `Item ${id}` : '');
  const q = qualityClass(quality);
  const prefix = count && Number(count) > 1 ? html`<span class="muted">${count} × </span>` : null;
  if (!id) return html`<span class=${cx(q, cls)}>${prefix}${label}</span>`;
  if (hover) {
    return html`<span>${prefix}<span class=${cx('wh-hover', q, cls)} data-wowhead=${wowheadData('item', id, g)}>${label}</span></span>`;
  }
  return html`<span>${prefix}<a class=${cx('wh', q, cls)} href=${itemUrl(id, g)} target="_blank" rel="noopener noreferrer"
    data-wowhead=${wowheadData('item', id, g)}>${label}</a></span>`;
}

// A spell or recipe with a Wowhead tooltip (lib/tooltip.js): <SpellLink id=${17187} name="Transmute: Arcanite" />
export function SpellLink({ id, name, game, class: cls }) {
  const g = useGame(game);
  if (!id) return html`<span class=${cls}>${name || ''}</span>`;
  return html`<a class=${cx('wh', cls)} href=${spellUrl(id, g)} target="_blank" rel="noopener noreferrer"
    data-wowhead=${wowheadData('spell', id, g)}>${name || `Spell ${id}`}</a>`;
}

// ---------- times ----------

// One shared ticker so every relative time on screen updates together (every 30 s).
const tickers = new Set();
let tickTimer = 0;
function subscribeTick(fn) {
  tickers.add(fn);
  if (!tickTimer) tickTimer = setInterval(() => { for (const f of tickers) f(); }, 30000);
  return () => {
    tickers.delete(fn);
    if (!tickers.size) { clearInterval(tickTimer); tickTimer = 0; }
  };
}
export function useNow() {
  const [, force] = useReducer((n) => n + 1, 0);
  useEffect(() => subscribeTick(force), []);
  return Date.now();
}

// "5 min ago", with the full local date and time on hover. `never` is shown for empty values.
export function TimeAgo({ t, never = 'never', class: cls }) {
  const now = useNow();
  const d = parseTime(t);
  if (!d) return html`<span class=${cx('muted', cls)}>${never}</span>`;
  return html`<time class=${cls} datetime=${d.toISOString()} title=${localDateTime(d)}>${timeAgo(d, now)}</time>`;
}

// A date/time in the viewer's time zone. style: 'full' (Fri 14 Nov, 20:00) | 'time' | 'date' | 'short' | 'day' | 'long'.
export function LocalTime({ t, style = 'full', empty = '', class: cls }) {
  const d = parseTime(t);
  if (!d) return empty ? html`<span class="muted">${empty}</span>` : null;
  return html`<time class=${cls} datetime=${d.toISOString()} title=${style === 'long' ? undefined : localDateTime(d)}>${localTime(d, style)}</time>`;
}
