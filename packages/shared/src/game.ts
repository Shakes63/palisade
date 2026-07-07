/** Which game an instance runs. */
export enum Game {
  /** ARK: Survival Ascended — Windows binary via Proton, CurseForge mods. */
  ASA = "ASA",
  /** ARK: Survival Evolved — native Linux, Steam Workshop mods. */
  ASE = "ASE",
  /** Conan Exiles (Enhanced) — native Linux, Steam Workshop mods. */
  CONAN = "CONAN",
  /** Palworld — native Linux, env-driven; RCON (no Workshop mods). */
  PALWORLD = "PALWORLD",
  /** Minecraft (Java) — itzg image, downloads the server jar itself; TCP, RCON. */
  MINECRAFT = "MINECRAFT",
  /** Icarus — mornedhels image (SteamCMD under Wine), env-driven; NO network RCON. */
  ICARUS = "ICARUS",
  /** Minecraft (Bedrock) — itzg bedrock image, env-driven; UDP; NO network RCON. */
  BEDROCK = "BEDROCK",
  /** Valheim — lloesche image (native Linux SteamCMD), env-driven; UDP; NO RCON. */
  VALHEIM = "VALHEIM",
  /** 7 Days to Die — vinanrra/LinuxGSM image; we render sdtdserver.xml; telnet console. */
  SEVEN_DAYS = "SEVEN_DAYS",
  /** Enshrouded — mornedhels image (SteamCMD under Proton), env-driven; UDP; NO RCON. */
  ENSHROUDED = "ENSHROUDED",
}

/** Friendly game names for the UI. */
export const GAME_LABELS: Record<Game, string> = {
  [Game.ASA]: "ARK: Survival Ascended",
  [Game.ASE]: "ARK: Survival Evolved",
  [Game.CONAN]: "Conan Exiles",
  [Game.PALWORLD]: "Palworld",
  [Game.MINECRAFT]: "Minecraft (Java)",
  [Game.ICARUS]: "Icarus",
  [Game.BEDROCK]: "Minecraft (Bedrock)",
  [Game.VALHEIM]: "Valheim",
  [Game.SEVEN_DAYS]: "7 Days to Die",
  [Game.ENSHROUDED]: "Enshrouded",
};

/** SteamCMD app IDs for the dedicated server (anonymous login). */
export const STEAM_APP_ID: Record<Game, number> = {
  [Game.ASA]: 2430930,
  [Game.ASE]: 376030,
  [Game.CONAN]: 443030,
  [Game.PALWORLD]: 2394010,
  // Minecraft isn't on Steam — the itzg image downloads the server jar from
  // Mojang/its build sources. This is only read by the ASA-only game-file cache,
  // so the value is unused for Minecraft.
  [Game.MINECRAFT]: 0,
  // Icarus dedicated server (the image installs it via SteamCMD under Wine).
  [Game.ICARUS]: 2089300,
  // Bedrock isn't on Steam — the itzg image downloads Mojang's Bedrock server. Unused.
  [Game.BEDROCK]: 0,
  // Valheim dedicated server (the lloesche image installs it via SteamCMD on boot).
  [Game.VALHEIM]: 896660,
  // 7 Days to Die dedicated server (LinuxGSM installs it via SteamCMD on boot).
  [Game.SEVEN_DAYS]: 294420,
  // Enshrouded dedicated server (the mornedhels image installs it via SteamCMD).
  [Game.ENSHROUDED]: 2278520,
};

/** Steam Workshop "consumer" app ids for mod downloads (ARK: Survival Evolved /
 *  Conan Exiles). ASA uses CurseForge instead, so it has no Workshop app id. */
export const ASE_WORKSHOP_APP_ID = 346110;
export const CONAN_WORKSHOP_APP_ID = 440900;

/** The Steam Workshop app id for a game, or undefined for CurseForge games (ASA).
 *  Doubles as the "is this a Workshop game?" check across the mods code. */
export function workshopAppId(game: Game): number | undefined {
  if (game === Game.ASE) return ASE_WORKSHOP_APP_ID;
  if (game === Game.CONAN) return CONAN_WORKSHOP_APP_ID;
  return undefined;
}

/**
 * Per-game icons (Steam store headers — stable CDN URLs). Used for the spawned
 * containers' Unraid icon label and anywhere the UI wants a game badge.
 */
export const GAME_ICONS: Record<Game, string> = {
  [Game.ASA]: "https://cdn.cloudflare.steamstatic.com/steam/apps/2399830/header.jpg",
  [Game.ASE]: "https://cdn.cloudflare.steamstatic.com/steam/apps/346110/header.jpg",
  [Game.CONAN]: "https://cdn.cloudflare.steamstatic.com/steam/apps/440900/header.jpg",
  [Game.PALWORLD]: "https://cdn.cloudflare.steamstatic.com/steam/apps/1623730/header.jpg",
  // Minecraft has no Steam page; use the Wikimedia logo thumbnail (cosmetic — a
  // 404 just falls back to Unraid's default container icon).
  [Game.MINECRAFT]:
    "https://upload.wikimedia.org/wikipedia/commons/thumb/8/85/Minecraft_2024_logo.svg/512px-Minecraft_2024_logo.svg.png",
  [Game.ICARUS]: "https://cdn.cloudflare.steamstatic.com/steam/apps/1149460/header.jpg",
  // Same Minecraft logo as the Java edition (cosmetic; a 404 just falls back).
  [Game.BEDROCK]:
    "https://upload.wikimedia.org/wikipedia/commons/thumb/8/85/Minecraft_2024_logo.svg/512px-Minecraft_2024_logo.svg.png",
  [Game.VALHEIM]: "https://cdn.cloudflare.steamstatic.com/steam/apps/892970/header.jpg",
  [Game.SEVEN_DAYS]: "https://cdn.cloudflare.steamstatic.com/steam/apps/251570/header.jpg",
  [Game.ENSHROUDED]: "https://cdn.cloudflare.steamstatic.com/steam/apps/1203620/header.jpg",
};

/** CurseForge numeric game id for ASA (used by the mod browser). */
export const ASA_CURSEFORGE_GAME_ID = 83374;

/** CurseForge numeric game id for Minecraft, and the "Modpacks" class id — the
 *  Minecraft mods tab browses modpacks (itzg installs them via AUTO_CURSEFORGE). */
export const MINECRAFT_CURSEFORGE_GAME_ID = 432;
export const MINECRAFT_CURSEFORGE_MODPACK_CLASS_ID = 4471;

/** CurseForge game id + (optional) class id for a game's mod browser, or undefined
 *  for non-CurseForge games. ASA browses all classes; Minecraft browses modpacks. */
export function curseforgeBrowse(game: Game): { gameId: number; classId?: number } | undefined {
  if (game === Game.ASA) return { gameId: ASA_CURSEFORGE_GAME_ID };
  if (game === Game.MINECRAFT)
    return { gameId: MINECRAFT_CURSEFORGE_GAME_ID, classId: MINECRAFT_CURSEFORGE_MODPACK_CLASS_ID };
  return undefined;
}

/**
 * Rough expected RAM (MB) for a populated server of each game — used by the start
 * guard to warn before a start would exceed free host RAM. Grounded in real usage
 * (ASA is by far the heaviest; two of them OOM'd a 32 GB box). A server's own
 * ramLimitMb, when set, overrides this estimate.
 */
export const RAM_ESTIMATE_MB: Record<Game, number> = {
  [Game.ASA]: 16000,
  [Game.ASE]: 7000,
  [Game.CONAN]: 7000,
  [Game.PALWORLD]: 8000,
  // Vanilla Java is light (~2-3 GB); modpacks run heavier. 4 GB is a safe headroom
  // estimate for the start guard — a server's own ramLimitMb overrides it.
  [Game.MINECRAFT]: 4000,
  // Icarus is heavy (RocketWerkz recommend 16 GB); 12 GB is a realistic populated
  // estimate for the start guard.
  [Game.ICARUS]: 12000,
  // Bedrock is a lightweight native server (~1-2 GB even populated).
  [Game.BEDROCK]: 2000,
  // Valheim is light — ~2-4 GB for a populated world.
  [Game.VALHEIM]: 3000,
  // 7 Days to Die is fairly heavy (Unity + RWG) — ~5-8 GB populated.
  [Game.SEVEN_DAYS]: 6000,
  // Enshrouded is heavy (mornedhels recommend 16 GB) — 8 GB is a realistic estimate.
  [Game.ENSHROUDED]: 8000,
};

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

/** Palworld has a single world (no map selection). */
export const PALWORLD_OFFICIAL_MAPS = ["Palworld"] as const;

/**
 * Minecraft has no "map" — we repurpose the map field as the world generation type
 * (itzg's LEVEL_TYPE). These are the vanilla generators players actually pick.
 */
export const MINECRAFT_OFFICIAL_MAPS = [
  "minecraft:normal",
  "minecraft:flat",
  "minecraft:large_biomes",
  "minecraft:amplified",
] as const;

/** Icarus has no map at launch — the world is a "prospect" players create/select
 *  in-game across the game's maps. Single placeholder for the create form. */
export const ICARUS_OFFICIAL_MAPS = ["Prospect"] as const;

/** Bedrock, like Java, repurposes the map field as the world-generation type
 *  (itzg's LEVEL_TYPE — Bedrock uses these bare keywords, not the namespaced ids). */
export const BEDROCK_OFFICIAL_MAPS = ["DEFAULT", "FLAT", "LEGACY"] as const;

/** Valheim has a single procedurally-generated world (from a seed) — no map choice. */
export const VALHEIM_OFFICIAL_MAPS = ["Valheim"] as const;

/** 7 Days to Die: the handcrafted Navezgane map or a Random World Generation seed. */
export const SEVEN_DAYS_OFFICIAL_MAPS = ["Navezgane", "RWG"] as const;

/** Enshrouded has a single procedurally-generated world — no map choice. */
export const ENSHROUDED_OFFICIAL_MAPS = ["Enshrouded"] as const;

/** Friendly display names for known level names (raw level → label). */
export const MAP_LABELS: Record<string, string> = {
  // Conan Exiles
  ConanSandbox: "Exiled Lands",
  // Palworld
  Palworld: "Palpagos Islands",
  // Minecraft world-generation types (used in place of a map)
  "minecraft:normal": "Default",
  "minecraft:flat": "Superflat",
  "minecraft:large_biomes": "Large Biomes",
  "minecraft:amplified": "Amplified",
  // Icarus (world is a prospect chosen in-game)
  Prospect: "Prospect (chosen in-game)",
  // Bedrock world-generation types (LEVEL_TYPE)
  DEFAULT: "Default",
  FLAT: "Flat",
  LEGACY: "Legacy (small finite world)",
  // Valheim (single procedural world)
  Valheim: "Procedural world",
  // 7 Days to Die
  Navezgane: "Navezgane (handcrafted)",
  RWG: "Random world (RWG)",
  // Enshrouded (single procedural world)
  Enshrouded: "Procedural world",
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
