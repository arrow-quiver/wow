# Guild Camp

A guild platform for **World of Warcraft: Forever** (PvP ruleset; Retail later), in three parts:

```
app/      Guild Camp, the Windows desktop app (Electron). Everything a member sees and does,
          plus background sync with the game, and it installs and updates the addon.
server/   The guild server (Node + SQLite JSON API). Shared guild data, Battle.net sign-in,
          Discord, calendar feeds, and hosting for app and addon updates.
addon/    WowGuild, the in-game addon (listed as "Guild Camp"; Forever 16001, Retail 120105).
scripts/  release.js: publish app and addon updates.
docs/     ARCHITECTURE.md (how it fits together), RELEASING.md, api/*.md (every endpoint).
```

Version 0.11.0 replaces the old companion exe and browser site. The old version is on the
`versions/0.10.0` branch.

## How it works

1. A member installs Guild Camp (from `<server>/get`) and signs in with Battle.net. That is the whole first
   run: Guild Camp finds every WoW folder (`_forever_`, `_retail_`, …), installs the addon where the game
   version is supported, and joins the member to the guild automatically when one of their characters is in
   the guild roster (verified by Battle.net, or from the characters the addon saved). The first person on a
   new server sets the guild up with one click and becomes the owner; officers can follow in-game ranks.
   Invite links still work for anyone the automatic match can't place.
2. The addon saves data out of combat into `WowGuildDB`. WoW writes it on logout or `/reload`.
3. The app sees the file change and uploads it to the server. Then it writes the guild's news into
   `Interface\AddOns\WowGuild_Inbox` so the addon shows it after the next `/reload`.
4. Everything else happens in the app: Camp, Coach, Raids (sign-ups, soft reserves with SR+ loyalty,
   loot screen), Crafters, Requests, Partners, Roster, Bank, Prices, Drives, Loot, Officer tools and
   Guild settings. Desktop notifications cover calls to arms, raids, notices, requests and Coach answers.
5. The app updates itself and the addon from the guild server. The owner publishes updates with
   `scripts/release.js`, a tag push (GitHub Actions), or the app's **Releases** page.

## Run it locally

```bash
npm install
```

That installs `app/` and `server/` too. Then, in two terminals:

```bash
cd server && DEV_LOGIN=1 PORT=3000 BASE_URL=http://127.0.0.1:3000 node src/index.js
```

```bash
cd app && GUILDCAMP_SERVER=http://127.0.0.1:3000 npx electron . --user-data ./dist/dev-profile
```

`DEV_LOGIN=1` lets you sign in by typing any BattleTag. `--user-data` keeps the dev app's settings and
sign-in apart from a real install. Add `GUILDCAMP_NO_SCAN=1` to stop the dev app looking in the real
game folders (it would otherwise install and update the addon there, like the real app does).

Tests (shared modules, app main process, every server domain, the real addon Lua in a simulated WoW
client, and an end-to-end run from game to server and back):

```bash
npm test
```

Screenshots of every page from the real app (needs a `DEV_LOGIN=1` server; never touches game folders):

```bash
cd app && MSYS_NO_PATHCONV=1 GUILDCAMP_SERVER=http://127.0.0.1:3000 npx electron . --smoke --smoke-login=Dev#1234
```

## Deploy the server (Coolify)

1. New resource → this repo → Build pack **Dockerfile**, base directory `/`, Dockerfile `server/Dockerfile`, port `3000`.
2. Persistent storage mounted at `/data` (database, backups and published updates live there).
3. Environment (see `server/.env.example`): `BASE_URL`, `SESSION_SECRET`, `BNET_CLIENT_ID` / `BNET_CLIENT_SECRET`
   (redirect URL `<BASE_URL>/auth/bnet/callback`), `PUBLISH_TOKEN`, and optionally `DISCORD_*`,
   `ANTHROPIC_API_KEY`, `COACH_MODEL`, `COACH_FAST_MODEL`, `BNET_REGION`.
   The Battle.net client (develop.battle.net) needs the `wow.profile` scope enabled: sign-in asks for
   `openid wow.profile` so the server can read members' characters and match them to the guild.
4. Deploy. The first person to set up the guild in the app becomes the owner.

The new server opens the old site's database as it is: the old migrations are kept and new tables are
added on top. Old companion sync keys keep uploading until members switch to the app.

## Release updates

Short version (full guide: [docs/RELEASING.md](docs/RELEASING.md)):

```bash
node scripts/release.js addon --bump patch --notes "What changed"
```

```bash
node scripts/release.js app --bump minor --notes-from-git
```

Set `GUILDCAMP_SERVER` and `GUILDCAMP_PUBLISH_TOKEN` (the server's `PUBLISH_TOKEN`) first, or put them in
`.release.json`. Add `--push` to commit, tag (`app-v…` / `addon-v…`) and push; with the GitHub secrets set,
`.github/workflows/release.yml` publishes tagged versions too. Members get app updates in the background
(restart to install) and addon updates automatically in every game folder that has the addon (and new
installs in supported game folders, unless the member removed the addon there).

The app's installer isn't code-signed yet, so Windows SmartScreen asks once: **More info → Run anyway**.
