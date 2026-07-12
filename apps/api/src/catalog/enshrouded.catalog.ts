import { Game, SettingTarget, type SettingsCatalog, type SettingDef } from "@ark/shared";

/**
 * Enshrouded catalog. The mornedhels/enshrouded-server image is env-driven — it
 * translates env vars into enshrouded_server.json on startup, so every setting
 * targets `Env` and the runtime spec passes it through (key = env var name).
 *
 * The difficulty/game settings live under the image's `SERVER_GS_*` prefix (which map
 * to enshrouded_server.json's gameSettings). NOTE: Enshrouded only honours the
 * individual knobs when the preset is `Custom` — the PRESET help says so. The three
 * time-duration knobs are stored in nanoseconds by the game; we expose them in
 * minutes and convert in buildEnshroudedSpec (see ENSHROUDED_MINUTE_NS_KEYS).
 *
 * First-class fields the orchestrator owns (server name, slot count, ports, and the
 * role-based join/admin passwords) are NOT here. Enshrouded has no RCON. Booleans
 * emit as true/false.
 */
function eset(
  key: string,
  label: string,
  category: string,
  type: SettingDef["type"],
  def: SettingDef["default"],
  extra: Partial<SettingDef> = {},
): SettingDef {
  return { key, label, category, target: SettingTarget.Env, type, default: def, emitAs: key, ...extra };
}

/** A 0.25–4 style scaling factor (rendered as a percentage in-game). */
function factor(
  key: string,
  label: string,
  category: string,
  def: number,
  min: number,
  max: number,
  help: string,
): SettingDef {
  return eset(`SERVER_GS_${key}`, label, category, "float", def, { min, max, step: 0.05, help });
}

/**
 * The `SERVER_GS_*` duration knobs the game stores in NANOSECONDS. We expose them in
 * minutes; buildEnshroudedSpec multiplies by 60e9 before emitting the env var.
 */
export const ENSHROUDED_MINUTE_NS_KEYS = new Set([
  "SERVER_GS_FROM_HUNGER_TO_STARVING",
  "SERVER_GS_DAY_TIME_DURATION",
  "SERVER_GS_NIGHT_TIME_DURATION",
]);

const settings: SettingDef[] = [
  // ── Version ──────────────────────────────────────────────────────────────────
  // Steam branch the image installs; emitted as GAME_BRANCH by enshroudedCatalogEnv.
  eset("GAME_BRANCH", "Game branch", "Version", "enum", "public", {
    choices: [
      { value: "public", label: "Stable (public)" },
      { value: "testing", label: "Experimental (testing)" },
    ],
    help: "Which Steam branch of the Enshrouded server to run. Stable is recommended; Experimental (testing) gets early updates and may be unstable. Changing it re-downloads the game on the next start.",
  }),
  // ── Difficulty / enemies ─────────────────────────────────────────────────────
  eset("SERVER_GS_PRESET", "Difficulty preset", "Difficulty", "enum", "Default", {
    choices: [
      { value: "Default", label: "Default" },
      { value: "Relaxed", label: "Relaxed" },
      { value: "Hard", label: "Hard" },
      { value: "Survival", label: "Survival" },
      { value: "Custom", label: "Custom (unlocks the knobs below)" },
    ],
    help: "Enshrouded only applies the individual settings below when this is set to Custom. Leave on a preset to ignore them.",
  }),
  factor("ENEMY_DAMAGE_FACTOR", "Enemy damage", "Difficulty", 1, 0.25, 5, "Scales all non-boss enemy damage."),
  factor("ENEMY_HEALTH_FACTOR", "Enemy health", "Difficulty", 1, 0.25, 4, "Scales all non-boss enemy health."),
  factor("ENEMY_STAMINA_FACTOR", "Enemy stamina", "Difficulty", 1, 0.5, 2, "Higher = enemies are harder to stun."),
  factor(
    "ENEMY_PERCEPTION_RANGE_FACTOR",
    "Enemy perception",
    "Difficulty",
    1,
    0.5,
    2,
    "How far enemies can see/hear the player.",
  ),
  factor("BOSS_DAMAGE_FACTOR", "Boss damage", "Difficulty", 1, 0.2, 5, "Scales boss attack damage."),
  factor("BOSS_HEALTH_FACTOR", "Boss health", "Difficulty", 1, 0.2, 5, "Scales boss health."),
  factor("THREAT_BONUS", "Threat / aggro", "Difficulty", 1, 0.25, 4, "Frequency of enemy attacks (non-boss)."),
  eset("SERVER_GS_RANDOM_SPAWNER_AMOUNT", "Enemy amount", "Difficulty", "enum", "Normal", {
    choices: enumChoices(["Few", "Normal", "Many", "Extreme"]),
    help: "How many enemies populate the world.",
  }),
  eset("SERVER_GS_AGGRO_POOL_AMOUNT", "Simultaneous attackers", "Difficulty", "enum", "Normal", {
    choices: enumChoices(["Few", "Normal", "Many", "Extreme"]),
    help: "How many enemies may attack at the same time.",
  }),
  eset("SERVER_GS_CURSE_MODIFIER", "Curse chance", "Difficulty", "enum", "Normal", {
    choices: enumChoices(["Off", "Normal", "Hard"]),
    help: "Chance of being cursed by enemies (Hard doubles it; Off disables the mechanic).",
  }),
  eset("SERVER_GS_PACIFY_ALL_ENEMIES", "Passive enemies", "Difficulty", "bool", false, {
    help: "Enemies won't attack until attacked (excludes bosses).",
  }),

  // ── Players / survival ───────────────────────────────────────────────────────
  factor("PLAYER_HEALTH_FACTOR", "Player health", "Players", 1, 0.25, 4, "Scales player max health."),
  factor("PLAYER_MANA_FACTOR", "Player mana", "Players", 1, 0.25, 4, "Scales player max mana."),
  factor("PLAYER_STAMINA_FACTOR", "Player stamina", "Players", 1, 0.25, 4, "Scales player max stamina."),
  factor(
    "PLAYER_BODY_HEAT_FACTOR",
    "Body heat",
    "Players",
    1,
    0.5,
    2,
    "Higher = the player survives cold areas longer before hypothermia.",
  ),
  factor(
    "PLAYER_DIVING_TIME_FACTOR",
    "Diving time",
    "Players",
    1,
    0.5,
    2,
    "Scales how long the player can stay underwater.",
  ),
  factor("SHROUD_TIME_FACTOR", "Shroud time", "Players", 1, 0.5, 2, "How long the player can stay in the Shroud."),
  factor(
    "FOOD_BUFF_DURATION_FACTOR",
    "Food buff duration",
    "Players",
    1,
    0.5,
    2,
    "Scales how long food buffs last.",
  ),
  eset("SERVER_GS_ENABLE_DURABILITY", "Weapon durability", "Players", "bool", true, {
    help: "Whether weapons/tools wear out.",
  }),
  eset("SERVER_GS_ENABLE_STARVING_DEBUFF", "Hunger & starvation", "Players", "bool", false, {
    help: "Enable hunger — starvation drains health until the player eats.",
  }),
  eset("SERVER_GS_FROM_HUNGER_TO_STARVING", "Hunger → starving", "Players", "int", 10, {
    min: 5,
    max: 20,
    unit: "min",
    help: "Minutes in the hungry state before starvation sets in (only with the hunger debuff on).",
  }),
  eset("SERVER_GS_ENABLE_GLIDER_TURBULENCES", "Glider turbulence", "Players", "bool", true, {
    help: "If off, the glider isn't buffeted by air turbulence.",
  }),
  eset("SERVER_GS_TOMBSTONE_MODE", "On death", "Players", "enum", "AddBackpackMaterials", {
    choices: [
      { value: "AddBackpackMaterials", label: "Lose materials only (tombstone)" },
      { value: "Everything", label: "Lose everything (tombstone)" },
      { value: "NoTombstone", label: "Keep everything (no tombstone)" },
    ],
    help: "What the player drops into a recoverable tombstone on death.",
  }),
  eset("SERVER_GS_TAMING_STARTLE_REPERCUSSION", "Taming startle", "Players", "enum", "LoseSomeProgress", {
    choices: [
      { value: "KeepProgress", label: "Keep progress" },
      { value: "LoseSomeProgress", label: "Lose some progress" },
      { value: "LoseAllProgress", label: "Lose all progress" },
    ],
    help: "What happens when you startle wildlife while taming.",
  }),

  // ── World ────────────────────────────────────────────────────────────────────
  eset("SERVER_GS_WEATHER_FREQUENCY", "Weather frequency", "World", "enum", "Normal", {
    choices: enumChoices(["Disabled", "Rare", "Normal", "Often"]),
    help: "How often new weather phenomena appear.",
  }),
  eset("SERVER_GS_FISHING_DIFFICULTY", "Fishing difficulty", "World", "enum", "Normal", {
    choices: enumChoices(["VeryEasy", "Easy", "Normal", "Hard", "VeryHard"]),
    help: "How strong fish fight during the fishing minigame.",
  }),
  eset("SERVER_GS_DAY_TIME_DURATION", "Day length", "World", "int", 30, {
    min: 2,
    max: 60,
    unit: "min",
    help: "Real-time minutes of daytime.",
  }),
  eset("SERVER_GS_NIGHT_TIME_DURATION", "Night length", "World", "int", 12, {
    min: 2,
    max: 30,
    unit: "min",
    help: "Real-time minutes of nighttime.",
  }),

  // ── Economy / progression ────────────────────────────────────────────────────
  factor("MINING_DAMAGE_FACTOR", "Mining damage", "Economy", 1, 0.5, 2, "Higher = faster terraforming + more yield per hit."),
  factor("PLANT_GROWTH_SPEED_FACTOR", "Plant growth", "Economy", 1, 0.25, 2, "Scales farm plant growth speed."),
  factor(
    "RESOURCE_DROP_STACK_AMOUNT_FACTOR",
    "Resource drops",
    "Economy",
    1,
    0.25,
    2,
    "Materials per loot stack (chests, enemies, etc).",
  ),
  factor(
    "FACTORY_PRODUCTION_SPEED_FACTOR",
    "Production speed",
    "Economy",
    1,
    0.25,
    2,
    "Scales workshop production times.",
  ),
  factor(
    "PERK_UPGRADE_RECYCLING_FACTOR",
    "Salvage return",
    "Economy",
    0.1,
    0,
    1,
    "Runes returned when salvaging upgraded weapons.",
  ),
  factor("PERK_COST_FACTOR", "Upgrade cost", "Economy", 1, 0.25, 2, "Runes required to upgrade weapons."),
  factor("EXPERIENCE_COMBAT_FACTOR", "XP — combat", "Economy", 1, 0.25, 2, "XP gained from combat."),
  factor("EXPERIENCE_MINING_FACTOR", "XP — mining", "Economy", 1, 0.05, 2, "XP gained from mining."),
  factor(
    "EXPERIENCE_EXPLORATION_QUESTS_FACTOR",
    "XP — exploration",
    "Economy",
    1,
    0.25,
    2,
    "XP gained exploring and completing quests.",
  ),

  // ── Chat & voice ─────────────────────────────────────────────────────────────
  eset("SERVER_ENABLE_VOICE_CHAT", "Enable voice chat", "Chat", "bool", false, {
    help: "Turn on in-game voice chat. Off by default.",
  }),
  eset("SERVER_VOICE_CHAT_MODE", "Voice chat mode", "Chat", "enum", "Proximity", {
    choices: [
      { value: "Proximity", label: "Proximity (nearby players)" },
      { value: "Global", label: "Global (everyone)" },
    ],
    help: "Proximity = only players near you hear you; Global = the whole server. Only applies when voice chat is enabled.",
  }),
  eset("SERVER_ENABLE_TEXT_CHAT", "Enable text chat", "Chat", "bool", false, {
    help: "Turn on the in-game text chat window. Off by default.",
  }),
];

/** Build {value,label} choices where the label equals the value. */
function enumChoices(values: string[]): { value: string; label: string }[] {
  return values.map((v) => ({ value: v, label: v }));
}

export const ENSHROUDED_CATALOG: SettingsCatalog = { game: Game.ENSHROUDED, version: "1", settings };
