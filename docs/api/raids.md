# Raids API

Raids and the other scheduled event kinds (PvP premades, guild events), sign-ups, soft reserves with the
SR+ loyalty bonus, the officer loot screen (rolls and awards), loot lists, loot history and the one-hour
reminder. Implemented in `server/src/routes/raids.js` on top of the rules in `server/src/services/raids.js`.
Conventions (auth, errors, field names, times) are in [core.md](core.md).

## SR+ in one paragraph

Each raider reserves up to `sr_limit` items per raid (0–5, default 2; PvP premades and guild events have none).
When an item drops, only the people who reserved it and are in the raid (sign-up `yes` or `bench`) roll 1–100,
and each adds their loyalty bonus for that item. The bonus grows by **+10** for every raid you attend with that
item reserved and don't win it. It resets when you win the item, when you attend with a different reserve
(switching ends the streak for the instance's other items), and when you sign up "Coming" (`yes`) and don't
show. Skipping a raid you didn't sign up for leaves it alone. Bonuses are settled when an officer closes the raid.

## Shapes

**Raid** (`raids` row; `guild_id` and the Discord event id are left out)
```json
{ "id": 12, "kind": "raid", "title": "Hyjal week 1", "instance": "Hyjal Summit",
  "starts_at": "2026-12-09T18:00:00.000Z", "duration_min": 180, "size": 20, "sr_limit": 2,
  "notes": "Bring fire resistance", "status": "open", "reminded": 0, "created_by": 3,
  "created_at": "2026-11-07 18:00:00" }
```
- `kind`: `raid` | `pvp` | `event`. `status`: `open` (reserves open) | `locked` (reserves locked, sign-ups still
  open) | `done` (closed, bonuses settled) | `cancelled`. `starts_at` is ISO 8601 UTC; `created_at` is SQLite UTC.
- `size` (players, up to 40) and `notes` may be `null`.

**Counts**: people coming per role, and the other statuses.
```json
{ "tank": 2, "healer": 4, "dps": 12, "tentative": 3, "bench": 1, "no": 2 }
```

**Sign-up** (`signups` row plus the member and their character's readiness)
```json
{ "user_id": 9, "character": "Mokra", "role": "healer", "status": "yes", "note": "Might be 15 min late",
  "updated_at": "2026-11-07 18:10:00", "battletag": "Mokra#9031", "name": "Mokra", "class": "SHAMAN", "level": 60,
  "readiness": { "ilvl": 58.2, "durability": 22, "consumables": { "potion": 5, "bandage": 10 }, "at": 1762538400 },
  "flags": { "noData": false, "lowRepair": true, "noConsumables": false },
  "mine": true }
```
- `role`: `tank` | `healer` | `dps`. `status`: `yes` (Coming) | `tentative` (Maybe) | `bench` | `no` (Can't make it).
- `readiness` comes from the addon (item level, repair %, consumables in bags at the last reload; `at` is unix
  seconds) via `characters.readiness`, matched by character name. `null` when the character never synced.
- `flags.lowRepair` is repair under 30 %. `flags.noConsumables` is no consumables in bags. `flags.noData` is no readiness.

**Loot item** (`loot_items` row)
```json
{ "id": 4, "guild_id": 1, "instance": "Hyjal Summit", "boss": "Anetheron", "name": "Night Cloak", "item_id": null, "wh_id": 30884 }
```
`item_id` is the Wowhead item id typed with the list; `wh_id` is that, or the id found by name in `item_names`
(prices/bank data), for tooltips. Either can be `null` (show the plain name).

**Reserver**
```json
{ "user_id": 9, "battletag": "Mokra#9031", "name": "Mokra", "character": "Mokra", "bonus": 20, "signup": "yes", "inRaid": true }
```
`character` is `null` when the person reserved without signing up. `inRaid` is sign-up `yes` or `bench`.

**Roll**
```json
{ "user_id": 9, "battletag": "Mokra#9031", "name": "Mokra", "character": "Mokra", "roll": 51, "bonus": 20, "total": 71,
  "created_at": "2026-12-09 19:40:00" }
```

**Award** (`loot_log` row plus `wh_id`)
```json
{ "id": 7, "guild_id": 1, "raid_id": 12, "item_id": 4, "item_name": "Night Cloak", "user_id": 9, "character": "Mokra",
  "kind": "sr", "roll": 51, "bonus": 20, "created_at": "2026-12-09 19:41:00", "wh_id": 30884 }
```
`kind`: `sr` (reserve win) | `ms` (main spec) | `os` (off spec) | `free` (free roll). `roll` is set when the
winner had rolled for that item in this raid. `user_id`/`item_id` are `null` for typed-in names.

---

## Raids

### `GET /api/raids` (guild member)
Coming up (starts no more than 6 hours ago and not closed, soonest first, up to 20; cancelled raids stay here so
people see them) and past (older, or closed; newest first, up to 20). `instances` feeds the schedule form: every
instance with a loot list or an earlier raid.
```json
{
  "upcoming": [
    { "id": 12, "kind": "raid", "title": "Hyjal week 1", "instance": "Hyjal Summit", "starts_at": "2026-12-09T18:00:00.000Z",
      "duration_min": 180, "size": 20, "sr_limit": 2, "notes": null, "status": "open", "reminded": 0, "created_by": 3,
      "created_at": "2026-11-07 18:00:00",
      "counts": { "tank": 2, "healer": 4, "dps": 12, "tentative": 3, "bench": 0, "no": 1 },
      "mySignup": { "status": "yes", "role": "healer", "character": "Mokra" },
      "myReserves": 2 }
  ],
  "past": [ "...same shape..." ],
  "instances": ["Black Temple", "Hyjal Summit"]
}
```
`mySignup` is `null` when you haven't signed up. `myReserves` is how many items you reserved.

### `POST /api/raids` (owner or officer)
```json
{ "kind": "raid", "title": "Hyjal week 1", "instance": "Hyjal Summit", "starts_at": "2026-12-09T18:00:00.000Z",
  "duration_min": 180, "size": 20, "sr_limit": 2, "notes": "Bring fire resistance" }
```
- `starts_at`: ISO 8601 **with a zone** (the app converts the local date and time itself). For old clients a
  local time without a zone (`"starts"` or `"starts_at"`: `"2026-12-09T20:00"`) is accepted together with
  `tz_offset` (JavaScript `getTimezoneOffset()` minutes, UTC+2 → `-120`); without `tz_offset` the server's
  `DEFAULT_TZ_OFFSET` applies.
- `kind` defaults to `raid`. `title` and `instance` up to 60 characters. `size` 0–40 (0/empty → `null`).
  `sr_limit` 0–5 (default 2; always 0 for `pvp` and `event`). `duration_min` 15–1440 (default 180). `notes` up to 300.

`201`
```json
{ "raid": { "id": 12, "kind": "raid", "...": "Raid shape" }, "message": "Raid scheduled and posted to Discord." }
```
(`"PvP scheduled."`, `"Event scheduled."`; " and posted to Discord" only when the webhook accepted the post.)

Side effects:
- Discord webhook: `🗓️ **Raid: Hyjal week 1** (Hyjal Summit)` / `⚔️ **PvP: …**` / `🎉 **Event: …**`, then
  `<t:…:F>, <t:…:R>` and `Sign up and reserve: <BASE_URL>/raids/12` (`Sign up:` for PvP and events).
- When the Discord app is set up (`DISCORD_BOT_TOKEN` and the guild's `discord_server_id`), a native Discord
  scheduled event (`services/discord.js createEvent`); its id is kept for the cancel. Discord failures never fail the request.
- App notification `raid` to everyone but the scheduler: title `🗓️ Hyjal week 1`, body
  `Hyjal Summit, Wed 9 Dec, 18:00 UTC. Sign up in Guild Camp.`, route `/raids/12`.
- Activity `Calvin scheduled Hyjal week 1`. Audit `scheduled raid` / `scheduled pvp` / `scheduled event`, detail `Hyjal week 1 (2026-12-09T18:00:00.000Z)`.

Errors: `400 "Fill in the name, instance and start time."`, `403 "Officers only."`

### `GET /api/raids/:id` (guild member)
```json
{
  "raid": { "...": "Raid shape", "scheduledBy": "Calvin" },
  "signups": [ "Sign-up, ..." ],
  "counts": { "tank": 1, "healer": 1, "dps": 0, "tentative": 0, "bench": 0, "no": 1 },
  "mySignup": { "...": "Sign-up" },
  "myCharacters": [ { "name": "Mokra", "class": "SHAMAN", "level": 60, "is_main": 1 } ],
  "items": [ { "...": "Loot item", "bonus": 20, "reserved": 2, "mine": true } ],
  "myReserves": [ { "...": "Loot item", "bonus": 20 } ],
  "board": [ { "item_id": 4, "item": "Night Cloak", "boss": "Anetheron", "wh_id": null, "reservers": [ "Reserver, highest bonus first" ] } ],
  "loot": [ "Award, oldest first" ],
  "attended": [9, 12],
  "canSignUp": true,
  "canReserve": true,
  "isOfficer": false
}
```
- `signups` are sorted tank, healer, damage, then by character. `mySignup` is `null` until you sign up.
- `myCharacters`: your synced characters, main first, then by level (the sign-up form's choices).
- `items`: this raid's instance loot list (by boss, then name) with **your** bonus per item, how many people
  reserved it in this raid, and whether you did.
- `board`: every item with at least one reserve in this raid.
- `attended`: member ids recorded when the raid was closed.
- `canSignUp`: status `open` or `locked`. `canReserve`: status `open`, kind `raid`, `sr_limit` > 0 and a loot list exists.
- Unknown id → `404 "That raid was not found. It may have been removed."`

### `POST /api/raids/:id/signup` (guild member)
```json
{ "character": "Mokra", "role": "healer", "status": "yes", "note": "Might be 15 min late" }
```
Creates or replaces your sign-up. `character` up to 40 (required), `role` defaults to `dps`, `status` defaults
to `yes`, `note` up to 120.
```json
{ "ok": true, "signup": { "...": "Sign-up" }, "counts": { "...": "Counts" }, "message": "You’re signed up." }
```
Messages: `"You’re signed up."` (first time), `"Sign-up updated."`, `"Marked as can’t make it."` (status `no`).
Activity `Mokra signed up for Hyjal week 1` the first time someone signs up `yes`.
Errors: `400 "Pick a character."`, `409 "Sign-ups are closed for this raid."` (done or cancelled).

### `POST /api/raids/:id/reserves` (guild member)
Replaces your reserves for the raid. `[]` clears them.
```json
{ "item_ids": [4, 7] }
```
```json
{ "ok": true, "myReserves": [ { "...": "Loot item", "bonus": 20 } ], "message": "Reserves saved." }
```
(`"Reserves cleared."` for an empty list.) Errors: `409 "Reserves are locked for this raid."` (status isn't
`open`), `400 "You can reserve up to 2 items."`, `400 "That item isn’t on this raid’s loot list."`

### `POST /api/raids/:id/lock`, `/unlock`, `/cancel` (owner or officer)
No body.
```json
{ "ok": true, "raid": { "...": "Raid shape" }, "message": "Reserves locked." }
```
| Call | From | To | Message | Audit | Refused (`409`) |
|---|---|---|---|---|---|
| `lock` | `open` | `locked` | `Reserves locked.` | `raid locked` | `Only raids with open reserves can be locked.` |
| `unlock` | `locked` | `open` | `Reserves reopened.` | `raid reopened` | `Reserves aren’t locked for this raid.` |
| `cancel` | `open`, `locked` | `cancelled` | `Raid cancelled.` / `PvP cancelled.` / `Event cancelled.` | `raid cancelled` | `Only upcoming raids can be cancelled.` |

Audit detail is the raid title. Cancelling also posts `❌ **Hyjal week 1** on <t:…:F> is cancelled.` to Discord,
removes the Discord scheduled event (when there is one and the Discord app is set up; best effort), and sends a
`raid` notification (`❌ Hyjal week 1 is cancelled`, `Check Guild Camp for details.`, route `/raids/12`) to everyone
signed up except "can't make it" and the officer who cancelled.

### `POST /api/raids/:id/close` (owner or officer)
Records who attended and settles the SR+ bonuses (see above). Ids that aren't guild members are ignored.
Only `raid` kind settles bonuses: closing a PvP premade or guild event records attendance and no-shows but leaves
everyone's SR+ loyalty for that instance alone.
```json
{ "attendee_user_ids": [9, 12] }
```
```json
{ "ok": true, "raid": { "...": "Raid shape, status done" }, "attended": 2, "noShows": 1,
  "message": "Raid closed. 2 attended, 1 no-show. Bonuses updated." }
```
The message starts with the kind (`Raid closed.`, `PvP closed.`, `Event closed.`); only raids add ` Bonuses updated.`
(e.g. `PvP closed. 5 attended.`).
Activity `Hyjal week 1 finished with 2 raiders`. Audit `raid closed`, `Hyjal week 1: 2 attended, 1 no-shows`.
Errors: `409 "This raid is already closed."`, `409 "Cancelled raids can’t be closed."`

---

## Loot screen (owner or officer)

### `GET /api/raids/:id/loot`
```json
{
  "raid": { "...": "Raid shape" },
  "board": [ { "item_id": 4, "item": "Night Cloak", "boss": "Anetheron", "wh_id": null,
               "reservers": [ "Reserver" ], "rolls": [ "Roll, highest total first" ] } ],
  "items": [ "Loot item (this instance)" ],
  "attending": [ { "user_id": 9, "character": "Mokra", "role": "healer", "status": "yes", "class": "SHAMAN" } ],
  "awarded": [ "Award, newest first" ]
}
```
`attending` is everyone signed up `yes` or `bench`, by character. Members get `403 "Officers only."`

### `POST /api/raids/:id/roll`
Rolls 1–100 plus bonus for everyone who reserved the item and is in the raid (`yes` or `bench`). Rolling again
replaces the earlier rolls for that item.
```json
{ "item_id": 4 }
```
```json
{ "item_id": 4, "rolls": [ "Roll" ], "message": "Mokra has the highest roll for Night Cloak: 51 + 20 = 71." }
```
With nobody to roll: `rolls: []`, message `"Nobody in the raid reserved Night Cloak. Give it as main spec, off spec or a free roll."`
Errors: `404 "That item isn’t on this raid’s loot list."`, `409 "This raid was cancelled."`

### `POST /api/raids/:id/award`
```json
{ "item_id": 4, "user_id": 9, "kind": "sr" }
```
```json
{ "item_name": "Random Ring", "character": "Pugsy", "kind": "free" }
```
- What: `item_id` (a loot list item) or `item_name` (up to 100; matched to this instance's list, case-insensitive,
  when it can be).
- Who: `user_id` (a guild member; their sign-up character, else their main) or `character` (a sign-up name, a guild
  character, or any name typed in).
- `kind` defaults to `ms`. Giving a list item to a member resets their bonus for it, fulfils their reserve and
  clears the item's rolls (for any kind). Allowed after the raid is closed (late records), not when cancelled.
```json
{ "ok": true, "award": { "...": "Award" }, "message": "Night Cloak given to Mokra." }
```
Side effects: Discord `💎 **Night Cloak** → Mokra (SR, Hyjal week 1)`, activity `Mokra received Night Cloak`,
audit `loot given`, `Night Cloak → Mokra (sr)`. No app notification.
Errors: `400 "Pick an item."`, `400 "Pick who gets it."`, `400 "That person isn’t in the guild."`,
`404 "That item isn’t on this raid’s loot list."`, `409 "This raid was cancelled."`

---

## Loot lists and history

### `GET /api/loot` (guild member)
```json
{
  "lists": [ { "instance": "Hyjal Summit", "items": [ "Loot item, by boss then name" ] } ],
  "history": [ { "...": "Award", "title": "Hyjal week 1", "raid_kind": "raid" } ],
  "myLoyalty": [ { "item_id": 4, "name": "Night Cloak", "instance": "Hyjal Summit", "boss": "Anetheron", "wh_id": null, "bonus": 20 } ]
}
```
`lists` are sorted by instance. `history` is the newest 100 awards (`title` is the raid's, `null` when the raid
was removed). `myLoyalty` is your bonuses above 0, biggest first.

### `POST /api/loot/items` (owner or officer)
One item per line: `Item`, or `Boss | Item`, optionally followed by `| 12345` or a Wowhead link (`…item=12345`) for
tooltips. Lines for items already on the list update their boss and item id. (`items` is accepted instead of `text`.)
```json
{ "instance": "Hyjal Summit", "text": "Rage Winterchill | Frost Greaves | 30871\nAnetheron | Night Cloak" }
```
```json
{ "added": 2, "instance": "Hyjal Summit", "items": [ "Loot item (whole list for that instance)" ],
  "message": "2 items added to Hyjal Summit." }
```
Audit `loot list items added`, `2 to Hyjal Summit` (only when something was added).
Errors: `400 "Name the instance."`, `400 "Paste at least one item, one per line."`, `400 "That list is too long. …"` (over 100 000 characters).

### `DELETE /api/loot/items/:id` (owner or officer)
Removes the item from its list, with everyone's reserves, bonuses and rolls for it. Loot history keeps the name.
```json
{ "ok": true, "message": "Night Cloak removed." }
```
Audit `loot list item removed`, `Night Cloak (Hyjal Summit)`. Unknown → `404 "That item isn’t on a loot list any more."`

---

## Reminders and links

- **One-hour reminder** (every minute while `cfg.timers` is on; once per raid, for `open`/`locked` raids starting
  within the hour): Discord `⏰ **Hyjal week 1** starts <t:…:R>. 2 tanks, 4 healers, 12 damage signed up.` plus the
  raid link, and a `raid` notification (`⏰ Hyjal week 1 starts in an hour`, route `/raids/12`) to the people
  signed up as coming, maybe or bench. Tests and other code can run it with `ctx.services.raids.remind()`
  (resolves to the number of raids reminded).
- **`GET /raids/:id`** (public HTML): Discord posts, `/raids` slash command answers and Discord scheduled events
  link to `<BASE_URL>/raids/<id>`. This small page says sign-ups live in the app, links `guildcamp://raids/<id>`
  and `/get`, and shows no raid details.
