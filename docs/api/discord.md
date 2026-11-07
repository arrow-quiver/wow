# Discord API

Slash commands in the guild's Discord server, account link codes, and command registration.
Implemented in `server/src/routes/discord.js` (HTTP) and `server/src/services/discord.js` (command behaviour,
link codes, Discord scheduled events). Ported from the old `web/src/routes/phase3.js` and `web/src/discord.js`.

There is no bot process and no gateway connection: Discord calls `POST /discord/interactions` for every slash
command and the server answers straight away.

## Server setup

| Env | What it does |
|---|---|
| `DISCORD_APP_ID` | The application id (discord.com/developers/applications). |
| `DISCORD_PUBLIC_KEY` | The application's public key. Checks the signature on every interaction. Without it `/discord/interactions` answers `404`. |
| `DISCORD_BOT_TOKEN` | Only needed to register the slash commands and to create Discord scheduled events for raids. |

In the Discord developer portal set **Interactions Endpoint URL** to `<BASE_URL>/discord/interactions`.
Slash commands count as "configured" once `DISCORD_APP_ID` and `DISCORD_PUBLIC_KEY` are both set.

Channel posts (calls to arms, notices, requests, raid reminders) use the guild's **webhook**, set under
Guild settings (`PUT /api/guild/settings { discord_webhook }`, see `core.md`). That is separate from the app above.

---

## `POST /discord/interactions` (Discord only)

Raw body (app.js keeps `/discord/*` bodies as a Buffer), signed by Discord with Ed25519 over
`X-Signature-Timestamp + body`. Rate limit: 120 per minute.

| Situation | Answer |
|---|---|
| `DISCORD_PUBLIC_KEY` not set | `404 { "error": "Not found." }` |
| Missing or wrong signature | `401 { "error": "Invalid request signature." }` (Discord tests this on purpose) |
| Signed, but not JSON | `400 { "error": "That request was not valid JSON." }` |
| `PING` (`type: 1`) | `200 { "type": 1 }` |
| Autocomplete (`type: 4`, `/signup raid`) | `200 { "type": 8, "data": { "choices": [{ "name": "Molten Core (Fri, 13 Nov 2026 18:00 UTC)", "value": "12" }] } }` |
| Slash command (`type: 2`) | `200 { "type": 4, "data": { "content": "…", "allowed_mentions": { "parse": [] }, "flags": 64? } }` |
| Anything throws while answering | `200 { "type": 4, "data": { "content": "Something went wrong in Guild Camp. Try again in a moment.", "flags": 64 } }` (logged) |

`flags: 64` means only the person who typed the command sees the reply (ephemeral).

### Which guild and which member
- The Discord server is matched by `guilds.discord_server_id`. It is set automatically the first time anyone runs
  `/link` in that server (only if the guild has no server yet).
- If the server isn't connected but the Discord user is linked, their own guild is used (so commands also work in DMs).
- The Discord user is matched by `users.discord_id` (unique; set by `/link`).

### Commands

| Command | Who | Reply |
|---|---|---|
| `/link code:<CODE>` | anyone | Links the Discord account to the member who made the code (case-insensitive, works once, 15 minutes). A Discord account linked to someone else moves to the new member. Ephemeral: `Linked to Thrall in Guild Camp. You can now use /signup and /cta.` / `That code didn’t work. Get a fresh one from Settings in the Guild Camp app (codes last 15 minutes).` |
| `/online` | anyone in a connected server | Public: `🔥 **3 around the fire** (as of <t:…:R>)` then `Name (level), zone` lines, or `Nobody online.` |
| `/raids` | anyone in a connected server | Public: up to 8 open/locked raids starting after 3 hours ago: `**Title** <t:…:F> (<t:…:R>), N coming` + `<BASE_URL>/raids/<id>`, or `Nothing scheduled.` |
| `/craft item:<text>` | anyone in a connected server | Public: up to 10 recipes matching the text (`%` and `_` are literal): `**Recipe**: Name 🟢, Name` (🟢 = online), or `Nobody has a recipe matching “x” synced yet.` |
| `/price item:<text>` | anyone in a connected server | Public: up to 8 items with a recent scan: `**Runecloth**: 1g 20s (scanned 2026-11-07)`, or `No recent auction scans for that. Prices come from members running Auctionator scans.` |
| `/cta zone:<text> needed:<1-40>? message:<text>?` | linked members | Stores a call to arms (`ctas.source = 'discord'`, character = the member's main), adds the camp feed line `Call to arms in <zone> (from Discord)` and an app notification (`cta`, title `⚔️ Call to arms: <zone>`, body `Called from Discord.`, route `/`). Public reply: `⚔️ **Call to arms: Zone** (need 5)` / message / `— Main`. Not posted to the webhook: the reply is already in Discord. |
| `/signup raid:<id> role:<tank/healer/dps> status:<yes/tentative/no>? character:<name>?` | linked members | Signs the member up (or changes their sign-up) for an open/locked raid. Character defaults to their main, then their BattleTag name. Ephemeral: `Mokra is coming for **Molten Core** as healer. Reserves: <BASE_URL>/raids/12`. |

Unconnected server, unknown user → ephemeral: `This server isn’t connected to Guild Camp yet. Open Settings in the
Guild Camp app (get it at <BASE_URL>/get), get a link code and run /link.`
`/cta` or `/signup` from an unlinked Discord user → ephemeral: `Link your Discord first: in the Guild Camp app open
Settings → “Link Discord”, then run /link with the code.`

---

## `GET /api/discord` (signed in)
What Settings → Discord shows.
```json
{
  "configured": true,
  "app_id": "1234567890",
  "invite_url": "https://discord.com/oauth2/authorize?client_id=1234567890&scope=bot%20applications.commands&permissions=8589934592",
  "bot_configured": true,
  "linked": false,
  "server_linked": true,
  "commands": ["online", "raids", "cta", "craft", "price", "signup", "link"]
}
```
- `configured`: `DISCORD_APP_ID` and `DISCORD_PUBLIC_KEY` are set. When false, `app_id` and `invite_url` are `null`.
- `invite_url`: adds the app to a Discord server with the slash commands and the bot with **Manage Events**
  (so raids can also show in Discord's Events list).
- `bot_configured`: `DISCORD_APP_ID` and `DISCORD_BOT_TOKEN` are set, so officers can register the commands.
- `linked`: this member's Discord account is linked. `server_linked`: the guild has a Discord server
  (`discord_server_id`); `false` when not in a guild.

## `POST /api/discord/link` (guild member)
Makes a fresh 8-character code (hex, upper case) valid for 15 minutes. It replaces the member's older codes.
```json
{
  "code": "9F3A0C7B",
  "expires_at": "2026-11-07T18:20:00.000Z",
  "command": "/link 9F3A0C7B",
  "linked": false,
  "message": "Your link code is 9F3A0C7B. In your Discord server, type /link 9F3A0C7B within 15 minutes."
}
```
`expires_at` is ISO 8601 UTC. `linked` is the member's state before using the code (a new code relinks them).
- Discord not configured → `400 { "error": "Discord isn't set up on this server yet. Ask the server owner to add the Discord app details." }`
- Not in a guild → `403 { "error": "Join a guild first." }`

## `POST /api/discord/unlink` (signed in)
```json
{ "ok": true, "message": "Discord unlinked." }
```

## `POST /api/discord/register` (owner or officer)
Sends the slash command list to Discord (`PUT /applications/<app id>/commands` with the bot token, through
`cfg.fetch`). Needed once after adding the app, and again when the commands change.
```json
{ "ok": true, "registered": 7, "message": "7 slash commands registered with Discord." }
```
Audit: `Discord commands registered` (detail: the number).
- No app id or bot token → `400 { "error": "The Discord app details aren’t set on the server yet." }`
- Discord refuses → `502 { "error": "Discord said 401: {\"message\": \"401: Unauthorized\", …}" }`
- Discord can't be reached → `502 { "error": "Couldn't reach Discord. Try again in a minute." }`
- Members → `403 { "error": "Officers only." }`

---

## Service functions (`server/src/services/discord.js`)
For other domains (raids use the scheduled events):
```js
const D = require('../services/discord');
D.createEvent(cfg, guild.discord_server_id, raid, url)  // → Discord event id; HttpError 502 when Discord refuses
D.deleteEvent(cfg, guild.discord_server_id, eventId)    // best effort
D.newLinkCode(db, userId, guildId)                      // → code (15 minutes)
D.COMMANDS                                              // slash command definitions
```
