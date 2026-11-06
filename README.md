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

## Profession helper (addon 0.4.0)

Built into the guild addon. It only reads profession and bag data, out of combat.

- **Skill-up guide:** opens beside the profession window. Lists the recipes that still give skill points, ranked by cost per expected point. Orange counts as 1 point, yellow ¾, green ¼, and grey is skipped. Recipes you can make from your bags come first. Prices come from Auctionator (live, if installed) or the guild price index. Click **+5 list** to add a recipe to your shopping list.
- **Shopping list:** a small movable tracker shows each mat as `have / need`. It also notes how many are on your alts or in the guild bank (from the site). It ticks off as you loot and tells you when everything's ready. The list also appears on the site's Crafters page, with a total cost.
- Commands: `/wow guide` (show/hide the guide), `/wow list` (show/hide the tracker), `/wow list clear`.

## Running it safely

- **Backups:** the server snapshots the database every day into `/data/backups` and keeps the last 14. Officers can make one on demand under **Officer tools**, and the owner can download them.
- **Officer tools** (`/admin`):
  - **Sync health:** last sync and addon/companion version per member. Outdated versions show in red. Grey rows haven't synced for a week.
  - **Backups.**
  - **Audit log:** promotions, removals, webhook changes, raids scheduled or closed, loot given, bank requests handled, drives, invite link changes.
- **Members:** officers can promote and remove members. Only the owner can demote or remove officers. Removing someone also kills their sync keys. **Replace invite link** makes a new one if the old link leaks.
- **Security:**
  - Content-Security-Policy and HSTS headers.
  - Rate limits: 40 uploads a minute per sync key, 20 sign-in attempts a minute per IP, 120 Discord calls a minute.
  - Sync keys only work while their owner is still in the guild.
- **Version notices:** the addon tells players in chat when a newer version is on `/get`, and so does the companion window.
- **Onboarding:** Camp shows each new member a short checklist until they've finished setup:
  1. Synced
  2. Professions opened
  3. Main chosen
  4. Discord linked
  5. Signed up for the next raid

### Companion options
| Command | What it does |
|---|---|
| `wow-companion.exe` | Run normally (watch and upload) |
| `wow-companion.exe --install-startup` | Start automatically with Windows (minimised) |
| `wow-companion.exe --uninstall-startup` | Stop starting with Windows |
| `wow-companion.exe --check` | Show which game folders it found and test the sync key |

It writes `companion.log` next to itself. Send that file when something isn't syncing. If the site is unreachable, it retries with growing waits (5 seconds up to 5 minutes) instead of hammering it.

### Addon options
`/wow options` (or Settings → AddOns → wow guild):
- login news
- update notices
- auto-open the skill-up guide
- show the shopping list on login
- share bank data

The addon also records PvP rank and honor, reputations and currencies (for example Merchant's Favor), and shows them on each character's page.

## Deploy on Coolify

1. Push this folder to a GitHub repo.
2. In Coolify: **New resource → your repo → Build pack: Dockerfile**, base directory `/`, Dockerfile location `/web/Dockerfile`, port `3000`. Each build also compiles `wow-companion.exe` and zips the addon. Both are served at `/get` (public download page) and `/downloads/...`.
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

## Coach (addon 0.8.0+, companion 0.5.0+)

- **In game:** `/wow coach`, the Coach tab, or a key binding opens the Coach window. It shows your play style, your build plan, your next steps, and lets you ask questions.
  - **Play style:** five scores (aggression, risk taking, social, PvP focus, pace) and an archetype. They come from a short quiz plus what the addon sees outside combat: fights started, deaths, time flagged or grouped, battlegrounds, honour kills, duels, quests.
  - **Build plan:** talents in order (already-taken ones are ticked), stat priority, gear and tips.
  - **Next steps:** worked out locally: unspent talent points, repairs, bag space, class trainer, professions behind your level, raid sign-ups, plus the plan's own steps.
- **Website:** `/coach` shows the same information and answers questions instantly.
- **How in-game questions travel:** a question asked in game is saved, sent at the next /reload (the Coach has a "Send now" button), and answered on the site. The companion keeps checking for up to two minutes and saves the answer, so one more /reload shows it. It also arrives as a phone notification.
- **Claude API:**
  - Set `ANTHROPIC_API_KEY` on the server.
  - Plans use `COACH_MODEL` (default `claude-sonnet-5-5`) and answers use `COACH_FAST_MODEL` (default `claude-haiku-5-5`). Both use Claude's web search, limited to Wowhead, warcraft.wiki.gg, Blizzard, Icy Veins and Reddit, so advice about WoW: Forever can be checked against current sources.
  - Every call is metered. Officers set a monthly budget (default $15) and can switch the AI off in Settings. Each member gets 30 questions and 5 plans a day.
- **Without a key:** play-style tracking and next steps still work.

## Free services built in

- **Calendar feed.** Settings → "Raids in your calendar" gives each member a private iCalendar link (Google, Apple, Outlook). Raids update by themselves with a 30-minute reminder. "Replace calendar link" kills the old one.
- **Phone and desktop notifications.** Standard web push (VAPID keys are made once and kept in the database). Sent for calls to arms, new or cancelled raids, the one-hour reminder, guild notices, crafting requests (only to members who know the recipe) and bank requests (officers). Each member picks which kinds they want. On iPhone the site must be added to the Home Screen first; the site ships a web app manifest and service worker for that.
- **Discord Events.** If the Discord app is invited as a bot with Manage Events (the invite link in Settings asks for it), new raids also appear in the server's Events list and are removed when cancelled.
- **Blizzard Game Data API.** Uses the same Battle.net app as sign-in (`BNET_REGION`, default `eu`). The server checks daily whether a WoW: Forever namespace exists yet and reads the Retail WoW Token price; officers see the result in Officer tools.
- **Wowhead tooltips** on every item and spell (see Addon polish).
- **Official game data** (`src/gamedata.js`). Item names and details for every item the guild has seen, from Blizzard's API (Classic Era item data until WoW: Forever is in the API, then Forever's own). Once Forever is there: realm status on the camp page every 5 minutes, with a "realm is back up" notification after downtime, and Blizzard's official guild list merged into the roster twice a day. The addon (0.7.2+) reports the realm and in-game guild name; officers can correct them in Settings → "Realm and official Blizzard data".

## Addon polish (0.7.0)

- **Looks like the game:** the window uses Blizzard's own frame and bottom tabs where the client has them, and falls back to its own look where it doesn't.
- **Item rows:** mats on the Professions tab and recipes in the skill-up guide show icons and quality colours, with the real item tooltip on hover. Shift-click links an item in chat.
- **Guide actions:**
  - click a recipe to open it in the profession window
  - **Make** crafts one when you have the mats
  - **+5 list** adds it to the shopping list
- **Auction house:** with Auctionator installed, **Search auction house** searches every missing mat, and **Auctionator list** saves them as an Auctionator shopping list.
- **Item tooltips:** guild crafters who can make the item, how many your other characters hold, and the guild bank count. The guild auction price also shows when Auctionator isn't installed. You can switch this off in Settings.
- **Plays well with other addons:** if LibDataBroker or LibDBIcon is loaded (Titan Panel, ElvUI, Bazooka, minimap button collectors…), the addon registers there instead of adding its own minimap button.

## In-game window (addon 0.6.0)

No typing needed. Click the **campfire button on the minimap**. Right-click it for settings, or drag it to move it. In Retail it's also in the addon drawer, and you can set a key under Key Bindings → AddOns → wow guild.

| Tab | What's there |
|---|---|
| **Camp** | Upcoming raids and your sign-up status, guild notices, what's been saved, and **Sync now** (saves and reloads so the companion uploads) |
| **Call to arms** | Where (with *Use my zone*), how many, what's happening, then **Sound the horn**. Shows calls waiting to send |
| **Professions** | Your skill levels, buttons for the skill-up guide and the on-screen shopping list, each recipe on the list with −1 / +1 / Remove, mats still needed, and **Clear list** |
| **Guild** | Crafting requests you can make, your own requests, leveling partners |
| **Settings** | Every option as a tick box (including the minimap button), the guild site address to copy, version and update notice |

## In-game commands (optional)

| Command | What it does |
|---|---|
| `/wow` | Open the guild panel (notices, requests you can craft, leveling partners) |
| `/wow cta Crossroads 8 Alliance at the FP` | Call to arms. Zone, then how many you need, then a message. Leave out the zone to use your current one. Offers a reload so it sends immediately. |
| `/wow sync` | Save everything now (then reload) |
| `/wow status` | What's been saved, and when news last arrived |
| `/wow guide` | Show or hide the skill-up guide next to your profession window |
| `/wow list` | Show or hide your shopping list tracker (`/wow list clear` empties it) |
| `/wow options` | Addon settings |

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
