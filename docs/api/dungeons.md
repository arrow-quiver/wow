# Dungeons API

Dungeon groups inside the guild: a guildmate puts a group together for a dungeon (now or later) with the role slots
they need, and others join with a role. First come, first in; anyone past a role's free slots waits and moves up
when someone leaves. Implemented in `app/src/core/routes/dungeons.js`; the app page is `dungeons.js`; preview data
lives in `app/src/renderer/lib/mocks/dungeons.js`. In game the same groups are listed and joined with `/wow lfg`
(`addon/WowGuild/Dungeons.lua`).

**Players from outside the guild.** The leader can add guests (Name or Name-Realm, with a role). They are listed on
the `dg` record, so guildmates see them, and they take spots right after the leader, before guildmates' joins. The
app can't reach the game, so finding, whispering and inviting happen there: `/wow lfg find [dungeon]` opens the group
finder (`addon/WowGuild/Finder.lua`), which lists players posting LFG or LFM for the dungeon in the chat channels and,
after a click on "Who's around", a `/who` for its level range (never the player's own guild). Each one has Whisper
(opens the chat box with a message the player sends), Invite, and Add (as a guest of the group they lead).
`/wow lfg invite` invites everyone in the group who isn't in the party yet; `/wow lfg add <name> <role>` adds a guest.

Every route needs the guild to be known (`403 NO_GUILD`). Conventions are in [core.md](core.md).

**Shared through the addon** ([SHARING.md](../SHARING.md) §4.3): a group is a `dg` record (called off `x` and done
`d` are final), a join is `dj:<group>:<my pid>` (status `y`, or `w` after leaving). There are no rows: the routes
read the effective records (stored ones plus this computer's pending changes) and the line-up comes from
`dungeonGroupState` in `shared/sharing.js`, so every PC shows the same group. Without a character of mine in the
guild yet, changes answer `409` "Log in to World of Warcraft on a character in your guild first, then log out or
type /reload."

Notifications (kind `cta`, turned off with the Calls to arms choice): a guildmate's new group that starts within
the hour or later ("🛡️ Grom is grouping for Wailing Caverns"), and someone joining or leaving my open group.

---

### `GET /api/dungeons` (guild)
Open and full groups that started at most 3 hours ago, soonest first, and my characters for the pickers.
```json
{
  "groups": [{
    "key": "gr0up1", "dungeon": "Wailing Caverns", "startsAt": "2026-11-09T18:30:00.000Z", "note": "fast run",
    "state": "open", "pending": false,
    "leader": { "character": "Grom", "role": "tank", "class": "WARRIOR", "level": 25, "battletag": "Grom#3333", "mine": false },
    "slots": { "tank": 1, "healer": 1, "dps": 3 }, "open": { "tank": 0, "healer": 1, "dps": 2 },
    "members": [
      { "character": "Varok", "role": "dps", "class": "MAGE", "level": 24, "battletag": "Varok", "mine": false, "waiting": false, "guest": false },
      { "character": "Brokk-Mirage", "role": "dps", "class": "WARRIOR", "level": 21, "battletag": null, "mine": false, "waiting": false, "guest": true }
    ],
    "waiting": [],
    "mine": false, "joined": null,
    "canJoin": true, "canLeave": false, "canCancel": false, "canDone": false, "over": false
  }],
  "myCharacters": [{ "name": "Mokra", "class": "PRIEST", "level": 22, "is_main": 1 }]
}
```
`state`: `open` | `full`. `slots` count the leader. `pending`: my change is not sent yet. `joined`:
`{ character, role, waiting }` when I am in the group or on its waiting list.

### `POST /api/dungeons` (guild)
`{ dungeon, role: 'tank'|'healer'|'dps', character?, startsAt? (ISO; empty = now), slots?: { tank, healer, dps }, note? }`
→ `201 { group, message }`. Slots default to 1 / 1 / 3 and count the leader (the leader's role gets at least 1); a
group has 2 to 10 people. `startsAt` may not be in the past or more than two weeks ahead. `character` defaults to
my main. Errors: `400` "Name the dungeon.", "Pick your role: tank, healer or dps.", "Pick one of your characters.",
"A group can have at most 10 people.", "That time has already passed.", "Plan at most two weeks ahead."

### `POST /api/dungeons/:key` (guild, the leader)
`{ dungeon?, startsAt?, slots?, note? }` → `{ ok, group, message }`. `403` for anyone else, `409` once it is over.

### `POST /api/dungeons/:key/:verb` (guild)
- `join` `{ role, character? }`: my `dj` (status `y`, joinedAt now). The message says whether I'm in or waiting.
  `409` for the leader or when already in it.
- `leave`: my `dj` with status `w` (joinedAt kept).
- `guest` `{ name, role, class?, level? }` / `unguest` `{ name }` (the leader, open group): add or remove a player from
  outside the guild (the `dg` record's `guests`, at most 9). `400` "Type the player's character name, like Brokk or
  Brokk-Mirage.", `409` when already in the group, `404` when removing someone who isn't.
- `done` / `cancel` (the leader): the group's `dg` with state `d` / `x` (final); it leaves the board. `403` for anyone else.

`404` "That group no longer exists." for an unknown or malformed key.
