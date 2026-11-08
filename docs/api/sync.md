# Sync API

The app's sync engine uploads what the addon saved (`WowGuildDB`) and fetches the guild news and the sharing
outbox the addon reads in game. Implemented in `app/src/core/routes/sync.js` and `app/src/core/services/sync.js`
(`applyPayload`, `buildInbox`, `freshOnly`), with `services/economy.js` (bags, banks, guild bank, prices),
`services/coach.js` and `sharing.js` (`importShared`, `exportOutbox`, `exportMe`, `exportSeed`). The app side is
`app/src/main/sync.js` ([ARCHITECTURE.md](../ARCHITECTURE.md) "The file channel"). Conventions are in
[core.md](core.md).

| Call | What for |
|---|---|
| `POST /api/sync` | Upload one SavedVariables file's `WowGuildDB` (plus Auctionator prices). |
| `GET /api/inbox` | The news and the sharing outbox as JSON. The app writes it to `Interface/AddOns/WowGuild_Inbox/Inbox.lua`. |

Neither route needs a guild: an upload is how the core learns the guild.

---

## `POST /api/sync`

Body up to 15 MB. The app sends it when `WowGuild.lua` changes (logout or `/reload`), one file at a time.

### Body: `WowGuildDB` as the addon saves it

Every part is optional; a missing part leaves what the core has alone. Lua tables arrive as arrays or as objects
with numeric keys (`{"1": …, "2": …}`); both are read as lists. Strings are cut to the lengths shown below.

```json
{
  "addonVersion": "0.11.0",
  "characters": {
    "Thrallia": {
      "name": "Thrallia", "realm": "Forever", "guild": "wow", "class": "SHAMAN", "race": "Orc", "level": 23,
      "faction": "Horde", "zone": "The Barrens", "money": 123456, "updated": 1794065026,
      "professions": [{ "name": "Blacksmithing", "skill": 120, "max": 150, "id": 164 }],
      "recipes": { "Blacksmithing": [{ "id": 2660, "name": "Copper Chain Vest" }] },
      "inventory": { "bags": [{ "id": 2589, "name": "Linen Cloth", "count": 2 }], "bank": [{ "id": 14047, "name": "Runecloth", "count": 35 }] },
      "readiness": { "ilvl": 58.2, "durability": 50, "consumables": { "potion": 5, "bandage": 10 }, "at": 1794065026 },
      "pvp": { "rank": 2, "rankName": "Scout", "hk": 120, "honor": 5400 },
      "reputations": [{ "name": "Durotar Supply and Logistics", "header": "Horde", "standing": 5, "value": 1500, "max": 6000 }],
      "currencies": [{ "id": 3001, "name": "Merchant's Favor", "qty": 12 }]
    }
  },
  "roster": { "scannedAt": 1794065026, "guild": "wow",
              "members": [{ "name": "Grommash", "rank": "Officer", "rankIndex": 1, "level": 31, "class": "WARRIOR", "zone": "Hillsbrad Foothills", "online": true }] },
  "guildBank": { "scannedAt": 1794065026, "guild": "wow", "money": 1234567,
                 "tabs": [{ "name": "Mats", "items": [{ "id": 14047, "name": "Runecloth", "count": 30 }] }],
                 "log": [{ "kind": "deposit", "who": "Grommash", "id": 14047, "name": "Runecloth", "count": 10, "at": 1794054226 }] },
  "reagentIds": [2589, 2840],
  "shopping": [{ "name": "Linen Belt", "qty": 6, "prof": "Tailoring", "skill": 197, "reagents": [{ "id": 2589, "name": "Linen Cloth", "qty": 1 }] }],
  "coach": {
    "chars": { "Thrallia": { "name": "Thrallia", "class": "SHAMAN", "level": 23, "realm": "Forever", "profile": {}, "stats": {},
                             "quiz": {}, "talents": {}, "gear": {}, "planRequest": 1794065026 } },
    "questions": [{ "id": "1794065026-1216", "char": "Thrallia", "text": "Enhancement or Elemental for world PvP?", "at": 1794065026 }]
  },
  "shared": {
    "v": 1,
    "clock": { "server": 1794066000, "here": 1794065990 },
    "guilds": { "Forever/wow": {
      "pid":   "Thrallia.p4m7",
      "recs":  { "RD:k3f9a2": "RD:k3f9a2^1gqwzvur^Grommash^^r^Molten Core Thursday^Molten Core^tobc40^50^14^2^Bring fire resist" },
      "via":   { "RD:k3f9a2": "Grommash,1794066003,d" },
      "sent":  { "o17": "ok,1gr80lc3,Grommash", "o18": "wait,officer", "o19": "no,stale" },
      "names": { "s": { "2660": "Rough Sharpening Stone" }, "i": { "17102": "Cloak of the Shrouded Mists" } },
      "stats": { "peers": 7, "lastHello": 1794066010, "lastExchange": 1794066030, "dropped": 0, "refused": 2 }
    } }
  },
  "prices": { "items": [[2589, 120, 2502]] },
  "_source": { "account": "ACCOUNTNAME", "install": "C:\\Games\\World of Warcraft\\_forever_" }
}
```

Added by the app, not the addon:
- `prices` from Auctionator's SavedVariables next to the file (`[itemId, copper, auctionatorDay]`, days counted
  from 1 Jan 2020), only when that file changed since the last successful upload.
- `_source`: which account file and game folder this is. The core uses it to tell when one account's shared
  store is far behind the app and needs a seed.

### Which guild

Before anything is stored, the core picks the guild (`identity.selectGuild`): the in-game guild of the most
recently played character in the upload (`characters[*].guild`, `realm`, `faction`, `updated`). The first time a
guild is seen it is created locally and becomes current. A different guild becomes current only when its
character was played more recently than any character of the current one. The reply says so in `switched`.

An upload with no character in a guild, while no guild is known yet, stores nothing (only the addon version) and
answers:
```json
{ "ok": true, "noGuild": true,
  "message": "None of your characters is in a guild yet. Guild Camp starts working as soon as you log in to a character in your guild.",
  "characters": 0, "roster": 0, "recipes": 0, "ctas": 0, "inventory": 0, "bank": 0, "prices": 0, "coachPending": 0,
  "latest": { "app": null, "addon": { "version": "0.11.0" } } }
```
The app logs this once and does not treat it as a failure.

When the upload's roster scan still names a guild (`roster.guild`: the old addon could save a character before
the game knew its guild), the message says so and the reply adds `"rosterGuild": { "name", "realm" }`. Nothing
is set up yet: Addon & sync asks "Is <guild> your guild?", and the player's yes calls
`POST /api/sync/roster-guild` with `{ "name" }`. The name must match the offer the core stored from that upload
(else 409); the guild is then set up like a first sync would (realm and faction from the most recently played
character) and the app syncs again. Any upload that has a guild drops the offer. The same happens when a guild
is already current but the roster names a different one: that upload is not stored in the current guild.

The app only uploads game folders in use: WoW Forever (or a folder with no flavor), plus any other game the player
turned on under Addon & sync (`settings.otherGameFolders`). Other games are listed there as "Not used".

### What the core does with it

All of it is written in one transaction (`applyPayload`).

| Part | Rule |
|---|---|
| `characters` | Upserted by name and linked to me, with the in-game guild the upload gives (`characters.game_guild`; an upload without one keeps the old value): a character the upload puts in another in-game guild doesn't count as mine here and stays off this guild's roster, counts and pickers, and one uploaded with no guild (and not on the roster) counts as mine but is never the main, an alt or the player id's anchor my shared records give (SHARING.md §3). A character another player owns is **never** changed, with one exception: a character that only a shared record linked to a player id (a `pid:` or `char:` user) is mine, since it is in my own SavedVariables (my second account before both used one player id); the player it leaves behind is no longer listed once it has no character. Name ≤ 40, class ≤ 20, race ≤ 30, faction ≤ 10, zone ≤ 60. `professions` replace the character's list when sent; `recipes` replace that profession's recipes when sent (≤ 2000 each). `readiness` feeds raid sign-ups. `pvp`, `reputations` (≤ 120), `currencies` (≤ 100) and the character's addon version are kept as `extras`. A new character adds the activity line "`<name>` linked their character". |
| realm | The first character with both `realm` and `guild` sets the guild's `realm` and `game_guild` when they are empty. |
| `inventory` | `bags` and `bank` replace that location for my own characters (≤ 2000 each). The bank only updates when it was sent (the player opened it). Item names are remembered for search and tooltips. |
| `guildBank` | Replaces the guild bank and its money, unless the core already has a newer scan (≤ 20 tabs × 200 items). Log lines (≤ 500) are added once: the game only says "3 hours ago", so repeats are matched in 6-hour windows. |
| `prices` | One price per item per day (≤ 100 000 rows); the cheapest seen that day wins. |
| `roster` | When newer than the last scan: every character's `online` is reset, then each member (≤ 1000) gets rank, rank index, zone, online and level. Roster rows never claim a character for anyone. `rankIndex` (0 = Guild Master, whole numbers 0–20) is saved as `characters.rank_index`; a member without one keeps the old value. After the upload, roles follow the ranks (`identity.syncRanks`, audit lines `rank promote` / `rank demote`). |
| `reagentIds` | Replaces my "wanted" items (≤ 2000), which the inbox prices. |
| `shopping` | Replaces my shopping list (≤ 50 entries, ≤ 12 reagents each); its reagents count as wanted too. An empty list clears it; leaving the key out keeps it. |
| `coach` | Play style, talents and gear per character (≤ 50) and questions asked in game (≤ 10 per upload, ≤ 500 characters, stored once per question id). |
| `shared` | Guildmates' records and the acknowledgements of my outbox, for the current guild's partition only (`sharing.importShared`, below). |
| `addonVersion` | Saved on my users row (Officer tools shows it). |
| `ctaQueue` | Only in SavedVariables files from before sharing: old queued calls to arms (≤ 20) are stored once each. The addon no longer writes it. |

**`shared` (SHARING.md §9, §10).** For the partition of the current guild (`"<realm>/<guild>"` exactly as the
game names them; the core learns the key from the addon and matches it ignoring case, spaces and punctuation):
1. The clock skew (`server - here`) is saved, and `share_since:<guild id>` at the first import in the guild. When
   the app has no player id for this guild yet, it settles one before any record is imported (SHARING.md §3): an
   id another PC of mine already uses (named by the `ch` of one of my characters and by its anchor's own `ch`;
   when the addon has an id of its own, only one made on a character this PC doesn't play), else the addon's id
   for this guild (`guilds[g].pid`, then the old `shared.pid`), each only when it was made on one of my characters
   in the guild; else a new one at the end.
2. Acknowledgements in `sent` (of every partition) update `share_outbox` ([share.md](share.md)). On `ok` the
   record is stored as mine, the version goes into the log of my own versions (`share_sent`), and its Discord
   post is collected. The item and spell names are saved.
3. Each record whose version beats the stored one is decoded and checked (the import rules), stored in
   `shared_records` as `ok`, or `ignored` with a reason and an audit line, and the rows of its type are made
   again. A record missing from a store is not a deletion; only tombstones delete. A version the app dropped as
   expired (or an older one), and a record whose parent it dropped, are skipped.
4. Guildmates' new records notify me (core.md "Notifications"; not records from before the guild's last fresh
   start), officer records add audit lines such as "Grommash cancelled Molten Core (passed on by Thrallia)", and
   a record in my name that this computer didn't make opens an author check.
5. An officer's app writes an SR+ checkpoint (`LY`) when the newest one is over 14 days old. At most once per
   server hour, the records every addon has expired leave `shared_records`; the rows they made stay
   (SHARING.md §11).

After the transaction, the collected Discord posts go out (when a webhook is set), and once a day my Auctionator
prices for my wanted reagents and the guild bank's items (≤ 60) are queued as a `pr` record.

**My calls to arms from the game.** `/wow cta` writes a `ca` record in game and sends it at once. When it arrives
here for the first time (under an hour old, written by one of my characters), it counts in `ctas` and is
posted to Discord (when a webhook is set):
```
⚔️ **Call to arms: Crossroads** (need 8)
Alliance at the flight master
— Thrallia (from in game)
```

**Fresh start.** After the Guild Master's fresh start (`guilds.reset_at`), data from before it is ignored:
characters whose `updated` is older, a roster or guild bank scanned before it, prices from earlier days. Once the
guild's realm is known, characters from another realm are ignored, and so are the roster, guild bank and prices
of an upload that has no character on that realm. A roster or guild bank from a different in-game guild
(`guild` ≠ `game_guild`) is ignored too. `shared` is never filtered: the addon's store brings the guild's shared
records back after a fresh start, whatever their age ([admin.md](admin.md)).

Every upload with a guild adds a `sync_log` row and sets my `last_sync_at`.

### Coach

`coachPending` counts my questions still waiting for an answer, plus build plans wanted (only when an Anthropic key
is set). When the upload brought a question, or something is pending and a key is set, the core starts a Coach
pass right away. The app then reads `GET /api/inbox` every 6 seconds (for up to 2 minutes) until `coach.pending`
is 0, and saves the news again.

### Response

```json
{
  "ok": true,
  "guild": { "id": 1, "name": "wow", "faction": "Horde", "role": "member" },
  "characters": 1, "roster": 3, "recipes": 2, "ctas": 1, "inventory": 4, "bank": 3, "prices": 1,
  "coachPending": 0,
  "latest": { "app": { "version": "0.11.1" }, "addon": { "version": "0.11.1" } },
  "switched": { "id": 1, "name": "wow", "faction": "Horde", "created": true }
}
```
- The counts are what this upload changed: characters saved, roster members, recipes, **new** calls to arms,
  inventory rows, guild bank rows, price rows.
- `latest`: the newest app and addon versions the app knows (either may be `null`).
- `switched` only when this upload created the guild or made another guild current.

| Status | When | `error` |
|---|---|---|
| 400 | The body isn't a JSON object (an array, for example) | `"The upload must be a JSON object with the addon's data."` |
| 400 | Broken JSON | `"That request was not valid JSON."` |
| 413 | Over 15 MB | `"That upload is too large."` |

Odd values inside the object (a character without a name, a price row without a day, a roster entry that isn't a
table, a malformed record) are skipped, not refused.

---

## `GET /api/inbox`

The news for the addon, and what it should send. `Cache-Control: no-store`.

```json
{
  "guild": "wow",
  "generatedAt": 1794065299,
  "latestAddon": "0.11.1",
  "announcements": [{ "body": "Raid sign-ups Sunday", "at": "2026-11-07 18:00:00", "by": "Grommash" }],
  "canCraft": [{ "id": 4, "item": "Copper Chain Vest", "notes": "mats in mail", "requester": "Grom" }],
  "myRequests": [{ "item": "Linen Belt", "status": "claimed", "crafter": "Jaina" }],
  "buddies": [{ "character": "Grom", "level": 22, "zone": "The Barrens", "whenText": "evenings", "note": "questing" }],
  "raids": [{ "id": 12, "title": "Molten Core", "instance": "Molten Core", "status": "open", "startsAt": 1794600000,
              "signup": "yes", "role": "healer", "character": "Thrallia", "coming": 14,
              "reserves": [{ "name": "Night Cloak", "bonus": 20 }] }],
  "prices": [{ "id": 2589, "price": 120 }],
  "stock": [{ "id": 2589, "chars": [{ "name": "Altie", "count": 7 }], "guildBank": 20 }],
  "holdings": [{ "id": 2589, "chars": [{ "name": "Altie", "count": 7 }], "guildBank": 20 }],
  "crafters": [{ "name": "Linen Belt", "who": "Altie,Zuljinne" }],
  "coach": { "enabled": true, "pending": 0, "plans": {}, "answers": [] },
  "outbox": [
    { "op": "o17", "g": "Forever/wow", "id": "RT:k3f9a2", "t": 1794355200, "need": "o", "base": "1gqwzvur", "body": "l^tob9c0" },
    { "op": "o19", "g": "Forever/wow", "id": "AN:q2w8zz", "t": 1794069000, "need": "o", "base": "1gr0abcd", "del": true },
    { "op": "o20", "g": "Forever/wow", "id": "WH:1", "t": 1794069100, "need": "o", "base": "", "chan": "OFFICER",
      "body": "https://discord.com/api/webhooks/…" }
  ],
  "me": { "pid": "Thrallia.p4m7", "bt": "Calvin#1234", "main": "Thrallia", "alts": ["Thrallia", "Zuljinne"],
          "g": "Forever/wow",
          "byG": { "Forever/wow": { "pid": "Thrallia.p4m7", "bt": "Calvin#1234", "main": "Thrallia", "alts": ["Thrallia", "Zuljinne"] },
                   "Forever/Rivals": { "pid": "Bob.k2x9", "bt": "Calvin#1234", "main": "Bob", "alts": ["Bob"] } } },
  "seed": []
}
```

| Field | Contents |
|---|---|
| `generatedAt` | Unix seconds. The addon uses it to tell "sent" questions from "unsent" ones and to show how fresh the news is. |
| `latestAddon` | The newest addon version the app knows (GitHub or bundled), or `null`. When it is newer than the installed addon, the addon tells the player to update from the Guild Camp app. |
| `announcements` | The newest 5 notices. `at` is SQLite UTC; `by` is the poster's name. |
| `canCraft` | Up to 20 open requests from others for an item one of **my** characters has the recipe for. |
| `myRequests` | Up to 10 of my open or claimed requests, newest first. |
| `buddies` | Up to 10 active leveling-partner posts from others. |
| `raids` | Up to 5 open or locked events starting no earlier than 3 hours ago, soonest first, with my sign-up and my reserves with their SR+ bonus. `startsAt` is Unix seconds. |
| `prices` | Guild prices (copper, newest scan in the last 30 days) for my wanted reagents and shopping-list mats, then for items in `holdings`. |
| `stock` | For each reagent on my shopping list: how many each of my characters holds, and the guild bank plus bank characters. |
| `holdings` | For item tooltips: what each of my characters holds, and what the guild bank holds (≤ 2500 items). |
| `crafters` | Every recipe in the guild with the characters that know it, comma-separated (≤ 4000). |
| `coach` | Plans for my characters, my last 10 questions with answers (plain text for the game), `pending`, and whether the Coach is `enabled`. |
| `outbox` | Changes the addon should send, for every guild (an entry for another guild waits until a character of that guild logs in): `op` id, `g` the partition `"<realm>/<guild>"`, record `id`, `t` (server seconds), `base` (the version the edit was made on, `""` for none), `need` (`o` officer character, `g` Guild Master; absent for member records), `del` (a tombstone), `chan` (`OFFICER` for `WH`), `body` (the record's fields, not for tombstones). Only entries not yet acknowledged with `ok` or `no`. |
| `me` | Who I am in the current guild: my player id there, BattleTag (`bt`, when known), `main`, and `alts` (the anchor first, then every character of mine in that guild, ≤ 20), plus `g` (that guild's partition key) and `byG`: the same four fields for each guild of mine the app knows, keyed by partition (the current guild first, then by when I last played there, at most 3; a guild with no character known to be mine there has none). Player ids are per guild, so the addon uses the entry of the guild it is in and puts it on my `ch` records (SHARING.md §3, §9). `null` before any of my characters in the current guild is known. |
| `seed` | Usually `[]`. When an account's store holds under half of the guild's records here (a wiped WTF folder, a new PC), up to 3,000 records or 400 KB, newest first. Officer records only when they were accepted first-hand, from a trusted relay, or are my own. |
| `seedG` | Only with a seed: the partition it belongs to. The addon skips the seed on a character of another guild. |

Before any guild is known the answer has the same keys, empty (`guild: ""`, empty lists, `coach.enabled: false`,
no `me`).

The app writes this object as `WowGuildInbox = {…}` (`luaAssignment`). Lua can't hold `null`, so those fields
simply end up missing in game; empty lists become `{}`.
