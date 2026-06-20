import { Game, SettingTarget, type SettingDef } from "@ark/shared";

/**
 * Shared ASA/ASE settings with small builder helpers. ARK has hundreds of
 * settings; this covers the broad, commonly-tuned set across both games. The
 * per-server raw passthrough still handles anything not modelled here.
 */
const GUS = SettingTarget.GameUserSettings;
const GAMEINI = SettingTarget.Game;
const SERVER = "ServerSettings";
const MODE = "/script/shootergame.shootergamemode";

interface NumOpts {
  def?: number;
  min?: number;
  max?: number;
  step?: number;
  advanced?: boolean;
  help?: string;
  emitAs?: string;
  /** Show the value ×displayScale (with `unit`), e.g. difficulty → wild level. */
  displayScale?: number;
  unit?: string;
  /** Slider endpoint labels; default "less"/"more". */
  lo?: string;
  hi?: string;
}
interface BoolOpts {
  def?: boolean;
  advanced?: boolean;
  help?: string;
  emitAs?: string;
  /** Override the UI grouping (used by flag(); defaults to "Launch flags"). */
  category?: string;
}

const num =
  (target: SettingTarget, section: string, type: "int" | "float") =>
  (key: string, label: string, category: string, o: NumOpts = {}): SettingDef => ({
    key,
    label,
    category,
    target,
    section,
    type,
    default: o.def ?? (type === "float" ? 1 : 0),
    min: o.min ?? 0,
    max: o.max ?? 100,
    step: o.step ?? (type === "float" ? 0.1 : 1),
    displayScale: o.displayScale,
    unit: o.unit,
    minLabel: o.lo ?? "less",
    maxLabel: o.hi ?? "more",
    advanced: o.advanced,
    help: o.help,
    emitAs: o.emitAs,
  });

const bool =
  (target: SettingTarget, section: string) =>
  (key: string, label: string, category: string, o: BoolOpts = {}): SettingDef => ({
    key,
    label,
    category,
    target,
    section,
    type: "bool",
    default: o.def ?? false,
    advanced: o.advanced,
    help: o.help,
    emitAs: o.emitAs,
  });

const str =
  (target: SettingTarget, section: string) =>
  (key: string, label: string, category: string, o: { def?: string; advanced?: boolean; help?: string; emitAs?: string } = {}): SettingDef => ({
    key,
    label,
    category,
    target,
    section,
    type: "string",
    default: o.def ?? "",
    advanced: o.advanced,
    help: o.help,
    emitAs: o.emitAs,
  });

export const gusFloat = num(GUS, SERVER, "float");
export const gusInt = num(GUS, SERVER, "int");
export const gusBool = bool(GUS, SERVER);
export const gusStr = str(GUS, SERVER);
export const gameFloat = num(GAMEINI, MODE, "float");
export const gameInt = num(GAMEINI, MODE, "int");
export const gameBool = bool(GAMEINI, MODE);
// Ragnarok ships its own [Ragnarok] section in GameUserSettings.ini.
const RAG = "Ragnarok";
const ragBool = bool(GUS, RAG);
const ragFloat = num(GUS, RAG, "float");
const ragInt = num(GUS, RAG, "int");

export function flag(key: string, label: string, emitAs: string, o: BoolOpts = {}): SettingDef {
  return {
    key,
    label,
    category: o.category ?? "Launch flags",
    target: SettingTarget.CommandLineFlag,
    type: "bool",
    default: o.def ?? false,
    emitAs,
    advanced: o.advanced,
    help: o.help,
  };
}

interface DashOpts {
  type?: "string" | "enum" | "multiselect";
  options?: string[];
  choices?: { value: string; label: string }[];
  joinWith?: string;
  def?: string;
  defaultArray?: string[];
  advanced?: boolean;
  help?: string;
  emitAs?: string;
  games?: Game[];
}

/** A `-Key=Value` command-line option (e.g. -ActiveEvent=Easter). */
export function dashOption(key: string, label: string, o: DashOpts = {}): SettingDef {
  return {
    key,
    label,
    category: "Launch options",
    target: SettingTarget.CommandLineDashOption,
    type: o.type ?? "string",
    default: o.type === "multiselect" ? (o.defaultArray ?? []) : (o.def ?? ""),
    options: o.options,
    choices: o.choices,
    joinWith: o.joinWith,
    advanced: o.advanced,
    help: o.help,
    emitAs: o.emitAs,
    games: o.games,
  };
}

/** Stat order matches the ARK PerLevelStatsMultiplier_* array indices. */
const PER_LEVEL_STATS = [
  { key: "Health", label: "Health" },
  { key: "Stamina", label: "Stamina" },
  { key: "Torpidity", label: "Torpidity" },
  { key: "Oxygen", label: "Oxygen" },
  { key: "Food", label: "Food" },
  { key: "Water", label: "Water" },
  { key: "Temperature", label: "Temperature" },
  { key: "Weight", label: "Weight" },
  { key: "MeleeDamage", label: "Melee Damage" },
  { key: "MovementSpeed", label: "Movement Speed" },
  { key: "Fortitude", label: "Fortitude" },
  { key: "CraftingSpeed", label: "Crafting Speed" },
];

function statGrid(key: string, label: string): SettingDef {
  return {
    key,
    label,
    category: "Per-level stats",
    target: GAMEINI,
    section: MODE,
    type: "grid",
    emitAs: key,
    default: {},
    gridRows: PER_LEVEL_STATS,
    advanced: true,
    help: "How much each point spent in a stat gives. 1 = vanilla. Leave a stat at 1 to skip it.",
  };
}

/** The big shared catalog used by both ASA and ASE. */
export const COMMON_SETTINGS: SettingDef[] = [
  // ── Server ───────────────────────────────────────────────────────────────────
  // Join password. Delivered to the game container via the SERVER_PASSWORD env var
  // (noEmit), not the INI — so POK/hermsi own it and there's no duplicate INI key.
  // Stored and shown in plain text on purpose (single-user manager; easy to read).
  {
    key: "ServerPassword",
    label: "Server join password",
    category: "Server",
    target: SettingTarget.GameUserSettings,
    section: SERVER,
    type: "string",
    default: "",
    noEmit: true,
    help: "Players must enter this to join. Leave blank for an open server. Stored and shown in plain text — change it any time and restart the server to apply.",
  },

  // ── Rules ──────────────────────────────────────────────────────────────────
  gusBool("ServerPVE", "PvE mode", "Rules", { help: "Disable player-vs-player combat." }),
  gusBool("ServerHardcore", "Hardcore", "Rules", { help: "Players revert to level 1 on death." }),
  gusBool("AllowThirdPersonPlayer", "Allow third person", "Players", { def: true }),
  gusBool("GlobalVoiceChat", "Global voice chat", "Chat"),
  gusBool("ProximityChat", "Proximity chat only", "Chat"),
  gusBool("ShowMapPlayerLocation", "Show player location on map", "Players", { def: true }),
  gusBool("ShowFloatingDamageText", "Floating damage numbers (RPG mode)", "Rules"),
  gusBool("AllowHitMarkers", "Allow hit markers", "Rules", { def: true }),
  gusBool("ServerCrosshair", "Crosshair", "Rules", { def: true }),
  gusBool("ServerForceNoHUD", "Force no HUD", "Rules", { advanced: true }),
  gusBool("EnablePVPGamma", "Allow gamma in PvP", "PvP", { emitAs: "EnablePVPGamma" }),
  gusBool("DisablePvEGamma", "Disable gamma in PvE", "Rules", { advanced: true }),
  gusBool("AllowFlyerCarryPvE", "Allow flyer carry (PvE)", "Tamed creatures"),
  gusBool("NoTributeDownloads", "No tribute downloads", "Cross-server", { advanced: true }),
  gusBool("PreventDownloadSurvivors", "Prevent download survivors", "Cross-server", { advanced: true }),
  gusBool("PreventDownloadItems", "Prevent download items", "Cross-server", { advanced: true }),
  gusBool("PreventDownloadDinos", "Prevent download dinos", "Cross-server", { advanced: true }),
  gusBool("AllowRaidDinoFeeding", "Allow raid dino (titan) feeding", "Tamed creatures", { advanced: true }),
  gusBool("RandomSupplyCratePoints", "Randomize supply crate locations", "Loot crates", { advanced: true }),
  gusBool("AllowHideDamageSourceFromLogs", "Hide damage source from logs", "Tribes", { advanced: true }),
  gusBool("AllowAnyoneBabyImprintCuddle", "Anyone can imprint/cuddle", "Breeding", { advanced: true }),
  gusBool("DisableImprintDinoBuff", "Disable imprint rider stat buff", "Breeding", { advanced: true }),
  gusBool("AlwaysNotifyPlayerLeft", "Notify when a player leaves", "Server", { advanced: true }),
  gusBool("DontAlwaysNotifyPlayerJoined", "Don't notify when a player joins", "Server", { advanced: true }),

  // ── Difficulty ─────────────────────────────────────────────────────────────
  gusFloat("DifficultyOffset", "Difficulty offset", "Difficulty", { min: 0, max: 1, step: 0.01 }),
  gusFloat("OverrideOfficialDifficulty", "Max wild creature level", "Difficulty", {
    def: 5,
    min: 1,
    max: 20,
    step: 0.5,
    displayScale: 30,
    unit: "level",
    lo: "easier",
    hi: "harder",
    help: "Highest level wild creatures can spawn at (they range from 1 up to this). 150 = official 'Hard'/single-player max, 30 = easiest. Internally this is the difficulty value ×30.",
  }),

  // ── Rates ──────────────────────────────────────────────────────────────────
  gusFloat("XPMultiplier", "XP multiplier", "Rates", { max: 1000 }),
  gusFloat("TamingSpeedMultiplier", "Taming speed", "Rates", { max: 1000 }),
  gusFloat("HarvestAmountMultiplier", "Harvest amount", "Rates", { max: 1000 }),
  gusFloat("HarvestHealthMultiplier", "Harvest health (node durability)", "Rates", { advanced: true }),
  gusFloat("ResourcesRespawnPeriodMultiplier", "Resource respawn period", "Rates", { advanced: true, lo: "faster", hi: "slower" }),
  gusFloat("ItemStackSizeMultiplier", "Item stack size", "Items", { min: 1, max: 100, step: 0.5 }),
  gusFloat("FuelConsumptionIntervalMultiplier", "Fuel consumption interval", "Pickup & power", { advanced: true }),
  gusFloat("OxygenSwimSpeedStatMultiplier", "Oxygen swim-speed bonus", "Players", { advanced: true, max: 50 }),

  // ── Time & weather ─────────────────────────────────────────────────────────
  gusFloat("DayCycleSpeedScale", "Day/night cycle speed", "Time & weather", { max: 50, lo: "slower", hi: "faster" }),
  gusFloat("DayTimeSpeedScale", "Daytime speed", "Time & weather", { max: 50, advanced: true, lo: "longer day", hi: "shorter day" }),
  gusFloat("NightTimeSpeedScale", "Nighttime speed", "Time & weather", { max: 50, advanced: true, lo: "longer night", hi: "shorter night" }),
  gusBool("DisableWeatherFog", "Disable fog", "Time & weather", { advanced: true }),

  // ── Spoiling & decomposition ───────────────────────────────────────────────
  gusFloat("GlobalSpoilingTimeMultiplier", "Food spoiling time", "Spoiling & decay", { advanced: true, lo: "shorter", hi: "longer" }),
  gusFloat("GlobalItemDecompositionTimeMultiplier", "Dropped item decomposition", "Spoiling & decay", { advanced: true, lo: "shorter", hi: "longer" }),
  gusFloat("GlobalCorpseDecompositionTimeMultiplier", "Corpse decomposition", "Spoiling & decay", { advanced: true, lo: "shorter", hi: "longer" }),
  gusBool("ClampItemSpoilingTimes", "Clamp item spoiling times", "Spoiling & decay", { advanced: true }),

  // ── Players ────────────────────────────────────────────────────────────────
  gusFloat("PlayerCharacterFoodDrainMultiplier", "Player food drain", "Players", { max: 50, advanced: true }),
  gusFloat("PlayerCharacterWaterDrainMultiplier", "Player water drain", "Players", { max: 50, advanced: true }),
  gusFloat("PlayerCharacterStaminaDrainMultiplier", "Player stamina drain", "Players", { max: 50, advanced: true }),
  gusFloat("PlayerCharacterHealthRecoveryMultiplier", "Player health recovery", "Players", { max: 50, advanced: true }),
  gusFloat("PlayerDamageMultiplier", "Player damage", "Players", { max: 100 }),
  gusFloat("PlayerResistanceMultiplier", "Player resistance", "Players", { max: 100 }),
  gusInt("OverrideMaxExperiencePointsPlayer", "Max player XP cap", "Players", { def: 0, max: 1000000000, step: 1000000, advanced: true, help: "0 = use default." }),

  // ── Dinos ──────────────────────────────────────────────────────────────────
  gusFloat("DinoCountMultiplier", "Wild dino count", "Wild creatures", { max: 50 }),
  gusFloat("DinoDamageMultiplier", "Wild dino damage", "Wild creatures", { max: 100 }),
  gusFloat("DinoResistanceMultiplier", "Wild dino resistance", "Wild creatures", { max: 100 }),
  gusFloat("TamedDinoDamageMultiplier", "Tamed dino damage", "Tamed creatures", { max: 100 }),
  gusFloat("TamedDinoResistanceMultiplier", "Tamed dino resistance", "Tamed creatures", { max: 100 }),
  gusFloat("DinoCharacterFoodDrainMultiplier", "Dino food drain", "All creatures", { max: 50, advanced: true }),
  gusFloat("DinoCharacterStaminaDrainMultiplier", "Dino stamina drain", "All creatures", { max: 50, advanced: true }),
  gusFloat("DinoCharacterHealthRecoveryMultiplier", "Dino health recovery", "All creatures", { max: 50, advanced: true }),
  gameFloat("DinoHarvestingDamageMultiplier", "Dino harvesting damage", "Tamed creatures", { def: 3.2, max: 100, advanced: true, help: "Harvest damage a tame does per hit (ARK default is 3.2). Game.ini setting." }),
  gameFloat("DinoTurretDamageMultiplier", "Turret damage to dinos", "All creatures", { max: 100, advanced: true, help: "Damage turrets deal to creatures. Game.ini setting." }),
  gusFloat("ServerAutoForceRespawnWildDinosInterval", "Auto wild-dino respawn interval (s)", "Wild creatures", { def: 0, max: 604800, step: 3600, advanced: true, lo: "often", hi: "rarely" }),
  gusInt("MaxTamedDinos", "Max tamed dinos (server)", "Tamed creatures", { def: 5000, min: 100, max: 100000, step: 100, advanced: true }),

  // ── Structures ─────────────────────────────────────────────────────────────
  gusFloat("StructureResistanceMultiplier", "Structure resistance", "Structure combat", { max: 100 }),
  gusFloat("StructureDamageMultiplier", "Structure damage", "Structure combat", { max: 100 }),
  gusInt("TheMaxStructuresInRange", "Max structures in range", "Structure limits", { def: 10500, min: 1000, max: 1000000, step: 500, advanced: true }),
  gusFloat("StructurePreventResourceRadiusMultiplier", "Resource-block radius", "Building", { advanced: true }),
  gusFloat("PerPlatformMaxStructuresMultiplier", "Platform structure limit ×", "Structure limits", { advanced: true, max: 10 }),
  gusInt("MaxPlatformSaddleStructureLimit", "Max platform-saddle structures", "Structure limits", { def: 100, min: 0, max: 5000, step: 10, advanced: true }),
  gusBool("AlwaysAllowStructurePickup", "Always allow structure pickup", "Pickup & power", { advanced: true }),
  gusBool("DisableStructureDecayPVE", "Disable structure decay (PvE)", "Structure decay"),
  gusFloat("PvEStructureDecayPeriodMultiplier", "PvE structure decay period", "Structure decay", { advanced: true, lo: "shorter", hi: "longer" }),

  // ── Crops & farming ────────────────────────────────────────────────────────
  gameFloat("CropGrowthSpeedMultiplier", "Crop growth speed", "Crops & farming", { advanced: true }),
  gameFloat("CropDecaySpeedMultiplier", "Crop decay speed", "Crops & farming", { advanced: true }),
  gameFloat("PoopIntervalMultiplier", "Poop interval", "Crops & farming", { advanced: true }),
  gameFloat("HairGrowthSpeedMultiplier", "Hair growth speed", "Players", { advanced: true }),

  // ── Breeding ───────────────────────────────────────────────────────────────
  gameFloat("MatingIntervalMultiplier", "Mating interval", "Breeding", { lo: "faster", hi: "slower" }),
  gameFloat("MatingSpeedMultiplier", "Mating speed", "Breeding", { advanced: true }),
  gameFloat("EggHatchSpeedMultiplier", "Egg hatch speed", "Breeding"),
  gameFloat("BabyMatureSpeedMultiplier", "Baby mature speed", "Breeding"),
  gameFloat("BabyFoodConsumptionSpeedMultiplier", "Baby food consumption", "Breeding", { advanced: true }),
  gameFloat("BabyCuddleIntervalMultiplier", "Baby cuddle interval", "Breeding", { advanced: true, lo: "faster", hi: "slower" }),
  gameFloat("BabyCuddleGracePeriodMultiplier", "Cuddle grace period", "Breeding", { advanced: true, lo: "shorter", hi: "longer" }),
  gameFloat("BabyCuddleLoseImprintQualitySpeedMultiplier", "Imprint loss speed", "Breeding", { advanced: true, lo: "slower", hi: "faster" }),
  gameFloat("BabyImprintingStatScaleMultiplier", "Imprint stat bonus", "Breeding", { advanced: true }),
  gameFloat("BabyImprintAmountMultiplier", "Imprint % per cuddle", "Breeding", { advanced: true }),
  gameFloat("LayEggIntervalMultiplier", "Lay egg interval", "Breeding", { advanced: true, lo: "faster", hi: "slower" }),

  // ── XP breakdown (Game.ini) ────────────────────────────────────────────────
  gameFloat("KillXPMultiplier", "Kill XP", "XP breakdown", { advanced: true }),
  gameFloat("HarvestXPMultiplier", "Harvest XP", "XP breakdown", { advanced: true }),
  gameFloat("CraftXPMultiplier", "Craft XP", "XP breakdown", { advanced: true }),
  gameFloat("GenericXPMultiplier", "Generic (idle) XP", "XP breakdown", { advanced: true }),
  gameFloat("SpecialXPMultiplier", "Special XP", "XP breakdown", { advanced: true }),

  // ── Crafting ───────────────────────────────────────────────────────────────
  gameFloat("CustomRecipeEffectivenessMultiplier", "Custom recipe effectiveness", "Crafting", { advanced: true }),
  gameFloat("CustomRecipeSkillMultiplier", "Custom recipe skill bonus", "Crafting", { advanced: true }),
  gameFloat("PlayerHarvestingDamageMultiplier", "Player harvesting damage", "Rates", { advanced: true, max: 100 }),
  gameBool("bAllowCustomRecipes", "Allow custom recipes", "Crafting", { def: true, advanced: true }),

  // ── Tribes ─────────────────────────────────────────────────────────────────
  gameInt("MaxNumberOfPlayersInTribe", "Max players per tribe", "Tribes", { def: 0, max: 500, help: "0 = unlimited." }),
  gameInt("MaxTribeLogs", "Max tribe log entries", "Tribes", { def: 100, min: 0, max: 1000, step: 10, advanced: true }),
  gameFloat("TribeNameChangeCooldown", "Tribe name change cooldown (min)", "Tribes", { def: 15, max: 1440, step: 5, advanced: true, lo: "shorter", hi: "longer" }),
  gusBool("PreventTribeAlliances", "Prevent tribe alliances", "Tribes", { advanced: true }),

  // ── PvP ────────────────────────────────────────────────────────────────────
  gusBool("bPvEDisableFriendlyFire", "Disable friendly fire (PvE)", "PvP", { advanced: true }),
  gameBool("bAutoPvETimer", "Timed PvE/PvP (auto PvE timer)", "PvP", { advanced: true }),
  gameFloat("AutoPvEStartTimeSeconds", "Auto-PvE start (sec of day)", "PvP", { def: 0, max: 86400, step: 60, advanced: true, lo: "earlier", hi: "later" }),
  gameFloat("AutoPvEStopTimeSeconds", "Auto-PvE stop (sec of day)", "PvP", { def: 0, max: 86400, step: 60, advanced: true, lo: "earlier", hi: "later" }),
  gameFloat("PvPZoneStructureDamageMultiplier", "PvP-zone structure damage", "PvP", { def: 6, max: 100, advanced: true }),
  gameBool("bIncreasePvPRespawnInterval", "Increasing PvP respawn timer", "PvP", { advanced: true }),
  gameBool("bDisableLootCrates", "Disable loot crates", "Loot crates", { advanced: true }),
  gameBool("bAllowUnlimitedRespecs", "Allow unlimited mindwipes", "Players", { advanced: true }),
  gameBool("bPassiveDefensesDamageRiderlessDinos", "Spikes damage riderless dinos", "PvP", { advanced: true }),

  // ── Auto-save & idle ───────────────────────────────────────────────────────
  gusFloat("AutoSavePeriodMinutes", "Auto-save period (min)", "Server", { def: 15, min: 1, max: 240, step: 1, lo: "often", hi: "rarely" }),
  gusFloat("KickIdlePlayersPeriod", "Kick idle players after (s)", "Server", { def: 3600, min: 0, max: 7200, step: 60, advanced: true, lo: "sooner", hi: "later" }),
  gameBool("bUseSingleplayerSettings", "Use single-player rates", "Server", { advanced: true }),

  // ── Tribute expiration (cross-server) ──────────────────────────────────────
  gusInt("TributeItemExpirationSeconds", "Uploaded item expiration (s)", "Cross-server", { def: 86400, max: 2592000, step: 3600, advanced: true, lo: "shorter", hi: "longer" }),
  gusInt("TributeDinoExpirationSeconds", "Uploaded dino expiration (s)", "Cross-server", { def: 86400, max: 2592000, step: 3600, advanced: true, lo: "shorter", hi: "longer" }),
  gusInt("TributeCharacterExpirationSeconds", "Uploaded survivor expiration (s)", "Cross-server", { def: 86400, max: 2592000, step: 3600, advanced: true, lo: "shorter", hi: "longer" }),

  // ── More rules ─────────────────────────────────────────────────────────────
  gusBool("AllowCaveBuildingPvE", "Allow cave building (PvE)", "Building", { advanced: true }),
  gusBool("AllowCaveBuildingPvP", "Allow cave building (PvP)", "Building", { def: true, advanced: true }),
  gusBool("PreventDiseases", "Disable diseases (e.g. Swamp Fever)", "Players", { advanced: true }),
  gusBool("NonPermanentDiseases", "Diseases are cured on respawn", "Players", { advanced: true }),
  gusBool("PreventSpawnAnimations", "Skip the wake-up animation on spawn", "Players", { advanced: true }),

  // ── More rates ─────────────────────────────────────────────────────────────
  gusFloat("SupplyCrateLootQualityMultiplier", "Supply crate loot quality", "Loot crates", { advanced: true, max: 5 }),
  gusFloat("FishingLootQualityMultiplier", "Fishing loot quality", "Items", { advanced: true, max: 5 }),
  gameFloat("CraftingSkillBonusMultiplier", "Crafting skill bonus", "Crafting", { advanced: true }),

  // ── More dinos / leveling ──────────────────────────────────────────────────
  gusInt("OverrideMaxExperiencePointsDino", "Max creature XP cap", "Tamed creatures", { def: 0, max: 1000000000, step: 1000000, advanced: true }),
  gameBool("bAllowSpeedLeveling", "Allow leveling Movement Speed (players)", "Players", { advanced: true }),
  gameBool("bAllowFlyerSpeedLeveling", "Allow leveling flyer Movement Speed", "Tamed creatures", { advanced: true }),

  // ── More structures ────────────────────────────────────────────────────────
  gusBool("EnableExtraStructurePreventionVolumes", "Block building in extra no-build zones", "Building", { advanced: true }),
  gusBool("FastDecayUnsnappedCoreStructures", "Fast-decay unsnapped foundations/pillars", "Structure decay", { advanced: true }),
  gusBool("DestroyUnconnectedWaterPipes", "Auto-destroy disconnected water pipes", "Structure decay", { advanced: true }),
  gusBool("OnlyAutoDestroyCoreStructures", "Only auto-destroy core structures", "Structure decay", { advanced: true }),
  gusFloat("PlatformSaddleBuildAreaBoundsMultiplier", "Platform build-area size", "Platforms & saddles", { advanced: true, max: 10 }),

  // ── More PvP / tribes ──────────────────────────────────────────────────────
  gusBool("PreventOfflinePvP", "Offline raid protection", "PvP", { advanced: true }),
  gusFloat("PreventOfflinePvPInterval", "Offline-protection grace (s)", "PvP", { def: 0, max: 3600, step: 30, advanced: true }),
  gameInt("MaxAlliancesPerTribe", "Max alliances per tribe", "Tribes", { def: 0, max: 100, advanced: true }),
  gameInt("MaxTribesPerAlliance", "Max tribes per alliance", "Tribes", { def: 0, max: 100, advanced: true }),

  // ── Launch options ─────────────────────────────────────────────────────────
  dashOption("ActiveEvent", "Active seasonal event", {
    type: "enum",
    def: "",
    choices: [
      { value: "", label: "None" },
      { value: "WinterWonderland", label: "Winter Wonderland (Christmas)" },
      { value: "vday", label: "Love Evolved (Valentine's)" },
      { value: "Easter", label: "Eggcellent Adventure (Easter)" },
      { value: "Summer", label: "Summer Bash" },
      { value: "FearEvolved", label: "Fear Evolved (Halloween)" },
      { value: "TurkeyTrial", label: "Turkey Trial (Thanksgiving)" },
      { value: "Birthday", label: "ARK Anniversary" },
    ],
    help: "Runs a seasonal event. If a token ever changes, you can still set it via the raw args box.",
  }),
  dashOption("culture", "Server language override", {
    type: "enum",
    def: "Default",
    choices: [
      { value: "Default", label: "Default" },
      { value: "en", label: "English" },
      { value: "de", label: "German" },
      { value: "fr", label: "French" },
      { value: "es", label: "Spanish" },
      { value: "it", label: "Italian" },
      { value: "pt", label: "Portuguese" },
      { value: "ru", label: "Russian" },
      { value: "zh", label: "Chinese" },
      { value: "ja", label: "Japanese" },
      { value: "ko", label: "Korean" },
    ],
    advanced: true,
  }),

  // ── Launch flags ───────────────────────────────────────────────────────────
  flag("NoUnderMeshKilling", "Disable under-mesh killing", "noundermeshkilling", { advanced: true }),
  flag("NoUnderMeshChecking", "Disable under-mesh checking", "noundermeshchecking", { advanced: true }),
  flag("ServerRCONOutputTribeLogs", "Show tribe logs in RCON output", "ServerRCONOutputTribeLogs", { advanced: true }),
  flag("NotifyAdminCommandsInChat", "Announce admin commands in chat", "NotifyAdminCommandsInChat", { advanced: true }),

  // ── Structured (Tier B) ────────────────────────────────────────────────────
  statGrid("PerLevelStatsMultiplier_Player", "Per-level stats — Player"),
  statGrid("PerLevelStatsMultiplier_DinoTamed", "Per-level stats — Tamed dino (added)"),
  statGrid("PerLevelStatsMultiplier_DinoWild", "Per-level stats — Wild dino"),
  {
    key: "MessageOfTheDay",
    label: "Message of the Day",
    category: "Chat",
    target: GUS,
    section: "MessageOfTheDay",
    type: "motd",
    default: { message: "", duration: 20 },
    help: "A message shown to players when they join. Duration is how many seconds it stays on screen.",
  },
  {
    key: "ConfigOverrideItemMaxQuantity",
    label: "Item stack-size overrides",
    category: "Items",
    target: GAMEINI,
    section: MODE,
    type: "itemmax",
    emitAs: "ConfigOverrideItemMaxQuantity",
    default: [],
    advanced: true,
    help: 'Override the max stack size of specific items by class (e.g. "PrimalItemResource_Wood"). "ignore ×" makes the value absolute instead of multiplied by the global stack multiplier.',
  },
  {
    key: "ConfigOverrideItemCraftingCosts",
    label: "Item crafting costs (recipes)",
    category: "Items",
    target: GAMEINI,
    section: MODE,
    type: "craftcost",
    emitAs: "ConfigOverrideItemCraftingCosts",
    default: [],
    advanced: true,
    help: "Change what it costs to craft an item. Pick an item, then list the resources (and how many of each) its recipe requires — this fully replaces the item's default cost.",
  },
  {
    key: "DinoSpawnWeightMultipliers",
    label: "Creature spawn rates",
    category: "Creature spawns",
    target: GAMEINI,
    section: MODE,
    type: "spawnweight",
    emitAs: "DinoSpawnWeightMultipliers",
    default: [],
    advanced: true,
    help: "Make specific creatures spawn more or less often. Weight is relative (1 = default, higher = more common). Optionally cap the share of a spawn region the creature can occupy.",
  },
  {
    key: "NPCReplacements",
    label: "Creature spawn replacements",
    category: "Creature spawns",
    target: GAMEINI,
    section: MODE,
    type: "npcreplace",
    emitAs: "NPCReplacements",
    default: [],
    advanced: true,
    help: "Replace one creature's spawns with another, or disable a creature entirely (leave the replacement empty).",
  },
  {
    key: "LevelRamp",
    label: "Level cap & XP curve",
    category: "Leveling",
    target: GAMEINI,
    section: MODE,
    type: "levelramp",
    default: {
      player: { maxLevel: 0, baseXp: 10, growth: 1.05, engramPerLevel: 8 },
      dino: { maxLevel: 0, baseXp: 10, growth: 1.05 },
    },
    advanced: true,
    help: "Raise the level cap and shape the XP curve for players and dinos, plus engram points per player level. Set a max level above 0 to enable; the curve is generated for you (raw box for exact per-level values).",
  },
  {
    key: "Engrams",
    label: "Engram overrides",
    category: "Engrams",
    target: GAMEINI,
    section: MODE,
    type: "engrams",
    default: { overrides: [], autoUnlockOnly: [] },
    advanced: true,
    help: "Hide engrams, change their point cost / level requirement, remove prerequisites, or auto-unlock them at a level.",
  },
  {
    key: "SupplyCrateOverrides",
    label: "Supply crate loot",
    category: "Loot crates",
    target: GAMEINI,
    section: MODE,
    type: "lootcrate",
    emitAs: "ConfigOverrideSupplyCrateItems",
    default: [],
    advanced: true,
    help: "Override exactly what a supply/loot crate can contain. Pick a crate, then add the items it should drop with quantity, quality, and blueprint chance.",
  },
  {
    key: "SpawnContainerOverrides",
    label: "Spawn pool overrides",
    category: "Creature spawns",
    target: GAMEINI,
    section: MODE,
    type: "spawncontainer",
    emitAs: "ConfigOverrideNPCSpawnEntriesContainer",
    default: [],
    advanced: true,
    help: "Full control of a spawn region: replace which creatures spawn there (with weights) and cap each creature's share. Advanced — most needs are covered by Creature spawn rates above.",
  },

  // ── Extended coverage (auto-audited against the ARK wiki settings list) ──────
  // Rates / consumption
  gameFloat("BaseTemperatureMultiplier", "Base temperature", "Time & weather", { advanced: true, lo: "colder", hi: "hotter", max: 10, help: "Map base temperature. Lower = colder world, higher = hotter." }),
  gameFloat("TamedDinoCharacterFoodDrainMultiplier", "Tamed creature food drain", "Tamed creatures", { advanced: true, max: 10, help: "How fast tamed creatures get hungry." }),
  gameFloat("WildDinoCharacterFoodDrainMultiplier", "Wild creature food drain", "Wild creatures", { advanced: true, max: 10, help: "How fast wild creatures get hungry." }),
  gameFloat("TamedDinoTorporDrainMultiplier", "Tamed creature torpor drain", "Tamed creatures", { advanced: true, max: 10, help: "How fast tamed creatures lose torpor." }),
  gameFloat("WildDinoTorporDrainMultiplier", "Wild creature torpor drain", "Wild creatures", { advanced: true, max: 10, help: "How fast wild creatures lose torpor (affects taming knock-out)." }),
  gusFloat("RaidDinoCharacterFoodDrainMultiplier", "Raid creature food drain", "All creatures", { advanced: true, max: 10, help: "How fast raid creatures (e.g. Titanosaur) get hungry." }),
  gameFloat("PassiveTameIntervalMultiplier", "Passive tame interval", "Rates", { advanced: true, max: 10, help: "How often a survivor gets passive-tame feed requests." }),
  gameFloat("GlobalPoweredBatteryDurabilityDecreasePerSecond", "Battery drain per second", "Pickup & power", { def: 3, advanced: true, max: 100, help: "Rate charge batteries are used by electrical objects." }),

  // Breeding / imprinting (the imprint/cuddle multipliers already live above)
  gameBool("bDisableDinoBreeding", "Disable breeding", "Breeding", { advanced: true, help: "Prevent tames from being bred." }),
  gusBool("PreventMateBoost", "Disable mate boost", "Breeding", { advanced: true, help: "Turn off the mate-boost buff between nearby opposite-sex creatures." }),

  // Creatures (taming / riding / decay / limits)
  gameBool("bDisableDinoTaming", "Disable taming", "Tamed creatures", { advanced: true, help: "Prevent players from taming wild creatures." }),
  gameBool("bDisableDinoRiding", "Disable riding", "Tamed creatures", { advanced: true, help: "Prevent players from riding tames." }),
  gameBool("bAllowUnclaimDinos", "Allow unclaiming tames", "Tamed creatures", { def: true, advanced: true, help: "Let players unclaim their tamed creatures." }),
  gameBool("bUseDinoLevelUpAnimations", "Tame level-up animation", "Tamed creatures", { def: true, advanced: true, help: "Play the level-up animation when a tame levels." }),
  gameBool("bFlyerPlatformAllowUnalignedDinoBasing", "Quetz platform basing", "Tamed creatures", { advanced: true, help: "Allow non-allied tames to base on flying Quetz platforms." }),
  gusBool("bForceCanRideFliers", "Force allow flyers", "Tamed creatures", { advanced: true, help: "Allow flyers on maps where they're normally disabled (or disable them everywhere if off)." }),
  gusBool("AutoDestroyDecayedDinos", "Auto-destroy decayed tames", "Tamed creatures", { advanced: true, help: "Destroy claimable, decayed tames on load instead of leaving them claimable." }),
  gusBool("DisableDinoDecayPvE", "Disable tame decay (PvE)", "Tamed creatures", { advanced: true, help: "Turn off the auto-decay/unclaim of tames in PvE." }),
  gusFloat("PvEDinoDecayPeriodMultiplier", "Tame decay period (PvE)", "Tamed creatures", { advanced: true, max: 100, help: "Scales how long until a PvE tame decays." }),
  gusBool("PvPDinoDecay", "Tame decay during ORP (PvP)", "Tamed creatures", { advanced: true, help: "Enable tame decay while Offline Raid Protection is active." }),
  gusInt("MaxPersonalTamedDinos", "Per-tribe tame limit", "Tamed creatures", { advanced: true, max: 10000, help: "Max tames per tribe. 0 = no limit." }),
  gusBool("DestroyTamesOverTheSoftTameLimit", "Enforce soft tame limit", "Tamed creatures", { advanced: true, help: "Mark tames over the soft limit for cryo, then auto-destroy them after a countdown." }),
  gameInt("DestroyTamesOverLevelClamp", "Destroy tames over level", "Tamed creatures", { advanced: true, max: 100000, help: "Delete tames above this level on server start. 0 = off." }),

  // Cryopods
  gusBool("EnableCryoSicknessPVE", "Cryo sickness (PvE)", "Cryopods", { advanced: true, help: "Apply the cryopod deploy cooldown/sickness in PvE." }),
  gusBool("EnableCryopodNerf", "Enable cryopod nerf", "Cryopods", { advanced: true, help: "Apply the post-deploy damage nerf (set the duration/mults below)." }),
  gusFloat("CryopodNerfDuration", "Cryo nerf duration (s)", "Cryopods", { advanced: true, max: 600, emitAs: "CryopodNerfDuration", help: "Seconds the cryo-deploy debuff lasts." }),
  gusFloat("CryopodNerfDamageMult", "Cryo nerf outgoing damage", "Cryopods", { advanced: true, step: 0.01, max: 1, lo: "less dmg", hi: "full dmg", help: "Fraction of damage a just-deployed creature deals. 0.1 = 90% removed." }),
  gusFloat("CryopodNerfIncomingDamageMultPercent", "Cryo nerf incoming damage", "Cryopods", { advanced: true, step: 0.01, max: 2, help: "Extra damage a just-deployed creature takes. 0.25 = +25%." }),
  gusBool("DisableCryopodEnemyCheck", "Cryo near enemies", "Cryopods", { advanced: true, help: "Allow cryopods to be used while enemies are nearby." }),
  gusBool("DisableCryopodFridgeRequirement", "No cryofridge needed", "Cryopods", { advanced: true, help: "Allow cryopods to be used without a powered cryofridge in range." }),

  // Structures
  gusFloat("AutoDestroyOldStructuresMultiplier", "Auto-destroy old structures", "Structure decay", { advanced: true, max: 100, help: "Auto-destroy abandoned structures after this × their decay time. Needs the auto-destroy launch flag. 0 = off." }),
  gameInt("FastDecayInterval", "Fast-decay interval (s)", "Structure decay", { def: 43200, advanced: true, max: 1000000, help: "Decay time for unsnapped 'fast decay' structures (lone pillars/foundations)." }),
  gusBool("PvPStructureDecay", "Structure decay during ORP (PvP)", "Structure decay", { advanced: true, help: "Enable structure decay while Offline Raid Protection is active." }),
  gusBool("ForceAllStructureLocking", "Lock all structures by default", "Structure decay", { advanced: true, help: "New structures default to locked." }),
  gusBool("IgnoreLimitMaxStructuresInRangeTypeFlag", "No decorative structure cap", "Structure limits", { advanced: true, help: "Remove the 150 decorative-structure (signs/flags/dermis) limit." }),
  gusBool("OverrideStructurePlatformPrevention", "Turrets on platforms", "Platforms & saddles", { advanced: true, help: "Allow turrets/spikes to be built and function on platform saddles." }),
  gusInt("MaxGateFrameOnSaddles", "Gateways per platform saddle", "Structure limits", { advanced: true, max: 100, help: "Max gateways on a platform saddle. 0 = none allowed." }),
  gusInt("PersonalTamedDinosSaddleStructureCost", "Platform saddle tame cost", "Platforms & saddles", { advanced: true, max: 100, help: "How many tame slots a platform saddle with structures uses." }),
  gameBool("bAllowPlatformSaddleMultiFloors", "Multi-floor platform saddles", "Platforms & saddles", { advanced: true, help: "Allow multiple platform floors." }),
  gameBool("bUseTameLimitForStructuresOnly", "Tame limit for platforms only", "Platforms & saddles", { advanced: true, help: "Only count platform/raft tames toward the tame limit." }),
  gusBool("PvEAllowStructuresAtSupplyDrops", "Build near supply drops (PvE)", "Building", { advanced: true, help: "Allow building near supply drop points in PvE." }),
  gameInt("StructureDamageRepairCooldown", "Repair cooldown (s)", "Structure combat", { def: 180, advanced: true, max: 100000, help: "Cooldown after damage before a structure can be repaired. 0 = off." }),
  gusBool("AllowCrateSpawnsOnTopOfStructures", "Crates on structures", "Building", { advanced: true, help: "Let air-drop supply crates land on top of structures." }),
  gameBool("bIgnoreStructuresPreventionVolumes", "Build in prevention zones", "Building", { advanced: true, help: "Allow building in normally-blocked areas (obelisks, portals, mission volumes)." }),
  gameInt("WirelessCraftingRangeOverride", "Wireless crafting range", "Structure limits", { def: 3000, advanced: true, max: 100000, help: "Range (Unreal units) for Tek Dedicated Storage wireless crafting." }),
  gameInt("LimitGeneratorsNum", "Generator limit", "Structure limits", { def: 3, advanced: true, max: 1000, help: "Max generators within the generator range below. " }),
  gameInt("LimitGeneratorsRange", "Generator limit range", "Structure limits", { def: 15000, advanced: true, max: 1000000, help: "Area (Unreal units) the generator limit applies in." }),
  gameInt("LimitNonPlayerDroppedItemsCount", "Dropped item limit", "Structure limits", { advanced: true, max: 100000, help: "Max non-player dropped items within the range below. 0 = off." }),
  gameInt("LimitNonPlayerDroppedItemsRange", "Dropped item limit range", "Structure limits", { advanced: true, max: 1000000, help: "Area (Unreal units) the dropped-item limit applies in." }),

  // Turrets
  gameBool("bLimitTurretsInRange", "Limit turrets in range", "Turrets", { def: true, advanced: true, help: "Cap the number of turrets in an area (see below)." }),
  gameBool("bHardLimitTurretsInRange", "Hard turret limit", "Turrets", { advanced: true, help: "Enforce the retroactive 100-turrets-per-10k-units hard limit." }),
  gameInt("LimitTurretsNum", "Turret limit", "Turrets", { def: 100, advanced: true, max: 1000, help: "Max turrets allowed in the turret range." }),
  gameFloat("LimitTurretsRange", "Turret limit range", "Turrets", { def: 10000, advanced: true, max: 100000, help: "Area (Unreal units) counted toward the turret limit." }),

  // PvP
  gameFloat("IncreasePvPRespawnIntervalBaseAmount", "PvP respawn penalty base (s)", "PvP", { def: 60, advanced: true, max: 3600, help: "Extra respawn time added when killed by the same team repeatedly." }),
  gameFloat("IncreasePvPRespawnIntervalCheckPeriod", "PvP respawn penalty window (s)", "PvP", { def: 300, advanced: true, max: 3600, help: "Window in which repeat kills stack the respawn penalty." }),
  gameFloat("IncreasePvPRespawnIntervalMultiplier", "PvP respawn penalty scale", "PvP", { def: 2, advanced: true, max: 100, help: "How much the respawn penalty scales on repeat kills." }),
  gameFloat("PreventOfflinePvPConnectionInvincibleInterval", "Login invincibility (s)", "PvP", { advanced: true, max: 600, help: "Seconds a player can't take damage right after logging in." }),
  gameBool("bPvEAllowTribeWar", "Allow tribe war (PvE)", "Tribes", { def: true, advanced: true, help: "Let PvE tribes mutually declare war." }),
  gameBool("bPvEAllowTribeWarCancel", "Allow tribe war cancel (PvE)", "Tribes", { advanced: true, help: "Allow cancelling an agreed war before it starts." }),
  gameBool("bDisableFriendlyFire", "Disable friendly fire", "PvP", { advanced: true, help: "Prevent damage between tribe mates / their tames / structures." }),
  gameBool("bAutoPvEUseSystemTime", "Timed PvE uses real time", "PvP", { advanced: true, help: "For timed PvP→PvE servers: base the PvE window on the server's real clock instead of in-game time (pairs with the auto-PvE timer)." }),

  // Tribes
  gusBool("TribeLogDestroyedEnemyStructures", "Log enemy structure kills", "Tribes", { advanced: true, help: "Show enemy structure destruction in the victim tribe's log." }),
  gameFloat("TribeSlotReuseCooldown", "Tribe slot reuse cooldown (s)", "Tribes", { advanced: true, max: 1000000, help: "Lock a vacated tribe slot for this many seconds before someone can take it." }),

  // Players
  gameFloat("MaxFallSpeedMultiplier", "Fall damage threshold", "Players", { advanced: true, max: 100, help: "How far players can fall before taking damage. Higher = survive longer falls." }),
  gameBool("bUseCorpseLocator", "Corpse locator beam", "Players", { def: true, advanced: true, help: "Show the green beam at a player's death location." }),
  gameFloat("UseCorpseLifeSpanMultiplier", "Corpse/bag lifespan", "Players", { advanced: true, max: 100, help: "Scales how long corpses and dropped bags last." }),
  gusFloat("ImplantSuicideCD", "Respawn cooldown (s)", "Players", { def: 28800, advanced: true, max: 1000000, help: "Cooldown between uses of the implant 'Respawn' feature." }),
  gusBool("AllowSharedConnections", "Allow family sharing", "Server", { advanced: true, help: "Let Steam Family Sharing players connect." }),

  // Cross-server transfers
  gusBool("PreventUploadSurvivors", "Prevent survivor uploads", "Cross-server", { advanced: true, help: "Block uploading survivors to ARK Data." }),
  gusBool("PreventUploadItems", "Prevent item uploads", "Cross-server", { advanced: true, help: "Block uploading items to ARK Data." }),
  gusBool("PreventUploadDinos", "Prevent creature uploads", "Cross-server", { advanced: true, help: "Block uploading creatures to ARK Data." }),
  gusBool("CrossARKAllowForeignDinoDownloads", "Allow foreign creature downloads", "Cross-server", { advanced: true, help: "Allow non-native creatures to be downloaded (e.g. on Aberration)." }),
  gusFloat("MinimumDinoReuploadInterval", "Creature re-upload cooldown (s)", "Cross-server", { advanced: true, max: 1000000, help: "Cooldown between allowed creature re-uploads." }),
  gusInt("MaxTributeCharacters", "Uploaded survivor slots", "Cross-server", { def: 10, advanced: true, max: 1000, help: "Slots for uploaded survivors." }),
  gusInt("MaxTributeDinos", "Uploaded creature slots", "Cross-server", { def: 20, advanced: true, max: 1000, help: "Slots for uploaded creatures." }),
  gusInt("MaxTributeItems", "Uploaded item slots", "Cross-server", { def: 50, advanced: true, max: 1000, help: "Slots for uploaded items/resources." }),

  // Genesis / Hexagon store
  gameBool("bDisableGenesisMissions", "Disable Genesis missions", "Genesis", { advanced: true, help: "Turn off missions on Genesis maps." }),
  gameBool("bDisableHexagonStore", "Disable Hexagon store", "Hexagon store", { advanced: true, help: "Turn off the Hexagon/Club ARK store." }),
  gameFloat("HexagonCostMultiplier", "Hexagon store cost", "Hexagon store", { advanced: true, max: 100, help: "Scales item costs in the Hexagon/Club ARK store." }),
  gameFloat("BaseHexagonRewardMultiplier", "Hexagon reward", "Hexagon store", { advanced: true, max: 100, help: "Scales mission Hexagon/token rewards." }),
  gusInt("MaxHexagonsPerCharacter", "Max Hexagons per character", "Hexagon store", { advanced: true, max: 2000000000, def: 2000000000, help: "Cap on Hexagons a character can hold." }),

  // Ragnarok ([Ragnarok] section) — only shown on Ragnarok servers
  ragBool("EnableVolcano", "Enable volcano", "Ragnarok", { def: true, help: "Whether the Ragnarok volcano becomes active." }),
  ragFloat("VolcanoIntensity", "Volcano intensity", "Ragnarok", { def: 1, min: 0.25, max: 10, step: 0.25, lo: "milder", hi: "fiercer", help: "Lower value = a more intense eruption (minimum 0.25)." }),
  ragInt("VolcanoInterval", "Volcano interval", "Ragnarok", { def: 0, max: 100000, help: "0 = default 5000–15000s between eruptions; any value above acts as a multiplier." }),
  ragInt("UnicornSpawnInterval", "Unicorn respawn (hours)", "Ragnarok", { def: 24, max: 168, help: "Minimum hours before a new Unicorn spawns once the wild one is gone." }),
  ragBool("AllowMultipleTamedUnicorns", "Allow multiple tamed unicorns", "Ragnarok", { help: "Off = one Unicorn on the map at a time; on = unlimited tamed Unicorns." }),

  // Rules / misc
  gusBool("AdminLogging", "Log admin commands", "Server", { advanced: true, help: "Show all admin commands in chat." }),
  gusBool("AllowTekSuitPowersInGenesis", "Tek suit powers in Genesis", "Genesis", { advanced: true, help: "Enable Tek suit powers in Genesis: Part 1." }),
  gameBool("bShowCreativeMode", "Creative mode toggle", "Rules", { advanced: true, help: "Add a pause-menu button to toggle creative mode." }),
  gameBool("bDisablePhotoMode", "Disable photo mode", "Rules", { advanced: true, help: "Turn off photo mode." }),
  gameInt("PhotoModeRangeLimit", "Photo mode range", "Rules", { def: 3000, advanced: true, max: 100000, help: "Max distance the photo-mode camera can travel from the player." }),
  gameBool("bAutoUnlockAllEngrams", "Auto-learn all engrams at their level", "Engrams", { advanced: true, help: "Players automatically learn every engram the moment they reach its required level — no engram points to spend, nothing to pick. Takes priority over the per-engram overrides above." }),
  gameBool("bOnlyAllowSpecifiedEngrams", "Whitelist engrams only", "Engrams", { advanced: true, help: "Hide every engram not explicitly allowed by an engram override." }),
  gusBool("ClampItemStats", "Clamp item stats", "Items", { advanced: true, help: "Enable the item stat clamps (cap looted/crafted gear stats)." }),
  gusBool("ClampResourceHarvestDamage", "Clamp harvest damage", "Rates", { advanced: true, help: "Limit harvest damage to a node's remaining health (less waste with high-damage tools)." }),
  gusBool("UseOptimizedHarvestingHealth", "Optimized harvesting", "Rates", { advanced: true, help: "Server harvesting optimization for high harvest multipliers (fewer rare items)." }),
  gameFloat("ResourceNoReplenishRadiusPlayers", "Resource regrow radius (players)", "Rates", { advanced: true, max: 10, help: "How far from players resources refuse to regrow. >1 widens it, <1 shrinks it." }),
  gameFloat("ResourceNoReplenishRadiusStructures", "Resource regrow radius (structures)", "Rates", { advanced: true, max: 10, help: "How far from structures resources refuse to regrow. >1 widens it, <1 shrinks it." }),
  gusBool("UseFjordurTraversalBuff", "Fjordur biome teleport", "Fjordur", { advanced: true, help: "Enable the hold-to-teleport biome travel on Fjordur." }),
  gusInt("ExtinctionEventTimeInterval", "ARKpocalypse interval (s)", "Server", { advanced: true, max: 100000000, help: "Enables extinction/ARKpocalypse mode; server wipes on this interval (e.g. 2592000 = 30 days)." }),

  // Chat filtering
  gusBool("bFilterChat", "Filter chat", "Chat", { advanced: true, help: "Filter chat messages against the bad/good word lists." }),
  gusBool("bFilterCharacterNames", "Filter character names", "Chat", { advanced: true, help: "Filter character names against the bad/good word lists." }),
  gusBool("bFilterTribeNames", "Filter tribe names", "Chat", { advanced: true, help: "Filter tribe names against the bad/good word lists." }),

  // URLs (text)
  gusStr("BanListURL", "Ban list URL", "Server", { advanced: true, help: "URL of a global ban list, refreshed every ~10 minutes." }),
  gusStr("CustomDynamicConfigUrl", "Dynamic config URL", "Server", { advanced: true, help: "HTTP URL to a live dynamicconfig.ini (requires the dynamic-config launch flag)." }),
  gusStr("CustomLiveTuningUrl", "Live tuning URL", "Server", { advanced: true, help: "HTTP URL to a live tuning (overloads) file." }),
];
