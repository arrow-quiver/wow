# Releasing Guild Camp

Guild Camp has two things you release, each on its own schedule:

| What | Version lives in | Published file | Tag |
|---|---|---|---|
| The **app** (Windows installer) | `app/package.json` → `"version"` | `Guild-Camp-Setup-<version>.exe` + `.blockmap` + `latest.yml` | `app-v<version>` |
| The **addon** (WowGuild) | `addon/WowGuild/WowGuild.toc` → `## Version:` | `WowGuild-<version>.zip` | `addon-v<version>` |

Releases are uploaded to your Guild Camp server, which keeps them under `/data/updates`. Players never
download anything by hand: the app updates itself from the server, and it installs and updates the addon
in every game folder it finds.

There are three ways to publish, and they all do the same thing underneath (`app/src/shared/release.js`):

1. **The release script** on your computer: `node scripts/release.js …`
2. **GitHub Actions**: push an `app-v*` or `addon-v*` tag.
3. **The app itself**: the Releases page (guild owner only).

Versions look like `1.2.3`, or `1.2.3-beta.1` for a test build. The server only accepts a version that is
newer than the one it has (except a forced addon rollback, below).

---

## First-time setup

### 1. Give the server a publish token

The publish token is a shared secret that lets the script and GitHub Actions upload releases.

1. Make a long random string:
   ```
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
2. Set it as the environment variable `PUBLISH_TOKEN` on the server (in Coolify: the app's
   **Environment Variables**), then restart or redeploy the server.

The guild owner can also publish from inside the app without this token: the app uses the owner's own
sign-in. The token is for the script and for CI.

### 2. Give the release script the same token

Pick one:

- **Environment variable** (good for a single session):
  - PowerShell: `$env:GUILDCAMP_PUBLISH_TOKEN = "<token>"`
  - Git Bash / macOS / Linux: `export GUILDCAMP_PUBLISH_TOKEN=<token>`
- **`.release.json`** at the repo root (remembered; the file is in `.gitignore`, never commit it):
  ```json
  { "server": "https://wow.cjplumbing.co.za", "token": "<token>" }
  ```
- **Flags** on each run: `--token <token>` and `--server <url>`.

Flags win over environment variables, which win over `.release.json`. The server defaults to
`https://wow.cjplumbing.co.za`; set `GUILDCAMP_SERVER` (or `server` in `.release.json`) if yours differs.

Check it works:
```
node scripts/release.js status
```
It shows the versions in your checkout next to what the server has published.

### 3. GitHub Actions (optional)

To publish by pushing a tag, add these repository secrets (**Settings → Secrets and variables → Actions**):

| Secret | Needed | Value |
|---|---|---|
| `GUILDCAMP_PUBLISH_TOKEN` | yes | the same value as `PUBLISH_TOKEN` on the server |
| `GUILDCAMP_SERVER` | no | your server address, if it isn't `https://wow.cjplumbing.co.za` |
| `CF_API_TOKEN` | no | a CurseForge API token, to upload the addon there too (see the end of this page) |

### 4. Building the app

The Windows installer is built with electron-builder, on Windows. To build on your own computer, install
Node.js 24, then run `npm install` at the repo root once. If you aren't on Windows, use GitHub Actions
for app releases (it builds on a Windows machine).

---

## Each release

### Option A: from your computer

**Addon:**
```
node scripts/release.js addon --bump patch --notes "Tooltips show guild bank stock."
```
This bumps `## Version:` in `WowGuild.toc`, zips `addon/WowGuild` into one `WowGuild/` folder, and uploads it.

**App:**
```
node scripts/release.js app --bump minor --notes-from-git
```
This bumps `app/package.json`, runs the build (`npm run dist` in `app/`, a few minutes), uploads the
installer and its `.blockmap`, and then makes the release live.

**Both:** `node scripts/release.js all --bump patch --notes "…"`

Useful options:

| Option | What it does |
|---|---|
| `--bump patch` / `minor` / `major` | bump the version first (`1.2.3` → `1.2.4` / `1.3.0` / `2.0.0`) |
| `--bump beta` | a test build: `1.2.3` → `1.2.4-beta.1` → `1.2.4-beta.2` |
| `--version 1.4.0` | set an exact version |
| `--no-bump` | release the version already in the files (the default) |
| `--notes "…"`, `--notes-file notes.md` | the release notes players see in the app |
| `--notes-from-git` | notes = the subjects of commits that touched `addon/WowGuild` (or `app/`) since the last `addon-v*` (or `app-v*`) tag |
| `--dry-run` | build and zip, but upload nothing; prints where the files are (the addon zip goes to `dist/`, the installer to `app/dist/`). Version bumps are still written, because the build needs them |
| `--git` | after publishing, commit the version bump (`Release addon 1.2.4`) and tag it (`addon-v1.2.4`) |
| `--push` | also push that commit and tag (implies `--git`) |
| `--skip-published` | if the server already has this exact version, skip the upload instead of failing |

Before a build or upload, the script checks what the server has, so a version that isn't newer is refused
straight away instead of after a long build.

If you push a tag with `--push` after publishing from your computer, GitHub Actions starts too, sees that
the server already has that version, and skips the upload. (It still uploads to CurseForge if
`CF_API_TOKEN` is set, so don't also pass `--curseforge` locally.)

### Option B: through GitHub Actions

Let CI build and publish, so your computer only makes the tag:
```
node scripts/release.js addon --bump patch --tag-only --push
node scripts/release.js app --bump minor --tag-only --push
```
`--tag-only` bumps the version, commits it, and tags it, without building or uploading. `--push` sends
the commit and tag to GitHub, and `.github/workflows/release.yml` takes over:

- `app-v*` tags: builds the installer on Windows and publishes it.
- `addon-v*` tags: zips and publishes the addon, and uploads it to CurseForge when `CF_API_TOKEN` is set.

The workflow checks that the tag matches the version in the files, and writes the notes from the commits
since the previous tag. You can also tag by hand: bump the version, commit, `git tag addon-v1.2.4`,
`git push origin HEAD addon-v1.2.4`.

To republish the version that's already in the files (for example after fixing a server problem), run the
**Release** workflow from the **Actions** tab and pick `addon` or `app`. You can type notes there.

### Option C: in the app

Signed in as the guild owner, open **App → Releases**:

- **Publish addon**: pick the `WowGuild` folder (your checkout's `addon/WowGuild`, or any copy), choose
  the bump, write notes, publish.
- **Build and publish app**: needs a source checkout of this repo with `npm install` done (set its folder
  on the page if the app doesn't find it). The page runs the same build and shows its output as it goes.

---

## How players get updates

**The app** checks the server when it starts and every 30 minutes. With automatic app updates on in
**Settings** (the default), it downloads the update in the background and installs it the next time the
app restarts; the **Updates** page shows progress and can restart the app to install straight away. Only
the changed parts of the installer are downloaded (that's what the `.blockmap` is for).

**The addon** is handled by the app too. It checks the server for the latest addon, and with automatic
addon updates on in **Settings** (the default) it updates every game folder it found. Otherwise the
**Addon & sync** page shows an **Update** button per folder. Players then `/reload` or restart the game.
The addon also tells players in chat when a newer version is out, and to update it from the Guild Camp app.

Each app installer also contains the addon as it was when that installer was built, so a brand-new player
can install it straight away; the app then moves them to the newest published addon.

---

## Rolling back

**Addon.** The best fix is a new version with the old code, because every player gets it automatically.
Say 0.11.2 is the bad release and 0.11.0 was fine:
```
git checkout addon-v0.11.0 -- addon/WowGuild
node scripts/release.js addon --version 0.11.3 --notes "Back to the 0.11.0 behaviour while we fix the tooltip bug."
```
(Use `--version` with a number above the bad release: the restored `WowGuild.toc` still says 0.11.0.)

You can also republish an older version number as the current one with `--force`:
```
node scripts/release.js addon --version 0.11.0 --force --notes "Rolled back."
```
New installs and players who haven't updated yet get 0.11.0. Players who already have the newer version
see it marked as newer than the published one; **Repair** on the Addon & sync page puts them on 0.11.0.

**App.** The app never downgrades itself, so ship the fix as a new version: revert the bad change
(`git revert <commit>`), then `node scripts/release.js app --bump patch --notes "…"`.

The server keeps the newest five app versions on disk.

---

## CurseForge (optional)

Players with the Guild Camp app don't need CurseForge. Listing the addon there lets other people use its
stand-alone features. It's listed as **Guild Camp** (CurseForge rejects names containing "WoW"); the
folder, SavedVariables and slash commands keep the `WowGuild` / `/wow` names.

First time:
1. On CurseForge's author site, create a project: World of Warcraft → Addons. The listing text is in
   `addon/CURSEFORGE.md`.
2. Run `node scripts/curseforge.js --dry-run`. It writes `dist/WowGuild-<version>.zip`. Upload that by
   hand as the first file, tagged **WoW Forever** and **Retail**, and wait for approval.
3. Add `## X-Curse-Project-ID: <id>` to `WowGuild.toc` (the number in the project's About box).
4. In the CurseForge author dashboard, create an API token.
   - For GitHub Actions: add it as the repository secret `CF_API_TOKEN`. Every `addon-v*` tag then uploads
     to CurseForge as well.
   - For the release script: set `CF_API_TOKEN` in your shell and add `--curseforge`:
     `node scripts/release.js addon --bump patch --notes "…" --curseforge`

Each file is tagged with the game versions in `## Interface:` (16001 → WoW Forever 1.60.1,
120105 → Retail 12.1.5). If CurseForge doesn't list that exact version yet, the newest one below it is used
and a warning is printed. Versions with `beta` or `alpha` in them upload as beta or alpha files.

---

## When something goes wrong

| Message | What to do |
|---|---|
| `No publish token` | Follow "First-time setup" steps 1 and 2. |
| `The server refused the request (403)` | The token doesn't match `PUBLISH_TOKEN` on the server, or `PUBLISH_TOKEN` isn't set there. Check for spaces, and that the server was restarted after setting it. |
| `The server refused the request (401)` | The token is a Guild Camp device token that was signed out (or an old `wowg_` sync key). Use the `PUBLISH_TOKEN` value instead, or sign in again. |
| `The server already has addon 1.2.3, and 1.2.3 isn't newer` | Add `--bump patch` (or `--version`). For a rollback, see above. |
| `The tag addon-v1.2.4 already exists` | That version was released already. Bump again. |
| `The app build failed` | The lines above it are electron-builder's output. Run `npm install` at the repo root and try `npm run dist` in `app/` by hand. |
| `The build in app/dist is version X, but app/package.json says Y` | The build didn't finish; look at its output. |
| `Couldn't reach https://…` | Check the server address (`node scripts/release.js status`) and that the server is up. |

On the server, published files are in `UPDATES_DIR` (default `/data/updates`):
```
updates/app/latest.yml                    electron-updater reads this (written last)
updates/app/Guild-Camp-Setup-0.11.1.exe   + .blockmap
updates/addon/latest.json                 version, notes, sha256, size, file
updates/addon/WowGuild-0.11.1.zip
```
