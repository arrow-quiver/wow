# Warband Codex

A standalone all-in-one addon for **WoW Forever** (`addon/WarbandCodex`). Any player can use it on its own; with
Guild Camp (`addon/WowGuild`) installed it also shows the guild's events, dungeon groups and kill-on-sight list, and
hands Guild Camp a snapshot of the character for the guild site.

"Warband Codex" is a working name. To rename: the folder, the `.toc` file name and title, `ns.NAME` in `Core.lua`,
the saved-variable name `WarbandCodexDB`, the slash commands and the frame names (`WarbandCodexWindow` …).

Keep this file outside `addon/WarbandCodex` so it isn't packaged.

## Install (until it has its own release)

Copy the `addon/WarbandCodex` folder into the game's `Interface\AddOns` folder and restart the game. Open it with
`/codex` (or `/wbc`), the book on the minimap, or the addon drawer.

The Guild Camp app does not install or update it yet, and `scripts/release.js` does not package it yet.

## What's in it

| Tab | What it does | Where its data comes from |
|---|---|---|
| Home | Character banner, gold, bags, durability, and "Next steps" gathered from every tab | The game |
| Armory | Upgrades for your talent tree with the gain in %, wishlist, sets, an upgrade line on item tooltips | Items in bags, the wishlist, loot the Codex has seen; stat weights in `Data/Classes.lua` |
| Dungeons & Raids | Bosses in order, loot seen per boss with your own drop rate, quests to bring, keys and attunements, a card on entering | Baseline in `Data/Dungeons.lua`; loot is learned by looting; quests in `Data/DungeonQuests.lua` (Horde) |
| Professions | Recipes across your characters, who can make what, trainers you've found with a map pin | Profession windows; Guild Camp crafters; guildmates' Codex over the addon channel |
| Talents | Calculator for every class you've played (rules enforced), three builds per class, build codes, the next point; what your trainer teaches and costs | The game's own talent API, recorded per class |
| Hunter Pets | Families, diets and skills; skill ranks you know; beasts met; a card when a beast teaches a better rank | Baseline in `Data/Pets.lua`; beasts are learned by targeting them |
| Reputation | Standings with progress, how to earn each, reward vendor and what each standing opens | The game; notes in `Data/Factions.lua` |
| PvP | Kills by day, rank progress, battleground record, enemy log, own kill-on-sight list with alerts, the guild's list | The game (no combat log); Guild Camp for the guild's list |
| Guild | Events, dungeon groups (join, leave, start), who's online, sync | Guild Camp through `GuildCampAPI`; the roster works alone |
| Quality of Life | Repair, sell greys, accept and hand in quests, quick loot, bag and gear warnings: all off by default, Shift skips | The game |
| Settings | Five themes, window size, tab order and visibility per character, every option in one searchable list | |

One search box in the header searches everything: tabs, bosses, dungeons, loot seen, recipes, trainers, talents,
factions, enemies, guildmates and settings.

## How it is built

- `Core.lua`: saved data, events, options (`ns.option`), the module registry (`ns.module`), slash commands, the
  guild-channel messages (`ns.send` / `ns.onMessage`, prefix `WBCodex`).
- `Theme.lua`: themes, tweens, and the widget kit (buttons, switches, bars, lists, chips, toasts). Themed textures
  register a painter, so changing the theme repaints everything.
- `Shell.lua`: the window, sidebar, pages, search and the minimap button.
- `Data/`: the Classic baseline. Forever-specific facts are learned in play and kept in `WarbandCodexDB.learn`.
- `Modules/`: one file per tab. A module is `ns.module{ id, title, icon, blurb, build, refresh, search, steps, badge }`.

The same rules as Guild Camp apply (docs/CONTRIBUTING.md): free, no ads, nothing sent for the player without a
click, our own frames only, no `COMBAT_LOG_EVENT_UNFILTERED`, nothing read in combat. Unit names and chat lines can
be secret values in combat, so that code runs inside `ns.try` and checks `ns.secret`.

OneForAll - Forever (GPLv3) inspired the feature list. No code or data was taken from it.

## Guild Camp link

`addon/WowGuild/Bridge.lua` defines `GuildCampAPI` (kill-on-sight list, groups, raids, crafters, `publish`). The
Codex calls `GuildCampAPI.publish("WarbandCodex", "character_<name>", snapshot)` at login, on logout and from the
Sync button; Guild Camp keeps it in `WowGuildDB.ext.WarbandCodex`. **The desktop app does not read `ext` yet**, so
the snapshot reaches the saved-variables file but not the site until the app's sync picks it up.

## Tests

`app/test/core/codex.test.js` runs the real addon on the simulated client (`wowsim`, `addonDir`), with the game
APIs it needs mocked at the top of the file. `app/test/core/addon-bridge.test.js` covers `GuildCampAPI`.

## Not done yet

- Nothing has been run in a real game client. Check by hand: fonts and glyphs, the resize grip, the tooltip line,
  the minimap button, and each event the modules listen for (Forever's API is not documented).
- Shipped loot tables, item-set piece lists, enchant suggestions, Library Books, Mage Scrolls, Merchant's Favor and
  camping. Loot is learned instead; the rest needs Forever data.
- Dungeon maps with boss portraits, the quest-share popup (Guild Camp has one), Alliance dungeon quests.
- Minimap button collector, quest XP on the experience bar, item sparkle.
- The level cap is assumed to be 60 (`ns.talents.MAX_LEVEL`).
- Baseline data (bosses, keys, pet families, faction vendors) was written from Classic knowledge and needs a check
  against Forever.
