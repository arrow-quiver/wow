# War API

War alerts and the war map: where the guild fights in the open world, and who keeps killing you. Implemented in
`app/src/core/routes/war.js` and `services/war.js`. Conventions (roles, errors, times) are in [core.md](core.md).

Where the data comes from:
- **My deaths**: the app's live link (`main/live.js`, reading the game's combat log) sees each death as it happens,
  with the killer, every player who hit me in the last 15 seconds, the zone (`ZONE_CHANGE` lines) and the killing
  blow. `main/main.js` posts each one to `POST /api/war/death`. Only this computer has them (`pvp_deaths`).
- **The guild's marks**: the addon (`War.lua`) marks the spot of every death and honorable kill in the open world
  (`C_Map` position, so not in dungeons or battlegrounds), keeps the account's newest 30 of the last 14 days, and
  shares them as one `wm` record per player ([SHARING.md](../SHARING.md)), at most every 5 minutes. Every app
  makes `war_marks` from them; the addon draws them on the world map.

Discord only hears what the player on this computer did, like every other Guild Camp post.

## POST /api/war/death

From the app itself (the live link). Saved once per character and time; a death to players is posted to the
guild's Discord when `alert` is true (Settings → Overlay & live → War alerts), a webhook is set in Settings →
Discord, and the last posted death was over 2 minutes before.

```json
{ "character": "Grom", "at": 1794067195000, "pvp": true, "killer": "Sneaky", "enemies": ["Sneaky", "Holy"],
  "zone": "Hillsbrad Foothills", "zoneId": 1424, "spell": "Eviscerate", "amount": 612, "seconds": 4.2,
  "damageTaken": 2100, "healed": 0, "alert": true }
```
→ `{ "saved": true, "posted": true }`. 400 without `character` or `at`.

Discord: `⚔️ **Grom** died to **Sneaky** and **Holy** in **Hillsbrad Foothills** (Eviscerate for 612). Anyone near?`

## POST /api/war/help

"Call for help" on the War page and the Coach overlay. Posts to Discord at once, with the zone and players of my
last death to players when it is under 10 minutes old. `{ character?, zone?, message? }` override them.
→ `{ "posted": true }`. 409 without a webhook, 429 within a minute of the last call, 502 when Discord refuses.

Discord: `🆘 **Grom** needs help in **Hillsbrad Foothills**: 2 enemies (Sneaky, Holy).`

## GET /api/war?days=7

`days` 1–60 (default 7).

```json
{
  "days": 7, "alerts": true,
  "guild": { "deaths": 6, "kills": 7, "players": 4 },
  "zones": [
    { "mapId": 1424, "zone": "Hillsbrad Foothills", "deaths": 4, "kills": 4,
      "marks": [{ "x": 452, "y": 381, "at": 1794067000, "kind": "d", "who": "Grommash", "n": null }] }
  ],
  "hotspots": [{ "mapId": 1424, "zone": "Hillsbrad Foothills", "x": 454, "y": 380, "deaths": 2, "kills": 2, "last": 1794067000 }],
  "mine": {
    "deaths": 5, "pvpDeaths": 4,
    "recent": [{ "character": "Grom", "at": 1794067195000, "pvp": true, "killer": "Sneaky", "enemies": ["Sneaky", "Holy"],
                 "zone": "Hillsbrad Foothills", "spell": "Eviscerate", "amount": 612, "posted": true }],
    "nemeses": [{ "name": "Sneaky", "kills": 2 }]
  }
}
```
- `x`, `y`: thousandths of the map (the game shows them as 45.2, 38.1). Mark times (`at`, `last`) are seconds; my
  deaths' `at` is milliseconds (from the combat log).
- `zones`: busiest first. A map no guildmate named shows as `Map <id>`.
- `hotspots`: map cells of 5% × 5% with two or more marks, busiest first (at most 6), at the cell's average spot.
- `who`: the player's main character (or highest), else their BattleTag name.
- `alerts`: whether a Discord webhook is set.

## Kill on sight and bounties

Services: `services/hunt.js`; routes: `routes/hunt.js`; migration 29; page: The hunt (`/hunt`); addon: `Hunt.lua`.
Records: `ko` (kill on sight, any member), `BT` (bounties, officers), `kk` (a kill that counts, by the killer's
addon). See [SHARING.md](../SHARING.md).

Season points ([seasons.md](seasons.md)): each kill of a kill-on-sight target 8 (`kos`), and a bounty's points
(`bounty`), on top of the usual 2 for a kill. A player bounty pays the first kill made while it was up (from 5
minutes before it was posted, for clock differences, to `ends`); a zone bounty pays each kill in its zone, in kill
order, up to `cap` kills. Players' season rows carry `hunt`: the points from these.

### `GET /api/hunt` (guild)
```json
{ "canPost": true, "kosPoints": 8,
  "kos": [{ "name": "Gankalot", "reason": "Camps the Crossroads", "addedBy": "Mokra", "addedAt": "…", "kills": 4, "lastKill": 1762800000 }],
  "bounties": [{ "id": 3, "key": "z3z3z3", "target": null, "zone": "Hillsbrad Foothills", "points": 5, "cap": 10,
    "ends": 1763200000, "note": "Take back Tarren Mill", "createdAt": "…", "status": "open|claimed|expired|closed",
    "claims": [{ "name": "Mokra", "target": "Lightbro", "at": 1762900000, "points": 5 }], "left": 9 }] }
```

### `POST /api/kos` (guild)
`{ "name": "Gankalot", "reason"?: "…" }` → `201 { "ok": true, "message": "Gankalot is now kill on sight for the guild." }`.
The name is fixed up ("gankalot-Realm" → "Gankalot"); not a valid name → `400`.

### `POST /api/kos/:name/remove` (guild)
→ `{ "ok": true }`; not on the list → `404`.

### `POST /api/bounties` (guild, officers)
`{ "target": "Stabby" }` or `{ "zone": "Hillsbrad Foothills", "cap": 10 }`, plus `"points"` (1–1000), `"days"` (1–30,
default 7), `"note"`. → `201 { "ok": true, "key": "…", "message": "…" }`. Not an officer → `403`; no target or
zone, or no points → `400`.

### `POST /api/bounties/:id/close` (guild, officers)
Closes it for good (`BT` state `x`); kills already made still count. → `{ "ok": true }`.

### Discord
Each app posts its own: a new kill-on-sight entry ("☠️ **Kill on sight:** Gankalot — Camps the Crossroads"), a new
bounty ("💰 **Bounty:** 50 points for killing Stabby"), and the player's own kills that count ("🎯 **Mokra** slew
Stabby in Ashenvale and claims the bounty! For the Horde!").
