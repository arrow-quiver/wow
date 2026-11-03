// Wowhead links with hover tooltips (wow.zamimg.com/js/tooltips.js, loaded in the layout).
// The guild picks which Wowhead section matches its game: Forever, Retail or Classic.
const { esc } = require('./layout');

const PATHS = { forever: 'forever', retail: '', classic: 'classic' };
let current = 'forever';

function setGame(game) { if (game in PATHS) current = game; }
function game() { return current; }
const base = () => `https://www.wowhead.com/${PATHS[current] ? `${PATHS[current]}/` : ''}`;
const itemUrl = (id) => `${base()}item=${encodeURIComponent(id)}`;
const spellUrl = (id) => `${base()}spell=${encodeURIComponent(id)}`;

// An item name that shows the Wowhead tooltip on hover (when the item id is known).
function itemLink(id, name) {
  const label = name || (id ? `Item ${id}` : '');
  if (!id) return esc(label);
  return `<a class="wh" href="${itemUrl(id)}" target="_blank" rel="noopener"${name ? ' data-wh-rename-link="false"' : ''}>${esc(label)}</a>`;
}
function spellLink(id, name) {
  if (!id) return esc(name || '');
  return `<a class="wh" href="${spellUrl(id)}" target="_blank" rel="noopener" data-wh-rename-link="false">${esc(name)}</a>`;
}

// Tooltip on a non-link element (e.g. a checkbox label), so clicking still ticks the box.
function itemHover(id, name) {
  if (!id) return esc(name || '');
  const domain = PATHS[current] ? `&domain=${PATHS[current]}` : '';
  return `<span class="wh-hover" data-wowhead="item=${encodeURIComponent(id)}${domain}">${esc(name)}</span>`;
}

module.exports = { itemHover, setGame, game, itemUrl, spellUrl, itemLink, spellLink, GAMES: Object.keys(PATHS) };
