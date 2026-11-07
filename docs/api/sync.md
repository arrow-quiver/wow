# Sync API

The desktop app uploads what the addon saved (`WowGuildDB`), and fetches the guild news the addon shows in
game. Implemented in `server/src/routes/sync.js`, `services/sync.js` (`applyPayload`, `buildInbox`,
`freshOnly`), `services/economy.js` (bags, bank, guild bank, prices) and `services/membership.js` (joining
during an upload, officer roles from roster ranks). The app side is
`app/src/main/sync.js`. General conventions (errors, auth, times) are in [core.md](core.md).

| Call | What for |
|---|---|
| `POST /api/sync` | Upload `WowGuildDB` (plus Auctionator prices). |
| `GET /api/inbox` | The guild news as JSON. The app writes it to `Interface/AddOns/WowGuild_Inbox/Inbox.lua`. |
| `GET /api/inbox.lua` | The same news as Lua source. Only old companions use it; they save it unchanged. |

## Auth

- `Authorization: Bearer gcd_…` (device token) of a **guild member** (for `POST /api/sync`, also a signed-in
  member who isn't in the guild yet: see "Uploading before you are in the guild"), or
- `Authorization: Bearer wowg_…`, an old companion sync key. These three paths are the only ones that accept
  sync keys, and only while the key's owner is still in the key's guild (see core.md).

| Status | When | `error` |
|---|---|---|
| 401 | No token | `"Sign in first."` |
| 401 | Signed-out device | `"This device was signed out. Sign in again in Guild Camp."` |
| 401 | Unknown sync key, or its owner left the guild | `"That sync key no longer works. Install the Guild Camp app and sign in with Battle.net."` |
| 403 | Signed in, not in a guild yet (`GET /api/inbox`, `GET /api/inbox.lua`) | `"Join a guild first."` |
| 409 | Signed in, not in a guild yet, and the upload's characters don't match the guild roster (`POST /api/sync`, see below) | the auto-join `reason` |
| 429 | More than 40 uploads a minute from one token (has `Retry-After`) | `"Too many uploads. Guild Camp will retry shortly."` |

---

## `POST /api/sync`

Headers: `Content-Type: application/json`, `X-App-Version: 0.11.0` (the app's version; recorded on the device and
the member by the auth middleware). Old companions send `X-Companion-Version` instead. Body up to 15 MB.

### Body: `WowGuildDB` as the addon saves it

Every part is optional; missing parts leave what the server has alone. Lua tables arrive as arrays or
as objects with numeric keys (`{"1": …, "2": …}`); both are read as lists. Strings are cut to the lengths shown.

```json
{
  "addonVersion": "0.11.0",
  "characters": {
    "Thrallia": {
      "name": "Thrallia", "realm": "Forever", "guild": "wow", "class": "SHAMAN", "race": "Orc", "level": 23,
      "faction": "Horde", "zone": "The Barrens", "money": 123456, "updated": 1794065026,
      "professions": [{ "name": "Blacksmithing", "skill": 120, "max": 150 }],
      "recipes": { "Blacksmithing": [{ "id": 102, "name": "Copper Chain Vest" }] },
      "inventory": { "bags": [{ "id": 2589, "name": "Linen Cloth", "count": 2 }], "bank": [{ "id": 14047, "name": "Runecloth", "count": 35 }] },
      "readiness": { "ilvl": 58.2, "durability": 50, "consumables": { "potion": 5, "bandage": 10 }, "at": 1794065026 },
      "pvp": { "rank": 2, "rankName": "Scout", "hk": 120, "honor": 5400 },
      "reputations": [{ "name": "Durotar Supply and Logistics", "header": "Horde", "standing": 5, "value": 1500, "max": 6000 }],
      "currencies": [{ "id": 3001, "name": "Merchant's Favor", "qty": 12 }]
    }
  },
  "roster": { "scannedAt": 1794065026, "guild": "wow",
              "members": [{ "name": "Grommash Hellscream", "rank": "Officer", "rankIndex": 1, "level": 31, "class": "WARRIOR", "zone": "Hillsbrad Foothills", "online": true }] },
  "guildBank": { "scannedAt": 1794065026, "guild": "wow", "money": 1234567,
                 "tabs": [{ "name": "Mats", "items": [{ "id": 14047, "name": "Runecloth", "count": 30 }] }],
                 "log": [{ "kind": "deposit", "who": "Grommash", "id": 14047, "name": "Runecloth", "count": 10, "at": 1794054226 },
                         { "kind": "withdraw", "who": "Thrallia", "amount": 50000, "at": 1794061426 }] },
  "ctaQueue": [{ "zone": "Crossroads", "needed": 8, "msg": "Alliance at the flight master", "character": "Thrallia", "at": 1794065026 }],
  "reagentIds": [2589, 2840],
  "shopping": [{ "name": "Linen Belt", "qty": 6, "prof": "Tailoring", "reagents": [{ "id": 2589, "name": "Linen Cloth", "qty": 1 }] }],
  "coach": {
    "chars": { "Thrallia": { "name": "Thrallia", "class": "SHAMAN", "level": 23, "realm": "Forever", "profile": {}, "stats": {},
                             "quiz": {}, "talents": {}, "gear": {}, "planRequest": 1794065026 } },
    "questions": [{ "id": "1794065026-1216", "char": "Thrallia", "text": "Enhancement or Elemental for world PvP?", "at": 1794065026 }]
  },
  "prices": { "items": [[2589, 120, 2502]] }
}
```

`prices` is added by the app from Auctionator's SavedVariables (`[itemId, copper, auctionatorDay]`, days counted
from 1 Jan 2020), and only when that file changed since the last successful upload.

### What the server does with it

All of it is written in one transaction.

| Part | Rule |
|---|---|
| `characters` | Upserted by name and linked to the uploader. A character another member already owns is **never** changed. Name ≤ 40, class ≤ 20, race ≤ 30, faction ≤ 10, zone ≤ 60. `professions` replace the character's list when sent; `recipes` replace that profession's recipes when sent (≤ 2000 each). `readiness` (item level, repair %, consumables) feeds raid sign-ups. `pvp` (≤ 10 numbers + `rankName`), `reputations` (≤ 120), `currencies` (≤ 100) and the character's `addonVersion` are kept as `extras` for the character page. A new character adds the activity line "`<name>` linked their character". |
| realm | The first upload with a character that has both `realm` and `guild` sets the guild's `realm` and `game_guild` (never changed by later uploads; officers can edit them in guild settings). |
| `inventory` | `bags` and `bank` replace that location for the uploader's own characters (≤ 2000 each). The bank only updates when it was sent (the player opened it). Item names are remembered for search and tooltips. |
| `guildBank` | Replaces the guild bank and its money, unless the server already has a newer scan (≤ 20 tabs × 200 items). Log lines (≤ 500) are added once: the game only says "3 hours ago", so repeats are matched in 6-hour windows. |
| `prices` | One price per item per day (≤ 100 000 rows); the cheapest seen that day wins. |
| `roster` | When newer than the last scan: every character's `online` is reset, then each member (≤ 1000) gets rank, zone, online and level. Roster rows never claim a character for anyone. When the uploader is the **owner or an officer**, each member's `rankIndex` (in-game rank index from `GetGuildRosterInfo`, 0 = Guild Master; whole numbers 0–20) is saved as `characters.rank_index` (a member without one keeps the old value), and after the upload the rank mapping runs: members who follow in-game ranks become officers or members (core.md, "Officers from in-game ranks"). Uploads from other members update rank names but never `rank_index` or roles. |
| `ctaQueue` | Calls to arms from `/wow cta` (≤ 20 per upload; zone ≤ 60, message ≤ 200). Each is stored once per `at` + character, so re-uploading the same file adds nothing. Each **new** one is posted to the guild's Discord webhook and sent as a `cta` notification to everyone except the uploader (see below). |
| `reagentIds` | Replaces the uploader's "wanted" items (≤ 2000), which the inbox prices. |
| `shopping` | Replaces the uploader's shopping list (≤ 50 entries, ≤ 12 reagents each); its reagents count as wanted too. An empty list clears it; leaving the key out keeps it. |
| `coach` | Play style, talents and gear per character (≤ 50; a character another member coaches is left alone) and questions asked in game (≤ 10 per upload, ≤ 500 characters, stored once per question id). |
| `addonVersion` | Saved on the member and on the device (shown in Officer tools and Settings → Devices). |

**Fresh start.** After an officer's fresh start (`guilds.reset_at`), data from before it is ignored: characters
whose `updated` is older, a roster or guild bank scanned before it, prices from earlier days and calls to arms
queued before it. Once the guild's realm is known, characters from another realm are ignored, and so are the
roster, guild bank and prices of an upload that has no character on that realm. A roster or guild bank from a
different in-game guild (`guild` ≠ `game_guild`) is ignored too.

Every accepted upload adds a `sync_log` row (guild, member, bytes from `Content-Length`) and sets the member's
`last_sync_at`. Old companions also get `companion_version` set from `X-Companion-Version`.

### Call to arms: Discord and notification

```
⚔️ **Call to arms: Crossroads** (need 8)
Alliance at the flight master
— Thrallia (from in game)
```
(The `(need N)` part and the message line are left out when empty.) Notification:

| `kind` | `title` | `body` | `route` |
|---|---|---|---|
| `cta` | `⚔️ Call to arms: Crossroads` | `Need 8. Alliance at the flight master (Thrallia)` | `/` |

### Coach

`coachPending` counts this member's questions still waiting for an answer, plus build plans wanted (only
when the server has a Claude key). When the upload brought a new question, or something is pending and the
server has a key, the route calls `ctx.services.coach.kick()` (routes/coach.js) so the answers start right away.
The app then checks `GET /api/inbox` every 6 s (up to 2 minutes) until `coach.pending` is 0, and saves the news
again.

### Response

```json
{
  "ok": true,
  "characters": 1,
  "roster": 3,
  "recipes": 2,
  "ctas": 1,
  "inventory": 4,
  "bank": 3,
  "prices": 1,
  "coachPending": 0,
  "latest": {
    "app": { "version": "0.11.1", "notes": "Fixes.", "publishedAt": "2026-11-06 18:00:00", "file": "Guild-Camp-Setup-0.11.1.exe",
             "url": "/updates/app/Guild-Camp-Setup-0.11.1.exe", "size": 92405112 },
    "addon": { "version": "0.11.1", "notes": null, "publishedAt": null, "sha256": "…", "size": 148220,
               "url": "/updates/addon/WowGuild-0.11.1.zip", "source": "bundled" }
  }
}
```
The counts are what this upload changed: characters saved (not someone else's), roster members, recipes,
**new** calls to arms, inventory rows, guild bank rows, price rows. `latest` is `ctx.latest()` (see
[releases.md](releases.md)); either side can be `null`.

### Uploading before you are in the guild

A signed-in member who isn't in a guild yet may upload too (device tokens only; old sync keys always belong to a
guild). The server first runs the auto join (`tryAutoJoin`, core.md "Joining by itself") with the upload's
`characters` map as the reported characters (`name`, `realm`, `guild`, `faction`, `level`, `class`, `updated`).

- **It joins**: the upload is stored as usual and the response adds who joined and how:
  ```json
  { "ok": true, "characters": 1, "...": "as above",
    "joined": { "guild": { "id": 1, "name": "Just Now WoW", "faction": "Horde" }, "role": "member", "via": "roster", "character": "Thrallia" } }
  ```
  The app then refreshes the signed-in state. Later uploads have no `joined`.
- **No match** (or no guild on the server, or `auto_join` off): nothing is stored (no characters, no sync log) and
  the answer is
  ```json
  { "error": "None of your characters are in Just Now WoW's roster yet. Ask someone in the guild to open the guild roster in game, or use an invite link.",
    "code": "NO_GUILD_MATCH",
    "autoJoin": { "status": "no-match", "guild": { "id": 1, "name": "Just Now WoW", "faction": "Horde" }, "role": null,
                  "via": null, "character": null, "reason": "None of your characters are in …", "detected": null } }
  ```
  with status `409`. This is not an error to retry quickly: the app shows the reason and tries again on the
  next SavedVariables change or after a minute.
- A body that isn't a JSON object is still `400`.

| Status | When | `error` |
|---|---|---|
| 400 | The body isn't a JSON object (an array, for example) | `"The upload must be a JSON object with the addon's data."` |
| 400 | Broken JSON | `"That request was not valid JSON."` |
| 413 | Over 15 MB | `"That upload is too large."` |

Odd values inside the object (a character without a name, a price row without a day, a roster entry that
isn't a table) are skipped, not refused.

---

## `GET /api/inbox`

The news for the addon, for the member making the call. `Cache-Control: no-store`.

```json
{
  "guild": "wow",
  "generatedAt": 1794065299,
  "site": "https://wow.cjplumbing.co.za",
  "latestAddon": "0.11.1",
  "announcements": [{ "body": "Raid sign-ups Sunday", "at": "2026-11-07 18:00:00", "by": "Thrall#1234" }],
  "canCraft": [{ "id": 4, "item": "Copper Chain Vest", "notes": "mats in mail", "requester": "Grom#2222" }],
  "myRequests": [{ "item": "Linen Belt", "status": "claimed", "crafter": "Jaina#3333" }],
  "buddies": [{ "character": "Grom", "level": 22, "zone": "The Barrens", "whenText": "evenings", "note": "questing" }],
  "raids": [{ "id": 12, "title": "Molten Core", "instance": "Molten Core", "status": "open", "startsAt": 1794600000,
              "signup": "yes", "role": "healer", "character": "Thrallia", "coming": 14,
              "reserves": [{ "name": "Night Cloak", "bonus": 20 }] }],
  "prices": [{ "id": 2589, "price": 120 }],
  "stock": [{ "id": 2589, "chars": [{ "name": "Altie", "count": 7 }, { "name": "Thrallia", "count": 2 }], "guildBank": 20 }],
  "holdings": [{ "id": 2589, "chars": [{ "name": "Altie", "count": 7 }], "guildBank": 20 }],
  "crafters": [{ "name": "Linen Belt", "who": "Altie,Zuljinne" }],
  "coach": {
    "enabled": true,
    "pending": 0,
    "plans": { "Thrallia": { "headline": "Enhancement for world PvP", "spec": "Enhancement", "...": "the plan, without its sources" } },
    "answers": [{ "qid": "1794065026-1216", "char": "Thrallia", "q": "Enhancement or Elemental for world PvP?",
                  "a": "Enhancement: Stormstrike burst wins world fights.", "status": "answered", "at": 1794065100 }]
  }
}
```

| Field | Contents |
|---|---|
| `generatedAt` | Unix seconds. The addon uses it to tell "sent" questions from "unsent" ones and to show how fresh the news is. |
| `site` | The server's `BASE_URL`. |
| `latestAddon` | Version of the newest addon release (`ctx.latest().addon.version`; the bundled addon until one is published), or `null`. When it is newer than the installed addon, the addon tells the player to update from the Guild Camp app. |
| `announcements` | The newest 5. `at` is SQLite UTC; `by` is a BattleTag. |
| `canCraft` | Up to 20 open requests from other members for an item one of **your** characters has the recipe for (names match case-insensitively). |
| `myRequests` | Up to 10 of your open or claimed requests, newest first. `crafter` is a BattleTag or `null`. |
| `buddies` | Up to 10 active leveling-partner posts from other members. |
| `raids` | Up to 5 open or locked events starting no earlier than 3 hours ago, soonest first. `startsAt` is Unix seconds. `signup`, `role` and `character` are yours (`null` when you haven't signed up); `coming` counts "yes" sign-ups; `reserves` are your soft reserves with their SR+ bonus. |
| `prices` | Guild prices (copper, newest scan in the last 30 days) for your wanted reagents and shopping-list mats, then for items in `holdings`. |
| `stock` | For each reagent on your shopping list: how many each of your characters holds, and how many the guild bank (plus bank characters) holds. |
| `holdings` | For item tooltips: what each of your characters holds, and what the guild bank holds (≤ 2500 items). |
| `crafters` | Every recipe in the guild with the characters that know it, comma-separated (≤ 4000). |
| `coach` | `plans` for your characters, your last 10 questions with answers (plain text for the game: no markdown, ASCII punctuation; `a` is the error message when an answer failed), `pending` as in the sync reply, and whether officers have the Coach `enabled`. |

The app writes this object as `WowGuildInbox = {…}` (shared `luaAssignment`). Lua can't hold `null`, so
those fields simply end up missing in game; empty lists become `{}`.

## `GET /api/inbox.lua`

The same object as Lua source, `text/plain; charset=utf-8`, `Cache-Control: no-store`:

```lua
-- Written by Guild Camp. Do not edit.
WowGuildInbox = {
  guild = "wow",
  ...
  latestAddon = nil,
  site = "https://wow.cjplumbing.co.za",
}
```
Old companions save it as the news file unchanged. The app uses `GET /api/inbox` instead.
