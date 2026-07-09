import { Game, SettingTarget, type SettingsCatalog, type SettingDef } from "@ark/shared";

/**
 * BeamMP catalog. The rouhim image is env-driven — every setting targets `Env`
 * and buildBeammpSpec passes it through (key = env var name).
 *
 * First-class fields the orchestrator owns (server name, slots, port, the level
 * via the map field, and the mandatory AuthKey via the admin-password field) are
 * NOT here. No RCON, no query; the image doesn't expose BeamMP's join password —
 * keep the server Private for invite-only play.
 */
function bset(
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
  bset("BEAMMP_PRIVATE", "Private (hide from server browser)", "Session", "bool", true, {
    help: "Hidden servers are joined via the BeamMP launcher's Direct Connect. The AuthKey is required either way.",
  }),
  bset("BEAMMP_DESCRIPTION", "Server description", "Session", "string", "Hosted by Palisade"),
  bset("BEAMMP_MAX_CARS", "Max vehicles per player", "Session", "int", 1, {
    min: 1,
    max: 20,
    help: "Physics run on the clients — high car counts tax the PLAYERS' machines, not the server.",
  }),
  bset("BEAMMP_DEBUG", "Debug logging", "Session", "bool", false),
];

export const BEAMMP_CATALOG: SettingsCatalog = { game: Game.BEAMMP, version: "1", settings };
