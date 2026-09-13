import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { mkdir } from "node:fs/promises";
import { EventType, Game, MAPS_BY_GAME, type CreateServerDto } from "@ark/shared";
import { DockerService } from "../docker/docker.service";
import { ServersService } from "../servers/servers.service";
import { EventsService } from "../events/events.service";
import { gameForImageRef, SERVER_GID, SERVER_UID } from "../common/images";
import { LocalPaths } from "../common/paths";
import {
  alignVRisingWorldName,
  COPY_NO_SOURCE,
  copyHelperSpec,
  foreignImageFor,
  resolveBind,
  type ForeignImage,
} from "./foreign-images";
import { loadEnv } from "../config/env";

export interface AdoptionCandidate {
  containerId: string;
  containerName: string;
  image: string;
  game: Game;
  running: boolean;
  /** Set when the container runs an image we don't, and only its saves come
   *  across (e.g. "ich777 Palworld"). */
  foreignImage?: string;
  /** container path → host path */
  binds: Record<string, string>;
}

/** "host:container[:mode]" bind strings → { containerPath: hostPath }. */
export function parseBinds(binds: string[] | undefined | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const b of binds ?? []) {
    // Split from the right: host paths may contain colons only in exotic cases,
    // container paths never do, and the optional trailing part is a mode flag.
    const parts = b.split(":");
    if (parts.length < 2) continue;
    const maybeMode = parts[parts.length - 1]!;
    const hasMode = /^(ro|rw|z|Z|rshared|rslave|rprivate|shared|slave|private|,)+$/.test(maybeMode);
    const containerPath = hasMode ? parts[parts.length - 2]! : parts[parts.length - 1]!;
    const hostPath = parts.slice(0, hasMode ? parts.length - 2 : parts.length - 1).join(":");
    if (hostPath && containerPath) out[containerPath] = hostPath;
  }
  return out;
}

/**
 * Adopt game containers created outside Palisade. Discovery matches containers
 * running a game image we know and that aren't already ours; adoption creates a
 * proper Palisade server and copies the old container's data into our instance
 * layout. The copy runs in a helper container (the manager can't read arbitrary
 * host paths), using the old container's own image so nothing new is pulled,
 * and the original is stopped and left in place for the user to remove once
 * they're happy.
 *
 * Where the data comes from depends on the image:
 *  - Same image as ours: every container path both sides mount is data the new
 *    container reads from the same place, so it's a straight host-dir copy.
 *  - An image in FOREIGN_IMAGES: the two agree on nothing path-wise, so the
 *    mapping says which of their dirs holds each of ours, and only the saves
 *    travel (GH #90).
 */
@Injectable()
export class AdoptionService {
  private readonly logger = new Logger(AdoptionService.name);

  constructor(
    private readonly docker: DockerService,
    private readonly servers: ServersService,
    private readonly events: EventsService,
  ) {}

  async candidates(): Promise<AdoptionCandidate[]> {
    const all = await this.docker.listAllContainers();
    const out: AdoptionCandidate[] = [];
    for (const c of all) {
      if ((c.Labels ?? {})["ark.serverId"]) continue; // already ours
      const foreign = foreignImageFor(c.Image ?? "");
      const game = gameForImageRef(c.Image ?? "") ?? foreign?.game;
      if (!game) continue;
      const info = await this.docker.inspect(c.Id).catch(() => null);
      if (!info) continue;
      out.push({
        containerId: c.Id,
        containerName: (c.Names?.[0] ?? c.Id.slice(0, 12)).replace(/^\//, ""),
        image: c.Image,
        game,
        running: c.State === "running",
        ...(foreign ? { foreignImage: foreign.label } : {}),
        binds: parseBinds(info.HostConfig?.Binds),
      });
    }
    return out;
  }

  async adopt(input: {
    containerId: string;
    name: string;
    adminPassword?: string;
    serverPassword?: string;
  }): Promise<{ serverId: string; copied: string[] }> {
    const info = await this.docker.inspect(input.containerId).catch(() => null);
    if (!info) throw new BadRequestException("Container not found");
    if ((info.Config?.Labels ?? {})["ark.serverId"]) {
      throw new BadRequestException("That container is already managed by Palisade");
    }
    const image = info.Config?.Image ?? "";
    const foreign = foreignImageFor(image);
    const game = gameForImageRef(image) ?? foreign?.game;
    if (!game) {
      throw new BadRequestException(
        `Can't adopt "${image}" — Palisade neither runs that image nor knows where it keeps its ` +
          `saves, so there's nothing it can carry over. Adoption works for containers running the ` +
          `image Palisade uses for that game, plus the other images listed in FOREIGN_IMAGES.`,
      );
    }

    // The source must be quiesced or we'd copy a live, changing world.
    if (info.State?.Running) {
      await this.docker.stop(input.containerId, 120);
    }

    const created = await this.servers.create({
      name: input.name,
      game,
      map: MAPS_BY_GAME[game][0]!,
      adminPassword: input.adminPassword,
      serverPassword: input.serverPassword,
    } as CreateServerDto);

    // Our spec's binds tell us which container paths hold data and where they
    // live on the host for the NEW server; the foreign inspect tells us where
    // the old one kept the same data, directly (same image) or through the
    // mapping (foreign image).
    const spec = await this.servers.specForServer(created.id);
    const ours = parseBinds(spec.HostConfig?.Binds as string[] | undefined);
    const theirs = parseBinds(info.HostConfig?.Binds);

    const copied = foreign
      ? await this.copyForeignSaves(image, foreign, game, theirs, ours)
      : await this.copyMatchingMounts(image, theirs, ours);
    if (copied.length === 0) {
      this.logger.warn(
        `adopt(${input.containerId.slice(0, 12)}): ${
          foreign ? "none of the mapped save dirs held data" : "no overlapping data mounts found"
        } — server created empty`,
      );
    }
    await this.alignWorldName(created.id, game);

    await this.events.emit({
      type: EventType.ServerCreated,
      message: `Adopted container "${info.Name?.replace(/^\//, "")}" as "${input.name}" (${game})${
        foreign ? ` — saves copied from ${foreign.label}` : ""
      } — original left stopped`,
      serverId: created.id,
      data: { adoptedFrom: input.containerId, copied, ...(foreign ? { foreignImage: image } : {}) },
    });
    return { serverId: created.id, copied };
  }

  /** Same-image adoption: every container path both sides mount is data the new
   *  container will read from the same place, so copy host dir to host dir. */
  private async copyMatchingMounts(
    image: string,
    theirs: Record<string, string>,
    ours: Record<string, string>,
  ): Promise<string[]> {
    const copied: string[] = [];
    for (const [containerPath, ourHost] of Object.entries(ours)) {
      const theirHost = theirs[containerPath];
      if (!theirHost || theirHost === ourHost) continue;
      await this.ensureOurDir(ourHost);
      await this.copyHostDir(image, theirHost, ourHost, ".", ".");
      copied.push(containerPath);
    }
    return copied;
  }

  /** Foreign-image adoption: the two images agree on nothing path-wise, so the
   *  mapping says which of their dirs holds each of ours (GH #90). Game files
   *  stay behind — SteamCMD reinstalls them on first boot. */
  private async copyForeignSaves(
    image: string,
    foreign: ForeignImage,
    game: Game,
    theirs: Record<string, string>,
    ours: Record<string, string>,
  ): Promise<string[]> {
    const copied: string[] = [];
    for (const [ourPath, theirPath] of Object.entries(foreign.paths)) {
      const dst = resolveBind(ours, ourPath);
      const src = resolveBind(theirs, theirPath);
      if (!dst) continue; // our own spec changed out from under the mapping
      if (!src) {
        // Their data dir was never persisted, so it died with the container.
        this.logger.warn(`adopt: ${theirPath} isn't on a bind mount in ${image} — skipped`);
        continue;
      }
      await this.ensureOurDir(dst.hostRoot);
      const done = await this.copyHostDir(
        image,
        src.hostRoot,
        dst.hostRoot,
        src.subpath || ".",
        dst.subpath || ".",
        { uid: SERVER_UID[game], gid: SERVER_GID[game] },
      );
      if (done) copied.push(ourPath);
      else this.logger.warn(`adopt: ${theirPath} is empty in ${image} — nothing to copy`);
    }
    return copied;
  }

  /** After the copy, point V Rising at the world we just brought over. */
  private async alignWorldName(serverId: string, game: Game): Promise<void> {
    if (game !== Game.VRISING) return;
    const renamed = await alignVRisingWorldName(LocalPaths.instanceRoot(serverId)).catch(
      (e: Error) => {
        this.logger.warn(`adopt: couldn't rename the adopted V Rising world: ${e.message}`);
        return [];
      },
    );
    for (const was of renamed) {
      this.logger.log(`adopt: renamed V Rising world "${was}" to world1 so the server loads it`);
    }
  }

  /** Pre-create our instance dir through the manager's own mount so the helper
   *  bind doesn't get a root-owned auto-created dir (breaks uid-strict games). */
  private async ensureOurDir(hostPath: string): Promise<void> {
    const env = loadEnv();
    const hostRoot = env.HOST_DATA_DIR ?? env.DATA_DIR;
    if (!hostPath.startsWith(hostRoot)) return;
    const inContainer = env.DATA_DIR + hostPath.slice(hostRoot.length);
    await mkdir(inContainer, { recursive: true }).catch(() => undefined);
  }

  /** Copy one host dir into another, via the helper container. Returns false
   *  when the source isn't there at all (nothing to carry over). */
  private async copyHostDir(
    image: string,
    srcHost: string,
    dstHost: string,
    srcSub: string,
    dstSub: string,
    own?: { uid: number; gid: number },
  ): Promise<boolean> {
    const res = await this.docker.runToCompletion(
      copyHelperSpec({ image, srcHost, dstHost, srcSub, dstSub, own }),
    );
    if (res.exitCode === COPY_NO_SOURCE) return false;
    if (res.exitCode !== 0) {
      throw new BadRequestException(
        `Data copy failed (exit ${res.exitCode}): ${res.log.slice(-300)}`,
      );
    }
    return true;
  }
}
