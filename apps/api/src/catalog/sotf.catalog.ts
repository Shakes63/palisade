import { Game, SettingTarget, type SettingsCatalog, type SettingDef } from "@ark/shared";

/**
 * Sons of the Forest catalog. The server has no env-var interface — everything
 * lives in userdata/dedicatedserver.cfg (JSON), which the manager renders on every
 * start (renderSotfConfig). Settings here map 1:1 onto the cfg's top-level keys,
 * except the two GS_ keys, which land inside the nested GameSettings object under
 * the game's dotted names (see SOTF_GAME_SETTINGS_KEYS).
 *
 * First-class fields the orchestrator owns (server name, slots, ports, join
 * password, GameMode from the map field) are NOT here. No RCON.
 */
function sset(
  key: string,
  label: string,
  category: string,
  type: SettingDef["type"],
  def: SettingDef["default"],
  extra: Partial<SettingDef> = {},
): SettingDef {
  return { key, label, category, target: SettingTarget.Env, type, default: def, emitAs: key, ...extra };
}

/** Catalog key → the dotted key inside the cfg's nested GameSettings object. */
export const SOTF_GAME_SETTINGS_KEYS: Record<string, string> = {
  GS_TreeRegrowth: "Gameplay.TreeRegrowth",
  GS_StructureDamage: "Structure.Damage",
};

const settings: SettingDef[] = [
  // ── World ─────────────────────────────────────────────────────────────────────
  sset("GS_TreeRegrowth", "Tree regrowth", "World", "bool", true, {
    help: "Cut trees regrow 10% each time you sleep.",
  }),
  sset("GS_StructureDamage", "Structure damage", "World", "bool", true, {
    help: "Whether structures can be damaged (enemies/explosives).",
  }),
  sset("SaveSlot", "Save slot", "World", "int", 1, {
    min: 1,
    max: 10,
    help: "Which save slot the server continues (a new slot starts a fresh world).",
  }),
  sset("SaveInterval", "Autosave interval", "World", "int", 600, { unit: "s", min: 60, max: 3600 }),

  // ── Network ───────────────────────────────────────────────────────────────────
  sset("LanOnly", "LAN only", "Network", "bool", false, {
    help: "Hide the server from the internet lobby list.",
  }),
  sset("SkipNetworkAccessibilityTest", "Skip reachability test", "Network", "bool", true, {
    help: "Skip the boot-time port-accessibility self-test (recommended behind NAT — the test often false-fails).",
  }),

  // ── Performance ───────────────────────────────────────────────────────────────
  sset("ActiveTargetFramerate", "Active tick rate", "Performance", "int", 60, {
    min: 10,
    max: 120,
    help: "Server framerate while players are online.",
  }),
  sset("IdleTargetFramerate", "Idle tick rate", "Performance", "int", 5, { min: 1, max: 60 }),
  sset("IdleDayCycleSpeed", "Idle day-cycle speed", "Performance", "float", 0, {
    min: 0,
    max: 1,
    step: 0.1,
    help: "0 freezes world time while the server is empty.",
  }),
];

export const SOTF_CATALOG: SettingsCatalog = { game: Game.SOTF, version: "1", settings };
