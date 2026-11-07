# Guild Camp: architecture and conventions

Guild Camp is a guild platform for **World of Warcraft: Forever** (PvP ruleset; Retail later). It has three parts:

```
app/      Electron desktop app "Guild Camp". Replaces the old companion exe AND the old browser UI.
server/   Node + SQLite JSON API. Shared guild data, Discord, Battle.net sign-in, release hosting.
addon/    WowGuild, the in-game addon (listed as "Guild Camp"). The app installs and updates it.
scripts/  Release tooling (publish app + addon updates to the server).
docs/     This file, docs/api/<domain>.md (endpoint shapes), docs/RELEASING.md.
```

The old version (branch `versions/0.11.0`, identical to `versions/0.10.0`) is the behavioural reference:
`web/` (Express site with server-rendered HTML), `companion/` (pkg-built exe), `addon/WowGuild`. Every feature
it had carries over unless this document says otherwise. A read-only copy is extracted at
`$REF` = `C:/Users/calvi/AppData/Local/Temp/claude/555ee30c360e826d/450f66fd-6ccb-4920-8169-2bcf92567984/scratchpad/ref`
(also readable with `git show versions/0.11.0:<path>`).

## What changed from the old version

| Old | New |
|---|---|
| `companion.exe` with hand-edited `config.json` and a sync key | The app signs in with Battle.net, gets a **device token**, and syncs in the background (tray). |
| Joining with an invite link | Members **join by themselves** when one of their characters is in the guild roster (see "Joining by itself"). Invite links still work as a fallback. |
| Browser UI (server-rendered HTML, cookie sessions, CSRF) | The app's renderer (Preact + htm, no build step). The server returns JSON, plus a few small HTML pages (below). |
| Sync keys (`api_tokens`, `wowg_…`) | Device tokens (`devices` table, `gcd_…`). One token per signed-in app, used for UI calls and sync. Revocable under Settings → Devices. |
| Web push, PWA, service worker | Server `events` table + app polling `GET /api/events` → native desktop notifications. |
| Addon via CurseForge / manual copy | The app installs (automatically, for supported game versions), updates, repairs and removes the addon in every detected game folder. CurseForge upload stays as an optional release step. |
| Downloads built into the Docker image | Releases are **published** to the server (`/data/updates`) by `scripts/release.js`, CI, or the in-app Releases page. The app self-updates from there (electron-updater, generic provider). |
| `/get` download page with companion zip | `/get` links the latest Windows installer. `/join/<code>` offers "Open in Guild Camp" (`guildcamp://join/<code>`). |

Kept on the server as non-JSON endpoints: Battle.net OAuth redirect pages, `/discord/interactions`, calendar `.ics` feeds,
`/updates/*` static files, `/healthz`, and small HTML landing pages for links shared outside the app (Discord posts,
invites): `/raids/:id` ("Open this raid in Guild Camp" → `guildcamp://raids/<id>`, no raid details), `/drives`
(→ `guildcamp://drives`), `/join/:code` (→ `guildcamp://join/<code>`) and `/get` (download). All built with
`htmlPage` / `sendHtml` from `http.js`.

## Versions

Everything starts at **0.11.0**: `app/package.json`, `server/package.json`, `## Version:` in `addon/WowGuild/WowGuild.toc`.
App and addon are released independently after that. Version strings are `MAJOR.MINOR.PATCH` with optional `-beta.N`.

## Repository layout

```
app/
  package.json            name guild-camp, productName "Guild Camp", main src/main/main.js
  electron-builder.yml    NSIS installer, generic publish provider, extraResources: ../addon/WowGuild → addon/WowGuild
  build/icon.png          512px app icon (electron-builder converts it to .ico)
  src/shared/             ZERO-DEPENDENCY CommonJS used by app, server and scripts (see "Shared modules")
  src/main/               Electron main process (CommonJS)
  src/preload/preload.js  contextBridge → window.gc
  src/renderer/           UI (ES modules, Preact + htm from src/renderer/vendor, no bundler)
  test/                   node:test unit tests for shared + main modules (plain Node, no Electron)
server/
  package.json            deps: better-sqlite3, express@5. devDeps: fengari (runs addon Lua in tests)
  Dockerfile              build context = repo root; copies server/ and app/src/shared/ (same relative layout)
  src/index.js            entry: config → db → createApp → listen → timers
  src/config.js  src/db.js  src/auth.js  src/http.js  src/context.js  src/app.js
  src/routes/<domain>.js  each exports register(app, ctx); app.js loads every file in routes/ automatically
  src/services/<name>.js  domain logic (ported from old web/src/*.js)
  test/                   node:test; test/helpers.js starts a server on an ephemeral port
addon/WowGuild/           the addon (ported from the old version)
scripts/release.js        CLI wrapper around app/src/shared/release.js
scripts/vendor.js         copies preact/htm/fonts into app/src/renderer/vendor (output is committed)
.github/workflows/release.yml  builds + publishes on tags app-v* / addon-v*
```

Requiring shared code: from `app/src/main/x.js` use `require('../shared/lua')`; from `server/src/**/x.js` use a path
to `app/src/shared` (e.g. `server/src/services/x.js` → `require('../../../app/src/shared/zip')`); from `scripts/` use
`require('../app/src/shared/release')`. Shared modules must never `require` anything outside Node built-ins.

## Shared modules (`app/src/shared/`)

| Module | Exports |
|---|---|
| `lua.js` | `parseSavedVariables(bufOrLatin1String) → {VarName: value}` (port of old `companion/lua.js`, byte-exact behaviour incl. UTF-8 decoding and array detection). `toLua(value) → string` (port of old `sync.js` toLua). `luaAssignment(name, value) → "Name = {...}\n"` |
| `version.js` | `parse(v) → {major,minor,patch,pre}|null`, `valid(v)`, `compare(a,b) → -1|0|1` (pre-release < release), `lt(a,b)`, `gt(a,b)`, `bump(v, 'patch'|'minor'|'major') → string` |
| `toc.js` | `readToc(text) → {fields: {Interface, Title, Version, ...}, files: [..]}`, `setTocField(text, field, value) → text` (keeps line endings), `tocVersion(text)` |
| `zip.js` | `createZip([{name, data: Buffer|string, mtime?}]) → Buffer` (deflate via zlib, store when not smaller), `readZip(buf) → [{name, data: Buffer, isDir}]` (supports store + deflate, rejects encrypted/zip64 gracefully with a clear error), `extractZip(buf, destDir)` (refuses absolute paths, `..`, drive letters: zip-slip safe), `zipDirectory(dir, {prefix}) → Buffer` |
| `auctionator.js` | `extractPrices(auctionatorDb, now?) → {items: [[itemId, copper, day]]}` (port of old companion) |
| `hash.js` | `sha256(buf) → hex`, `sha512Base64(buf)`, `sha256File(path) → Promise<hex>`, `sha512File(path) → Promise<base64>` |
| `release.js` | Release pipeline used by `scripts/release.js` AND the app's Publisher: `packAddon(addonDir) → {version, zip, sha256, size}`, `bumpAddonVersion(addonDir, bumpOrVersion) → version`, `bumpAppVersion(appDir, bumpOrVersion) → version`, `buildApp(appDir, {onLog, signal}) → {distDir}` (runs `npm run dist` in `app/`, i.e. `electron-builder --win --publish never`; aborting kills the process tree), `readAppBuild(distDir) → {version, files:[path], latestYml}`, `publishAddon({server, token, pack, notes, onLog})`, `publishApp({server, token, distDir, notes, onLog})`, `getReleases(server)`. Uses global `fetch`; streams files with `fs.createReadStream` + `duplex: 'half'`. |

## Server

### Conventions
- Express 5 (async handlers may throw; errors are caught by the error middleware in `app.js`).
- Every `/api/*` response is JSON. Errors: status 4xx/5xx with `{ "error": "Plain sentence for a person." }` (sometimes with a `code`, e.g. `NO_GUILD_MATCH`). Throw `new HttpError(status, message)` from `http.js`.
- Auth: `Authorization: Bearer gcd_…` (device token). Middleware in `app.js` sets `req.user`, `req.device`, `req.guild` (row from `guilds` plus `role`), or leaves them `null`.
- Guards from `http.js`: `needUser`, `needGuild`, `needOfficer` (owner or officer), `needOwner`, `needPublisher` (owner device token OR `Authorization: Bearer <PUBLISH_TOKEN>` env).
- Inputs: use `str(v, max)`, `int(v)`, `bool(v)`, `oneOf(v, list)` from `http.js`. Never trust lengths; cap lists.
- Times: SQLite `datetime('now')` strings ("YYYY-MM-DD HH:MM:SS", UTC) are returned as-is; scheduled times (raids) are ISO 8601 UTC strings. Clients parse both as UTC.
- Money is integer copper.
- Single guild per server for now: `POST /api/guild` only works while no guild exists. Every guild-owned row keeps `guild_id`.
- Rate limits (`ratelimit.js`, in-memory): `/api/sync` 40/min per device, `/auth` + `/api/auth` 20/min per IP, `/discord` 120/min, `/api/publish` 30/min.
- Security headers on every response (nosniff, frame DENY, referrer same-origin; HSTS when BASE_URL is https).

### `ctx` passed to `register(app, ctx)`
```js
ctx = {
  db, cfg,                    // better-sqlite3 handle, config object from config.js
  audit(req, action, detail), // audit_log row for req.guild / req.user
  activity(guildId, kind, text),
  emit(guildId, kind, { title, body, route, userId, exceptUserId, officersOnly, recipe }), // events table → app notifications
  discord(guild, content),    // POST to the guild's webhook (no-op without one; never throws)
  services: {},               // domain services attach here so routes can share them (e.g. ctx.services.coach)
  timers: [],                 // push setInterval handles here; index.js clears them on shutdown
  latest(),                   // { app: {version,...}|null, addon: {version,...}|null } from the releases service
}
```
`cfg.timers === false` in tests: never start intervals then. Tests can pass `cfg.fetch` to stand in for outside HTTP (Battle.net, Discord, Blizzard, Anthropic).

### Events (notifications)
`emit()` inserts into `events`. The app polls `GET /api/events?after=<id>` every 20 s and shows a native notification for
each event the user's prefs allow (`users.notify_prefs` JSON: `{cta, raids, notices, requests, bank, coach, drives}` all
default true). Kinds: `cta`, `raid`, `notice`, `request`, `bank`, `coach`, `drive`, `release`. `route` is an app route
such as `/raids/12`. `recipe` limits a `request` event to members whose characters know that recipe. `officersOnly`
limits to owner/officers. Events older than 14 days are pruned.

### API surface (owner domain → file)
Exact request/response shapes live in `docs/api/<domain>.md`, written by whoever implements the domain.

- **core** (`routes/auth.js`, `routes/guild.js`, `routes/events.js`)
  - `GET /api/meta` public → `{ server: 'guild-camp', version, devLogin, bnet, guild: {name, faction}|null, releases: {app, addon} }`
  - `GET /auth/bnet?device=&platform=&appVersion=` public, browser → Battle.net (scope `openid wow.profile`); `GET /auth/bnet/callback` → reads the player's WoW characters, then `302 /auth/app/done#token=gcd_…`; `GET /auth/app/done` small HTML
  - `POST /api/auth/dev {battletag, device}` (DEV_LOGIN=1 only) → `{token, user}`; `POST /api/auth/signout`
  - `GET /api/me` → `{user, guild|null, role|null, device, notifyPrefs, bnet: {characters, profile_at, note}}`; `PUT /api/me/notifications`
  - `GET /api/devices`, `DELETE /api/devices/:id`
  - `POST /api/guild {name, faction, realm?, game_guild?}`, `GET /api/guild/invite/:code` public preview, `POST /api/guild/join {code}`
  - `POST /api/guild/auto-join {characters}` → auto-join result (see "Joining by itself")
  - `GET /api/guild`, `PUT /api/guild/settings` (officer; incl. `auto_join`, `officer_rank_max`), `POST /api/guild/invite/reset` (officer)
  - `GET /api/members`, `POST /api/members/:id/(promote|demote|remove)` (remove also signs out their devices, drops sync keys, unlinks characters and their Discord account)
  - `GET /api/events?after=`
- **sync** (`routes/sync.js`, `services/sync.js`, `services/economy.js`): `POST /api/sync` (a signed-in non-member is matched to the guild first: `joined` in the reply, or `409 { code: 'NO_GUILD_MATCH', autoJoin }` and nothing stored), `GET /api/inbox`
- **community** (`routes/community.js`): camp dashboard, CTAs, announcements, activity, onboarding, roster, characters, mains, crafters, crafting requests, leveling partners, shopping lists
- **raids** (`routes/raids.js`, `services/raids.js`): raids + other event kinds, sign-ups, soft reserves, SR+ loyalty, loot screen, rolls, awards, loot lists, history, reminders, `/raids/:id` landing page
- **economy** (`routes/economy.js`): guild bank, bank requests, bank characters, alt search, price index, supply drives, `/drives` landing page
- **discord** (`routes/discord.js`, `services/discord.js`): interactions endpoint, slash commands, link codes, register commands, Discord scheduled events
- **coach** (`routes/coach.js`, `services/coach.js`, `services/ai.js`): play style, plans, Q&A, budget/usage
- **admin** (`routes/admin.js`, `services/backup.js`, `services/reset.js`, `services/blizzard.js`, `services/gamedata.js`, `services/calendar.js`): sync health, backups, audit log, fresh start, Blizzard/game data, realm status, calendar feeds
- **releases** (`routes/releases.js`, `services/releases.js`): `GET /api/releases`, publish endpoints, `/updates/*`, `/get`, `/join/:code`

### Joining by itself (`services/membership.js`; full rules in `docs/api/core.md` "Joining by itself")
- **Battle.net characters.** Sign-in asks for `openid wow.profile`. In the callback the server uses the access token
  once (never stored) to read the player's characters from every profile namespace (Retail, Classic, Classic Era,
  WoW: Forever guesses) plus the guild of the 10 highest-level ones (guild realm first), and replaces their `bnet_characters` rows
  (`users.bnet_profile_at` / `bnet_profile_note`). Bounded by a timeout; a Battle.net failure never fails sign-in.
- **Reported characters.** The app sends the characters the addon saved (`WowGuildDB.characters`, every game folder).
- **Matching** (`tryAutoJoin`, one guild per server). The guild roster = this guild's `characters` from a roster scan
  or Blizzard's official roster. (1) A Battle.net character on the guild's realm (when both are known) whose name is
  in the roster, or whose in-game guild is `guilds.game_guild` → `via: 'battlenet'`. (2) Only in `roster` mode: a
  reported character whose guild is `game_guild`, on the guild's realm, in the roster and not owned by another
  member → `via: 'roster'`.
- **Guild settings.** `guilds.auto_join`: `roster` (default; Battle.net or reported), `verified` (Battle.net only),
  `off` (invite links only). `guilds.officer_rank_max`: in-game rank index (0 = Guild Master) up to which a member
  is an officer here (default 1; `null` = off).
- **Roles.** `memberships.role_source`: `manual` (creating the guild, invite link, promote/demote; never changed
  automatically) or `rank` (joined by itself; `syncRanks` sets officer/member from in-game rank after trusted roster
  scans, the official roster, a change of `officer_rank_max`, and each auto join).
- **Result** (same shape from `POST /api/guild/auto-join`, the `autoJoin` of a 409 from `/api/sync`, IPC and the
  app's `membership` channel): `{ status: 'joined'|'already'|'no-guild-on-server'|'no-match'|'disabled', guild, role,
  via, character, reason, detected }`. `no-guild-on-server` + `detected` lets the first person set the guild up in one
  click (`POST /api/guild` with the detected name, faction, realm and `game_guild`); they become the owner.

### Release hosting (server)
Files live under `UPDATES_DIR` (default `<dir of DB_FILE>/updates`, i.e. `/data/updates` in Docker):
```
updates/app/latest.yml                     written last, atomically (electron-updater reads it)
updates/app/Guild-Camp-Setup-0.11.1.exe    + .blockmap
updates/addon/latest.json                  {version, notes, sha256, size, file, publishedAt}
updates/addon/WowGuild-0.11.1.zip
```
- `GET /api/releases` (public) → `{ app: {version, notes, publishedAt, file, url, size}|null, addon: {version, notes, publishedAt, sha256, size, url}|null, history: [{kind, version, notes, publishedAt, by}] }`
- `PUT /api/publish/app/files/:name` (needPublisher, raw body streamed to disk; name must match `^[\w.\- ]+\.(exe|blockmap|dmg|zip|AppImage)$`)
- `POST /api/publish/app/commit {version, notes, latestYml}` → verifies every file named in latest.yml exists with the sha512 and size it states, writes latest.yml atomically, records `releases` row, emits a `release` event, keeps the newest 5 app versions on disk.
- `PUT /api/publish/addon?notes=…&force=0` raw zip → must contain `WowGuild/WowGuild.toc` whose `## Version:` is valid and newer than the current (unless force=1). Stores zip, writes `latest.json`, records release, emits event.
- If no addon was ever published, the server falls back to the addon bundled in the Docker image (`/srv/addon/WowGuild`, zipped on first request) so new installs always get one.

## App (Electron)

### Security
`contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`. The renderer is served from a privileged custom
protocol `app://guildcamp/` (registered as standard + secure + supportFetchAPI) that maps to `src/renderer/`.
The renderer **never** talks to the server directly and never sees the device token: every server call goes through IPC
(`api.request`) and the main process adds the token. External links open in the system browser
(`setWindowOpenHandler` + `will-navigate` guard). CSP is set in `index.html`.
- **No third-party script runs in the app.** `lib/tooltip.js` fetches Wowhead tooltip data and renders sanitised
  HTML; the renderer only runs its own (vendored) scripts.
- **IPC hardening.** `api.request` only takes `/api/…` paths and refuses `/api/auth…` (sign-in hands out tokens: use
  `auth.*`) and `/api/publish…` (publishing goes through `publisher.*` with its own checks). A `serverUrl` change
  from the renderer is confirmed by the person in a native dialog before Guild Camp signs out and switches.
- **Deep links** (`guildcamp://`) only open read-only routes (see "Deep links").

### Main process modules (`app/src/main/`)
Only `main.js`, `window.js`, `ipc.js`, `auth.js`, `updater.js`, `startup.js`, `notify.js`, `tray.js` may `require('electron')`.
Everything else is plain Node, constructed with injected dependencies so tests can run without Electron.

| Module | Role |
|---|---|
| `main.js` | single-instance lock, `guildcamp://` deep links (`deepLinkRoute`), app lifecycle, builds services, `wireSession` (sign-in → sync + events + addon check; no guild → `membership.start()`; joined → uploads go at once; first sign-in of an installed app turns "start with Windows" on once via `startupDefaulted`), `--hidden` start, `--smoke` run, quit handling |
| `window.js` | `app://` protocol handler, main BrowserWindow (`titleBarStyle: 'hidden'` + `titleBarOverlay` matching the sidebar colour, min 1000×680, remembers bounds), close-to-tray |
| `tray.js` | tray icon + menu: Open, Sync now, Check for updates, Quit |
| `store.js` | `createStore(dir)` → JSON settings in `userData/settings.json` (atomic writes) + `secrets` (token encrypted with `safeStorage` when available, injected) |
| `log.js` | `createLog(dir)` → rotating `userData/logs/guildcamp.log` (1 MB × 3) + in-memory ring (500) + `on('line')` |
| `api.js` | `createApi({ getServer, getToken, appVersion, fetch })` → `request(method, path, body, {raw})`; normalises errors to `ApiError {status, message}`; 401 → emits `unauthorized` |
| `auth.js` | Battle.net sign-in window (`/auth/bnet?...` in a modal BrowserWindow, partition `persist:auth`; intercept navigation to `/auth/app/done#token=…`), dev sign-in, sign-out |
| `wow.js` | `findInstalls({ extraRoots, scanDefaults })` → `[{ dir, root, flavor: '_forever_', label: 'WoW Forever', addonsDir, wtfDir, accounts: [svFile...], addonInstalled }]`. Flavor folders match `^_.+_$`; known labels: `_forever_` WoW Forever, `_retail_` Retail, `_classic_era_` Classic Era, `_classic_` Classic, `_ptr_` PTR, `_beta_` Beta. Default roots as old companion plus registry-free common paths on C:–F:; `GUILDCAMP_NO_SCAN=1` turns the default roots off. An install counts even when the addon is not installed yet (the app installs it). `detectGuild({ extraRoots, scanDefaults })` → `{ characters: [...], guild: {name, realm, faction}|null }` read (never written) from every `WowGuildDB.characters`. |
| `sync.js` | `createSync({ api, store, log, wow, appVersion })` EventEmitter: polls SavedVariables mtimes every 4 s, waits until the file settles, uploads `WowGuildDB` (+ Auctionator prices) to `POST /api/sync`, writes `WowGuild_Inbox` (toc + `Inbox.lua` via `luaAssignment('WowGuildInbox', inbox)`), refreshes the inbox every 5 min, follows pending Coach answers (every 6 s up to 2 min), exponential retry 5 s → 5 min. Not in a guild yet: a 409 `NO_GUILD_MATCH` is waiting, not failing (state `no-guild`, retried when the game saves or after 60 s); an upload that joined emits `joined`. `status()`, `syncNow()`, `start()`, `stop()`, `clearNoGuild()`, events `status`, `log`, `uploaded`, `joined`, `no-guild`. |
| `membership.js` | `createMembership({ api, wow, auth, log, store })`: while signed in without a guild, sends `wow.detectGuild()` characters to `POST /api/guild/auto-join` now, every 60 s and when the game saves (`kick()`); refreshes auth on `joined`. `autoJoin()`, `status()`, `record(result)`, `start()`, `stop({ forget })`, `kick()`, event `change` → IPC channel `membership`. |
| `addon.js` | `createAddonManager({ store, log, wow, api, resourcesDir, fetch })`: bundled addon = `resourcesDir/addon/WowGuild` (dev: `../addon/WowGuild`); remote = `GET /api/releases` addon + download from `/updates/addon/...` verified by sha256. `status()`, `check()`, `install(dir)`, `update(dir)`, `updateAll()`, `repair(dir)`, `uninstall(dir)`. On check: auto-update when `settings.addonAutoUpdate`; auto-install into folders without the addon when `settings.addonAutoInstall`, only for flavors the bundled toc's `## Interface:` list supports, and never where the person removed it (`settings.addonOptOut`, until they install it there again). Installs are atomic: extract to `AddOns/.guildcamp-tmp-<rand>/WowGuild`, rename the old folder to `WowGuild.old-<ts>`, move the new one in, delete the old; roll back on failure. Never touches other addons. `WowGuild_Inbox` belongs to sync.js. |
| `updater.js` | wraps `electron-updater` `autoUpdater` with `setFeedURL({ provider: 'generic', url: <server>/updates/app })`; `autoDownload` per `settings.appAutoUpdate`; `status()`, `check()`, `download()`, `install()` (quitAndInstall); in dev (`!app.isPackaged`) reports state `dev` but still shows the server's latest version from `/api/releases`. Checks on start and every 30 min. |
| `publisher.js` | Owner-only Releases page backend. Uses `shared/release.js`. `status()` → `{ canPublish, repoDir, addonSource: {dir, version}, appVersion, published }`. `publishAddon({ sourceDir, bump, notes })` zips and uploads with the owner's device token. `publishApp({ bump, notes })` needs a source checkout (`repoDir`, auto-detected when running unpackaged: the repo root that contains `app/` and `addon/`); runs the build (`npm run dist` in `app/`) streaming output to `publisher:log`, then uploads. |
| `events.js` | polls `GET /api/events?after=` every 20 s while signed in; forwards each to the renderer (`server-event`) and to `notify.js` |
| `notify.js` | native `Notification`; click focuses the window and sends `navigate` with the event's route |
| `startup.js` | `app.setLoginItemSettings({ openAtLogin, args: ['--hidden'] })` |
| `ipc.js` | one `ipcMain.handle('gc:invoke', (e, method, ...args))` dispatcher over a flat `methods` map, plus `broadcast(channel, payload)` → `webContents.send('gc:event', channel, payload)` |

### Settings (`store.js`)
```js
{ serverUrl: 'https://wow.cjplumbing.co.za', extraWowFolders: [], syncEnabled: true, closeToTray: true,
  startWithWindows: false, addonAutoUpdate: true, addonAutoInstall: true, appAutoUpdate: true, notifications: true,
  theme: 'system', repoDir: null, lastEventId: 0, windowBounds: null, onboarded: false,
  startupDefaulted: false, addonOptOut: [] }
```
`lastEventId`, `windowBounds`, `startupDefaulted` and `addonOptOut` are managed by the main process; `settings.set` ignores them.

### IPC surface (`window.gc`)
`preload.js` exposes `window.gc = { invoke(method, ...args), on(channel, cb) → unsubscribe }` plus convenience wrappers
generated from the list below (`gc.sync.now()` === `gc.invoke('sync.now')`). Every method returns a Promise. Errors reject
with `{ message, status?, code? }`. `preload.js` lists the methods and channels itself (sandboxed); a test keeps them
in step with `METHOD_NAMES` / `EVENT_CHANNELS` in `ipc.js`.

```
app.info()                 → { version, isPackaged, platform, arch, electron, logFile, userData, repoDir, server, secretsEncrypted, startWithWindowsSupported, smoke }
app.openExternal(url)      app.openPath(path)      app.showItemInFolder(path)
app.pickFolder({ title })  → path|null
app.quit()                 app.relaunch()          app.rendererReady(info)   (the renderer is up: pending deep-link route delivered)
log.recent()               → [{ t, level, scope, msg }]
settings.get()             → settings       settings.set(patch) → settings   (serverUrl change: native confirm first)
auth.state({ refresh? })   → { signedIn, server, user, guild, role }
auth.signIn()              auth.devSignIn(battletag)      auth.signOut()        (each → state)
api.request(method, path, body?)   → data   (GET|POST|PUT|PATCH|DELETE; path starts with /api/, not /api/auth or /api/publish)
api.download(path, suggestedName)  → savedPath|null  (save dialog; used for backups)
wow.installs()             → installs (see wow.js)     wow.addFolder(dir)   wow.removeFolder(dir)
wow.detectGuild()          → { characters, guild|null }   (see wow.js)
guild.autoJoin()           → auto-join result (see "Joining by itself")      membership.status() → last result|null
sync.status()              → { enabled, running, state: 'off'|'idle'|'syncing'|'error'|'signed-out'|'no-game'|'no-guild', lastSyncAt, lastResult, lastError, noGuild: {reason, since}|null, files: [{file, account, install, label, flavor, lastUploadAt, lastError, nextRetryAt}], nextRetryAt, installCount, coachWaiting, recent }
sync.now()                 sync.setEnabled(bool)
addon.status()             → { bundled: {version}|null, remote: {version, notes, publishedAt}|null, latest: {version, source: 'bundled'|'remote'}|null, autoUpdate, autoInstall, supportedFlavors, checking, lastCheckAt, error, installs: [{ dir, flavor, label, addonsDir, installed: {version}|null, state: 'missing'|'outdated'|'current'|'newer', supported, optedOut, busy }] }
addon.check()   addon.install(dir)   addon.update(dir)   addon.updateAll()   addon.repair(dir)   addon.uninstall(dir)   addon.openFolder(dir)
updater.status()           → { state: 'dev'|'idle'|'checking'|'available'|'not-available'|'downloading'|'downloaded'|'error', current, available: {version, notes, date}|null, progress: {percent, bytesPerSecond, transferred, total}|null, error, lastCheckAt }
updater.check()   updater.download()   updater.install()
publisher.status()         publisher.publishAddon({ sourceDir, bump, notes })   publisher.publishApp({ bump, notes })   publisher.setRepoDir(dir)   publisher.cancel()
notify.test()
```
Event channels (`gc.on`): `auth`, `sync`, `addon`, `updater`, `publisher:log`, `server-event`, `navigate`, `log`, `settings`, `membership` (auto-join results).

### Renderer (`app/src/renderer/`)
- `index.html` has an import map: `preact` → `./vendor/preact.module.js`, `preact/hooks` → `./vendor/hooks.module.js`, `htm` → `./vendor/htm.module.js`. Fonts (Alegreya, Alegreya Sans) are vendored woff2 in `vendor/fonts/`.
- `lib/html.js` re-exports `html` (htm bound to Preact `h`), `render`, and the hooks.
- `lib/gc.js` thin wrapper over `window.gc` (with a dev fallback mock when `window.gc` is missing, so pages can be previewed in a plain browser).
- `lib/api.js`: `api.get(path)`, `api.post(path, body)`, `api.put`, `api.del`; `useApi(path, { refreshOn: ['raid', ...] })` → `{ data, error, loading, reload }` (reloads when a `server-event` of a listed kind arrives).
- `lib/session.js`: `useSession()` → `{ user, guild, role, isOfficer, isOwner, refresh }`.
- `lib/router.js`: hash router. `navigate(path)`, `useRoute()`, `<Link href>`. Routes come from `pages/index.js`.
- `lib/format.js`: `money(copper)` (g/s/c), `timeAgo(t)`, `localTime(iso)`, `parseTime(t)`, `classColor(cls)`, `className(cls)`.
- `components/`: `Page`, `Card`, `Table`, `Empty`, `Button` (variants primary/secondary/danger/ghost, `busy`), `Field`, `Input`, `Select`, `Textarea`, `Checkbox`, `Modal`, `Tabs`, `Pill`, `ClassName`, `Money`, `TimeAgo`, `LocalTime`, `ItemLink`, `Spinner`, `ErrorBox`, `ConfirmButton`, `Toasts` (`toast(msg, kind)`), `Progress`.
- Page modules: `pages/<name>.js` `export default function XPage({ params, query })`. Registered in `pages/index.js`:
  `{ path: '/raids/:id', load: () => import('./raid.js'), title: 'Raid', nav?: 'Guild'|'Play'|'Officers'|'App', icon?, officer?, owner? }`.
- Styling: `styles/tokens.css` (WoW: Forever palette: slate-navy frame `#18222e`, emblem blue `#1a5d8f`, Warcraft gold `#eaa93a`, cream lettering; light + dark), `styles/app.css`. No inline colour literals in components.
- Wowhead tooltips: `lib/tooltip.js` fetches Wowhead tooltip data and renders sanitised HTML; no third-party script runs in the app. `ItemLink` links to `https://www.wowhead.com/<game>/item=<id>` (opened in the system browser; game from `guild.wowhead_game`, default `classic` until Forever has its own Wowhead domain; `lib/wowhead.js` builds the URLs, as the old `views/wowhead.js` did).

### Navigation
```
Play:     Camp (/), Coach (/coach), Raids (/raids), Crafters (/crafters), Requests (/requests), Partners (/partners)
Guild:    Roster (/roster), Bank (/bank), Prices (/prices), Drives (/drives), Loot (/loot)
Officers: Officer tools (/admin), Guild settings (/guild-settings)
App:      Addon & sync (/addon), Settings (/settings), Updates (/updates), Releases (/releases, owner only)
```
Plus non-nav routes: `/raids/:id`, `/raids/:id/loot`, `/characters/:name`, `/welcome` (first run, below).

### First run (`pages/welcome.js`)
1. **Sign in with Battle.net** is the first and only required step (`?step=server` changes the server address).
2. Then an **automatic checklist** runs by itself: find the game folders, install the addon (supported flavors),
   join the guild (`guild.autoJoin` + the `membership` channel; the server also checks Battle.net characters), and
   offer "start with Windows" (an installed app turns it on once at the first sign-in).
3. Fallbacks on the same screen: `no-guild-on-server` → "Set up `<detected guild>` on this server" (one click; the
   person becomes the owner); `no-match` / `disabled` → paste an invite link or code (`?join=CODE` prefills it).
4. When everything is done the camp opens by itself.

### Deep links
`guildcamp://join/<code>` → `/welcome?join=<code>`. `guildcamp://raids/<id>`, `characters/<name>`, `coach`,
`crafters`, `requests`, `partners`, `roster`, `bank`, `prices`, `drives`, `loot`, `addon`, `updates`, `settings`
→ the same app route (at most three plain segments); anything else just focuses the app. A link that arrives before
the renderer is up waits for `app.rendererReady`. The server's HTML pages (`/raids/:id`, `/drives`, `/join/:code`)
link to these. Smoke runs and dev runs with their own user data folder don't register the protocol.

## The addon and the sync contract
- The addon writes `WowGuildDB` (SavedVariables) out of combat; WoW saves it on logout or `/reload`.
- The app uploads `WowGuildDB` as JSON to `POST /api/sync` (`X-App-Version` header). Payload shape = the old companion's (characters, roster, ctaQueue, guildBank, inventory, coach, reagentIds, shopping, addonVersion, prices from Auctionator).
- Response: `{ ok, characters, roster, recipes, ctas, inventory, bank, prices, coachPending, latest: { app, addon }, joined? }`.
  A signed-in member who isn't in the guild yet is matched first (`joined: { guild, role, via, character }` when that
  put them in); with no match the server answers `409 { error, code: 'NO_GUILD_MATCH', autoJoin }` and stores nothing.
- `GET /api/inbox` → the old `buildInbox` object plus `latestAddon` (version string) and `site` (server URL). The app writes it to `Interface/AddOns/WowGuild_Inbox/Inbox.lua` as `WowGuildInbox = {...}` with a toc copied from the installed addon's `## Interface:` line. The legacy `WowGuild/Data/Inbox.lua` path is dropped.
- The addon tells players to update from the Guild Camp app (not CurseForge / the site) when `latestAddon` is newer.

## Releasing (summary; full steps in docs/RELEASING.md)
- `node scripts/release.js addon --bump patch --notes "…"` → bumps the toc, zips, uploads.
- `node scripts/release.js app --bump minor --notes "…"` → bumps app/package.json, builds the installer, uploads exe + blockmap, commits latest.yml.
- Env/flags: `GUILDCAMP_SERVER`, `GUILDCAMP_PUBLISH_TOKEN` (server env `PUBLISH_TOKEN`), or `--server/--token`, or `.release.json` (gitignored).
- `--git` commits the bump and tags `app-v<version>` / `addon-v<version>` (`--push` also pushes); pushing such a tag runs `.github/workflows/release.yml` which does the same publish from CI.
- In the app (owner): Releases page → publish addon from a folder, or build + publish the app from a source checkout.

## Testing
- `npm test` at the root runs `app/test` and `server/test` with `node --test`.
- `server/test/wowsim.js` runs the real addon Lua under fengari against a mocked WoW client.
- `server/test/e2e.test.js`: simulated game → SavedVariables → the app's real `sync.js` engine → server → inbox → back into the simulated game.
- App main modules are tested in plain Node with temp dirs (never touch a real WoW install: pass `scanDefaults: false`
  or set `GUILDCAMP_NO_SCAN=1`).
- `npx electron . --smoke` (app/) screenshots every route into `app/dist/smoke` with its own user data folder. It is
  safe by default: no scanning of the usual game folders (`GUILDCAMP_NO_SCAN=1` unless `--smoke-scan`), and nothing
  installs, updates or syncs (addon auto-install/update, app auto-update, sync and notifications are off). Any other
  manual Electron run should use `GUILDCAMP_NO_SCAN=1` and `--user-data <scratch folder>`.
