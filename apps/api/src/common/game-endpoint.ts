import { ARK_NETWORK } from "./naming";

/**
 * Where the manager should connect to reach a game container's admin port (RCON,
 * a status HTTP endpoint, the A2S query port…).
 *
 * Historically every call site guessed this from the global GAME_HOST_NETWORK flag:
 * host networking → `host.docker.internal`, otherwise the container name resolved
 * over Docker's embedded DNS on ark-net. That guess is only right when the whole
 * deployment matches the flag, and nothing verified it — so a manager that isn't
 * actually attached to ark-net (Unraid's template Network field is easy to change),
 * or a container created while the flag had the other value, failed with a bare
 * `getaddrinfo ENOTFOUND palworld-…` and no indication of why (GH #21).
 *
 * We now derive it from what the container actually IS, which is knowable: one
 * inspect tells us its network mode, its IPs, and its published ports.
 */

/** The subset of `docker inspect` this resolution needs. */
export interface ContainerNetworkFacts {
  /** HostConfig.NetworkMode — "host", "bridge", a network name, "container:…". */
  networkMode: string;
  /** NetworkSettings.Networks — network name → the container's IP on it. */
  networks: Record<string, string | null>;
  /** NetworkSettings.Ports — "7780/tcp" → host bindings (empty/absent = unpublished).
   *  The RUNTIME view of publishing. */
  ports: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null>;
  /** HostConfig.PortBindings — the same mapping as REQUESTED at create time. Docker
   *  normally mirrors it into NetworkSettings.Ports once running, but not on every
   *  version/runtime (and not at all before start), so we consult both before
   *  concluding a port isn't published. */
  requestedPorts?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null>;
}

/** What the manager itself is attached to, so we know what it can reach. */
export interface ManagerNetworkFacts {
  /** False when the manager runs outside Docker (dev) — then the host IS localhost. */
  inContainer: boolean;
  /** True when the manager container itself uses host networking. */
  hostNetwork: boolean;
  /** Names of the Docker networks the manager is attached to. */
  networks: string[];
  /** The manager's own container name, so a suggested fix is copy-pasteable rather
   *  than a `<placeholder>` the user has to go look up. */
  name?: string | null;
}

export interface ResolvedEndpoint {
  host: string;
  port: number;
  /** How we got here — surfaced in errors/logs so a bad setup explains itself. */
  via: "host-network" | "shared-network" | "published-port" | "container-name";
}

/**
 * The host-side address of a port bound on the Docker host. A manager on the host
 * network (or outside Docker entirely) reaches it on loopback; one inside a bridge
 * needs the host gateway, which requires `--add-host host.docker.internal:host-gateway`.
 */
export function hostGatewayAddress(manager: ManagerNetworkFacts): string {
  return !manager.inContainer || manager.hostNetwork ? "127.0.0.1" : "host.docker.internal";
}

/** True when the container runs in the host's network namespace. */
function usesHostNetwork(c: ContainerNetworkFacts): boolean {
  return c.networkMode === "host" || "host" in c.networks;
}

/**
 * The first network both ends share, preferring ark-net. Connecting to the
 * container's IP on a shared network skips Docker's embedded DNS entirely — which
 * is the specific thing that was failing — and works even if the container was
 * renamed out from under us.
 */
function sharedNetworkIp(c: ContainerNetworkFacts, manager: ManagerNetworkFacts): string | null {
  const shared = Object.keys(c.networks).filter((n) => manager.networks.includes(n));
  const preferred = shared.includes(ARK_NETWORK) ? ARK_NETWORK : shared[0];
  const ip = preferred ? c.networks[preferred] : null;
  return ip || null;
}

/** The host port `containerPort` is published on, if any. */
function publishedPort(c: ContainerNetworkFacts, containerPort: number, proto: "tcp" | "udp"): number | null {
  const key = `${containerPort}/${proto}`;
  const binding = c.ports[key]?.[0]?.HostPort ?? c.requestedPorts?.[key]?.[0]?.HostPort;
  const port = binding ? Number(binding) : NaN;
  return Number.isFinite(port) && port > 0 ? port : null;
}

/**
 * Resolve the address to reach `containerPort` on a game container.
 *
 * Ordered most- to least-direct; each step is only taken when we can see it will
 * work, so we degrade toward the old container-name behaviour rather than failing
 * outright when Docker tells us nothing (`facts` null — inspect denied or the
 * container is gone).
 */
export function resolveGameEndpoint(input: {
  facts: ContainerNetworkFacts | null;
  manager: ManagerNetworkFacts;
  containerPort: number;
  protocol?: "tcp" | "udp";
  /** Container name, used as the last resort (and when we can't inspect). */
  fallbackHost: string;
}): ResolvedEndpoint {
  const { facts, manager, containerPort, fallbackHost } = input;
  const protocol = input.protocol ?? "tcp";
  if (!facts) return { host: fallbackHost, port: containerPort, via: "container-name" };

  // Host networking: the game binds straight onto the host, so go via the host side.
  if (usesHostNetwork(facts)) {
    return { host: hostGatewayAddress(manager), port: containerPort, via: "host-network" };
  }

  // Same network as us: dial the container's IP directly, no DNS involved.
  const ip = sharedNetworkIp(facts, manager);
  if (ip) return { host: ip, port: containerPort, via: "shared-network" };

  // Different networks, but the port is published — reach it through the host.
  const published = publishedPort(facts, containerPort, protocol);
  if (published) {
    return { host: hostGatewayAddress(manager), port: published, via: "published-port" };
  }

  // Nothing verifiable left. Keep the historical behaviour so a working, unusual
  // setup we failed to model isn't broken by this change.
  return { host: fallbackHost, port: containerPort, via: "container-name" };
}

/**
 * Why a connection to a resolved endpoint could not be made, in terms the user can
 * act on. Returns null when the failure isn't one of the addressing problems we can
 * explain (a wrong password or a server that isn't listening yet is not our business).
 */
export function explainEndpointFailure(input: {
  error: Error;
  endpoint: ResolvedEndpoint;
  manager: ManagerNetworkFacts;
  gameOnArkNet: boolean;
}): string | null {
  const { endpoint, manager, gameOnArkNet } = input;
  const code = (input.error as NodeJS.ErrnoException).code;
  const dnsFailure = code === "ENOTFOUND" || code === "EAI_AGAIN";

  if (dnsFailure && endpoint.via === "container-name") {
    if (gameOnArkNet && manager.inContainer && !manager.networks.includes(ARK_NETWORK)) {
      return `the manager container is not attached to the "${ARK_NETWORK}" network, so it cannot resolve game containers by name, and this server's RCON port is not published to the host either — run: docker network connect ${ARK_NETWORK} ${manager.name || "<manager container>"} (on Unraid: edit the Palisade container and set Network Type to ${ARK_NETWORK}), then restart this server`;
    }
    return `the name "${endpoint.host}" did not resolve — the game container is not on a network this manager shares, and its port is not published to the host`;
  }

  if (dnsFailure && endpoint.host === "host.docker.internal") {
    return "host.docker.internal did not resolve — start the manager with `--add-host host.docker.internal:host-gateway` (required when game servers use host networking)";
  }

  if (code === "ECONNREFUSED") {
    return `nothing is listening on ${endpoint.host}:${endpoint.port} — the server may still be starting, or RCON may be disabled/bound to a different port`;
  }

  return null;
}
