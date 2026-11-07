# Economy API

The guild bank (tabs, gold, log), bank requests, bank characters, a search across your own alts, the guild price
index and supply drives. Implemented in `server/src/routes/economy.js`; the data itself arrives with app uploads
(`POST /api/sync` → `services/economy.js` `applyEconomy`). General conventions (errors, auth, times) are in
[core.md](core.md).

Where the data comes from:
- **Guild bank**: whoever opens the guild bank in game with the addon. Only a newer scan replaces the stored one.
  The game's log only says "x hours ago", so log times (`at`) are approximate.
- **Bags and banks**: each member's own characters. A character's bank refreshes when its player opens the bank.
- **Prices**: members' Auctionator scans, read by the app. One price per item per scan day (the lowest seen that
  day). "Recent" means the last 30 days.

Item `name` is `null` when the server has never seen the item's name (show `Item <id>`). Money is integer copper.
`unit` is the item's most recent guild auction price (last 30 days) or `null`; `value` is `unit × count` or `null`.

---

## Guild bank

### `GET /api/bank` (guild member)
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
- `bankCharacters` lists every character marked as a bank character (bags and bank added together per item), sorted
  by name. A new bank character has `items: []` until its owner syncs it; `updated_at` is when it was last synced. `owner` is the owner's BattleTag name or
  `null` when nobody owns the character any more.
- `value` adds up every priced stack. Unpriced items count as nothing.
- `requests`: open requests first, then the ones handled in the last 7 days, newest first. Cancelled requests are
  left out.
- `log`: the newest 40 entries. `kind` is the game's word: `deposit`, `withdraw`, `move` (items), `repair`,
  `withdrawForTab`, `buyTab`, `depositSummary` (gold). Item entries have `item_id`/`name`/`count`; gold entries have
  `amount`.

### `GET /api/bank/search?q=<text>` (guild member)
"Which alt has my Runecloth?" Items on **your own** synced characters whose name contains `q` (up to 60
characters, wildcards are literal). Up to 100 rows, by item name then character.
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
`status` is `open`, `sent`, `declined` or `cancelled`. `requester` / `handler` are BattleTag names. `mine` is true
for the caller's own requests.

### `POST /api/bank/requests` (guild member)
```json
{ "item": "Runecloth", "count": 20, "note": "For bandages" }
```
`item` up to 100 characters (required), `count` a whole number clamped to 1–1000 (missing or not a number → 1),
`note` up to 200 characters.

`201`
```json
{ "ok": true, "request": { "…": "Bank request" }, "message": "Request sent to the officers." }
```
- No item → `400 { "error": "Name the item you need." }`
- Activity: `"<name> asked the bank for 20 × Runecloth"` (kind `bank`).
- Discord: `🏦 **Bank request:** 20 × Runecloth, for <name>`
- Event `bank` to the owner and officers (not the asker): title `🏦 Bank request from <name>`, body `20 × Runecloth`,
  route `/bank?tab=requests`.

### `POST /api/bank/requests/:id/sent` · `/declined` (owner or officer) · `/cancel` (the person who asked)
```json
{ "ok": true, "request": { "…": "Bank request, with status and handler" }, "message": "Marked as sent." }
```
Messages: `"Marked as sent."`, `"Request declined."`, `"Request cancelled."`
- Unknown request → `404 "Request not found."`. Not open any more → `409 "That request has already been handled."`
- `sent`/`declined` by a member → `403 "Officers only."`. `cancel` by anyone but the asker →
  `403 "Only the person who asked can cancel a request."`
- `sent`: activity `"20 × Runecloth sent from the bank"`.
- `sent`/`declined`: audit `bank request sent` / `bank request declined` with `"20 × Runecloth"`, and an event `bank`
  to the asker (unless they handled it themselves): `🏦 Your bank request is on its way` /
  `🏦 Your bank request was declined`, body `"20 × Runecloth. Sent by <officer>."`, route `/bank?tab=requests`.

---

## Bank characters (for guilds without a guild bank)

Characters that hold guild stock. Their bags and bank show on the Bank page and count toward the bank's value and the
addon's guild bank stock.

### `GET /api/bank/alts` (owner or officer)
Every linked character plus any already marked, marked ones first, then by name.
```json
{ "characters": [ { "name": "Stashy", "class": "MAGE", "level": 12, "owner": "Mokra", "is_bank": 1, "items": 2 } ] }
```
`items` is how many item rows (bags + bank) the server holds for the character.

### `PUT /api/bank/alts` (owner or officer)
The complete list of bank characters. Names match case-insensitively; characters left out stop being bank characters.
```json
{ "names": ["Stashy", "Grunta"] }
```
```json
{ "ok": true, "bankCharacters": ["Grunta", "Stashy"], "added": ["Grunta"], "removed": [],
  "message": "Grunta is now a bank character. Its bags and bank show here after its next sync." }
```
Messages: one added → `"<name> is now a bank character. Its bags and bank show here after its next sync."`; one
removed → `"<name> is no longer a bank character."`; several → `"Bank characters saved. New ones show their bags and
bank after their next sync."`; nothing changed → `"No changes."`
- `names` not a list → `400 "Send the bank characters as a list of names."`; more than 50 →
  `400 "Mark at most 50 bank characters."`; unknown name → `400 "There is no character called <name> in the guild."`
  (nothing is saved).
- Audit per character: `bank character added` / `bank character removed` with the name.

---

## Prices

### `GET /api/prices?q=<text>` (guild member)
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
- Without `q`: `held` is up to 30 priced items that members carry most (count of characters' bags, banks and guild
  bank tabs holding it), then by name. `results` is `[]`.
- `history` is the item's newest 14 scan days, oldest first; `latest` is the newest of them.
- `change` is the percent change from the first to the last point of `history`, one decimal place, or `null` with
  fewer than two points.
- `bank` values the guild bank and bank characters as in `GET /api/bank`; `priced`/`unpriced` count stacks,
  `top` is the five most valuable stacks, each with the guild bank `tab` or bank `character` holding it (the other is `null`).

---

## Supply drives

**Drive**
```json
{ "id": 3, "title": "Durotar crates", "unit": "crates", "goal": 200, "notes": "Hand in at Razor Hill",
  "status": "open", "created_by": 2, "creator": "Velanne", "created_at": "2026-11-07 18:00:00",
  "total": 70, "pct": 35, "contributors": 4, "mine": 12,
  "leaderboard": [ { "who": "Grunta", "amount": 30 }, { "who": "Mokra", "amount": 12 } ] }
```
`status` is `open`, `done` (goal reached) or `closed` (an officer ended it). `pct` is capped at 100. `mine` is the
caller's own total. `leaderboard` is the top 10, grouped by the character named when giving (or the giver's BattleTag
name when none was given).

### `GET /api/drives` (guild member)
```json
{ "open": [ { "…": "Drive" } ], "past": [ { "…": "Drive" } ], "myCharacters": ["Grunta", "Stashy"] }
```
Newest first, up to 20 of each. `myCharacters` (main first, then by level) fills the "character" choice when giving.

### `POST /api/drives` (owner or officer)
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
- Discord: `📦 **Supply drive: <title>**. Goal: 200 crates.` and the server's `/drives` address on the next line.
  `GET <BASE_URL>/drives` (public, no sign-in) serves a small HTML page with an "Open Drives in Guild Camp" link
  (`guildcamp://drives`) and a link to `/get`, like the raid links (`GET /raids/:id`).
- Event `drive` to everyone but the officer: `📦 Supply drive: <title>`, body
  `"Goal: 200 crates. Log what you hand in under Drives."`, route `/drives`.

### `POST /api/drives/:id/give` (guild member)
```json
{ "amount": 10, "character": "Grunta", "note": "From the Razor Hill run" }
```
`amount` a whole number from 1 (capped at 1,000,000), `character` up to 40 characters (optional), `note` up to 120.
```json
{ "ok": true, "reached": false, "drive": { "…": "Drive" }, "message": "Logged 10 crates." }
```
- Unknown drive → `404 "Drive not found."`. Drive done or closed → `409 "That drive has finished."`.
  No amount → `400 "How many did you hand in?"`
- When the total reaches the goal the drive becomes `done` (exactly once, even with hand-ins at the same moment):
  `reached: true`, message `"Goal reached. Thank you!"`, activity `"<title> reached its goal!"`, Discord
  `🎉 **<title>** reached its goal of 200 crates. Thanks everyone!`, event `drive` to everyone but the giver:
  `🎉 <title> reached its goal`, body `"200 crates. Thanks everyone!"`.

### `POST /api/drives/:id/close` (owner or officer)
```json
{ "ok": true, "drive": { "…": "Drive, status closed" }, "message": "Drive closed." }
```
Closing a drive that already finished changes nothing and answers the same. Unknown drive → `404 "Drive not found."`.
Audit `drive closed` with `#<id>` (only when it was open).
