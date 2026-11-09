// The one line every action that travels to guildmates through the addon carries, so people know when the guild
// sees it (docs/SHARING.md §2). Guild Camp keeps guild data on this PC; the addon trades it with guildmates in game.
//
//   html`<${ShareHint} />`                     "This goes to your guild the next time you log in or type /reload."
//   html`<${ShareHint} officer />`             + "Log in on an officer character to send this." (officer-only records)
//   html`<${ShareHint} gm />`                  + "Log in on your Guild Master character to send this." (guild settings)
//   html`<${ShareHint} discord />`             + "Your Discord channel gets a post once it goes out." when a webhook is set
//   html`<${ShareHint} discord="A cancellation also posts to your Discord channel once it goes out." />`
//   (Discord posts go out when the game confirms the change reached the guild, so custom lines never say "now".)
//
// "Waiting until you leave the dungeon." is added only when the game said so (an outbox entry waiting for the
// player to leave an instance, from GET /api/share/status): the app can't know it otherwise.
// While sync is off, it says the change stays on this PC until sync is back on. While the game needs a restart to load
// the news folder (sync status restartNeeded), it says to restart World of Warcraft instead of /reload.
import { html, cx } from '../lib/html.js';
import { useSyncStatus, useSettings, useShareStatus, waitingForDungeon, needsGameRestart, SHARE_LINES, RESTART_SHARE_LINES } from '../lib/status.js';
import { Icon } from './Icon.js';

export const SHARE_HINT = 'This goes to your guild the next time you log in or type /reload.';
export const SHARE_HINT_RESTART = RESTART_SHARE_LINES.hint;
export const SAVED_LINE = SHARE_LINES.saved;
export const NEW_DATA_LINE = SHARE_LINES.newData;
export const INSTANCE_LINE = SHARE_LINES.instance;
export const OFFICER_HINT = SHARE_LINES.officer;
export const STALE_LINE = SHARE_LINES.stale;
export const GM_HINT = 'Log in on your Guild Master character to send this.';
export const SHARE_HINT_OFF = 'Sync is off, so this stays on this PC. Turn sync on under Addon & sync to send it to your guild.';
export const DISCORD_HINT = 'Your Discord channel gets a post once it goes out.';

/** The sentence(s) the hint shows (exported for tests). */
export function shareHintText({ syncOff = false, webhook = false, discord = false, officer = false, gm = false, dungeon = false, restart = false } = {}) {
  if (syncOff) return SHARE_HINT_OFF;
  const parts = [restart ? SHARE_HINT_RESTART : SHARE_HINT];
  if (dungeon) parts.push(INSTANCE_LINE);
  if (gm) parts.push(GM_HINT);
  else if (officer) parts.push(OFFICER_HINT);
  if (discord && webhook) parts.push(typeof discord === 'string' ? discord : DISCORD_HINT);
  return parts.join(' ');
}

export function ShareHint({ discord = false, officer = false, gm = false, class: cls }) {
  const sync = useSyncStatus();
  const settings = useSettings();
  const share = useShareStatus();
  const syncOff = Boolean(sync && sync.state === 'off');
  const webhook = Boolean(settings && settings.discordWebhook);
  const dungeon = Boolean(share && share.data && waitingForDungeon(share.data));
  const restart = needsGameRestart(sync);
  return html`<p class=${cx('share-hint', syncOff && 'share-hint--off', cls)}>
    <${Icon} name=${syncOff ? 'off' : 'sync'} size=${14} class="share-hint-icon" />
    <span>${shareHintText({ syncOff, webhook, discord, officer, gm, dungeon, restart })}</span>
  </p>`;
}

export default ShareHint;
