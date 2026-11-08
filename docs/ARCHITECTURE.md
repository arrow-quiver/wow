# Guild Camp: architecture

Guild Camp is a guild platform for **World of Warcraft: Forever** (PvP ruleset; Retail later). There is no
server. Each player runs the desktop app, the app keeps its own copy of the guild's data, and the addon carries
guild data between players inside the game. Releases live on GitHub.

The decisions behind this design are in [PIVOT.md](PIVOT.md). The in-game sharing protocol is in
[SHARING.md](SHARING.md). Endpoint shapes are in [api/](api/). Releasing is in [RELEASING.md](RELEASING.md).

## The three parts

| Part | Where | What it does |
|---|---|---|
| **The app** ("Guild Camp") | `app/` | An Electron desktop app for Windows. It shows everything a player sees and does, syncs with the game in the background, and installs and updates the addon. Inside it runs the **local core**: the old server's domain logic, an Express app on `127.0.0.1` over a SQLite database in the player's user data folder. |
| **The addon** (WowGuild, listed as "Guild Camp") | `addon/WowGuild/` | Runs in the game (interfaces 16001 for Forever and 120105 for Retail). It collects what the game shows outside combat, saves it for the app, shows the guild news the app writes back, and trades guild data with guildmates over WoW's hidden addon channel. |
| **GitHub Releases** | `arrow-quiver/wow` releases | App installers (tag `v<version>`, marked Latest) and addon zips (tag `addon-v<version>`, never Latest). Apps update themselves and the addon from here. Releases are published with the GitHub CLI (`gh`). |

How data moves:

```
  Player A's PC                                 Player B's PC
  +------------------------------------+        +------------------------------------+
  | Guild Camp app                     |        | Guild Camp app                     |
  |   window <-> main <-> local core   |        |   window <-> main <-> local core   |
  |                       guildcamp.db |        |                       guildcamp.db |
  |   ^ WowGuild.lua       | Inbox.lua |        |   ^ WowGuild.lua       | Inbox.lua |
  |   | (SavedVariables)   v           |        |   | (SavedVariables)   v           |
  | WowGuild addon, in game            |        | WowGuild addon, in game            |
  +------------------+-----------------+        +------------------+-----------------+
                     |                                             |
                     +-- hidden addon messages (GUILD, OFFICER) ---+

  GitHub Releases ---> app and addon updates on every PC
```

## Repository layout

```
app/                       the Electron app (npm package "guild-camp", productName "Guild Camp")
  package.json             main: src/main/main.js; deps: express, electron-updater
  electron-builder.yml     NSIS installer, github publish provider, ships ../addon/WowGuild as a resource
  src/main/                Electron main process (CommonJS)
  src/preload/preload.js   contextBridge → window.gc
  src/renderer/            UI: ES modules, Preact + htm from src/renderer/vendor, no bundler
  src/core/                the local core (Express + node:sqlite), runs inside the main process
  src/shared/              zero-dependency modules used by main, core, scripts and tests
  test/                    node:test suites (layout below)
addon/WowGuild/            the addon (Lua 5.1)
scripts/release.js         publishes GitHub releases with gh (wraps app/src/shared/release.js)
scripts/vendor.js          copies Preact, htm and fonts into app/src/renderer/vendor (output is committed)
scripts/curseforge.js      optional CurseForge upload of the addon zip
.github/workflows/release.yml   builds and publishes on v* and addon-v* tags
docs/                      this file, PIVOT.md, SHARING.md, RELEASING.md, api/*.md
```

Shared modules (`app/src/shared/`) never `require` anything outside Node built-ins:

| Module | What it holds |
|---|---|
| `lua.js` | `parseSavedVariables` (reads WoW's SavedVariables files) and `toLua` / `luaAssignment` (writes `Inbox.lua`). |
| `sharing.js` | The sharing codec and rules (SHARING.md Appendix A): record format, escaping, base36, varints, djb2, buckets, digests, versions, expiry, the accept rules, the H/I/G/R/M message layouts, and the derived state (raid status, counting reserves, craft and bank request state, drives, the SR+ loyalty fold). |
| `release.js` | The release pipeline: version bumps, packing the addon, building the app, `gh release create`, and reading the public release list. |
| `version.js`, `toc.js`, `zip.js`, `hash.js`, `auctionator.js` | Versions, `.toc` fields, zip read and write, hashes, Auctionator price extraction. |

## Process model

Guild Camp is one Electron app with three kinds of code, plus the core inside the main process.

```
renderer (app://guildcamp/, sandboxed)
   │  window.gc.invoke('api.request', 'GET', '/api/raids')       one IPC channel: gc:invoke
   ▼
preload (contextBridge, method list written out)
   ▼
main process (src/main)  ── ipc.js checks the method, the path and the sender
   │  api.js: fetch http://127.0.0.1:<port>/api/raids  with  Authorization: Bearer <launch token>
   ▼
local core (src/core, same process)  ── Express on 127.0.0.1, random port, guildcamp.db
   │  core.emitter: 'event' (notification), 'session' (who I am, my guild or role, or the guild's
   │  Wowhead database or officer / relay ranks changed), 'outbox' (a change was queued)
   ▼
main: native notification, 'server-event' to the renderer, inbox rewrite for the addon
```

**Main process** (`src/main/main.js`). Single-instance lock, `guildcamp://` deep links, the window, the tray,
start hidden in the tray (`--hidden`), quitting, and the `--smoke` screenshot run. It builds the services in this
order: log → store → credentials → auth → wow → addon → updater → local core → api → sync → publisher → notify →
session → ipc → window → tray. Only `main.js`, `window.js`, `ipc.js`, `notify.js`, `tray.js` and `startup.js`
load Electron (`updater.js` loads electron-updater only when it first checks). Everything else is plain Node with
injected dependencies, so it is tested without Electron.

**Preload** (`src/preload/preload.js`). Exposes `window.gc = { invoke(method, ...args), on(channel, cb) }` plus
wrappers such as `gc.sync.now()`. It runs sandboxed, so it lists the methods and channels itself; a test keeps
them equal to `METHOD_NAMES` and `EVENT_CHANNELS` in `src/main/ipc.js`.

**Renderer** (`src/renderer/`). Served from the privileged `app://guildcamp/` protocol (`window.js`), with
`contextIsolation`, `sandbox` and no Node integration. A CSP is set in `index.html`. It never talks to the core
directly and never sees the token: every call goes through `gc.api.request`. External links open in the system
browser. No third-party script runs in the app (Wowhead tooltip data is fetched and rendered as sanitised HTML).

**Local core** (`src/core/index.js` `createCore`). An Express app that listens on `127.0.0.1` on a random port.
Every request must carry `Authorization: Bearer <token>`; the token is 32 random bytes made at each launch and
compared in constant time. Without it the core answers `401 { "error": "Not allowed." }`, even for unknown paths.
It sends no CORS headers, so web pages in a browser can't use it. Only the app's own main process calls it.
`core.close()` stops its timers and the server and closes the database; `main.js` waits up to 3 seconds for an
upload to finish before that.

### Main process modules (`app/src/main/`)

| Module | Role |
|---|---|
| `main.js` | Lifecycle, services, deep links, smoke run. Also `createSession` (Battle.net state plus who I am in the core, for `auth.*`), `createLatestTracker` (newest app and addon versions for the core), `wireNotifications` (core events → native notification and `server-event`), `createAppSync` (the sync engine wired to the core's `outbox` event), `wireInboxAfterInstall` (a game folder that just got the addon gets its `WowGuild_Inbox` at once) and `pickUserDataDir` (which user data folder a run uses). |
| `window.js` | The `app://` protocol handler and the main window (custom title bar, remembers its bounds, close to tray). |
| `tray.js` | Tray icon and menu: Open, Sync now, Check for updates, Quit. |
| `store.js` | `settings.json` and `secrets.json` in the user data folder. Secrets (`bnetToken`, `anthropicKey`) are encrypted with Electron's `safeStorage` when it is available. Atomic writes. |
| `log.js` | `logs/guildcamp.log`, rotated at 1 MB (3 files kept), and the last 500 lines in memory for the Addon & sync page. |
| `credentials.js` | The Battle.net client id and secret (see "Battle.net sign-in"). |
| `auth.js` | Battle.net sign-in in the app (loopback redirect, system browser). |
| `api.js` | HTTP client for the core. Adds the token and `X-App-Version`; errors become `ApiError { status, message, code, body }`. |
| `wow.js` | Finds game folders (`_forever_`, `_retail_`, `_classic_era_` …) under the usual install places and the folders the player added. `GUILDCAMP_NO_SCAN=1` turns the usual places off. Reads, never writes, `WowGuildDB.characters` for `detectGuild`. `isWowRunning()` (true, false or null when it can't tell) and `gameProcessIds()` (the game clients' process ids, `null` when it can't tell) look at the running processes. |
| `sync.js` | The file channel (below): watches SavedVariables, uploads, writes the inbox. |
| `addon.js` | Installs, updates, repairs and removes the addon in every game folder (below). |
| `updater.js` | App self-update from GitHub with electron-updater (below). |
| `publisher.js` | The Releases page: publishes with `gh` on a PC with a source checkout (below). |
| `notify.js` | Native notifications; a click opens the event's route. |
| `startup.js` | "Start with Windows" (`--hidden`). An installed app turns it on once at first launch; the player's choice in Settings wins after that. |
| `ipc.js` | One `ipcMain.handle('gc:invoke')` dispatcher over a flat method table, plus `broadcast(channel, payload)`. Refuses calls from pages that aren't `app://guildcamp`. |

### IPC surface (`window.gc`)

Every method returns a Promise. Errors reject with `{ message, status?, code? }` (`ipc.js` `serialiseError`).
`code` is passed on when it looks like a code (a letter, then letters, digits, `_` or `-`, up to 40 characters):
the app's own `cancelled` and `in-use`, the core's `NO_GUILD`, and Node's system codes such as `ENOENT`. The
renderer reacts only to `cancelled` (no error toast) and `NO_GUILD` (show "Waiting for your guild"). Shapes of the
status objects are documented at the top of each module.

```
app.info()  app.openExternal(url)  app.openPath(path)  app.showItemInFolder(path)  app.pickFolder({ title })
app.quit()  app.relaunch()  app.rendererReady(info)
log.recent()
settings.get()  settings.set(patch)
auth.state({ refresh? })  auth.signIn()  auth.signOut()     Battle.net state + { user, guild, role } from the core
api.request(method, path, body?)   only paths under /api/, no "..", no backslashes
api.download(path, suggestedName)  save dialog, then the core's bytes
calendar.export()                  saves GET /api/calendar.ics as "<guild> raids.ics"
secrets.set(name, value)  secrets.has(name)       only 'anthropicKey'; the page never reads a secret back
wow.installs()  wow.addFolder(dir)  wow.removeFolder(dir)  wow.detectGuild()
sync.status()  sync.now()  sync.setEnabled(bool)
addon.status()  addon.check({ force? })  addon.install(dir)  addon.update(dir)  addon.updateAll()
addon.repair(dir)  addon.uninstall(dir)  addon.openFolder(dir)
updater.status()  updater.check({ force? })  updater.download()  updater.install()
publisher.status()  publisher.publishAddon({ sourceDir, bump, notes })  publisher.publishApp({ bump, notes })
publisher.setRepoDir(dir)  publisher.cancel()
notify.test()
```

Event channels (`gc.on`): `auth`, `sync`, `addon`, `updater`, `publisher:log`, `server-event` (a core notification
event), `navigate`, `log`, `settings`.

`sync.status()` (also sent on the `sync` channel when it changes):

```
{ enabled, running, state: 'off'|'idle'|'syncing'|'error'|'no-game', lastSyncAt, lastResult, lastError, guildNote,
  files: [{ file, account, install, label, flavor, lastUploadAt, lastError, nextRetryAt }],
  nextRetryAt, installCount, coachWaiting,
  restartNeeded, restartFolders: [{ install, label, since }], recent }
```

`restartNeeded` is true while a game folder's `WowGuild_Inbox` was made during the game session that still runs
(that session never loads it, also not after a `/reload`); `restartFolders` lists those folders, with `since` the
ISO time it was made. The renderer then says "restart World of Warcraft" instead of "/reload" (SHARING.md §2).

### Settings (`store.js`)

```js
{ extraWowFolders: [], syncEnabled: true, closeToTray: true, startWithWindows: false,
  addonAutoUpdate: true, addonAutoInstall: true, appAutoUpdate: true, notifications: true, theme: 'system',
  repoDir: null, discordWebhook: null, bnetRegion: 'eu', windowBounds: null, onboarded: false,
  startupDefaulted: false, addonOptOut: [], inboxRestart: {} }
```

`windowBounds`, `startupDefaulted`, `addonOptOut` and `inboxRestart` are managed by the main process;
`settings.set` ignores them, and a change to these keys alone is not broadcast on `settings`. `inboxRestart` holds the
game folders whose news folder waits for a game restart: `{ [folder key]: { dir, at, pids } }` ("The file
channel").
The core reads `discordWebhook` and `bnetRegion` live, and the secret `anthropicKey` for the Coach.
`createStore(dir, { overrides })` reports some values for one run only, never writing them to `settings.json`: a
smoke run uses this to turn off addon installs and updates, app updates, sync and notifications (`SMOKE_SETTINGS`
in `main.js`), so the next normal run of that folder keeps the player's choices.

### The user data folder

`%APPDATA%\Guild Camp` for an installed app, or the folder given with `--user-data` (or `GUILDCAMP_USER_DATA`) in
a dev run. A smoke run always uses its own: `<smoke out>/user-data` (`app/dist/smoke/user-data` by default), or
the folder given with `--smoke-user-data`; it ignores `--user-data` and `GUILDCAMP_USER_DATA`
(`pickUserDataDir`). It holds `settings.json`,
`secrets.json`, `guildcamp.db` (with `-wal` and `-shm`), `backups/`, `logs/`, `bnet-profile.json`,
`github-releases.json` (the cached release list) and `addon-cache/` (downloaded addon zips).

### The local core (`app/src/core/`)

| File | Role |
|---|---|
| `index.js` | `createCore({ dataDir, log, getIdentity, getSecret, getSettings, credentials, getLatest })` → `{ url, token, emitter, setIdentity, session, close, db, ctx }`. At start, once Battle.net characters are applied, it runs the one-time repair of who I am (`sharing.repairIdentity`, SHARING.md §3). |
| `app.js` | Security headers, the token check, JSON bodies (up to 15 MB), "me" and the current guild on every request, the route files in order, the JSON 404 and error handler. |
| `config.js` | Live getters for the player's Anthropic key, Discord webhook and Battle.net region, and the built-in Battle.net credentials. |
| `context.js` | The `ctx` every route file gets: `db, cfg, log, emit, audit, activity, discord, me, guild, services, timers, latest, outboxChanged`. |
| `http.js` | `HttpError`, input validators (`str`, `int`, `num`, `bool`, `oneOf`, `list`), guards (`needGuild`, `needOfficer`, `needOwner`) and the guild and user JSON shapes. |
| `identity.js` | Me, the current guild, and roles from in-game ranks (below). |
| `events.js` | The in-process notification bus (below). |
| `db.js` | `node:sqlite` behind a small better-sqlite3-compatible adapter, and the migrations (below). |
| `sharing.js`, `share/*.js` | In-game sharing on the app side (below). |
| `routes/*.js` | `core`, `sync`, `community`, `raids`, `economy`, `coach`, `admin`, `calendar`, `share`. Each exports `register(app, ctx)`. |
| `services/*.js` | Domain rules ported from the old server: sync, raids, community, economy, coach and ai, backup, reset, blizzard, gamedata, calendar. |
| `demo.js` | A demo guild for `--smoke --smoke-seed` screenshot runs only. |

Conventions for every route: JSON in and out; errors are `{ "error": "Plain sentence." }` with an HTTP status,
sometimes with a `code`. Rows keep their column names (`snake_case`); computed fields are `camelCase`. SQLite
times are UTC `"YYYY-MM-DD HH:MM:SS"`; raid start times are ISO 8601 UTC; times inside shared records are server
seconds. Money is integer copper. Details: [api/core.md](api/core.md).

## The file channel (game ↔ app)

The app and the addon never talk directly. They share two files on the player's PC.

**Up: SavedVariables.** The addon keeps everything in `WowGuildDB`. WoW writes it to
`WTF/Account/<ACCOUNT>/SavedVariables/WowGuild.lua` when the player logs out or types `/reload` (not on a crash).
`sync.js` checks the modification time of that file in every game folder every 4 seconds. When it changes, it
waits 1.5 seconds and checks again so it never reads a half-written file, parses it with `parseSavedVariables`,
and posts `WowGuildDB` to `POST /api/sync`. It adds `_source = { account, install }` (which file it was) and,
when `Auctionator.lua` next to it changed, Auctionator prices. Uploads never overlap. A failed upload is retried
for that file after 5 s, 10 s, 20 s … up to 5 minutes. Game folders are looked for again every 60 seconds.

The core applies an upload in one transaction (`services/sync.js` `applyPayload`): the guild (see "Identity and
roles"), the player's characters, professions and recipes, bags and banks, the guild bank, prices, Coach data,
the shopping list, the roster with in-game ranks, and then `WowGuildDB.shared`, the records the addon traded with
guildmates (`sharing.importShared`). After it commits, roles follow the ranks and Discord posts go out for the
player's own changes that the game confirmed.

**Down: the inbox.** After each upload, every 5 minutes, and soon after the player makes a change that must reach
the guild (below), `sync.js` asks the core for `GET /api/inbox` and writes it as `WowGuildInbox = {…}` into
`Interface/AddOns/WowGuild_Inbox/Inbox.lua`, with a `.toc` whose `## Interface:` line is copied from the installed
`WowGuild.toc`. `WowGuild_Inbox` is a tiny separate addon that WowGuild lists as an optional dependency, so the
addon's own folder stays exactly as released. The game reads it at the next login or `/reload`. Each file is only
written when its content changed. The game finds a new addon folder only when it starts, so a game folder that
just got the addon gets its `WowGuild_Inbox` within a second or two (`main.js` `wireInboxAfterInstall`), and both
folders load at the next game start. When `sync.js` still has to create `WowGuild_Inbox` while the game may be
running, it logs "Guild news saved for the addon. It shows after you restart World of Warcraft. A /reload isn't
enough the first time." (`writeInboxFiles` returns `created`).

**Waiting for a game restart.** That game session never loads the new folder, also not after a `/reload`, so
`sync.js` remembers the folder in `settings.inboxRestart` (`{ dir, at, pids }`, `pids` = the game's process ids
then, from `wow.gameProcessIds()`; `null` when unknown). It survives a Guild Camp restart; when settings can't be
written, the wait is kept in memory for that run. While anything waits, `sync.status()` says `restartNeeded` with
`restartFolders`, and the screens, the Coach lines in the log and the "news saved" log line say to restart World
of Warcraft instead of `/reload` (SHARING.md §2). The wait ends when Guild Camp sees that game session end: the
game closed, or none of the process ids from then is left (a quick restart between two checks). It looks at the
game at most every 30 seconds while something waits (`gameCheckMs`), and at every news write. When it can't tell,
the wait stays. The game is asked through test overrides first, then `wow.gameProcessIds`, then
`wow.isWowRunning` (a `wow` whose `isWowRunning` was replaced is asked only through that).

The inbox holds the guild news the addon shows (notices, raids with my sign-up, crafting requests I can make,
leveling partners, guild prices and stock for tooltips, crafters, Coach plans and answers, `latestAddon`) and,
for sharing, `outbox` (changes for the addon to send), `me` (my player id, BattleTag, main and characters in the
current guild, plus `g` and `byG`: the same per guild, since player ids are per guild) and, when an account's
store is far behind, `seed` with `seedG`. Shapes: [api/sync.md](api/sync.md).

When a route queues a change, the core calls `ctx.outboxChanged()` and its emitter sends `outbox`. `main.js`
builds the sync engine with `createAppSync({ core, … })`, which passes `coreEvents: core.emitter` to `createSync`,
so the inbox is rewritten about 1 second later (within 2 s), whether or not the game is running.

Rules on the game side: everything is gathered out of combat. WoW: Forever follows the Midnight-era rules, which
hide combat data from addons and block addon messages inside instances.

## In-game sharing

The full protocol is [SHARING.md](SHARING.md). This is the short version.

**What travels.** Guild data is a set of **records**: one string each, `<id>^<v>^<author>^<flags>^<fields…>`,
identical in messages, in `WowGuildDB.shared` and in the app's `shared_records` table. The id is `<type>:<key>`.
Lowercase types are member data (characters, recipes, sign-ups, requests, calls to arms, bank stock, prices …);
UPPERCASE types are officer data (raids and their status, loot, notices, drives, bank answers, bank characters,
guild settings, the Discord webhook). The bigger version `v` wins everywhere. A version is the server time × 64
plus a hash of the author; "final" versions (a cancel, a close) beat every normal one, and the earliest final one
wins, so every PC settles on the same state in any arrival order. A tombstone (flag `d`) deletes.

**Who may write.** The game vouches only for the direct sender of a message. Each addon checks ranks from its own
roster scan: officer data is accepted first-hand from an officer, or relayed by a trusted rank ("Who passes on
officer changes", `relay_rank_max`); member data from any guild member. The app adds content rules on import:
records keyed by a player id must come from a character linked to that player, nobody claims their own crafting
request, reserves must be on the loot list and within the limit. A record in my name that this PC never made
shows an "author check" ("It was me" / "Undo it"). Anyone may pass on member data in anyone's name, so per-author
caps never refuse a record heard from its author, records of unknown types have their own small budget, and an
addon never passes on member data in its own player's name that it didn't make (SHARING.md §5, §11).

**How it moves.** One addon prefix (`GuildCamp`), five message types: `H` hello (48 bucket digests), `I`
inventory, `G` get, `R` records, `M` a part of a large record. Each new local record is pushed once. When digests
differ, peers exchange inventories and ask for what they lack. Replies wait a random moment and are dropped when
someone else's equivalent reply was seen first, so a mass login does not cause a storm. A token bucket keeps
every client under the game's throttle. Nothing is sent in combat, inside an instance, during a loading screen,
or before the first roster scan, and sharing starts only once the game gives the guild's name. Each guildmate's
hellos get a bounded number of answers, a whole bucket goes to one peer at most once a day, the same inventory
to the same peer is guarded for 2 hours and longer when it keeps coming due, and records sent again for a
guildmate's requests have a budget. Every store keeps to its caps when a record arrives, pushing out by class the
records anyone could have made up first (SHARING.md §8, §11). Every peer prunes the same expired records in the
same server hour, and the app drops them from its own copy too, keeping the rows they made as history.

**App to guild.** A route that changes shared data checks input and role, then calls
`sharing.queue(db, ctx, { type, key, fields, del, need, base, chan })`. That writes a `share_outbox` entry and a
provisional record, and remakes the domain rows at once, so the page shows the change straight away. The inbox
carries the entry to the addon, which sends it at the next login or `/reload` outside instances, on a suitable
character (an officer character for officer data, the Guild Master for `CFG`). The addon writes an
acknowledgement in `WowGuildDB.shared.guilds["<realm>/<guild>"].sent[op]`: `ok,<v>,<author>`, `wait,<reason>` or
`no,<reason>`. On `ok` the app keeps the record and posts to Discord if a webhook is set; on `no` (for example
`no,stale` when someone changed it first) it rolls the rows back and shows why. Routes write no rows themselves:
the projector makes them from the provisional record (below).

**Guild to app.** Records reach my app through my own addon's store at my next upload. The core checks them,
stores them in `shared_records` (`ok`, or `ignored` with a reason), and remakes the domain rows.

**Rows are a projection.** For every shared type, the rows the pages read (raids, sign-ups, reserves, loot,
loyalty, requests, posts, drives, bank requests, guildmates' characters …) are made from the stored `ok` records
plus this PC's own pending outbox entries, by one projector per type (`share/project.js`, upserting by
`share_id`; a tombstone removes the row). Derived state (raid status, craft and bank request state, drive totals,
SR+ bonuses) is recomputed with the pure functions in `shared/sharing.js`, so the same records give the same
answer on every PC. Cancelling a pending change, or a refused one, just remakes the rows without it.

Code map:

```
app/src/shared/sharing.js       codec, rules, derived state (also used by tests)
app/src/core/sharing.js         public API: queue, cancel, importShared, exportOutbox/Me/Seed, status, ...
app/src/core/share/store.js     clock and skew, who I am (my characters and player id per guild), effective records, links
app/src/core/share/project.js   one projector per record type
app/src/core/share/queue.js     queue, cancel, newKey, baseOf, recordOf, ensurePid
app/src/core/share/import.js    importShared: player id adoption, acknowledgements, checks, storing, notifications, author checks, SR+ checkpoints
app/src/core/share/export.js    the inbox's outbox, me and seed
app/src/core/share/prune.js     drops the records every addon has expired, at most hourly (their rows stay)
app/src/core/share/repair.js    the one-time repair of who I am after an update (runs at core start)
app/src/core/share/text.js      summaries, plain-English notes, audit lines, Discord posts
app/src/core/routes/share.js    GET /api/share/status and the outbox, author-check and webhook actions
addon/WowGuild/ShareCodec.lua   the same codec in Lua, byte for byte
addon/WowGuild/Share.lua        store, outbox and acknowledgements, receiving and checks, queues and token bucket, /wow share
addon/WowGuild/ShareSync.lua    hellos, inventories, gets, the beacon, catch-up, pruning
addon/WowGuild/Collect.lua      builds my ch, rc, bk, sh records and the guild bank gb records
```

The app's sharing routes are in [api/share.md](api/share.md). What sharing still can't do without a server is
listed under "Known limits" in [SHARING.md](SHARING.md) §12.

## Identity and roles

There are no accounts, invites, devices or join steps.

- **Me.** One local `users` row (`bnet_id = 'local:me'`). Its `battletag` is the BattleTag when the player signed
  in to Battle.net in the app, otherwise the name of their main (or most recently played) character, otherwise
  "You". Every request to the core is "me".
- **The guild.** The in-game guild of the most recently played character that has one, read from each upload
  (`WowGuildDB.characters[*].guild/realm/faction/updated`). It is created locally the first time it is seen. One
  guild at a time: `app_settings.guild_id` points at it. Another guild becomes current only when one of its
  characters was played more recently (`guilds.last_played_at`), so uploads from several game folders don't flip
  it back and forth. Data of an earlier guild stays and comes back if the player returns.
- **My characters.** Only what this computer saw itself makes a character mine: the characters in its own
  SavedVariables uploads (`characters.user_id` = me), my Battle.net characters, and names I confirmed with "It was
  me" on an author check. A shared record never makes a character mine on its own (SHARING.md §3).
  `characters.game_guild` keeps the in-game guild the upload gave: a character of mine in another game guild
  doesn't count in this one and stays off its roster, counts, members list and pickers (`identity.notElsewhere`).
  One uploaded with no guild, and not on the roster, still counts as mine, but is never the main, an alt or the
  anchor my shared records give; pages that pick my main prefer a character known to be in the guild
  (`identity.looseLast`). Once, after an update, `share/repair.js` unlinks characters an older version linked to
  me through a guildmate's record, and asks about them.
- **Guildmates.** They appear from roster scans (characters with ranks) and from shared records. Each player has
  a player id (`pid`, for example `Thrallia.p4m7`) **per guild**, made on their main in that guild (the anchor).
  Mine is kept in `app_settings` `me_pid:<guild id>` and, in the addon, per guild in
  `WowGuildDB.shared.guilds[g].pid`; the inbox's `me.byG` gives the addon the id of each guild. A guildmate is a
  `users` row with `bnet_id = 'pid:<pid>'`. A character belongs to a player only when its own `ch` record names
  that player and it is the player's anchor or the anchor's `ch` lists it, so nobody can attach a character to
  someone else.
- **Roles come only from in-game ranks** (`identity.syncRanks`): rank index 0 (Guild Master) → `owner`; rank index
  ≤ `guilds.officer_rank_max` (default 1) → `officer`; anything else, or unknown → `member`. A player's best
  (lowest) rank among their characters counts. Ranks come from the player's own roster scans. Only the Guild
  Master changes `officer_rank_max` and `relay_rank_max`, in Guild settings; that queues one `CFG` record, which
  every other app applies when it arrives.
- **Guards.** `needGuild` answers `403` with code `NO_GUILD` and "Guild Camp hasn't seen your guild yet. Log in to
  World of Warcraft with the Guild Camp addon on a character in your guild, then log out or type /reload." until
  the first upload brings a guild. `needOfficer` and `needOwner` check the role. The renderer hides officer pages
  for members and shows a "Waiting for your guild" page until the guild is known.

## Battle.net sign-in

Battle.net is optional. Without it everything works; the player is known by their main's name and there is no
character list from Battle.net and no Blizzard game data.

- **Where the credentials come from** (`credentials.js`, first match wins):
  1. The environment variables `GUILDCAMP_BNET_CLIENT_ID` and `GUILDCAMP_BNET_CLIENT_SECRET` (development).
  2. `app/src/main/bnet-credentials.json`, written by the release pipeline (`shared/release.js buildApp`) from the
     same variables, or from `bnetClientId` / `bnetClientSecret` in the gitignored `.release.json`, or from GitHub
     secrets in CI. It is written just before electron-builder runs, packed into `app.asar`, and removed after
     the build. It is gitignored: the repository is public and never contains the secret.
- **Sign-in** (`auth.js`, OAuth authorization code flow): a small web server starts on `127.0.0.1:47615` (and
  `[::1]:47615`) only while signing in. The system browser opens Battle.net's sign-in page with a random `state`.
  Battle.net sends the browser back to `http://localhost:47615/auth/callback` (the redirect URI registered at
  develop.battle.net); a reply with the wrong `state` is refused. The app trades the code for a token with the
  built-in credentials, reads the BattleTag and then the World of Warcraft characters (Retail, Classic and
  Classic Era profiles; at most 6 seconds), and stops the server. It gives up after 3 minutes. Scope:
  `openid wow.profile`.
- **What is kept**: the access token, encrypted (secret `bnetToken`); the BattleTag and characters in
  `bnet-profile.json`. Tokens last about a day; after that the player stays signed in with what was read last, and
  a refresh with an expired token signs out and says why.
- `main.js` passes the BattleTag and characters to the core with `core.setIdentity()`; the core keeps them in
  `bnet_characters` and uses the BattleTag as my name. The core also uses the credentials (client credentials
  flow) for Blizzard game data: item details, realm status and the official roster, when Blizzard's API has them.

## Updates for the app and the addon

**The app** (`updater.js`). Installed builds use electron-updater with the `github` provider from
`app-update.yml`, which electron-builder writes from `electron-builder.yml` (owner `arrow-quiver`, repo `wow`).
It follows the release marked **Latest**, reads its `latest.yml`, and downloads only the changed blocks of the
installer (the `.blockmap`). `appAutoUpdate` decides whether it downloads by itself; a downloaded update
installs when the app quits, or at once from the Updates page. `main.js` checks at start and every 30 minutes.
Development builds never update themselves: they report state `dev` and read the newest release from the GitHub
API, so the Updates page can say what is out.

**The addon** (`addon.js`). The app ships a copy of the addon (`resources/addon/WowGuild`; in development the
repo's `addon/WowGuild`). It also reads `https://api.github.com/repos/arrow-quiver/wow/releases` without signing
in, keeps the answer with its ETag in `github-releases.json`, and asks GitHub at most every 30 minutes (every
10 seconds when the player presses Check). The newest `addon-v*` release with its zip is the remote copy;
`WowGuild-<v>.zip` is checked against `WowGuild-<v>.zip.sha256` and cached in `addon-cache/`. The higher version
of the two copies is installed.

- `addonAutoUpdate` updates outdated installs; `addonAutoInstall` installs the addon into game folders that don't
  have it, only for game versions the bundled `.toc`'s `## Interface:` list supports, and never where the player
  removed it (`addonOptOut`). `main.js` checks at start and every hour.
- **While the game runs.** The game reads the AddOns folders and each `.toc`'s file list when it starts; a
  `/reload` reloads the same files. So automatic installs and updates wait while World of Warcraft runs, or while
  Guild Camp can't tell (`wow.isWowRunning()` true or null): the folder shows `waitingForGame` in
  `addon.status().installs[i]`, one log line says so, and Guild Camp looks again every minute and runs the check
  once the game has closed (it asks again right before replacing the folder). An install, update, repair or
  "Update all" the player starts still happens, and its result says `restartNeeded: true` when the game may be
  running and the change added the `WowGuild` folder or changed its `.toc` file list; the pages then say "Restart
  World of Warcraft to load it. A /reload isn't enough this time." In game, an addon whose sharing files didn't
  load says to restart the game, not to `/reload`.
- Every change is atomic: unpack into `AddOns/.guildcamp-tmp-<random>/WowGuild`, rename the old folder to
  `WowGuild.old-<time>`, move the new one in, delete the old one; if the move fails the old folder is put back.
  Renames are retried while Windows holds a lock ("Close World of Warcraft and try again").
- Only `AddOns/WowGuild` is replaced, and only `WowGuild` and `WowGuild_Inbox` are ever removed, after checking
  their `.toc` says they are ours.
- The inbox carries `latestAddon`, so the addon tells the player in game when a newer version is out.

## Publishing with gh

All publishing goes through `app/src/shared/release.js`, which runs the GitHub CLI. There are three ways in:
`node scripts/release.js addon|app|all|status …` on a computer, GitHub Actions on a pushed `v*` or `addon-v*` tag
(`.github/workflows/release.yml`, with the workflow's `GITHUB_TOKEN`), and the app's **Releases** page
(`publisher.js`), which shows on a PC with a source checkout and `gh` signed in with push access.

| What | Version lives in | Tag | Assets | Latest? |
|---|---|---|---|---|
| App | `app/package.json` | `v<version>` | `Guild-Camp-Setup-<v>.exe`, its `.blockmap`, `latest.yml` | yes |
| Addon | `## Version:` in `addon/WowGuild/WowGuild.toc` | `addon-v<version>` | `WowGuild-<v>.zip`, `WowGuild-<v>.zip.sha256` | never (`--latest=false`) |

App builds run `npm run dist` in `app/` (`electron-builder --win --publish never`); electron-builder never
publishes by itself. A version bump that does not end in a published release is undone. The full walkthrough,
first-time setup and rollback: [RELEASING.md](RELEASING.md).

## The database

`<userData>/guildcamp.db`, opened by `db.js` with `node:sqlite` (built into Electron's Node). A small adapter
makes it behave like better-sqlite3 (`prepare().run/get/all/iterate/pluck`, `transaction(fn)` with savepoints
when nested, `pragma`, `exec`), so the domain code ported from the old server works unchanged. WAL journal,
foreign keys on, a 5-second busy timeout. Each player has their own database; there is nothing to share it with.

**Migrations.** `MIGRATIONS` in `db.js` is an append-only array. `schema_version` holds how many have run; each new
one runs in its own transaction. Never edit an existing entry; add a new one at the end.

| Index | What |
|---|---|
| 0–13 | The old server's schema, in its order, so the ported domain code finds every table and column it expects (guilds, users, memberships, characters, professions, recipes, raids and loot, bank, prices, drives, Coach, audit log, events …). Some tables from that era (devices, releases) are no longer used. |
| 14 | `guilds.last_played_at`: when a character of each guild was last played (picks the current guild). |
| 15 | Sharing (SHARING.md §10): `share_id` (unique per guild) on raids, loot_log, craft_requests, buddy_posts, ctas, announcements, drives, drive_contribs and bank_requests; `raids.locked_at`; `signups.reserves_at`; `loot_items.item_key`; `guilds.relay_rank_max`; and the tables `shared_records` (with `kept`, the last `ok` version shown while a newer one is ignored), `share_outbox` (with `record`, the provisional record, `sent_v`, `sent_author` and a `dropped` state), `spell_names` and `share_author_checks`. |
| 16 | Who I am, per guild (SHARING.md §3): `characters.game_guild` (the in-game guild an upload of this PC gave for the character; `NULL` = not known) and `share_author_checks.names` (the characters a `ch` check is about). The player id moves from `me_pid` to `me_pid:<guild id>` on first use, not in the migration. |
| 17 | Author checks and pruning (SHARING.md §5, §11): `share_sent` (the versions this PC sent or said were mine, kept through a fresh start; filled from `share_outbox.sent_v` and from checks answered "It was me"), `share_pruned` (records dropped as expired, with their last version, so their rows stay and an expired copy is refused), and `share_author_checks.kind` (`unknown`, `pid`, `repair`), `n` and `recs`. The one `share_since` is copied to `share_since:<guild id>` for every guild with shared records, then deleted. |

The next free index is **18**.

`app_settings` holds small values the core keeps for itself, for example `guild_id`, `me_pid:<guild>` (my player
id in that guild; `me_pid` from before ids were per guild), `share_my_alts:<guild>` (characters I confirmed with
"It was me"), `me_battletag`, `server_skew` (game server time minus this PC's clock), `share_since:<guild>` (when
this PC first shared in that guild; author checks only look at records newer than this), `share_reset:<guild>`
(the last fresh start), `share_pruned_at:<guild>` (the hour of the last pruning), `share_repair` (the one-time
repair ran), `share_g:<guild>` (the addon's partition key), `share_stores:<guild>`, `share_stats:<guild>` and
`shared_webhook`.

**Backups.** Officer tools makes a snapshot with `VACUUM INTO <userData>/backups/guildcamp-YYYYMMDD-HHMMSS.db`.
A background check makes one a day (30 seconds after start, then hourly checks) and keeps the newest 14. The app
reveals a backup in its folder; nothing is uploaded anywhere. If the database is lost, the next uploads rebuild
what the addon stores still hold.

**Fresh start** (`services/reset.js`, Officer tools, Guild Master only). A backup is made first. It wipes this
PC's game data for the guild (characters and roster, raids and loot, bank, prices, drives, requests, calls to
arms, notices, activity, Coach data) and keeps people, roles, settings and player ids. Uploads of game data from
before the wipe (an old Retail SavedVariables file, say) are ignored afterwards. Guild data shared in game is
rebuilt, not lost: this PC's shared records, answered author checks, sharing statistics and outbox history go,
while unsent changes and unanswered author checks stay (their rows are made again at once), and the next upload
brings every record back from the addon's store, whatever its age. Before the wipe, the records in my name it
holds go into `share_sent`, so my own records coming back don't open author checks; `share_since:<guild>` doesn't
move, so a forged one from before the fresh start still does. `share_reset:<guild>` keeps records from before it
from notifying again, and a call to arms from before it from being posted to Discord again. Guildmates' games and
apps don't change.

## Notifications and Discord

**Notifications.** `events.js` replaces the old server's events table and polling. Code calls
`ctx.emit(guildId, kind, { title, body, route, userId, userIds, exceptUserId, officersOnly, recipe })`. Because
only the player on this PC can see anything, `emit` decides whether *I* should hear about it (the filters, my
role, whether my characters know the recipe, and my notification choices). A visible event is kept in the
`events` table (14 days) and sent on the core's emitter as `event`; `main.js` shows a native notification (unless
notifications are off) and broadcasts `server-event`, which pages use to reload. Kinds: `cta`, `raid`, `notice`,
`request`, `bank`, `coach`, `drive`, `release`. Guildmates' changes notify me when their records arrive in an
upload (raid scheduled or cancelled, notice, call to arms under 1 hour old, a request I can craft, bank requests
for officers, a drive started or reached, and answers to my own requests), unless they are from before the
guild's last fresh start.

**Discord.** Each app may have a webhook URL in Settings (`settings.discordWebhook`). It posts only what its own
player did, and only once the game confirms the change went out (`sharing.afterImport` after an upload): a new
raid or event, a cancel, a loot award, a notice, a call to arms, a crafting request, a bank request, a new drive,
and a drive reaching its goal (posted once, by the app of the player whose hand-in first brought the total there).
The one-hour raid reminder is posted by the app of the officer who scheduled the raid. Officers can pass their
webhook to the other officers over the OFFICER channel (`WH` record); an officer's app then offers "<name> shared
a Discord webhook. Use it?".

## Renderer

- `index.html` has an import map for the vendored Preact, hooks and htm. Fonts are vendored woff2.
- `lib/gc.js` wraps `window.gc`. `lib/api.js` gives `api.get/post/put/del` and `useApi(path, { refreshOn })`,
  which reloads when a matching `server-event` arrives. `lib/session.js` gives `useSession()` (user, guild, role,
  Battle.net state) and `pageGate`. `lib/status.js` holds live stores for sync, addon, updater, settings and
  sharing status. `lib/router.js` is a hash router.
- Pages are `pages/<name>.js`, registered in `pages/index.js` with `{ path, load, title, nav, icon, officer?,
  owner?, publisher?, public?, bare? }`.
- Navigation: **Play** Camp, Coach, Raids, Crafters, Requests, Partners · **Guild** Roster, Bank, Prices, Drives,
  Loot, Guild settings · **Officers** Officer tools · **App** Addon & sync, Settings, Updates, Releases (only on a
  PC that can publish). Not in the sidebar: `/raids/:id`, `/raids/:id/loot`, `/characters/:name`, `/welcome`.
- The gate: the welcome flow until setup is done (`settings.onboarded`), then every page. Pages that need guild
  data show "Waiting for your guild" with a link to Addon & sync until the first upload brings the guild.
  Addon & sync, Settings, Updates and Releases always open.
- First run (`pages/welcome.js`): "Sign in with Battle.net" (when this copy has it) or "Continue without
  Battle.net", then a checklist that runs by itself: find the game folders, install the addon, pick up the guild
  after the first sync, and offer "start with Windows".
- Sharing in the UI: Addon & sync shows "Sharing in game" (guildmates heard, records, last exchange) and the lists
  "Waiting to go out", "Not sent" and "Sent in the last day". Camp shows author checks, each kind with its own
  words and button labels (`lib/status.js` `authorCheckView`). `components/ShareHint.js` and `lib/status.js` hold
  the plain-English lines from SHARING.md §2, with their "restart World of Warcraft" versions while the sync
  status says `restartNeeded`.
- Deep links: `guildcamp://raids/<id>`, `characters/<name>`, `coach`, `crafters`, `requests`, `partners`,
  `roster`, `bank`, `prices`, `drives`, `loot`, `addon`, `updates`, `settings` open the same route (at most three
  plain segments). Anything else just focuses the app.
- Styling: `styles/tokens.css` (the WoW: Forever palette, light and dark) and `styles/app.css`. No colour literals
  in components.
- **Previews without Electron**: when `window.gc` is missing, `lib/gc.js` loads `lib/mock.js` and `lib/mocks/*`,
  which answer every IPC method and core endpoint with sample data. Serve `app/src/renderer` with any static web
  server and open `index.html?mock=owner` (also `officer`, `member`, `setup`, `noguild`; more switches at the top
  of `lib/mock.js`).

## Development

### Safety rules

The development PC has a real World of Warcraft install and a GitHub CLI signed in with push access to the real
repository. These rules keep both safe.

- **Never run Electron against your real setup.** Always set `GUILDCAMP_NO_SCAN=1` and pass
  `--user-data <a scratch folder>`. Without them a dev app scans the real game folders and installs, updates or
  syncs the addon there, exactly like the installed app. A test run once overwrote the real addon this way.
- Never read or write under the real game folder (`C:\Program Files (x86)\World of Warcraft`). Tests make fake
  game folders in temp directories and pass `scanDefaults: false` or set `GUILDCAMP_NO_SCAN=1`.
- `--smoke` runs are safe by default: they always use their own user data folder (`<smoke out>/user-data`,
  `app/dist/smoke/user-data` by default, or `--smoke-user-data <dir>`; `--user-data` and `GUILDCAMP_USER_DATA`
  are ignored), turn off default folder scanning (unless `--smoke-scan`), switch off addon install and update, app
  update, sync and notifications for that run only (store overrides, never saved), turn the addon and app update
  checks into no-ops, and never run `gh`. To give a smoke run fake game folders, set them up in a scratch profile
  and pass it with `--smoke-user-data`.
- **Tests only ever run a fake `gh`**: a small Node script put first on `PATH` (see `test/publisher.test.js` and
  `test/release.test.js`). Never run `scripts/release.js` without `--dry-run` while testing, and never run
  `gh release` or `gh repo` commands by hand unless you mean to publish.
- **No network in tests.** Pass `fetch` stand-ins (`startCore({ fetch })`, `createAddonManager({ fetch })`); the
  sim never touches the network.
- **Lua must run on real WoW** (Lua 5.1) and under fengari (Lua 5.3 with 32-bit integers) in tests: no `//`,
  `goto`, bit operators, `utf8.*`, `string.pack`, `math.type` or `tonumber(s, 36)`; never `tostring` a number for
  wire data; every event handler and timer in `pcall`; never error into the game. `test/lua51-guard.test.js`
  checks every addon file. Write a new Lua file completely before adding it to `WowGuild.toc`.
- Keep the default test suite fast: simulations that take more than about 20 seconds run only with
  `GUILDCAMP_SIM_HEAVY=1`; a lighter version of each runs by default.

### Running things

```bash
npm install                       # at the repo root; also installs app/
GUILDCAMP_NO_SCAN=1 npm test      # the whole suite: node --test "app/test/**/*.test.{js,mjs}"
```

From `app/`:

```bash
# The dev app, kept away from your real game folders and settings
GUILDCAMP_NO_SCAN=1 npx electron . --user-data ./dist/dev-profile

# One test file, or the whole suite with the heavy simulations
GUILDCAMP_NO_SCAN=1 node --test test/core/raids.test.js
GUILDCAMP_SIM_HEAVY=1 GUILDCAMP_NO_SCAN=1 node --test "test/**/*.test.{js,mjs}"

# Screenshots of every page with a demo guild, into dist/smoke (report in dist/smoke/smoke-report.json)
npx electron . --smoke --smoke-seed

# The same in a scratch profile of your own (fake game folders set up there under Addon & sync)
npx electron . --smoke --smoke-user-data ./dist/smoke-profile
```

From Git Bash, set `MSYS_NO_PATHCONV=1` before `--smoke-routes=/,/raids`, or it rewrites `/` into a Windows path.
To give the dev app fake game folders, add them under Addon & sync (`extraWowFolders`) in the scratch profile.
`GUILDCAMP_BNET_CLIENT_ID` and `GUILDCAMP_BNET_CLIENT_SECRET` turn Battle.net sign-in on in a dev run.

### Test layout

| Folder | What |
|---|---|
| `app/test/` | Unit tests for the main process and shared modules (store, api, ipc, sync, addon manager, updater, publisher, release, auth, credentials, wow, main), the renderer's pure helpers (`renderer.test.mjs`, in plain Node), real renderer components rendered with Preact into a small in-test DOM (`renderer-render.test.mjs`), the sharing codec and derived state (`sharing-codec.test.js`, `sharing-derived.test.js`) and the Lua 5.1 guard. |
| `app/test/core/` | The local core: each route domain over a real core on `127.0.0.1` with an in-memory database (`helpers.js` `startCore`, `seedGuild`, `addPlayer`), the sharing engine (`sharing-*.test.js`, including `sharing-identity` for who I am, `sharing-unknown` for unknown record types, `sharing-author` for author checks, `sharing-prune` for pruning and `sharing-repair` for the repair after an update; `sharing-helpers.js`, `share-kit.js`), the real addon Lua in a simulated client (`addon.test.js`), and `e2e.test.js`: a simulated game session → SavedVariables → the app's real `sync.js` → the core → the inbox → back into the game. `wowsim.js` here re-exports `../sim/wowsim.js`. |
| `app/test/sim/` | `wowsim.js` runs the real addon under fengari against a mocked WoW client, with immediate timers or a virtual clock (both interfaces, roster, instances, combat, item and spell names). `guildnet.js` connects many simulated clients over GUILD and OFFICER with the game's throttle, latency, loss and reordering. The collector tests, the sharing engine tests and the SHARING.md §13 scenarios (`share-scenarios`, `share-scale`, `share-engine`) run here, plus `share-identity` (forged `ch`, player id adoption, ids per guild) and `share-robustness` (floods, made-up hellos, a late guild name, guild switches). `e2e-share.test.js` (with `e2e-kit.js`) runs several players end to end: a real core and the real `main/sync.js` per player, the real addon in GuildNet, one virtual clock. |
| `app/test/fixtures/` | The sharing golden vectors (`sharing-vectors.json`, rebuilt by `make-sharing-vectors.js`) and the Lua checker used by both fengari and a real `lua5.1` when one is installed. |

## Versions

Everything started at **0.11.0**: `app/package.json` and `## Version:` in `addon/WowGuild/WowGuild.toc`. The app
and the addon are released independently. Versions are `MAJOR.MINOR.PATCH`, with an optional `-beta.N`.
