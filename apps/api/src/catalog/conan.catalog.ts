import { Game, SettingTarget, type SettingsCatalog, type SettingDef } from "@ark/shared";

/**
 * Conan Exiles catalog. The Conan image (acekorneya/conan_enhanced_server) writes
 * ServerSettings.ini / Engine.ini / Game.ini itself from env vars, so every setting
 * here targets `Env` and the runtime spec passes it through (key = env var name).
 *
 * Two kinds of settings:
 *  - First-class (`cset`): env vars configure-server.sh maps explicitly to an ini
 *    key. Always sent (with our defaults, e.g. Region = North America).
 *  - Raw allowlist (`rset`): any allowed ServerSettings key, set via
 *    `CONAN_SETTING_<IniKey>`. Only sent when changed from default (see
 *    conanCatalogEnv) so untouched knobs keep the game's vanilla default.
 *
 * Every setting carries `help` (tooltip) and, where numeric, a `unit` suffix; rate
 * multipliers show a "×" suffix, times are shown in friendly units.
 */
function cset(
  key: string,
  label: string,
  category: string,
  type: SettingDef["type"],
  def: SettingDef["default"],
  extra: Partial<SettingDef> = {},
): SettingDef {
  return { key, label, category, target: SettingTarget.Env, type, default: def, emitAs: key, ...extra };
}

/** A raw ServerSettings.ini key, delivered via the image's CONAN_SETTING_ override. */
function rset(
  iniKey: string,
  label: string,
  category: string,
  type: SettingDef["type"],
  def: SettingDef["default"],
  extra: Partial<SettingDef> = {},
): SettingDef {
  return cset(iniKey, label, category, type, def, { emitAs: `CONAN_SETTING_${iniKey}`, ...extra });
}

// Multiplier helpers — a "×" suffix + slider range + the tooltip in one place.
const x = (help: string): Partial<SettingDef> => ({ min: 0, max: 10, step: 0.1, unit: "×", help });
const xWide = (help: string): Partial<SettingDef> => ({ min: 0, max: 100, step: 0.1, unit: "×", help });

const settings: SettingDef[] = [
  // ── General / browser ──────────────────────────────────────────────────────
  cset("SERVER_MESSAGE_OF_THE_DAY", "Message of the day", "General", "string", "", {
    help: "Shown to players when they join the server.",
  }),
  cset("SERVER_REGION", "Region", "General", "enum", "1", {
    choices: [
      { value: "0", label: "Europe" },
      { value: "1", label: "North America" },
      { value: "2", label: "Asia" },
      { value: "3", label: "Australia" },
      { value: "4", label: "South America" },
      { value: "5", label: "Japan" },
    ],
    help: "Region the server advertises in the in-game browser. Set it to where your players are.",
  }),
  cset("COMMUNITY", "Server type", "General", "enum", "0", {
    choices: [
      { value: "0", label: "Purist" },
      { value: "1", label: "Relaxed" },
      { value: "2", label: "Hardcore" },
      { value: "3", label: "Role Playing" },
      { value: "4", label: "Experimental" },
    ],
    help: "Community category shown in the server browser — players filter by it.",
  }),
  cset("SERVER_VOICE_CHAT", "In-game voice chat", "General", "enum", "0", {
    choices: [
      { value: "0", label: "Disabled" },
      { value: "1", label: "Enabled" },
    ],
    help: "Enable proximity voice chat between players in-game.",
  }),
  rset("ShowOnlinePlayers", "Show online players in browser", "General", "bool", true, {
    help: "Show the live player count in the server browser.",
  }),
  rset("DisableChatFormatting", "Disable chat formatting", "General", "bool", false, {
    help: "Turn off rich-text (colors/sizes) in chat messages.",
  }),
  rset("AllowFamilySharedAccount", "Allow Steam Family Sharing accounts", "General", "bool", true, {
    help: "Let players using a Family-Shared copy of Conan join.",
  }),
  rset("EnableLoginQueue", "Login queue when full", "General", "bool", false, {
    help: "Queue players when the server is full instead of rejecting them.",
  }),
  rset("EnableTargetLock", "Allow target lock (soft aim)", "General", "bool", true, {
    help: "Allow console-style soft-lock targeting in combat.",
  }),
  rset("CreativeModeServer", "Creative mode (admin no-cost build)", "General", "bool", false, {
    help: "Build and craft with no resource cost — intended for admin/creative servers.",
  }),
  rset("PoiProtectionEnabled", "Protect points of interest", "General", "bool", true, {
    help: "Stop players from building on or blocking key world locations.",
  }),
  rset("ServerTransferEnabled", "Allow character transfer in/out", "General", "bool", false, {
    help: "Let characters move between servers in a cluster.",
  }),
  rset("MaxAllowedPing", "Max allowed ping", "General", "int", 0, {
    min: 0,
    max: 1000,
    unit: "ms",
    help: "Kick players whose ping exceeds this. 0 = no limit.",
  }),
  rset("KickAFKTime", "Kick AFK players after", "General", "int", 0, {
    min: 0,
    max: 3600,
    step: 60,
    displayScale: 1 / 60,
    unit: "min",
    help: "Kick idle players after this long. 0 = never.",
  }),
  rset("DisconnectionGraceTime", "Disconnect body grace period", "General", "int", 120, {
    min: 0,
    max: 3600,
    unit: "sec",
    help: "How long a disconnected player's body lingers in the world before despawning.",
  }),

  // ── PvP & rules ────────────────────────────────────────────────────────────
  cset("PVP_ENABLED", "PvP enabled", "PvP & Rules", "bool", true, {
    help: "Allow players to damage each other. Off = PvE.",
  }),
  cset("CAN_DAMAGE_PLAYER_OWNED_STRUCTURES", "Players can damage structures", "PvP & Rules", "bool", false, {
    help: "Allow raiding — players can damage others' buildings. Forced on while a raid schedule is set.",
  }),
  rset("FriendlyFireDamageMultiplier", "Friendly fire damage", "PvP & Rules", "float", 1.0, x("Damage dealt to your own clanmates and allies.")),
  rset("DynamicBuildingDamage", "Dynamic building damage", "PvP & Rules", "bool", false, {
    help: "Buildings only take damage during set time windows.",
  }),
  rset("DisableBuildingDuringTimeRestrictedPVP", "Block building during PvP hours", "PvP & Rules", "bool", false, {
    help: "Stop players placing new structures while scheduled PvP is active.",
  }),
  rset("bUndermeshDetectionEnabled", "Detect under-mesh exploits", "PvP & Rules", "bool", true, {
    help: "Detect and act on players exploiting the terrain mesh to hide bases.",
  }),
  cset("ENABLE_BATTLEYE", "BattlEye anti-cheat", "PvP & Rules", "bool", true, {
    help: "BattlEye anti-cheat. Players must have it enabled to join.",
  }),
  cset("AVATAR_ENABLED", "Avatars (god summons) enabled", "PvP & Rules", "bool", true, {
    help: "Allow players to summon the gods' giant avatars.",
  }),
  cset("MAX_NUDITY", "Max nudity", "PvP & Rules", "enum", "0", {
    choices: [
      { value: "0", label: "None" },
      { value: "1", label: "Partial" },
      { value: "2", label: "Full" },
    ],
    help: "Maximum nudity level shown to connected clients.",
  }),

  // ── Combat (damage / health) ───────────────────────────────────────────────
  rset("PlayerDamageMultiplier", "Player damage dealt", "Combat", "float", 1.0, x("Damage players deal to anything.")),
  rset("PlayerDamageTakenMultiplier", "Player damage taken", "Combat", "float", 1.0, x("Damage players take.")),
  rset("NPCDamageMultiplier", "NPC damage dealt", "Combat", "float", 1.0, x("Damage creatures and enemy NPCs deal.")),
  rset("NPCDamageTakenMultiplier", "NPC damage taken", "Combat", "float", 1.0, x("Damage creatures and enemy NPCs take.")),
  rset("NPCHealthMultiplier", "NPC health", "Combat", "float", 1.0, x("Health pool of creatures and enemy NPCs.")),
  rset("ThrallDamageToPlayersMultiplier", "Thrall damage to players", "Combat", "float", 1.0, x("Damage your thralls deal to enemy players.")),
  rset("ThrallDamageToNPCsMultiplier", "Thrall damage to NPCs", "Combat", "float", 1.0, x("Damage your thralls deal to creatures/NPCs.")),
  rset("MinionDamageMultiplier", "Follower damage dealt", "Combat", "float", 1.0, x("Damage your followers (thralls and pets) deal.")),
  rset("MinionDamageTakenMultiplier", "Follower damage taken", "Combat", "float", 1.0, x("Damage your followers take.")),
  rset("StructureDamageMultiplier", "Structure damage dealt", "Combat", "float", 1.0, x("Damage tools/weapons deal to structures.")),
  rset("StructureHealthMultiplier", "Structure health", "Combat", "float", 1.0, x("Hit points of placed structures.")),
  rset("BuildingDamageMultiplier", "Building damage", "Combat", "float", 1.0, x("Damage dealt to buildings during raids.")),
  rset("PlayerKnockbackMultiplier", "Player knockback", "Combat", "float", 1.0, x("Knockback applied to players when hit.")),
  rset("NPCKnockbackMultiplier", "NPC knockback", "Combat", "float", 1.0, x("Knockback applied to NPCs when hit.")),
  rset("ConciousnessDamageMultiplier", "Knockout (concussion) damage", "Combat", "float", 1.0, x("Concussion damage that knocks targets out — used to capture thralls.")),
  rset("PvPMountEnduranceDamageMultiplier", "Mount endurance damage", "Combat", "float", 1.0, x("Endurance damage dealt to mounts in PvP.")),

  // ── Survival (player rates) ────────────────────────────────────────────────
  cset("PLAYER_HEALTH_REGEN_SPEED_SCALE", "Health regen speed", "Survival", "float", 1.0, x("How fast players heal over time.")),
  cset("PLAYER_STAMINA_COST_MULTIPLIER", "Stamina cost", "Survival", "float", 1.0, x("Stamina drained by actions.")),
  cset("PLAYER_STAMINA_COST_SPRINT_MULTIPLIER", "Sprint stamina cost", "Survival", "float", 1.0, x("Stamina drained while sprinting.")),
  rset("PlayerStaminaRegenSpeedScale", "Stamina regen speed", "Survival", "float", 1.0, x("How fast stamina recovers.")),
  rset("StaminaStaticRegenRateMultiplier", "Standing stamina regen", "Survival", "float", 1.0, x("Stamina recovery while standing still.")),
  rset("StaminaMovingRegenRateMultiplier", "Moving stamina regen", "Survival", "float", 1.0, x("Stamina recovery while moving.")),
  rset("PlayerMovementSpeedScale", "Movement speed", "Survival", "float", 1.0, x("Player walk and run speed.")),
  rset("PlayerSprintSpeedScale", "Sprint speed", "Survival", "float", 1.0, x("Player sprint speed.")),
  rset("PlayerEncumbranceMultiplier", "Carry capacity", "Survival", "float", 1.0, x("Weight a player can carry before being over-encumbered.")),
  rset("PlayerEncumbrancePenaltyMultiplier", "Encumbrance penalty", "Survival", "float", 1.0, x("How harshly being over-encumbered slows you.")),
  rset("PlayerCorruptionGainMultiplier", "Corruption gain", "Survival", "float", 1.0, x("How fast players gain corruption.")),
  rset("PlayerCorruptionGainFromSorceryMultiplier", "Sorcery corruption gain", "Survival", "float", 1.0, x("Corruption gained from casting sorcery.")),

  // ── Progression (XP) ───────────────────────────────────────────────────────
  cset("XP_RATE_MULTIPLIER", "Overall XP", "Progression", "float", 1.0, xWide("All XP players and thralls earn.")),
  cset("PLAYER_XP_KILL_MULTIPLIER", "Kill XP", "Progression", "float", 1.0, xWide("XP earned from killing creatures and players.")),
  cset("PLAYER_XP_HARVEST_MULTIPLIER", "Harvest XP", "Progression", "float", 1.0, xWide("XP earned from harvesting resources.")),
  cset("PLAYER_XP_CRAFT_MULTIPLIER", "Crafting XP", "Progression", "float", 1.0, xWide("XP earned from crafting items.")),
  cset("PLAYER_XP_TIME_MULTIPLIER", "Time (idle) XP", "Progression", "float", 1.0, xWide("Passive XP earned just by being online.")),

  // ── Harvest & crafting ─────────────────────────────────────────────────────
  cset("HARVEST_AMOUNT_MULTIPLIER", "Harvest amount", "Harvest & Crafting", "float", 1.0, xWide("Resources gained from each harvest.")),
  cset("ITEM_SPOIL_RATE_SCALE", "Item spoil rate", "Harvest & Crafting", "float", 1.0, x("How fast perishables spoil — lower = slower.")),
  cset("FUEL_BURN_TIME_MULTIPLIER", "Fuel burn time", "Harvest & Crafting", "float", 1.0, x("How long fuel lasts in furnaces and torches — higher = longer.")),
  cset("CRAFTING_COST_MULTIPLIER", "Crafting cost", "Harvest & Crafting", "float", 1.0, x("Materials needed to craft — lower = cheaper.")),
  rset("ItemConvertionMultiplier", "Crafting/cooking speed", "Harvest & Crafting", "float", 1.0, x("Speed of crafting, cooking and smelting.")),
  rset("AnimalPenCraftingTimeMultiplier", "Animal pen time", "Harvest & Crafting", "float", 1.0, x("Time to raise pets in an animal pen.")),
  rset("FeedBoxRangeMultiplier", "Feed box range", "Harvest & Crafting", "float", 1.0, x("Range a feed box reaches to feed thralls and pets.")),

  // ── World (time / spawns) ──────────────────────────────────────────────────
  cset("DAY_CYCLE_SPEED_SCALE", "Day cycle speed", "World", "float", 1.0, x("Overall speed of the day/night cycle.")),
  cset("DAY_TIME_SPEED_SCALE", "Daytime speed", "World", "float", 1.0, x("Length of daytime — higher = shorter days.")),
  cset("NIGHT_TIME_SPEED_SCALE", "Nighttime speed", "World", "float", 1.0, x("Length of night — higher = shorter nights.")),
  cset("NPC_RESPAWN_MULTIPLIER", "NPC respawn", "World", "float", 1.0, x("How fast killed creatures and NPCs respawn.")),
  rset("NPCMaxSpawnCapMultiplier", "NPC spawn cap", "World", "float", 1.0, x("Maximum number of NPCs the world spawns.")),
  rset("AmbientLifeEnabled", "Ambient wildlife", "World", "bool", true, {
    help: "Spawn non-combat ambient wildlife (birds, critters).",
  }),
  rset("EventSystemEnabled", "World events / purge", "World", "bool", true, {
    help: "Enable world events, including the Purge.",
  }),
  rset("EnableFatalities", "Fatalities (finisher kills)", "World", "bool", true, {
    help: "Allow cinematic finisher kills on staggered enemies.",
  }),
  rset("DogsOfTheDesertSpawnWithDogs", "Dogs of the Desert spawn with dogs", "World", "bool", true, {
    help: "The Dogs of the Desert NPC camp spawns alongside its hyenas.",
  }),

  // ── Death ──────────────────────────────────────────────────────────────────
  cset("DROP_EQUIPMENT_ON_DEATH", "Drop equipment on death", "Death", "enum", "1", {
    choices: [
      { value: "0", label: "Nothing" },
      { value: "1", label: "Everything" },
      { value: "2", label: "All but equipped" },
    ],
    help: "What players drop from their equipped gear when they die.",
  }),
  cset("DROP_BACKPACK_ON_DEATH", "Drop backpack on death", "Death", "enum", "1", {
    choices: [
      { value: "0", label: "Nothing" },
      { value: "1", label: "Everything" },
      { value: "2", label: "All but equipped" },
    ],
    help: "What players drop from their inventory when they die.",
  }),
  cset("EVERYBODY_CAN_LOOT_CORPSE", "Anyone can loot corpses", "Death", "bool", true, {
    help: "Let anyone loot a corpse, not just its owner.",
  }),
  rset("CorpsesPerPlayer", "Corpses kept per player", "Death", "int", 5, {
    min: 1,
    max: 20,
    help: "How many of a player's corpses persist at once before the oldest despawns.",
  }),
  rset("MaxDeathMapMarkers", "Death map markers kept", "Death", "int", 5, {
    min: 0,
    max: 50,
    help: "How many death-location markers are kept on a player's map.",
  }),

  // ── Building ───────────────────────────────────────────────────────────────
  cset("ALLOW_BUILDING_ANYWHERE", "Allow building anywhere", "Building", "bool", false, {
    help: "Let players build in normally-blocked areas.",
  }),
  cset("BUILDING_ABANDONMENT_ENABLED", "Building abandonment (decay)", "Building", "bool", true, {
    help: "Unused buildings decay over time and can be demolished.",
  }),
  rset("BuildingPickupEnabled", "Allow building pickup", "Building", "bool", true, {
    help: "Allow picking up recently-placed building pieces.",
  }),
  rset("StabilityLossMultiplier", "Stability loss", "Building", "float", 1.0, x("How quickly unsupported structures lose stability.")),
  rset("LandClaimRadiusMultiplier", "Land-claim radius", "Building", "float", 1.0, x("Size of the no-build bubble around foundations.")),
  rset("BuildingDecayTimeMultiplier", "Building decay time", "Building", "float", 1.0, x("How long unused buildings take to decay — higher = longer.")),
  rset("DecayCleanupTimeMultiplier", "Ruined-building cleanup time", "Building", "float", 1.0, x("How long ruined buildings linger before they're cleaned up.")),
  rset("DecayShowBuildingScore", "Show decay timer on buildings", "Building", "bool", false, {
    help: "Show a building's remaining decay time when you look at it.",
  }),
  rset("DisableLandclaimNotifications", "Hide land-claim notifications", "Building", "bool", false, {
    help: "Suppress the 'you can't build here' land-claim popups.",
  }),
  rset("CampsIgnoreLandclaim", "Camps ignore land claim", "Building", "bool", false, {
    help: "Let NPC camps spawn inside land-claimed areas.",
  }),
  rset("ContainersIgnoreOwnership", "Containers ignore ownership", "Building", "bool", false, {
    help: "Anyone can open any container — no ownership lock.",
  }),

  // ── Clans ──────────────────────────────────────────────────────────────────
  cset("CLAN_MAX_SIZE", "Max clan size", "Clans", "int", 10, {
    min: 1,
    max: 100,
    unit: "players",
    help: "Maximum number of players in a single clan.",
  }),
  rset("EnableClanMarkers", "Clan map markers", "Clans", "bool", true, {
    help: "Show clanmates' positions as markers on the map.",
  }),

  // ── Thralls & followers ────────────────────────────────────────────────────
  cset("THRALL_CONVERSION_MULTIPLIER", "Thrall conversion speed", "Thralls", "float", 0.5, x("How fast captured thralls convert on the Wheel of Pain.")),
  rset("ThrallCorruptionRemovalMultiplier", "Thrall corruption removal", "Thralls", "float", 1.0, x("How fast thralls recover from corruption.")),
  rset("DisableThrallDecay", "Disable thrall/pet decay", "Thralls", "bool", false, {
    help: "Thralls and pets never decay or die from neglect.",
  }),
  rset("UseMinionPopulationLimit", "Limit follower population", "Thralls", "bool", false, {
    help: "Cap how many followers each player/clan can place.",
  }),
  rset("MinionPopulationBaseValue", "Base follower limit", "Thralls", "int", 50, {
    min: 0,
    max: 1000,
    unit: "followers",
    help: "Base follower cap when the limit is on.",
  }),
  rset("MinionPopulationPerPlayer", "Extra followers per player", "Thralls", "int", 0, {
    min: 0,
    max: 1000,
    unit: "followers",
    help: "Additional follower slots granted per clan member.",
  }),
  rset("MinionOverpopulationCleanup", "Auto-clean excess followers", "Thralls", "bool", false, {
    help: "Automatically remove followers over the limit.",
  }),
  rset("EnableFollowerDbno", "Followers down-but-not-out", "Thralls", "bool", false, {
    help: "Followers fall unconscious instead of dying, so you can revive them.",
  }),
  rset("EnableFollowerRescueOnLandClaimOnly", "Rescue followers only on your claim", "Thralls", "bool", false, {
    help: "Knocked-out followers can only be revived inside your own land claim.",
  }),

  // ── Avatars ────────────────────────────────────────────────────────────────
  rset("AvatarDomeDamageMultiplier", "Avatar dome damage", "Avatars", "float", 1.0, x("Damage an avatar's protective dome takes.")),
  rset("AvatarDomeDurationMultiplier", "Avatar dome duration", "Avatars", "float", 1.0, x("How long an avatar's protective dome lasts.")),

  // ── Schedules (leave blank for unrestricted) ───────────────────────────────
  // Day list (e.g. "Saturday,Sunday" or "weekend"/"weekday") + HH:MM start/end, in
  // the server's timezone. The image converts these to the per-day ini windows.
  cset("PVP_TIME_DAYS", "PvP days", "Schedules", "string", "", {
    help: 'When PvP is allowed. Days like "Saturday,Sunday" or "weekend". Blank = always on.',
  }),
  cset("PVP_TIME_START", "PvP start (HH:MM)", "Schedules", "string", "", {
    help: "Time PvP turns on each day (24-hour, server timezone).",
  }),
  cset("PVP_TIME_END", "PvP end (HH:MM)", "Schedules", "string", "", {
    help: "Time PvP turns off each day (24-hour, server timezone).",
  }),
  cset("PVP_BUILDING_DAMAGE_DAYS", "Raid (building damage) days", "Schedules", "string", "", {
    help: 'When buildings can be damaged. Days like "Friday,Saturday". Blank = follows PvP.',
  }),
  cset("PVP_BUILDING_DAMAGE_START", "Raid start (HH:MM)", "Schedules", "string", "", {
    help: "Time raiding (building damage) turns on (24-hour, server timezone).",
  }),
  cset("PVP_BUILDING_DAMAGE_END", "Raid end (HH:MM)", "Schedules", "string", "", {
    help: "Time raiding (building damage) turns off (24-hour, server timezone).",
  }),
];

export const CONAN_CATALOG: SettingsCatalog = { game: Game.CONAN, version: "4", settings };
