import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import type Docker from "dockerode";
import { mkdir, stat } from "node:fs/promises";
import { posix } from "node:path";
import { EventType, Game, MAPS_BY_GAME, type CreateServerDto } from "@ark/shared";
import { DockerService } from "../docker/docker.service";
import { ServersService } from "../servers/servers.service";
import { EventsService } from "../events/events.service";
import { PrismaService } from "../prisma/prisma.service";
import { CryptoService } from "../crypto/crypto.service";
import { readServerSnapshot, type ServerSnapshot } from "../servers/server-snapshot";
import { gameForImageRef, SERVER_GID, SERVER_UID } from "../common/images";
import { HostPaths, LocalPaths } from "../common/paths";
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
  /** A container Palisade created whose server is gone from the database, e.g.
   *  after a reinstall. Adopting it reattaches the server under its old id. */
  orphaned?: boolean;
  /** The orphan's name from its saved settings, present when those survived. */
  savedName?: string;
  /** One key per password it saved: true if it still decrypts, false once SECRETS_KEY changed. */
  savedPasswords?: { admin?: boolean; join?: boolean };
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

/** Palisade's ids are cuids; anything else in the label isn't one of ours to reattach. */
const SERVER_ID_RE = /^[a-z0-9]+$/;

const norm = (p: string) => posix.normalize(p).replace(/\/+$/, "");
const within = (p: string, dir: string) => p === dir || p.startsWith(`${dir}/`);
const clustersDir = () => norm(posix.dirname(HostPaths.cluster("_")));
/** Docker names an image's own unnamed volumes with 64 hex chars. */
const ANON_VOLUME_RE = /^[0-9a-f]{64}$/;

/** Where a container's bind mounts come from as they took effect, whichever API set them. */
function bindSources(info: Docker.ContainerInspectInfo): string[] {
  return (info.Mounts ?? []).filter((m) => m.Type === "bind").map((m) => norm(m.Source));
}

/** Every mount of the old container is one our spec recreates, so none of its data is left behind. */
function mountsMatch(info: Docker.ContainerInspectInfo, spec: Docker.ContainerCreateOptions): boolean {
  const binds = Object.entries(parseBinds(spec.HostConfig?.Binds)).map(
    ([dst, src]) => [norm(src), norm(dst)] as const,
  );
  const ours = new Set(binds.map(([src, dst]) => `${src}:${dst}`));
  const clusters = clustersDir();
  return (info.Mounts ?? []).every((m) => {
    if (m.Type === "bind") {
      return ours.has(`${norm(m.Source)}:${norm(m.Destination)}`) || within(norm(m.Source), clusters);
    }
    if (m.Type !== "volume") return true;
    // An anonymous volume outside our binds is never kept across a start anyway; one over them hides data.
    const dst = norm(m.Destination);
    return ANON_VOLUME_RE.test(m.Name ?? "") && !binds.some(([, bound]) => within(dst, bound));
  });
}

/** The recreated container gets no capability or privilege the old one ran without. */
function gainsNoAccess(info: Docker.ContainerInspectInfo, spec: Docker.ContainerCreateOptions): boolean {
  const had = new Set(info.HostConfig?.CapAdd ?? []);
  const hardened = (opts: string[] | undefined) => (opts ?? []).includes("no-new-privileges:true");
  return (
    ((spec.HostConfig?.CapAdd ?? []) as string[]).every((cap) => had.has(cap)) &&
    (!hardened(info.HostConfig?.SecurityOpt) || hardened(spec.HostConfig?.SecurityOpt))
  );
}

/** The parsed value, or undefined when `raw` is missing or isn't JSON. */
function parseJson(raw: string | null | undefined): unknown {
  if (typeof raw !== "string") return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function labelledGame(labels: Record<string, string>): Game | undefined {
  const game = labels["ark.game"] as Game | undefined;
  return game && Object.values(Game).includes(game) ? game : undefined;
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
 *  - A container Palisade created whose server the database has lost: it is
 *    reattached under its old id, where its data already is, with the settings
 *    its last start snapshotted (GH #175).
 */
@Injectable()
export class AdoptionService {
  private readonly logger = new Logger(AdoptionService.name);

  constructor(
    private readonly docker: DockerService,
    private readonly servers: ServersService,
    private readonly events: EventsService,
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  async candidates(): Promise<AdoptionCandidate[]> {
    const [all, servers] = await Promise.all([
      this.docker.listAllContainers(),
      this.prisma.server.findMany({ select: { id: true } }),
    ]);
    const known = new Set(servers.map((s) => s.id));
    const out: AdoptionCandidate[] = [];
    for (const c of all) {
      const labels = c.Labels ?? {};
      const ownId = labels["ark.serverId"];
      if (ownId && known.has(ownId)) continue;
      const foreign = ownId ? undefined : foreignImageFor(c.Image ?? "");
      const game =
        (ownId ? labelledGame(labels) : undefined) ?? gameForImageRef(c.Image ?? "") ?? foreign?.game;
      if (!game) continue;
      const info = await this.docker.inspect(c.Id).catch(() => null);
      if (!info) continue;
      if (ownId && !(await this.reattachable(ownId, info))) continue;
      const snapshot = ownId ? await this.snapshotFor(ownId, game) : null;
      out.push({
        containerId: c.Id,
        containerName: (c.Names?.[0] ?? c.Id.slice(0, 12)).replace(/^\//, ""),
        image: c.Image,
        game,
        running: c.State === "running",
        ...(foreign ? { foreignImage: foreign.label } : {}),
        ...(ownId ? { orphaned: true } : {}),
        ...(snapshot ? { savedName: snapshot.name, savedPasswords: this.savedPasswords(snapshot) } : {}),
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
    const ownId = (info.Config?.Labels ?? {})["ark.serverId"];
    if (ownId) {
      if (await this.prisma.server.findUnique({ where: { id: ownId }, select: { id: true } })) {
        throw new BadRequestException("That container is already managed by Palisade");
      }
      if (!(await this.reattachable(ownId, info))) {
        throw new BadRequestException(
          "That container's data isn't in this Palisade's data folder, so there's nothing to reattach it to.",
        );
      }
      return this.reattach(input, info, ownId);
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

  /** Reattach a container Palisade created whose server the database lost. Its data
   *  is already in our instance dir under the same id, so nothing is copied. */
  private async reattach(
    input: { containerId: string; name: string; adminPassword?: string; serverPassword?: string },
    info: Docker.ContainerInspectInfo,
    serverId: string,
  ): Promise<{ serverId: string; copied: string[] }> {
    const game = labelledGame(info.Config?.Labels ?? {}) ?? gameForImageRef(info.Config?.Image ?? "");
    if (!game) throw new BadRequestException(`Can't tell which game "${info.Config?.Image}" runs`);
    const snapshot = await this.snapshotFor(serverId, game);

    // Held throughout: a start slipping in before the checks finish would launch unchecked settings.
    return this.servers.withLock(serverId, async () => {
      // Checked again under the lock, so the rollback below can only ever delete our own row.
      if (await this.prisma.server.findUnique({ where: { id: serverId }, select: { id: true } })) {
        throw new BadRequestException("That container is already managed by Palisade");
      }
      try {
        await this.servers.create(
          {
            name: input.name,
            game,
            map: snapshot?.map ?? MAPS_BY_GAME[game][0]!,
            adminPassword: input.adminPassword || this.reveal(snapshot?.adminPasswordEnc),
            serverPassword: input.serverPassword || this.reveal(snapshot?.serverPasswordEnc),
            ...(snapshot
              ? {
                  spectatorPassword: this.reveal(snapshot.spectatorPasswordEnc),
                  maxPlayers: snapshot.maxPlayers,
                  config: JSON.parse(snapshot.configJson),
                  modIds: JSON.parse(snapshot.modIds),
                  ramLimitMb: snapshot.ramLimitMb ?? undefined,
                  cpuLimit: snapshot.cpuLimit ?? undefined,
                  imageTag: snapshot.imageTag,
                }
              : {}),
          } as CreateServerDto,
          { id: serverId },
        );
        if (snapshot) await this.restoreSnapshot(serverId, game, snapshot);
        // The game can rewrite or delete the snapshot, so a bridged container stays bridged
        // rather than following a manager-wide host-network default.
        if (info.HostConfig?.NetworkMode !== "host") {
          await this.prisma.server.update({ where: { id: serverId }, data: { hostNetwork: false } });
        }
        const spec = await this.servers.specForServer(serverId);
        if (!mountsMatch(info, spec)) {
          throw new BadRequestException(
            "That container mounts its data differently from how Palisade sets it up, so reattaching would leave some of it behind.",
          );
        }
        // The game can rewrite the snapshot, so its settings mustn't buy the container more access.
        if (!gainsNoAccess(info, spec)) {
          throw new BadRequestException(
            "That server's saved settings would give its container more access than it had, so Palisade won't use them.",
          );
        }
        // The first start replaces the old container; until then it mustn't run unmanaged.
        if (info.State?.Running) await this.docker.stop(input.containerId, 120);
      } catch (e) {
        // Drop the row directly: deleting the server would wipe the instance dir, the only copy.
        await this.prisma.server.delete({ where: { id: serverId } }).catch(() => undefined);
        throw e;
      }

      await this.events.emit({
        type: EventType.ServerCreated,
        message: `Reattached container "${info.Name?.replace(/^\//, "")}" as "${input.name}" (${game}) with ${
          snapshot ? "its saved" : "default"
        } settings`,
        serverId,
        data: { adoptedFrom: input.containerId },
      });
      return { serverId, copied: [] };
    });
  }

  /** Ours to reattach only if it mounts nothing but our existing instance dir (and clusters);
   *  else it's another Palisade's, or its data isn't where our spec will mount it. */
  private async reattachable(serverId: string, info: Docker.ContainerInspectInfo): Promise<boolean> {
    if (!SERVER_ID_RE.test(serverId)) return false;
    const root = norm(HostPaths.instanceRoot(serverId));
    const clusters = clustersDir();
    const sources = bindSources(info);
    if (!sources.some((s) => within(s, root))) return false;
    if (!sources.every((s) => within(s, root) || within(s, clusters))) return false;
    return stat(LocalPaths.instanceRoot(serverId)).then(
      (s) => s.isDirectory(),
      () => false,
    );
  }

  /** The orphan's saved settings, unless they belong to another server or don't parse. */
  private async snapshotFor(serverId: string, game: Game): Promise<ServerSnapshot | null> {
    const s = await readServerSnapshot(serverId);
    if (s?.id !== serverId || s.game !== game || typeof s.name !== "string" || !Array.isArray(s.mods)) {
      return null;
    }
    const config = parseJson(s.configJson);
    if (typeof config !== "object" || config === null || !Array.isArray(parseJson(s.modIds))) return null;
    return s;
  }

  /** A saved secret, or undefined when it can't be decrypted (SECRETS_KEY changed). */
  private reveal(enc: string | null | undefined): string | undefined {
    if (!enc) return undefined;
    try {
      return this.crypto.decrypt(enc);
    } catch {
      return undefined;
    }
  }

  private savedPasswords(snapshot: ServerSnapshot): { admin?: boolean; join?: boolean } {
    return {
      ...(snapshot.adminPasswordEnc ? { admin: this.reveal(snapshot.adminPasswordEnc) !== undefined } : {}),
      ...(snapshot.serverPasswordEnc ? { join: this.reveal(snapshot.serverPasswordEnc) !== undefined } : {}),
    };
  }

  /** What create() doesn't take: the server's ports, extra env, art and mod list. */
  private async restoreSnapshot(serverId: string, game: Game, snapshot: ServerSnapshot): Promise<void> {
    await this.prisma.server.update({
      where: { id: serverId },
      data: {
        gamePort: snapshot.gamePort,
        rawSocketPort: snapshot.rawSocketPort,
        queryPort: snapshot.queryPort,
        rconPort: snapshot.rconPort,
        extraEnvEnc: this.reveal(snapshot.extraEnvEnc) === undefined ? null : snapshot.extraEnvEnc,
        artworkJson: parseJson(snapshot.artworkJson) === undefined ? null : snapshot.artworkJson,
        backupKeep: snapshot.backupKeep,
        hostNetwork: snapshot.hostNetwork,
      },
    });
    for (const m of snapshot.mods) {
      const mod = await this.prisma.mod.upsert({
        where: { game_source_remoteId: { game, source: m.source, remoteId: m.remoteId } },
        create: {
          game,
          source: m.source,
          remoteId: m.remoteId,
          name: m.name,
          thumbnailUrl: m.thumbnailUrl,
          extra: m.extra,
        },
        update: {},
      });
      await this.prisma.modInstall.create({
        data: {
          serverId,
          modId: mod.id,
          loadOrder: m.loadOrder,
          pinnedVersion: m.pinnedVersion,
          enabled: m.enabled,
        },
      });
    }
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
