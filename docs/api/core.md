# Core API

What the app is, who I am, my notification choices, the guild and its settings, and the members Guild Camp
knows about. Implemented in `app/src/core/routes/core.js`, with `identity.js` (me, the guild, roles) and
`events.js` (notifications). There are no accounts, devices, invites or sign-in routes: see
[ARCHITECTURE.md](../ARCHITECTURE.md) "Identity and roles".

## Conventions (every route of the local core)

- **Who calls it.** Only the app's own main process (`src/main/api.js`). The core listens on `127.0.0.1` on a
  random port. Every request needs `Authorization: Bearer <token>`, a random secret made at each launch; without
  it the answer is `401 { "error": "Not allowed." }` for any path. The renderer reaches the core only through
  `gc.api.request(method, path, body)`, which accepts paths under `/api/` only.
- **Me.** Every request is the player on this computer (`req.user`, the `local:me` users row). `req.guild` is the
  current guild with my role, or `null` until an upload brought a guild.
- **Requests**: JSON bodies (`Content-Type: application/json`, up to 15 MB). A missing body counts as `{}`. The
  app sends `X-App-Version: 0.11.0`; the core saves it on my users row.
- **Field names**: rows keep their column names and stored values (`snake_case`, SQLite integers for flags such as
  `coach_enabled: 1`). Fields the core computes, and envelope keys, are `camelCase` (`notifyPrefs`,
  `memberCount`). JSON text columns are returned parsed where noted (`realm_status`).
- **Times**: SQLite `"YYYY-MM-DD HH:MM:SS"` strings in UTC (no zone marker) unless noted; parse them as UTC. Raid
  start times and roster times are ISO 8601. Money is integer copper.
- **Security headers** on every answer: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`, `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`,
  `Cache-Control: no-store`. No CORS headers.
- **Errors**: any 4xx/5xx is `{ "error": "Plain sentence for a person." }`, sometimes with a `code`. The main
  process passes the status and the code on to the renderer (`gc.api.request` rejects with
  `{ message, status, code }`; [ARCHITECTURE.md](../ARCHITECTURE.md) "IPC surface"), so pages can rely on
  `code: "NO_GUILD"` rather than on the sentence.

| Status | When | Example `error` |
|---|---|---|
| 400 | Bad input | `"Pick Off, or an in-game rank from 0 to 9, for officers."`, `"That request was not valid JSON."` |
| 401 | Missing or wrong launch token | `"Not allowed."` |
| 403 | No guild yet (`code: "NO_GUILD"`) | `"Guild Camp hasn't seen your guild yet. Log in to World of Warcraft with the Guild Camp addon on a character in your guild, then log out or type /reload."` |
| 403 | Not allowed for my role | `"Only officers can do that. Your rank in the in-game guild decides who is an officer."`, `"Only the Guild Master can do that."` |
| 404 | Unknown path or row | `"Not found."` |
| 409 | The action can't happen now | `"That request has already moved on."`, `"This was made with an older Guild Camp and can’t be changed. Make it again."` |
| 413 | Body too large | `"That upload is too large."` |
| 500 | A bug (the stack is logged) | `"Something went wrong inside Guild Camp. Try again, and check the log if it keeps happening."` |

### Roles

Roles come only from in-game guild ranks (`identity.syncRanks`): the best (lowest) rank index among a player's
characters decides. Rank 0 (Guild Master) → `owner`; rank ≤ `officer_rank_max` (default 1) → `officer`; anything
else or unknown → `member`. Routes use three guards from `http.js`:

| Guard | Lets through | Otherwise |
|---|---|---|
| `needGuild` | anyone, once the guild is known | `403` with `code: "NO_GUILD"` (the sentence above) |
| `needOfficer` | `owner` and `officer` | `403 "Only officers can do that. Your rank in the in-game guild decides who is an officer."` |
| `needOwner` | `owner` | `403 "Only the Guild Master can do that."` |

Docs in this folder write "(guild)", "(officer)" or "(Guild Master)" next to each route for these.

### Shared guild data

Raids, sign-ups, loot, notices, calls to arms, requests, partner posts, drives, bank requests, bank characters and
the officer and relay ranks are shared with guildmates through the addon ([SHARING.md](../SHARING.md)). A route
that changes them checks input and role, then queues a record (`sharing.queue`). The rows change at once, so the
answer already shows the change. The change itself goes to the guild the next time the player logs in or types
`/reload`; it shows under Addon & sync until then ([share.md](share.md)). Guildmates are notified by their own
apps, and a Discord post (when a webhook is set) goes out once the game confirms the change. Rows made before
sharing existed have no `share_id`: they can be read but not changed (`409 "This was made with an older Guild
Camp and can’t be changed. Make it again."`). A change that needs a player id before any of my characters is
known answers `409 "Log in to World of Warcraft on a character in your guild first, then log out or type
/reload."`.

### Common shapes

**User** (never includes `bnet_id`, `calendar_token` or `notify_prefs`)
```json
{ "id": 1, "battletag": "Calvin#1234", "name": "Calvin", "addon_version": "0.11.0", "app_version": "0.11.0",
  "last_sync_at": "2026-11-07 18:02:11", "created_at": "2026-11-01 09:00:00" }
```
`battletag` is the BattleTag when the player signed in to Battle.net in the app, otherwise the name of their main
(or most recently played) character, otherwise `"You"`. `name` is the part before `#`.

**Guild** (`discord_webhook` only for owner and officers)
```json
{ "id": 1, "name": "Just Now WoW", "faction": "Horde", "ruleset": "PvP", "wowhead_game": "forever",
  "realm": "Mirage Raceway", "game_guild": "Just Now WoW",
  "realm_status": { "found": true, "name": "Mirage Raceway", "up": true },
  "official_roster_at": null, "official_roster_note": null, "roster_scanned_at": "2026-11-07T17:55:00.000Z",
  "bank_money": 1234567, "bank_scanned_at": "2026-11-06T20:00:00.000Z",
  "coach_enabled": 1, "coach_budget_usd": 15, "officer_rank_max": 1, "relay_rank_max": null,
  "reset_at": null, "created_at": "2026-11-01 09:00:00", "role": "officer",
  "discord_webhook": "https://discord.com/api/webhooks/123/abc" }
```
- The guild is created locally from the first upload that has a character in a guild. `realm` and `game_guild`
  come from the game.
- `officer_rank_max`: the highest in-game rank index (0 = Guild Master) that counts as officer. `relay_rank_max`:
  ranks below the officers that may also pass on officer changes in game ("Who passes on officer changes");
  `null` = officers only.
- `discord_webhook` is this computer's Settings value (`settings.discordWebhook`), shown to officers; it is not a
  guild setting any more.

---

## `GET /api/meta`

```json
{ "app": "guild-camp", "version": "0.11.0", "guild": { "name": "Just Now WoW", "faction": "Horde" },
  "blizzard": true, "latest": { "app": { "version": "0.11.1" }, "addon": { "version": "0.11.1" } } }
```
- `guild` is `null` before the first upload with a guild.
- `blizzard`: this copy of Guild Camp has the Battle.net app built in (Blizzard game data can run).
- `latest`: the newest app and addon versions the app's updater and addon manager know (either may be `null`).

## `GET /api/me`

```json
{
  "user": { "id": 1, "battletag": "Calvin#1234", "name": "Calvin", "...": "User shape" },
  "guild": { "id": 1, "name": "Just Now WoW", "...": "Guild shape" },
  "role": "officer",
  "notifyPrefs": { "cta": true, "raids": true, "notices": true, "requests": true, "bank": true, "coach": true, "drives": true },
  "bnet": { "characters": 6, "profile_at": "2026-11-07 18:00:00", "note": "Read 6 characters from Battle.net." }
}
```
- `guild` and `role` are `null` until an upload brought a guild. This route never answers `NO_GUILD`.
- `bnet`: what Battle.net sign-in in the app read (count of World of Warcraft characters, when, and a plain note).
  `{ "characters": 0, "profile_at": null, "note": null }` when not signed in.
- The same `{ user, guild, role }` is what `gc.auth.state()` adds to the Battle.net state.

## `PUT /api/me/notifications`

Turns kinds of notifications on or off for this computer. Body: any of `cta`, `raids`, `notices`, `requests`,
`bank`, `coach`, `drives` as booleans, either directly or as `{ "notifyPrefs": { … } }`. Other keys and
non-boolean values are ignored.
```json
{ "raids": false }
```
```json
{ "notifyPrefs": { "cta": true, "raids": false, "notices": true, "requests": true, "bank": true, "coach": true, "drives": true } }
```

---

## The guild

### `GET /api/guild` (guild)

```json
{ "guild": { "...": "Guild shape" }, "memberCount": 14,
  "options": { "wowheadGames": [ { "value": "forever", "label": "WoW: Forever" }, { "value": "retail", "label": "Retail" },
                                 { "value": "classic", "label": "Classic" } ] } }
```
`memberCount` counts me and the guildmates whose records reached me.

### `PUT /api/guild/settings` (guild; some fields need a role)

A partial update. Everything is checked before anything is saved.

| Field | Who | Rule |
|---|---|---|
| `wowhead_game` | anyone | `forever`, `retail` or `classic`: which Wowhead database item tooltips use. |
| `coach_enabled`, `coach_budget_usd` | anyone | The Coach's AI on or off, and a monthly budget of $0–$500 (rounded to cents). The key and the budget are the player's own. |
| `realm`, `game_guild` | officers | Up to 60 characters each. Normally read from the game. Clears `realm_status` and `official_roster_at`. |
| `officer_rank_max` | Guild Master | `null` / `""` (Off) or a rank index 0–9. Off is saved as 0, the Guild Master alone. |
| `relay_rank_max` | Guild Master | `null` / `""` (officers only) or a rank index 0–9. |
| `discord_webhook` | nobody | Refused: the webhook is set in Settings now, on this computer only. |

`officer_rank_max` and `relay_rank_max` are shared with the guild as one `CFG` record (need `g`: it waits for a
Guild Master character in game, and every other app accepts it only from rank 0). Changing one keeps the other.
Roles here change at once; each app that receives the record changes its roles too. When the guild's first `CFG`
is cancelled under Addon & sync or refused by the game, the ranks go back to the defaults (officers up to rank 1,
officer changes passed on by officers only).

A change to `wowhead_game`, `officer_rank_max` or `relay_rank_max` (here, or from a `CFG` that arrives in an
upload) makes the core send `session` on its emitter, so every open page picks up the new Wowhead database and
roles; the Guild settings page also refreshes the session after a save.

```json
{ "officer_rank_max": 2, "relay_rank_max": 3 }
```
```json
{ "guild": { "...": "Guild shape, with my role after the change" },
  "messages": ["Officers now follow in-game ranks: Guild Master + 2 ranks below.",
               "Officer changes are also passed on by the Guild Master and the 3 ranks below."] }
```

Messages, one per change: `"Item tooltips now use Wowhead's Forever database."`, `"Realm saved. Use "Refresh now"
to fetch realm status and the official roster."`, `"Coach settings saved."`, `"Officers now follow in-game ranks:
<label>."` (Off: `"In-game ranks no longer make anyone an officer here."`), `"Officer changes are also passed on
by <who>."` (null: `"Only officers pass on officer changes now."`).

Audit lines: `Wowhead tooltips set`, `realm set`, `coach settings`, `officer ranks set`, `relay ranks set`, and a
`rank promote` / `rank demote` line for each member whose role changed.

| Status | When | `error` |
|---|---|---|
| 400 | `discord_webhook` sent | `"The Discord webhook is set in Settings now, on this computer only."` |
| 400 | Unknown `wowhead_game` | `"Pick WoW: Forever, Retail or Classic for item tooltips."` |
| 400 | Budget out of range | `"Set a monthly Coach budget between $0 and $500."` |
| 400 | Bad officer rank | `"Pick Off, or an in-game rank from 0 to 9, for officers."` |
| 400 | Bad relay rank | `"Pick Nobody, or an in-game rank from 0 to 9, for who passes on officer changes."` |
| 400 | Nothing recognised | `"Nothing to save."` |
| 403 | `realm` / `game_guild` by a member | `"Only officers can change the realm and guild name."` |
| 403 | Officer ranks by anyone but the Guild Master | `"Only the Guild Master can choose which ranks are officers."` |
| 403 | Relay ranks by anyone but the Guild Master | `"Only the Guild Master can choose who passes on officer changes."` |

## `GET /api/members` (guild)

Everyone Guild Camp knows plays in the guild: me, and the guildmates whose shared records reached me. Owner first,
then officers, then members, then by BattleTag.
```json
{ "members": [
  { "id": 1, "battletag": "Calvin#1234", "name": "Calvin", "role": "owner", "rank_index": 0,
    "joined_at": "2026-11-01 09:00:00", "characters": 3,
    "main": { "name": "Grimtusk", "class": "WARRIOR", "level": 60, "is_main": 1 },
    "addon_version": "0.11.0", "app_version": "0.11.0", "last_sync_at": "2026-11-07 18:02:11", "isMe": true },
  { "id": 7, "battletag": "Velanne", "name": "Velanne", "role": "member", "rank_index": 4,
    "joined_at": "2026-11-05 20:00:00", "characters": 2, "main": { "name": "Velanne", "class": "PRIEST", "level": 60, "is_main": 1 },
    "addon_version": "0.11.0", "app_version": null, "last_sync_at": null, "isMe": false }
] }
```
- A guildmate is a player (player id) linked to characters through their shared character records. Their
  `battletag` is the BattleTag they shared, else their main's name.
- `rank_index` is the best in-game rank among their characters (`null` until a roster scan saw it).
- `main` is their main, else their highest-level character (`null` without characters). A character known to be
  in the guild comes before a guildless one of mine (uploaded with no guild), and my characters that an upload put
  in another in-game guild don't count here or in `characters` (SHARING.md §3).
- A guildmate's `addon_version` comes from their shared character records. `app_version` and `last_sync_at`
  are only known for me (guildmates' apps don't report to this one).

There is no promote, demote or remove: the in-game guild decides.

---

## Notifications

There is no events endpoint. The core decides in-process which notifications **I** should see and sends each one
on its emitter as `event`; the main process shows a native notification and sends it to the renderer on the
`server-event` channel.

```json
{ "id": 41, "kind": "raid", "title": "🗓️ Molten Core", "body": "Molten Core, Fri 13 Nov, 19:00 UTC. Sign up in Guild Camp.",
  "route": "/raids/12", "created_at": "2026-11-07 18:05:00" }
```

Kinds and the `notifyPrefs` switch that hides them: `cta` → `cta`, `raid` → `raids`, `notice` → `notices`,
`request` → `requests`, `bank` → `bank`, `coach` → `coach`, `drive` → `drives`. `release` always shows. Shown
events are kept in the `events` table for 14 days.

Emitting one (core code):
```js
ctx.emit(guildId, 'raid', {
  title: '🗓️ Molten Core',            // up to 120 characters
  body: 'Sign up in Guild Camp.',     // up to 300 characters
  route: '/raids/12',                 // an app route starting with "/"
  userId: 9,                          // only when that is me
  userIds: [9, 12],                   // only when I am one of these
  exceptUserId: 9,                    // not when that is me
  officersOnly: true,                 // only when I am the Guild Master or an officer
  recipe: 'Flask of the Titans',      // only when one of my characters knows it (any capitalisation)
});                                   // → event id when shown to me, else null. Never throws.
```

Most notifications come from guildmates' records arriving in an upload (`share/import.js`): a raid scheduled
or cancelled, a notice, a call to arms under an hour old, a crafting request I can make, a claim or delivery of
my own request, a bank request (officers), an answer to my bank request, a drive started or reaching its goal.
Others: the one-hour raid reminder (raids.md), Coach answers (coach.md), realm back up (admin.md).
