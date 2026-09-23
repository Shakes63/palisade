import { Game, SettingTarget, type SettingsCatalog, type SettingDef } from "@ark/shared";

/**
 * Satisfactory catalog. The wolveix image is env-driven — its wrapper script maps
 * env vars onto the server's launch options / Game.ini, so every setting targets
 * `Env` and buildSatisfactorySpec passes it through (key = env var name).
 *
 * First-class fields the orchestrator owns (server name via API claim, slots,
 * ports, admin + join passwords) are NOT here. Session settings that live in the
 * claimed server (autopause etc.) are managed from the in-game Server Manager.
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

const settings: SettingDef[] = [
  // ── World / saves ─────────────────────────────────────────────────────────────
  fset("AUTOSAVENUM", "Rotating autosaves kept", "World", "int", 5, { min: 1, max: 50 }),
  fset("DISABLESEASONALEVENTS", "Disable FICSMAS", "World", "bool", false, {
    help: "Turn off the seasonal FICSMAS event content.",
  }),

  // ── Performance ───────────────────────────────────────────────────────────────
  fset("MAXTICKRATE", "Max tick rate", "Performance", "int", 30, {
    min: 10,
    max: 120,
    help: "Server simulation tick rate. 30 is the game default; higher is smoother but heavier.",
  }),
  fset("MAXOBJECTS", "Object limit", "Performance", "int", 2162688, {
    min: 1000000,
    max: 10000000,
    help: "Unreal object cap — raise for megafactories (needs RAM to match).",
  }),
  fset("SERVERSTREAMING", "Asset streaming", "Performance", "bool", true, {
    help: "Stream assets on demand (less RAM). Off preloads everything.",
  }),
  fset("TIMEOUT", "Client timeout", "Performance", "int", 30, { unit: "s", min: 10, max: 300 }),

  // ── Updates / branch ──────────────────────────────────────────────────────────
  fset("STEAMBETA", "Experimental branch", "Updates", "bool", false, {
    help: "Run the Experimental game version instead of Early Access.",
  }),
  fset("SKIPUPDATE", "Skip update on start", "Updates", "bool", false, {
    help: "Don't check Steam for a game update when the server starts.",
  }),
];

export const SATISFACTORY_CATALOG: SettingsCatalog = {
  game: Game.SATISFACTORY,
  version: "1",
  settings,
};
