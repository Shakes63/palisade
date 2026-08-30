import { Injectable, Logger } from "@nestjs/common";
import type Docker from "dockerode";
import { DockerService } from "./docker.service";
import { ManagerSettingsService } from "../manager-settings/manager-settings.service";
import { findSelfContainerId } from "../config/ensure-host-data-dir";
import { LEGACY_NETWORK } from "../common/naming";
import { loadEnv } from "../config/env";
import {
  NetworkPlanInput,
  dockerViaProxy,
  legacyMigrationNote,
  shouldLeaveLegacy,
  targetNetwork,
} from "../common/shared-network";
import {
  ContainerNetworkFacts,
  ManagerNetworkFacts,
  ResolvedEndpoint,
  explainEndpointFailure,
  gameBridgeNetwork,
  resolveGameEndpoint,
} from "../common/game-endpoint";

/**
 * Resolves the address the manager should use to reach a game container's admin
 * ports, from the container's real networking rather than a global assumption
 * (GH #21 — see common/game-endpoint.ts for the why).
 *
 * Every lookup is best-effort: if Docker won't tell us (locked-down socket-proxy,
 * container already gone), resolution falls back to the historical container-name
 * behaviour instead of failing.
 */
@Injectable()
export class GameEndpointService {
  private readonly logger = new Logger(GameEndpointService.name);
  /** The manager's own networking can't change while the process runs — resolve once. */
  private managerFacts: Promise<ManagerNetworkFacts> | null = null;
  /** How each server was last reached, for the sync per-server health note. */
  private readonly lastVia = new Map<string, ResolvedEndpoint["via"]>();
  /** Cached from the manager facts so `addressingNote` can stay synchronous.
   *  Null until the first resolve has loaded them. */
  private missingShared: boolean | null = null;
  private managerName: string | null = null;
  /** Our own container id — resolved once, then reused by every network call. */
  private selfContainerId: Promise<string | null> | null = null;

  constructor(
    private readonly docker: DockerService,
    private readonly settings: ManagerSettingsService,
  ) {}

  /** The manager setting if one is stored, else the AUTO_CREATE_NETWORK env var. */
  private async autoCreateNetwork(): Promise<boolean> {
    const stored = await this.settings.getAutoCreateNetwork().catch(() => null);
    return stored ?? loadEnv().AUTO_CREATE_NETWORK;
  }

  /**
   * Where to reach `containerPort` on the given server's container.
   *
   * Deliberately uncached: a container recreate changes its IP, and a stale address
   * would strand RCON until the entry expired. The cost is one inspect per RCON
   * connect (connections are pooled) or per player-probe cache miss.
   */
  async resolve(
    serverId: string,
    containerPort: number,
    fallbackHost: string,
    protocol: "tcp" | "udp" = "tcp",
  ): Promise<ResolvedEndpoint> {
    const [facts, manager] = await Promise.all([
      this.containerFacts(serverId),
      this.manager(),
    ]);
    const endpoint = resolveGameEndpoint({ facts, manager, containerPort, protocol, fallbackHost });
    this.lastVia.set(serverId, endpoint.via);
    if (endpoint.via === "container-name" && facts) {
      // We inspected it and still had nothing better — the setup is unusual enough
      // that the next failure will be worth explaining.
      this.logger.debug(
        `server ${serverId}: falling back to the container name "${fallbackHost}" — not on a shared network and :${containerPort} is unpublished`,
      );
    }
    return endpoint;
  }

  /**
   * Turn a connection failure into an actionable message, or null when the cause
   * isn't an addressing problem we can explain.
   */
  async explain(serverId: string, error: Error, endpoint: ResolvedEndpoint): Promise<string | null> {
    const [facts, manager] = await Promise.all([
      this.containerFacts(serverId).catch(() => null),
      this.manager(),
    ]);
    return explainEndpointFailure({
      error,
      endpoint,
      manager,
      gameNetwork: gameBridgeNetwork(facts, manager),
    });
  }

  /**
   * Put the manager on the network its game containers use, and take it off the one
   * they no longer use (GH #31). Both halves are safe to run on every boot.
   *
   * Docker attaches a running container to an extra network live: no restart, and
   * existing networks are kept, so a manager on an Unraid custom/macvlan network
   * keeps its static LAN IP and just gains a route to the game servers.
   *
   * Deliberately conservative — it does nothing when the flag is off, the manager
   * isn't containerised or runs on the host network, we can't read our own
   * networking (a locked-down socket-proxy), or the target network doesn't exist
   * yet. Returns whether the manager ended up on the target network.
   */
  async ensureManagerNetworks(): Promise<boolean> {
    if (!(await this.autoCreateNetwork())) return false;
    const manager = await this.manager();
    if (!manager.inContainer || manager.hostNetwork) return false;
    if (!manager.networks.length) return false; // couldn't inspect ourselves

    const target = manager.sharedNetwork;
    let joined = manager.networks.includes(target);
    if (!joined && (await this.docker.networkExists(target)) === true) {
      const id = await this.selfId();
      joined = id ? await this.docker.connectToNetwork(target, id) : false;
      if (joined) {
        this.logger.log(
          `Attached the manager to "${target}" so game servers on that bridge are reachable`,
        );
        this.forgetManagerFacts();
      }
    }
    await this.retireLegacyNetwork().catch(() => undefined);
    return joined;
  }

  /**
   * Drop the manager's endpoint on the pre-1.11 "ark-net" network once nothing can
   * still be depending on it. This is the step that repairs Unraid's WebUI link for
   * a manager on a custom network — Unraid reads the FIRST of the container's
   * networks and "ark-net" sorted ahead of "br0" (see DEFAULT_SHARED_NETWORK).
   *
   * Never runs on a guess: if Docker won't tell us who else is on that network, the
   * endpoint stays. Leaving a spare endpoint attached costs nothing; removing one a
   * socket-proxy was answering on would cut the manager off from Docker entirely.
   */
  private async retireLegacyNetwork(): Promise<void> {
    const plan = await this.legacyPlan();
    if (!plan || !shouldLeaveLegacy(plan)) return;
    const id = await this.selfId();
    if (!id) return;
    if (await this.docker.disconnectFromNetwork(LEGACY_NETWORK, id)) {
      this.logger.log(
        `Detached the manager from the legacy "${LEGACY_NETWORK}" network — every server now runs on "${targetNetwork(plan.override)}"`,
      );
      this.forgetManagerFacts();
    }
  }

  /**
   * How far along the move off "ark-net" this install is, or null when the network
   * is gone or Docker won't say. Everything the plan decides is derived here once so
   * the rules themselves stay pure and testable (common/shared-network.ts).
   */
  private async legacyPlan(): Promise<NetworkPlanInput | null> {
    const manager = await this.manager();
    if (!manager.inContainer) return null;
    // Docker lists only containers with a LIVE endpoint here, so a stopped server on
    // the legacy network doesn't count — correctly: every start recreates the
    // container, so it comes back on the new network regardless.
    const ids = await this.docker.networkContainerIds(LEGACY_NETWORK);
    if (ids === null) return null; // network absent, or the API is denied to us
    const selfId = await this.selfId();
    const managed = new Set((await this.docker.listManagedServers()).map((s) => s.id));
    return {
      override: loadEnv().SHARED_NETWORK,
      managerNetworks: manager.networks,
      legacyServers: ids.filter((id) => managed.has(id)).length,
      otherOnLegacy: ids.some((id) => id !== selfId && !managed.has(id)),
      dockerViaProxy: dockerViaProxy(loadEnv().DOCKER_HOST),
    };
  }

  /** Progress note for the admin while both networks are in play, else null. */
  async migrationNote(): Promise<string | null> {
    const plan = await this.legacyPlan().catch(() => null);
    return plan ? legacyMigrationNote(plan) : null;
  }

  /** True when the manager runs in a container attached to NEITHER the shared network
   *  nor the legacy one — the setup that silently breaks name-based RCON. Null when
   *  we can't tell. */
  async managerMissingSharedNetwork(): Promise<boolean | null> {
    const manager = await this.manager();
    if (!manager.inContainer || manager.hostNetwork) return false;
    if (!manager.networks.length) return null; // inspect denied — don't cry wolf
    return !manager.networks.some((n) => n === manager.sharedNetwork || n === LEGACY_NETWORK);
  }

  /**
   * Sync note for a server Palisade genuinely cannot reach — the manager is off the
   * shared network AND this server's last resolve had to fall back to the container
   * name (no shared network, no published port), so RCON/player counts will fail.
   *
   * Deliberately narrow: being off the bridge is harmless when ports are published,
   * so this only speaks up for servers that actually failed. Surfaces in the UI's
   * health banner because "check /api/health" is not something a panel user should
   * have to know how to do (GH #21).
   */
  addressingNote(serverId: string): string | null {
    if (this.missingShared !== true) return null;
    if (this.lastVia.get(serverId) !== "container-name") return null;
    const target = this.managerName || "<manager container>";
    const net = this.sharedNetworkName();
    return `Palisade can't reach this server's RCON/query port — the manager container isn't attached to the "${net}" network and this server's ports aren't published to the host, so player counts and the console won't work. Fix: run \`docker network connect ${net} ${target}\` (on Unraid: edit the Palisade container and set Network Type to ${net}), then restart this server.`;
  }

  /** The bridge new game containers are created on. */
  sharedNetworkName(): string {
    return targetNetwork(loadEnv().SHARED_NETWORK);
  }

  /** Our own container id, memoized — every network call needs it. Only a SUCCESSFUL
   *  lookup is kept: caching a transient boot-time failure would pin the manager to
   *  "can't see myself" for the life of the process and quietly skip every attach. */
  private async selfId(): Promise<string | null> {
    const id = await (this.selfContainerId ??= findSelfContainerId(this.docker.client).catch(
      () => null,
    ));
    if (!id) this.selfContainerId = null;
    return id;
  }

  /** Our cached view of our own networking is stale after we change it — the next
   *  resolve (and the health check) must see the new interface list. */
  private forgetManagerFacts(): void {
    this.managerFacts = null;
    this.missingShared = null;
  }

  /** The game container's networking, or null if we can't see it. */
  private async containerFacts(serverId: string): Promise<ContainerNetworkFacts | null> {
    try {
      const id = await this.docker.findContainerIdByServerId(serverId);
      if (!id) return null;
      return toFacts(await this.docker.inspect(id));
    } catch (err) {
      this.logger.debug(`server ${serverId}: container inspect failed (${(err as Error).message})`);
      return null;
    }
  }

  private manager(): Promise<ManagerNetworkFacts> {
    // Memoized on the promise so concurrent probes share one inspect.
    return (this.managerFacts ??= this.loadManagerFacts());
  }

  private async loadManagerFacts(): Promise<ManagerNetworkFacts> {
    const sharedNetwork = this.sharedNetworkName();
    const unknown: ManagerNetworkFacts = {
      inContainer: false,
      hostNetwork: false,
      networks: [],
      sharedNetwork,
    };
    try {
      const id = await this.selfId();
      if (!id) return unknown; // not in a container (dev on the host)
      const info = await this.docker.inspect(id);
      const networks = Object.keys(info.NetworkSettings?.Networks ?? {});
      const facts: ManagerNetworkFacts = {
        inContainer: true,
        hostNetwork: info.HostConfig?.NetworkMode === "host" || networks.includes("host"),
        networks,
        name: info.Name?.replace(/^\//, "") || null,
        sharedNetwork,
      };
      this.managerName = facts.name ?? null;
      // Either bridge counts: mid-migration the servers may still be on the old one.
      this.missingShared = facts.hostNetwork
        ? false
        : !networks.some((n) => n === sharedNetwork || n === LEGACY_NETWORK);
      this.logger.log(
        `manager networking: ${facts.hostNetwork ? "host" : networks.join(", ") || "none detected"}`,
      );
      return facts;
    } catch (err) {
      this.logger.warn(
        `could not determine the manager's own networking (${(err as Error).message}) — game endpoints fall back to container names`,
      );
      return unknown;
    }
  }
}

/** Narrow a dockerode inspect down to the fields resolution actually uses. */
function toFacts(info: Docker.ContainerInspectInfo): ContainerNetworkFacts {
  const networks: Record<string, string | null> = {};
  for (const [name, net] of Object.entries(info.NetworkSettings?.Networks ?? {})) {
    networks[name] = net?.IPAddress || null;
  }
  return {
    networkMode: info.HostConfig?.NetworkMode ?? "",
    networks,
    ports: info.NetworkSettings?.Ports ?? {},
    requestedPorts: info.HostConfig?.PortBindings ?? {},
  };
}
