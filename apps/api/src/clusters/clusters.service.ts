import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { EventType, ServerState } from "@ark/shared";
import { PrismaService } from "../prisma/prisma.service";
import { EventsService } from "../events/events.service";
import { ServersService } from "../servers/servers.service";
import { HostPaths } from "../common/paths";

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "cluster";
}

/**
 * Clusters group servers that share a transfer directory + ARK cluster id, so
 * players/dinos/items can move between maps. Member containers mount the shared
 * cluster volume and launch with -clusterid/-ClusterDirOverride (runtime-spec).
 */
@Injectable()
export class ClustersService {
  private readonly logger = new Logger(ClustersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsService,
    private readonly servers: ServersService,
  ) {}

  async create(name: string, clusterId?: string) {
    const cid = clusterId?.trim() || `${slugify(name)}-${randomBytes(3).toString("hex")}`;
    const exists = await this.prisma.cluster.findUnique({ where: { clusterId: cid } });
    if (exists) throw new BadRequestException("Cluster id already in use");
    const cluster = await this.prisma.cluster.create({
      data: { name, clusterId: cid, transferDir: HostPaths.cluster(cid) },
    });
    await this.events.emit({
      type: EventType.ServerCreated,
      message: `Created cluster "${name}" (${cid})`,
      clusterId: cluster.id,
    });
    return cluster;
  }

  list() {
    return this.prisma.cluster.findMany({
      include: { servers: { select: { id: true, name: true, map: true, state: true, game: true } } },
      orderBy: { createdAt: "desc" },
    });
  }

  async get(id: string) {
    const cluster = await this.prisma.cluster.findUnique({
      where: { id },
      include: { servers: true },
    });
    if (!cluster) throw new NotFoundException("Cluster not found");
    return cluster;
  }

  /** Add a server to a cluster, or MOVE it here if it's already in another one. */
  async addMember(clusterId: string, serverId: string) {
    const cluster = await this.prisma.cluster.findUnique({ where: { id: clusterId } });
    if (!cluster) throw new NotFoundException("Cluster not found");
    const server = await this.prisma.server.findUnique({ where: { id: serverId } });
    if (!server) throw new NotFoundException("Server not found");
    if (server.clusterId === clusterId) return this.get(clusterId);

    await this.prisma.server.update({ where: { id: serverId }, data: { clusterId } });
    const restarted = await this.applyMembershipChange(serverId);
    const moved = !!server.clusterId;
    await this.events.emit({
      type: EventType.ConfigChanged,
      message: `${server.name} ${moved ? "moved to" : "joined"} cluster "${cluster.name}"${
        restarted ? " — restarting to apply" : " (applies on next start)"
      }`,
      serverId,
      clusterId,
    });
    return this.get(clusterId);
  }

  async removeMember(serverId: string) {
    const server = await this.prisma.server.findUnique({ where: { id: serverId } });
    if (!server?.clusterId) throw new BadRequestException("Server is not in a cluster");
    const clusterId = server.clusterId;
    await this.prisma.server.update({ where: { id: serverId }, data: { clusterId: null } });
    const restarted = await this.applyMembershipChange(serverId);
    await this.events.emit({
      type: EventType.ConfigChanged,
      message: `${server.name} left the cluster${
        restarted ? " — restarting to apply" : " (applies on next start)"
      }`,
      serverId,
      clusterId,
    });
    return this.get(clusterId);
  }

  /** If the server is live, restart it so the cluster wiring takes effect now. */
  private async applyMembershipChange(serverId: string): Promise<boolean> {
    const server = await this.prisma.server.findUnique({ where: { id: serverId } });
    if (!server) return false;
    const live = [ServerState.Running, ServerState.Starting].includes(server.state as ServerState);
    if (!live) return false;
    await this.servers.restart(serverId).catch(() => undefined);
    return true;
  }

  async remove(clusterId: string) {
    await this.prisma.server.updateMany({ where: { clusterId }, data: { clusterId: null } });
    await this.prisma.cluster.delete({ where: { id: clusterId } });
  }

  /** Start every member sequentially (avoids a resource spike on boot). */
  async startAll(clusterId: string) {
    const members = await this.prisma.server.findMany({ where: { clusterId } });
    for (const m of members) await this.servers.start(m.id).catch(() => undefined);
    return { started: members.length };
  }

  async stopAll(clusterId: string) {
    const members = await this.prisma.server.findMany({ where: { clusterId } });
    for (const m of members) await this.servers.stop(m.id).catch(() => undefined);
    return { stopped: members.length };
  }

  /**
   * Start/stop every member for the HTTP layer, detached.
   *
   * Both loops are sequential on purpose, so the request would be held for the sum
   * of every member's launch or teardown. The web app's rewrite proxy severs a
   * connection at ~30s and Next 15 exposes no timeout to raise, so a cluster of any
   * size reports a failure for work that is running fine — the same false alarm that
   * hit start and restart.
   *
   * The count is what the caller wanted anyway ("this many were asked to start"),
   * and each member's real progress is already on the servers list.
   *
   * startAll/stopAll are unchanged for internal callers.
   */
  async startAllDetached(clusterId: string) {
    const members = await this.membersOf(clusterId);
    void this.startAll(clusterId).catch((e) =>
      this.logger.warn(`cluster ${clusterId} start failed: ${(e as Error).message}`),
    );
    return { started: members };
  }

  async stopAllDetached(clusterId: string) {
    const members = await this.membersOf(clusterId);
    void this.stopAll(clusterId).catch((e) =>
      this.logger.warn(`cluster ${clusterId} stop failed: ${(e as Error).message}`),
    );
    return { stopped: members };
  }

  /** Member count, and a 404 for a cluster that isn't there — the one thing worth
   *  answering before detaching. */
  private async membersOf(clusterId: string): Promise<number> {
    const cluster = await this.prisma.cluster.findUnique({ where: { id: clusterId } });
    if (!cluster) throw new NotFoundException("Cluster not found");
    return this.prisma.server.count({ where: { clusterId } });
  }
}
