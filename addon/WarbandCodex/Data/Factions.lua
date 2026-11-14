-- Warband Codex: reputations worth knowing about, the Classic baseline: who sells the rewards, where, and what
-- kind of thing each standing opens. The page shows your real standing from the game next to this; a vendor's exact
-- spot is remembered the first time you open their window, and can then be put on your map.
local ADDON, ns = ...
ns.data = ns.data or {}

-- { name, vendor, where, how (how to earn it), rewards = { { standing, what } } }
ns.data.factions = {
  { name = "Argent Dawn", vendor = "Quartermaster Miranda Breechlock", where = "Light's Hope Chapel, Eastern Plaguelands",
    how = "Wear an Argent Dawn Commission while killing undead in the Plaguelands, Stratholme and Scholomance; hand in scourgestones.",
    rewards = { { "Friendly", "Consumables and the first recipes" }, { "Honored", "More recipes; needed for the Naxxramas attunement" },
      { "Revered", "Shoulder enchants (resistance mantles) and a cheaper Naxxramas attunement" }, { "Exalted", "The best mantle and a free Naxxramas attunement" } } },
  { name = "Timbermaw Hold", vendor = "Meilosh", where = "Timbermaw Hold, the tunnel between Felwood and Winterspring",
    how = "Kill Deadwood furbolgs in Felwood and Winterfall furbolgs in Winterspring; hand in their feathers and beads.",
    rewards = { { "Neutral", "Safe passage through the tunnel (they stop attacking at Unfriendly)" }, { "Friendly", "First recipes" },
      { "Honored", "Leatherworking, tailoring and enchanting recipes" }, { "Exalted", "The Defender of the Timbermaw trinket quest" } } },
  { name = "Thorium Brotherhood", vendor = "Lokhtos Darkbargainer", where = "The Grim Guzzler, Blackrock Depths",
    how = "Hand in Dark Iron ore, Core Leather, Fiery Cores and Lava Cores; early on, incendosaur scales and kingsblood in Searing Gorge.",
    rewards = { { "Friendly", "Dark Iron and fire-resistance recipes begin" }, { "Honored", "More fire-resistance recipes" },
      { "Revered", "Raid-level crafting recipes" }, { "Exalted", "The top Dark Iron recipes" } } },
  { name = "Cenarion Circle", vendor = "The vendors of Cenarion Hold", where = "Cenarion Hold, Silithus",
    how = "Kill Twilight's Hammer cultists and silithid in Silithus, do the field duty quests, and raid Ahn'Qiraj.",
    rewards = { { "Friendly", "First nature-resistance recipes" }, { "Honored", "More recipes; Ahn'Qiraj quest rewards begin" },
      { "Revered", "Better recipes and quest rewards" }, { "Exalted", "The last recipes and rewards" } } },
  { name = "Zandalar Tribe", vendor = "Rin'wosho the Trader", where = "Yojamba Isle, Stranglethorn Vale",
    how = "Hand in the coins and bijous from Zul'Gurub and kill its bosses.",
    rewards = { { "Friendly", "First recipes and the class head and leg enchants' quests" }, { "Honored", "More recipes; better class item" },
      { "Revered", "Shoulder enchants and recipes" }, { "Exalted", "The best version of your class item" } } },
  { name = "Hydraxian Waterlords", vendor = "Duke Hydraxis (quests, no shop)", where = "An island off the coast of Azshara",
    how = "Kill elementals in Silithus and the Plaguelands, then the bosses of Molten Core.",
    rewards = { { "Honored", "Aqual Quintessence, needed to douse the runes in Molten Core" }, { "Revered", "The Eternal Quintessence, which never runs out" } } },
  { name = "Brood of Nozdormu", vendor = "Anachronos (quests, no shop)", where = "Caverns of Time, Tanaris",
    how = "Kill the creatures and bosses of the Temple of Ahn'Qiraj and hand in the insignias.",
    rewards = { { "Neutral", "The signet ring quest begins" }, { "Exalted", "The best version of the signet ring" } } },
  { name = "Frostwolf Clan", side = "Horde", vendor = "Jekyll Flandring", where = "Outside Alterac Valley, Alterac Mountains",
    how = "Fight in Alterac Valley.",
    rewards = { { "Friendly", "First rewards" }, { "Honored", "Better gear and the first rank trinket upgrades" }, { "Exalted", "Epic rewards and the Frostwolf mount" } } },
  { name = "Stormpike Guard", side = "Alliance", vendor = "Thanthaldis Snowgleam", where = "Outside Alterac Valley, Alterac Mountains",
    how = "Fight in Alterac Valley.",
    rewards = { { "Friendly", "First rewards" }, { "Honored", "Better gear and the first rank trinket upgrades" }, { "Exalted", "Epic rewards and the Stormpike mount" } } },
  { name = "Warsong Outriders", side = "Horde", vendor = "Kelm Hargunth", where = "Outside Warsong Gulch, The Barrens",
    how = "Fight in Warsong Gulch: flag captures and wins.",
    rewards = { { "Friendly", "Consumables" }, { "Honored", "First gear" }, { "Revered", "Better gear" }, { "Exalted", "Epic gear" } } },
  { name = "Silverwing Sentinels", side = "Alliance", vendor = "Illiyana Moonblaze", where = "Outside Warsong Gulch, Ashenvale",
    how = "Fight in Warsong Gulch: flag captures and wins.",
    rewards = { { "Friendly", "Consumables" }, { "Honored", "First gear" }, { "Revered", "Better gear" }, { "Exalted", "Epic gear" } } },
  { name = "The Defilers", side = "Horde", vendor = "Rutherford Twing", where = "Hammerfall, Arathi Highlands",
    how = "Fight in Arathi Basin.",
    rewards = { { "Friendly", "Consumables" }, { "Honored", "First gear" }, { "Revered", "Better gear" }, { "Exalted", "Epic gear" } } },
  { name = "The League of Arathor", side = "Alliance", vendor = "Samuel Hawke", where = "Refuge Pointe, Arathi Highlands",
    how = "Fight in Arathi Basin.",
    rewards = { { "Friendly", "Consumables" }, { "Honored", "First gear" }, { "Revered", "Better gear" }, { "Exalted", "Epic gear" } } },
}
ns.data.standings = { "Hated", "Hostile", "Unfriendly", "Neutral", "Friendly", "Honored", "Revered", "Exalted" }
