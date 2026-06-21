import { Game, SettingTarget, type SettingsCatalog, type SettingDef } from "@ark/shared";

/**
 * Conan Exiles catalog. Unlike ARK, the Conan image (acekorneya/conan_enhanced_
 * server) writes ServerSettings.ini / Engine.ini / Game.ini itself from env vars,
 * so every setting here targets `Env` and the runtime spec passes it through as an
 * env var (key = env var name). First-class fields (name, passwords, max players,
 * ports, RCON, mods) are handled by the orchestrator, not here. Starter subset —
 * the raw passthrough covers anything not yet listed.
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

const settings: SettingDef[] = [
  cset("COMMUNITY", "Server type", "General", "enum", "0", {
    choices: [
      { value: "0", label: "Purist" },
      { value: "1", label: "Relaxed" },
      { value: "2", label: "Hardcore" },
      { value: "3", label: "Experimental" },
    ],
    help: "Conan's server-community category shown in the browser.",
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
    help: "Region the server advertises in the in-game server browser.",
  }),
  cset("SERVER_MESSAGE_OF_THE_DAY", "Message of the day", "General", "string", "", {
    help: "Shown to players when they join.",
  }),
  cset("PVP_ENABLED", "PvP enabled", "Rules", "bool", true),
  cset("MAX_NUDITY", "Max nudity", "Rules", "enum", "0", {
    choices: [
      { value: "0", label: "None" },
      { value: "1", label: "Partial" },
      { value: "2", label: "Full" },
    ],
  }),
  cset("ENABLE_BATTLEYE", "BattlEye anti-cheat", "Rules", "bool", true),
  cset("XP_RATE_MULTIPLIER", "XP rate ×", "Progression", "float", 1.0, { min: 0.1, max: 100, step: 0.1 }),
  cset("HARVEST_AMOUNT_MULTIPLIER", "Harvest amount ×", "Progression", "float", 1.0, { min: 0.1, max: 100, step: 0.1 }),
  cset("CRAFTING_COST_MULTIPLIER", "Crafting cost ×", "Progression", "float", 1.0, { min: 0.1, max: 10, step: 0.1 }),
  cset("ITEM_SPOIL_RATE_SCALE", "Item spoil rate ×", "Survival", "float", 1.0, { min: 0, max: 10, step: 0.1 }),
  cset("FUEL_BURN_TIME_MULTIPLIER", "Fuel burn time ×", "Survival", "float", 1.0, { min: 0.1, max: 10, step: 0.1 }),
  cset("DAY_CYCLE_SPEED_SCALE", "Day cycle speed ×", "World", "float", 1.0, { min: 0.1, max: 10, step: 0.1 }),
  cset("NPC_RESPAWN_MULTIPLIER", "NPC respawn ×", "World", "float", 1.0, { min: 0.1, max: 10, step: 0.1 }),
  cset("CLAN_MAX_SIZE", "Max clan size", "Clans", "int", 10, { min: 1, max: 100 }),
];

export const CONAN_CATALOG: SettingsCatalog = { game: Game.CONAN, version: "1", settings };
