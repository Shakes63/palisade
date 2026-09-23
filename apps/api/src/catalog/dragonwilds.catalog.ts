import { Game, SettingTarget, type SettingsCatalog, type SettingDef } from "@ark/shared";

/**
 * RuneScape: Dragonwilds catalog. The server has no gameplay settings of its own
 * (difficulty, XP, PvP and world type are picked in-client when a world is
 * created), so this is the short list of knobs the ferment9348 image and the
 * engine accept. First-class fields (server name, owner id via the admin slot,
 * world password, max players, port) are NOT here.
 */
function dwset(
  key: string,
  label: string,
  category: string,
  type: SettingDef["type"],
  def: SettingDef["default"],
  extra: Partial<SettingDef> = {},
): SettingDef {
  return { key, label, category, target: SettingTarget.Env, type, default: def, emitAs: key, ...extra };
}

/** Engine CVar behind the autosave timer (default 5 min); passed as a launch arg. */
export const DRAGONWILDS_AUTOSAVE_KEY = "AUTOSAVE_MINUTES";
/** Appended verbatim to the launch line. */
export const DRAGONWILDS_EXTRA_ARGS_KEY = "GAME_PARAMS_EXTRA";

const settings: SettingDef[] = [
  dwset("WORLD_NAME", "World name", "World", "string", "MyWorld", {
    help: "Names the world the server creates on first start and its save file. This is what players search for under Worlds → Public (case-sensitive, max 16 characters). Changing it later loads a different world; the old save stays on disk.",
  }),
  dwset(DRAGONWILDS_AUTOSAVE_KEY, "Autosave interval", "World", "int", 5, {
    unit: "min",
    min: 1,
    max: 60,
    help: "Stopping the server does NOT save — only this timer and a player's in-game quit do. A stop loses whatever happened since the last autosave, so 1–2 minutes is a sensible choice.",
  }),
  dwset(DRAGONWILDS_EXTRA_ARGS_KEY, "Extra launch arguments", "Advanced", "string", "", {
    advanced: true,
    help: "Appended to the server command line as-is.",
  }),
];

export const DRAGONWILDS_CATALOG: SettingsCatalog = { game: Game.DRAGONWILDS, version: "1", settings };
