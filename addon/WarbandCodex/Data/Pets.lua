-- Warband Codex: hunter pet families, the Classic baseline: what each family eats and which skills it can learn.
-- Every family also learns Growl and Cower (from the pet trainer). Bite and Claw have eight ranks, at pet levels
-- 1, 8, 16, 24, 32, 40, 48 and 56: a wild beast teaches the rank for its own level. Forever may change this; the
-- page also keeps a log of the beasts you have met, with their level and zone.
local ADDON, ns = ...
ns.data = ns.data or {}

ns.data.petFamilies = {
  { name = "Bat", diet = "fruit, fungus", skills = { "Bite", "Dive", "Screech" } },
  { name = "Bear", diet = "bread, cheese, fish, fruit, fungus, meat", skills = { "Bite", "Claw" } },
  { name = "Boar", diet = "bread, cheese, fish, fruit, fungus, meat", skills = { "Bite", "Charge", "Dash" } },
  { name = "Carrion Bird", diet = "fish, meat", skills = { "Bite", "Claw", "Dive", "Screech" } },
  { name = "Cat", diet = "fish, meat", skills = { "Bite", "Claw", "Dash", "Prowl" } },
  { name = "Crab", diet = "bread, fish, fruit, fungus", skills = { "Claw" } },
  { name = "Crocolisk", diet = "fish, meat", skills = { "Bite" } },
  { name = "Gorilla", diet = "fruit, fungus", skills = { "Bite", "Thunderstomp" } },
  { name = "Hyena", diet = "fruit, meat", skills = { "Bite", "Dash" } },
  { name = "Owl", diet = "meat", skills = { "Claw", "Dive", "Screech" } },
  { name = "Raptor", diet = "meat", skills = { "Bite", "Claw" } },
  { name = "Scorpid", diet = "meat", skills = { "Claw", "Scorpid Poison" } },
  { name = "Spider", diet = "meat", skills = { "Bite" } },
  { name = "Tallstrider", diet = "cheese, fruit, fungus", skills = { "Bite", "Dash" } },
  { name = "Turtle", diet = "fish, fruit, fungus", skills = { "Bite", "Shell Shield" } },
  { name = "Wind Serpent", diet = "bread, cheese, fish", skills = { "Bite", "Dive", "Lightning Breath" } },
  { name = "Wolf", diet = "meat", skills = { "Bite", "Dash", "Furious Howl" } },
}

-- Pet levels at which a new rank of the skill exists (Classic). Only the ones that are well established.
ns.data.petRanks = {
  Bite = { 1, 8, 16, 24, 32, 40, 48, 56 },
  Claw = { 1, 8, 16, 24, 32, 40, 48, 56 },
  Dash = { 30, 40, 50 },
  Dive = { 30, 40, 50 },
}
