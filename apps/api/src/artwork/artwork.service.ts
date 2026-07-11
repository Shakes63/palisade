import { Injectable, Logger } from "@nestjs/common";
import {
  Game,
  GAME_LABELS,
  STORE_APP_ID,
  type ArtworkKind,
  type ArtworkOption,
  type GameArtwork,
} from "@ark/shared";
import { ManagerSettingsService, SettingKeys } from "../manager-settings/manager-settings.service";

const SGDB_BASE = "https://www.steamgriddb.com/api/v2";
const FETCH_TIMEOUT_MS = 10_000;
/** Re-check games that had NO art after a week (new uploads appear); found art is kept forever. */
const RETRY_EMPTY_AFTER_MS = 7 * 24 * 60 * 60_000;

/**
 * Minecraft/Bedrock aren't on Steam (STORE_APP_ID 0), so resolve their art by
 * name search. Every other game has a store app id and resolves directly.
 */
const SEARCH_NAME: Partial<Record<Game, string>> = {
  [Game.MINECRAFT]: "Minecraft",
  [Game.BEDROCK]: "Minecraft",
};

type CacheEntry = GameArtwork & { fetchedAt: string };
type Cache = Partial<Record<Game, CacheEntry>>;

interface SgdbAsset {
  url?: string;
  thumb?: string;
  score?: number;
}

/** SGDB path segment per art kind. */
const KIND_PATH: Record<ArtworkKind, string> = {
  grid: "grids",
  hero: "heroes",
  logo: "logos",
  icon: "icons",
};

/**
 * Game cover art / banners / logos / icons from SteamGridDB. Resolution is by
 * Steam app id where we have one (GET {type}/steam/{appid}) and by name search
 * otherwise. Results are cached in a manager setting so SGDB is hit roughly
 * once per game, not per page load; everything degrades to "no art" quietly —
 * a missing/invalid key must never break the dashboard.
 */
@Injectable()
export class ArtworkService {
  private readonly logger = new Logger(ArtworkService.name);
  private refreshing: Promise<{ fetched: number; missing: number }> | null = null;

  constructor(private readonly settings: ManagerSettingsService) {}

  /** Cached art for every game (empty object per game when unfetched). Kicks a
   *  background fill for anything missing/stale when a key is configured. */
  async getAll(): Promise<Partial<Record<Game, GameArtwork>>> {
    const cache = await this.readCache();
    if (await this.needsRefresh(cache)) {
      void this.refresh().catch(() => undefined);
    }
    const out: Partial<Record<Game, GameArtwork>> = {};
    for (const [game, entry] of Object.entries(cache)) {
      const { fetchedAt: _ignored, ...art } = entry;
      out[game as Game] = art;
    }
    return out;
  }

  /** Fetch (or re-fetch) art for every game. Single-flight; returns counts. */
  refresh(): Promise<{ fetched: number; missing: number }> {
    this.refreshing ??= this.doRefresh().finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  private async doRefresh(): Promise<{ fetched: number; missing: number }> {
    const key = await this.settings.get(SettingKeys.SteamGridDbApiKey);
    if (!key) return { fetched: 0, missing: Object.values(Game).length };

    const cache = await this.readCache();
    let fetched = 0;
    let missing = 0;
    for (const game of Object.values(Game)) {
      const existing = cache[game];
      // Keep found art forever; only re-try games that previously had nothing.
      if (existing && (this.hasAnyArt(existing) || !this.isStale(existing))) {
        if (this.hasAnyArt(existing)) fetched++;
        else missing++;
        continue;
      }
      try {
        const art = await this.fetchGameArt(game, key);
        cache[game] = { ...art, fetchedAt: new Date().toISOString() };
        if (this.hasAnyArt(art)) fetched++;
        else missing++;
      } catch (err) {
        this.logger.warn(`artwork(${game}): ${(err as Error).message}`);
        missing++;
      }
    }
    await this.writeCache(cache);
    this.logger.log(`SteamGridDB artwork: ${fetched} game(s) with art, ${missing} without`);
    return { fetched, missing };
  }

  /** SGDB ref for a game: its STORE app id (where SGDB indexes art), or a game
   *  id from name search for the two games that aren't on Steam. Null if neither. */
  private async resolveRef(game: Game, key: string): Promise<{ kind: "steam" | "game"; id: number } | null> {
    const appId = STORE_APP_ID[game];
    if (appId > 0) return { kind: "steam", id: appId };
    const name = SEARCH_NAME[game] ?? GAME_LABELS[game];
    const results = await this.sgdb<{ id: number }[]>(
      `/search/autocomplete/${encodeURIComponent(name)}`,
      key,
    );
    return results?.[0]?.id ? { kind: "game", id: results[0].id } : null;
  }

  private assetPath(kind: ArtworkKind, ref: { kind: string; id: number }): string {
    // Grids: 600x900 portrait covers. Others keep SGDB's score-sorted defaults.
    const dims = kind === "grid" ? "&dimensions=600x900" : "";
    return `/${KIND_PATH[kind]}/${ref.kind}/${ref.id}?nsfw=false&humor=false&types=static${dims}`;
  }

  /** Candidate assets of one kind for the per-server picker (score-sorted by SGDB). */
  async options(game: Game, kind: ArtworkKind): Promise<ArtworkOption[]> {
    const key = await this.settings.get(SettingKeys.SteamGridDbApiKey);
    if (!key) return [];
    const ref = await this.resolveRef(game, key).catch(() => null);
    if (!ref) return [];
    const assets = (await this.sgdb<SgdbAsset[]>(this.assetPath(kind, ref), key).catch(() => null)) ?? [];
    return assets
      .filter((a): a is SgdbAsset & { url: string } => Boolean(a.url))
      .map((a) => ({ url: a.url, thumb: a.thumb || a.url }));
  }

  private async fetchGameArt(game: Game, key: string): Promise<GameArtwork> {
    const ref = await this.resolveRef(game, key);
    if (!ref) return { grid: null, hero: null, logo: null, icon: null };
    const first = async (kind: ArtworkKind) =>
      (await this.sgdb<SgdbAsset[]>(this.assetPath(kind, ref), key))?.[0]?.url ?? null;
    const [grid, hero, logo, icon] = await Promise.all([
      first("grid"),
      first("hero"),
      first("logo"),
      first("icon"),
    ]);
    return { grid, hero, logo, icon };
  }

  /** GET an SGDB endpoint; null on any failure (404 = game/assets not found). */
  private async sgdb<T>(path: string, key: string): Promise<T | null> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(`${SGDB_BASE}${path}`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: ctrl.signal,
      });
      if (res.status === 401) throw new Error("SteamGridDB rejected the API key (401)");
      if (!res.ok) return null;
      const body = (await res.json()) as { success: boolean; data: T };
      return body.success ? body.data : null;
    } finally {
      clearTimeout(timer);
    }
  }

  // ── Cache (one manager-setting JSON; ~22 small entries) ─────────────────────
  private async readCache(): Promise<Cache> {
    const raw = await this.settings.get(SettingKeys.ArtworkCache);
    if (!raw) return {};
    try {
      return JSON.parse(raw) as Cache;
    } catch {
      return {};
    }
  }

  private async writeCache(cache: Cache): Promise<void> {
    await this.settings.set(SettingKeys.ArtworkCache, JSON.stringify(cache));
  }

  private hasAnyArt(a: GameArtwork): boolean {
    return Boolean(a.grid || a.hero || a.logo || a.icon);
  }

  private isStale(entry: CacheEntry): boolean {
    return Date.now() - new Date(entry.fetchedAt).getTime() > RETRY_EMPTY_AFTER_MS;
  }

  private async needsRefresh(cache: Cache): Promise<boolean> {
    if (!(await this.settings.get(SettingKeys.SteamGridDbApiKey))) return false;
    return Object.values(Game).some((g) => {
      const e = cache[g];
      return !e || (!this.hasAnyArt(e) && this.isStale(e));
    });
  }
}
