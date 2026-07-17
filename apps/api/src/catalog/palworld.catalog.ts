import { Game, SettingTarget, type SettingsCatalog, type SettingDef } from "@ark/shared";

/**
 * Palworld catalog. The image (thijsvanloef/palworld-server-docker) compiles
 * PalWorldSettings.ini from env vars, so every setting targets `Env` and the runtime
 * spec passes it through (key = env var name). First-class fields handled by the
 * orchestrator (name, passwords, max players, ports, RCON) are not here.
 */
function pset(
  key: string,
  label: string,
  category: string,
  type: SettingDef["type"],
  def: SettingDef["default"],
  extra: Partial<SettingDef> = {},
): SettingDef {
  return { key, label, category, target: SettingTarget.Env, type, default: def, emitAs: key, ...extra };
}

// "×" rate helpers (Palworld sliders are mostly 0.1–20 multipliers).
const x = (help: string): Partial<SettingDef> => ({ min: 0, max: 5, step: 0.1, unit: "×", help });
const xBig = (help: string): Partial<SettingDef> => ({ min: 0, max: 20, step: 0.1, unit: "×", help });

const settings: SettingDef[] = [
  // ── Version ──────────────────────────────────────────────────────────────────
  // thijsvanloef INSTALL_BETA_INSIDER env → the Palworld beta (insider) build.
  pset("INSTALL_BETA_INSIDER", "Game version", "Version", "enum", "false", {
    choices: [
      { value: "false", label: "Stable" },
      { value: "true", label: "Beta (insider)" },
    ],
    help: "Install the Palworld beta (insider) build instead of the stable release. Changing it re-downloads the game on the next start.",
  }),
  // ── General ────────────────────────────────────────────────────────────────
  pset("SERVER_DESCRIPTION", "Server description", "General", "string", "", {
    help: "Description shown next to the server in the browser.",
  }),
  pset("DIFFICULTY", "Difficulty preset", "General", "enum", "None", {
    choices: [
      { value: "None", label: "Custom (use settings below)" },
      { value: "Casual", label: "Casual" },
      { value: "Normal", label: "Normal" },
      { value: "Hard", label: "Hard" },
    ],
    help: "A preset difficulty. “Custom” leaves your individual rates below in control.",
  }),
  pset("SHOW_PLAYER_LIST", "Show player list", "General", "bool", true, {
    help: "Let players see who else is online.",
  }),
  pset("ENABLE_FAST_TRAVEL", "Allow fast travel", "General", "bool", true, {
    help: "Allow fast travel between unlocked statues.",
  }),
  pset("REGION", "Region", "General", "string", "", {
    help: "Region tag shown in the server browser (informational only).",
  }),
  pset("USEAUTH", "Require account authentication", "General", "bool", true, {
    help: "Verify player accounts (Steam/Epic) before allowing them to join.",
  }),
  pset("BAN_LIST_URL", "Ban list URL", "General", "string", "https://b.palworldgame.com/api/banlist.txt", {
    help: "Remote ban list the server pulls from.",
    advanced: true,
  }),
  pset("CROSSPLAY_PLATFORMS", "Allowed platforms", "General", "string", "(Steam,Xbox,PS5,Mac)", {
    help: "Platforms allowed to connect, e.g. (Steam,Xbox,PS5,Mac). Keep the parentheses.",
  }),
  pset("CHAT_POST_LIMIT_PER_MINUTE", "Chat rate limit", "General", "int", 30, {
    min: 0,
    max: 300,
    unit: "msgs/min",
    help: "Maximum chat messages a player can send per minute.",
  }),
  pset("LOG_FORMAT_TYPE", "Log format", "General", "enum", "Text", {
    choices: [
      { value: "Text", label: "Text" },
      { value: "Json", label: "JSON" },
    ],
    help: "Server log output format.",
    advanced: true,
  }),
  pset("IS_SHOW_JOIN_LEFT_MESSAGE", "Show join/leave messages", "General", "bool", true, {
    help: "Announce in chat when players join or leave.",
  }),
  pset("ALLOW_CLIENT_MOD", "Allow client mods", "General", "bool", true, {
    help: "Let players connect with client-side mods installed.",
  }),
  pset("IS_MULTIPLAY", "Multiplayer mode", "General", "bool", false, {
    help: "Enable multiplayer support.",
  }),
  pset("IS_START_LOCATION_SELECT_BY_MAP", "Map start-location picker", "General", "bool", false, {
    help: "Let new players pick their starting location on the map.",
  }),
  pset("EXIST_PLAYER_AFTER_LOGOUT", "Keep player after logout", "General", "bool", false, {
    help: "Keep a player's character in the world after they disconnect.",
  }),
  pset("ENABLE_AIM_ASSIST_PAD", "Controller aim assist", "General", "bool", true, {
    help: "Aim assist for gamepad players.",
  }),
  pset("ENABLE_AIM_ASSIST_KEYBOARD", "Keyboard aim assist", "General", "bool", false, {
    help: "Aim assist for keyboard/mouse players.",
  }),
  pset("ENABLE_VOICE_CHAT", "Voice chat", "General", "bool", false, {
    help: "Enable in-game proximity voice chat.",
  }),
  pset("VOICE_CHAT_MAX_VOLUME_DISTANCE", "Voice chat max volume distance", "General", "float", 3000, {
    min: 0,
    max: 30000,
    step: 100,
    unit: "cm",
    help: "Distance at which voice chat is loudest.",
    advanced: true,
  }),
  pset("VOICE_CHAT_ZERO_VOLUME_DISTANCE", "Voice chat cutoff distance", "General", "float", 15000, {
    min: 0,
    max: 60000,
    step: 100,
    unit: "cm",
    help: "Distance beyond which voice chat is inaudible.",
    advanced: true,
  }),
  pset("ALLOW_GLOBAL_PALBOX_EXPORT", "Allow global Palbox export", "General", "bool", true, {
    help: "Let players save Pals to the cross-save global Palbox.",
  }),
  pset("ALLOW_GLOBAL_PALBOX_IMPORT", "Allow global Palbox import", "General", "bool", false, {
    help: "Let players import Pals from the cross-save global Palbox.",
  }),

  // ── PvP & rules ────────────────────────────────────────────────────────────
  pset("IS_PVP", "PvP enabled", "PvP & Rules", "bool", false, {
    help: "Enable player-vs-player combat.",
  }),
  pset("ENABLE_PLAYER_TO_PLAYER_DAMAGE", "Player-to-player damage", "PvP & Rules", "bool", false, {
    help: "Players can deal damage to each other.",
  }),
  pset("ENABLE_FRIENDLY_FIRE", "Friendly fire", "PvP & Rules", "bool", false, {
    help: "Allow damage between members of the same guild.",
  }),
  pset("ENABLE_INVADER_ENEMY", "Base raids (invaders)", "PvP & Rules", "bool", true, {
    help: "Hostile NPCs periodically raid your base.",
  }),
  pset("DEATH_PENALTY", "Death penalty", "PvP & Rules", "enum", "All", {
    choices: [
      { value: "None", label: "Drop nothing" },
      { value: "Item", label: "Drop items (not equipment)" },
      { value: "ItemAndEquipment", label: "Drop items + equipment" },
      { value: "All", label: "Drop everything (incl. Pals)" },
    ],
    help: "What a player drops when they die.",
  }),
  pset("HARDCORE", "Hardcore (permadeath)", "PvP & Rules", "bool", false, {
    help: "Characters are permanently lost on death.",
  }),
  pset("ENABLE_NON_LOGIN_PENALTY", "Inactivity penalty", "PvP & Rules", "bool", true, {
    help: "Apply a penalty to players who stay logged out for a long time.",
  }),
  pset("PAL_LOST", "Lose Pals on death", "PvP & Rules", "bool", false, {
    help: "Pals are lost (not just downed) when they die.",
  }),
  pset("CAN_PICKUP_OTHER_GUILD_DEATH_PENALTY_DROP", "Loot other guilds' death drops", "PvP & Rules", "bool", false, {
    help: "Allow players to pick up death-penalty drops from other guilds.",
  }),
  pset("ENABLE_DEFENSE_OTHER_GUILD_PLAYER", "Defend against other guilds", "PvP & Rules", "bool", false, {
    help: "Allow base defenses to target players from other guilds.",
  }),
  pset("INVISIBLE_OTHER_GUILD_BASE_CAMP_AREA_FX", "Hide other guilds' base areas", "PvP & Rules", "bool", false, {
    help: "Hide the base-camp area effect for other guilds' bases.",
    advanced: true,
  }),
  pset("BLOCK_RESPAWN_TIME", "Respawn block time", "PvP & Rules", "float", 5, {
    min: 0,
    max: 300,
    step: 1,
    unit: "s",
    help: "Minimum time before a player can respawn.",
  }),
  pset("RESPAWN_PENALTY_DURATION_THRESHOLD", "Respawn penalty threshold", "PvP & Rules", "float", 0, {
    min: 0,
    max: 300,
    step: 1,
    unit: "s",
    help: "Time since death before the respawn penalty starts scaling.",
    advanced: true,
  }),
  pset("RESPAWN_PENALTY_TIME_SCALE", "Respawn penalty scale", "PvP & Rules", "float", 2, {
    min: 0,
    max: 10,
    step: 0.1,
    unit: "×",
    help: "Multiplier applied to respawn penalty time.",
    advanced: true,
  }),
  pset("DISPLAY_PVP_ITEM_NUM_ON_WORLD_MAP_BASE_CAMP", "Show PvP item counts on base camps", "PvP & Rules", "bool", false, {
    help: "Show item counts for base camps on the world map.",
  }),
  pset("DISPLAY_PVP_ITEM_NUM_ON_WORLD_MAP_PLAYER", "Show PvP item counts on players", "PvP & Rules", "bool", false, {
    help: "Show item counts for players on the world map.",
  }),
  pset("ADDITIONAL_DROP_ITEM_WHEN_PLAYER_KILLING_IN_PVP_MODE_ENABLED", "Enable PvP kill bonus item", "PvP & Rules", "bool", false, {
    help: "Drop a bonus item when a player kills another player in PvP.",
  }),
  pset("ADDITIONAL_DROP_ITEM_WHEN_PLAYER_KILLING_IN_PVP_MODE", "PvP kill bonus item", "PvP & Rules", "string", "PlayerDropItem", {
    help: "Item class dropped as a bonus when killing a player in PvP.",
    advanced: true,
  }),
  pset("ADDITIONAL_DROP_ITEM_WHEN_PLAYER_KILLING_IN_PVP_MODE_NUM", "PvP kill bonus item count", "PvP & Rules", "int", 1, {
    min: 0,
    max: 100,
    help: "How many of the bonus item drop.",
  }),

  // ── Progression (rates) ────────────────────────────────────────────────────
  pset("EXP_RATE", "Experience", "Progression", "float", 1.0, xBig("Experience earned by players and Pals.")),
  pset("PAL_CAPTURE_RATE", "Pal capture rate", "Progression", "float", 1.0, x("Success rate when capturing Pals.")),
  pset("PAL_SPAWN_NUM_RATE", "Pal spawn amount", "Progression", "float", 1.0, x("How many wild Pals spawn in the world.")),
  pset("COLLECTION_DROP_RATE", "Gathering yield", "Progression", "float", 1.0, xBig("Resources gained from gathering nodes.")),
  pset("COLLECTION_OBJECT_RESPAWN_SPEED_RATE", "Node respawn speed", "Progression", "float", 1.0, x("How fast gathering nodes respawn.")),
  pset("ENEMY_DROP_ITEM_RATE", "Enemy drops", "Progression", "float", 1.0, xBig("Item drops from defeated enemies.")),
  pset("WORK_SPEED_RATE", "Work speed", "Progression", "float", 1.0, x("Base + Pal work/craft speed.")),
  pset("MONSTER_FARM_ACTION_SPEED_RATE", "Monster farm speed", "Progression", "float", 1.0, x("Speed of actions performed by Pals working a base.")),
  pset("ALLOW_ENHANCE_STAT_HEALTH", "Allow health stat points", "Progression", "bool", true, {
    help: "Let players spend stat points on health.",
  }),
  pset("ALLOW_ENHANCE_STAT_ATTACK", "Allow attack stat points", "Progression", "bool", true, {
    help: "Let players spend stat points on attack.",
  }),
  pset("ALLOW_ENHANCE_STAT_STAMINA", "Allow stamina stat points", "Progression", "bool", true, {
    help: "Let players spend stat points on stamina.",
  }),
  pset("ALLOW_ENHANCE_STAT_WEIGHT", "Allow weight stat points", "Progression", "bool", true, {
    help: "Let players spend stat points on carry weight.",
  }),
  pset("ALLOW_ENHANCE_STAT_WORK_SPEED", "Allow work-speed stat points", "Progression", "bool", true, {
    help: "Let players spend stat points on work speed.",
  }),
  pset("DENY_TECHNOLOGY_LIST", "Denied technology IDs", "Progression", "string", "", {
    help: "Comma-separated technology IDs to block from being researched.",
    advanced: true,
  }),

  // ── World (time) ───────────────────────────────────────────────────────────
  pset("DAYTIME_SPEEDRATE", "Daytime speed", "World", "float", 1.0, x("Length of daytime — higher = shorter days.")),
  pset("NIGHTTIME_SPEEDRATE", "Nighttime speed", "World", "float", 1.0, x("Length of night — higher = shorter nights.")),
  pset("ENABLE_PREDATOR_BOSS_PAL", "Predator/boss Pals", "World", "bool", true, {
    help: "Spawn rare predator and field-boss Pals.",
  }),
  pset("RANDOMIZER_TYPE", "Pal randomizer", "World", "enum", "None", {
    choices: [
      { value: "None", label: "Off" },
      { value: "Region", label: "Randomize by region" },
      { value: "All", label: "Fully random" },
    ],
    help: "Randomize which Pals spawn where.",
  }),
  pset("RANDOMIZER_SEED", "Randomizer seed", "World", "string", "", {
    help: "Seed for the Pal randomizer (blank = random).",
    advanced: true,
  }),
  pset("IS_RANDOMIZER_PAL_LEVEL_RANDOM", "Randomize Pal levels", "World", "bool", false, {
    help: "Fully randomize wild Pal levels instead of scaling by area.",
  }),
  pset("SUPPLY_DROP_SPAN", "Supply drop interval", "World", "int", 180, {
    min: 0,
    max: 1440,
    unit: "min",
    help: "Time between supply drops.",
  }),
  pset("SERVER_REPLICATE_PAWN_CULL_DISTANCE", "Pawn replication distance", "World", "float", 15000, {
    min: 0,
    max: 30000,
    step: 500,
    unit: "cm",
    help: "Max distance at which players/Pals are replicated to clients.",
    advanced: true,
  }),

  // ── Combat ─────────────────────────────────────────────────────────────────
  pset("PLAYER_DAMAGE_RATE_ATTACK", "Player damage dealt", "Combat", "float", 1.0, x("Damage players deal.")),
  pset("PLAYER_DAMAGE_RATE_DEFENSE", "Player damage taken", "Combat", "float", 1.0, x("Damage players take.")),
  pset("PAL_DAMAGE_RATE_ATTACK", "Pal damage dealt", "Combat", "float", 1.0, x("Damage your Pals deal.")),
  pset("PAL_DAMAGE_RATE_DEFENSE", "Pal damage taken", "Combat", "float", 1.0, x("Damage your Pals take.")),

  // ── Survival ───────────────────────────────────────────────────────────────
  pset("PLAYER_STOMACH_DECREASE_RATE", "Player hunger rate", "Survival", "float", 1.0, x("How fast players get hungry.")),
  pset("PLAYER_STAMINA_DECREASE_RATE", "Player stamina drain", "Survival", "float", 1.0, x("How fast player stamina drains.")),
  pset("PLAYER_AUTO_HP_REGEN_RATE", "Player health regen", "Survival", "float", 1.0, x("How fast players heal over time.")),
  pset("PAL_STOMACH_DECREASE_RATE", "Pal hunger rate", "Survival", "float", 1.0, x("How fast Pals get hungry.")),
  pset("PAL_STAMINA_DECREASE_RATE", "Pal stamina drain", "Survival", "float", 1.0, x("How fast Pal stamina drains.")),
  pset("PAL_AUTO_HP_REGEN_RATE", "Pal health regen", "Survival", "float", 1.0, x("How fast Pals heal over time.")),
  pset("PLAYER_AUTO_HP_REGEN_RATE_IN_SLEEP", "Player sleep health regen", "Survival", "float", 1.0, x("How fast players heal while sleeping.")),
  pset("PAL_AUTO_HP_REGEN_RATE_IN_SLEEP", "Pal Palbox health regen", "Survival", "float", 1.0, x("How fast Pals heal while stored in the Palbox.")),
  pset("ACTIVE_UNKO", "Enable Unko (poop) items", "Survival", "bool", false, {
    help: "Pals periodically drop Unko items.",
  }),
  pset("PLAYER_DATA_PAL_STORAGE_UPDATE_CHECK_TICK_INTERVAL", "Pal storage update interval", "Survival", "float", 1.0, {
    min: 0,
    max: 60,
    step: 0.1,
    unit: "s",
    help: "How often the server checks for Pal storage updates.",
    advanced: true,
  }),
  pset("PAL_EGG_DEFAULT_HATCHING_TIME", "Egg hatch time", "Survival", "float", 72, {
    min: 0,
    max: 240,
    step: 1,
    unit: "hours",
    help: "Real-world hours to hatch an egg.",
  }),

  // ── Building ───────────────────────────────────────────────────────────────
  pset("BUILD_OBJECT_HP_RATE", "Structure health", "Building", "float", 1.0, x("Hit points of placed structures.")),
  pset("BUILD_OBJECT_DAMAGE_RATE", "Structure damage taken", "Building", "float", 1.0, x("Damage structures take.")),
  pset("BUILD_OBJECT_DETERIORATION_DAMAGE_RATE", "Structure decay", "Building", "float", 1.0, x("How fast structures deteriorate. 0 = no decay.")),
  pset("MAX_BUILDING_LIMIT_NUM", "Max structures per base", "Building", "int", 0, {
    min: 0,
    max: 100000,
    help: "Build limit per base camp (0 = unlimited).",
  }),
  pset("BASE_CAMP_MAX_NUM", "Max base camps", "Building", "int", 128, { min: 1, max: 1000 }),
  pset("BASE_CAMP_WORKER_MAX_NUM", "Max workers per base", "Building", "int", 15, {
    min: 1,
    max: 50,
    unit: "Pals",
    help: "How many Pals can work at a single base camp.",
  }),
  pset("BUILD_AREA_LIMIT", "Enforce build area limit", "Building", "bool", false, {
    help: "Restrict building to the base camp's designated area.",
  }),
  pset("ENABLE_BUILDING_PLAYER_UID_DISPLAY", "Show building owner", "Building", "bool", false, {
    help: "Display which player placed a structure.",
  }),
  pset("BUILDING_NAME_DISPLAY_CACHE_TTL_SECONDS", "Building name cache TTL", "Building", "int", 60, {
    min: 0,
    max: 3600,
    unit: "s",
    help: "How long building-owner names are cached before refreshing.",
    advanced: true,
  }),

  // ── Items ──────────────────────────────────────────────────────────────────
  pset("EQUIPMENT_DURABILITY_DAMAGE_RATE", "Equipment wear", "Items", "float", 1.0, x("How fast equipment loses durability.")),
  pset("DROP_ITEM_MAX_NUM", "Max dropped items", "Items", "int", 3000, {
    min: 0,
    max: 10000,
    help: "How many dropped items persist in the world before cleanup.",
  }),
  pset("ITEM_WEIGHT_RATE", "Item weight", "Items", "float", 1.0, x("Multiplier applied to item weight.")),
  pset("DROP_ITEM_MAX_NUM_UNKO", "Max dropped Unko items", "Items", "int", 100, {
    min: 0,
    max: 10000,
    help: "How many Unko drops persist in the world.",
  }),
  pset("DROP_ITEM_ALIVE_MAX_HOURS", "Dropped item lifetime", "Items", "float", 1.0, {
    min: 0,
    max: 24,
    step: 0.5,
    unit: "hours",
    help: "How long dropped items persist before despawning.",
  }),
  pset("ITEM_CONTAINER_FORCE_MARK_DIRTY_INTERVAL", "Item container save interval", "Items", "float", 1.0, {
    min: 0,
    max: 60,
    step: 0.1,
    unit: "s",
    help: "How often item containers are force-flagged for saving.",
    advanced: true,
  }),
  pset("ITEM_CORRUPTION_MULTIPLIER", "Item corruption rate", "Items", "float", 1.0, x("Rate at which items degrade/corrupt.")),
  pset("PHYSICS_ACTIVE_DROP_ITEM_MAX_NUM", "Max physics-active dropped items", "Items", "int", -1, {
    min: -1,
    max: 10000,
    help: "Cap on dropped items simulating physics (-1 = unlimited).",
    advanced: true,
  }),

  // ── Guild ──────────────────────────────────────────────────────────────────
  pset("GUILD_PLAYER_MAX_NUM", "Max guild size", "Guild", "int", 20, {
    min: 1,
    max: 100,
    unit: "players",
    help: "Maximum players in a single guild.",
  }),
  pset("AUTO_SAVE_SPAN", "Auto-save interval", "Guild", "float", 30, {
    min: 1,
    max: 120,
    step: 1,
    unit: "min",
    help: "How often the world auto-saves.",
  }),
  pset("AUTO_RESET_GUILD_NO_ONLINE_PLAYERS", "Auto-reset empty guilds", "Guild", "bool", false, {
    help: "Automatically reset a guild once no members are online.",
  }),
  pset("AUTO_RESET_GUILD_TIME_NO_ONLINE_PLAYERS", "Empty-guild reset delay", "Guild", "float", 72, {
    min: 0,
    max: 720,
    step: 1,
    unit: "hours",
    help: "Time with no members online before a guild auto-resets.",
  }),
  pset("BASE_CAMP_MAX_NUM_IN_GUILD", "Max base camps per guild", "Guild", "int", 4, {
    min: 1,
    max: 50,
    unit: "camps",
  }),
  pset("COOP_PLAYER_MAX_NUM", "Max co-op (split-screen) players", "Guild", "int", 4, {
    min: 1,
    max: 8,
    unit: "players",
    help: "Max local co-op players per connection.",
  }),
  pset("GUILD_REJOIN_COOLDOWN_MINUTES", "Guild rejoin cooldown", "Guild", "int", 0, {
    min: 0,
    max: 1440,
    unit: "min",
    help: "Cooldown before a player can rejoin a guild they left.",
  }),
  pset("AUTO_TRANSFER_MASTER_CHECK_INTERVAL_SECONDS", "Guild master transfer check interval", "Guild", "float", 3600, {
    min: 0,
    max: 86400,
    step: 60,
    unit: "s",
    advanced: true,
  }),
  pset("AUTO_TRANSFER_MASTER_THRESHOLD_DAYS", "Guild master inactivity threshold", "Guild", "int", 14, {
    min: 0,
    max: 365,
    unit: "days",
    help: "Days of inactivity before guild master transfers automatically.",
  }),
  pset("MAX_GUILDS_PER_FRAME", "Max guilds processed per frame", "Guild", "int", 10, {
    min: 1,
    max: 1000,
    advanced: true,
  }),
];

export const PALWORLD_CATALOG: SettingsCatalog = { game: Game.PALWORLD, version: "1", settings };
