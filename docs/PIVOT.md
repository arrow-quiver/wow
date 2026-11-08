# Pivot: no server (binding contract for the rebuild, 2026-11-07)

**Status (2026-11-08): implemented.** The app, its local core, in-game sharing and GitHub releases work as
described here, and are covered by tests; in-game sharing still needs the checks in the real game listed in
[SHARING.md](SHARING.md) §15. How it fits together today: [ARCHITECTURE.md](ARCHITECTURE.md). The record below is
kept as the decision it was.

The product owner decided: **nothing is deployed anywhere. Only the Electron app (plus the addon) exists.**
The `server/` folder goes away as a deployable. Decisions, verbatim choices:

1. **Guild data is shared through the addon in game.** The WowGuild addon trades guild data with guildmates
   over WoW's hidden addon channel (GUILD, and OFFICER for officer-only data). The app reads and writes it
   on the player's PC through the two files it already uses: SavedVariables (`WowGuildDB`, written by WoW on
   logout or `/reload`) and the inbox addon (`WowGuild_Inbox/Inbox.lua`, read by the addon on login or `/reload`).
2. **Releases go on this GitHub repo (arrow-quiver/wow), which will be made public.** App updates: electron-updater
   **github** provider. Addon updates: the app reads GitHub releases. Publishing: `gh` CLI (local, CI with
   GITHUB_TOKEN, or the app's Releases page running `gh` on the owner's PC).
3. **Battle.net sign-in runs inside the app, with the client id and secret built into the installer**
   (never committed: the repo is public). Used for the BattleTag and the Retail/Classic character list.
   Without built-in credentials (dev builds), the app works without signing in.

## New shape

```
app/src/core/      the old server's domain logic, running INSIDE the Electron main process
                   (Express on 127.0.0.1:<random port>, per-launch random bearer secret; only the app's
                   own main process calls it). Database: node:sqlite (built into Electron 45 / Node 24)
                   in userData/guildcamp.db, through a small better-sqlite3-compatible adapter so the
                   ported code keeps working (prepare/run/get/all, transaction, pragma, exec).
app/src/main/      Electron main process (as before). api.js now talks to the local core.
app/src/renderer/  UI (as before; pages keep calling api.get('/api/...')).
app/src/shared/    zero-dep helpers (as before) + the sharing record codec used by core and tests.
addon/WowGuild/    the addon, now with a comm/sharing module (protocol in docs/SHARING.md).
scripts/release.js publishes to GitHub Releases with gh.
server/            DELETED at the end (its tests move to app/test/core/*).
```

### Identity, guild and roles (no accounts)
- **The guild** is the in-game guild of the player's most recently played character that has one
  (from `WowGuildDB.characters[*].guild/realm`). Created locally on first sync. One guild at a time.
- **Me**: one local user row. BattleTag from Battle.net when signed in, else the main character's name.
- **Other members** appear from the in-game roster scans and from records guildmates' addons share.
  A member is identified by character name (WoW authenticates the sender of an addon message);
  a shared "player" record links a player's characters (and BattleTag, if they signed in).
- **Roles come only from in-game guild ranks**: rank index 0 = Guild Master → owner; rank index ≤
  `officer_rank_max` (guild setting, default 1, changed only by the Guild Master and shared) → officer;
  else member. No manual promote/demote, no invites, no devices, no join step.
- **Permission checks without a server**: every shared record carries its author character. The addon
  (on receive) and the core (on import) accept officer-only record types only when the author's rank index
  in the guild roster is ≤ officer_rank_max (owner-only: rank 0). Records from non-guild members are ignored.

### Removed (server-only)
Battle.net OAuth on a server, device tokens, dev login, invite links, guild create/join, member
promote/demote/remove, auto-join/membership, server events polling (replaced by an in-process event bus →
native notifications), legacy companion sync keys, rate limits, HTML pages (/get, /join, /raids/:id, /drives),
Discord slash commands/interactions and link codes, the calendar URL feed (→ "Export to calendar" saves an
.ics file), server backups download (→ local backups of guildcamp.db), release hosting, PUBLISH_TOKEN.

### Kept, now local
Camp, Roster, Characters, Crafters, Requests, Partners, Raids (+ sign-ups, soft reserves, SR+ loyalty,
loot screen, loot lists), Bank (+ requests, bank characters), Prices (the player's own Auctionator data plus
prices shared by guildmates if the protocol carries them), Drives, Coach (play style and next steps local;
AI answers need the player's own Anthropic API key, entered in Settings, stored encrypted), Officer tools
(local: backups, audit log of shared actions, game data), Discord **webhook** posts (each app posts only
events its own player creates, if a webhook URL is set locally; officers can share the URL over the OFFICER
channel), Blizzard game data (item info, realm status) using the built-in Battle.net credentials
(client-credentials flow) when present.

### Release flow
- App: tag `v<version>` (electron-builder github provider default), GitHub release marked **Latest**, assets
  `Guild-Camp-Setup-<v>.exe`, `.blockmap`, `latest.yml`.
- Addon: tag `addon-v<version>`, GitHub release created with **make_latest=false** (so it never hides the app's
  latest), assets `WowGuild-<v>.zip` and `WowGuild-<v>.zip.sha256`. The app finds the newest `addon-v*` release
  via `https://api.github.com/repos/arrow-quiver/wow/releases` (unauthenticated, cached, at most hourly).
- `node scripts/release.js app|addon [--bump …] [--notes …]` builds/zips and runs `gh release create …`.
  CI (`.github/workflows/release.yml`) does the same on tag push with GITHUB_TOKEN.
- Battle.net credentials for builds: env `GUILDCAMP_BNET_CLIENT_ID` / `GUILDCAMP_BNET_CLIENT_SECRET`
  (local `.release.json` keys `bnetClientId`/`bnetClientSecret`, or GitHub secrets in CI) are written into a
  gitignored generated file `app/src/main/bnet-credentials.json` just before electron-builder runs.
  Redirect URI to register at develop.battle.net: `http://localhost:47615/auth/callback`.
