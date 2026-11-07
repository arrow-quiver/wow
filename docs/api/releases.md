# Releases API

What the desktop app should update to, the publish endpoints, the update files themselves, and two
public pages (`/get`, `/join/:code`). Implemented in `server/src/routes/releases.js` and
`server/src/services/releases.js`. The client side is `app/src/shared/release.js` (used by
`scripts/release.js`, CI and the owner's Releases page). General conventions (errors, auth, times) are in
[core.md](core.md).

## Files on disk

Everything lives under `UPDATES_DIR` (default `<folder of DB_FILE>/updates`, `/data/updates` in Docker):

```
updates/app/latest.yml                     electron-updater's manifest. Written LAST, atomically.
updates/app/Guild-Camp-Setup-0.11.1.exe    + Guild-Camp-Setup-0.11.1.exe.blockmap
updates/addon/latest.json                  { version, notes, sha256, size, file, publishedAt }
updates/addon/WowGuild-0.11.1.zip
```

- Uploads stream into a temp file in the same folder (`.upload-<hex>.part`) while they are hashed, and are
  moved into place with one rename once they check out. A refused or broken upload leaves nothing behind.
  Temp files left by a crash are deleted after an hour.
- The server keeps the **newest 5 app versions** on disk (by version number, read from the file names).
  Files the live `latest.yml` points at (and their `.blockmap`) are never deleted, even after a forced
  rollback. Files without a version in their name are left alone. Addon zips are kept.
- The `releases` table records each publish (notes, who, when). If it is empty (a replaced database), the
  manifests on disk stand in for "what is live".

---

## `GET /api/releases` (public)

```json
{
  "app": {
    "version": "0.11.1",
    "notes": "Faster sync after /reload.\nNew Updates page.",
    "publishedAt": "2026-11-06 18:00:00",
    "file": "Guild-Camp-Setup-0.11.1.exe",
    "url": "/updates/app/Guild-Camp-Setup-0.11.1.exe",
    "size": 92405112
  },
  "addon": {
    "version": "0.11.1",
    "notes": "Shopping list shows guild bank stock.",
    "publishedAt": "2026-11-05 18:00:00",
    "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "size": 148220,
    "url": "/updates/addon/WowGuild-0.11.1.zip",
    "source": "published"
  },
  "history": [
    { "kind": "app", "version": "0.11.1", "notes": "Faster sync after /reload.\nNew Updates page.", "publishedAt": "2026-11-06 18:00:00", "by": "Calvin#1234" },
    { "kind": "addon", "version": "0.11.1", "notes": "Shopping list shows guild bank stock.", "publishedAt": "2026-11-05 18:00:00", "by": null }
  ]
}
```

- `app` / `addon` are `null` when there is nothing to offer. `url` is relative to the server address.
- "Current" is the **newest publish**, not the highest number: after a forced rollback the older version is current.
- `notes` is `null` when the publisher wrote none. `publishedAt` is SQLite UTC (`"YYYY-MM-DD HH:MM:SS"`); when
  it comes from a manifest on disk (empty table) it may be ISO 8601 instead. Parse both as UTC.
- `addon.source`:
  - `"published"`: an addon release uploaded to this server.
  - `"bundled"`: **no addon was ever published**, so the server offers the addon it ships with
    (`BUNDLED_ADDON_DIR`, `/srv/addon/WowGuild` in Docker; `addon/WowGuild` in the repo). It is zipped on the
    first request (cached until its `## Version:` changes) and served at `/updates/addon/WowGuild-<version>.zip`.
    `publishedAt` and `notes` are `null`. New installs always get an addon this way.
- `history`: newest first, at most 30. `by` is the publisher's BattleTag, or `null` for the release token.
- `GET /api/meta` → `releases: { app, addon }` uses the same objects (`ctx.services.releases.latest()`, which
  `ctx.latest()` delegates to).

---

## Publishing

Every publish call needs `Authorization: Bearer <token>`, where the token is either the **guild owner's
device token** or the server's **`PUBLISH_TOKEN`** (`needPublisher` in `http.js`).

| Status | When | `error` |
|---|---|---|
| 401 | No token, or a signed-out device / old sync key | `"Sign in first."` (or the device/sync-key message from core.md) |
| 403 | A member's or officer's token, or a wrong bearer value | `"Only the guild owner or the release token can publish updates."` |
| 429 | More than 30 publish calls a minute | `"Too many uploads. Wait a minute and try again."` |

Each successful publish adds an audit-log line for the guild (`app release published` /
`addon release published`, detail like `0.11.2`, `0.11.0 (forced)`, `0.11.2 (release token)`) and a
`release` notification for every member (it ignores notification switches):

| Kind | `title` | `body` | `route` |
|---|---|---|---|
| app | `Guild Camp 0.11.2 is out` | first line of the notes (list bullet removed), or `Guild Camp downloads it in the background.` | `/updates` |
| addon | `Guild Camp addon 0.11.2 is out` | first line of the notes, or `Guild Camp updates it in your game folders.` | `/addon` |

Publishes run one at a time (commits, addon publishes and the final step of each upload queue up);
uploads themselves stream in parallel.

### App: upload each file, then commit

#### `PUT /api/publish/app/files/:name`
The raw file as the request body (any `Content-Type`; not parsed as JSON). Headers:
- `Content-Length` (checked against what arrives),
- `X-Sha512`: base64 sha512 of the file, optional. When sent, a mismatch is refused.

`:name` must match `^[\w.\- ]+\.(exe|blockmap|dmg|zip|AppImage)$`, must not start with a dot, and is at most
200 characters. Up to **600 MB** per file.

```json
{ "ok": true, "name": "Guild-Camp-Setup-0.11.2.exe", "size": 92405112, "sha512": "base64…", "unchanged": false }
```
Uploading a file that already exists replaces it, except a file the **live** release uses (listed in the
current `latest.yml`, or its `.blockmap`): identical bytes answer `unchanged: true`; different bytes are refused.

| Status | `error` |
|---|---|
| 400 | `"That file name isn't allowed. Upload the installer (.exe) or its .blockmap under a plain file name."` |
| 400 | `"Guild-Camp-Setup-0.11.2.exe didn't arrive intact (its checksum doesn't match). Try the upload again."` |
| 400 | `"The upload was empty."`, `"The upload was cut off before it finished. Try again."` |
| 409 | `"Guild-Camp-Setup-0.11.1.exe belongs to the live release and can't be replaced. Publish a new version instead."` |
| 413 | `"That upload is too large. App files can be up to 600.0 MB."` |
| 507 | `"The server's disk is full, so the upload couldn't be saved."` |

#### `POST /api/publish/app/commit` (JSON)
```json
{ "version": "0.11.2", "notes": "Faster sync.\nNew Updates page.", "latestYml": "version: 0.11.2\nfiles:\n  - url: …", "force": false }
```
1. `version` must be valid (`1.2.3`, `1.2.3-beta.1`) and equal latest.yml's `version`.
2. Unless `force` is true, it must be **newer** than the current app release, otherwise `409`.
3. Every file latest.yml lists (`files[].url`, plus `path`) must have been uploaded, with the `sha512` and
   `size` latest.yml states.
4. Only then is `latest.yml` written (exactly the text sent, atomically). That is the moment the release goes
   live for electron-updater.
5. Records the release (notes up to 4,000 characters), prunes old versions, notifies the guild.

```json
{
  "ok": true,
  "app": { "version": "0.11.2", "notes": "Faster sync.\nNew Updates page.", "publishedAt": "2026-11-07 18:00:00",
           "file": "Guild-Camp-Setup-0.11.2.exe", "url": "/updates/app/Guild-Camp-Setup-0.11.2.exe", "size": 92405112 },
  "pruned": ["Guild-Camp-Setup-0.10.7.exe", "Guild-Camp-Setup-0.10.7.exe.blockmap"],
  "forced": false
}
```

| Status | `error` |
|---|---|
| 400 | `"Send the version being published, like 1.2.3."`, `"Send the latest.yml that the app build made."`, `"That latest.yml is too large to be a real one."` (over 100 KB) |
| 400 | `"That latest.yml can't be read. latest.yml line 3: …"`, `"latest.yml is for version 0.11.1, not 0.11.2. Build the app again."`, `"latest.yml lists no files."` |
| 400 | `"latest.yml lists \"notes.txt\", which isn't an installer file name the server accepts."`, `"latest.yml has no checksum for Setup.exe."` |
| 400 | `"Guild-Camp-Setup-0.11.2.exe hasn't been uploaded. Upload every file latest.yml lists, then try again."` |
| 400 | `"Guild-Camp-Setup-0.11.2.exe on the server doesn't match latest.yml (different checksum). Upload it again."` (or `different size`) |
| 409 | `"Guild Camp 0.11.2 is already published, and 0.11.2 isn't newer. Publish a higher version."` |

When a commit fails, `latest.yml` and the releases table are unchanged.

### Addon

#### `PUT /api/publish/addon?notes=<text>&force=0|1`
The raw zip as the body (`Content-Type: application/zip`, not parsed as JSON). Headers: `Content-Length`,
`X-Sha256` (hex sha256 of the zip, optional, any case). Up to **20 MB**. `notes` travels in the query string
(up to 4,000 characters are kept).

The zip must contain only one `WowGuild/` folder (what `packAddon` makes), with `WowGuild/WowGuild.toc`
whose `## Version:` is valid. Unless `force=1`, the version must be newer than the current published addon
(the bundled one doesn't count), otherwise `409`. `force=1` republishes an older or equal version as the
current one (rollback). The zip is stored as `WowGuild-<version>.zip`, then `latest.json` is written
atomically, the release is recorded and the guild notified.

```json
{
  "ok": true,
  "addon": { "version": "0.11.2", "notes": "Tooltips show bank stock.", "publishedAt": "2026-11-07 18:00:00",
             "sha256": "…", "size": 148220, "url": "/updates/addon/WowGuild-0.11.2.zip", "source": "published" },
  "forced": false
}
```

| Status | `error` |
|---|---|
| 400 | `"The addon zip didn't arrive intact (its checksum doesn't match). Try the upload again."` |
| 400 | zip problems from `shared/zip.js`, e.g. `"This file isn't a zip, or it's damaged."`, `"\"x.lua\" in this zip is password-protected. …"`, `"The zip contains an unsafe file name (…). Nothing was extracted."` |
| 400 | `"The zip has files outside the WowGuild folder (\"Other/x.lua\"). Zip the WowGuild folder itself."` |
| 400 | `"The zip has no WowGuild/WowGuild.toc. Zip the WowGuild addon folder itself."` |
| 400 | `"WowGuild.toc needs a \"## Version:\" line with a version like 1.2.3 (found \"next\")."` |
| 400 | `"The upload was empty."`, `"The upload was cut off before it finished. Try again."` |
| 409 | `"Addon 0.11.2 is already published, and 0.11.1 isn't newer. Bump the version, or force it to roll back."` |
| 413 | `"That upload is too large. Addon zips can be up to 20.0 MB."` |

A refused upload is read to the end and then answered, so `fetch` clients always get the JSON error.

---

## Update files (public)

### `GET|HEAD /updates/app/<file>` and `/updates/addon/<file>`
Plain files from `UPDATES_DIR`. Only single file names (no folders; names starting with a dot are never
served). Anything else is `404 { "error": "Not found." }`.

| File | `Content-Type` | `Cache-Control` |
|---|---|---|
| `latest.yml` | `text/yaml; charset=utf-8` | `no-cache` |
| `latest.json` | `application/json; charset=utf-8` | `no-cache` |
| `*.exe`, `*.blockmap`, `*.dmg`, `*.AppImage` | `application/octet-stream` | `public, max-age=31536000, immutable` |
| `*.zip` | `application/zip` | `public, max-age=31536000, immutable` |

Files without a version in their name get `no-cache`. Installers and zips also get
`Content-Disposition: attachment`. ETag / Last-Modified / `If-None-Match` work as usual.

**Ranges** (electron-updater's differential download): `Accept-Ranges: bytes`. One range → `206` with
`Content-Range`. Several ranges in one request → `206 multipart/byteranges`, one part per range **in the order
asked, never merged** (that is what electron-updater's parser expects). A range past the end → `416`.

While no addon was ever published, `/updates/addon/WowGuild-<bundled version>.zip` serves the bundled addon
(`Cache-Control: public, max-age=3600`, ETag = its sha256).

---

## Pages (HTML, public)

Small self-contained pages in the WoW: Forever colours (`http.js` `htmlPage`), no scripts, no outside requests.

### `GET /get`
"Get Guild Camp": the guild's name, a **Download for Windows** button linking the latest installer
(`/updates/app/<file>`) with its version, date and size, three short steps (run the installer, sign in with
Battle.net, Guild Camp installs the addon), and the SmartScreen note (the app isn't code-signed yet: **More
info**, then **Run anyway**). Before any app release: a note that no installer is published yet.

### `GET /join/:code`
For a valid invite code: "Join <guild>" with faction and member count, an **Open in Guild Camp** button
(`guildcamp://join/<code>`), and for people without the app: "Don't have the app yet? Download it" (link to
`/get`) plus the code in large text to paste into the app. Unknown or replaced code → `404` page "That invite
link doesn't work. Ask an officer for a fresh invite link."

---

## Server code

```js
const releases = ctx.services.releases;   // registered by routes/releases.js
releases.latest();        // → { app, addon } (the /api/releases objects); ctx.latest() delegates here
releases.history(30);     // → [{ kind, version, notes, publishedAt, by }]
releases.currentApp();    // → app object or null
releases.currentAddon();  // → published addon, else bundled, else null
releases.publishedAddon();// → published addon or null (never the bundled one)
```

Test hooks (not environment variables): `cfg.maxAppFileBytes`, `cfg.maxAddonBytes` override the upload caps.
