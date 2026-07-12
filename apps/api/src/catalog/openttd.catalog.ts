import { Game, SettingTarget, type SettingsCatalog, type SettingDef } from "@ark/shared";

/**
 * OpenTTD catalog. Settings are rendered into openttd.cfg by the config-writer, which
 * routes each into the right [section] using emitAs="<section>.<key>". First-class fields
 * (server name, passwords, ports, max clients, landscape/map) are handled by the renderer
 * itself, not here.
 */
function oset(
  key: string,
  label: string,
  category: string,
  section: string,
  cfgKey: string,
  type: SettingDef["type"],
  def: SettingDef["default"],
  extra: Partial<SettingDef> = {},
): SettingDef {
  return {
    key,
    label,
    category,
    target: SettingTarget.Env,
    emitAs: `${section}.${cfgKey}`,
    type,
    default: def,
    ...extra,
  };
}

// OpenTTD map dimensions are stored as log2 of the tile count.
const MAP_SIZES = [
  { value: "8", label: "256 tiles" },
  { value: "9", label: "512 tiles" },
  { value: "10", label: "1024 tiles" },
  { value: "11", label: "2048 tiles" },
];

const settings: SettingDef[] = [
  // ── Version ──────────────────────────────────────────────────────────────────
  // Not an openttd.cfg key: the ich777 image reads GAME_VERSION from the env to
  // install a specific OpenTTD build. noEmit keeps the cfg renderer from writing it;
  // buildOpenttdSpec reads it. Dropdown populated from OpenTTD's GitHub releases.
  {
    key: "GAME_VERSION",
    label: "Game version",
    category: "Version",
    target: SettingTarget.Env,
    emitAs: "GAME_VERSION",
    type: "string",
    default: "latest",
    noEmit: true,
    optionsSource: "game-versions",
    help: 'Which OpenTTD version to install, e.g. "15.3". Use latest for the newest stable release. Changing it re-downloads the game on the next start.',
  },
  // ── Network ──────────────────────────────────────────────────────────────────
  oset("server_game_type", "Server visibility", "Network", "network", "server_game_type", "enum", "public", {
    choices: [
      { value: "local", label: "Unlisted (join by IP only)" },
      { value: "public", label: "Public (listed in the server browser)" },
      { value: "invite_only", label: "Invite-only" },
    ],
    help: "Whether the server advertises itself to the public OpenTTD server list.",
  }),
  oset("max_companies", "Max companies", "Network", "network", "max_companies", "int", 15, {
    min: 1,
    max: 15,
    step: 1,
    help: "How many companies can exist on the server at once.",
  }),
  oset("autoclean_companies", "Auto-clean idle companies", "Network", "network", "autoclean_companies", "bool", false, {
    help: "Automatically remove a company after its owner has been gone for a while.",
  }),

  // ── World ────────────────────────────────────────────────────────────────────
  oset("starting_year", "Starting year", "World", "game_creation", "starting_year", "int", 1950, {
    min: 1920,
    max: 2050,
    step: 1,
    help: "The calendar year the game world starts in.",
  }),
  oset("map_x", "Map width", "World", "game_creation", "map_x", "enum", "8", {
    choices: MAP_SIZES,
    help: "Map width. Bigger maps need more RAM and CPU.",
  }),
  oset("map_y", "Map height", "World", "game_creation", "map_y", "enum", "8", {
    choices: MAP_SIZES,
    help: "Map height.",
  }),

  // ── Difficulty ───────────────────────────────────────────────────────────────
  oset("max_no_competitors", "AI competitors", "Difficulty", "difficulty", "max_no_competitors", "int", 0, {
    min: 0,
    max: 15,
    step: 1,
    help: "Number of computer-controlled opponent companies.",
  }),
];

export const OPENTTD_CATALOG: SettingsCatalog = {
  game: Game.OPENTTD,
  version: "1",
  settings,
};
