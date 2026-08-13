import { Injectable, Logger } from "@nestjs/common";
import type Docker from "dockerode";
import { DockerService } from "./docker.service";
import { findSelfContainerId } from "../config/ensure-host-data-dir";
import { ARK_NETWORK } from "../common/naming";
import {
  ContainerNetworkFacts,
  ManagerNetworkFacts,
  ResolvedEndpoint,
  explainEndpointFailure,
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

  constructor(private readonly docker: DockerService) {}

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
      gameOnArkNet: facts ? ARK_NETWORK in facts.networks : false,
    });
  }

  /** True when the manager runs in a container that ISN'T on ark-net — the setup
   *  that silently breaks name-based RCON. Null when we can't tell. */
  async managerMissingArkNet(): Promise<boolean | null> {
    const manager = await this.manager();
    if (!manager.inContainer || manager.hostNetwork) return false;
    if (!manager.networks.length) return null; // inspect denied — don't cry wolf
    return !manager.networks.includes(ARK_NETWORK);
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
    const unknown: ManagerNetworkFacts = { inContainer: false, hostNetwork: false, networks: [] };
    try {
      const id = await findSelfContainerId(this.docker.client);
      if (!id) return unknown; // not in a container (dev on the host)
      const info = await this.docker.inspect(id);
      const networks = Object.keys(info.NetworkSettings?.Networks ?? {});
      const facts: ManagerNetworkFacts = {
        inContainer: true,
        hostNetwork: info.HostConfig?.NetworkMode === "host" || networks.includes("host"),
        networks,
      };
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
  };
}
