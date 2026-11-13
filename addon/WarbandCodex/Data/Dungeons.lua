-- Warband Codex: dungeons and raids, the Classic baseline. Names, level ranges, where the entrance is, the bosses in
-- the usual order, and the steps for keys and attunements. WoW Forever changes and adds to this: loot is not shipped
-- here at all. The addon records what each boss drops as you (and your other characters) loot it, and shows the drop
-- rate you have seen. Levels are the usual ranges players run them at.
local ADDON, ns = ...
ns.data = ns.data or {}

-- { name, kind ("dungeon" | "raid"), min, max, zone, alias = {...}, bosses = {...}, wings = { { name, bosses } } }
ns.data.dungeons = {
  { name = "Ragefire Chasm", min = 13, max = 18, zone = "Orgrimmar", alias = { "rfc" },
    bosses = { "Oggleflint", "Taragaman the Hungerer", "Jergosh the Invoker", "Bazzalan" } },
  { name = "Wailing Caverns", min = 17, max = 24, zone = "The Barrens", alias = { "wc" },
    bosses = { "Lady Anacondra", "Lord Cobrahn", "Kresh", "Lord Pythas", "Skum", "Lord Serpentis", "Verdan the Everliving", "Mutanus the Devourer" } },
  { name = "The Deadmines", min = 17, max = 26, zone = "Westfall", alias = { "vc", "dm" },
    bosses = { "Rhahk'Zor", "Sneed's Shredder", "Gilnid", "Mr. Smite", "Captain Greenskin", "Edwin VanCleef", "Cookie" } },
  { name = "Shadowfang Keep", min = 22, max = 30, zone = "Silverpine Forest", alias = { "sfk" },
    bosses = { "Rethilgore", "Razorclaw the Butcher", "Baron Silverlaine", "Commander Springvale", "Odo the Blindwatcher", "Fenrus the Devourer", "Wolf Master Nandos", "Archmage Arugal" } },
  { name = "Blackfathom Deeps", min = 24, max = 32, zone = "Ashenvale", alias = { "bfd" },
    bosses = { "Ghamoo-ra", "Lady Sarevess", "Gelihast", "Lorgus Jett", "Baron Aquanis", "Twilight Lord Kelris", "Old Serra'kis", "Aku'mai" } },
  { name = "The Stockade", min = 24, max = 32, zone = "Stormwind City", alias = { "stocks", "stockades" },
    bosses = { "Targorr the Dread", "Kam Deepfury", "Hamhock", "Bazil Thredd", "Dextren Ward", "Bruegal Ironknuckle" } },
  { name = "Gnomeregan", min = 29, max = 38, zone = "Dun Morogh", alias = { "gnomer" },
    bosses = { "Grubbis", "Viscous Fallout", "Electrocutioner 6000", "Crowd Pummeler 9-60", "Dark Iron Ambassador", "Mekgineer Thermaplugg" } },
  { name = "Razorfen Kraul", min = 29, max = 38, zone = "The Barrens", alias = { "rfk" },
    bosses = { "Roogug", "Aggem Thorncurse", "Death Speaker Jargba", "Overlord Ramtusk", "Agathelos the Raging", "Charlga Razorflank" } },
  { name = "Scarlet Monastery", min = 34, max = 45, zone = "Tirisfal Glades", alias = { "sm" },
    wings = {
      { name = "Graveyard", bosses = { "Interrogator Vishas", "Bloodmage Thalnos" } },
      { name = "Library", bosses = { "Houndmaster Loksey", "Arcanist Doan" } },
      { name = "Armory", bosses = { "Herod" } },
      { name = "Cathedral", bosses = { "High Inquisitor Fairbanks", "Scarlet Commander Mograine", "High Inquisitor Whitemane" } },
    } },
  { name = "Razorfen Downs", min = 37, max = 46, zone = "The Barrens", alias = { "rfd" },
    bosses = { "Tuten'kash", "Mordresh Fire Eye", "Glutton", "Ragglesnout", "Amnennar the Coldbringer" } },
  { name = "Uldaman", min = 41, max = 51, zone = "Badlands", alias = { "ulda" },
    bosses = { "Revelosh", "The Lost Dwarves", "Ironaya", "Obsidian Sentinel", "Ancient Stone Keeper", "Galgann Firehammer", "Grimlok", "Archaedas" } },
  { name = "Zul'Farrak", min = 44, max = 54, zone = "Tanaris", alias = { "zf" },
    bosses = { "Antu'sul", "Theka the Martyr", "Witch Doctor Zum'rah", "Nekrum Gutchewer", "Shadowpriest Sezz'ziz", "Sergeant Bly", "Hydromancer Velratha", "Gahz'rilla", "Chief Ukorz Sandscalp" } },
  { name = "Maraudon", min = 46, max = 55, zone = "Desolace", alias = { "mara" },
    bosses = { "Noxxion", "Razorlash", "Lord Vyletongue", "Celebras the Cursed", "Landslide", "Tinkerer Gizlock", "Rotgrip", "Princess Theradras" } },
  { name = "Sunken Temple", min = 50, max = 56, zone = "Swamp of Sorrows", alias = { "st", "temple of atal'hakkar" },
    bosses = { "Atal'alarion", "Dreamscythe", "Weaver", "Jammal'an the Prophet", "Ogom the Wretched", "Morphaz", "Hazzas", "Avatar of Hakkar", "Shade of Eranikus" } },
  { name = "Blackrock Depths", min = 52, max = 60, zone = "Blackrock Mountain", alias = { "brd" },
    bosses = { "High Interrogator Gerstahn", "Lord Roccor", "Houndmaster Grebmar", "Ring of Law", "Pyromancer Loregrain", "Lord Incendius", "Warder Stilgiss", "Fineous Darkvire", "Bael'Gar", "General Angerforge", "Golem Lord Argelmach", "Hurley Blackbreath", "Phalanx", "Plugger Spazzring", "Ambassador Flamelash", "The Seven", "Magmus", "Emperor Dagran Thaurissan" } },
  { name = "Lower Blackrock Spire", min = 55, max = 60, zone = "Blackrock Mountain", alias = { "lbrs" },
    bosses = { "Highlord Omokk", "Shadow Hunter Vosh'gajin", "War Master Voone", "Mother Smolderweb", "Urok Doomhowl", "Quartermaster Zigris", "Halycon", "Gizrul the Slavener", "Overlord Wyrmthalak" } },
  { name = "Upper Blackrock Spire", min = 58, max = 60, zone = "Blackrock Mountain", alias = { "ubrs" },
    bosses = { "Pyroguard Emberseer", "Solakar Flamewreath", "Warchief Rend Blackhand", "The Beast", "General Drakkisath" } },
  { name = "Dire Maul", min = 55, max = 60, zone = "Feralas", alias = { "dm" },
    wings = {
      { name = "East", bosses = { "Pusillin", "Zevrim Thornhoof", "Hydrospawn", "Lethtendris", "Alzzin the Wildshaper" } },
      { name = "West", bosses = { "Tendris Warpwood", "Illyanna Ravenoak", "Magister Kalendris", "Immol'thar", "Prince Tortheldrin" } },
      { name = "North", bosses = { "Guard Mol'dar", "Stomper Kreeg", "Guard Fengus", "Guard Slip'kik", "Captain Kromcrush", "Cho'Rush the Observer", "King Gordok" } },
    } },
  { name = "Stratholme", min = 58, max = 60, zone = "Eastern Plaguelands", alias = { "strat" },
    wings = {
      { name = "Living side", bosses = { "The Unforgiven", "Timmy the Cruel", "Cannon Master Willey", "Archivist Galford", "Balnazzar" } },
      { name = "Undead side", bosses = { "Magistrate Barthilas", "Nerub'enkan", "Baroness Anastari", "Maleki the Pallid", "Ramstein the Gorger", "Baron Rivendare" } },
    } },
  { name = "Scholomance", min = 58, max = 60, zone = "Western Plaguelands", alias = { "scholo" },
    bosses = { "Kirtonos the Herald", "Jandice Barov", "Rattlegore", "Marduk Blackpool", "Vectus", "Ras Frostwhisper", "Instructor Malicia", "Doctor Theolen Krastinov", "Lorekeeper Polkelt", "The Ravenian", "Lord Alexei Barov", "Lady Illucia Barov", "Darkmaster Gandling" } },

  { name = "Molten Core", kind = "raid", min = 60, max = 60, zone = "Blackrock Mountain", alias = { "mc" },
    bosses = { "Lucifron", "Magmadar", "Gehennas", "Garr", "Baron Geddon", "Shazzrah", "Sulfuron Harbinger", "Golemagg the Incinerator", "Majordomo Executus", "Ragnaros" } },
  { name = "Onyxia's Lair", kind = "raid", min = 60, max = 60, zone = "Dustwallow Marsh", alias = { "ony" },
    bosses = { "Onyxia" } },
  { name = "Blackwing Lair", kind = "raid", min = 60, max = 60, zone = "Blackrock Mountain", alias = { "bwl" },
    bosses = { "Razorgore the Untamed", "Vaelastrasz the Corrupt", "Broodlord Lashlayer", "Firemaw", "Ebonroc", "Flamegor", "Chromaggus", "Nefarian" } },
  { name = "Zul'Gurub", kind = "raid", min = 60, max = 60, zone = "Stranglethorn Vale", alias = { "zg" },
    bosses = { "High Priestess Jeklik", "High Priest Venoxis", "High Priestess Mar'li", "Bloodlord Mandokir", "Edge of Madness", "High Priest Thekal", "Gahz'ranka", "High Priestess Arlokk", "Jin'do the Hexxer", "Hakkar" } },
  { name = "Ruins of Ahn'Qiraj", kind = "raid", min = 60, max = 60, zone = "Silithus", alias = { "aq20" },
    bosses = { "Kurinnaxx", "General Rajaxx", "Moam", "Buru the Gorger", "Ayamiss the Hunter", "Ossirian the Unscarred" } },
  { name = "Temple of Ahn'Qiraj", kind = "raid", min = 60, max = 60, zone = "Silithus", alias = { "aq40" },
    bosses = { "The Prophet Skeram", "Bug Trio", "Battleguard Sartura", "Fankriss the Unyielding", "Viscidus", "Princess Huhuran", "Twin Emperors", "Ouro", "C'Thun" } },
  { name = "Naxxramas", kind = "raid", min = 60, max = 60, zone = "Eastern Plaguelands", alias = { "naxx" },
    wings = {
      { name = "Arachnid Quarter", bosses = { "Anub'Rekhan", "Grand Widow Faerlina", "Maexxna" } },
      { name = "Plague Quarter", bosses = { "Noth the Plaguebringer", "Heigan the Unclean", "Loatheb" } },
      { name = "Military Quarter", bosses = { "Instructor Razuvious", "Gothik the Harvester", "The Four Horsemen" } },
      { name = "Construct Quarter", bosses = { "Patchwerk", "Grobbulus", "Gluth", "Thaddius" } },
      { name = "Frostwyrm Lair", bosses = { "Sapphiron", "Kel'Thuzad" } },
    } },
}

-- Keys and attunements: the Classic steps, shortest wording that still gets you there. Forever may differ.
ns.data.keys = {
  { name = "Scarlet Key", dungeon = "Scarlet Monastery", steps = {
    "Run the Library wing and kill Arcanist Doan.",
    "Open Doan's Strongbox behind him: the key is inside.",
    "It opens the Armory and the Cathedral.",
  } },
  { name = "Workshop Key", dungeon = "Gnomeregan", steps = {
    "Kill Mekgineer Thermaplugg at the end of Gnomeregan: he drops the key.",
    "It opens the back door, a shortcut to the last part of the dungeon.",
  } },
  { name = "Mallet of Zul'Farrak", dungeon = "Zul'Farrak", steps = {
    "In the Hinterlands, kill Qiaga the Keeper at the Altar of Zul for the Sacred Mallet.",
    "Carry it to the altar at the very top of Jintha'Alor and use it there.",
    "Strike the gong in Zul'Farrak with the Mallet to call Gahz'rilla.",
  } },
  { name = "Scepter of Celebras", dungeon = "Maraudon", steps = {
    "Inside Maraudon, defeat Celebras the Cursed and speak with his freed spirit.",
    "Help him through the ritual. The Scepter opens the portal straight to the inner part.",
  } },
  { name = "Shadowforge Key", dungeon = "Blackrock Depths", steps = {
    "Die in Blackrock Mountain and, as a ghost, talk to Franclorn Forgewright above the lava (near the Molten Bridge).",
    "In Blackrock Depths kill Fineous Darkvire and take his hammer, Ironfel.",
    "Put Ironfel in the Shrine of Thaurissan (the statue past the Ring of Law) to get the key.",
  } },
  { name = "Seal of Ascension (Upper Blackrock Spire)", dungeon = "Upper Blackrock Spire", steps = {
    "Get the Unadorned Seal of Ascension: it drops from the orcs in Lower Blackrock Spire.",
    "Collect the three gems in Lower Blackrock Spire: from Highlord Omokk, War Master Voone and Overlord Wyrmthalak.",
    "Take them to Vaelan (inside the Spire) and then forge the seal with the dragon Emberstrike in Dustwallow Marsh.",
    "One player with the Seal opens the door for the whole group.",
  } },
  { name = "Crescent Key", dungeon = "Dire Maul", steps = {
    "In Dire Maul East, talk to the imp Pusillin and chase him until he fights.",
    "He drops the Crescent Key. It opens Dire Maul West and North.",
  } },
  { name = "Key to the City", dungeon = "Stratholme", steps = {
    "Enter Stratholme by the main gate and kill Magistrate Barthilas (he runs to the undead side when he sees you).",
    "He drops the Key to the City: it opens the service entrance and the gates inside.",
  } },
  { name = "Skeleton Key", dungeon = "Scholomance", steps = {
    "Start with the quest Scholomance at Chillwind Point (Alliance) or the Bulwark (Horde).",
    "Follow the chain: a mold from Andorhal, forged in the lava at Fire Plume Ridge in Un'Goro Crater.",
    "Then Araj the Summoner's scarab in the middle of Andorhal. The finished key opens the front door.",
  } },
  { name = "Attunement to the Core", dungeon = "Molten Core", steps = {
    "Take Attunement to the Core from Lothos Riftwaker in Blackrock Mountain.",
    "Go through Blackrock Depths to the Molten Core entrance and take the Core Fragment beside the portal.",
    "Return to Lothos. From then on he sends you straight to Molten Core.",
  } },
  { name = "Drakefire Amulet", dungeon = "Onyxia's Lair", steps = {
    "Horde: start with Warlord's Command from Warlord Goretooth in Kargath (Badlands), then Eitrigg, Thrall and the dragons Rexxar sends you to.",
    "Alliance: start with Dragonkin Menace from Helendis Riverhorn in the Burning Steppes, through Marshal Windsor in Blackrock Depths and the march into Stormwind.",
    "Both end in Upper Blackrock Spire: the blood of General Drakkisath finishes the amulet.",
    "Everyone in the raid needs the amulet in their bags.",
  } },
  { name = "Blackwing Lair attunement", dungeon = "Blackwing Lair", steps = {
    "Kill the Scarshield Quartermaster outside the Blackrock Spire entrance and read Blackhand's Command.",
    "Clear Upper Blackrock Spire and touch the Orb of Command behind General Drakkisath.",
  } },
  { name = "Naxxramas attunement", dungeon = "Naxxramas", steps = {
    "Reach Honored with the Argent Dawn.",
    "Take The Dread Citadel - Naxxramas from Archmage Angela Dosantos at Light's Hope Chapel. The cost falls at Revered and is free at Exalted.",
  } },
}
