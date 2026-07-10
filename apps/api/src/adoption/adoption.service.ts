import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { mkdir } from "node:fs/promises";
import { EventType, Game, MAPS_BY_GAME, type CreateServerDto } from "@ark/shared";
import { DockerService } from "../docker/docker.service";
import { ServersService } from "../servers/servers.service";
import { EventsService } from "../events/events.service";
import { IMAGES } from "../common/images";
import { loadEnv } from "../config/env";

export interface AdoptionCandidate {
  containerId: string;
  containerName: string;
  image: string;
  game: Game;
  running: boolean;
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
 * running a known game image (and not already ours); adoption creates a proper
 * Palisade server and copies the foreign container's volume data into our
 * instance layout — mount-pair mapping comes from our own container spec, so
 * whatever container path the image stores data under, the matching foreign
 * host dir is copied to ours. The copy runs in a helper container (the
 * manager can't read arbitrary host paths), using the game's own image so
 * nothing new is pulled. The original container is stopped and left in place
 * for the user to remove once they're happy.
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
    const repoToGame = new Map<string, Game>(
      Object.entries(IMAGES).map(([game, image]) => [image.split(":")[0]!, game as Game]),
    );
    const all = await this.docker.listAllContainers();
    const out: AdoptionCandidate[] = [];
    for (const c of all) {
      if ((c.Labels ?? {})["ark.serverId"]) continue; // already ours
      const game = repoToGame.get((c.Image ?? "").split(":")[0]!);
      if (!game) continue;
      const info = await this.docker.inspect(c.Id).catch(() => null);
      if (!info) continue;
      out.push({
        containerId: c.Id,
        containerName: (c.Names?.[0] ?? c.Id.slice(0, 12)).replace(/^\//, ""),
        image: c.Image,
        game,
        running: c.State === "running",
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
    const repoToGame = new Map<string, Game>(
      Object.entries(IMAGES).map(([game, image]) => [image.split(":")[0]!, game as Game]),
    );
    const game = repoToGame.get((info.Config?.Image ?? "").split(":")[0]!);
    if (!game) throw new BadRequestException("Unrecognized game image — can't adopt this container");

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
    // the same container paths lived for the old one.
    const spec = await this.servers.specForServer(created.id);
    const ours = parseBinds(spec.HostConfig?.Binds as string[] | undefined);
    const theirs = parseBinds(info.HostConfig?.Binds);

    const copied: string[] = [];
    for (const [containerPath, ourHost] of Object.entries(ours)) {
      const theirHost = theirs[containerPath];
      if (!theirHost || theirHost === ourHost) continue;
      await this.ensureOurDir(ourHost);
      await this.copyHostDir(info.Config!.Image!, theirHost, ourHost);
      copied.push(containerPath);
    }
    if (copied.length === 0) {
      this.logger.warn(
        `adopt(${input.containerId.slice(0, 12)}): no overlapping data mounts found — server created empty`,
      );
    }

    await this.events.emit({
      type: EventType.ServerCreated,
      message: `Adopted container "${info.Name?.replace(/^\//, "")}" as "${input.name}" (${game}) — original left stopped`,
      serverId: created.id,
      data: { adoptedFrom: input.containerId, copied },
    });
    return { serverId: created.id, copied };
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

  /** Copy one host dir to another via a helper container (the game's own image —
   *  already present, and its `sh`/`cp` are all we need). */
  private async copyHostDir(image: string, srcHost: string, dstHost: string): Promise<void> {
    const res = await this.docker.runToCompletion({
      Image: image,
      Entrypoint: ["sh", "-c"],
      Cmd: ["cp -a /palisade-adopt-src/. /palisade-adopt-dst/"],
      Labels: { "ark.role": "adopt-helper" },
      HostConfig: {
        Binds: [`${srcHost}:/palisade-adopt-src:ro`, `${dstHost}:/palisade-adopt-dst`],
        NetworkMode: "none",
        SecurityOpt: ["no-new-privileges:true"],
        PidsLimit: 256,
      },
    });
    if (res.exitCode !== 0) {
      throw new BadRequestException(
        `Data copy failed (exit ${res.exitCode}): ${res.log.slice(-300)}`,
      );
    }
  }
}
