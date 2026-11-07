# Core API

Server info, sign-in, the signed-in member, devices, the guild, members and notifications.
Implemented in `server/src/routes/auth.js`, `routes/guild.js`, `routes/events.js` and `services/events.js`.

## Conventions (whole API)

- **Requests**: JSON bodies with `Content-Type: application/json` (up to 15 MB). A missing body counts as `{}`.
  Exceptions: uploads to `/api/publish/*` with any method but POST (raw, streamed to disk; `req.body` is left
  undefined) and `/discord/*` (raw bytes as a Buffer in `req.body`, for signature checks).
  `POST /api/publish/app/commit` is parsed as JSON like any other call.
- **Auth**: `Authorization: Bearer gcd_…` (device token from sign-in). The app also sends `X-App-Version: 0.11.0`;
  the server records it on the device and the member.
- **Field names**: database rows keep their column names and stored values (`snake_case`, SQLite integers for
  flags such as `coach_enabled: 1`). Fields the server computes, and envelope keys, are `camelCase`
  (`inviteUrl`, `notifyPrefs`, `latestId`, `memberCount`). JSON text columns are returned parsed where noted
  (`realm_status`).
- **Times**: SQLite `"YYYY-MM-DD HH:MM:SS"` strings in UTC (no zone marker). Parse them as UTC.
- **Errors**: any 4xx/5xx is `{ "error": "Plain sentence for a person." }`.

| Status | When | Example `error` |
|---|---|---|
| 400 | Bad input | `"Use a BattleTag like Name#1234."`, `"That request was not valid JSON."` |
| 401 | No token, or the token isn't accepted | `"Sign in first."`, `"This device was signed out. Sign in again in Guild Camp."`, `"That sync key no longer works. Install the Guild Camp app and sign in with Battle.net."` |
| 403 | Signed in but not allowed | `"Join a guild first."`, `"Officers only."`, `"Only the guild owner can do that."` |
| 404 | Unknown path or row | `"Not found."` |
| 409 | Conflict | `"This server already has a guild. Ask an officer for the invite link."` |
| 413 | Body too large | `"That upload is too large."` |
| 429 | Rate limited (has `Retry-After`) | `"Too many sign-in attempts. Wait a minute and try again."` |
| 500 | Server bug (stack is logged) | `"Something went wrong on the server. Try again in a minute."` |

- **Rate limits** (per minute): `/api/sync` 40 per token, `/auth/*` + `/api/auth/*` 20 per IP, `/discord/*` 120, `/api/publish/*` 30.
- **Security headers** on every response: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: same-origin`, `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'` (HTML pages
  get a small inline-styles-only CSP), `Strict-Transport-Security` when `BASE_URL` is https.
- **Legacy sync keys** (`Bearer wowg_…`, old companion) are accepted **only** on `POST /api/sync`, `GET /api/inbox`
  and `GET /api/inbox.lua`, and only while the key's owner is still in the key's guild. Everywhere else they get 401.

### Common shapes

**User**
```json
{ "id": 3, "battletag": "Thrall#1234", "name": "Thrall", "discord_linked": false,
  "addon_version": "0.11.0", "app_version": "0.11.0", "last_sync_at": "2026-11-07 18:02:11",
  "created_at": "2026-10-01 09:00:00" }
```

**Guild** (`invite_code`/`inviteUrl` for members of the guild; `discord_webhook` only for owner and officers)
```json
{ "id": 1, "name": "wow", "faction": "Horde", "ruleset": "PvP", "wowhead_game": "forever",
  "realm": "Mirage Raceway", "game_guild": "wow", "realm_status": { "name": "Mirage Raceway", "up": true },
  "official_roster_at": null, "official_roster_note": null, "roster_scanned_at": "2026-11-07 17:55:00",
  "bank_money": 1234567, "bank_scanned_at": "2026-11-06 20:00:00", "discord_server_id": null,
  "coach_enabled": 1, "coach_budget_usd": 15, "reset_at": null, "created_at": "2026-10-01 09:00:00",
  "role": "officer",
  "invite_code": "Xk3_9aQe", "inviteUrl": "https://wow.cjplumbing.co.za/join/Xk3_9aQe",
  "discord_webhook": "https://discord.com/api/webhooks/123/abc",
  "auto_join": "roster", "officer_rank_max": 1 }
```
`auto_join` and `officer_rank_max` (see [Joining by itself](#joining-by-itself)) are added by the core routes:
`GET /api/me`, `POST /api/guild`, `POST /api/guild/join`, `GET /api/guild` and `PUT /api/guild/settings`.

**Device** (never includes the token or its hash)
```json
{ "id": 7, "name": "Gaming PC", "platform": "win32", "prefix": "gcd_Ab3dE5fG",
  "app_version": "0.11.0", "addon_version": null, "created_at": "2026-11-01 10:00:00",
  "last_used_at": "2026-11-07 18:03:00", "current": true }
```

---

## Server info

### `GET /api/meta` (public)
What the app shows before sign-in.
```json
{
  "server": "guild-camp",
  "version": "0.11.0",
  "devLogin": false,
  "bnet": true,
  "guild": { "name": "wow", "faction": "Horde" },
  "releases": {
    "app": { "version": "0.11.1", "notes": "Fixes.", "file": "Guild-Camp-Setup-0.11.1.exe", "size": 81234567,
             "sha256": null, "sha512": "base64…", "created_at": "2026-11-05 12:00:00" },
    "addon": null
  }
}
```
`guild` is `null` until a guild is created. `releases` comes from `ctx.latest()`: the newest `releases` rows, or
whatever the releases domain's `ctx.services.releases.latest()` returns once it is registered (see `docs/api/releases.md`).

### `GET /healthz` (public)
```json
{ "ok": true }
```

---

## Sign-in

### `GET /auth/bnet?device=<name>&platform=<platform>&appVersion=<version>` (public, browser)
Opened by the app in its sign-in window. Checks the device details (name up to 60 characters, platform
`[a-z0-9_-]{1,20}`, version like `0.11.0`), signs a 10-minute state with `SESSION_SECRET`, sets a short-lived
`gc_auth_nonce` cookie (HttpOnly, SameSite=Lax, path `/auth`) and redirects `302` to Battle.net.
- Battle.net not configured → `503` HTML page. Bad device details → `400` HTML page.

### `GET /auth/bnet/callback?code=&state=` (Battle.net redirects here)
Checks the state and the nonce cookie, exchanges the code (scope `openid wow.profile`), creates or updates the
user (BattleTag follows Battle.net), creates a device, reads the player's WoW characters (below), tries to join
them to the guild (`tryAutoJoin`, see [Joining by itself](#joining-by-itself)), then:
```
302 Location: /auth/app/done#token=gcd_…
```
The token is in the fragment, so it never reaches a server or a `Referer`. The app's sign-in window watches for
this address, reads the token and closes.
- `error=access_denied` (cancelled) → `400` HTML. Missing/altered/expired state or no nonce cookie → `400` HTML
  ("Sign-in expired or was started from a different address."). Battle.net failure → `502` HTML.

**Reading the WoW characters.** With the player's Battle.net access token (used once, never stored), all
through `cfg.fetch`, the whole step capped at about 6 s (`cfg.bnetProfileTimeoutMs`):
1. `GET https://<BNET_REGION>.api.blizzard.com/profile/user/wow?namespace=<ns>&locale=en_GB` in parallel for
   `profile-<r>`, `profile-classic-<r>`, `profile-classic1x-<r>` and `profile-<g>-<r>` for every WoW: Forever
   guess in `services/blizzard.js` `FOREVER_GUESSES`. `404`/`403` mean "no characters there".
2. For up to 10 characters (those on the guild's realm first, then the highest level), the character profile
   summary `GET /profile/wow/character/<realm_slug>/<lower-case name>?namespace=<ns>&locale=en_GB` gives the
   in-game guild name.
3. When at least one namespace answered, the user's `bnet_characters` rows are replaced and
   `users.bnet_profile_at` is set. `users.bnet_profile_note` always says what happened, for example
   `"Read 3 characters from Battle.net (Classic Era 2, WoW: Forever 1)."`,
   `"Battle.net shows no World of Warcraft characters on this account yet."` or
   `"Couldn't read your characters from Battle.net (it did not answer in time). Guild Camp uses the addon instead."`
   (then the rows from the last sign-in are kept).

Sign-in never fails because of this step.

### `GET /auth/app/done` (public, browser)
A small styled HTML page: "You are signed in. You can close this window and go back to Guild Camp." No scripts.

### `POST /api/auth/dev` (only when `DEV_LOGIN=1`; otherwise `404`)
```json
{ "battletag": "Thrall#1234", "device": { "name": "Dev PC", "platform": "win32", "appVersion": "0.11.0" } }
```
`device` may also be a plain name string, or left out. The user's `bnet_id` is `dev:<battletag>`.
```json
{ "token": "gcd_…", "user": { "id": 3, "battletag": "Thrall#1234", "name": "Thrall", "discord_linked": false,
  "addon_version": null, "app_version": "0.11.0", "last_sync_at": null, "created_at": "2026-11-07 18:00:00" } }
```
- Bad BattleTag → `400 { "error": "Use a BattleTag like Name#1234." }`

### `POST /api/auth/signout` (signed in)
Deletes the device making the call. Its token stops working at once.
```json
{ "ok": true }
```

---

## The signed-in member

### `GET /api/me` (signed in)
```json
{
  "user": { "id": 3, "battletag": "Thrall#1234", "name": "Thrall", "discord_linked": false, "addon_version": "0.11.0",
            "app_version": "0.11.0", "last_sync_at": "2026-11-07 18:02:11", "created_at": "2026-10-01 09:00:00" },
  "guild": { "id": 1, "name": "wow", "faction": "Horde", "role": "member", "invite_code": "Xk3_9aQe",
             "inviteUrl": "https://wow.cjplumbing.co.za/join/Xk3_9aQe", "...": "see Guild shape" },
  "role": "member",
  "device": { "id": 7, "name": "Gaming PC", "platform": "win32", "prefix": "gcd_Ab3dE5fG", "app_version": "0.11.0",
              "addon_version": null, "created_at": "2026-11-01 10:00:00", "last_used_at": "2026-11-07 18:03:00", "current": true },
  "notifyPrefs": { "cta": true, "raids": true, "notices": true, "requests": true, "bank": true, "coach": true, "drives": true },
  "bnet": { "characters": 3, "profile_at": "2026-11-07 18:00:00", "note": "Read 3 characters from Battle.net (Classic Era 3)." }
}
```
`guild` and `role` are `null` until the member creates or joins a guild. `role` is `owner`, `officer` or `member`.
`bnet` is what the last Battle.net sign-in read: how many WoW characters are stored, when (`null` if never, as
for dev sign-ins), and the plain note (`null` if never tried).

### `PUT /api/me/notifications` (signed in)
Any subset of the seven switches, as booleans (non-booleans and unknown keys are ignored). Also accepts
`{ "notifyPrefs": { … } }`.
```json
{ "raids": false, "bank": false }
```
```json
{ "notifyPrefs": { "cta": true, "raids": false, "notices": true, "requests": true, "bank": false, "coach": true, "drives": true } }
```

---

## Devices (Settings → Devices)

### `GET /api/devices` (signed in)
Newest use first. `syncKeys` are the member's old companion sync keys, still accepted for syncing.
```json
{
  "devices": [
    { "id": 7, "name": "Gaming PC", "platform": "win32", "prefix": "gcd_Ab3dE5fG", "app_version": "0.11.0",
      "addon_version": null, "created_at": "2026-11-01 10:00:00", "last_used_at": "2026-11-07 18:03:00", "current": true },
    { "id": 5, "name": "Laptop", "platform": "win32", "prefix": "gcd_Zz9yX8wV", "app_version": "0.11.0",
      "addon_version": null, "created_at": "2026-10-20 08:00:00", "last_used_at": "2026-10-30 21:00:00", "current": false }
  ],
  "syncKeys": [ { "id": 2, "prefix": "wowg_Q1w2E", "created_at": "2026-09-01 12:00:00", "last_used_at": "2026-11-07 17:00:00" } ]
}
```

### `DELETE /api/devices/:id` (signed in, own devices only)
Signs that device out. Revoking the current device is the same as signing out.
```json
{ "ok": true, "current": false }
```
- Not yours or unknown → `404 { "error": "Device not found." }`

### `DELETE /api/sync-keys/:id` (signed in, own keys only)
Revokes an old companion sync key.
```json
{ "ok": true }
```
- Not yours or unknown → `404 { "error": "Sync key not found." }`

---

## The guild

### `POST /api/guild` (signed in, not in a guild)
Only works while the server has no guild. The creator becomes the owner. Defaults: name `"wow"`, faction
`"Horde"` (anything but `"Alliance"` means Horde). Name up to 40 characters. Optional `realm` and `game_guild`
(the in-game realm and guild name, up to 60 characters each) are stored on the guild; the app sends them from
the guild it detected (`detected` in the auto-join result), so other members can join by themselves at once.
```json
{ "name": "Just Now WoW", "faction": "Horde", "realm": "Mirage Raceway", "game_guild": "Just Now WoW" }
```
`201`
```json
{ "guild": { "id": 1, "name": "wow", "faction": "Horde", "role": "owner", "invite_code": "Xk3_9aQe",
             "inviteUrl": "https://wow.cjplumbing.co.za/join/Xk3_9aQe", "discord_webhook": null, "...": "see Guild shape" },
  "role": "owner" }
```
- Already in a guild → `400 { "error": "You are already in a guild." }`
- A guild exists → `409 { "error": "This server already has a guild. Ask an officer for the invite link." }`
- Adds activity "`<name>` lit the campfire".

### `GET /api/guild/invite/:code` (public)
Preview for the join screen. `:code` may be the bare code.
```json
{ "guild": { "name": "wow", "faction": "Horde", "members": 12 } }
```
- Unknown code → `404 { "error": "That invite link doesn't work. Ask an officer for a fresh one." }`

### `POST /api/guild/join` (signed in)
`code` may be the bare code or a pasted link (`https://…/join/<code>`, `guildcamp://join/<code>`).
```json
{ "code": "Xk3_9aQe" }
```
```json
{ "guild": { "id": 1, "name": "wow", "role": "member", "invite_code": "Xk3_9aQe", "inviteUrl": "…", "...": "see Guild shape" },
  "role": "member" }
```
- Unknown code → `404`. In another guild → `400 { "error": "You are already in a guild." }`. Already in this
  guild → `200` with the current role. Adds activity "`<name>` joined the camp". Invite links work whatever
  `auto_join` says.

### Joining by itself

#### `POST /api/guild/auto-join` (signed in)
The app sends the characters the addon saved (`WowGuildDB.characters` of every game folder); the Battle.net
characters read at sign-in count too. Up to 50 characters (more are ignored), strings capped (name 40, realm 60,
guild 60, faction 10, class 20). `characters` may be a list or the addon's map keyed by name, or left out.
```json
{ "characters": [ { "name": "Thrallia", "realm": "Mirage Raceway", "guild": "Just Now WoW", "faction": "Horde",
                    "level": 23, "class": "SHAMAN", "updated": 1794065026 } ] }
```
Always `200` with the **result object** (also used by `POST /api/sync`, below):
```json
{ "status": "joined", "guild": { "id": 1, "name": "Just Now WoW", "faction": "Horde" }, "role": "member",
  "via": "roster", "character": "Thrallia", "reason": "You're in Just Now WoW. Guild Camp matched Thrallia.",
  "detected": { "guild": "Just Now WoW", "realm": "Mirage Raceway", "faction": "Horde" } }
```
| `status` | When | `guild` / `role` / `via` / `character` |
|---|---|---|
| `joined` | A character matched (rules below); the member is in now | set |
| `already` | Already a member | `guild`, `role` |
| `no-guild-on-server` | Nobody has created the guild here yet. `detected` says which in-game guild the player is in, if known: the app offers "Set up `<guild>` on this server" (`POST /api/guild`) | all `null` |
| `no-match` | No character matched | `guild` |
| `disabled` | `auto_join` is `off`: invite links only | `guild` |

`reason` is always a plain sentence for the person, e.g.
`"Log in to World of Warcraft once with the Guild Camp addon on a character in Just Now WoW, then Guild Camp will add you."`,
`"None of your characters are in Just Now WoW's roster yet. Ask someone in the guild to open the guild roster in game, or use an invite link."`,
`"Grom is on Firemaw, but Just Now WoW plays on Mirage Raceway. Log in to a character in Just Now WoW, then Guild Camp will add you."`,
`"Thrallia is already linked to someone else in Guild Camp. Ask an officer for an invite link."`,
`"Just Now WoW only lets people in with an invite link. Ask an officer for one."`.
`detected` = the guild of the most recently updated reported character that has one, else of a Battle.net
character (WoW: Forever first, then the highest level), or `null`.

- Malformed input (body not an object, `characters` not a list or map) → `400 { "error": "Send your characters as a list." }`.

**Matching** (`services/membership.js` `tryAutoJoin`; one guild per server). The **guild roster** is this guild's
`characters` rows that came from a roster scan (`rank` set) or Blizzard's official roster (`in_official_roster = 1`).
Names compare without case; realms without case, spaces or punctuation (`Mirage Raceway` = `mirage-raceway`).
1. **Battle.net** (`via: "battlenet"`, allowed for `roster` and `verified`): one of the player's own Battle.net
   characters whose realm matches the guild's realm (when both are known) and whose name is in the guild roster,
   or whose in-game guild (from the summary) is the guild's `game_guild`.
2. **Reported** (`via: "roster"`, only for `roster`): a character from the app whose `guild` is the guild's
   `game_guild`, whose `realm` is the guild's realm (when the guild has one), whose name is in the guild roster,
   and which no other member owns.

On a join: membership `member` with `role_source: "rank"`, then the rank mapping runs at once (a matched officer
becomes an officer); the matched character is claimed when nobody owns it; the member's devices move into the
guild; activity "`<BattleTag>` joined (matched `<Character>`)"; audit `auto join` (`"Thrallia (guild roster)"` /
`"Thrallia (Battle.net)"`); a `notice` event for owner and officers:
`{ title: "<BattleTag> joined the guild", body: "Matched <Character> in the guild roster.", route: "/guild-settings" }`.

#### Officers from in-game ranks
`characters.rank_index` is the in-game rank index (0 = Guild Master). It is written **only** from roster scans
uploaded by the owner or an officer (`members[].rankIndex`, see sync.md) and from Blizzard's official roster.
Each membership has `role_source`: `manual` (set by a person: creating the guild, an invite link, promote,
demote; never changed automatically) or `rank` (joined by itself; follows in-game rank).
For every `rank` membership except the owner: `officer` when one of the member's characters in the guild has
`rank_index ≤ officer_rank_max` (and `officer_rank_max` isn't `null`), otherwise `member`. This runs after a
trusted roster scan, after Blizzard's official roster, after `officer_rank_max` changes, and on each auto join.
Changes are audited as `rank promote` / `rank demote` (`"Aaa#1 (rank 1)"`).

### `GET /api/guild` (guild member)
```json
{
  "guild": { "id": 1, "name": "wow", "faction": "Horde", "role": "officer", "invite_code": "Xk3_9aQe",
             "inviteUrl": "https://wow.cjplumbing.co.za/join/Xk3_9aQe", "discord_webhook": null, "...": "see Guild shape" },
  "memberCount": 12,
  "options": { "wowheadGames": [ { "value": "forever", "label": "WoW: Forever" }, { "value": "retail", "label": "Retail" },
                                 { "value": "classic", "label": "Classic" } ] }
}
```

### `PUT /api/guild/settings` (owner or officer)
Partial update: send only the groups you change. Everything is checked first; if anything is invalid nothing is
saved. Each change is written to the audit log.

| Field(s) | Rule | Audit action |
|---|---|---|
| `discord_webhook` | `https://discord.com/api/webhooks/…` or `https://discordapp.com/api/webhooks/…`; `""`/`null` removes it | `Discord webhook set` / `Discord webhook removed` |
| `wowhead_game` | `forever`, `retail` or `classic` | `Wowhead tooltips set` |
| `realm`, `game_guild` | up to 60 characters each, empty clears; a field left out keeps its value. Saving clears `realm_status` and `official_roster_at` | `realm set` (`"<realm> / <game guild>"`) |
| `coach_enabled`, `coach_budget_usd` | boolean; number clamped to 0–500 (USD per month) | `coach settings` (`"on, $15/month"`) |
| `auto_join` | `roster` (default: join by themselves when their character is in the guild roster), `verified` (only when Battle.net confirms their character), `off` (invite link only) | `auto join set` (`"verified"`) |
| `officer_rank_max` | `null` (off) or a whole number 0–9 (also `"0"`–`"9"`, `""` = off); rank-following members with a character at this in-game rank index or lower (0 = Guild Master) are officers. Default `1`. A change re-runs the rank mapping at once | `officer ranks set` (`"Guild Master + 1 rank below"`, `"off"`) |

```json
{ "discord_webhook": "https://discord.com/api/webhooks/123/abc", "wowhead_game": "retail" }
```
```json
{ "guild": { "id": 1, "wowhead_game": "retail", "discord_webhook": "https://discord.com/api/webhooks/123/abc", "...": "see Guild shape" },
  "messages": [ "Webhook saved.", "Item tooltips now use Wowhead's Retail database." ] }
```
Errors (`400`): `"That isn't a Discord webhook URL."`, `"Pick WoW: Forever, Retail or Classic for item tooltips."`,
`"Set a monthly Coach budget between $0 and $500."`, `"Pick how new members join: roster, verified or off."`,
`"Pick Off, or an in-game rank from 0 to 9, for officers."`, `"Nothing to save."`. Members → `403 "Officers only."`

Messages for the new fields: `"New members now join by themselves when their character is in the guild roster."`,
`"New members now join by themselves only when Battle.net confirms their character."`,
`"New members now need an invite link."`, `"Officers now follow in-game ranks: Guild Master + 1 rank below."`,
`"In-game ranks no longer make anyone an officer here."`.

### `POST /api/guild/invite/reset` (owner or officer)
Replaces the invite code; the old link stops working. Audit: `invite link replaced`.
```json
{ "invite_code": "N3wC0de_", "inviteUrl": "https://wow.cjplumbing.co.za/join/N3wC0de_",
  "message": "New invite link made. The old one no longer works." }
```

---

## Members

### `GET /api/members` (guild member)
Owner first, then officers, then members, each by BattleTag. `main` is the chosen main (`is_main: 1`), otherwise
the highest-level linked character, or `null`.
```json
{
  "members": [
    { "id": 3, "battletag": "Thrall#1234", "name": "Thrall", "role": "owner", "joined_at": "2026-10-01 09:00:00",
      "characters": 3, "main": { "name": "Thrall", "class": "SHAMAN", "level": 60, "is_main": 1 },
      "addon_version": "0.11.0", "app_version": "0.11.0", "companion_version": null,
      "last_sync_at": "2026-11-07 18:02:11", "discord_linked": true, "devices": 2, "sync_keys": 0 }
  ]
}
```

### `POST /api/members/:id/promote` (owner or officer)
Member → officer. Audit: `promoted to officer`. Promote and demote set the membership's `role_source` to
`manual`, so in-game ranks no longer change that person's role.
```json
{ "ok": true, "member": { "id": 9, "role": "officer" }, "message": "Jaina is now an officer." }
```
- Not in the guild → `404 "That person isn't in the guild."`. Not a plain member → `400 "Only members can be promoted."`

### `POST /api/members/:id/demote` (owner only)
Officer → member. Audit: `demoted to member`.
```json
{ "ok": true, "member": { "id": 9, "role": "member" }, "message": "Jaina is now a member." }
```
- An officer calling it → `403 "Only the guild owner can demote officers."`. Target not an officer → `400 "Only officers can be demoted."`

### `POST /api/members/:id/remove` (owner or officer)
Removes the member, deletes all their devices (signed out everywhere) and old sync keys, and unlinks their
characters (`user_id = NULL`, `is_main = 0`). Audit: `removed from guild`.
```json
{ "ok": true, "member": { "id": 9, "role": null }, "message": "Jaina was removed. Their devices are signed out." }
```
- Target is the owner → `403 "Nobody can remove the guild owner."`
- Target is yourself → `400 "You can't remove yourself."`
- An officer removing an officer → `403 "Only the guild owner can remove officers."`

---

## Notifications

### `GET /api/events?after=<id>` (signed in)
The app polls this every 20 s and shows a native notification for each event. Send the `latestId` from the
previous answer as `after`.
```json
{
  "events": [
    { "id": 41, "kind": "raid", "title": "⚔️ Molten Core", "body": "Molten Core, Fri 20:00 UTC. Sign up in Guild Camp.",
      "route": "/raids/12", "created_at": "2026-11-07 18:05:00" }
  ],
  "latestId": 43
}
```
- No `after` → `{ "events": [], "latestId": <newest id> }`, so a freshly started app doesn't get a flood.
- `after` newer than anything on the server (database replaced) → `{ "events": [], "latestId": <newest id> }`; adopt it.
- Up to 100 events per call; if 100 come back, poll again straight away with the new `latestId`.
- `latestId` also moves past events meant for other members, so keep sending it back.
- Not in a guild yet → `{ "events": [], "latestId": 0 }`. Non-numeric `after` → `400`.

Kinds and the `notifyPrefs` switch that hides them: `cta` → `cta`, `raid` → `raids`, `notice` → `notices`,
`request` → `requests`, `bank` → `bank`, `coach` → `coach`, `drive` → `drives`. `release` always shows.
Events older than 14 days are pruned.

### Emitting events (server code)
```js
ctx.emit(guildId, 'raid', {
  title: '⚔️ Molten Core',          // required in practice; up to 120 characters
  body: 'Sign up in Guild Camp.',     // up to 300 characters
  route: '/raids/12',                 // app route, must start with "/"
  userId: 9,                          // only this member
  userIds: [9, 12],                   // only these members (one row each; [] sends nothing)
  exceptUserId: req.user.id,          // everyone but the person who caused it
  officersOnly: true,                 // only owner and officers
  recipe: 'Flask of the Titans',      // only members whose characters know this recipe (case-insensitive)
});                                   // → event id, or null. Never throws.
```
