/** Which game an instance runs. */
export enum Game {
  /** ARK: Survival Ascended — Windows binary via Proton, CurseForge mods. */
  ASA = "ASA",
  /** ARK: Survival Evolved — native Linux, Steam Workshop mods. */
  ASE = "ASE",
  /** Conan Exiles (Enhanced) — native Linux, Steam Workshop mods. */
  CONAN = "CONAN",
}

/** Friendly game names for the UI. */
export const GAME_LABELS: Record<Game, string> = {
  [Game.ASA]: "ARK: Survival Ascended",
  [Game.ASE]: "ARK: Survival Evolved",
  [Game.CONAN]: "Conan Exiles",
};

/** SteamCMD app IDs for the dedicated server (anonymous login). */
export const STEAM_APP_ID: Record<Game, number> = {
  [Game.ASA]: 2430930,
  [Game.ASE]: 376030,
  [Game.CONAN]: 443030,
};

/** Steam Workshop "consumer" app id used for ASE mod downloads. */
export const ASE_WORKSHOP_APP_ID = 346110;

/**
 * Per-game icons (Steam store headers — stable CDN URLs). Used for the spawned
 * containers' Unraid icon label and anywhere the UI wants a game badge.
 */
export const GAME_ICONS: Record<Game, string> = {
  [Game.ASA]: "https://cdn.cloudflare.steamstatic.com/steam/apps/2399830/header.jpg",
  [Game.ASE]: "https://cdn.cloudflare.steamstatic.com/steam/apps/346110/header.jpg",
  [Game.CONAN]: "https://cdn.cloudflare.steamstatic.com/steam/apps/440900/header.jpg",
};

/** CurseForge numeric game id for ASA (used by the mod browser). */
export const ASA_CURSEFORGE_GAME_ID = 83374;

/** Default port offsets within a per-server allocation block. */
export interface PortSet {
  game: number; // UDP, players connect here
  rawSocket: number; // UDP, game + 1 (only used with ?bRawSockets)
  query: number; // UDP, Steam query (vestigial on ASA — verify, see PLANNING.md)
  rcon: number; // TCP, internal management
}

export const DEFAULT_PORTS: PortSet = {
  game: 7777,
  rawSocket: 7778,
  query: 27015,
  rcon: 27020,
};

/** Official ASA maps known at build time (mod maps are added dynamically). */
export const ASA_OFFICIAL_MAPS = [
  "TheIsland_WP",
  "ScorchedEarth_WP",
  "TheCenter_WP",
  "Ragnarok_WP",
  "Aberration_WP",
  "Extinction_WP",
  "Valguero_WP",
  "Astraeos_WP",
  "LostColony_WP",
  "BobsMissions_WP",
] as const;

export const ASE_OFFICIAL_MAPS = [
  "TheIsland",
  "TheCenter",
  "ScorchedEarth_P",
  "Aberration_P",
  "Extinction",
  "Valguero_P",
  "Genesis",
  "CrystalIsles",
  "Gen2",
  "LostIsland",
  "Fjordur",
  "Ragnarok",
] as const;

/** Conan Exiles maps. Exiled Lands is the base game; Isle of Siptah is a DLC map. */
export const CONAN_OFFICIAL_MAPS = ["ConanSandbox"] as const;

/** Friendly display names for known level names (raw level → label). */
export const MAP_LABELS: Record<string, string> = {
  // Conan Exiles
  ConanSandbox: "Exiled Lands",
  // ASA (World Partition — *_WP)
  TheIsland_WP: "The Island",
  TheCenter_WP: "The Center",
  ScorchedEarth_WP: "Scorched Earth",
  Aberration_WP: "Aberration",
  Extinction_WP: "Extinction",
  Ragnarok_WP: "Ragnarok",
  Valguero_WP: "Valguero",
  Astraeos_WP: "Astraeos",
  LostColony_WP: "Lost Colony",
  BobsMissions_WP: "Club ARK",
  // ASE
  TheIsland: "The Island",
  TheCenter: "The Center",
  ScorchedEarth_P: "Scorched Earth",
  Aberration_P: "Aberration",
  Extinction: "Extinction",
  Valguero_P: "Valguero",
  Genesis: "Genesis: Part 1",
  CrystalIsles: "Crystal Isles",
  Gen2: "Genesis: Part 2",
  LostIsland: "Lost Island",
  Fjordur: "Fjordur",
  Ragnarok: "Ragnarok",
  Aquatica: "Aquatica",
  PGARK: "Procedurally Generated",
};

/**
 * Human-readable label for a map level name. Falls back gracefully for unknown
 * or modded maps by dropping the _WP/_P suffix and spacing out CamelCase, so
 * e.g. "TheIsland_WP" → "The Island" and "MyCoolMap_WP" → "My Cool Map".
 */
export function mapLabel(raw: string | null | undefined): string {
  if (!raw) return "";
  if (MAP_LABELS[raw]) return MAP_LABELS[raw];
  const base = raw.replace(/_WP$|_P$/i, "");
  return base.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ").trim();
}
