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

  // ── Progression (rates) ────────────────────────────────────────────────────
  pset("EXP_RATE", "Experience", "Progression", "float", 1.0, xBig("Experience earned by players and Pals.")),
  pset("PAL_CAPTURE_RATE", "Pal capture rate", "Progression", "float", 1.0, x("Success rate when capturing Pals.")),
  pset("PAL_SPAWN_NUM_RATE", "Pal spawn amount", "Progression", "float", 1.0, x("How many wild Pals spawn in the world.")),
  pset("COLLECTION_DROP_RATE", "Gathering yield", "Progression", "float", 1.0, xBig("Resources gained from gathering nodes.")),
  pset("COLLECTION_OBJECT_RESPAWN_SPEED_RATE", "Node respawn speed", "Progression", "float", 1.0, x("How fast gathering nodes respawn.")),
  pset("ENEMY_DROP_ITEM_RATE", "Enemy drops", "Progression", "float", 1.0, xBig("Item drops from defeated enemies.")),
  pset("WORK_SPEED_RATE", "Work speed", "Progression", "float", 1.0, x("Base + Pal work/craft speed.")),

  // ── World (time) ───────────────────────────────────────────────────────────
  pset("DAYTIME_SPEEDRATE", "Daytime speed", "World", "float", 1.0, x("Length of daytime — higher = shorter days.")),
  pset("NIGHTTIME_SPEEDRATE", "Nighttime speed", "World", "float", 1.0, x("Length of night — higher = shorter nights.")),
  pset("ENABLE_PREDATOR_BOSS_PAL", "Predator/boss Pals", "World", "bool", true, {
    help: "Spawn rare predator and field-boss Pals.",
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

  // ── Items ──────────────────────────────────────────────────────────────────
  pset("EQUIPMENT_DURABILITY_DAMAGE_RATE", "Equipment wear", "Items", "float", 1.0, x("How fast equipment loses durability.")),
  pset("DROP_ITEM_MAX_NUM", "Max dropped items", "Items", "int", 3000, {
    min: 0,
    max: 10000,
    help: "How many dropped items persist in the world before cleanup.",
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
];

export const PALWORLD_CATALOG: SettingsCatalog = { game: Game.PALWORLD, version: "1", settings };
