# wow: guild website + addon

Phase 1 of the guild platform for **World of Warcraft: Forever** (PvP ruleset). Retail comes later.

```
web/         the website (Node + SQLite), deploys to Coolify with the Dockerfile
addon/       WowGuild, the in-game addon (Forever interface 16001, Retail 120105)
companion/   the desktop app that carries data between the game and the site
```

## How the pieces talk

1. **The addon** saves data out of combat into WoW's SavedVariables file: your character, professions, learned recipes, the guild roster with who's online, and any `/wow cta` calls.
2. WoW writes that file when you **log out or `/reload`**. Addons can't send data any other way, and can't talk to other players inside dungeons or raids.
3. **The companion** sees the file change, uploads it to `/api/sync`, then downloads news and writes it to `addon/WowGuild/Data/Inbox.lua`. News covers notices, crafting requests you can make, and leveling partners.
4. On the next reload, the addon shows that news (`/wow` opens the panel).

## What's in Phase 1

- **Camp:** who's online around the fire, call to arms (posts to Discord), notices, activity.
- **Roster:** every guild member from in-game roster scans, plus characters linked to players.
- **Crafters:** search any recipe to see who in the guild can make it, plus a summary of everyone's professions.
- **Crafting requests:** post, claim, mark delivered. Crafters see requests they can fill in game.
- **Leveling partners:** post where and when you're questing.
- **Settings:** sync keys, invite link, Discord webhook, members and officers.

## What's in Phase 2

- **Raids:** officers schedule raids (times shown in everyone's own time zone). Members sign up with a character, role and note. Discord gets a post when a raid is scheduled and a reminder an hour before.
- **Soft reserves with loyalty bonus (SR+):** each raider reserves up to N items. When an item drops, reservers in the raid roll 1–100 plus their bonus. Bonus: +10 per raid attended with the same item reserved. It resets when you win the item, switch reserves, or sign up "Coming" and don't show.
- **Loot screen (phone):** `/raids/<id>/loot` for the raid leader. Roll, give, and record off-reserve loot. Everything goes to the loot history and Discord.
- **Loot lists:** officers paste `Boss | Item` lines per instance on the Loot page.
- **Readiness:** the addon records item level, repair % and consumables at each reload. Sign-ups show it, and flag low repair or no consumables.
- **In game:** `/wow` shows upcoming raids, whether you're signed up, and your reserves. Login reminds you if you haven't signed up for the next raid.

## What's in Phase 3

- **Discord slash commands:** `/online`, `/raids`, `/craft`, `/price`, `/cta`, `/signup` and `/link`. Discord calls the site directly (`/discord/interactions`, signature-checked), so no bot process runs. Members link their Discord once from Settings.
- **Bank:** guild bank contents, gold and log (read when anyone opens the guild bank), plus "bank characters" for guilds without one. Includes request → sent/declined, and a search across your own alts' bags and banks.
- **Prices:** a guild price index built from members' Auctionator scans (the companion reads `Auctionator.lua`). Shows a 2-week trend and values the bank stock.
- **Supply drives:** a goal and a unit (crates, mats, gold), members log contributions, with a progress bar and leaderboard. Discord posts when a drive starts and when it hits its goal.
- **Event types:** schedule PvP premades and guild events alongside raids (no reserves for those).

### Discord setup (once)
1. discord.com/developers/applications → **New Application**.
2. **General Information**: copy the *Application ID* and *Public Key*. Set *Interactions Endpoint URL* to `<BASE_URL>/discord/interactions`.
3. **Bot** → *Reset Token* → copy it (only needed to register the commands).
4. Set `DISCORD_APP_ID`, `DISCORD_PUBLIC_KEY` and `DISCORD_BOT_TOKEN` on the server and redeploy.
5. Site → Settings → *invite the app* to your server → **Register slash commands** → **Link Discord**, then run `/link CODE` in the server.

## Deploy on Coolify

1. Push this folder to a GitHub repo.
2. In Coolify: **New resource → your repo → Build pack: Dockerfile**, base directory `/web`, port `3000`.
3. Add a **persistent storage** volume mounted at `/data`. This holds the database: without it, data is lost on redeploy.
4. Set the environment variables from `web/.env.example`:
   - `BASE_URL`: the domain you give it in Coolify, e.g. `https://wow.cjplumbing.co.za`
   - `SESSION_SECRET`: a long random string (`openssl rand -base64 48`)
   - `BNET_CLIENT_ID` / `BNET_CLIENT_SECRET`: create a client at <https://develop.battle.net/access/clients>, with redirect URL `<BASE_URL>/auth/bnet/callback`
5. Deploy, open the site, sign in with Battle.net, and create the guild. **The first person to create it becomes the owner.**
6. Settings → copy the invite link for guildies, and paste a Discord webhook URL.

## Install for each player

1. Copy `addon/WowGuild` into the game's `Interface\AddOns` folder. For Forever that's probably `World of Warcraft\_forever_\Interface\AddOns` (check which `_xxx_` folder Forever uses).
2. Put `wow-companion.exe` anywhere and run it once. It creates `config.json` next to itself.
3. On the site: Settings → **Create sync key**. In `config.json`, set `syncKey` and `siteUrl`. If the companion can't find the game, set `wowFolder` to the folder that contains `Interface` and `WTF`.
4. Run the companion and leave it open while playing.
5. In game: open each profession window once so its recipes get saved, then `/reload`.

Windows may show a SmartScreen warning the first time, because the exe isn't code-signed. Choose "More info → Run anyway".

## In-game commands

| Command | What it does |
|---|---|
| `/wow` | Open the guild panel (notices, requests you can craft, leveling partners) |
| `/wow cta Crossroads 8 Alliance at the FP` | Call to arms. Zone, then how many you need, then a message. Leave out the zone to use your current one. Offers a reload so it sends immediately. |
| `/wow sync` | Save everything now (then reload) |
| `/wow status` | What's been saved, and when news last arrived |

## Development

```
cd web && npm install
npm test                                   # end-to-end: simulated game → companion → site → back into the game
DB_FILE=data/demo.db npm run demo          # sample guild data
DEV_LOGIN=1 DB_FILE=data/demo.db npm start # http://localhost:3000, sign in as J#1001
cd ../companion && npm run build:exe       # rebuilds dist/wow-companion.exe
```

The tests run the real addon Lua against a mocked WoW client (`web/test/wowsim.js`), so addon changes are covered too.

## Known unknowns (check after Forever launches on 4 Nov)

- The addon uses the modern API first and falls back to the classic API for professions and recipes, because Forever's exact profession API isn't documented. Run `/wow status` after opening a profession window to confirm recipes are being saved.
- The Forever install folder name (`_forever_`?). The companion searches every `_xxx_` folder that contains the addon.
- Blizzard hasn't published a web API namespace for Forever. When it does, we can add armory data such as gear.

## Multi-guild later

Every guild-owned table already has `guild_id`. To open the site to other guilds, lift the single-guild check in `POST /guild/create` and add guild selection.
