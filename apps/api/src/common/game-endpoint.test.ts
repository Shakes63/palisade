import { describe, it, expect } from "vitest";
import {
  ContainerNetworkFacts,
  ManagerNetworkFacts,
  explainEndpointFailure,
  gameBridgeNetwork,
  hostGatewayAddress,
  resolveGameEndpoint,
} from "./game-endpoint";

// GH #21: Palworld player counts go through RCON, and RCON's host used to be guessed
// from the global GAME_HOST_NETWORK flag. When the flag and the deployment disagreed
// the connection was attempted against a name nothing could resolve, and the user saw
// only `getaddrinfo ENOTFOUND palworld-…`. These cover the shapes that produced that.

const managerOnShared: ManagerNetworkFacts = {
  inContainer: true,
  hostNetwork: false,
  networks: ["palisade-net"],
  sharedNetwork: "palisade-net",
};
/** The misconfiguration behind #21: manager on the default bridge, not the shared bridge. */
const managerOffShared: ManagerNetworkFacts = {
  inContainer: true,
  hostNetwork: false,
  networks: ["bridge"],
  sharedNetwork: "palisade-net",
};
const managerOnHost: ManagerNetworkFacts = {
  inContainer: true,
  hostNetwork: true,
  networks: ["host"],
  sharedNetwork: "palisade-net",
};
const managerOnDevBox: ManagerNetworkFacts = {
  inContainer: false,
  hostNetwork: false,
  networks: [],
  sharedNetwork: "palisade-net",
};

const onShared = (ip: string | null, ports: ContainerNetworkFacts["ports"] = {}): ContainerNetworkFacts => ({
  networkMode: "palisade-net",
  networks: { "palisade-net": ip },
  ports,
});

const resolve = (facts: ContainerNetworkFacts | null, manager: ManagerNetworkFacts) =>
  resolveGameEndpoint({ facts, manager, containerPort: 7780, fallbackHost: "palworld-mysrv-abc123" });

describe("resolveGameEndpoint", () => {
  it("dials the container's shared-network IP when the manager shares that network", () => {
    // The fix: an IP needs no DNS, so this can't fail the way a name can.
    expect(resolve(onShared("172.20.0.5"), managerOnShared)).toEqual({
      host: "172.20.0.5",
      port: 7780,
      via: "shared-network",
    });
  });

  it("goes through the host gateway for a host-networked container", () => {
    const hostNetworked: ContainerNetworkFacts = { networkMode: "host", networks: { host: null }, ports: {} };
    expect(resolve(hostNetworked, managerOnShared)).toEqual({
      host: "host.docker.internal",
      port: 7780,
      via: "host-network",
    });
  });

  it("uses the published host port when the two share no network (the #21 setup)", () => {
    // Manager on `bridge`, game on `palisade-net`: the name would never resolve, but the
    // published port is reachable through the host, so RCON works anyway.
    const facts = onShared("172.20.0.5", { "7780/tcp": [{ HostIp: "0.0.0.0", HostPort: "7780" }] });
    expect(resolve(facts, managerOffShared)).toEqual({
      host: "host.docker.internal",
      port: 7780,
      via: "published-port",
    });
  });

  it("falls back to HostConfig.PortBindings when the runtime view is empty", () => {
    // Reported on #21 after the first fix shipped: the manager was off the shared network and
    // resolution still fell through to the container name even though the spec
    // publishes RCON. NetworkSettings.Ports is Docker's runtime view and isn't always
    // populated; the requested bindings say the same thing, so consult both.
    const facts: ContainerNetworkFacts = {
      networkMode: "palisade-net",
      networks: { "palisade-net": "172.20.0.5" },
      ports: {},
      requestedPorts: { "7780/tcp": [{ HostIp: "0.0.0.0", HostPort: "7780" }] },
    };
    expect(resolve(facts, managerOffShared)).toEqual({
      host: "host.docker.internal",
      port: 7780,
      via: "published-port",
    });
  });

  it("prefers the runtime binding over the requested one when they disagree", () => {
    const facts: ContainerNetworkFacts = {
      networkMode: "palisade-net",
      networks: { "palisade-net": "172.20.0.5" },
      ports: { "7780/tcp": [{ HostPort: "17780" }] },
      requestedPorts: { "7780/tcp": [{ HostPort: "7780" }] },
    };
    // The runtime value is what the host is actually listening on.
    expect(resolve(facts, managerOffShared)).toMatchObject({ port: 17780 });
  });

  it("honours a published port that differs from the container port", () => {
    const facts = onShared("172.20.0.5", { "7780/tcp": [{ HostPort: "17780" }] });
    expect(resolve(facts, managerOffShared)).toMatchObject({ port: 17780, via: "published-port" });
  });

  it("prefers the shared network over another shared network", () => {
    const facts: ContainerNetworkFacts = {
      networkMode: "palisade-net",
      networks: { other: "10.0.0.9", "palisade-net": "172.20.0.5" },
      ports: {},
    };
    expect(resolve(facts, { ...managerOnShared, networks: ["other", "palisade-net"] })).toMatchObject({
      host: "172.20.0.5",
    });
  });

  it("falls back to the container name when nothing is shared and nothing is published", () => {
    // Preserves the historical behaviour rather than breaking a setup we can't model.
    expect(resolve(onShared("172.20.0.5"), managerOffShared)).toEqual({
      host: "palworld-mysrv-abc123",
      port: 7780,
      via: "container-name",
    });
  });

  it("falls back to the container name when Docker tells us nothing", () => {
    // Locked-down socket-proxy or a container that vanished mid-probe.
    expect(resolve(null, managerOnShared)).toEqual({
      host: "palworld-mysrv-abc123",
      port: 7780,
      via: "container-name",
    });
  });

  it("ignores a shared network the container has no IP on", () => {
    // A created-but-not-started container has the network with an empty IP.
    const facts = onShared("", { "7780/tcp": [{ HostPort: "7780" }] });
    expect(resolve(facts, managerOnShared)).toMatchObject({ via: "published-port" });
  });

  it("matches the port's own protocol, not just its number", () => {
    // A UDP query port published as UDP must not be found under tcp (and vice versa).
    const facts = onShared(null, { "27015/udp": [{ HostPort: "27015" }] });
    const udp = resolveGameEndpoint({
      facts,
      manager: managerOffShared,
      containerPort: 27015,
      protocol: "udp",
      fallbackHost: "ark-x",
    });
    const tcp = resolveGameEndpoint({
      facts,
      manager: managerOffShared,
      containerPort: 27015,
      protocol: "tcp",
      fallbackHost: "ark-x",
    });
    expect(udp.via).toBe("published-port");
    expect(tcp.via).toBe("container-name");
  });
});

describe("hostGatewayAddress", () => {
  it("uses the host gateway from inside a bridged container", () => {
    expect(hostGatewayAddress(managerOnShared)).toBe("host.docker.internal");
  });
  it("uses loopback when the manager is on the host network", () => {
    expect(hostGatewayAddress(managerOnHost)).toBe("127.0.0.1");
  });
  it("uses loopback in dev, where the manager isn't containerised at all", () => {
    // host.docker.internal doesn't exist outside Docker — this made dev probes fail too.
    expect(hostGatewayAddress(managerOnDevBox)).toBe("127.0.0.1");
  });
});

describe("explainEndpointFailure", () => {
  const dns = Object.assign(new Error("getaddrinfo ENOTFOUND palworld-mysrv-abc123"), {
    code: "ENOTFOUND",
  });
  const byName = { host: "palworld-mysrv-abc123", port: 7780, via: "container-name" } as const;

  it("names the missing shared-network attachment as the cause", () => {
    const hint = explainEndpointFailure({
      error: dns,
      endpoint: byName,
      manager: managerOffShared,
      gameNetwork: "palisade-net",
    });
    expect(hint).toContain("not attached");
    expect(hint).toContain("docker network connect palisade-net");
  });

  it("names the manager's actual container so the command is copy-pasteable", () => {
    // "<manager container>" made the user go find the name themselves (#21 follow-up).
    const hint = explainEndpointFailure({
      error: dns,
      endpoint: byName,
      manager: { ...managerOffShared, name: "palisade" },
      gameNetwork: "palisade-net",
    });
    expect(hint).toContain("docker network connect palisade-net palisade");
    expect(hint).not.toContain("<manager container>");
  });

  it("keeps a placeholder when the manager's name is unknown", () => {
    expect(
      explainEndpointFailure({ error: dns, endpoint: byName, manager: managerOffShared, gameNetwork: "palisade-net" }),
    ).toContain("<manager container>");
  });

  it("explains a name failure when the container is off the shared network entirely", () => {
    const hint = explainEndpointFailure({
      error: dns,
      endpoint: byName,
      manager: managerOnShared,
      gameNetwork: null,
    });
    expect(hint).toContain("did not resolve");
    expect(hint).not.toContain("docker network connect");
  });

  it("points at the missing --add-host when the host gateway is unresolvable", () => {
    const err = Object.assign(new Error("getaddrinfo ENOTFOUND host.docker.internal"), {
      code: "ENOTFOUND",
    });
    const hint = explainEndpointFailure({
      error: err,
      endpoint: { host: "host.docker.internal", port: 7780, via: "host-network" },
      manager: managerOnShared,
      gameNetwork: null,
    });
    expect(hint).toContain("host-gateway");
  });

  // GH #31: manager on an Unraid custom/macvlan network. Such a container is isolated
  // from the Docker host AND from Docker's bridges, so every candidate address is
  // unroutable — the user saw a bare "EHOSTUNREACH 172.17.0.1" with no explanation.
  it("explains a no-route failure via the host gateway (macvlan manager)", () => {
    const err = Object.assign(new Error("connect EHOSTUNREACH 172.17.0.1:27020"), {
      code: "EHOSTUNREACH",
    });
    const hint = explainEndpointFailure({
      error: err,
      endpoint: { host: "host.docker.internal", port: 27020, via: "host-network" },
      manager: { ...managerOffShared, networks: ["br0"], name: "palisade" },
      gameNetwork: null,
    });
    expect(hint).toContain("no route");
    expect(hint).toContain("macvlan");
    expect(hint).toContain("docker network connect palisade-net palisade");
    expect(hint).toContain("GAME_HOST_NETWORK=false");
  });

  it("explains a no-route failure to a container IP without the host-network advice", () => {
    // Bridge mode, manager elsewhere: attaching to the shared network is the fix, but telling
    // them to set GAME_HOST_NETWORK=false would be nonsense — they already have.
    const err = Object.assign(new Error("connect EHOSTUNREACH 172.19.0.3:27020"), {
      code: "EHOSTUNREACH",
    });
    const hint = explainEndpointFailure({
      error: err,
      endpoint: { host: "172.19.0.3", port: 27020, via: "shared-network" },
      manager: { ...managerOffShared, networks: ["br0"], name: "palisade" },
      gameNetwork: "palisade-net",
    });
    expect(hint).toContain("no route");
    expect(hint).toContain("docker network connect palisade-net palisade");
    expect(hint).not.toContain("GAME_HOST_NETWORK=false");
  });

  it("treats ENETUNREACH the same as EHOSTUNREACH", () => {
    const err = Object.assign(new Error("connect ENETUNREACH"), { code: "ENETUNREACH" });
    expect(
      explainEndpointFailure({
        error: err,
        endpoint: { host: "172.17.0.1", port: 27020, via: "published-port" },
        manager: managerOffShared,
        gameNetwork: null,
      }),
    ).toContain("no route");
  });

  it("distinguishes a refused connection from an addressing problem", () => {
    const err = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    const hint = explainEndpointFailure({
      error: err,
      endpoint: { host: "172.20.0.5", port: 7780, via: "shared-network" },
      manager: managerOnShared,
      gameNetwork: "palisade-net",
    });
    expect(hint).toContain("nothing is listening on 172.20.0.5:7780");
  });

  it("stays silent about failures that aren't ours to explain", () => {
    // A wrong RCON password isn't an addressing problem — don't editorialise.
    const hint = explainEndpointFailure({
      error: new Error("Authentication failed"),
      endpoint: { host: "172.20.0.5", port: 7780, via: "shared-network" },
      manager: managerOnShared,
      gameNetwork: "palisade-net",
    });
    expect(hint).toBeNull();
  });
});

// The move off "ark-net" (GH #31 follow-up) recreates each server on the new bridge
// as it is restarted, so an install spends real time with servers on both. Resolution
// has to work either way round, and any advice has to name the network the server is
// ACTUALLY on rather than the one new servers would get.
describe("during the ark-net → palisade-net migration", () => {
  const managerOnBoth: ManagerNetworkFacts = {
    inContainer: true,
    hostNetwork: false,
    networks: ["br0", "palisade-net", "ark-net"],
    sharedNetwork: "palisade-net",
    name: "Palisade",
  };
  const stillOnLegacy: ContainerNetworkFacts = {
    networkMode: "ark-net",
    networks: { "ark-net": "172.19.0.7" },
    ports: {},
  };

  it("reaches a not-yet-migrated server on the old bridge", () => {
    expect(resolve(stillOnLegacy, managerOnBoth)).toEqual({
      host: "172.19.0.7",
      port: 7780,
      via: "shared-network",
    });
  });

  it("prefers the new bridge for a server that has moved", () => {
    const onBoth: ContainerNetworkFacts = {
      networkMode: "palisade-net",
      networks: { "ark-net": "172.19.0.7", "palisade-net": "172.22.0.4" },
      ports: {},
    };
    expect(resolve(onBoth, managerOnBoth)).toMatchObject({ host: "172.22.0.4" });
  });

  it("names the old network in the fix when that is where the server sits", () => {
    // Telling someone to connect to palisade-net would not make them meet.
    const hint = explainEndpointFailure({
      error: Object.assign(new Error("getaddrinfo ENOTFOUND palworld-mysrv-abc123"), {
        code: "ENOTFOUND",
      }),
      endpoint: { host: "palworld-mysrv-abc123", port: 7780, via: "container-name" },
      manager: { ...managerOnBoth, networks: ["br0", "palisade-net"] },
      gameNetwork: "ark-net",
    });
    expect(hint).toContain("docker network connect ark-net Palisade");
  });

  describe("gameBridgeNetwork", () => {
    it("picks the new bridge over the old one", () => {
      const onBoth: ContainerNetworkFacts = {
        networkMode: "palisade-net",
        networks: { "ark-net": "172.19.0.7", "palisade-net": "172.22.0.4" },
        ports: {},
      };
      expect(gameBridgeNetwork(onBoth, managerOnBoth)).toBe("palisade-net");
    });

    it("reports the old bridge for a server that has not moved yet", () => {
      expect(gameBridgeNetwork(stillOnLegacy, managerOnBoth)).toBe("ark-net");
    });

    it("has nothing to name for a host-networked or invisible container", () => {
      const hostNetworked: ContainerNetworkFacts = {
        networkMode: "host",
        networks: { host: null },
        ports: {},
      };
      expect(gameBridgeNetwork(hostNetworked, managerOnBoth)).toBeNull();
      expect(gameBridgeNetwork(null, managerOnBoth)).toBeNull();
    });
  });
});
