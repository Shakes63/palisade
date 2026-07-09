import { Game, SettingTarget, type SettingsCatalog, type SettingDef } from "@ark/shared";

/**
 * Project Zomboid catalog. The danixu86 image is env-driven — its start script
 * patches servertest.ini / applies the sandbox preset from env vars on boot, so
 * every setting targets `Env` and buildZomboidSpec passes it through (key = env
 * var name). Deliberately v1-scoped to the env vars the image actually reads;
 * the full servertest.ini / SandboxVars.lua surface (hundreds of keys) would
 * need file patching and is deferred.
 *
 * First-class fields the orchestrator owns (server name, slots, ports, admin +
 * join passwords, Workshop mods) are NOT here.
 */
function zset(
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
  zset("SERVERPRESET", "Sandbox preset", "World", "enum", "Apocalypse", {
    choices: [
      { value: "Apocalypse", label: "Apocalypse (default survival)" },
      { value: "Beginner", label: "Beginner" },
      { value: "Builder", label: "Builder (relaxed, base-building)" },
      { value: "FirstWeek", label: "First Week" },
      { value: "SixMonthsLater", label: "Six Months Later" },
      { value: "Survival", label: "Survival (classic)" },
      { value: "Survivor", label: "Survivor (combat-focused)" },
    ],
    help: "The sandbox ruleset the world is created with. Applies on FIRST boot only — an existing save keeps its preset unless 'Re-apply preset' is on.",
  }),
  zset("SERVERPRESETREPLACE", "Re-apply preset on start", "World", "bool", false, {
    help: "Overwrite the server's sandbox settings with the preset above on every start. Leave off to preserve custom in-game sandbox tweaks.",
  }),

  // ── Network / visibility ──────────────────────────────────────────────────────
  zset("PUBLIC", "Public server list", "Network", "bool", false, {
    help: "Advertise the server on the in-game public server browser. LAN/direct-connect players can join either way.",
  }),
  zset("STEAMVAC", "Steam VAC", "Network", "bool", true, {
    help: "Valve Anti-Cheat protection for the server.",
  }),
  zset("NOSTEAM", "Allow non-Steam clients", "Network", "bool", false, {
    help: "Run in non-Steam mode so non-Steam copies can join. Disables Workshop mod auto-download for clients.",
  }),

  // ── Performance ───────────────────────────────────────────────────────────────
  zset("MEMORY", "Java heap size", "Performance", "string", "4096m", {
    help: "JVM max heap (e.g. 2048m, 4096m, 8g). Raise for many players/mods; keep below the container RAM limit.",
  }),
];

export const ZOMBOID_CATALOG: SettingsCatalog = { game: Game.ZOMBOID, version: "1", settings };
