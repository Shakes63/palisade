import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import * as cron from "node-cron";
import { Game, EventType, STEAM_APP_ID, resolveVersionTag } from "@ark/shared";
import { PrismaService } from "../prisma/prisma.service";
import { EventsService } from "../events/events.service";
import { LocalPaths } from "../common/paths";
import { IMAGE_BAKED_GAMES, imageRefFor, splitImageRef } from "../common/images";
import { DockerService } from "../docker/docker.service";
import { ImageTagsService } from "../images/image-tags.service";
import { digestsDiffer, remoteImageDigest } from "./registry-digest";

// Every 3 hours, offset off the top of the hour. ARK ships updates a few times a
// week at most, so this is plenty without hammering the API.
const POLL_CRON = "23 */3 * * *";
const INITIAL_DELAY_MS = 30_000; // let the app settle/reconcile before the first check
const FETCH_TIMEOUT_MS = 15_000;

/** Build id from SteamCMD's app manifest (`"buildid"   "12345678"`), or null. */
export function parseAcfBuildId(acf: string): number | null {
  const m = acf.match(/"buildid"\s+"(\d+)"/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Find `appmanifest_<appid>.acf` under a root dir. SteamCMD always writes the
 * manifest to `<install_dir>/steamapps/`, but every image nests the install in a
 * different subdirectory of the bind (observed live: `.`, `server/`, `serverfiles/`,
 * `game/`, `gamefiles/server/` — GH #16), so instead of a per-image table this does a
 * BOUNDED guided search: at each directory down to `maxDepth`, try `<dir>/<file>` and
 * `<dir>/steamapps/<file>`. Only readdir/readFile probes — the game tree itself is
 * never walked, so a 30 GB install costs the same as an empty one.
 */
export async function findManifest(root: string, file: string, maxDepth = 2): Promise<string | null> {
  let level: string[] = [root];
  for (let depth = 0; depth <= maxDepth && level.length; depth++) {
    for (const dir of level) {
      for (const candidate of [join(dir, file), join(dir, "steamapps", file)]) {
        try {
          await readFile(candidate, "utf8");
          return candidate;
        } catch {
          /* not here */
        }
      }
    }
    if (depth === maxDepth) break;
    const next: string[] = [];
    for (const dir of level) {
      try {
        const entries = await readdir(dir, { withFileTypes: true });
        for (const e of entries) {
          // steamapps is probed explicitly above; don't descend into it (its
          // subtree holds depot content, never another manifest root).
          if (e.isDirectory() && e.name !== "steamapps") next.push(join(dir, e.name));
        }
      } catch {
        /* unreadable/absent dir → nothing beneath it */
      }
    }
    level = next;
  }
  return null;
}

/** Public-branch build id from the steamcmd.net info JSON, or null. */
export function pickPublicBuildId(json: unknown, appId: number): number | null {
  const buildid = (json as Record<string, never> | null)?.["data"]?.[String(appId)]?.["depots"]?.[
    "branches"
  ]?.["public"]?.["buildid"];
  const n = Number(buildid);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Detects when a server's installed ARK build is behind Steam's latest public
 * build, flags `updateAvailable`, and emits an `UpdateAvailable` event (which the
 * notifications service forwards to Discord). The "latest" build comes from the
 * public steamcmd.net info API; failures degrade gracefully (the check is skipped,
 * never throwing). The "installed" build is read from SteamCMD's appmanifest .acf.
 */
@Injectable()
export class UpdatesService implements OnModuleInit {
  private readonly logger = new Logger(UpdatesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsService,
    private readonly docker: DockerService,
    private readonly imageTags: ImageTagsService,
  ) {}

  onModuleInit(): void {
    cron.schedule(POLL_CRON, () => void this.checkAll());
    setTimeout(() => void this.checkAll(), INITIAL_DELAY_MS).unref?.();
  }

  async checkAll(): Promise<void> {
    try {
      const servers = await this.prisma.server.findMany();
      const games = [...new Set(servers.map((s) => s.game as Game))];
      const latest = new Map<Game, number>();
      await Promise.all(
        games.map(async (g) => {
          const b = await this.latestBuildId(g);
          if (b !== null) latest.set(g, b);
        }),
      );

      for (const server of servers) {
        // Server baked into the image → the image digest is the game version.
        if (IMAGE_BAKED_GAMES.has(server.game as Game)) {
          await this.checkBakedImage(server).catch(() => undefined);
          continue;
        }
        const newest = latest.get(server.game as Game);
        if (newest === undefined) continue; // couldn't fetch the latest → skip
        const installed = await this.installedBuildId(server.id, server.game as Game);
        if (installed === null) continue; // not installed yet → nothing to compare

        const outdated = newest > installed;
        const data: Record<string, unknown> = {};
        if (String(installed) !== server.installedBuildId) data.installedBuildId = String(installed);
        if (outdated !== server.updateAvailable) data.updateAvailable = outdated;
        if (Object.keys(data).length) {
          await this.prisma.server.update({ where: { id: server.id }, data }).catch(() => undefined);
        }
        // Notify once, on the false→true transition only (no every-poll spam).
        if (outdated && !server.updateAvailable) {
          await this.events.emit({
            type: EventType.UpdateAvailable,
            message: `Update available for "${server.name}" (installed build ${installed}, latest ${newest}). Use Install / Update, then restart.`,
            serverId: server.id,
            data: { installed: String(installed), latest: String(newest) },
          });
        }
      }
    } catch (err) {
      this.logger.warn(`update check failed: ${(err as Error).message}`);
    }
  }

  /**
   * Update check for a game whose server binary ships inside the image: compare the
   * digest of the image we pulled against what the tag points at in the registry
   * now. A difference means a new image — and for these games that IS a new game
   * build (GH #26).
   *
   * `installedBuildId` doubles as the stored digest here (it's a free-form string
   * column), so no schema change. Both lookups fail soft: an unreachable registry
   * or a locally-built image leaves the flag exactly as it was rather than
   * inventing an update.
   */
  private async checkBakedImage(server: {
    id: string;
    name: string;
    game: string;
    imageTag: string | null;
    installedBuildId: string | null;
    updateAvailable: boolean;
  }): Promise<void> {
    const ref = imageRefFor(server.game as Game, server.imageTag);
    const { repo, tag } = splitImageRef(ref);
    const [local, remote] = await Promise.all([
      this.docker.imageDigest(ref),
      remoteImageDigest(repo, tag),
    ]);
    if (!local || !remote) return; // can't tell — leave the flag untouched

    const outdated = digestsDiffer(local, remote);
    const data: Record<string, unknown> = {};
    if (local !== server.installedBuildId) data.installedBuildId = local;
    if (outdated !== server.updateAvailable) data.updateAvailable = outdated;
    if (Object.keys(data).length) {
      await this.prisma.server.update({ where: { id: server.id }, data }).catch(() => undefined);
    }
    // Once per false→true transition, like the SteamCMD path.
    if (outdated && !server.updateAvailable) {
      // Name the actual build when the registry publishes a versioned alias for it —
      // "a newer image" tells an admin nothing about WHICH game version (GH #26).
      const version = await this.newVersionName(server.game as Game, tag);
      await this.events.emit({
        type: EventType.UpdateAvailable,
        message:
          `Update available for "${server.name}": a newer ${repo}:${tag} image has been published` +
          (version ? ` (${version})` : "") +
          ". The game server ships inside the image, so restart the server to pull it.",
        serverId: server.id,
        data: { installed: local, latest: remote, ...(version ? { version } : {}) },
      });
    }
  }

  /** The versioned tag a floating tag now points at ("42.20.3-release"), or null when
   *  the registry lists no digests / publishes no version aliases. Best-effort. */
  private async newVersionName(game: Game, tag: string): Promise<string | null> {
    try {
      const { tags } = await this.imageTags.list(game);
      return resolveVersionTag(tags, tag);
    } catch {
      return null;
    }
  }

  /** Live check for one server: newest public build vs the installed .acf.
   *  Returns null when it can't tell — non-Steam game, no manifest yet, or the
   *  build API is unreachable (falling back to the stored 3-hourly flag). */
  async isOutdated(serverId: string): Promise<boolean | null> {
    const server = await this.prisma.server.findUnique({ where: { id: serverId } });
    if (!server) return null;
    const game = server.game as Game;
    if (!STEAM_APP_ID[game]) return null;
    const [newest, installed] = await Promise.all([
      this.latestBuildId(game),
      this.installedBuildId(serverId, game),
    ]);
    if (newest === null || installed === null) return server.updateAvailable ?? null;
    return newest > installed;
  }

  private async latestBuildId(game: Game): Promise<number | null> {
    const appId = STEAM_APP_ID[game];
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(`https://api.steamcmd.net/v1/info/${appId}`, { signal: ctrl.signal });
      if (!res.ok) return null;
      return pickPublicBuildId(await res.json(), appId);
    } catch (err) {
      this.logger.debug(`latestBuildId(${game}) failed: ${(err as Error).message}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private async installedBuildId(serverId: string, game: Game): Promise<number | null> {
    const file = `appmanifest_${STEAM_APP_ID[game]}.acf`;
    // A started server has its own copy; fall back to the shared golden cache.
    // The manifest's location within the bind varies per image (GH #16), so each
    // root is searched, not probed at a single fixed path.
    for (const root of [LocalPaths.instanceRoot(serverId), LocalPaths.gameCache(game)]) {
      const path = await findManifest(root, file);
      if (!path) continue;
      try {
        const buildid = parseAcfBuildId(await readFile(path, "utf8"));
        if (buildid !== null) return buildid;
      } catch {
        /* vanished between find and read → try the next root */
      }
    }
    this.logger.debug(`installedBuildId(${game}): no ${file} under instance or cache`);
    return null;
  }
}
