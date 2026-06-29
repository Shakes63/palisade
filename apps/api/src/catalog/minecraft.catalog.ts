import { Game, SettingTarget, type SettingsCatalog, type SettingDef } from "@ark/shared";

/**
 * Minecraft (Java) catalog. The itzg/minecraft-server image writes server.properties
 * from env vars, so every setting targets `Env` and the runtime spec passes it
 * through (key = env var name, e.g. DIFFICULTY, PVP, VIEW_DISTANCE). First-class
 * fields the orchestrator owns (server name/MOTD, max players, ports, RCON, EULA,
 * world type via the map field, memory) are NOT here.
 *
 * Categories map 1:1 to the MINECRAFT_GROUPS tabs in the web settings form.
 */
function mset(
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
  // ── Server (jar / build) ─────────────────────────────────────────────────────
  mset("TYPE", "Server type", "Server", "enum", "VANILLA", {
    choices: [
      { value: "VANILLA", label: "Vanilla (official)" },
      { value: "PAPER", label: "Paper (plugins, high performance)" },
      { value: "FABRIC", label: "Fabric (mods)" },
      { value: "FORGE", label: "Forge (mods)" },
      { value: "NEOFORGE", label: "NeoForge (mods)" },
      { value: "SPIGOT", label: "Spigot (plugins)" },
    ],
    help: "Which server flavour to run. Vanilla is the official server; Paper/Spigot add plugins; Fabric/Forge/NeoForge add mods. The image downloads the right jar on first boot.",
  }),
  mset("VERSION", "Game version", "Server", "string", "LATEST", {
    help: 'Minecraft version, e.g. "1.21.4". Use LATEST for the newest release. (For modded types, match the modpack\'s version.)',
  }),
  mset("ONLINE_MODE", "Online mode (auth)", "Server", "bool", true, {
    help: "Verify players against Mojang/Microsoft auth. Turn OFF only for offline/LAN or cracked clients — off lets anyone use any username.",
  }),
  mset("ENABLE_COMMAND_BLOCK", "Enable command blocks", "Server", "bool", false, {
    help: "Allow command blocks to run in the world.",
  }),

  // ── World ────────────────────────────────────────────────────────────────────
  mset("SEED", "World seed", "World", "string", "", {
    help: "Seed for world generation. Leave blank for a random world.",
  }),
  mset("GENERATE_STRUCTURES", "Generate structures", "World", "bool", true, {
    help: "Generate villages, temples, strongholds, etc.",
  }),
  mset("SPAWN_PROTECTION", "Spawn protection radius", "World", "int", 16, {
    min: 0,
    max: 256,
    unit: "blocks",
    help: "Radius around spawn that only operators can build in (0 disables it).",
  }),
  mset("VIEW_DISTANCE", "View distance", "World", "int", 10, {
    min: 3,
    max: 32,
    unit: "chunks",
    help: "How many chunks the server sends to players. Higher = more to see but heavier on CPU/RAM.",
  }),
  mset("ALLOW_NETHER", "Allow the Nether", "World", "bool", true, {
    help: "Let players travel to the Nether.",
  }),

  // ── Gameplay ─────────────────────────────────────────────────────────────────
  mset("MODE", "Game mode", "Gameplay", "enum", "survival", {
    choices: [
      { value: "survival", label: "Survival" },
      { value: "creative", label: "Creative" },
      { value: "adventure", label: "Adventure" },
      { value: "spectator", label: "Spectator" },
    ],
    help: "Default game mode for players who join.",
  }),
  mset("DIFFICULTY", "Difficulty", "Gameplay", "enum", "easy", {
    choices: [
      { value: "peaceful", label: "Peaceful (no hostile mobs)" },
      { value: "easy", label: "Easy" },
      { value: "normal", label: "Normal" },
      { value: "hard", label: "Hard" },
    ],
    help: "World difficulty.",
  }),
  mset("HARDCORE", "Hardcore", "Gameplay", "bool", false, {
    help: "Permadeath: dying switches the player to spectator. Forces Hard difficulty.",
  }),
  mset("PVP", "PvP", "Gameplay", "bool", true, {
    help: "Allow players to damage each other.",
  }),
  mset("FORCE_GAMEMODE", "Force game mode on join", "Gameplay", "bool", false, {
    help: "Reset players to the default game mode each time they log in.",
  }),
  mset("ALLOW_FLIGHT", "Allow flight", "Gameplay", "bool", false, {
    help: "Permit flight from mods/plugins in survival (anti-cheat otherwise kicks flying players). Creative flight is always allowed.",
  }),

  // ── Mobs ─────────────────────────────────────────────────────────────────────
  mset("SPAWN_MONSTERS", "Spawn monsters", "Mobs", "bool", true, {
    help: "Spawn hostile mobs (zombies, skeletons, …).",
  }),
  mset("SPAWN_ANIMALS", "Spawn animals", "Mobs", "bool", true, {
    help: "Spawn passive animals (cows, sheep, …).",
  }),
  mset("SPAWN_NPCS", "Spawn villagers", "Mobs", "bool", true, {
    help: "Spawn NPC villagers.",
  }),

  // ── Players ──────────────────────────────────────────────────────────────────
  mset("OPS", "Operators", "Players", "string", "", {
    help: "Comma-separated usernames to grant operator (admin) rights to.",
  }),
  mset("ENABLE_WHITELIST", "Enable whitelist", "Players", "bool", false, {
    help: "Only players on the whitelist may join.",
  }),
  mset("WHITELIST", "Whitelist", "Players", "string", "", {
    help: "Comma-separated usernames allowed to join (when the whitelist is enabled).",
  }),
];

export const MINECRAFT_CATALOG: SettingsCatalog = { game: Game.MINECRAFT, version: "1", settings };
