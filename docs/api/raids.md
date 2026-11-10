# Raids API

Raids and the other scheduled event kinds (PvP premades, guild events), sign-ups, soft reserves with the SR+
loyalty bonus, the officer loot screen (rolls and awards), loot lists, loot history and the one-hour reminder.
Implemented in `app/src/core/routes/raids.js` on top of `app/src/core/services/raids.js` (row reads and record
fields). Conventions (roles, errors, field names, times) are in [core.md](core.md).

## Shared through the addon

Raids are guild data shared in game ([SHARING.md](../SHARING.md), [share.md](share.md)). Every change here queues
a record, and the rows (raids, signups, reserves, attendance, loot_items, loot_log, loyalty) are made again from
the records at once, so the answer already shows the change:

| Action | Record | Notes |
|---|---|---|
| Schedule | `RD:<key>` | A random key, which becomes the raid's `share_id`. Officer data: waits for an officer character. |
| Lock, unlock, cancel, close | `RT:<raid key>` (`l`, `o`, `x`, `d`) | Edited on top of the version this computer holds: if another officer changed it first, the change is refused as stale and rolled back. Cancel and close are final: the earliest final version wins everywhere. |
| Sign up, reserve | `su:<raid key>:<my player id>` | One sign-up per player per raid. The reserves ride on it. |
| Award | `LA:<key>` | The roll and bonus come from the rolls on this computer; rolls themselves never leave it. |
| Edit a loot list | `LL:<instance key>` | One record per instance, edited on top of the stored version. |

Guildmates' apps notify their players when the records arrive. Discord posts (when a webhook is set in Settings)
go out from the officer's app when the game confirms the change: a new raid or event, a cancel, an award.

Instance names match the way loot lists are keyed: ignoring case and surrounding blanks. A raid scheduled for
"molten core" shows the "Molten Core" list (items, reserves, loot screen, awards by name), and a new raid takes the
list's spelling. A change cancelled under Addon & sync, or refused by the game, is taken back from the rows: a
loot list's first shared edit that never went out takes the items it added with it (a list typed before sharing
stays as it was), and an award is matched to its raid and list again whenever they arrive or change.

## SR+ in one paragraph

Each raider reserves up to `sr_limit` items per raid (0–5, default 2; PvP premades and guild events have none).
When an item drops, only the people who reserved it and are in the raid (sign-up `yes` or `bench`) roll 1–100, and
each adds their loyalty bonus for that item. The bonus grows by **+10** for every raid you attend with that item
reserved and don't win it. It resets when you win the item, when you attend with a different reserve (switching
ends the streak for the instance's other items), and when you sign up "Coming" (`yes`) and don't show. Skipping a
raid you didn't sign up for leaves it alone.

Bonuses are not stored as edits. Every app works them out from the same records (`loyaltyFold` in
`shared/sharing.js`): start from the newest checkpoint (`LY`), then replay every raid close (`RT` `d` of kind
`raid`) and award (`LA`) after it, in time order. A close carries each attendee's counting reserves (minus what
they won in that raid) and the no-shows; an award to a player resets their bonus for that item. Reserves count at
a close only when they were picked before the raid was locked (otherwise the previous picks count). When the
newest checkpoint is over 14 days old, an officer's app writes a new one that folds in the closes and awards older
than 30 days.

## Shapes

**Raid** (`raids` row; `guild_id` and the old Discord event id are left out)
```json
{ "id": 12, "kind": "raid", "title": "Hyjal week 1", "instance": "Hyjal Summit",
  "starts_at": "2026-12-09T18:00:00.000Z", "duration_min": 180, "size": 20, "sr_limit": 2,
  "notes": "Bring fire resistance", "status": "open", "reminded": 0, "created_by": 3,
  "created_at": "2026-11-07 18:00:00" }
```
- `kind`: `raid` | `pvp` | `event`. `status`: `open` (reserves open) | `locked` (reserves locked, sign-ups still
  open) | `done` (closed, bonuses settled) | `cancelled`. `starts_at` is ISO 8601 UTC; `created_at` is SQLite UTC.
- `size` (players, up to 40) and `notes` may be `null`. `created_by` is the player who scheduled it.

**Counts**: people coming per role, and the other statuses.
```json
{ "tank": 2, "healer": 4, "dps": 12, "tentative": 3, "bench": 1, "no": 2 }
```

**Sign-up** (`signups` row plus the player and their character's readiness)
```json
{ "user_id": 9, "character": "Mokra", "role": "healer", "status": "yes", "note": "Might be 15 min late",
  "updated_at": "2026-11-07 18:10:00", "battletag": "Mokra", "name": "Mokra", "class": "SHAMAN", "level": 60,
  "readiness": { "ilvl": 58.2, "durability": 22, "consumables": { "potion": 5, "bandage": 10 }, "at": 1762538400 },
  "flags": { "noData": false, "lowRepair": true, "noConsumables": false },
  "mine": false }
```
- `role`: `tank` | `healer` | `dps`. `status`: `yes` (Coming) | `tentative` (Maybe) | `bench` | `no` (Can't make it).
- `readiness` comes from the addon (my uploads, or a guildmate's shared character record), matched by character
  name. `null` when unknown.
- `flags.lowRepair` is repair under 30 %. `flags.noConsumables` is no consumables in bags. `flags.noData` is no readiness.

**Loot item** (`loot_items` row)
```json
{ "id": 4, "guild_id": 1, "instance": "Hyjal Summit", "boss": "Anetheron", "name": "Night Cloak", "item_id": null,
  "item_key": "h1x9k2", "wh_id": 30884 }
```
`item_id` is the game item id typed with the list; `item_key` is the key the shared records use (the game id in
base36, else `h` + a hash of the name); `wh_id` is `item_id`, or the id found by name in `item_names`, for
tooltips. `item_id` and `wh_id` can be `null` (show the plain name).

**Reserver**
```json
{ "user_id": 9, "battletag": "Mokra", "name": "Mokra", "character": "Mokra", "bonus": 20, "signup": "yes", "inRaid": true }
```
`inRaid` is sign-up `yes` or `bench`.

**Roll** (local to the officer's computer)
```json
{ "user_id": 9, "battletag": "Mokra", "name": "Mokra", "character": "Mokra", "roll": 51, "bonus": 20, "total": 71,
  "created_at": "2026-12-09 19:40:00" }
```

**Award** (`loot_log` row plus `wh_id`)
```json
{ "id": 7, "guild_id": 1, "raid_id": 12, "item_id": 4, "item_name": "Night Cloak", "user_id": 9, "character": "Mokra",
  "kind": "sr", "roll": 51, "bonus": 20, "created_at": "2026-12-09 19:41:00", "share_id": "a8k2pq", "wh_id": 30884 }
```
`kind`: `sr` (reserve win) | `ms` (main spec) | `os` (off spec) | `free` (free roll). `roll` is set when the winner
had rolled for that item in this raid. `user_id`/`item_id` are `null` for typed-in names.

---

## Raids

### `GET /api/raids` (guild)
Coming up (starts no more than 6 hours ago and not closed, soonest first, up to 20; cancelled raids stay here so
people see them) and past (older, or closed; newest first, up to 20). `instances` feeds the schedule form: every
instance with a loot list or an earlier raid, each once (names that differ only in capitalisation count as one),
spelled as its loot list spells it, in name order.
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
`mySignup` is `null` when I haven't signed up. `myReserves` is how many items I reserved.

### `POST /api/raids` (officer)
Queues an `RD` record.
```json
{ "kind": "raid", "title": "Hyjal week 1", "instance": "Hyjal Summit", "starts_at": "2026-12-09T18:00:00.000Z",
  "duration_min": 180, "size": 20, "sr_limit": 2, "notes": "Bring fire resistance" }
```
- `starts_at`: ISO 8601 **with a zone** (the app converts the local date and time itself). A local time without a
  zone (`"starts"` or `"starts_at"`: `"2026-12-09T20:00"`) is accepted together with `tz_offset` (JavaScript
  `getTimezoneOffset()` minutes, UTC+2 → `-120`); without `tz_offset` this computer's time zone applies. Years
  2000–2100 only.
- `kind` defaults to `raid`. `title` and `instance` up to 60 characters. `size` 0–40 (0/empty → `null`).
  `sr_limit` 0–5 (default 2; always 0 for `pvp` and `event`). `duration_min` 15–1440 (default 180). `notes` up to 300.
- When the guild has a loot list for the instance under another capitalisation (`"molten core"` against
  `"Molten Core"`), the raid takes the list's spelling.

`201`
```json
{ "raid": { "id": 12, "kind": "raid", "...": "Raid shape" }, "message": "Raid scheduled." }
```
(`"PvP scheduled."`, `"Event scheduled."`.)

Side effects:
- Activity `Calvin scheduled Hyjal week 1`. Audit `scheduled raid` / `scheduled pvp` / `scheduled event`, detail
  `Hyjal week 1 (2026-12-09T18:00:00.000Z)`.
- When the game confirms it, Discord: `🗓️ **Raid: Hyjal week 1** (Hyjal Summit)` (`⚔️ **PvP: …**`,
  `🎉 **Event: …**`), then `<t:…:F>, <t:…:R>` and `Sign up and reserve in Guild Camp.` (`Sign up in Guild Camp.`
  for PvP and events).
- Guildmates' apps notify (`raid`): title `🗓️ Hyjal week 1`, body `Hyjal Summit, Wed 9 Dec, 18:00 UTC. Sign up in
  Guild Camp.`, route `/raids/<their id>`.

Errors: `400 "Fill in the name, instance and start time."`, `403` for members.

### `GET /api/raids/:id` (guild)
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
  "needsSignup": false,
  "isOfficer": false
}
```
- `signups` are sorted tank, healer, damage, then by character. `mySignup` is `null` until I sign up.
- `myCharacters`: my characters, main first, then by level (the sign-up form's choices), without those an upload
  put in another in-game guild.
- `items`: this raid's instance loot list (by boss, then name; the instance matched ignoring case) with **my**
  bonus per item, how many people reserved it in this raid, and whether I did.
- `board`: every item with at least one reserve in this raid.
- `attended`: the user ids (`users.id`) recorded when the raid was closed.
- `canSignUp`: status `open` or `locked`.
- Reserves are open when the status is `open`, the kind is `raid`, `sr_limit` > 0 and the loot list has items.
  Reserves travel on my sign-up record, so `canReserve` is true only when reserves are open **and** I have a
  sign-up (any status, "can't make it" included). `needsSignup` is true when reserves are open and I have no
  sign-up yet: the page shows the items read-only with "Sign up first, then pick your reserves." instead of
  failing with the `409` below. Both are false for a locked, closed or cancelled raid, a PvP premade or event, or a
  raid without a loot list.
- Unknown id → `404 "That raid was not found. It may have been removed."`

### `POST /api/raids/:id/signup` (guild)
Creates or replaces my sign-up (`su`). The reserves on it stay as they are.
```json
{ "character": "Mokra", "role": "healer", "status": "yes", "note": "Might be 15 min late" }
```
`character` up to 40 (required), `role` defaults to `dps`, `status` defaults to `yes`, `note` up to 120.
```json
{ "ok": true, "signup": { "...": "Sign-up" }, "counts": { "...": "Counts" }, "message": "You’re signed up." }
```
Messages: `"You’re signed up."` (first time), `"Sign-up updated."`, `"Marked as can’t make it."` (status `no`).
Activity `Mokra signed up for Hyjal week 1` the first time I sign up `yes`.
Errors: `400 "Pick a character."`, `409 "Sign-ups are closed for this raid."` (done or cancelled), `409` for a raid
from before sharing, `409` before any of my characters is known.

### `POST /api/raids/:id/reserves` (guild)
Replaces my reserves for the raid. `[]` clears them. Reserves travel on my sign-up, so I must sign up first.
```json
{ "item_ids": [4, 7] }
```
```json
{ "ok": true, "myReserves": [ { "...": "Loot item", "bonus": 20 } ], "message": "Reserves saved." }
```
(`"Reserves cleared."` for an empty list.) The list I replace is kept on the record as the previous picks, so if an
officer locked the raid before my change reached them, my earlier picks still count. Picking the same items again
queues nothing.

Errors: `409 "Reserves are locked for this raid."` (status isn't `open`), `400 "You can reserve up to 2 items."`,
`400 "That item isn’t on this raid’s loot list."`, `409 "Sign up for this raid first, then pick your reserves."`

### `POST /api/raids/:id/lock`, `/unlock`, `/cancel` (officer)
No body. Queues the raid's `RT` record on top of the version this computer holds.
```json
{ "ok": true, "raid": { "...": "Raid shape" }, "message": "Reserves locked." }
```
| Call | From | To | Message | Audit | Refused (`409`) |
|---|---|---|---|---|---|
| `lock` | `open` | `locked` | `Reserves locked.` | `raid locked` | `Only raids with open reserves can be locked.` |
| `unlock` | `locked` | `open` | `Reserves reopened.` | `raid reopened` | `Reserves aren’t locked for this raid.` |
| `cancel` | `open`, `locked` | `cancelled` | `Raid cancelled.` / `PvP cancelled.` / `Event cancelled.` | `raid cancelled` | `Only upcoming raids can be cancelled.` |

Audit detail is the raid title. When the game confirms a cancel, Discord gets
`❌ **Hyjal week 1** on <t:…:F> is cancelled.`, and guildmates who signed up (anything but "can't make it") are
notified by their apps (`❌ Hyjal week 1 is cancelled`, `Check Guild Camp for details.`).

### `POST /api/raids/:id/close` (officer)
Records who attended and the no-shows (people signed up `yes` who didn't come), as the final `RT` `d` record. Ids
that aren't in the guild are ignored. Only `raid` kind changes SR+ bonuses; closing a PvP premade or guild event
records attendance only.
```json
{ "attendee_user_ids": [9, 12] }
```
```json
{ "ok": true, "raid": { "...": "Raid shape, status done" }, "attended": 2, "noShows": 1,
  "message": "Raid closed. 2 attended, 1 no-show. Bonuses updated." }
```
The message starts with the kind (`Raid closed.`, `PvP closed.`, `Event closed.`); only raids add
` Bonuses updated.` Activity `Hyjal week 1 finished with 2 raiders`. Audit `raid closed`,
`Hyjal week 1: 2 attended, 1 no-shows`.
Errors: `409 "This raid is already closed."`, `409 "Cancelled raids can’t be closed."`,
`400 "A raid can record up to 60 people who came and 60 who didn’t."`

---

## Loot screen (officer)

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
`attending` is everyone signed up `yes` or `bench`, by character.

### `POST /api/raids/:id/roll`
Rolls 1–100 plus bonus for everyone who reserved the item and is in the raid (`yes` or `bench`). Rolling again
replaces the earlier rolls for that item. Rolls stay on this computer.
```json
{ "item_id": 4 }
```
```json
{ "item_id": 4, "rolls": [ "Roll" ], "message": "Mokra has the highest roll for Night Cloak: 51 + 20 = 71." }
```
With nobody to roll: `rolls: []`, message `"Nobody in the raid reserved Night Cloak. Give it as main spec, off spec or a free roll."`
Errors: `404 "That item isn’t on this raid’s loot list."`, `409 "This raid was cancelled."`

### `POST /api/raids/:id/award`
Queues an `LA` record.
```json
{ "item_id": 4, "user_id": 9, "kind": "sr" }
```
```json
{ "item_name": "Random Ring", "character": "Pugsy", "kind": "free" }
```
- What: `item_id` (a loot list item) or `item_name` (up to 100; matched to this instance's list, any
  capitalisation, when it can be).
- Who: `user_id` (a guild member; their sign-up character, else their main, a character known to be in the guild
  before one uploaded with no guild) or `character` (a sign-up name, a guild character, or any name typed in).
- `kind` defaults to `ms`. Giving a list item to a player resets their bonus for it, and the item no longer counts
  as their reserve at the close; its rolls are cleared. An award to someone Guild Camp has no player for changes
  no bonus. Allowed after the raid is closed (late records), not when cancelled.
```json
{ "ok": true, "award": { "...": "Award" }, "message": "Night Cloak given to Mokra." }
```
Side effects: activity `Mokra received Night Cloak`, audit `loot given`, `Night Cloak → Mokra (sr)`. When the game
confirms it, Discord `💎 **Night Cloak** → Mokra (SR, Hyjal week 1)`. No app notification.
Errors: `400 "Pick an item."`, `400 "Pick who gets it."`, `400 "That person isn’t in the guild."`,
`404 "That item isn’t on this raid’s loot list."`, `409 "This raid was cancelled."`

---

## Loot lists and history

### `GET /api/loot` (guild)
```json
{
  "lists": [ { "instance": "Hyjal Summit", "items": [ "Loot item, by boss then name" ] } ],
  "history": [ { "...": "Award", "title": "Hyjal week 1", "raid_kind": "raid" } ],
  "myLoyalty": [ { "item_id": 4, "name": "Night Cloak", "instance": "Hyjal Summit", "boss": "Anetheron", "wh_id": null, "bonus": 20 } ]
}
```
`lists` are sorted by instance. `history` is the newest 100 awards (`title` is the raid's, `null` when the raid is
unknown). `myLoyalty` is my bonuses above 0, biggest first.

### `POST /api/loot/items` (officer)
One item per line: `Item`, or `Boss | Item`, optionally followed by `| 12345` or a Wowhead link (`…item=12345`) for
tooltips. An item already on the list (same name in any capitalisation, or the same game item) keeps its key, so
reserves and bonuses on it stay; a boss on the line moves it to that boss. (`items` is accepted instead of `text`.)
The whole list for the instance is queued as one `LL` record; the first edit of a list typed before sharing
carries its existing rows.
```json
{ "instance": "Hyjal Summit", "text": "Rage Winterchill | Frost Greaves | 30871\nAnetheron | Night Cloak" }
```
```json
{ "added": 2, "instance": "Hyjal Summit", "items": [ "Loot item (whole list for that instance)" ],
  "message": "2 items added to Hyjal Summit." }
```
Audit `loot list items added`, `2 to Hyjal Summit` (only when something was added). Nothing is queued when the list
didn't change.
Errors: `400 "Name the instance."`, `400 "Paste at least one item, one per line."`, `400 "That list is too long. …"`
(over 100 000 characters), `400 "A loot list can hold up to 150 items. Remove some first."`,
`400 "A loot list can name up to 40 bosses."`

### `DELETE /api/loot/items/:id` (officer)
Removes the item from its list (a new `LL` version). Everyone's reserves and bonuses for it go too; loot history
keeps the name.
```json
{ "ok": true, "message": "Night Cloak removed." }
```
Audit `loot list item removed`, `Night Cloak (Hyjal Summit)`. Unknown → `404 "That item isn’t on a loot list any more."`

---

## Reminders

Every minute (while timers run), each app looks for open or locked raids starting within the hour that it hasn't
reminded about yet. It notifies its own player when they signed up as coming, maybe or bench (`raid`,
`⏰ Hyjal week 1 starts in an hour`, body `2 tanks, 4 healers, 12 damage signed up.`, route `/raids/12`), and the
app of the officer who scheduled the raid posts to Discord: `⏰ **Hyjal week 1** starts <t:…:R>. 2 tanks, 4 healers,
12 damage signed up. Sign up in Guild Camp.` Other code can run it with `ctx.services.raids.remind()` (resolves to
the number of raids reminded).

To put raids in a calendar, the app saves an `.ics` file (`gc.calendar.export()`, `GET /api/calendar.ics`, see
[admin.md](admin.md)).

## Boss kills

Service: `services/bosskills.js`; migration 30; addon: `BossKills.lua`; record `ek` ([SHARING.md](../SHARING.md)).

When a raid boss dies (`ENCOUNTER_END`, success, in a raid instance), a raider's addon reads the raid roster a few
seconds later and writes the guild members in it. The record's key comes from the encounter, the UTC day and the
raid leader, so every raider's addon makes the same one; an addon that already has it writes nothing. The app only
takes one written by a raider named in it, with `at` within a day of when it was written, and only its author can
change it later (share/import.js).

- **Which raid:** a scheduled raid of the same instance that started up to 6 hours before the kill (or up to 2 hours
  after it).
- **Attendance and season points:** everyone the kills saw gets one raid (10 points) per raid, or per instance and
  UTC day when nothing was scheduled, and at most two a day from kills. A raid an officer closed counts through its attendance, never twice.
- **`GET /api/raids/:id`** adds `bossKills: { kills: [{ boss, at, size }], seen: [userId] }`. Closing the raid ticks
  `seen` by default.
- **Weekly digest:** `bosses: [{ boss, instance, at }]`, and "💀 Bosses down: …" on Discord.
- **Discord:** the app whose addon wrote the record posts "💀 **Ragnaros** is down! Molten Core, 38 raiders.".
