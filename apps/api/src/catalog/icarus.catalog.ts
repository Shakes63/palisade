import { Game, SettingTarget, type SettingsCatalog, type SettingDef } from "@ark/shared";

/**
 * Icarus catalog. The mornedhels/icarus-server image writes ServerSettings.ini from
 * env vars, so every setting targets `Env` and the runtime spec passes it through
 * (key = env var name). First-class fields the orchestrator owns (server name,
 * passwords, max players, ports) are NOT here. Icarus has no network RCON, so there
 * are no broadcast/save knobs. Booleans emit as True/False (the image's format).
 */
function iset(
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
  // ── Session ──────────────────────────────────────────────────────────────────
  iset("SERVER_RESUME_PROSPECT", "Resume last prospect on restart", "Session", "bool", true, {
    help: "When the server restarts, automatically resume the prospect (world) it was last running.",
  }),
  iset("SERVER_SHUTDOWN_IF_NOT_JOINED", "Return to lobby if unjoined", "Session", "int", 300, {
    min: 0,
    max: 3600,
    unit: "sec",
    help: "Seconds to wait for a player after a prospect loads before returning to the lobby (0 = never).",
  }),
  iset("SERVER_SHUTDOWN_IF_EMPTY", "Return to lobby when empty", "Session", "int", 60, {
    min: 0,
    max: 3600,
    unit: "sec",
    help: "Seconds after the last player leaves before returning to the lobby (0 = never).",
  }),

  // ── Permissions ──────────────────────────────────────────────────────────────
  iset("SERVER_ALLOW_NON_ADMINS_LAUNCH", "Non-admins can launch prospects", "Permissions", "bool", true, {
    help: "Let any player create/select the prospect (world) from the in-game lobby. Off = admins only.",
  }),
  iset("SERVER_ALLOW_NON_ADMINS_DELETE", "Non-admins can delete prospects", "Permissions", "bool", false, {
    help: "Let any player delete prospects from the lobby. Off = admins only.",
  }),
];

export const ICARUS_CATALOG: SettingsCatalog = { game: Game.ICARUS, version: "1", settings };
