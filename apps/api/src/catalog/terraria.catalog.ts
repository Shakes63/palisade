import { Game, SettingTarget, type SettingsCatalog, type SettingDef } from "@ark/shared";

/**
 * Terraria (TShock) catalog. Two kinds of settings share the catalog:
 * - the TERRARIA_CLI_KEYS are world-CREATION launch args (only affect a new
 *   world) — buildTerrariaSpec turns them into -difficulty/-seed flags;
 * - everything else is a TShock `Settings` key, merged into the config.json in
 *   the worlds bind by patchTShockConfig before each start (TShock rewrites the
 *   file with its full defaults on boot, so only our keys are pinned).
 *
 * First-class fields the orchestrator owns (server name, slots, join password,
 * port, REST token) are NOT here. The console is stdin-only (hidden).
 */
function tset(
  key: string,
  label: string,
  category: string,
  type: SettingDef["type"],
  def: SettingDef["default"],
  extra: Partial<SettingDef> = {},
): SettingDef {
  return { key, label, category, target: SettingTarget.Env, type, default: def, emitAs: key, ...extra };
}

/** Catalog keys that are world-creation launch args, not TShock config keys. */
export const TERRARIA_CLI_KEYS: Record<string, string> = {
  TERRARIA_DIFFICULTY: "-difficulty",
  TERRARIA_SEED: "-seed",
};

const settings: SettingDef[] = [
  // ── World creation (new worlds only) ─────────────────────────────────────────
  tset("TERRARIA_DIFFICULTY", "World difficulty", "World creation", "enum", "0", {
    choices: [
      { value: "0", label: "Classic" },
      { value: "1", label: "Expert" },
      { value: "2", label: "Master" },
      { value: "3", label: "Journey" },
    ],
    help: "Applies when the world is CREATED (first start); an existing world keeps its difficulty.",
  }),
  tset("TERRARIA_SEED", "World seed", "World creation", "string", "", {
    help: "Seed for a NEW world. Empty = random.",
  }),

  // ── Gameplay (TShock) ─────────────────────────────────────────────────────────
  tset("PvPMode", "PvP mode", "Gameplay", "enum", "normal", {
    choices: [
      { value: "normal", label: "Player choice" },
      { value: "always", label: "Always on" },
      { value: "disabled", label: "Disabled" },
    ],
  }),
  tset("SpawnProtection", "Spawn protection", "Gameplay", "bool", true, {
    help: "Block building/destruction around the spawn point.",
  }),
  tset("SpawnProtectionRadius", "Spawn protection radius", "Gameplay", "int", 10, {
    min: 1,
    max: 100,
  }),
  tset("EnableWhitelist", "IP whitelist", "Gameplay", "bool", false, {
    help: "Only whitelisted IPs may join (tshock/whitelist.txt).",
  }),

  // ── Saves ─────────────────────────────────────────────────────────────────────
  tset("AnnounceSave", "Announce world saves", "Saves", "bool", true),
  tset("BackupInterval", "TShock backup interval", "Saves", "int", 10, {
    unit: "min",
    min: 0,
    max: 240,
    help: "TShock's own rolling world backups (inside the worlds volume). 0 disables.",
  }),
];

export const TERRARIA_CATALOG: SettingsCatalog = { game: Game.TERRARIA, version: "1", settings };
