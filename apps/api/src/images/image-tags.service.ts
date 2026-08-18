import { Injectable, Logger } from "@nestjs/common";
import { Game, type ImageTag, type ImageTagsResult } from "@ark/shared";
import { imageRepoFor, defaultImageTagFor } from "../common/images";

const CACHE_TTL_MS = 10 * 60_000;
const FETCH_TIMEOUT_MS = 12_000;
const MAX_TAGS = 100;

/**
 * Lists the image tags available for a game's Docker image, so the advanced version
 * picker can offer a dropdown instead of asking the user to hand-type a string. Reads
 * the public Docker Hub / GHCR registry APIs; results are cached per repo and any
 * failure degrades to an empty list (the UI still lets you keep the current tag).
 */
@Injectable()
export class ImageTagsService {
  private readonly logger = new Logger(ImageTagsService.name);
  private readonly cache = new Map<string, { at: number; tags: ImageTag[] }>();

  async list(game: Game): Promise<ImageTagsResult> {
    const repo = imageRepoFor(game);
    const defaultTag = defaultImageTagFor(game);
    const tags = await this.tagsFor(repo).catch((e) => {
      this.logger.warn(`tag list for ${repo} failed: ${(e as Error).message}`);
      return [];
    });
    return { repo, defaultTag, tags };
  }

  private async tagsFor(repo: string): Promise<ImageTag[]> {
    const cached = this.cache.get(repo);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.tags;
    const tags = (repo.startsWith("ghcr.io/") ? await this.ghcr(repo) : await this.dockerHub(repo)).slice(
      0,
      MAX_TAGS,
    );
    this.cache.set(repo, { at: Date.now(), tags });
    return tags;
  }

  /** Docker Hub: ordered by last push, with timestamps. */
  private async dockerHub(repo: string): Promise<ImageTag[]> {
    const path = repo.includes("/") ? repo : `library/${repo}`; // official images live under library/
    const json = (await this.getJson(
      `https://hub.docker.com/v2/repositories/${path}/tags?page_size=100&ordering=last_updated`,
    )) as { results?: { name: string; last_updated?: string; digest?: string }[] } | null;
    // The digest lets a floating tag ("latest") be resolved to the versioned tag
    // that shares it ("42.20.3-release") — see resolveVersionTag (GH #26).
    return (json?.results ?? []).map((t) => ({
      name: t.name,
      updatedAt: t.last_updated ?? null,
      digest: t.digest ?? null,
    }));
  }

  /** GHCR: needs an anonymous pull token; tags/list has names only (no timestamps). */
  private async ghcr(repo: string): Promise<ImageTag[]> {
    const path = repo.slice("ghcr.io/".length); // owner/name
    const tokenRes = (await this.getJson(
      `https://ghcr.io/token?scope=repository:${path}:pull&service=ghcr.io`,
    )) as { token?: string } | null;
    if (!tokenRes?.token) return [];
    const json = (await this.getJson(`https://ghcr.io/v2/${path}/tags/list`, {
      Authorization: `Bearer ${tokenRes.token}`,
    })) as { tags?: string[] } | null;
    // GHCR lists cosign signature/attestation artifacts as tags (sha256-<digest>.sig /
    // .att) alongside real ones — drop those. The registry returns tags oldest→newest;
    // reverse so recent ones show first.
    return (json?.tags ?? [])
      .filter((name) => !/^sha256-/.test(name))
      .slice()
      .reverse()
      .map((name) => ({ name, updatedAt: null }));
  }

  private async getJson(url: string, headers?: Record<string, string>): Promise<unknown> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }
}
