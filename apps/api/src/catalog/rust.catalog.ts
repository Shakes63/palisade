import { Game, SettingTarget, type SettingsCatalog, type SettingDef } from "@ark/shared";

/**
 * Rust catalog. The didstopia image is env-driven — every setting targets `Env`
 * and buildRustSpec passes it through (key = env var name). This image expects
 * booleans as "1"/"0" (handled by the spec builder); empty values are dropped.
 *
 * First-class fields the orchestrator owns (server name, slots, ports, RCON
 * password, world size via the repurposed map field) are NOT here. Vanilla Rust
 * has no join password.
 */
function rset(
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
  // ── World ─────────────────────────────────────────────────────────────────────
  rset("RUST_SERVER_SEED", "Map seed", "World", "string", "12345", {
    help: "Integer seed for the procedural map. Changing it after the first boot regenerates the world on the next map wipe.",
  }),
  rset("RUST_SERVER_LEVELURL", "Custom map URL", "World", "string", "", {
    help: "URL of a custom .map file. When set, the seed and world size are ignored.",
  }),
  rset("RUST_SERVER_SAVE_INTERVAL", "Autosave interval", "World", "int", 600, {
    unit: "s",
    min: 60,
    max: 3600,
  }),

  // ── Listing ───────────────────────────────────────────────────────────────────
  rset("RUST_SERVER_DESCRIPTION", "Server description", "Listing", "string", "Hosted by Palisade"),
  rset("RUST_SERVER_URL", "Server website", "Listing", "string", ""),
  rset("RUST_SERVER_BANNER_URL", "Server banner image URL", "Listing", "string", ""),

  // ── Mods / updates ────────────────────────────────────────────────────────────
  rset("RUST_OXIDE_ENABLED", "Oxide / uMod modding", "Mods", "bool", false, {
    help: "Install the Oxide plugin framework on boot (plugins go in oxide/plugins inside the data dir).",
  }),
  rset("RUST_OXIDE_UPDATE_ON_BOOT", "Update Oxide on boot", "Mods", "bool", true),
  rset("RUST_UPDATE_CHECKING", "Auto-restart on game updates", "Mods", "bool", false, {
    help: "Checks for Rust updates while running, warns players, restarts to install.",
  }),
  rset("RUST_HEARTBEAT", "Heartbeat watchdog", "Mods", "bool", false, {
    help: "Force-quit the server if it stops answering queries (the manager's crash watchdog restarts it).",
  }),
];

export const RUST_CATALOG: SettingsCatalog = { game: Game.RUST, version: "1", settings };
