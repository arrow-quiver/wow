# Releasing Guild Camp

Release from `main`, after the pull requests for it are merged (see [CONTRIBUTING.md](CONTRIBUTING.md)).

Guild Camp has two things you release, each on its own schedule. Both are published as
**GitHub releases** on this repository, [arrow-quiver/wow](https://github.com/arrow-quiver/wow/releases).
Nothing is hosted anywhere else.

| What | Version lives in | Tag | Files on the release | Marked Latest? |
|---|---|---|---|---|
| The **app** (Windows installer) | `app/package.json` → `"version"` | `v<version>` | `Guild-Camp-Setup-<version>.exe`, its `.blockmap`, `latest.yml` | yes |
| The **addon** (WowGuild) | `addon/WowGuild/WowGuild.toc` → `## Version:` | `addon-v<version>` | `WowGuild-<version>.zip`, `WowGuild-<version>.zip.sha256` | never |

Players never download anything by hand:

- **The app updates itself.** It follows the release marked **Latest** (electron-updater's GitHub
  provider), reads its `latest.yml`, and downloads only the changed parts of the installer (that's what
  the `.blockmap` is for). Addon releases are never marked Latest, so they never hide the app's release.
- **The app installs and updates the addon** in every game folder it finds. It reads the release list
  from GitHub (no sign-in, at most every 30 minutes, more often only when someone presses **Check for
  updates**), picks the newest `addon-v*` release, downloads the zip and checks it against the `.sha256`.

There are three ways to publish, and they all do the same thing underneath (`app/src/shared/release.js`,
which runs the [GitHub CLI](https://cli.github.com), `gh`):

1. **The release script** on your computer: `node scripts/release.js …`
2. **GitHub Actions**: push a `v*` or `addon-v*` tag.
3. **The app itself**: the **Releases** page, on a computer set up for publishing (below).

Versions look like `1.2.3`, or `1.2.3-beta.1` for a test build. A release must be newer than the newest one
of its kind on GitHub, and a tag can only be released once.

---

## First-time setup

### 1. Make the repository public (the owner does this once)

Players' apps download releases without signing in to GitHub, so the repository has to be public. Until
it is, apps say "No app release has been published on GitHub yet" and keep the addon that came with them.

Before you do it, make sure nothing secret was ever committed (the Battle.net secret and `.release.json`
are gitignored; check the history if you're unsure). Then the repository owner runs:

```
gh repo edit arrow-quiver/wow --visibility public --accept-visibility-change-consequences
```

(Or on github.com: **Settings → General → Danger Zone → Change visibility**.)

### 2. Install GitHub CLI and sign in

Every way of publishing uses `gh`. On the computer you publish from:

1. Install it: `winget install --id GitHub.cli` (or download it from [cli.github.com](https://cli.github.com)).
   Version 2.29 or newer is needed (`gh --version`). Open a new terminal afterwards, and restart Guild Camp
   if it was running.
2. Sign in: `gh auth login`. Choose **GitHub.com**, **HTTPS**, and sign in in the browser with an account that
   can **push** to arrow-quiver/wow (the owner, or a collaborator with write access).
3. Check it: `gh auth status`.

GitHub Actions doesn't need this: `gh` is already installed there and uses the workflow's own token.

### 3. Create the Battle.net client (for sign-in inside the app)

Guild Camp signs players in with Battle.net from inside the app, using a client id and secret that are
**built into the installer**. They are never committed (the repository is public).

1. Go to [develop.battle.net](https://develop.battle.net/access/clients) and create a client.
2. Add this **Redirect URL**: `http://localhost:47615/auth/callback`
3. Keep the **Client ID** and **Client Secret**.

Give them to the release tooling in one of these ways:

- **Environment variables** `GUILDCAMP_BNET_CLIENT_ID` and `GUILDCAMP_BNET_CLIENT_SECRET`
  - PowerShell: `$env:GUILDCAMP_BNET_CLIENT_ID = "…"; $env:GUILDCAMP_BNET_CLIENT_SECRET = "…"`
  - Git Bash / macOS / Linux: `export GUILDCAMP_BNET_CLIENT_ID=… GUILDCAMP_BNET_CLIENT_SECRET=…`
- **`.release.json`** at the repo root (gitignored, never commit it):
  ```json
  { "bnetClientId": "…", "bnetClientSecret": "…" }
  ```

Environment variables win over `.release.json`. Just before electron-builder runs, the release tooling writes
them to `app/src/main/bnet-credentials.json` (also gitignored), which goes into the installer, and deletes the
file again when the build ends. Setting only one of the two is refused, so a release never goes out half set up.
Without them, the build still works but has no Battle.net sign-in (people can use the app without signing in),
and the tooling says so.

When you run the app from source (`npm start` in `app/`), the same two environment variables turn on
Battle.net sign-in for that run.

### 4. GitHub Actions secrets (for releases from CI)

Publishing from CI needs no token of yours: the workflow uses its built-in `GITHUB_TOKEN` with
`permissions: contents: write`. Add these repository secrets (**Settings → Secrets and variables →
Actions**, or with `gh`):

| Secret | Needed | Value |
|---|---|---|
| `GUILDCAMP_BNET_CLIENT_ID` | for Battle.net sign-in | the Battle.net client id |
| `GUILDCAMP_BNET_CLIENT_SECRET` | for Battle.net sign-in | the Battle.net client secret |
| `CF_API_TOKEN` | no | a CurseForge API token, to upload the addon there too (see the end of this page) |

```
gh secret set GUILDCAMP_BNET_CLIENT_ID --repo arrow-quiver/wow
gh secret set GUILDCAMP_BNET_CLIENT_SECRET --repo arrow-quiver/wow
```
(Each asks for the value, so it doesn't end up in your shell history.)

If your organization limits workflow permissions to read-only, allow write access under
**Settings → Actions → General → Workflow permissions**.

### 5. Building the app

The Windows installer is built with electron-builder, on Windows. To build on your own computer, install
Node.js 24, then run `npm install` in `app/` once. If you aren't on Windows, use GitHub Actions for app
releases (it builds on a Windows machine).

Check everything:
```
node scripts/release.js status
```
It shows whether GitHub CLI is signed in and can publish, whether the Battle.net credentials are set, and the
versions in your checkout next to the newest releases on GitHub.

---

## Each release

### Option A: from your computer

**Addon:**
```
node scripts/release.js addon --bump patch --notes "Tooltips show guild bank stock."
```
This bumps `## Version:` in `WowGuild.toc`, zips `addon/WowGuild` into one `WowGuild/` folder, writes the zip
and its `.sha256` to `dist/`, and runs `gh release create addon-v<version> … --latest=false`.

**App:**
```
node scripts/release.js app --bump minor --notes-from-git
```
This bumps `app/package.json`, runs the build (`npm run dist` in `app/`, a few minutes) with the Battle.net
credentials built in, and runs `gh release create v<version> <installer> <blockmap> latest.yml --latest`.

**Both:** `node scripts/release.js all --bump patch --notes "…"`

Useful options:

| Option | What it does |
|---|---|
| `--bump patch` / `minor` / `major` | bump the version first (`1.2.3` → `1.2.4` / `1.3.0` / `2.0.0`) |
| `--bump beta` | a test build: `1.2.3` → `1.2.4-beta.1` → `1.2.4-beta.2` |
| `--version 1.4.0` | set an exact version |
| `--no-bump` | release the version already in the files (the default) |
| `--notes "…"`, `--notes-file notes.md` | the release notes players see in the app (and on the GitHub release) |
| `--notes-from-git` | notes = the subjects of commits that touched `addon/WowGuild` (or `app/`) since the last `addon-v*` (or `v*`) tag |
| `--dry-run` | build and zip, but publish nothing; prints where the files are (the addon zip goes to `dist/`, the installer to `app/dist/`). Version bumps are still written, because the build needs them. Needs no GitHub CLI |
| `--git --push` | commit the version bump (`Release addon 1.2.4`), tag it (`addon-v1.2.4`), push both, then publish the release on that tag. `--git` without `--push` is refused when publishing, because the release has to point at a tag that is on GitHub |
| `--skip-published` | if GitHub already has this exact release, skip it instead of failing |
| `--curseforge` | also upload the addon zip to CurseForge |

Before a build, the script checks that GitHub CLI is installed, signed in and allowed to push, and what is on
GitHub, so a version that can't be published is refused straight away instead of after a long build.

Without `--git`, `gh` creates the tag on GitHub at the tip of the default branch, and your version bump stays
uncommitted: commit and push it afterwards, so the code on GitHub matches the release.

The `--git --push` tag also starts GitHub Actions; the workflow sees that the release is already there and stops.
(It then doesn't upload to CurseForge either, so pass `--curseforge` yourself if you want that.)

### Option B: through GitHub Actions

Let CI build and publish, so your computer only makes the tag:
```
node scripts/release.js addon --bump patch --tag-only --push
node scripts/release.js app --bump minor --tag-only --push
```
`--tag-only` bumps the version, commits it, and tags it, without building or publishing. `--push` sends the
commit and tag to GitHub, and `.github/workflows/release.yml` takes over:

- `v*` tags: builds the installer on Windows (with the Battle.net secrets) and publishes release `v<version>`, marked Latest.
- `addon-v*` tags: zips the addon and publishes release `addon-v<version>`, and uploads it to CurseForge when
  `CF_API_TOKEN` is set.

The workflow checks that the tag matches the version in the files, and writes the notes from the commits since
the previous tag. You can also tag by hand: bump the version, commit, `git tag addon-v1.2.4`,
`git push origin HEAD addon-v1.2.4`.

To publish the version that's already in the files without a tag, run the **Release** workflow from the
**Actions** tab, pick `addon` or `app` and the branch. You can type notes there. The new tag goes on the commit
the workflow ran on.

### Option C: in the app

Open **App → Releases**. Until the computer is set up, the page lists what is missing: a source checkout of this
repository (with `npm install` done in `app/`), GitHub CLI installed, `gh auth login` done, and push access.
Players never need any of this.

Once it is set up:

- **Publish an addon update**: pick the `WowGuild` folder (your checkout's `addon/WowGuild`, or any copy),
  choose the bump, write notes, publish.
- **Publish an app update**: the page runs the same build (with the Battle.net credentials from the
  environment or the checkout's `.release.json`), shows its output as it goes, and publishes the release.

The page doesn't commit anything: commit and push the version bump afterwards.

---

## How players get updates

**The app** checks GitHub when it starts and every 30 minutes. With automatic app updates on in
**Settings** (the default), it downloads the update in the background and installs it the next time the
app restarts; the **Updates** page shows progress and can restart the app to install straight away.

**The addon** is handled by the app too. With automatic addon updates on in **Settings** (the default) it
updates every game folder it found. Otherwise the **Addon & sync** page shows an **Update** button per folder.
Players then `/reload` or restart the game. The addon also tells players in chat when a newer version is out,
and to update it from the Guild Camp app.

Each app installer also contains the addon as it was when that installer was built, so a brand-new player can
install it straight away (also while the repository is still private); the app then moves them to the newest
published addon.

New players download the installer from the Latest release:
`https://github.com/arrow-quiver/wow/releases/latest`.

---

## Rolling back

**Addon.** The best fix is a new version with the old code, because every player gets it automatically.
Say 0.11.2 is the bad release and 0.11.0 was fine:
```
git checkout addon-v0.11.0 -- addon/WowGuild
node scripts/release.js addon --version 0.11.3 --notes "Back to the 0.11.0 behaviour while we fix the tooltip bug."
```
(Use `--version` with a number above the bad release: the restored `WowGuild.toc` still says 0.11.0.)

To stop a bad addon release from spreading right away, delete it on GitHub (or edit it and turn it back into a
draft): within half an hour apps offer the previous release again. Players who already installed the bad one keep
it until a newer version comes out; **Repair** on the Addon & sync page puts them back on the newest published one.

**App.** The app never downgrades itself, so ship the fix as a new version: revert the bad change
(`git revert <commit>`), then `node scripts/release.js app --bump patch --notes "…"`.

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
| `GitHub CLI (gh) isn't installed. Install GitHub CLI and run gh auth login` | First-time setup, step 2. Open a new terminal (or restart Guild Camp) after installing. |
| `GitHub CLI isn't signed in. Run gh auth login` | Run `gh auth login` and choose GitHub.com. |
| `Your GitHub account (…) can't push to arrow-quiver/wow` | Ask the owner to add you as a collaborator with write access, or sign in with another account (`gh auth login`). |
| `GitHub already has the release addon-v1.2.3` | That version is out. Add `--bump patch` (or `--version`). In CI, `--skip-published` makes this a skip. |
| `GitHub already has addon 1.2.4, and 1.2.3 isn't newer` | Releases only move forward. Bump past the newest one. |
| `The tag addon-v1.2.4 already exists` | That version was tagged already. Bump again. |
| `--git needs --push when you publish` | Add `--push`, or use `--tag-only` to only make the tag. |
| `The tag … is on GitHub, but the release wasn't made` | Fix the problem shown above it, then run the command it gives (`--no-bump`, without `--git`). |
| `GitHub has an unfinished draft release for …` | A cancelled upload left a draft. Delete it on GitHub's Releases page, or with the `gh release delete` command shown. |
| `GUILDCAMP_BNET_CLIENT_ID is set but GUILDCAMP_BNET_CLIENT_SECRET isn't` | Set both (or neither). The same goes for `bnetClientId` / `bnetClientSecret` in `.release.json`. |
| `No Battle.net client id and secret were found, so this build has no Battle.net sign-in` | A warning, not an error. See first-time setup, step 3. |
| `The app build failed` | The lines above it are electron-builder's output. Run `npm install` in `app/` and try `npm run dist` there by hand. |
| `The build in app/dist is version X, but app/package.json says Y` | The build didn't finish; look at its output. |
| In the app: `No app release has been published on GitHub yet` | Publish an app release, or make the repository public (step 1). |
| In the app: `Guild Camp couldn't find its releases on GitHub. The project may not be public yet.` | Make the repository public (step 1). |
| In the app: `GitHub is limiting how often this computer can check for updates` | GitHub allows 60 unsigned requests an hour per address (a whole household or office shares it). The app waits and tries again by itself. |
