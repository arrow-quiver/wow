-- Warband Codex: dungeon quests worth taking in, by dungeon: { title, where to pick it up }.
-- Horde side (the same list Guild Camp uses). Alliance quests are not listed yet: quests in your log that name the
-- dungeon still show on the page.
local ADDON, ns = ...
ns.data = ns.data or {}
ns.data.dungeonQuests = {
  ["Ragefire Chasm"] = {
    { "Testing an Enemy's Strength", "Rahauro, Thunder Bluff (Elder Rise)" },
    { "Searching for the Lost Satchel", "Rahauro, Thunder Bluff (Elder Rise)" },
    { "The Power to Destroy...", "Varimathras, Undercity" },
    { "Hidden Enemies", "Thrall, Orgrimmar" },
    { "Slaying the Beast", "Neeru Fireblade, Orgrimmar (Cleft of Shadow)" },
  },
  ["Wailing Caverns"] = {
    { "Serpentbloom", "Apothecary Zamah, Thunder Bluff (Spirit Rise)" },
    { "Leaders of the Fang", "Nara Wildmane, Thunder Bluff (Elder Rise)" },
    { "Deviate Hides", "Nalpak, in the cave above the entrance" },
    { "Smart Drinks", "Mebok Mizzyrix, Ratchet" },
    { "Trouble at the Docks", "Crane Operator Bigglefuzz, Ratchet" },
  },
  ["Shadowfang Keep"] = {
    { "Deathstalkers in Shadowfang", "High Executor Hadrec, The Sepulcher" },
    { "The Book of Ur", "Keeper Bel'dugur, Undercity (Apothecarium)" },
    { "Arugal Must Die", "Dalar Dawnweaver, The Sepulcher" },
  },
  ["Blackfathom Deeps"] = {
    { "The Essence of Aku'Mai", "Je'neu Sancrea, Zoram'gar Outpost (Ashenvale)" },
    { "Amongst the Ruins", "Je'neu Sancrea, Zoram'gar Outpost (Ashenvale)" },
    { "Allegiance to the Old Gods", "a Damp Note dropped inside" },
    { "Blackfathom Villainy", "Bashana Runetotem, Thunder Bluff (Elder Rise)" },
  },
  ["Razorfen Kraul"] = {
    { "Going, Going, Guano!", "Master Apothecary Faranell, Undercity" },
    { "A Vengeful Fate", "Auld Stonespire, Thunder Bluff" },
    { "Willix the Importer", "Willix, inside (escort)" },
  },
  ["Gnomeregan"] = {
    { "Gnogaine", "Nogg, Orgrimmar (Valley of Honor)" },
    { "The Sparklematic 5200!", "inside, at the Sparklematic" },
  },
  ["Scarlet Monastery"] = {
    { "Into The Scarlet Monastery", "Varimathras, Undercity" },
    { "Hearts of Zeal", "Master Apothecary Faranell, Undercity" },
    { "Compendium of the Fallen", "Sage Truthseeker, Thunder Bluff" },
    { "Test of Lore", "Parqual Fintallas, Undercity" },
  },
  ["Razorfen Downs"] = {
    { "Bring the End", "Andrew Brownell, Undercity" },
    { "Scourge of the Downs", "Belnistrasz, inside" },
    { "A Host of Evil", "Myriam Moonsinger, near the entrance" },
  },
  ["Zul'Farrak"] = {
    { "Divino-matic Rod", "Chief Engineer Bilgewhizzle, Gadgetzan" },
    { "Scarab Shells", "Tran'rek, Gadgetzan" },
    { "Troll Temper", "Trenton Lighthammer, Gadgetzan" },
    { "Gahz'rilla", "Wizzle Brassbolts, Shimmering Flats" },
    { "Tiara of the Deep", "Tabetha, Dustwallow Marsh" },
    { "The Prophecy of Mosh'aru", "Yeh'kinya, Steamwheedle Port (Tanaris)" },
  },
  ["Maraudon"] = {
    { "Corruption of Earth and Seed", "Selendra, Desolace (near the entrance)" },
    { "Legends of Maraudon", "Cavindra, inside the orange entrance" },
    { "Vyletongue Corruption", "Vark Battlescar, Shadowprey Village" },
    { "Shadowshard Fragments", "Uthel'nay, Orgrimmar (Valley of Spirits)" },
  },
}
