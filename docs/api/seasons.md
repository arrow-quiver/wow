# Seasons API

A monthly guild leaderboard from what guildies actually did, with titles, streaks, badges and a hall of fame.
Implemented in `app/src/core/services/seasons.js` and `routes/seasons.js`. Every app works the season out the same
way from the guild's shared data, so everyone sees the same board. Conventions are in [core.md](core.md).

## Points

| What | Points | From |
|---|---|---|
| Gold given to the guild bank | 1 per gold of value | `donations` (bank log deposits, items at that day's Auctionator price: [economy.md](economy.md#donations)) |
| A kill in the open world | 2 | the war map's kill marks (`war_marks`, from everyone's `wm` record: [war.md](war.md)) |
| A crafting request filled | 5 | `craft_requests` done, by the crafter, in the month |
| A raid attended | 10 | `attendance` of raids that started in the month |

- **Season**: a calendar month (UTC).
- **Streak**: weeks in a row (Monday to Sunday, UTC) with any points, ending this week or last week; it runs
  across months. Each week after the first adds 5% to the season's points, up to +25%.
- **Titles**: the leader of each category (Quartermaster, Warlord, Master Crafter, Stalwart); MVP for the top score.
- **Badges** are for life: Benefactor / Patron / Guild Treasure (100 / 500 / 2,000 gold given), Bloodied / Slayer /
  Warbringer (10 / 100 / 500 kills), Helping Hands / Artisan of the Guild (10 / 50 crafts), Raid Regular / Veteran /
  Raid Legend (5 / 20 / 50 raids), Steady / Devoted / Unbreakable (4 / 8 / 12 weeks in a row).

## GET /api/seasons?month=YYYY-MM

Member. This month by default.

```json
{
  "month": "2026-11", "start": "2026-11-01T00:00:00.000Z", "end": "2026-12-01T00:00:00.000Z", "current": true, "daysLeft": 21,
  "points": { "gold": 1, "kill": 2, "craft": 5, "raid": 10 }, "streak": { "step": 0.05, "max": 0.25 },
  "categories": [{ "id": "donor", "title": "Quartermaster", "label": "Most given to the guild bank", "unit": "gold" }],
  "players": [{ "userId": 2, "name": "Thrallia", "class": "SHAMAN", "gold": 215, "kills": 9, "crafts": 1, "raids": 2,
                "base": 258, "streak": 4, "bonus": 0.15, "score": 297, "titles": ["MVP", "Quartermaster"], "rank": 1,
                "badges": [{ "id": "donor1", "name": "Benefactor", "what": "gold", "n": 100 }] }],
  "leaders": { "donor": { "userId": 2, "name": "Thrallia", "value": 215 } },
  "mvp": { "userId": 2, "name": "Thrallia", "score": 297 },
  "me": 1, "mine": { "...": "my row in players, or null" }, "myBadges": [], "allBadges": [],
  "hall": [{ "month": "2026-10", "mvp": { "name": "Mokra", "score": 412 }, "leaders": {}, "players": 7 }],
  "canAnnounce": false, "announced": null, "discord": true
}
```
`players`: everyone with points or a streak, best first. `hall`: the last 6 finished months that had a winner.
`canAnnounce`: an officer looking at a finished month.

## POST /api/seasons/announce

Officer. `{ month, force? }` posts a finished month's winners to the guild's Discord, once per month from this
app (409 when the month is still running, already announced without `force: true`, nobody scored, or there is no
webhook; 502 when Discord refuses).

## Shout-outs

Every 5 minutes, with a Discord webhook set, the app posts its own player's news, so no two apps post the same thing:
- each new gift to the guild bank (from the last 2 days): `🎁 **Grom** topped up the guild bank: 20 × Runecloth (worth 2g 40s). Thank you!`
- each badge just earned: `🏅 **Grom** earned the **Slayer** badge!` (the badges a player already had when this
  started are remembered without posting).

## In game

The inbox's `seasons` field (`{ month, players: { [character]: { title, rank, score, streak, badges, best } } }`)
puts a line on guildies' player tooltips ("Guild Camp: MVP · #1 this season · 3-week streak · 2 badges") and
`/wow season` prints the top five and your place (addon option `seasonTooltips`).

## The guild bank store

Spend season points on what officers put up. `services/store.js`, `routes/store.js`.

- **Items** are one shared officer record `ST` (key `1`): up to 25 `key,item,id,cost,stock` entries
  ([SHARING.md](../SHARING.md)), projected into `store_items` (migration 24). `left` = stock minus orders open or sent.
- **An order is a guild bank request** (`bq`) whose note starts `[store:<key>:<cost>]`, so it travels, shows in
  game and is handled like any other request: officers mark it sent or declined (`POST /api/bank/requests/:id/sent|declined`),
  the buyer can cancel it.
- **Balance**: `earned` = lifetime season points without streak bonuses; `held` = orders still open; `spent` = orders
  sent; `available` = earned − held − spent. Declined and cancelled orders give the points back.

### GET /api/store
```json
{
  "items": [{ "key": "a1b2c3", "item": "Major Mana Potion", "itemId": 13444, "cost": 40, "stock": 20, "left": 14 }],
  "balance": { "earned": 512, "spent": 160, "held": 80, "available": 272 },
  "mine": [{ "id": 7, "key": "a1b2c3", "item": "Major Mana Potion", "count": 2, "cost": 40, "total": 80, "note": "raid night",
             "status": "open", "requesterId": 1, "requester": "Grimtusk", "created_at": "2026-11-10 08:00:00" }],
  "pending": [], "canEdit": false
}
```
`pending` (officers): open orders, each with the buyer's `balance`.

### PUT /api/store
Officer. `{ items: [{ key?, item, itemId?, cost, stock }] }` replaces the whole list (keys kept, new ones made).
400 for a missing name or price or more than 25 items.

### POST /api/store/order
`{ key, count?, note? }` → 201 with the store view and a `message`. 404 unknown item; 409 not enough points, sold
out, or no character yet.
