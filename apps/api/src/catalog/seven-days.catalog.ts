import { Game, SettingTarget, type SettingsCatalog, type SettingDef } from "@ark/shared";

/**
 * 7 Days to Die catalog. Unlike the env-driven images, 7DTD's settings live in
 * sdtdserver.xml — the runtime spec renders that file from these settings (key = the
 * XML <property name="..."> attribute). First-class fields the orchestrator owns
 * (server name, passwords, ports, telnet, max players, GameWorld from the map) are
 * NOT here. Values are written verbatim into the XML; booleans emit as true/false.
 * This mirrors the full serverconfig.xml so every commonly-tuned knob is exposed.
 */
function sset(
  key: string,
  label: string,
  category: string,
  type: SettingDef["type"],
  def: SettingDef["default"],
  extra: Partial<SettingDef> = {},
): SettingDef {
  return { key, label, category, target: SettingTarget.Env, type, default: def, emitAs: key, ...extra };
}

const settings: SettingDef[] = [
  // ── Version ──────────────────────────────────────────────────────────────────
  // Not an XML property: the image reads VERSION from the env to pick the game's
  // Steam branch (set_version.sh). noEmit keeps it out of sdtdserver.xml;
  // buildSevenDaysSpec reads it.
  sset("VERSION", "Game version", "Version", "enum", "stable", {
    noEmit: true,
    choices: [
      { value: "stable", label: "Stable" },
      { value: "latest_experimental", label: "Experimental (latest)" },
    ],
    help: "Which 7 Days to Die branch to install. Stable is recommended; Experimental gets early builds and may break saves/mods. Changing it re-downloads the game (~17 GB) on the next start.",
  }),
  // ── World ────────────────────────────────────────────────────────────────────
  sset("GameName", "World save name", "World", "string", "ManagerWorld", {
    help: "Names the save game. For a Random World it also seeds generation; keep it stable to keep the same world.",
  }),
  sset("WorldGenSeed", "Random-world seed", "World", "string", "ManagerSeed", {
    help: "Seed string used to generate a Random World (RWG). Ignored on Navezgane.",
  }),
  sset("WorldGenSize", "Random-world size", "World", "int", 6144, {
    min: 6144,
    max: 16384,
    unit: "blocks",
    help: "Size of a generated Random World (RWG), in blocks per side. Ignored on Navezgane. Bigger = far slower first gen.",
  }),
  sset("DayNightLength", "Day length", "World", "int", 60, {
    min: 10,
    max: 120,
    unit: "min",
    help: "Real-time minutes in one full in-game day.",
  }),
  sset("DayLightLength", "Daylight hours", "World", "int", 18, {
    min: 0,
    max: 24,
    unit: "hrs",
    help: "How many of the 24 in-game hours are daylight.",
  }),

  // ── Difficulty ───────────────────────────────────────────────────────────────
  sset("GameDifficulty", "Difficulty", "Difficulty", "enum", "2", {
    choices: [
      { value: "0", label: "Scavenger (easiest)" },
      { value: "1", label: "Adventurer" },
      { value: "2", label: "Nomad (default)" },
      { value: "3", label: "Warrior" },
      { value: "4", label: "Survivalist" },
      { value: "5", label: "Insane (hardest)" },
    ],
    help: "Combat difficulty (damage taken/dealt).",
  }),
  sset("BlockDamagePlayer", "Block damage — players", "Difficulty", "int", 100, {
    min: 0,
    max: 500,
    unit: "%",
    help: "How much damage players do to blocks.",
  }),
  sset("BlockDamageAI", "Block damage — zombies", "Difficulty", "int", 100, {
    min: 0,
    max: 500,
    unit: "%",
    help: "How much damage zombies do to blocks.",
  }),
  sset("BlockDamageAIBM", "Block damage — Blood Moon", "Difficulty", "int", 100, {
    min: 0,
    max: 500,
    unit: "%",
    help: "How much damage zombies do to blocks during a Blood Moon.",
  }),
  sset("XPMultiplier", "XP multiplier", "Difficulty", "int", 100, {
    min: 1,
    max: 600,
    unit: "%",
    help: "Experience gain rate.",
  }),
  sset("PlayerSafeZoneLevel", "New-player safe-zone level", "Difficulty", "int", 5, {
    min: 0,
    max: 50,
    help: "Players below this level get a spawn safe zone (no enemies).",
  }),
  sset("PlayerSafeZoneHours", "New-player safe-zone hours", "Difficulty", "int", 5, {
    min: 0,
    max: 24,
    unit: "hrs",
    help: "How many in-game hours the new-player safe zone lasts.",
  }),

  // ── Zombies ──────────────────────────────────────────────────────────────────
  sset("EnemyDifficulty", "Enemy difficulty", "Zombies", "enum", "0", {
    choices: [
      { value: "0", label: "Normal" },
      { value: "1", label: "Feral (tougher)" },
    ],
    help: "Normal or Feral zombies.",
  }),
  sset("ZombieFeralSense", "Feral sense", "Zombies", "enum", "0", {
    choices: [
      { value: "0", label: "Off" },
      { value: "1", label: "Day only" },
      { value: "2", label: "Night only" },
      { value: "3", label: "All the time" },
    ],
    help: "When zombies can sense you through walls/at range.",
  }),
  sset("ZombieMove", "Zombie speed — day", "Zombies", "enum", "0", {
    choices: [
      { value: "0", label: "Walk" },
      { value: "1", label: "Jog" },
      { value: "2", label: "Run" },
      { value: "3", label: "Sprint" },
      { value: "4", label: "Nightmare" },
    ],
    help: "Zombie movement speed during the day.",
  }),
  sset("ZombieMoveNight", "Zombie speed — night", "Zombies", "enum", "3", {
    choices: [
      { value: "0", label: "Walk" },
      { value: "1", label: "Jog" },
      { value: "2", label: "Run" },
      { value: "3", label: "Sprint" },
      { value: "4", label: "Nightmare" },
    ],
    help: "Zombie movement speed at night.",
  }),
  sset("ZombieFeralMove", "Feral zombie speed", "Zombies", "enum", "3", {
    choices: [
      { value: "0", label: "Walk" },
      { value: "1", label: "Jog" },
      { value: "2", label: "Run" },
      { value: "3", label: "Sprint" },
      { value: "4", label: "Nightmare" },
    ],
    help: "Movement speed of feral zombies.",
  }),
  sset("ZombieBMMove", "Blood Moon zombie speed", "Zombies", "enum", "3", {
    choices: [
      { value: "0", label: "Walk" },
      { value: "1", label: "Jog" },
      { value: "2", label: "Run" },
      { value: "3", label: "Sprint" },
      { value: "4", label: "Nightmare" },
    ],
    help: "Movement speed of Blood Moon horde zombies.",
  }),
  sset("BloodMoonFrequency", "Blood Moon frequency", "Zombies", "int", 7, {
    min: 0,
    max: 30,
    unit: "days",
    help: "Days between horde nights (0 disables them).",
  }),
  sset("BloodMoonRange", "Blood Moon range", "Zombies", "int", 0, {
    min: 0,
    max: 15,
    unit: "days",
    help: "Random +/- days the Blood Moon can drift from the fixed frequency (0 = always on schedule).",
  }),
  sset("BloodMoonWarning", "Blood Moon warning hour", "Zombies", "int", 8, {
    min: -1,
    max: 24,
    help: "The in-game hour the red Blood Moon counter appears (-1 disables the warning).",
  }),
  sset("BloodMoonEnemyCount", "Blood Moon zombies per player", "Zombies", "int", 8, {
    min: 0,
    max: 64,
    help: "Max Blood Moon zombies alive per player at once.",
  }),
  sset("MaxSpawnedZombies", "Max zombies (server)", "Zombies", "int", 64, {
    min: 0,
    max: 512,
    help: "Server-wide cap on simultaneously spawned zombies.",
  }),
  sset("MaxSpawnedAnimals", "Max animals (server)", "Zombies", "int", 50, {
    min: 0,
    max: 512,
    help: "Server-wide cap on simultaneously spawned animals.",
  }),
  sset("EnemySpawnMode", "Spawn enemies", "Zombies", "bool", true, {
    help: "Turn off for a peaceful (no-enemy) world.",
  }),

  // ── Loot ─────────────────────────────────────────────────────────────────────
  sset("LootAbundance", "Loot abundance", "Loot", "int", 100, {
    min: 0,
    max: 600,
    unit: "%",
    help: "Amount of loot found in containers.",
  }),
  sset("LootRespawnDays", "Loot respawn", "Loot", "int", 30, {
    min: 1,
    max: 90,
    unit: "days",
    help: "How often looted containers refill.",
  }),
  sset("AirDropFrequency", "Air-drop frequency", "Loot", "int", 72, {
    min: 0,
    max: 240,
    unit: "hrs",
    help: "In-game hours between supply air drops (0 disables them).",
  }),
  sset("AirDropMarker", "Air-drop map marker", "Loot", "bool", true, {
    help: "Show a marker on the map where the supply crate lands.",
  }),

  // ── Land protection ──────────────────────────────────────────────────────────
  sset("LandClaimCount", "Land claims per player", "Land claim", "int", 3, {
    min: 1,
    max: 50,
    help: "How many land-claim blocks each player may place.",
  }),
  sset("LandClaimSize", "Land claim size", "Land claim", "int", 41, {
    min: 5,
    max: 255,
    unit: "blocks",
    help: "Side length of the protected area around a claim block (use an odd number).",
  }),
  sset("LandClaimDeadZone", "Claim dead-zone", "Land claim", "int", 30, {
    min: 0,
    max: 255,
    unit: "blocks",
    help: "Minimum spacing between claims owned by different players.",
  }),
  sset("LandClaimExpiryTime", "Claim expiry", "Land claim", "int", 7, {
    min: 1,
    max: 365,
    unit: "days",
    help: "Days a player must be offline before their claims decay.",
  }),
  sset("LandClaimDecayMode", "Claim decay mode", "Land claim", "enum", "0", {
    choices: [
      { value: "0", label: "Slow (linear)" },
      { value: "1", label: "Fast (exponential)" },
      { value: "2", label: "Full until expiry" },
    ],
    help: "How claimed-area block protection decays once the owner is offline past the expiry.",
  }),
  sset("LandClaimOnlineDurabilityModifier", "Durability — owner online", "Land claim", "int", 4, {
    min: 0,
    max: 64,
    unit: "x",
    help: "Block-hardness multiplier inside a claim while the owner is online (0 disables protection).",
  }),
  sset("LandClaimOfflineDurabilityModifier", "Durability — owner offline", "Land claim", "int", 4, {
    min: 0,
    max: 64,
    unit: "x",
    help: "Block-hardness multiplier inside a claim while the owner is offline (0 disables protection).",
  }),
  sset("LandClaimOfflineDelay", "Offline protection delay", "Land claim", "int", 0, {
    min: 0,
    max: 1440,
    unit: "min",
    help: "Minutes after the owner logs off before offline protection kicks in.",
  }),

  // ── Players ──────────────────────────────────────────────────────────────────
  sset("PlayerKillingMode", "PvP", "Players", "enum", "3", {
    choices: [
      { value: "0", label: "No killing" },
      { value: "1", label: "Allies only" },
      { value: "2", label: "Strangers only" },
      { value: "3", label: "Everyone (PvP)" },
    ],
    help: "Who players are allowed to kill.",
  }),
  sset("DropOnDeath", "Drop on death", "Players", "enum", "1", {
    choices: [
      { value: "0", label: "Nothing" },
      { value: "1", label: "Everything" },
      { value: "2", label: "Toolbelt only" },
      { value: "3", label: "Backpack only" },
      { value: "4", label: "Delete all" },
    ],
    help: "What a player drops when they die.",
  }),
  sset("DropOnQuit", "Drop on quit", "Players", "enum", "0", {
    choices: [
      { value: "0", label: "Nothing" },
      { value: "1", label: "Everything" },
      { value: "2", label: "Toolbelt only" },
      { value: "3", label: "Backpack only" },
    ],
    help: "What a player drops when they disconnect.",
  }),
  sset("BedrollDeadZoneSize", "Bedroll dead-zone", "Players", "int", 15, {
    min: 0,
    max: 100,
    unit: "blocks",
    help: "Radius around a bedroll where zombies won't spawn.",
  }),
  sset("BedrollExpiryTime", "Bedroll expiry", "Players", "int", 45, {
    min: 1,
    max: 365,
    unit: "days",
    help: "Days a player can be offline before their bedroll stops blocking spawns.",
  }),
  sset("PartySharedKillRange", "Party shared-kill range", "Players", "int", 100, {
    min: 0,
    max: 1000,
    unit: "m",
    help: "Distance within which party members share kill XP/quest credit.",
  }),
  sset("BuildCreate", "Creative menu (cheat)", "Players", "bool", false, {
    help: "Enable the creative menu / debug build access.",
  }),
  sset("PersistentPlayerProfiles", "Whitelist (persistent profiles)", "Players", "bool", false, {
    help: "Only players an admin has allowed on the server can join.",
  }),
  // NOTE: an unknown property name is FATAL to the 7DTD server ("Error parsing
  // configfile property X: Unknown config option" → shutdown), so names here must
  // match the game's GamePref names exactly. This one is QuestProgression…, not
  // QuestProgress… (caught live).
  sset("QuestProgressionDailyLimit", "Daily quest limit", "Players", "int", 8, {
    min: 0,
    max: 64,
    help: "Max quests a player can complete for rewards per day (0 = unlimited).",
  }),

  // ── Performance ──────────────────────────────────────────────────────────────
  sset("ServerMaxWorldTransferSpeedKiBs", "World transfer speed", "Performance", "int", 512, {
    min: 64,
    max: 1300,
    unit: "KiB/s",
    help: "Cap on the initial world download speed sent to each joining player.",
  }),
  sset("MaxUncoveredMapChunksPerPlayer", "Map memory per player", "Performance", "int", 131072, {
    min: 1,
    max: 131072,
    help: "How many explored map chunks are kept per player (higher = more RAM, larger revealed map).",
  }),
];

export const SEVEN_DAYS_CATALOG: SettingsCatalog = { game: Game.SEVEN_DAYS, version: "1", settings };
