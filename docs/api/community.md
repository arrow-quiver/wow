# Community API

The Camp dashboard (who's online, calls to arms, notices, activity, the setup checklist, upcoming raids), the
roster, character pages and mains, crafters and shopping lists, crafting requests, and leveling partners.
Implemented in `app/src/core/routes/community.js` and `app/src/core/services/community.js` (ported from the old
site). The app pages are `camp.js`, `roster.js`, `character.js`, `crafters.js`, `requests.js` and `partners.js`;
preview data lives in `app/src/renderer/lib/mocks/community.js`.

Every route needs the guild to be known (`403 NO_GUILD` before the first upload with a guild). Conventions
(roles, errors, times) are in [core.md](core.md). Times are SQLite UTC strings unless noted.

**Shared through the addon** ([SHARING.md](../SHARING.md), [share.md](share.md)): calls to arms (`ca`), notices
(`AN`), crafting requests (`cr`) and claims (`cl`), and leveling-partner posts (`lp`). A change here queues the
record and the rows change at once; it reaches the guild at the next login or `/reload`. Guildmates are told by
their own apps, and the Discord post goes out when the game confirms the change. Rows from guildmates appear when
their records arrive in an upload. Rows made before sharing (no record) can be read but not changed (`409 "This
was made with an older Guild Camp and can’t be changed. Make it again."`).

`ctx.services.community` exposes the service (`onboardingFor`, `searchRecipes`, `professionSummary`,
`whoCanCraft`, `shoppingFor`, `guildShoppingLists`, `matsNeeded`) for other domains.

---

## Camp

### `GET /api/camp` (guild)
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
      "source": "addon", "created_at": "2026-11-07 15:30:00", "user_id": 3, "battletag": "Mokra", "class": "SHAMAN" }
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
      { "key": "signup", "done": false, "label": "Sign up for Molten Core", "href": "/raids/12" }
    ],
    "done": 2, "total": 4
  },
  "me": { "main": { "name": "Mokra", "class": "SHAMAN", "level": 58, "zone": "Winterspring" },
          "lastZone": "Winterspring", "lastZoneCharacter": "Mokra" },
  "isOfficer": false
}
```
- `realm`: the guild's parsed `realm_status`, only when Blizzard found the realm; otherwise `null`.
- `online`: characters marked online by the latest roster scan, highest level first. The page treats the roster as
  stale after 30 minutes (`rosterScannedAt`). `battletag` is the linked player's name (`null` when the character
  isn't linked to anyone).
- `ctas`: calls to arms from the last 24 hours, newest first, at most 8. `source` is `app` (made in this app and
  still on its way, or sent from here) or `addon` (from the game: mine with `/wow cta`, or a guildmate's).
  `discord` and `web` only appear on rows from the old site. `class` is the signing character's class when known.
- `announcements`: the newest 5 notices. `canDelete` is true for the Guild Master and officers.
- `activity`: the newest 12 lines. Older ones: `GET /api/activity`. Activity is local to this computer.
- `raids`: up to 4 open or locked raids and events starting after now, soonest first, with my sign-up (`status` is
  `yes`, `tentative`, `no` or `bench`) or `null`. `coming`/`maybe` count `yes`/`tentative` sign-ups.
- `mySync`: when this computer last received an upload, or `null`.
- `onboarding`: `synced` = any upload; `professions` = any profession on my characters; `main` = a main is chosen
  (links to my highest-level character's page, or `/roster` without one); `signup` only when a raid is scheduled
  (for the next one). The page hides the checklist when `done === total`.
- `me.main`: the character a call to arms is signed with (main, else highest level; one known to be in the guild
  before one uploaded with no guild). `me.lastZone`: the zone of my most recently seen character ("Use my last
  zone"). My characters that an upload put in another in-game guild count nowhere on this page (SHARING.md §3).

### `GET /api/activity?before=<id>&limit=<n>` (guild)
Older activity lines. `before` is the smallest id already shown (omit for the newest); `limit` 1–100, default 30.
```json
{ "activity": [ { "id": 18, "kind": "buddy", "text": "Ilyra is looking for leveling partners in The Barrens",
                  "created_at": "2026-11-06 19:00:00" } ], "more": true }
```
Kinds written by this domain: `craft` (requests), `buddy` (partners). Others come from raids (`raid`, `loot`),
economy (`bank`, `drive`), sync (`character`) and the guild being set up (`guild`).

### `POST /api/ctas` (guild)
Sound the horn. Queues a `ca` record. It goes out at my next login or `/reload`; `/wow cta` in game sends one at
once.
```json
{ "zone": "Tarren Mill", "needed": 10, "message": "Alliance raid incoming from Southshore!" }
```
`201`
```json
{ "cta": { "id": 7, "zone": "Tarren Mill", "needed": 10, "message": "Alliance raid incoming from Southshore!",
           "character": "Velanne", "source": "app", "created_at": "2026-11-07 15:40:00", "user_id": 1,
           "battletag": "Velanne#2210", "class": "PRIEST" },
  "message": "Call to arms posted." }
```
- `zone` required, up to 60 characters → else `400 "Say where the fight is."`
- `needed` optional (missing or `""` → `null`), otherwise a whole number clamped to 1–40.
- `message` up to 200 characters.
- Signed with my main (else my highest-level character).
- **Discord at once**: `📣 **Call to arms** from **<character>**: **<zone>**, <n> needed. "<message>"`
  (services/ctaDiscord.js). The same call (character, zone and message) is posted once within 15 minutes, however
  it arrives; when the game later confirms the record, nothing is posted again.
- Guildmates' apps notify (`cta`, `⚔️ Call to arms: <zone>`, body `Need <n>. <message> (<character>)`, route `/`)
  while it is under an hour old; guildmates online in game get a chat line and a sound.

### `POST /api/ctas/discord` (guild)
From the app itself: a call to arms of mine that the app read from the game's chat log (`main/live.js`
`createChatWatch`). In game, `/wow cta` (and the war alerts' "Call the guild") also says the call in **guild chat**
as `[Guild Camp] Call to arms: <zone> (<n> needed): <message> — from <character>` (addon option `ctaChat`); while
chat logging is on (`/wow live on` turns it on with combat logging) the app sees that line within seconds and posts
it to Discord. `{ character, zone, needed?, message? }` → `{ posted }` (false: no webhook, or already posted).
A call made in game while chat logging is off reaches Discord when the next upload brings it (checked every
minute, for calls under 15 minutes old).

### `POST /api/announcements` (officer)
Queues an `AN` record (it waits for an officer character in game).
```json
{ "body": "Raid sign-ups open Sunday" }
```
`201`
```json
{ "announcement": { "id": 5, "body": "Raid sign-ups open Sunday", "user_id": 1, "created_at": "2026-11-07 15:41:00",
                    "battletag": "Velanne#2210", "canDelete": true },
  "message": "Notice posted." }
```
- `body` trimmed, up to 500 characters; empty → `400 "Write the notice first."`. Members → `403`.
- Audit `notice posted` (first 80 characters). Discord `📜 **Notice**\n<body>` when the game confirms it.
  Guildmates' apps notify (`notice`, `📜 Guild notice`, route `/`).

### `DELETE /api/announcements/:id` (officer)
Any officer may delete any notice: its tombstone goes to the guild. A notice from before sharing was only ever on
this computer, so it is just deleted.
```json
{ "ok": true, "message": "Notice removed." }
```
- Unknown or already removed → `404 "That notice was already removed."`. Audit `notice deleted` (first 80 characters).

---

## Roster and characters

### `GET /api/roster` (guild)
Every character the guild knows (my roster scans, my own characters, and guildmates' shared character records):
online first, then by level, then name.
```json
{
  "characters": [
    { "id": 1, "name": "Grimtusk", "class": "WARRIOR", "race": "Orc", "level": 60, "rank": "Guild Master", "rank_index": 0,
      "zone": "Orgrimmar", "online": 1, "last_seen": "2026-11-07T15:28:12.000Z", "is_main": 1, "is_bank": 0,
      "in_official_roster": null, "user_id": 1, "updated_at": "2026-11-07T15:28:12.000Z", "battletag": "Calvin#1234" }
  ],
  "scannedAt": "2026-11-07T15:28:12.000Z",
  "officialRosterAt": null,
  "counts": { "total": 14, "online": 7, "linked": 5, "mains": 2 }
}
```
- `battletag` is the linked player's name (`null` when the character isn't linked to anyone). A guildmate's
  character is linked once their shared records link it to their player (SHARING.md §3).
- My characters that an upload put in another in-game guild are not listed or counted (SHARING.md §3). One
  uploaded with no guild is still listed.
- `rank_index` is the in-game rank (0 = Guild Master; `null` until a roster scan saw it); the role it gives
  depends on the guild's `officer_rank_max`.
- Gold, readiness and extras are not on the roster. `last_seen` from roster scans is ISO 8601.

### `GET /api/characters/:name` (guild)
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
- `money` is only filled in for my own characters (`null` for everyone else).
- `readiness` (item level, repair %, consumables in bags, `at` = Unix seconds) and `extras` (PvP, reputations with
  `standing` 1–8 = Hated…Exalted, currencies) are what the addon reported, or `null`. Guildmates' characters get
  class, race, level, item level, repair, consumables, professions and PvP from their shared `ch` records, and
  recipes from their `rc` records (a recipe whose name isn't known yet shows as `Recipe <id>`).
- `professions` highest skill first; `recipes` by profession, then name; `alts` = the same player's other characters
  (not my characters of another in-game guild).
- Unknown → `404 "That character isn't on the guild roster yet."`

### `POST /api/characters/:name/main` (guild)
Makes one of my characters my main (and clears the flag on my others). The addon learns it from the inbox (`me`)
and puts it on my shared character records, so guildmates see it after my next login or `/reload`.
```json
{ "ok": true, "character": { "name": "Mokra", "is_main": 1 }, "message": "Mokra is now your main." }
```
- Not mine or unknown → `404 "That isn't one of your characters."`
- Until Battle.net gives Guild Camp my BattleTag, I go by my main's name.

---

## Crafters and shopping lists

### `GET /api/crafters?q=<text>` (guild)
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
    { "user_id": 2, "battletag": "Velanne", "main": { "name": "Velanne", "class": "PRIEST", "level": 60 },
      "updatedAt": "2026-11-07 15:28:20", "items": [ { "name": "Runecloth Bag", "qty": 4, "prof": "Tailoring" } ],
      "mats": [ { "id": 14047, "name": "Runecloth", "need": 20, "price": 1200 } ], "total": 64800, "unpriced": 0 }
  ]
}
```
- `q` is trimmed and capped at 60 characters. `results` (only when `q` is set): recipes whose name contains `q`,
  ignoring case (`%` and `_` match literally), grouped by recipe, online crafters first; up to 300 recipe rows.
- `professions`: every profession in the guild with its crafters, highest skill first.
- `shopping`: my list from the addon's profession helper (`null` when empty). `need` = reagent quantity × crafts.
  `chars` = where I have the mat (bags + bank per character). `guildBank` = guild bank plus bank characters.
  `price` = newest guild price in the last 30 days (copper) or `null`. `total` = sum of `price × need` over priced
  mats; `unpriced` = mats without a price.
- `lists`: guildmates' shopping lists (from their shared `sh` records, newest first) with the same totals; `main`
  is their main or highest-level character.

---

## Crafting requests

A request is a `cr` record (keyed by a random key, carrying the requester's player id); each crafter's claim is a
`cl` record keyed `<request>:<crafter's player id>`. The state is worked out the same way on every computer
(SHARING.md §4.4): cancelled if the request says so; done if the request or the active claimer says so; otherwise
claimed by the active claim with the earliest claim time; otherwise open. A claim by the requester is ignored.

### `GET /api/requests` (guild)
Open and claimed requests, plus delivered ones from the last 7 days, newest first. Cancelled requests are left out.
```json
{
  "requests": [
    { "id": 13, "item": "Flask of the Titans", "notes": "For MC on Friday.", "status": "open",
      "requester_id": 2, "requester": "Velanne", "crafter_id": null, "crafter": null,
      "created_at": "2026-11-07 15:30:00", "updated_at": "2026-11-07 15:30:00",
      "crafters": [ { "name": "Mokra", "class": "SHAMAN", "online": 1 } ],
      "mine": false, "i_can_craft": false, "canClaim": true, "canDone": false, "canCancel": false, "canWithdraw": false }
  ],
  "counts": { "open": 3, "claimed": 1, "done": 1 }
}
```
- `crafters` (open requests only): characters that know the recipe (exact name, any capitalisation).
- `i_can_craft`: one of my characters knows it.
- `canClaim` / `canDone` / `canCancel` / `canWithdraw`: what I may do (the rules below). The Requests page shows a
  control for each: "I can't make it" (with a confirm, "Give this request back?") is `withdraw`.

### `POST /api/requests` (guild)
Queues a `cr` record for my player.
```json
{ "item": "Copper Chain Vest", "notes": "mats in mail" }
```
`201`
```json
{ "request": { "id": 15, "item": "Copper Chain Vest", "status": "open", "...": "same shape as the list" },
  "message": "Request posted." }
```
- `item` trimmed, up to 100 characters → else `400 "Name the item you need."`; `notes` up to 200.
- Activity `craft`: `<name> asked for <item>`. Discord when the game confirms it:
  `🔨 **Crafting request:** <item> (<notes>), for <character>`.
- Guildmates whose characters know the recipe are notified by their own apps (`request`, `🔨 <character> needs
  <item>`, body `You can craft it. <notes>`, route `/requests`).

### `POST /api/requests/:id/claim` · `/done` · `/cancel` · `/withdraw` (guild)
```json
{ "ok": true, "request": { "id": 15, "status": "claimed", "crafter": "Calvin#1234", "...": "list shape" },
  "message": "You're making Copper Chain Vest." }
```
| Verb | Allowed when | Record | Message |
|---|---|---|---|
| `claim` | open, and not my own request | my claim `cl` `c` | `You're making <item>.` (activity `<name> is making <item>`) |
| `done` | claimed, and I am the crafter or the requester | crafter: my claim `cl` `d` (keeps the claim time); requester: the request `cr` `d` (final) | `Marked as delivered.` (activity `<item> delivered`) |
| `cancel` | my own request, open or claimed | the request `cr` `x` (final) | `Request cancelled.` |
| `withdraw` | claimed by me | my claim `cl` `w` | `You're no longer making <item>.` |

- The requester's app is notified when a guildmate claims (`🔨 <character> is making <item>`) or delivers
  (`📦 <item> delivered`) their request.
- Anything else → `409 "That request has already moved on."`; a claim on a request made by my own player id →
  `409 "You can’t claim your own request."`. Unknown id → `404 "That request no longer exists."`. Unknown verb →
  `404`.

---

## Leveling partners

### `GET /api/partners` (guild)
Active posts from the last 3 days, newest first, and my characters for the form.
```json
{
  "posts": [
    { "id": 6, "user_id": 5, "character": "Ilyra", "zone": "The Barrens", "when_text": "Tonight after 19:00",
      "note": "Doing the Wailing Caverns quests, need a tank.", "created_at": "2026-11-07 14:41:00",
      "level": 19, "class": "MAGE", "battletag": "Ilyra", "mine": false }
  ],
  "myCharacters": [ { "name": "Grimtusk", "class": "WARRIOR", "level": 60, "zone": "Orgrimmar", "is_main": 1 } ]
}
```
`level`/`class` come from the character when the guild knows it (the level stored with the post otherwise).
`created_at` is the time of the post's newest version, so posting again shows it for another 3 days.

### `POST /api/partners` (guild)
Queues an `lp` record keyed `<my player id>:<character>`: one live post per character, so a new post for the same
character replaces the old one.
```json
{ "character": "Zuljinne", "zone": "Stonetalon Mountains", "when_text": "Tonight 8pm", "note": "Venture Co. chain" }
```
`201`
```json
{ "post": { "id": 7, "character": "Zuljinne", "level": 18, "class": "HUNTER", "mine": true, "...": "list shape" },
  "message": "Posted. It stays up for 3 days." }
```
- `character` trimmed, up to 40 → else `400 "Pick the character you are leveling."`. A name that can't be part of a
  record key → `400 "That character name can’t be shared. Pick one of your characters."`. `zone` and `when_text`
  (alias `when`) up to 60, `note` up to 140.
- Activity `buddy`: `<character> is looking for leveling partners in <zone>` (" in <zone>" only with a zone).

### `POST /api/partners/:id/close` (guild)
Queues the post's tombstone. A post from before sharing just closes here.
```json
{ "ok": true, "message": "Post removed." }
```
- Unknown → `404 "That post no longer exists."`; someone else's → `403 "You can only remove your own posts."`

## Celebrations

`addon/WowGuild/Celebrate.lua` and `services/celebrate.js`. The addon says a player's big moments in guild chat as
`[Guild Camp] <what> — from <name>` (option `celebrate`, never inside dungeons or battlegrounds, each once per
character): levels 20, 30, 40, 50 and 60; an epic or legendary item looted; a profession reaching 150, 225 or 300;
learning to ride; a new PvP rank. Guildmates' addons show a toast, and at level 60 a huge Horde banner across the
screen ("LOK'TAR OGAR!"). When someone joins the guild, everyone gets a toast with **Say welcome**; officers also get
**Welcome kit**, which whispers the newcomer how to open the guild window (no links or ads), picks a guild buddy (the online
guildmate closest in level) and says the welcome in guild chat.

### `POST /api/celebrate` (guild)
From the app itself: one of my own lines, read from the chat log (`main/live.js`). `{ what, from }` → `{ posted }`.
Discord gets e.g. `🎉 **Grom** reached **level 40**! Grats!`, at 60 `🔥 **LOK'TAR OGAR!** 🔥 … The Horde grows
stronger. Blood and thunder!`, `💜 **Grom** looted **Thunderfury**!`, `🔨 **Grom** reached **300 Blacksmithing**!`,
`👋 Welcome to the guild, **Newbie**! Your guild buddy: **Mokra**.` The same line within 15 minutes posts once; an
activity line is added either way.

### Anniversaries
Time in the guild (`memberships.joined_at`: 1, 3 and 6 months, then every year) and character birthdays
(`characters.first_seen`, every year; migration 27). Each app posts its own player's to Discord once (checked every
hour), and the inbox's `today` field (`{ date, lines }`) shows them as a toast at login.

## Guild life

Services: `services/guildlife.js`; routes: `routes/guildlife.js`; migration 28. Pages: Bulletin board (`/board`), Weekly digest
(`/digest`), and "Good leveling matches" on Partners.

### Bulletin board

Posts are `bb` records ([SHARING.md](../SHARING.md)), shared like crafting requests, so guildmates without the app
see them in game (`/wow board`). A post lasts a week. Your own new post goes to Discord when the game confirms it
("📌 **Selling:** Mooncloth, 4 left (12g 50s) — Grimtusk").

#### `GET /api/board` (guild)
```json
{ "posts": [{ "id": 3, "character": "Grimtusk", "class": "MAGE", "level": 60, "kind": "wts", "kindLabel": "Selling",
    "text": "Mooncloth, 4 left", "price": 125000, "created_at": "2026-11-10 09:12:00", "mine": true }],
  "myCharacters": [{ "name": "Grimtusk", "class": "MAGE", "level": 60 }],
  "kinds": { "lfg": "Looking for group", "wts": "Selling", "wtb": "Buying", "help": "Help wanted" } }
```

#### `POST /api/board` (guild)
`{ "character": "Grimtusk", "kind": "lfg|wts|wtb|help", "text": "…", "price": 125000 }` (price in copper, optional)
→ `201 { "post": {…}, "message": "Posted to the guild. It stays up for a week." }`
- Not my character, unknown kind or no text → `400`; no player id yet → `409`.

#### `POST /api/board/:id/remove` (guild)
Takes my post down for the guild (the record's final state `x`). → `{ "ok": true, "message": "Post taken down." }`
- Unknown → `404`; someone else's → `403`.

### Leveling matches

#### `GET /api/leveling` (guild)
For each of my characters under 60: guildmates' characters within `levelGap` (3) levels, online or seen in the
last 14 days. Online first, then those with a partner post, then the hours of the week we're both usually on
(`sharedHours`), then level. Hours come from roster scans (`seen_hours`: each online guildmate counts once per scan
in the slot `weekday * 24 + hour`, this computer's time).
```json
{ "levelGap": 3, "characters": [{ "character": "Grimlet", "class": "ROGUE", "level": 27, "usually": "Weekday evenings",
  "matches": [{ "name": "Rokhan", "class": "HUNTER", "level": 28, "zone": "Ashenvale", "online": true, "lastSeen": "…",
    "sharedHours": 9, "usually": "Weekday evenings", "lookingForPartners": true }] }] }
```

### Weekly digest

The guild's week, Monday 00:00 UTC to the next: who joined, raids, the week's top three in season points,
donations, crafts made, kills and deaths, calls to arms and board posts. The Guild Master's app (membership role
`owner`) posts it to Discord on Sunday from 18:00 (this computer's time); officers can post it by hand. Each app
posts a week once (`digest_posts`).

#### `GET /api/digest?week=YYYY-MM-DD` (guild)
Any day of the week; this week by default.
```json
{ "week": "2026-11-09", "from": "…", "to": "…", "current": true, "previous": "2026-11-02", "next": null, "guild": "wow",
  "members": { "total": 27, "joined": ["Rokhan"], "atMax": 11 },
  "top": [{ "name": "Mokra", "points": 214 }], "points": { "gold": 120, "kills": 31, "crafts": 6, "raidNights": 18 },
  "raids": [{ "title": "Molten Core", "startsAt": "…", "done": true, "attended": 18 }],
  "donations": { "count": 9, "value": 1450000, "top": { "name": "Grimtusk", "value": 800000 } },
  "crafts": 6, "war": { "kills": 31, "deaths": 12 }, "ctas": 4, "board": 7,
  "posted": false, "canPost": true, "discord": true, "text": "📰 **wow — the week of 2026-11-09** …" }
```

#### `POST /api/digest/post` (guild, officers)
`{ "week"?: "YYYY-MM-DD", "force"?: true }` → `{ "ok": true, "posted": true, "message": "The weekly digest is on Discord." }`
(`posted: false` when it already went out and `force` isn't set).
- Not an officer → `403`; no webhook → `409`; Discord refused → `502`.
