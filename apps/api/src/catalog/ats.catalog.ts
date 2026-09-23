import { Game, SettingTarget, type SettingsCatalog, type SettingDef } from "@ark/shared";

/**
 * American Truck Simulator catalog. The dedicated server has no env-var interface —
 * everything lives in `server_config.sii` inside the game's save dir (seeded by the
 * ich777 image's bundled template on FIRST boot, so it can't be pre-written; once
 * present, patchAtsServerConfig patches it before every start). Keys here are the
 * sii attribute names, patched 1:1.
 *
 * First-class fields the orchestrator owns (lobby_name, password, max_players,
 * connection/query ports) are NOT here. No RCON. The world/DLC set comes from the
 * server_packages export — replaceable via the saves-upload flow.
 */
function aset(
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
  // ── Version ──────────────────────────────────────────────────────────────────
  // Steam branch of the dedicated server. noEmit: it builds GAME_ID (buildAtsSpec),
  // it's not a server_config.sii key. Dropdown from the app's Steam branches.
  aset("STEAM_BRANCH", "Game version", "Version", "string", "public", {
    noEmit: true,
    optionsSource: "game-versions",
    help: "Which Steam branch/version of the dedicated server to install. Public is the current release; specific game versions (e.g. 1.53.x) are also offered. Changing it re-downloads the game on the next start.",
  }),
  // ── Session ───────────────────────────────────────────────────────────────────
  aset("description", "Server description", "Session", "string", "", {
    help: "Session description shown to players, up to 63 characters.",
  }),
  aset("welcome_message", "Welcome message", "Session", "string", "", {
    help: "Message players see when they join, up to 127 characters.",
  }),
  aset("mods_optioning", "Allow optional mods", "Session", "bool", false, {
    help: "Players may join with mods the session host doesn't run.",
  }),
  aset("server_logon_token", "Steam logon token", "Session", "string", "", {
    help: "Optional Game Server Login Token (steamcommunity.com/dev/managegameservers, app 270880) for a persistent server identity.",
  }),

  // ── Gameplay ──────────────────────────────────────────────────────────────────
  aset("player_damage", "Player collision damage", "Gameplay", "bool", true, {
    help: "Players take damage from collisions with other players.",
  }),
  aset("force_speed_limiter", "Force speed limiter", "Gameplay", "bool", false, {
    help: "Forces the truck speed limiter on for every player.",
  }),
  aset("timezones", "Timezone simulation", "Gameplay", "int", 0, {
    min: 0,
    max: 2,
    help: "0 off, 1 in-game local time, 2 real timezones.",
  }),
  aset("name_tags", "Show name tags", "Gameplay", "bool", true, {
    help: "Shows player name tags above vehicles.",
  }),
  aset("hide_in_company", "Ghost players in company areas", "Gameplay", "bool", false, {
    help: "Hides remote players while they are inside a company area.",
  }),
  aset("hide_colliding", "Ghost colliding vehicles", "Gameplay", "bool", true, {
    help: "Hides a vehicle that would collide with another right after it teleports.",
  }),
  aset("service_no_collision", "No collision at services", "Gameplay", "bool", false, {
    help: "Turns off collisions in service areas.",
  }),
  aset("in_menu_ghosting", "Ghost players in menu", "Gameplay", "bool", false, {
    help: "Turns off collisions for a player while their game is paused.",
  }),

  // ── Traffic ───────────────────────────────────────────────────────────────────
  aset("traffic", "AI traffic", "Traffic", "bool", true, {
    help: "Enables AI traffic on the roads.",
  }),
  aset("max_vehicles_total", "Max vehicles total", "Traffic", "int", 100, { min: 0, max: 512 }),
  aset("max_ai_vehicles_player", "Max AI vehicles per player", "Traffic", "int", 50, {
    min: 0,
    max: 256,
  }),
  aset("max_ai_vehicles_player_spawn", "Max AI spawns per player", "Traffic", "int", 50, {
    min: 0,
    max: 256,
  }),
];

export const ATS_CATALOG: SettingsCatalog = { game: Game.ATS, version: "1", settings };

/** ETS2 shares ATS's engine and the exact same server_config.sii surface. */
export const ETS2_CATALOG: SettingsCatalog = { game: Game.ETS2, version: "1", settings };
