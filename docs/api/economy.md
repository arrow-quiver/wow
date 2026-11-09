# Economy API

The guild bank (tabs, gold, log), bank requests, bank characters, a search across your own alts, the guild price
index and supply drives. Implemented in `app/src/core/routes/economy.js`; the data itself arrives with uploads
(`POST /api/sync` → `services/economy.js` `applyEconomy`) and with guildmates' shared records. Conventions
(roles, errors, times) are in [core.md](core.md).

Where the data comes from:
- **Guild bank**: whoever opens the guild bank in game with the addon. My own scan arrives with my upload;
  guildmates' scans arrive as shared `gb` records (one per tab). Only a newer scan replaces the stored one. The
  game's log only says "x hours ago", so log times (`at`) are approximate.
- **Bags and banks**: my own characters from my uploads. A bank character's bags and bank reach the guild as a
  shared `bk` record from its own player's addon, only while it is on the bank character list (`BC`).
- **Prices**: my Auctionator scans, read by the app, and guildmates' `pr` records (up to 60 reagents and bank items
  each, once a day). One price per item per scan day (the lowest seen that day). "Recent" means the last 30 days.

**Shared through the addon** ([SHARING.md](../SHARING.md), [share.md](share.md)): bank requests (`bq`), officers'
answers (`BH`), the bank character list (`BC`), supply drives (`DR`) and hand-ins (`dc`). A change here queues the
record and the rows change at once; it reaches the guild at the next login or `/reload`. Guildmates are told by
their own apps, and the Discord post goes out when the game confirms the change. Rows made before sharing can be
read but not changed (`409 "This was made with an older Guild Camp and can’t be changed. Make it again."`).

Item `name` is `null` when Guild Camp has never seen the item's name (show `Item <id>`). Money is integer copper.
`unit` is the item's most recent guild auction price (last 30 days) or `null`; `value` is `unit × count` or `null`.

---

## Guild bank

### `GET /api/bank` (guild)
```json
{
  "money": 1234567,
  "scanned_at": "2026-11-07T17:50:00.000Z",
  "tabs": [
    { "name": "Mats", "value": 3600,
      "items": [ { "item_id": 14047, "name": "Runecloth", "count": 30, "unit": 120, "value": 3600 },
                 { "item_id": 12359, "name": "Thorium Bar", "count": 20, "unit": null, "value": null } ] }
  ],
  "bankCharacters": [
    { "name": "Stashy", "class": "MAGE", "level": 12, "owner": "Mokra", "updated_at": "2026-11-07T17:00:00.000Z",
      "value": 52000,
      "items": [ { "item_id": 13444, "name": "Major Mana Potion", "count": 10, "unit": 4000, "value": 40000 } ] }
  ],
  "value": { "guildBank": 57600, "bankCharacters": 52000, "total": 109600 },
  "requests": [ "…see Bank request below…" ],
  "log": [
    { "id": 9, "kind": "deposit", "who": "Grommash", "item_id": 14047, "name": "Runecloth", "count": 10, "amount": null,
      "at": "2026-11-07T16:50:00.000Z" },
    { "id": 10, "kind": "withdraw", "who": "Thrallia", "item_id": null, "name": null, "count": null, "amount": 50000,
      "at": "2026-11-07T15:50:00.000Z" }
  ]
}
```
- `money` / `scanned_at` are `null` until someone opens the guild bank. `scanned_at` is ISO 8601 (UTC).
- `tabs` are in the order the game lists them; items in a tab are sorted by name.
- `bankCharacters` lists every character marked as a bank character (bags and bank added together per item),
  sorted by name. A new bank character has `items: []` until its stock arrives; `updated_at` is when it last did.
  `owner` is the owning player's name or `null`.
- `value` adds up every priced stack. Unpriced items count as nothing.
- `requests`: open requests first, then the ones handled in the last 7 days, newest first. Cancelled requests are
  left out.
- `log`: the newest 40 entries. `kind` is the game's word: `deposit`, `withdraw`, `move` (items), `repair`,
  `withdrawForTab`, `buyTab`, `depositSummary` (gold). Item entries have `item_id`/`name`/`count`; gold entries
  have `amount`.

### `GET /api/bank/search?q=<text>` (guild)
"Which alt has my Runecloth?" Items on **my own** characters whose name contains `q` (up to 60 characters,
wildcards are literal). Up to 100 rows, by item name then character.
```json
{ "q": "rune",
  "results": [ { "character": "Stashy", "class": "MAGE", "location": "bank", "item_id": 14047, "name": "Runecloth", "count": 100 } ] }
```
`location` is `bags` or `bank`. An empty `q` → `{ "q": "", "results": [] }`.

---

## Bank requests

**Bank request**
```json
{ "id": 4, "item": "Runecloth", "count": 20, "note": "For bandages", "status": "open",
  "requester_id": 9, "requester": "Mokra", "handled_by": null, "handler": null,
  "created_at": "2026-11-07 18:00:00", "updated_at": "2026-11-07 18:00:00", "mine": true }
```
`status` is `open`, `sent`, `declined` or `cancelled`: the earlier (by time) of the requester's cancel and an
officer's answer wins, the same on every computer. `requester` / `handler` are player names (`handled_by` is
`null` for a cancel). `mine` is true for my own requests.

### `POST /api/bank/requests` (guild)
Queues a `bq` record for my player.
```json
{ "item": "Runecloth", "count": 20, "note": "For bandages" }
```
`item` up to 100 characters (required), `count` a whole number clamped to 1–1000 (missing or not a number → 1),
`note` up to 200 characters.

`201`
```json
{ "ok": true, "request": { "…": "Bank request" }, "message": "Request posted." }
```
- No item → `400 "Name the item you need."`
- Activity: `"<name> asked the bank for 20 × Runecloth"` (kind `bank`).
- When the game confirms it, Discord: `🏦 **Bank request:** 20 × Runecloth, for <character>`.
- Officers' apps notify (`bank`, `🏦 Bank request from <character>`, body `20 × Runecloth`, route
  `/bank?tab=requests`).
- A new request cancelled under Addon & sync, or refused by the game, before the guild had it disappears from the
  list (there is nothing left to cancel).

### `POST /api/bank/requests/:id/sent` · `/declined` (officer) · `/cancel` (the person who asked)
`sent` and `declined` queue an officer's `BH` record; `cancel` queues the request again as cancelled (`bq` `x`,
final).
```json
{ "ok": true, "request": { "…": "Bank request, with status and handler" }, "message": "Marked as sent." }
```
Messages: `"Marked as sent."`, `"Request declined."`, `"Request cancelled."`
- Unknown verb → `404 "Not found."`; unknown request → `404 "Request not found."`. Not open any more →
  `409 "That request has already been handled."`
- `sent`/`declined` by a member → `403 "Only officers can mark bank requests sent or declined."`. `cancel` by
  anyone but the asker → `403 "Only the person who asked can cancel a request."`
- `sent`: activity `"20 × Runecloth sent from the bank"`. `sent`/`declined`: audit `bank request sent` /
  `bank request declined` with `"20 × Runecloth"`.
- The requester's app notifies them when the answer arrives: `🏦 Your bank request is on its way` /
  `🏦 Your bank request was declined`, body `"20 × Runecloth. Sent by <character>."`, route `/bank?tab=requests`.

---

## Bank characters (for guilds without a guild bank)

Characters that hold guild stock. Their bags and bank show on the Bank page and count toward the bank's value and
the addon's guild bank stock. The list is one shared record (`BC:1`) that officers edit.

### `GET /api/bank/alts` (officer)
Every linked character plus any already marked, marked ones first, then by name.
```json
{ "characters": [ { "name": "Stashy", "class": "MAGE", "level": 12, "owner": "Mokra", "is_bank": 1, "items": 2 } ] }
```
`items` is how many item rows (bags + bank) Guild Camp holds for the character.

### `PUT /api/bank/alts` (officer)
The complete list of bank characters (at most 50). Names match in any capitalisation; characters left out stop
being bank characters. The whole list is queued as `BC` on top of the version this computer holds (a newer list
from another officer refuses it as stale). Nothing is queued when the list doesn't change.
```json
{ "names": ["Stashy", "Grunta"] }
```
```json
{ "ok": true, "bankCharacters": ["Grunta", "Stashy"], "added": ["Grunta"], "removed": [],
  "message": "Grunta is now a bank character. Its bags and bank show here after its next sync." }
```
Messages: one added → `"<name> is now a bank character. Its bags and bank show here after its next sync."`; one
removed → `"<name> is no longer a bank character."`; several → `"Bank characters saved. New ones show their bags
and bank after their next sync."`; nothing changed → `"No changes."`
- `names` not a list → `400 "Send the bank characters as a list of names."`; more than 50 →
  `400 "Mark at most 50 bank characters."`; unknown name → `400 "There is no character called <name> in the guild."`
  (nothing is saved).
- Audit per character: `bank character added` / `bank character removed` with the name.
- When the guild's first list is cancelled under Addon & sync, or refused by the game, nobody is a bank character
  again (as before any list).

---

## Prices

### `GET /api/prices?q=<text>` (guild)
```json
{
  "q": "",
  "stats": { "items": 812, "newest": "2026-11-07" },
  "results": [],
  "held": [
    { "item_id": 14047, "name": "Runecloth", "holders": 4,
      "latest": { "day": "2026-11-07", "price": 120 },
      "history": [ { "day": "2026-11-01", "price": 150 }, { "day": "2026-11-04", "price": 130 }, { "day": "2026-11-07", "price": 120 } ],
      "change": -20 }
  ],
  "bank": { "guildBank": 57600, "bankCharacters": 52000, "total": 109600, "priced": 4, "unpriced": 1,
            "top": [ { "item_id": 13444, "name": "Major Mana Potion", "count": 10, "unit": 4000, "value": 40000,
                       "tab": null, "character": "Stashy" } ] }
}
```
- `stats.items`: how many items have a price; `stats.newest`: the newest scan day (`null` without prices).
- With `q` (up to 60 characters): `results` are up to 50 priced items whose name contains `q`, by name, or the item
  with that id when `q` is a number (it may have `name: null`). `held` is then `[]`.
- Without `q`: `held` is up to 30 priced items that characters carry most (bags, banks and guild bank tabs holding
  it), then by name. `results` is `[]`.
- `history` is the item's newest 14 scan days, oldest first; `latest` is the newest of them.
- `change` is the percent change from the first to the last point of `history`, one decimal place, or `null` with
  fewer than two points.
- `bank` values the guild bank and bank characters as in `GET /api/bank`; `priced`/`unpriced` count stacks, `top`
  is the five most valuable stacks, each with the guild bank `tab` or bank `character` holding it.

---

## Deal hunter

What to buy on the auction house now and sell again for more. It works from **my own** Auctionator history:
the app reads every realm in `Auctionator.lua` scanned in the last 14 days (up to 4 realms, 15,000 items each) and
sends it with `POST /api/market` ([sync.md](sync.md)) after each upload. Nothing here is shared with the guild.
Both Auctionator formats are read: the old one (each realm a Lua table of items) and Auctionator 8+ (`__dbversion`
8: each realm one CBOR string, written with `C_EncodingUtil.SerializeCBOR`; `shared/cbor.js` decodes it).
Implemented in `app/src/core/services/deals.js`.

### `GET /api/deals?realm=&min_profit=&max_price=&budget=` (guild)
Money parameters are copper. `realm` is an Auctionator realm key ("Zul'jin Horde"); without it, the guild's realm
(with its faction) is used when it has a scan, else the realm with the newest scan. `min_profit` defaults to 5000.
```json
{
  "realms": [ { "key": "Zul'jin Horde", "newest": "2026-11-09", "items": 6120 } ],
  "realm": "Zul'jin Horde",
  "scan": { "day": "2026-11-09", "age_days": 0, "items": 6120 },
  "deals": [
    { "item_id": 14047, "name": "Runecloth", "quality": "common", "category": "Trade Goods",
      "buy": 30000, "worth": 50000, "resale": 47500, "profit": 17500, "roi": 58.3, "discount": 40,
      "confidence": 92, "sure": "high", "history_days": 20, "listed_days": 14, "listed": 25, "sell_price": null,
      "history": [ { "day": "2026-10-27", "price": 50000 } ],
      "flags": [ { "kind": "low", "text": "Lowest price in 30 days" } ],
      "seen": "2026-11-09", "age_days": 0 }
  ],
  "vendor": [ { "…": "same shape; profit = sell_price − buy, sure: \"certain\"" } ],
  "plan": { "budget": 400000, "items": [4338, 14047], "spend": 30500, "profit": 19000 },
  "notes": [],
  "rules": { "ah_cut": 0.05, "min_discount": 0.2, "min_history_days": 4, "min_profit": 5000 }
}
```
- Only items in the realm's **newest scan** are judged. `buy` is Auctionator's current lowest buyout.
- `worth` is the lower of the 30-day and 7-day medians of the daily prices before the current scan day, so a falling
  price isn't over-valued. `resale` = `worth` less the auction house's 5% cut; `profit` = `resale − buy`.
- A deal needs 4+ days of history, a discount of 20%+ and `profit ≥ min_profit`. `max_price` leaves out dearer items.
- `confidence` (0-100) weighs history (10+ days is full marks), `listed_days` of the last 14 (how easily it sells)
  and price swings. `sure`: `high` ≥ 70, `medium` ≥ 45, else `low`. Deals are sorted by
  `profit × (confidence/100)²`, so sure profits come first. Up to 50.
- `flags[].kind`: `low` (cheapest in 30 days), `falling` (7-day median under 85% of the 30-day), `slow` (listed on
  fewer than 6 of the last 14 days), `swingy` (typical swing over 35%).
- `vendor`: items listed below what a vendor pays (`item_info.sell_price`, from Blizzard's item data), by profit, up to 20.
- `plan` (only with `budget`): vendor flips then deals, best first, one of each, that fit the budget.
- `notes`: plain-English warnings, e.g. a scan older than today (`"Your newest scan of … is from yesterday. Prices
  move fast: scan again before you buy."`).
- No scans yet: `realm: null`, `scan: null`, empty lists.

The addon gets the best 15 deals and 10 vendor flips in the inbox (`deals`, see [sync.md](sync.md)) and shows them
beside the auction house, re-checked against Auctionator's live price from the current session.

---

## Supply drives

**Drive**
```json
{ "id": 3, "title": "Durotar crates", "unit": "crates", "goal": 200, "notes": "Hand in at Razor Hill",
  "status": "open", "created_by": 2, "creator": "Velanne", "created_at": "2026-11-07 18:00:00",
  "total": 70, "pct": 35, "contributors": 4, "mine": 12,
  "leaderboard": [ { "who": "Grunta", "amount": 30 }, { "who": "Mokra", "amount": 12 } ] }
```
`status` is `open`, `done` (goal reached) or `closed` (an officer ended it). The total is the sum of every hand-in
the guild shared, so the goal is reached once, the same everywhere. `pct` is capped at 100. `mine` is my own total.
`leaderboard` is the top 10, grouped by the character named when giving (or the giver's name when none was given).

### `GET /api/drives` (guild)
```json
{ "open": [ { "…": "Drive" } ], "past": [ { "…": "Drive" } ], "myCharacters": ["Grunta", "Stashy"] }
```
Newest first, up to 20 of each. `myCharacters` (main first, then by level) fills the "character" choice when giving.

### `POST /api/drives` (officer)
Queues a `DR` record.
```json
{ "title": "Durotar crates", "unit": "crates", "goal": 200, "notes": "Hand in at Razor Hill" }
```
`title` up to 80 characters, `unit` up to 40, `goal` a whole number from 1 (larger than 10,000,000 is capped),
`notes` up to 300.

`201`
```json
{ "ok": true, "drive": { "…": "Drive" }, "message": "Drive started." }
```
- Missing title, unit or goal → `400 "Give the drive a name, what you’re collecting, and a goal."`
- Activity `"New supply drive: <title>"` (kind `drive`), audit `drive started` with the title.
- When the game confirms it, Discord: `📦 **Supply drive: <title>**. Goal: 200 crates. Log what you hand in under
  Drives in Guild Camp.`
- Guildmates' apps notify (`drive`, `📦 Supply drive: <title>`, body `"Goal: 200 crates. Log what you hand in under
  Drives."`, route `/drives`).

### `POST /api/drives/:id/give` (guild)
Queues a hand-in (`dc`) for my player.
```json
{ "amount": 10, "character": "Grunta", "note": "From the Razor Hill run" }
```
`amount` a whole number from 1 (capped at 1,000,000), `character` up to 40 characters (optional), `note` up to 120.
```json
{ "ok": true, "reached": false, "drive": { "…": "Drive" }, "message": "Logged 10 crates." }
```
- Unknown drive → `404 "Drive not found."`. Drive done or closed → `409 "That drive has finished."`.
  No amount → `400 "How many did you hand in?"`
- When my hand-in brings the total to the goal: `reached: true`, message `"Goal reached. Thank you!"`, activity
  `"<title> reached its goal!"`. Guildmates' apps notify when a hand-in from someone else reaches the goal
  (`🎉 <title> reached its goal`, body `"200 crates. Thanks everyone!"`).
- Discord (when a webhook is set): `🎉 **<title>** reached its goal of 200 crates. Thanks everyone!`, posted once,
  by the app of the player whose hand-in first brought the total to the goal (hand-ins counted in the order they
  were made). That app checks when the game's `ok` for the hand-in arrives, after the whole upload is in, so a
  guildmate's earlier hand-in that comes in the same upload counts first (and then this app stays quiet). A
  closed drive gets no post.

### `POST /api/drives/:id/close` (officer)
Queues the drive again as closed (`DR` `c`, final), on top of the version this computer holds.
```json
{ "ok": true, "drive": { "…": "Drive, status closed" }, "message": "Drive closed." }
```
Closing a drive that already finished changes nothing and answers the same. Unknown drive → `404 "Drive not found."`.
Audit `drive closed` with `#<id>` (only when it was open).

## Donations

`GET /api/donations?days=30` (member; `days` 1–365). What guildies asked the guild bank for, with today's prices, and
who has given what. Implemented in `services/donations.js`.

- **Gifts** are the `deposit` lines of the guild bank log (`bank_log`, from whoever opened the bank with the addon,
  shared as `gb`). Bank characters' deposits are moves, not gifts, and don't count. Each gift is valued **once**, at
  the guild's Auctionator price index (`prices`) on the day it went in, else the newest earlier day within 14 days,
  else what a vendor pays (`item_info.sell_price`). Gold counts as itself. A gift without a price yet is tried again
  on every read for 30 days (`value: null` until then). Migration 21 adds `donations`.
- **Requests** are open bank requests, priced by name (`item_names`/`item_info`) at today's price.

```json
{
  "days": 30,
  "requests": [{ "id": 1, "item": "Major Mana Potion", "count": 10, "note": "for MC", "created_at": "2026-11-08 18:00:00",
                 "requester": "Shadowfen", "item_id": 13444, "unit_price": 9200, "total": 92000, "priced_from": "auction" }],
  "toBuy": 92000, "unpricedRequests": 0,
  "total": 3490500,
  "board": [{ "rank": 1, "userId": 2, "who": "Thrallia", "value": 2150000, "gold": 1500000, "items": 650000, "count": 9, "me": false }],
  "mine": { "value": 940000, "gold": 500000, "items": 440000, "count": 6, "rank": 2 },
  "recent": [{ "id": 10, "who": "Grimtusk", "kind": "item", "item_id": 13444, "item_name": "Major Mana Potion", "quality": "COMMON",
               "count": 8, "value": 73600, "priced_from": "auction", "at": "2026-11-09T10:00:00.000Z", "me": true }]
}
```
Money is in copper. `priced_from`: `auction` | `vendor` | `gold` | null. `board`: by player (a character nobody has
linked counts on its own), most given first, top 20.
