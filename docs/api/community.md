# Community API

The Camp dashboard (who's online, calls to arms, notices, activity, the setup checklist, upcoming raids), the
roster, character pages and mains, crafters and shopping lists, crafting requests, and leveling partners.
Implemented in `server/src/routes/community.js` and `server/src/services/community.js` (ported from the old
`web/src/server.js`). The app pages are `camp.js`, `roster.js`, `character.js`, `crafters.js`, `requests.js` and
`partners.js`; preview data lives in `app/src/renderer/lib/mocks/community.js`.

Every endpoint needs a device token for a guild member (`401 "Sign in first."`, `403 "Join a guild first."`).
Conventions (field names, times, errors) are in [core.md](core.md). Times are SQLite UTC strings unless noted.

`ctx.services.community` exposes the service (`onboardingFor`, `searchRecipes`, `professionSummary`,
`whoCanCraft`, `shoppingFor`, `guildShoppingLists`, `matsNeeded`) for other domains (for example Discord `/craft`).

---

## Camp

### `GET /api/camp`
Everything the Camp page shows, in one call.
```json
{
  "guild": { "id": 1, "name": "Just Now WoW", "faction": "Horde", "realm": "Mirage Raceway" },
  "realm": { "found": true, "slug": "mirage-raceway", "name": "Mirage Raceway", "up": true, "queue": false,
             "population": "High", "checkedAt": "2026-11-07T15:28:00.000Z" },
  "rosterScannedAt": "2026-11-07T15:28:12.000Z",
  "online": [
    { "id": 1, "name": "Grimtusk", "class": "WARRIOR", "race": "Orc", "level": 60, "zone": "Orgrimmar",
      "rank": "Guild Master", "is_main": 1, "user_id": 1, "battletag": "Calvin#1234" }
  ],
  "ctas": [
    { "id": 2, "zone": "Crossroads", "needed": 5, "message": "Ganker camping the flight master", "character": "Mokra",
      "source": "app", "created_at": "2026-11-07 15:30:00", "user_id": 3, "battletag": "Mokra#9031", "class": "SHAMAN" }
  ],
  "announcements": [
    { "id": 4, "body": "Molten Core on Friday 20:00 server time.", "user_id": 1, "created_at": "2026-11-07 15:30:00",
      "battletag": "Calvin#1234", "canDelete": true }
  ],
  "activity": [ { "id": 30, "kind": "craft", "text": "Velanne is making Runecloth Bag", "created_at": "2026-11-07 15:30:00" } ],
  "raids": [
    { "id": 12, "kind": "raid", "title": "Molten Core", "instance": "Molten Core", "starts_at": "2026-11-09T18:32:00.000Z",
      "status": "open", "size": 40, "coming": 18, "maybe": 3,
      "mySignup": { "status": "yes", "role": "tank", "character": "Grimtusk" } }
  ],
  "mySync": "2026-11-07 15:28:12",
  "onboarding": {
    "steps": [
      { "key": "synced", "done": true, "label": "Install the addon, then log in to the game once", "href": "/addon" },
      { "key": "professions", "done": true, "label": "Open each profession window in game, then /reload", "href": "/crafters" },
      { "key": "main", "done": false, "label": "Pick your main character", "href": "/characters/Mokra" },
      { "key": "discord", "done": false, "label": "Link your Discord", "href": "/settings?section=discord&link=1" },
      { "key": "signup", "done": false, "label": "Sign up for Molten Core", "href": "/raids/12" }
    ],
    "done": 2, "total": 5
  },
  "me": { "main": { "name": "Mokra", "class": "SHAMAN", "level": 58, "zone": "Winterspring" },
          "lastZone": "Winterspring", "lastZoneCharacter": "Mokra" },
  "isOfficer": false
}
```
- `realm`: the guild's parsed `realm_status`, only when Blizzard found the realm; otherwise `null`.
- `online`: characters marked online by the latest roster scan, highest level first. The page treats the roster as
  stale after 30 minutes (`rosterScannedAt`).
- `ctas`: calls to arms from the last 24 hours, newest first, at most 8. `source` is `app`, `addon`, `discord` or
  `web` (old site). `class` is the signing character's class when known.
- `announcements`: the newest 5 notices. `canDelete` is true for owner and officers.
- `activity`: the newest 12 lines. Older ones: `GET /api/activity`.
- `raids`: up to 4 open or locked raids and events starting after now, soonest first, with the member's sign-up
  (`status` is `yes`, `tentative`, `no` or `bench`) or `null`. `coming`/`maybe` count `yes`/`tentative` sign-ups.
- `mySync`: when the server last received an upload from this member, or `null`.
- `onboarding` (old `onboardingFor`): `synced` = any upload; `professions` = any profession on the member's
  characters; `main` = a main is chosen (link to their highest-level character's page, or `/roster` without one);
  `discord` only when the server has a Discord app (`DISCORD_PUBLIC_KEY`), linking to
  `/settings?section=discord&link=1` (opens the Discord card and makes a link code); `signup` only when a raid is scheduled
  (for the next one). The page hides the checklist when `done === total`.
- `me.main`: the character a call to arms is signed with (main, else highest level). `me.lastZone`: the zone of the
  member's most recently seen character ("Use my last zone").

### `GET /api/activity?before=<id>&limit=<n>`
Older activity lines. `before` is the smallest id already shown (omit for the newest); `limit` 1–100, default 30.
```json
{ "activity": [ { "id": 18, "kind": "buddy", "text": "Ilyra is looking for leveling partners in The Barrens",
                  "created_at": "2026-11-06 19:00:00" } ], "more": true }
```
Kinds written by this domain: `craft` (requests), `buddy` (partners). Others come from core (`guild`, `member`)
and sync (`character`).

### `POST /api/ctas`
Sound the horn. Any member.
```json
{ "zone": "Tarren Mill", "needed": 10, "message": "Alliance raid incoming from Southshore!" }
```
`201`
```json
{ "cta": { "id": 7, "zone": "Tarren Mill", "needed": 10, "message": "Alliance raid incoming from Southshore!",
           "character": "Velanne", "source": "app", "created_at": "2026-11-07 15:40:00", "user_id": 2,
           "battletag": "Velanne#2210", "class": "PRIEST" },
  "message": "Horn sounded." }
```
- `zone` required, up to 60 characters → else `400 "Say where the fight is."`
- `needed` optional (missing or `""` → `null`), otherwise a whole number clamped to 1–40.
- `message` up to 200 characters.
- Signed with the member's main (else highest-level character, else no character: Discord shows the BattleTag name).
- Discord: `⚔️ **Call to arms: <zone>** (need <n>)\n<message>\n— <character or name>` (the "(need n)" part only
  when `needed` is set).
- Event `cta` to everyone but the caller: title `⚔️ Call to arms: <zone>`, body `Need <n>. <message> (<signer>)`,
  route `/`.

### `POST /api/announcements` (owner or officer)
```json
{ "body": "Raid sign-ups open Sunday" }
```
`201`
```json
{ "announcement": { "id": 5, "body": "Raid sign-ups open Sunday", "user_id": 2, "created_at": "2026-11-07 15:41:00",
                    "battletag": "Velanne#2210", "canDelete": true },
  "message": "Notice posted." }
```
- `body` trimmed, up to 500 characters; empty → `400 "Write the notice first."`. Members → `403 "Officers only."`
- Audit `notice posted` (first 80 characters). Discord `📜 **Notice**\n<body>`. Event `notice` to everyone but the
  poster: title `📜 Guild notice`, body = the notice, route `/`.

### `DELETE /api/announcements/:id` (owner or officer)
```json
{ "ok": true, "message": "Notice removed." }
```
- Unknown or already removed → `404 "That notice was already removed."`. Audit `notice deleted` (first 80 characters).

---

## Roster and characters

### `GET /api/roster`
Every character the guild knows (roster scans plus characters linked to players): online first, then by level,
then name.
```json
{
  "characters": [
    { "id": 1, "name": "Grimtusk", "class": "WARRIOR", "race": "Orc", "level": 60, "rank": "Guild Master",
      "zone": "Orgrimmar", "online": 1, "last_seen": "2026-11-07T15:28:12.000Z", "is_main": 1, "is_bank": 0,
      "in_official_roster": null, "user_id": 1, "updated_at": "2026-11-07T15:28:12.000Z", "battletag": "Calvin#1234" }
  ],
  "scannedAt": "2026-11-07T15:28:12.000Z",
  "officialRosterAt": null,
  "counts": { "total": 14, "online": 7, "linked": 5, "mains": 2 }
}
```
`battletag` is the linked player (`null` when nobody linked the character). Gold, readiness and extras are not on the
roster. `last_seen` from roster scans is ISO 8601.

### `GET /api/characters/:name`
Exact name first, then any capitalisation (`/api/characters/grimtusk` works).
```json
{
  "character": {
    "id": 1, "name": "Grimtusk", "class": "WARRIOR", "race": "Orc", "level": 60, "faction": "Horde",
    "rank": "Guild Master", "zone": "Orgrimmar", "online": 1, "last_seen": "2026-11-07T15:28:12.000Z",
    "is_main": 1, "is_bank": 0, "in_official_roster": null, "user_id": 1, "battletag": "Calvin#1234",
    "updated_at": "2026-11-07T15:28:12.000Z",
    "money": 4235190,
    "readiness": { "ilvl": 61.2, "durability": 88, "consumables": { "flask": 2, "potion": 14, "food": 20 }, "at": 1793978292 },
    "extras": {
      "pvp": { "rank": 8, "rankName": "Blood Guard", "honor": 18450, "hk": 2210, "weekHk": 64, "weekContribution": 5400,
               "lastWeekRank": 7, "highestRank": 8 },
      "reputations": [ { "name": "Orgrimmar", "standing": 7, "value": 9200, "max": 21000, "header": "Horde" } ],
      "currencies": [ { "id": 3001, "name": "Merchant's Favor", "qty": 12, "max": 50 } ],
      "addonVersion": "0.11.0"
    }
  },
  "professions": [ { "name": "Blacksmithing", "skill": 300, "max_skill": 300 } ],
  "recipes": [ { "profession": "Blacksmithing", "name": "Arcanite Reaper", "recipe_id": 16994 } ],
  "alts": [ { "name": "Shadowfen", "class": "WARLOCK", "level": 42, "is_main": 0, "online": 0, "zone": "Desolace" } ],
  "isMine": true,
  "canMakeMain": false
}
```
- `money` is only filled in for the character's own player (`null` for everyone else).
- `readiness` (item level, repair %, consumables in bags, `at` = Unix seconds) and `extras` (PvP, reputations with
  `standing` 1–8 = Hated…Exalted, currencies) are what the addon reported, or `null`.
- `professions` highest skill first; `recipes` by profession, then name; `alts` = the same player's other characters.
- Unknown → `404 "That character isn't on the guild roster yet."`

### `POST /api/characters/:name/main`
Makes one of your characters your main (and clears the flag on your others).
```json
{ "ok": true, "character": { "name": "Mokra", "is_main": 1 }, "message": "Mokra is now your main." }
```
- Not yours or unknown → `404 "That isn't one of your characters."`

---

## Crafters and shopping lists

### `GET /api/crafters?q=<text>`
```json
{
  "q": "potion",
  "results": [
    { "recipe": "Major Healing Potion", "recipeId": 17556, "profession": "Alchemy",
      "crafters": [ { "name": "Mokra", "class": "SHAMAN", "level": 58, "online": 1, "user_id": 3 } ] }
  ],
  "professions": [
    { "name": "Alchemy", "count": 1,
      "crafters": [ { "name": "Mokra", "class": "SHAMAN", "level": 58, "online": 1, "skill": 250, "max_skill": 300 } ] }
  ],
  "shopping": {
    "items": [ { "name": "Thorium Belt", "qty": 2, "prof": "Blacksmithing" } ],
    "updatedAt": "2026-11-07 15:28:12",
    "mats": [
      { "id": 12359, "name": "Thorium Bar", "need": 20, "price": 9500, "guildBank": 12,
        "chars": [ { "name": "Grimtusk", "n": 6 } ] },
      { "id": 7077, "name": "Heart of Fire", "need": 2, "price": null, "guildBank": 0, "chars": [] }
    ],
    "total": 190000,
    "unpriced": 1
  },
  "lists": [
    { "user_id": 2, "battletag": "Velanne#2210", "main": { "name": "Velanne", "class": "PRIEST", "level": 60 },
      "updatedAt": "2026-11-07 15:28:20", "items": [ { "name": "Runecloth Bag", "qty": 4, "prof": "Tailoring" } ],
      "mats": [ { "id": 14047, "name": "Runecloth", "need": 20, "price": 1200 } ], "total": 64800, "unpriced": 0 }
  ]
}
```
- `q` is trimmed and capped at 60 characters. `results` (only when `q` is set): recipes whose name contains `q`,
  ignoring case (`%` and `_` match literally), grouped by recipe, online crafters first; up to 300 recipe rows.
- `professions`: every profession in the guild with its crafters, highest skill first (the page shows it when not
  searching).
- `shopping`: the signed-in member's list from the addon's profession helper (`null` when empty). `need` = reagent
  quantity × crafts. `chars` = where the member has the mat (bags + bank per character). `guildBank` = guild bank
  plus bank characters. `price` = newest guild price index entry in the last 30 days (copper) or `null`.
  `total` = sum of `price × need` over priced mats; `unpriced` = mats without a price.
- `lists`: the other guild members' shopping lists (newest first) with the same totals; `main` is their main or
  highest-level character.

---

## Crafting requests

### `GET /api/requests`
Open and claimed requests, plus delivered ones from the last 7 days, newest first. Cancelled requests are left out.
```json
{
  "requests": [
    { "id": 13, "item": "Flask of the Titans", "notes": "For MC on Friday.", "status": "open",
      "requester_id": 2, "requester": "Velanne#2210", "crafter_id": null, "crafter": null,
      "created_at": "2026-11-07 15:30:00", "updated_at": "2026-11-07 15:30:00",
      "crafters": [ { "name": "Mokra", "class": "SHAMAN", "online": 1 } ],
      "mine": false, "i_can_craft": false, "canClaim": true, "canDone": false, "canCancel": false }
  ],
  "counts": { "open": 3, "claimed": 1, "done": 1 }
}
```
- `crafters` (open requests only): characters that know the recipe (exact name, any capitalisation).
- `i_can_craft`: one of the signed-in member's characters knows it.
- `canClaim` / `canDone` / `canCancel`: what the signed-in member may do (the rules below).

### `POST /api/requests`
```json
{ "item": "Copper Chain Vest", "notes": "mats in mail" }
```
`201`
```json
{ "request": { "id": 15, "item": "Copper Chain Vest", "status": "open", "...": "same shape as the list" },
  "message": "Request posted. Crafters who know it have been told." }
```
- `item` trimmed, up to 100 characters → else `400 "Name the item you need."`; `notes` up to 200.
- Activity `craft`: `<name> asked for <item>`. Discord: `🔨 **Crafting request:** <item> (<notes>), for <name>`.
- Event `request` with `recipe = item` (only members whose characters know it, not the requester): title
  `🔨 <name> needs <item>`, body `You can craft it. <notes>`, route `/requests`. Sent only when such a crafter exists
  (the message then says so; otherwise `"Request posted."`).

### `POST /api/requests/:id/claim` · `/done` · `/cancel`
```json
{ "ok": true, "request": { "id": 15, "status": "claimed", "crafter": "Smithy#5555", "...": "list shape" },
  "message": "You're making Copper Chain Vest. Member can see that." }
```
| Verb | Allowed when | Effect |
|---|---|---|
| `claim` | open, and not your own request | claimed by you; activity `<name> is making <item>`; event `request` to the requester: `🔨 <name> is making <item>` |
| `done` | claimed, and you are the crafter or the requester | delivered; activity `<item> delivered`; event `request` to the requester (`📦 <item> delivered`) unless the requester did it |
| `cancel` | your own request, open or claimed | cancelled (leaves the board) |

- Anything else → `409 "That request has already moved on."`. Unknown id → `404 "That request no longer exists."`.
  Unknown verb → `404`.

---

## Leveling partners (old "buddies")

### `GET /api/partners`
Active posts from the last 3 days, newest first, and the member's characters for the form.
```json
{
  "posts": [
    { "id": 6, "user_id": 5, "character": "Ilyra", "zone": "The Barrens", "when_text": "Tonight after 19:00",
      "note": "Doing the Wailing Caverns quests, need a tank.", "created_at": "2026-11-07 14:41:00",
      "level": 19, "class": "MAGE", "battletag": "Ilyra#7777", "mine": false }
  ],
  "myCharacters": [ { "name": "Grimtusk", "class": "WARRIOR", "level": 60, "zone": "Orgrimmar", "is_main": 1 } ]
}
```
`level`/`class` come from the character when the guild knows it (the level stored with the post otherwise).

### `POST /api/partners`
```json
{ "character": "Zuljinne", "zone": "Stonetalon Mountains", "when_text": "Tonight 8pm", "note": "Venture Co. chain" }
```
`201`
```json
{ "post": { "id": 7, "character": "Zuljinne", "level": 18, "class": "HUNTER", "mine": true, "...": "list shape" },
  "message": "Posted. Guildies can see it for 3 days." }
```
- `character` trimmed, up to 40 → else `400 "Pick the character you are leveling."`. `zone` and `when_text` (alias
  `when`) up to 60, `note` up to 140.
- A new post for the same character (by the same member) replaces the old one.
- Activity `buddy`: `<character> is looking for leveling partners in <zone>` (" in <zone>" only with a zone).

### `POST /api/partners/:id/close`
```json
{ "ok": true, "message": "Post removed." }
```
- Unknown → `404 "That post no longer exists."`; someone else's → `403 "You can only remove your own posts."`

---

## Changes from the old site
- JSON instead of redirects: rule violations that used to redirect with a message now return `409`/`400`/`404`.
- Notices can be removed by officers (`DELETE /api/announcements/:id`, audited). The old site had no delete.
- Calls to arms from the app are stored with `source = 'app'`; `needed` is optional (the old form always sent 1–40).
- Crafting request notifications use the event `recipe` filter, so only members whose characters know the recipe see
  them; claiming and delivering now also notify the requester.
- Crafters shows the other members' shopping lists with totals (the old page showed only your own), and the guild
  bank column includes bank characters (as the addon tooltips already did).
- Activity has its own paged endpoint for "Show more".
