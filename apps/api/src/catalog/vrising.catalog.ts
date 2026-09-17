import { Game, SettingTarget, type SettingsCatalog, type SettingDef } from "@ark/shared";

/**
 * V Rising catalog. The trueosiris image maps any `HOST_SETTINGS_<key>` /
 * `GAME_SETTINGS_<key>` env var onto ServerHostSettings.json / ServerGameSettings.json
 * (keys case-insensitive, `__` = one JSON nesting level, type-validated, unknown keys
 * ignored) — so every setting targets `Env` and buildVRisingSpec passes it through
 * (key = env var name). Keys below are the games' real JSON keys.
 *
 * First-class fields the orchestrator owns (server name, slots, ports, RCON + join
 * passwords) are NOT here.
 */
function vset(
  key: string,
  label: string,
  category: string,
  type: SettingDef["type"],
  def: SettingDef["default"],
  extra: Partial<SettingDef> = {},
): SettingDef {
  return { key, label, category, target: SettingTarget.Env, type, default: def, emitAs: key, ...extra };
}

function gchoices(values: string[]): { value: string; label: string }[] {
  return values.map((v) => ({ value: v, label: v }));
}

const settings: SettingDef[] = [
  // ── Version ──────────────────────────────────────────────────────────────────
  // trueosiris BRANCH env → run a specific Steam branch. Empty = current release
  // (skipped by vrisingCatalogEnv); "legacy-1.0.x-pc" pins the 1.0.x line.
  vset("BRANCH", "Game version", "Version", "enum", "", {
    choices: [
      { value: "", label: "Current (latest)" },
      { value: "legacy-1.0.x-pc", label: "Legacy 1.0.x" },
    ],
    help: "Which build of V Rising to run. Legacy pins the 1.0.x line. Changing it re-downloads the game on the next start.",
  }),
  // ── Mode / PvP ────────────────────────────────────────────────────────────────
  vset("GAME_SETTINGS_GameModeType", "Game mode", "Mode", "enum", "PvP", {
    choices: gchoices(["PvP", "PvE"]),
  }),
  vset("GAME_SETTINGS_ClanSize", "Clan size", "Mode", "int", 4, {
    min: 1,
    max: 10,
    help: "Max members per clan.",
  }),
  vset("GAME_SETTINGS_PlayerDamageMode", "Player damage", "Mode", "enum", "Always", {
    choices: gchoices(["Always", "TimeRestricted"]),
    help: "TimeRestricted limits PvP damage to the configured windows.",
  }),
  vset("GAME_SETTINGS_PvPProtectionMode", "New-player PvP protection", "Mode", "enum", "Medium", {
    choices: gchoices(["None", "Short", "Medium", "Long"]),
  }),
  vset("GAME_SETTINGS_DeathContainerPermission", "Death loot access", "Mode", "enum", "Anyone", {
    choices: gchoices(["Anyone", "ClanMembers", "OnlySelf"]),
    help: "Who may loot a player's dropped items.",
  }),
  vset("GAME_SETTINGS_CanLootEnemyContainers", "Loot enemy containers", "Mode", "bool", true),
  vset("GAME_SETTINGS_BloodBoundEquipment", "Blood-bound equipment", "Mode", "bool", true, {
    help: "Keep equipped gear on death.",
  }),
  vset("GAME_SETTINGS_TeleportBoundItems", "Teleport with resources", "Mode", "bool", true, {
    help: "Off = classic rule where resources block waypoint travel.",
  }),
  vset("GAME_SETTINGS_AllWaypointsUnlocked", "All waypoints unlocked", "Mode", "bool", false),
  vset("GAME_SETTINGS_AllowGlobalChat", "Global chat", "Mode", "bool", true),

  // ── Castles / sieges ──────────────────────────────────────────────────────────
  vset("GAME_SETTINGS_CastleDamageMode", "Castle damage", "Castles", "enum", "Never", {
    choices: gchoices(["Always", "Never", "TimeRestricted"]),
  }),
  vset(
    "GAME_SETTINGS_CastleHeartDamageMode",
    "Castle heart damage",
    "Castles",
    "enum",
    "CanBeDestroyedOnlyWhenDecaying",
    {
      choices: gchoices([
        "CanBeDestroyedOnlyWhenDecaying",
        "CanBeDestroyedByPlayers",
        "CanBeSeizedOrDestroyedByPlayers",
      ]),
    },
  ),
  vset("GAME_SETTINGS_SiegeWeaponHealth", "Siege golem health", "Castles", "enum", "Normal", {
    choices: gchoices(["VeryLow", "Low", "Normal", "High", "VeryHigh"]),
  }),
  vset("GAME_SETTINGS_CastleDecayRateModifier", "Castle decay rate", "Castles", "float", 1, {
    min: 0,
    max: 5,
    step: 0.1,
    help: "0 disables decay while the heart has blood essence.",
  }),

  // ── Rates / difficulty ────────────────────────────────────────────────────────
  vset("GAME_SETTINGS_MaterialYieldModifier_Global", "Resource yield", "Rates", "float", 1, {
    min: 0.25,
    max: 5,
    step: 0.25,
  }),
  vset("GAME_SETTINGS_BloodEssenceYieldModifier", "Blood essence yield", "Rates", "float", 1, {
    min: 0.25,
    max: 5,
    step: 0.25,
  }),
  vset("GAME_SETTINGS_DropTableModifier_General", "Loot drop rate", "Rates", "float", 1, {
    min: 0.25,
    max: 5,
    step: 0.25,
  }),
  vset("GAME_SETTINGS_InventoryStacksModifier", "Stack size", "Rates", "float", 1, {
    min: 0.25,
    max: 5,
    step: 0.25,
  }),
  vset(
    "GAME_SETTINGS_UnitStatModifiers_Global__MaxHealthModifier",
    "Enemy health",
    "Rates",
    "float",
    1,
    { min: 0.25, max: 5, step: 0.25, help: "Scales all non-boss enemy health." },
  ),
  vset(
    "GAME_SETTINGS_UnitStatModifiers_Global__PowerModifier",
    "Enemy damage",
    "Rates",
    "float",
    1,
    { min: 0.25, max: 5, step: 0.25, help: "Scales all non-boss enemy damage." },
  ),
  vset(
    "GAME_SETTINGS_UnitStatModifiers_VBlood__MaxHealthModifier",
    "V Blood boss health",
    "Rates",
    "float",
    1,
    { min: 0.25, max: 5, step: 0.25 },
  ),
  vset(
    "GAME_SETTINGS_UnitStatModifiers_VBlood__PowerModifier",
    "V Blood boss damage",
    "Rates",
    "float",
    1,
    { min: 0.25, max: 5, step: 0.25 },
  ),
  vset(
    "GAME_SETTINGS_GameTimeModifiers__DayDurationInSeconds",
    "Day length (seconds)",
    "Rates",
    "int",
    1080,
    { min: 60, max: 86400 },
  ),

  // ── Server / visibility ───────────────────────────────────────────────────────
  vset("HOST_SETTINGS_ListOnSteam", "List on Steam browser", "Server", "bool", false, {
    help: "Also enables the Steam query responder — live player counts in the dashboard need this on (verified live).",
  }),
  vset("HOST_SETTINGS_ListOnEOS", "List on EOS (crossplay)", "Server", "bool", false),
  vset("HOST_SETTINGS_Description", "Server description", "Server", "string", ""),
  vset("HOST_SETTINGS_Secure", "VAC secure", "Server", "bool", true),
  vset("HOST_SETTINGS_AutoSaveInterval", "Autosave interval (seconds)", "Server", "int", 120, {
    min: 30,
    max: 3600,
  }),
  vset("HOST_SETTINGS_AutoSaveCount", "Autosaves kept", "Server", "int", 20, { min: 2, max: 100 }),
  vset("HOST_SETTINGS_AutoSaveSmartKeep", "Smart autosave retention", "Server", "string", "", {
    help: "Comma-separated A:B:C entries — within the past A minutes keep the B newest and C oldest saves. Each window excludes the ones before it; the autosave cap still applies afterwards. Empty = keep only the newest. Stunlock's example: 10:1:1,30:0:1,60:0:1,120:0:1,180:0:1,240:0:1,360:0:1,720:0:1,1440:0:1,2880:0:1,52560000:99:0",
  }),
  vset("HOST_SETTINGS_CompressSaveFiles", "Compress save files", "Server", "bool", true, {
    help: "Off trades disk space for less hitching during an autosave.",
  }),
  vset("HOST_SETTINGS_ServerFps", "Server tick rate (FPS)", "Server", "int", 30, {
    min: 1,
    max: 60,
    help: "30 is plenty for casual play; 60 suits intense PvP at higher CPU use.",
  }),
  vset("HOST_SETTINGS_LowerFPSWhenEmpty", "Lower tick rate when empty", "Server", "bool", false),
  vset("HOST_SETTINGS_LowerFPSWhenEmptyValue", "Empty-server tick rate (FPS)", "Server", "int", 1, {
    min: 1,
    max: 60,
  }),
  vset("HOST_SETTINGS_GameSettingsPreset", "Game settings preset", "Server", "string", "", {
    help: "A preset name (e.g. StandardPvP) from VRisingServer_Data/StreamingAssets/GameSettingPresets (custom files there work too). Applied before the difficulty preset, so any setting both define comes from the difficulty preset.",
  }),
  vset("HOST_SETTINGS_GameDifficultyPreset", "Difficulty preset", "Server", "enum", "", {
    choices: [
      { value: "", label: "None" },
      ...gchoices(["Difficulty_Easy", "Difficulty_Normal", "Difficulty_Brutal"]),
    ],
    help: "Applied after the game settings preset, so it wins wherever both define the same setting.",
  }),
];

export const VRISING_CATALOG: SettingsCatalog = { game: Game.VRISING, version: "1", settings };
