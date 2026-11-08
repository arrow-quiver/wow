// What a page shows while the game hasn't shown Guild Camp a guild yet: the core's own sentence (403 NO_GUILD)
// and a way to Addon & sync, where the addon and the first sync are set up. Never an error box.
//
//   html`<${NoGuild} />`                       the whole-page version (main.js uses it for every guild page)
//   html`<${NoGuild} error=${err} compact />`  inside a card, with the core's words when it sent them
//   html`<${NoGuild} here />`                  on Addon & sync itself (no link to the page you are on)
import { html, cx } from '../lib/html.js';
import { NO_GUILD_TEXT, isNoGuild } from '../lib/status.js';
import { Link } from '../lib/router.js';
import { Icon } from './Icon.js';
import { Button } from './Button.js';

export { NO_GUILD_TEXT, isNoGuild };

/** The sentence to show: the core's own words when the error carries them, else the standard one. */
export function noGuildText(error) {
  const message = error && typeof error === 'object' && isNoGuild(error) ? String(error.message || '').trim() : '';
  return message || NO_GUILD_TEXT;
}

export function NoGuild({ error, compact = false, here = false, class: cls }) {
  const text = noGuildText(error);
  if (compact) {
    return html`<div class=${cx('no-guild no-guild--compact', cls)}>
      <${Icon} name="camp" class="no-guild-icon" />
      <p class="mb-0">${text}${here ? null : html` <${Link} href="/addon" class="no-guild-link">Open Addon & sync<//>`}</p>
    </div>`;
  }
  return html`<div class=${cx('empty no-guild', cls)}>
    <${Icon} name="camp" class="empty-icon" />
    <p class="empty-title">Waiting for your guild</p>
    <p class="empty-body">${text}</p>
    ${here ? null : html`<${Button} variant="primary" icon="addon" href="/addon">Open Addon & sync<//>`}
  </div>`;
}

export default NoGuild;
