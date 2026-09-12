import { Injectable, NotFoundException } from "@nestjs/common";
import { EventEmitter } from "node:events";
import { PrismaService } from "../prisma/prisma.service";
import type { AuthUser } from "./auth-user";

/** "all" for admins and unrestricted users; otherwise the visible server ids. */
export type AllowedServers = "all" | Set<string>;

/**
 * Per-user server/cluster visibility (GH #73).
 *
 * Admins see everything. A non-admin user with `restricted` unset also sees
 * everything (that is how every account behaved before this existed). A
 * restricted user sees the servers granted directly plus every member of any
 * cluster granted to them, so a cluster grant follows membership changes.
 *
 * Denials are 404s, not 403s: a restricted user should not be able to tell a
 * server they cannot see apart from one that does not exist.
 */
@Injectable()
export class AccessService {
  private readonly bus = new EventEmitter();

  constructor(private readonly prisma: PrismaService) {}

  /** True when the user is exempt from per-server checks. */
  static unrestricted(user: Pick<AuthUser, "role" | "restricted"> | undefined): boolean {
    if (!user) return true;
    const role = user.role ?? "admin";
    return role === "admin" || !user.restricted;
  }

  async allowedServerIds(user: AuthUser | undefined): Promise<AllowedServers> {
    if (AccessService.unrestricted(user)) return "all";
    const [direct, clusters] = await Promise.all([
      this.prisma.userServerAccess.findMany({
        where: { userId: user!.sub },
        select: { serverId: true },
      }),
      this.prisma.userClusterAccess.findMany({
        where: { userId: user!.sub },
        select: { clusterId: true },
      }),
    ]);
    const ids = new Set(direct.map((d) => d.serverId));
    if (clusters.length > 0) {
      const members = await this.prisma.server.findMany({
        where: { clusterId: { in: clusters.map((c) => c.clusterId) } },
        select: { id: true },
      });
      for (const m of members) ids.add(m.id);
    }
    return ids;
  }

  /** Cluster ids granted directly (NOT clusters merely containing a visible server). */
  async grantedClusterIds(user: AuthUser | undefined): Promise<"all" | Set<string>> {
    if (AccessService.unrestricted(user)) return "all";
    const rows = await this.prisma.userClusterAccess.findMany({
      where: { userId: user!.sub },
      select: { clusterId: true },
    });
    return new Set(rows.map((r) => r.clusterId));
  }

  async canSeeServer(user: AuthUser | undefined, serverId: string): Promise<boolean> {
    const allowed = await this.allowedServerIds(user);
    return allowed === "all" || allowed.has(serverId);
  }

  /**
   * A cluster is usable when granted directly or when every member is visible.
   * A cluster with one visible member is still LISTED (for context) but cluster-
   * wide actions (start/stop all, membership, delete) need full access.
   */
  async canUseCluster(user: AuthUser | undefined, clusterId: string): Promise<boolean> {
    if (AccessService.unrestricted(user)) return true;
    const granted = await this.grantedClusterIds(user);
    if (granted !== "all" && granted.has(clusterId)) return true;
    const cluster = await this.prisma.cluster.findUnique({
      where: { id: clusterId },
      select: { servers: { select: { id: true } } },
    });
    if (!cluster) return false;
    const allowed = await this.allowedServerIds(user);
    return allowed === "all" || cluster.servers.every((s) => allowed.has(s.id));
  }

  async assertServer(user: AuthUser | undefined, serverId: string): Promise<void> {
    if (!(await this.canSeeServer(user, serverId))) {
      throw new NotFoundException(`Server ${serverId} not found`);
    }
  }

  async assertServers(user: AuthUser | undefined, serverIds: string[]): Promise<void> {
    const allowed = await this.allowedServerIds(user);
    if (allowed === "all") return;
    const missing = serverIds.find((id) => !allowed.has(id));
    if (missing) throw new NotFoundException(`Server ${missing} not found`);
  }

  async assertCluster(user: AuthUser | undefined, clusterId: string): Promise<void> {
    if (!(await this.canUseCluster(user, clusterId))) {
      throw new NotFoundException(`Cluster ${clusterId} not found`);
    }
  }

  /** Narrow a list of server-bearing rows to what the user may see. */
  filterByServer<T extends { serverId: string | null }>(rows: T[], allowed: AllowedServers): T[] {
    return allowed === "all" ? rows : rows.filter((r) => r.serverId !== null && allowed.has(r.serverId));
  }

  // ── Change notifications (the realtime gateway re-scopes open sockets) ─────

  /** Fired with the userId whenever an admin edits that user's access. */
  onChanged(listener: (userId: string) => void): () => void {
    this.bus.on("changed", listener);
    return () => this.bus.off("changed", listener);
  }

  notifyChanged(userId: string): void {
    this.bus.emit("changed", userId);
  }
}
