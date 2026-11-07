# CurseForge listing text

Paste these into the project form. Keep this file outside `addon/WowGuild` so it isn't packaged.

**Name:** Guild Camp

**Summary:**

Profession skill-up guide and shopping list, a Coach with play-style tracking and next steps, and an optional link to your guild's website.

**Categories:** Professions (main), Guild, Data Export

**Game versions:** WoW Forever, Retail

---

## Description

Guild Camp is a profession helper and personal coach. Guilds that run the Guild Camp website get a lot more on top.

### Works on its own

- **Skill-up guide:** ranks the recipes you know by cost per expected skill point, so you level a profession cheaply.
- **Shopping list:** add recipes and quantities. It works out the materials you still need and ticks them off as you loot. With Auctionator, it can make an Auctionator shopping list or search the auction house for you.
- **Coach:** five play-style scores (aggression, risk taking, social, PvP focus, pace), built from a short quiz and from what you do outside combat. You also get a list of next steps: unspent talent points, repairs, bag space, trainer visits and professions that have fallen behind your level.
- **One window for everything:** a minimap button (or your broker display, such as Titan Panel or ElvUI), the addon drawer in Retail, and key bindings.

Everything runs outside combat and only reads what the game shows freely.

### With your guild's website

If your guild runs the Guild Camp website, the companion app syncs your characters, professions and the guild roster to the site after each `/reload` or logout, and brings guild news back into the game:

- Guild notices, raid sign-ups and soft reserves, and reminders for the next raid
- Crafting requests you can make, and leveling partners
- Item tooltips that show what your alts and the guild bank hold, and who can craft it; guild prices in the shopping list
- Calls to arms (`/wow cta`) that post to the guild's Discord
- Coach build plans and answers to your questions

The companion app comes from your guild's website, not from CurseForge. Addons can't reach the internet themselves, so it copies the addon's saved data to the site, and copies the news back into a small `WowGuild_Inbox` folder next to the addon.

### Commands

- `/wow` opens the window. `/guildcamp` works too.
- `/wow coach` opens the Coach.
- `/wow guide` opens the skill-up guide, and `/wow list` opens the shopping list.
- `/wow options` opens the settings.
