import { describe, it, expect } from "vitest";
import {
  ContainerNetworkFacts,
  ManagerNetworkFacts,
  explainEndpointFailure,
  hostGatewayAddress,
  resolveGameEndpoint,
} from "./game-endpoint";

// GH #21: Palworld player counts go through RCON, and RCON's host used to be guessed
// from the global GAME_HOST_NETWORK flag. When the flag and the deployment disagreed
// the connection was attempted against a name nothing could resolve, and the user saw
// only `getaddrinfo ENOTFOUND palworld-…`. These cover the shapes that produced that.

const managerOnArkNet: ManagerNetworkFacts = {
  inContainer: true,
  hostNetwork: false,
  networks: ["ark-net"],
};
/** The misconfiguration behind #21: manager on the default bridge, not ark-net. */
const managerOffArkNet: ManagerNetworkFacts = {
  inContainer: true,
  hostNetwork: false,
  networks: ["bridge"],
};
const managerOnHost: ManagerNetworkFacts = {
  inContainer: true,
  hostNetwork: true,
  networks: ["host"],
};
const managerOnDevBox: ManagerNetworkFacts = {
  inContainer: false,
  hostNetwork: false,
  networks: [],
};

const onArkNet = (ip: string | null, ports: ContainerNetworkFacts["ports"] = {}): ContainerNetworkFacts => ({
  networkMode: "ark-net",
  networks: { "ark-net": ip },
  ports,
});

const resolve = (facts: ContainerNetworkFacts | null, manager: ManagerNetworkFacts) =>
  resolveGameEndpoint({ facts, manager, containerPort: 7780, fallbackHost: "palworld-mysrv-abc123" });

describe("resolveGameEndpoint", () => {
  it("dials the container's ark-net IP when the manager shares that network", () => {
    // The fix: an IP needs no DNS, so this can't fail the way a name can.
    expect(resolve(onArkNet("172.20.0.5"), managerOnArkNet)).toEqual({
      host: "172.20.0.5",
      port: 7780,
      via: "shared-network",
    });
  });

  it("goes through the host gateway for a host-networked container", () => {
    const hostNetworked: ContainerNetworkFacts = { networkMode: "host", networks: { host: null }, ports: {} };
    expect(resolve(hostNetworked, managerOnArkNet)).toEqual({
      host: "host.docker.internal",
      port: 7780,
      via: "host-network",
    });
  });

  it("uses the published host port when the two share no network (the #21 setup)", () => {
    // Manager on `bridge`, game on `ark-net`: the name would never resolve, but the
    // published port is reachable through the host, so RCON works anyway.
    const facts = onArkNet("172.20.0.5", { "7780/tcp": [{ HostIp: "0.0.0.0", HostPort: "7780" }] });
    expect(resolve(facts, managerOffArkNet)).toEqual({
      host: "host.docker.internal",
      port: 7780,
      via: "published-port",
    });
  });

  it("falls back to HostConfig.PortBindings when the runtime view is empty", () => {
    // Reported on #21 after the first fix shipped: the manager was off ark-net and
    // resolution still fell through to the container name even though the spec
    // publishes RCON. NetworkSettings.Ports is Docker's runtime view and isn't always
    // populated; the requested bindings say the same thing, so consult both.
    const facts: ContainerNetworkFacts = {
      networkMode: "ark-net",
      networks: { "ark-net": "172.20.0.5" },
      ports: {},
      requestedPorts: { "7780/tcp": [{ HostIp: "0.0.0.0", HostPort: "7780" }] },
    };
    expect(resolve(facts, managerOffArkNet)).toEqual({
      host: "host.docker.internal",
      port: 7780,
      via: "published-port",
    });
  });

  it("prefers the runtime binding over the requested one when they disagree", () => {
    const facts: ContainerNetworkFacts = {
      networkMode: "ark-net",
      networks: { "ark-net": "172.20.0.5" },
      ports: { "7780/tcp": [{ HostPort: "17780" }] },
      requestedPorts: { "7780/tcp": [{ HostPort: "7780" }] },
    };
    // The runtime value is what the host is actually listening on.
    expect(resolve(facts, managerOffArkNet)).toMatchObject({ port: 17780 });
  });

  it("honours a published port that differs from the container port", () => {
    const facts = onArkNet("172.20.0.5", { "7780/tcp": [{ HostPort: "17780" }] });
    expect(resolve(facts, managerOffArkNet)).toMatchObject({ port: 17780, via: "published-port" });
  });

  it("prefers ark-net over another shared network", () => {
    const facts: ContainerNetworkFacts = {
      networkMode: "ark-net",
      networks: { other: "10.0.0.9", "ark-net": "172.20.0.5" },
      ports: {},
    };
    expect(resolve(facts, { ...managerOnArkNet, networks: ["other", "ark-net"] })).toMatchObject({
      host: "172.20.0.5",
    });
  });

  it("falls back to the container name when nothing is shared and nothing is published", () => {
    // Preserves the historical behaviour rather than breaking a setup we can't model.
    expect(resolve(onArkNet("172.20.0.5"), managerOffArkNet)).toEqual({
      host: "palworld-mysrv-abc123",
      port: 7780,
      via: "container-name",
    });
  });

  it("falls back to the container name when Docker tells us nothing", () => {
    // Locked-down socket-proxy or a container that vanished mid-probe.
    expect(resolve(null, managerOnArkNet)).toEqual({
      host: "palworld-mysrv-abc123",
      port: 7780,
      via: "container-name",
    });
  });

  it("ignores a shared network the container has no IP on", () => {
    // A created-but-not-started container has the network with an empty IP.
    const facts = onArkNet("", { "7780/tcp": [{ HostPort: "7780" }] });
    expect(resolve(facts, managerOnArkNet)).toMatchObject({ via: "published-port" });
  });

  it("matches the port's own protocol, not just its number", () => {
    // A UDP query port published as UDP must not be found under tcp (and vice versa).
    const facts = onArkNet(null, { "27015/udp": [{ HostPort: "27015" }] });
    const udp = resolveGameEndpoint({
      facts,
      manager: managerOffArkNet,
      containerPort: 27015,
      protocol: "udp",
      fallbackHost: "ark-x",
    });
    const tcp = resolveGameEndpoint({
      facts,
      manager: managerOffArkNet,
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
    expect(hostGatewayAddress(managerOnArkNet)).toBe("host.docker.internal");
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

  it("names the missing ark-net attachment as the cause", () => {
    const hint = explainEndpointFailure({
      error: dns,
      endpoint: byName,
      manager: managerOffArkNet,
      gameOnArkNet: true,
    });
    expect(hint).toContain("not attached");
    expect(hint).toContain("docker network connect ark-net");
  });

  it("names the manager's actual container so the command is copy-pasteable", () => {
    // "<manager container>" made the user go find the name themselves (#21 follow-up).
    const hint = explainEndpointFailure({
      error: dns,
      endpoint: byName,
      manager: { ...managerOffArkNet, name: "palisade" },
      gameOnArkNet: true,
    });
    expect(hint).toContain("docker network connect ark-net palisade");
    expect(hint).not.toContain("<manager container>");
  });

  it("keeps a placeholder when the manager's name is unknown", () => {
    expect(
      explainEndpointFailure({ error: dns, endpoint: byName, manager: managerOffArkNet, gameOnArkNet: true }),
    ).toContain("<manager container>");
  });

  it("explains a name failure when the container is off ark-net entirely", () => {
    const hint = explainEndpointFailure({
      error: dns,
      endpoint: byName,
      manager: managerOnArkNet,
      gameOnArkNet: false,
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
      manager: managerOnArkNet,
      gameOnArkNet: false,
    });
    expect(hint).toContain("host-gateway");
  });

  it("distinguishes a refused connection from an addressing problem", () => {
    const err = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    const hint = explainEndpointFailure({
      error: err,
      endpoint: { host: "172.20.0.5", port: 7780, via: "shared-network" },
      manager: managerOnArkNet,
      gameOnArkNet: true,
    });
    expect(hint).toContain("nothing is listening on 172.20.0.5:7780");
  });

  it("stays silent about failures that aren't ours to explain", () => {
    // A wrong RCON password isn't an addressing problem — don't editorialise.
    const hint = explainEndpointFailure({
      error: new Error("Authentication failed"),
      endpoint: { host: "172.20.0.5", port: 7780, via: "shared-network" },
      manager: managerOnArkNet,
      gameOnArkNet: true,
    });
    expect(hint).toBeNull();
  });
});
