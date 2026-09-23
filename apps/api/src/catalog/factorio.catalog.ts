import { Game, SettingTarget, type SettingsCatalog, type SettingDef } from "@ark/shared";

/**
 * Factorio catalog. Most keys are `server-settings.json` fields, merge-patched
 * into the config bind by patchFactorioSettings before each start (the image
 * seeds the example file; unknown/other keys are preserved). The two
 * FACTORIO_ENV_KEYS are image env vars instead. The dotted visibility keys nest
 * into the `visibility` object.
 *
 * First-class fields the orchestrator owns (name, game password, slots, port,
 * RCON password via config/rconpw, map-gen preset via the map field) are NOT here.
 */
function fset(
  key: string,
  label: string,
  category: string,
  type: SettingDef["type"],
  def: SettingDef["default"],
  extra: Partial<SettingDef> = {},
): SettingDef {
  return { key, label, category, target: SettingTarget.Env, type, default: def, emitAs: key, ...extra };
}

/** Catalog keys that are image env vars, not server-settings.json fields. */
export const FACTORIO_ENV_KEYS = new Set(["UPDATE_MODS_ON_START", "DLC_SPACE_AGE"]);

const settings: SettingDef[] = [
  // ── Visibility ────────────────────────────────────────────────────────────────
  fset("visibility.public", "List on the public server browser", "Visibility", "bool", false, {
    help: "Requires the factorio.com username + token below.",
  }),
  fset("visibility.lan", "Visible on LAN", "Visibility", "bool", true),
  fset("description", "Server description", "Visibility", "string", "Hosted by Palisade"),
  fset("require_user_verification", "Require factorio.com login", "Visibility", "bool", true, {
    help: "Verify joining players against factorio.com. Turn OFF for pure-LAN play without accounts.",
  }),
  fset("username", "Factorio.com username", "Visibility", "string", "", {
    help: "Needed for public listing and mod downloads.",
  }),
  fset("token", "Factorio.com token", "Visibility", "string", "", {
    help: "From factorio.com/profile (not your password).",
  }),

  // ── Gameplay ──────────────────────────────────────────────────────────────────
  fset("auto_pause", "Pause when empty", "Gameplay", "bool", true),
  fset("afk_autokick_interval", "AFK autokick", "Gameplay", "int", 0, {
    unit: "min",
    min: 0,
    max: 240,
    help: "0 disables.",
  }),
  fset("only_admins_can_pause_the_game", "Only admins can pause", "Gameplay", "bool", true),

  // ── Saves ─────────────────────────────────────────────────────────────────────
  fset("autosave_interval", "Autosave interval", "Saves", "int", 10, { unit: "min", min: 1, max: 120 }),
  fset("autosave_slots", "Autosave slots", "Saves", "int", 5, { min: 1, max: 50 }),
  fset("non_blocking_saving", "Non-blocking saving", "Saves", "bool", false, {
    help: "Fork-based autosaves (no pause) — experimental, needs spare RAM.",
  }),

  // ── Mods / DLC (image) ────────────────────────────────────────────────────────
  fset("UPDATE_MODS_ON_START", "Update mods on start", "Mods", "bool", false, {
    help: "Updates everything in the mods folder via the mod portal — needs the factorio.com credentials above.",
  }),
  fset("DLC_SPACE_AGE", "Space Age DLC mods", "Mods", "bool", true, {
    help: "Enable the built-in Space Age mods. Turn OFF if players run the base game only.",
  }),
];

export const FACTORIO_CATALOG: SettingsCatalog = { game: Game.FACTORIO, version: "1", settings };
