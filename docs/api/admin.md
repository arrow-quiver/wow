# Admin API (officer tools and the calendar export)

Sync health, local backups, the audit log, fresh start, Blizzard API and game data status, AI usage, and the
raid calendar file. Implemented in `app/src/core/routes/admin.js` and `app/src/core/routes/calendar.js`, on top of
`services/backup.js`, `services/reset.js`, `services/blizzard.js`, `services/gamedata.js`, `services/calendar.js`
and `services/ai.js`. Conventions are in [core.md](core.md).

Everything here is about **this computer's** copy of the guild's data. Each player has their own database; there
is nothing to download from anyone else.

Every `/api/admin*` route needs an officer (`403` for members, `403 NO_GUILD` before the guild is known).

---

## `GET /api/admin` (officer)

Everything on the Officer tools page.

```json
{
  "isOwner": true,
  "latest": { "app": "0.12.0", "addon": "0.11.2" },
  "members": [
    { "id": 1, "battletag": "Calvin#1234", "name": "Calvin", "role": "owner", "joined_at": "2026-11-01 09:00:00",
      "characters": 3, "last_sync_at": "2026-11-07 18:02:11", "addon_version": "0.11.2", "app_version": "0.12.0",
      "addonOutdated": false, "appOutdated": false, "neverSynced": false, "stale": false, "isMe": true }
  ],
  "roster": [
    { "name": "Grommash", "class": "WARRIOR", "level": 60, "rank": "Officer", "rank_index": 1, "online": 1,
      "last_seen": "2026-11-07T17:55:00.000Z", "mine": false, "addon_version": null, "addonOutdated": false }
  ],
  "knownLocally": true,
  "backupsEnabled": true,
  "backupDir": "C:\\Users\\me\\AppData\\Roaming\\Guild Camp\\backups",
  "backups": [ { "file": "guildcamp-20261107-030000.db", "path": "C:\\Users\\me\\AppData\\Roaming\\Guild Camp\\backups\\guildcamp-20261107-030000.db",
                 "size": 1843200, "created": "2026-11-07T03:00:00.412Z" } ],
  "audit": {
    "entries": [
      { "id": 812, "user_id": 1, "battletag": "Calvin#1234", "name": "Calvin", "action": "raid locked",
        "detail": "Molten Core", "created_at": "2026-11-07 18:05:00" }
    ],
    "nextBefore": 762
  },
  "blizzard": {
    "configured": true, "region": "eu", "note": null,
    "status": { "checkedAt": "2026-11-07T06:00:20.000Z", "region": "eu", "ok": true, "forever": null, "foreverKey": null,
                "classicEra": true, "tokenGold": 250000, "notes": ["No WoW: Forever namespace yet (tried …)."] }
  },
  "gameData": {
    "namespaces": { "static": "static-classic1x-eu", "dynamic": null, "profile": null,
                    "label": "Classic Era item data (Forever not in the API yet)" },
    "liveData": false,
    "itemsKnown": 412,
    "realm": "Mirage Raceway", "game_guild": "Just Now WoW",
    "realm_status": { "found": true, "slug": "mirage-raceway", "name": "Mirage Raceway", "up": true, "queue": false,
                      "population": "High", "checkedAt": "2026-11-07T18:00:00.000Z" },
    "official_roster_at": null, "official_roster_note": null, "officialRosterMembers": 0
  },
  "ai": { "hasKey": true, "coach_enabled": 1, "coach_budget_usd": 15, "spentUsd": 2.25, "month": "2026-11",
          "limits": { "questionsPerDay": 30, "plansPerDay": 5 } }
}
```

- `latest`: the newest app and addon versions this app knows (from GitHub, or the bundled addon). `null` when
  unknown.
- `members` (sync health): what this computer knows about each player, most recent sync first. Only my own
  `last_sync_at` and `app_version` are known; a guildmate's `addon_version` comes from their shared character
  records. `addonOutdated` / `appOutdated`: a reported version older than `latest` (a missing version is not
  outdated). `stale`: synced before, but not in the last 7 days. `neverSynced`: no sync at all.
- `roster`: every character from roster scans or linked to a player, online first, then most recently seen. My
  characters that an upload put in another in-game guild are left out (SHARING.md §3), here and in the members'
  character counts. `addon_version` is what that character's own data reported (`null` when unknown). `mine`:
  one of my characters.
- `knownLocally`: always `true`; the page says these numbers are what this computer knows.
- `backups`: newest first, with the full `path` so the app can show the file in its folder
  (`gc.app.showItemInFolder(path)`). `backupsEnabled` is `false` for an in-memory database (tests).
- `audit`: the first 50 entries, newest first. My own actions have their own `action` words (`raid locked`,
  `notice posted` …). Guildmates' officer changes that arrived through the game have `action` `from the guild` and a
  sentence in `detail` ("Grommash cancelled Molten Core (passed on by Thrallia)."); records refused on import have
  `ignored from the guild` and the reason. Both are filed under the author's player when Guild Camp knows them.
  `name` is `"Guild Camp"` for rows without a person. `?before=<id>` on this route returns the page before that id instead; `nextBefore` is `null` on the last page.
- `blizzard`: `configured` is whether this copy of Guild Camp has the Battle.net app built in; `note` says why game
  data is off when it doesn't. `status` is `null` until the first check (20 s after start, then daily).
- `gameData.liveData`: realm status and the official roster need live data, which Blizzard's API doesn't have for
  WoW: Forever yet (until then item details come from Classic Era).
- `ai`: the Coach's settings and spend this calendar month (UTC), with the player's own key.

Errors: non-numeric `before` → `400 "The audit log cursor must be a number."`

## `GET /api/admin/audit?before=<id>&limit=50` (officer)

More of the audit log. `limit` is 1–200 (default 50).

```json
{ "entries": [ { "id": 761, "user_id": 4, "battletag": "Grommash", "name": "Grommash", "action": "from the guild",
                 "detail": "Grommash cancelled Molten Core (passed on by Thrallia).", "created_at": "2026-11-06 03:00:01" } ],
  "nextBefore": null }
```

Errors: `400 "The audit log cursor must be a number."`, `400 "The page size must be a number."`

## `GET /api/admin/status` (officer)

The parts Guild settings shows: `{ "blizzard": {…}, "gameData": {…}, "ai": {…} }` with the shapes above.

---

## Backups

### `POST /api/admin/backups` (officer)

Makes a snapshot of this computer's database now (`VACUUM INTO <userData>/backups/guildcamp-YYYYMMDD-HHMMSS.db`;
the newest 14 are kept). Audit: `backup made` (file name).

```json
{ "ok": true,
  "backup": { "file": "guildcamp-20261107-181500.db", "path": "C:\\…\\backups\\guildcamp-20261107-181500.db", "size": 1843200,
              "created": "2026-11-07T18:15:00.120Z" },
  "backups": [ { "file": "guildcamp-20261107-181500.db", "path": "…", "size": 1843200, "created": "2026-11-07T18:15:00.120Z" } ],
  "message": "Backup made." }
```

- In-memory database → `409 "Backups need a database file, and this one is kept in memory."`
- Disk or SQLite failure → `500 "The backup didn't work: <reason>"`

There is no download route: the backup is already a file on this computer.

---

## `POST /api/admin/reset` (Guild Master)

"Fresh start": wipes this computer's game data for the guild (characters and roster, raids and loot, bank,
prices, drives, requests, calls to arms, notices, activity, sync log, Coach data) and keeps people, roles,
settings and my player ids. A backup is made first (kept with up to 30 copies). Afterwards, uploads of game data
from before the reset (for example an old Retail SavedVariables file) are ignored. It changes nothing on
guildmates' computers or in their games.

Guild data shared in game ([SHARING.md](../SHARING.md) §12) is rebuilt, not lost:
- This computer's copy of the shared records goes, with the sharing statistics, answered author checks and the
  outbox history (sent, refused, dropped).
- My unsent changes (queued or waiting) stay, and their rows are made again at once. Author checks I haven't
  answered stay too.
- The next upload (after I log out or type `/reload` in game) brings every record back from the addon's store,
  whatever its age, and the rows are made again. My own records that come back don't open author checks: before
  the wipe, the records in my name this computer holds (with no open or undone check about them) go into its log
  of my own versions (`share_sent`), which a fresh start keeps. `share_since:<guild id>` doesn't move, so a
  forged record in my name from before the reset is still asked about. Records from before the reset don't
  notify again, and a call to arms from before it is not posted to Discord again (`share_reset:<guild id>`).

```json
{ "confirm": "Just Now WoW" }
```
`confirm` must be the guild name (case and surrounding spaces don't matter).

```json
{ "ok": true, "rows": 1234, "removed": { "characters": 40, "raids": 6, "shared_records": 812, "...": 0 },
  "backup": "guildcamp-20261107-181700.db",
  "message": "Fresh start done: 1234 rows of game data removed from this PC (backup guildcamp-20261107-181700.db kept). People, settings and your unsent changes stay. Guild data shared in game comes back after you log out or type /reload." }
```
`removed` counts the rows per table, the sharing tables (`shared_records`, `share_author_checks`,
`share_outbox`) included. Audit: `wiped guild data for a fresh start` (`"1234 rows, backup guildcamp-….db"`).
`backup` is `null` on an in-memory database.

- An officer → `403 "Only the Guild Master can wipe the game data on this PC."`
- Wrong or missing name → `400 "Nothing was wiped. Type the guild name (Just Now WoW) to confirm."`
- The backup or the wipe fails → `500 "Wipe failed, nothing changed: <reason>"`

---

## Blizzard and game data

These need the Battle.net app built into this copy of Guild Camp (client credentials flow). Without it,
`blizzard.configured` is `false` and nothing is fetched.

### `POST /api/admin/blizzard` (officer)

Checks Blizzard's Game Data API now (token price, Classic Era, a WoW: Forever namespace) and saves the result.

```json
{ "ok": true, "blizzard": { "configured": true, "region": "eu", "note": null, "status": { "…": "see GET /api/admin" } },
  "gameData": { "…": "see GET /api/admin" }, "message": "Blizzard API checked." }
```
Without the Battle.net app the saved status has `ok: false` and the note `"Blizzard game data is off: this copy of
Guild Camp has no Battle.net app built in."`. A failure → `502 "The Blizzard API check didn't work: <reason>"`.

### `POST /api/admin/gamedata/refresh` (officer)

Fetches realm status and the official guild roster now (normally hourly; realm status every 5 minutes). The realm
and in-game guild name are set with `PUT /api/guild/settings { realm, game_guild }` ([core.md](core.md)); they
normally come from the game.

```json
{ "ok": true, "log": ["Official roster: 42 members"], "message": "Official roster: 42 members",
  "gameData": { "…": "see GET /api/admin" } }
```
`message` explains when nothing could be fetched: `"Blizzard game data is off: this copy of Guild Camp has no
Battle.net app built in. There is nothing to refresh."`, `"Save the realm name first, then refresh."`,
`"Blizzard’s API doesn’t have WoW: Forever realms yet, so realm status and the official guild list will appear once
it does."`. A failure → `502 "Refresh failed: <reason>"`.

---

## Background jobs (`cfg.timers` only, never in tests)

| Job | When | What |
|---|---|---|
| Backup check | 30 s after start, then hourly | A snapshot when the newest is over 24 h old (14 kept). Skipped for an in-memory database. |
| Blizzard check | 20 s after start, then daily | Same as `POST /api/admin/blizzard`. Only with the Battle.net app built in. |
| Game data | 60 s after start, then hourly | Item details for items the guild has seen, realm status, the official roster. Only with the Battle.net app built in. |
| Realm status | every 5 minutes | When the realm goes from down to up, a `notice` notification: `✅ <realm> is back up` / `Log in!` or `There is a login queue.`, route `/`. |

---

## Calendar export

### `GET /api/calendar.ics` (guild)

The guild's raids and events from 30 days ago on, as an iCalendar file (`text/calendar; charset=utf-8`,
`Cache-Control: no-store`), with my own sign-up in each description and a reminder 30 minutes before. Cancelled
raids are marked `CANCELLED`. Event ids stay the same between exports, so importing again updates events instead
of adding copies.

There is no feed address to subscribe to. The app's `gc.calendar.export()` saves this file with a save dialog
(`"<guild> raids.ics"`), and the player imports it into Google, Apple or Outlook calendar.
