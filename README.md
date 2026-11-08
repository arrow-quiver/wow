# Guild Camp

Guild Camp is a desktop app and an in-game addon for a **World of Warcraft: Forever** guild. There is no
website and no server: every player runs the app on their own PC, and the addon shares guild data with
guildmates inside the game.

## For players

What you get:

- **Camp**: who's online, calls to arms, notices, upcoming raids and what the guild has been up to.
- **Raids**: sign-ups, soft reserves with an SR+ loyalty bonus, a loot screen for officers, and loot lists.
- **Crafters, Requests and Partners**: who can make what, crafting requests, and leveling partners.
- **Bank, Prices and Drives**: the guild bank, bank requests, guild prices from Auctionator, and supply drives.
- **Coach**: learns how you play and suggests next steps. Its AI answers need your own Anthropic API key.
- **In game**: guild news, item tooltips (crafters, your alts, the guild bank), a skill-up guide and a shopping
  list.

How it works:

1. The addon saves what the game shows. WoW writes it to disk when you log out or type `/reload`.
2. The app reads that file and shows it. Changes you make in the app (a sign-up, a request) go to the addon,
   which sends them to your guild the next time you log in or type `/reload`.
3. Guildmates who are online pass guild data on to each other, so it reaches you even when the person who made
   it has logged off. New guild data shows in the app after you log out or type `/reload` in game.
4. Your role comes from your in-game rank. The Guild Master decides which ranks count as officers.

### Install

1. Download `Guild-Camp-Setup-<version>.exe` from the
   [latest release](https://github.com/arrow-quiver/wow/releases/latest) and run it. The installer isn't
   code-signed yet, so Windows SmartScreen asks once: **More info → Run anyway**.
2. Open Guild Camp. Sign in with Battle.net, or continue without it. Guild Camp finds your game folders and
   installs the addon.
3. Log in to the game on a character in your guild, then log out or type `/reload`. Guild Camp picks up your
   guild from there.

The app updates itself and the addon from GitHub. It starts with Windows and stays in the tray, so your guild
stays in sync. You can turn that off in Settings.

## For developers

You need Node.js 24 (the tests use its built-in `node:sqlite`, as the app does inside Electron) and Git.
Windows is the main target.

```bash
npm install                    # at the repo root; also installs app/
GUILDCAMP_NO_SCAN=1 npm test   # every test: node --test "app/test/**/*.test.{js,mjs}"
```

Run the app from `app/`, always with a scratch profile and without scanning your real game folders:

```bash
cd app
GUILDCAMP_NO_SCAN=1 npx electron . --user-data ./dist/dev-profile
```

Without those two settings a dev app finds your real World of Warcraft folders and installs, updates or syncs
the addon there, exactly like the installed app does. To try it with game data, add a fake game folder under
Addon & sync in the scratch profile.

Screenshots of every page with a demo guild (safe by default; nothing touches your game or settings):

```bash
cd app
npx electron . --smoke --smoke-seed      # pictures and a report in app/dist/smoke
```

Heavy simulations of many players run only with `GUILDCAMP_SIM_HEAVY=1`. Tests never touch the network, a real
game folder or the real GitHub CLI.

Read these next:

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how the app, its local core, the addon and GitHub fit together,
  the safety rules for development, and the test layout.
- [docs/SHARING.md](docs/SHARING.md): how the addon shares guild data in game.
- [docs/api/](docs/api/): every endpoint of the app's local core.

## Releasing

App and addon releases are GitHub releases on this repository, published with the GitHub CLI (`gh`):

```bash
node scripts/release.js addon --bump patch --notes "What changed"
node scripts/release.js app --bump minor --notes-from-git
```

Add `--dry-run` to build and zip without publishing. Pushing a `v<version>` or `addon-v<version>` tag publishes
from GitHub Actions instead, and the app's **Releases** page can publish from a PC that has the source code and
`gh` signed in. First-time setup (making the repository public, `gh auth login`, the Battle.net client id and
secret that are built into the installer) and every step are in [docs/RELEASING.md](docs/RELEASING.md).
