import { Game, SettingTarget, type SettingsCatalog, type SettingDef } from "@ark/shared";

/**
 * Minecraft Bedrock catalog. The itzg/minecraft-bedrock-server image writes
 * server.properties from env vars (UPPER_SNAKE_CASE of each property), so every
 * setting targets `Env` and the runtime spec passes it through. First-class fields
 * the orchestrator owns (server name/MOTD, max players, ports, EULA, world type via
 * the map field, LEVEL_NAME) are NOT here. Bedrock has no RCON.
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
  // ── Server ───────────────────────────────────────────────────────────────────
  bset("VERSION", "Game version", "Server", "string", "LATEST", {
    help: 'Bedrock version, e.g. "1.21.51". Use LATEST for the newest release.',
  }),
  bset("ONLINE_MODE", "Xbox Live auth (online mode)", "Server", "bool", true, {
    help: "Require players to be signed in to Xbox Live. Turn OFF only for LAN/offline (uncommon on Bedrock).",
  }),
  bset("ALLOW_LIST", "Use allow-list (whitelist)", "Server", "bool", false, {
    help: "Only players on the allow-list may join. Manage the list in-game with /allowlist.",
  }),
  bset("DEFAULT_PLAYER_PERMISSION_LEVEL", "Default permission level", "Server", "enum", "member", {
    choices: [
      { value: "visitor", label: "Visitor" },
      { value: "member", label: "Member" },
      { value: "operator", label: "Operator" },
    ],
    help: "Permission level new players get on first join.",
  }),

  // ── Gameplay ─────────────────────────────────────────────────────────────────
  bset("GAMEMODE", "Game mode", "Gameplay", "enum", "survival", {
    choices: [
      { value: "survival", label: "Survival" },
      { value: "creative", label: "Creative" },
      { value: "adventure", label: "Adventure" },
    ],
    help: "Default game mode for players who join.",
  }),
  bset("DIFFICULTY", "Difficulty", "Gameplay", "enum", "easy", {
    choices: [
      { value: "peaceful", label: "Peaceful" },
      { value: "easy", label: "Easy" },
      { value: "normal", label: "Normal" },
      { value: "hard", label: "Hard" },
    ],
    help: "World difficulty.",
  }),
  bset("ALLOW_CHEATS", "Allow cheats", "Gameplay", "bool", false, {
    help: "Enable commands / cheats on the world.",
  }),
  bset("LEVEL_SEED", "World seed", "Gameplay", "string", "", {
    help: "Seed for world generation. Leave blank for a random world.",
  }),

  // ── World / performance ──────────────────────────────────────────────────────
  bset("VIEW_DISTANCE", "View distance", "World", "int", 10, {
    min: 3,
    max: 32,
    unit: "chunks",
    help: "How many chunks are sent to players. Higher = more to see, heavier on the server.",
  }),
  bset("TICK_DISTANCE", "Simulation distance", "World", "int", 4, {
    min: 4,
    max: 12,
    unit: "chunks",
    help: "How many chunks around players are actively simulated.",
  }),
  bset("PLAYER_IDLE_TIMEOUT", "Idle kick timeout", "World", "int", 30, {
    min: 0,
    max: 120,
    unit: "min",
    help: "Kick players idle for this many minutes (0 = never).",
  }),
  bset("TEXTUREPACK_REQUIRED", "Require server texture pack", "World", "bool", false, {
    help: "Force clients to use the server's resource pack.",
  }),
];

export const BEDROCK_CATALOG: SettingsCatalog = { game: Game.BEDROCK, version: "1", settings };
