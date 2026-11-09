// Wowhead links with hover tooltips. The tooltips are drawn by lib/tooltip.js (no Wowhead script runs in the app).
// The guild picks which Wowhead section matches its game (guild.wowhead_game): Forever, Retail or Classic.
// Port of the old views/wowhead.js. Until Forever has its own Wowhead domain the default is Classic.
import { initTooltips } from './tooltip.js';

export const PATHS = { forever: 'forever', retail: '', classic: 'classic' };
export const GAMES = Object.keys(PATHS);
export const GAME_LABELS = { forever: 'WoW: Forever', retail: 'Retail', classic: 'Classic' };
export const DEFAULT_GAME = 'classic';

export function normalizeGame(game) { return Object.prototype.hasOwnProperty.call(PATHS, game) ? game : DEFAULT_GAME; }

// The game for a guild row/object from the session.
export function guildGame(guild) {
  return normalizeGame(guild && (guild.wowhead_game ?? guild.wowheadGame));
}

export function wowheadBase(game) {
  const p = PATHS[normalizeGame(game)];
  return `https://www.wowhead.com/${p ? `${p}/` : ''}`;
}
export const itemUrl = (id, game) => `${wowheadBase(game)}item=${encodeURIComponent(id)}`;
export const spellUrl = (id, game) => `${wowheadBase(game)}spell=${encodeURIComponent(id)}`;

// The data-wowhead attribute: "item=19019&domain=classic" (no domain for Retail).
export function wowheadData(kind, id, game) {
  const p = PATHS[normalizeGame(game)];
  return `${kind}=${encodeURIComponent(id)}${p ? `&domain=${p}` : ''}`;
}

// Turns on the hover tooltips for every element with data-wowhead (ItemLink, SpellLink). The listeners sit on the
// document once (event delegation), so links that pages add later need nothing extra; `root` is not needed any more
// and is accepted for older callers. Returns a stop function (a no-op: the listeners stay for the app's lifetime).
export function watchTooltips(_root) {
  initTooltips();
  return () => {};
}
export { initTooltips };
