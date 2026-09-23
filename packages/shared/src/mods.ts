// Shared shapes for the mod browser (CurseForge for ASA, Steam Workshop for ASE).

export type ModSort = "relevance" | "popularity" | "downloads" | "updated" | "name";

/** A mod as shown in browse/search result cards. */
export interface ModSearchResult {
  remoteId: number;
  /** URL slug — CurseForge only; needed to install a Minecraft modpack (CF_SLUG). */
  slug: string | null;
  name: string;
  summary: string;
  thumbnailUrl: string | null;
  downloadCount: number;
  authors: string[];
  websiteUrl: string | null;
  lastUpdated: string | null; // ISO timestamp
  fileSize: number | null; // bytes (latest file)
  version: string | null; // latest file display name / version label
  categories: string[];
  featured: boolean;
}

/** Full mod info for the detail view (heavier — fetched on demand). */
export interface ModDetail extends ModSearchResult {
  description: string; // long description (plain text — HTML/BBCode stripped server-side)
  screenshots: string[];
}

export interface ModCategory {
  id: string;
  name: string;
}

/** A favorited mod (stored per game in the manager DB). */
export interface ModFavorite {
  remoteId: number;
  name: string;
  thumbnailUrl: string | null;
}

/** Page size used by the browse endpoint; the UI infers "has more" from it. */
export const MOD_PAGE_SIZE = 20;

/**
 * The CurseForge modpack installed on a Minecraft server. Stored in the server's
 * config (underscore-prefixed keys) and consumed by the runtime spec, which switches
 * the itzg image to TYPE=AUTO_CURSEFORGE and feeds it CF_SLUG/CF_FILE_ID + the key.
 */
export interface MinecraftModpack {
  projectId: number;
  slug: string;
  name: string;
  thumbnailUrl: string | null;
  /** Pinned file (version) id, or null to let the image install the latest. */
  fileId: number | null;
  /** Update check (filled on GET when the pack is pinned): CurseForge's current
   *  main file vs the pinned one. */
  latestFileId?: number | null;
  latestFileName?: string | null;
  updateAvailable?: boolean;
}

/** Which package index a Valheim mod search result came from. */
export type ValheimModSource = "thunderstore" | "hexium";

/** One installed mod's update state, unified across sources (Thunderstore package or
 *  CurseForge modpack). `id` is what the apply path needs to update just this one. */
export interface ModUpdateItem {
  id: string; // Thunderstore "Owner-Mod" full name, or the modpack slug
  name: string;
  installedVersion: string | null;
  latestVersion: string | null;
}

/** Whether a server has mod updates, and which mods. `supported` is false for games
 *  whose mods auto-update on restart or have no remote version to compare. */
export interface ModUpdateStatus {
  supported: boolean;
  count: number; // number of mods with an update available
  items: ModUpdateItem[]; // only the out-of-date ones
}

/** Result of applying pending mod updates for a server. */
export interface ModUpdateResult {
  updated: string[]; // names updated
  failed: { name: string; error: string }[];
  /** True if the server was running — the caller should restart to load the changes. */
  restartNeeded: boolean;
}
