# Admin API (officer tools and calendar feeds)

Sync health, backups, the audit log, fresh start, Blizzard API and game data status, AI usage, and each
member's private calendar feed. Implemented in `server/src/routes/admin.js` and `server/src/routes/calendar.js`,
on top of `services/backup.js`, `services/reset.js`, `services/blizzard.js`, `services/gamedata.js`,
`services/calendar.js`, `services/ai.js`.

Conventions are the same as the rest of the API (see `core.md`): JSON, `{ "error": "…" }` on failure, stored
columns keep their `snake_case` names, computed fields are `camelCase`, SQLite times are UTC
`"YYYY-MM-DD HH:MM:SS"`.

Every `/api/admin*` endpoint needs an owner or officer (`401 "Sign in first."`, `403 "Officers only."`).

---

## `GET /api/admin` (officer)

Everything on the Officer tools page.

```json
{
  "isOwner": true,
  "latest": { "app": "0.12.0", "addon": "0.11.2" },
  "members": [
    { "id": 3, "battletag": "Thrall#1234", "name": "Thrall", "role": "owner", "joined_at": "2026-10-01 09:00:00",
      "characters": 3, "devices": 2, "sync_keys": 0, "discord_linked": true,
      "last_sync_at": "2026-11-07 18:02:11", "addon_version": "0.11.2", "app_version": "0.12.0", "companion_version": null,
      "addonOutdated": false, "appOutdated": false, "legacyCompanion": false, "neverSynced": false, "stale": false }
  ],
  "backupsEnabled": true,
  "canDownloadBackups": true,
  "backups": [ { "file": "wow-20261107-030000.db", "size": 1843200, "created": "2026-11-07T03:00:00.412Z" } ],
  "audit": {
    "entries": [
      { "id": 812, "user_id": 3, "battletag": "Thrall#1234", "name": "Thrall", "action": "promoted to officer",
        "detail": "Jaina#2222", "created_at": "2026-11-07 18:05:00" }
    ],
    "nextBefore": 762
  },
  "blizzard": {
    "configured": true, "region": "eu",
    "status": { "checkedAt": "2026-11-07T06:00:20.000Z", "region": "eu", "ok": true, "forever": null, "foreverKey": null,
                "classicEra": true, "tokenGold": 250000, "notes": ["No WoW: Forever namespace yet (tried …)."] }
  },
  "gameData": {
    "namespaces": { "static": "static-classic1x-eu", "dynamic": null, "profile": null,
                    "label": "Classic Era item data (Forever not in the API yet)" },
    "liveData": false,
    "itemsKnown": 412,
    "realm": "Mirage Raceway", "game_guild": "wow",
    "realm_status": { "found": true, "slug": "mirage-raceway", "name": "Mirage Raceway", "up": true, "queue": false,
                      "population": "High", "checkedAt": "2026-11-07T18:00:00.000Z" },
    "official_roster_at": "2026-11-07 12:00:00", "official_roster_note": "42 members", "officialRosterMembers": 42
  },
  "ai": { "hasKey": true, "coach_enabled": 1, "coach_budget_usd": 15, "spentUsd": 2.25, "month": "2026-11",
          "limits": { "questionsPerDay": 30, "plansPerDay": 5 } }
}
```

- `latest` comes from `ctx.latest()` (the newest published app and addon, or the bundled addon). `null` when
  there is none.
- `members` (sync health): most recent sync first, members who never synced last.
  - `addonOutdated` / `appOutdated`: the member reported a version and it is older than `latest`. A missing
    version is not "outdated" (show it as "not yet").
  - `stale`: synced before, but not in the last 7 days. `neverSynced`: no sync at all.
  - `legacyCompanion`: still syncing with the old companion (has a `companion_version`, never used the app).
- `backups`: newest first (the daily job keeps 14; a fresh start keeps up to 30). `backupsEnabled` is `false`
  when the server runs on an in-memory database. Only the owner may download (`canDownloadBackups`).
- `audit`: the first 50 entries, newest first. `name` is `"system"` for rows without a person. `?before=<id>`
  on this endpoint returns the page before that id instead; `nextBefore` is `null` on the last page.
- `blizzard.status` is `null` until the first check (the server checks 20 s after it starts, then daily).
- `gameData.liveData`: realm status and the official roster need live data, which Blizzard's API doesn't have
  for WoW: Forever yet (until then item details come from Classic Era).
- `ai.spentUsd`: Coach spend this calendar month (UTC).

Errors: non-numeric `before` → `400 "The audit log cursor must be a number."`

## `GET /api/admin/audit?before=<id>&limit=50` (officer)

More of the audit log. `limit` is 1–200 (default 50).

```json
{ "entries": [ { "id": 761, "user_id": null, "battletag": null, "name": "system", "action": "backup made",
                 "detail": "wow-20261106-030000.db", "created_at": "2026-11-06 03:00:01" } ],
  "nextBefore": null }
```

Errors: `400 "The audit log cursor must be a number."`, `400 "The page size must be a number."`

## `GET /api/admin/status` (officer)

The parts Guild settings shows: `{ "blizzard": {…}, "gameData": {…}, "ai": {…} }` with the shapes above.

---

## Backups

### `POST /api/admin/backups` (officer)

Makes a snapshot now (`VACUUM INTO <dir of DB_FILE>/backups/wow-YYYYMMDD-HHMMSS.db`, the newest 14 kept).
Audit: `backup made` (file name).

```json
{ "ok": true, "backup": { "file": "wow-20261107-181500.db", "size": 1843200, "created": "2026-11-07T18:15:00.120Z" },
  "backups": [ { "file": "wow-20261107-181500.db", "size": 1843200, "created": "2026-11-07T18:15:00.120Z" } ],
  "message": "Backup made." }
```

- In-memory database → `409 "Backups need a database file. This server keeps its data in memory."`
- Disk or SQLite failure → `500 "Backup failed: <reason>"`

### `GET /api/admin/backups/:file` (owner)

The snapshot itself: `200`, `Content-Type: application/vnd.sqlite3`, `Content-Disposition: attachment;
filename=wow-….db`, `Cache-Control: no-store`. The app saves it with `gc.api.download(path, file)`.
Audit: `downloaded backup` (file name).

- An officer → `403 "Only the guild owner can download backups."` (the file holds everyone's data).
- Anything that isn't a listed backup name (paths, `..`, other files in the folder) → `404 "Backup not found."`

---

## `POST /api/admin/reset` (owner)

"Fresh start": wipes all game data (characters, roster, raids and loot, bank, prices, drives, requests, calls
to arms, activity, Coach data) and keeps members, roles, settings, devices, sync keys and the invite link. A
backup is made first (kept with up to 30 copies). Afterwards, uploads of game data from before the reset (for
example an old Retail SavedVariables file) are ignored by sync.

```json
{ "confirm": "wow" }
```
`confirm` must be the guild name (case and surrounding spaces don't matter).

```json
{ "ok": true, "rows": 1234, "removed": { "characters": 40, "raids": 6, "...": 0 }, "backup": "wow-20261107-181700.db",
  "message": "Fresh start done: 1234 rows of game data removed (backup wow-20261107-181700.db kept). Members, settings, devices and sync keys are untouched." }
```
Audit: `wiped guild data for a fresh start` (`"1234 rows, backup wow-….db"`). `backup` is `null` on an
in-memory database.

- An officer → `403 "Only the guild owner can wipe the guild’s data."`
- Wrong or missing name → `400 "Nothing was wiped. Type the guild name (wow) to confirm."`
- The backup or the wipe fails → `500 "Wipe failed, nothing changed: <reason>"`

---

## Blizzard and game data

### `POST /api/admin/blizzard` (officer)

Checks Blizzard's Game Data API now (token price, Classic Era, a WoW: Forever namespace) and saves the result.

```json
{ "ok": true, "blizzard": { "configured": true, "region": "eu", "status": { "…": "see GET /api/admin" } },
  "gameData": { "…": "see GET /api/admin" }, "message": "Blizzard API checked." }
```
Without a Battle.net app the saved status has `ok: false` and the note `"No Battle.net app configured."`.
Blizzard unreachable → `502 "Blizzard API check failed: <reason>"` (the last good status is kept).

### `POST /api/admin/gamedata/refresh` (officer)

Fetches realm status and the official guild roster now (normally hourly; realm status every 5 minutes).
The realm and in-game guild name are set with `PUT /api/guild/settings { realm, game_guild }` (core.md).

```json
{ "ok": true, "log": ["Official roster: 42 members"], "message": "Official roster: 42 members",
  "gameData": { "…": "see GET /api/admin" } }
```
`message` explains when nothing could be fetched: `"No Battle.net app is set up on the server, so there is
nothing to refresh."`, `"Save the realm name first, then refresh."`, `"Blizzard’s API doesn’t have WoW: Forever
realms yet, so realm status and the official guild list will appear once it does."`. Problems with one part are
reported in `message` (`"Realm status failed: …"`, `"Realm \"X\" not found in dynamic-…"`) rather than as an error.

---

## Background jobs (server, `cfg.timers` only)

| Job | When | What |
|---|---|---|
| Backup check | 30 s after start, then hourly | `backupIfDue`: a snapshot when the newest is over 24 h old (14 kept). Skipped for an in-memory database. |
| Blizzard check | 20 s after start, then daily | Same as `POST /api/admin/blizzard`. |
| Game data | 60 s after start, then hourly | Item details for items the guild has seen, realm status, the official roster (when 12+ h old). |
| Realm status | every 5 minutes | When the realm goes from down to up, a `notice` event: `✅ <realm> is back up` / `Log in!` or `There is a login queue.`, route `/`. |

---

## Calendar feeds

Each member has a private address that lists the guild's raids and events (from 30 days ago on) with their own
sign-up and a reminder 30 minutes before. It works in Google, Apple and Outlook calendar and refreshes hourly.

### `GET /api/calendar` (guild member)

Makes the member's link on first use; the same link after that.

```json
{ "url": "https://wow.cjplumbing.co.za/calendar/Q2x1Zl9hYmNkZWZnaGlqa2xt.ics",
  "webcalUrl": "webcal://wow.cjplumbing.co.za/calendar/Q2x1Zl9hYmNkZWZnaGlqa2xt.ics",
  "googleUrl": "https://calendar.google.com/calendar/r?cid=webcal%3A%2F%2Fwow.cjplumbing.co.za%2Fcalendar%2FQ2x1Zl9hYmNkZWZnaGlqa2xt.ics" }
```
`webcalUrl` opens Apple or Outlook calendar; `googleUrl` adds it to Google Calendar.

### `POST /api/calendar/reset` (guild member)

A new link; the old one stops working at once. Audit: `calendar link replaced`.
```json
{ "url": "…", "webcalUrl": "…", "googleUrl": "…",
  "message": "New calendar link made. Add it to your calendar again; the old link stopped working." }
```

### `GET /calendar/<token>.ics` (public)

`200 text/calendar; charset=utf-8`, `Cache-Control: private, max-age=600`. Unknown token, or the member left
the guild → `404 text/plain` "Calendar not found. Get a fresh link in Guild Camp under Settings."
