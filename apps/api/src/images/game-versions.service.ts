import { Injectable, Logger } from "@nestjs/common";
import { Game, type GameVersionOption, type GameVersionsResult } from "@ark/shared";

const CACHE_TTL_MS = 30 * 60_000; // versions change rarely; a stale-ish list is fine
const FETCH_TIMEOUT_MS = 12_000;
const MAX_SNAPSHOTS = 25; // the Mojang manifest has thousands — cap the noise
const MAX_OPENTTD = 60;

/**
 * Lists the available GAME versions for a game — the value its wrapper image reads to
 * install a specific build of the game itself (distinct from the Docker image tag).
 * Backs the settings version dropdown so a user picks a real published version instead
 * of guessing a string. Only games whose image exposes a version knob have a provider;
 * everything else returns an empty list (the UI falls back to a free-text box).
 */
@Injectable()
export class GameVersionsService {
  private readonly logger = new Logger(GameVersionsService.name);
  private readonly cache = new Map<Game, { at: number; result: GameVersionsResult }>();

  private readonly providers: Partial<Record<Game, () => Promise<GameVersionsResult>>> = {
    [Game.MINECRAFT]: () => this.minecraft(),
    [Game.OPENTTD]: () => this.openttd(),
  };

  async list(game: Game): Promise<GameVersionsResult> {
    const provider = this.providers[game];
    if (!provider) return { defaultValue: "", defaultLabel: "", options: [] };
    const cached = this.cache.get(game);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.result;
    const result = await provider().catch((e) => {
      this.logger.warn(`version list for ${game} failed: ${(e as Error).message}`);
      return { defaultValue: "", defaultLabel: "", options: [] as GameVersionOption[] };
    });
    // Only cache a non-empty success — a transient failure shouldn't be sticky.
    if (result.options.length) this.cache.set(game, { at: Date.now(), result });
    return result;
  }

  /** itzg/minecraft-server VERSION env: "LATEST", "SNAPSHOT", or a concrete id. */
  private async minecraft(): Promise<GameVersionsResult> {
    const json = (await this.getJson(
      "https://launchermeta.mojang.com/mc/game/version_manifest_v2.json",
    )) as { versions?: { id: string; type: string; releaseTime?: string }[] } | null;
    const versions = json?.versions ?? [];
    const date = (t?: string) => (t ? ` — ${t.slice(0, 10)}` : "");
    const releases = versions
      .filter((v) => v.type === "release")
      .map<GameVersionOption>((v) => ({ value: v.id, label: `${v.id}${date(v.releaseTime)}`, kind: "release" }));
    const snapshots = versions
      .filter((v) => v.type === "snapshot")
      .slice(0, MAX_SNAPSHOTS)
      .map<GameVersionOption>((v) => ({
        value: v.id,
        label: `${v.id} (snapshot)${date(v.releaseTime)}`,
        kind: "snapshot",
      }));
    return {
      defaultValue: "LATEST",
      defaultLabel: "Latest release (LATEST)",
      // "SNAPSHOT" is itzg's alias for the newest snapshot; then concrete versions.
      options: [
        { value: "SNAPSHOT", label: "Latest snapshot (SNAPSHOT)", kind: "default" },
        ...releases,
        ...snapshots,
      ],
    };
  }

  /** ich777 openttdserver GAME_VERSION: "latest" or a release tag (e.g. "15.3"). */
  private async openttd(): Promise<GameVersionsResult> {
    const json = (await this.getJson(
      "https://api.github.com/repos/OpenTTD/OpenTTD/releases?per_page=60",
    )) as { tag_name?: string; prerelease?: boolean; published_at?: string }[] | null;
    const options = (json ?? []).slice(0, MAX_OPENTTD).map<GameVersionOption>((r) => ({
      value: r.tag_name ?? "",
      label: `${r.tag_name}${r.prerelease ? " (beta)" : ""}${r.published_at ? ` — ${r.published_at.slice(0, 10)}` : ""}`,
      kind: r.prerelease ? "prerelease" : "release",
    }));
    return {
      defaultValue: "latest",
      defaultLabel: "Latest stable (latest)",
      options: options.filter((o) => o.value),
    };
  }

  private async getJson(url: string): Promise<unknown> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      // A UA header keeps the GitHub API from 403-ing anonymous requests.
      const res = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "palisade" } });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }
}
