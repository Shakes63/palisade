import { describe, it, expect, beforeEach, vi } from "vitest";
import { resetEnvCache } from "../config/env";
import { GameEndpointService } from "./game-endpoint.service";

// The only module seam that can't run here: finding our own container id reads
// /proc, and the tests are not in a container. Everything else is the real service.
vi.mock("../config/ensure-host-data-dir", async (orig) => ({
  ...(await orig<typeof import("../config/ensure-host-data-dir")>()),
  findSelfContainerId: async () => selfId,
}));

let selfId: string | null = "manager-id";

/**
 * GH #31 follow-up: the manager attaches itself to the shared bridge, and lets go of
 * the pre-1.11 "ark-net" one once nothing needs it — which is what restores the WebUI
 * link on an Unraid custom network. Detaching is the step that can do real damage
 * (drop the network a socket-proxy answers on and Docker access goes with it), so
 * every reason to stand down gets its own case here.
 */
class FakeDocker {
  networks: string[] = ["br0"];
  exists: boolean | null = true;
  legacyMembers: string[] | null = ["manager-id"];
  managedServers: string[] = [];
  connected: string[] = [];
  disconnected: string[] = [];
  client = {} as never;

  async inspect() {
    return {
      Name: "/Palisade",
      HostConfig: { NetworkMode: this.networks[0] },
      NetworkSettings: {
        Networks: Object.fromEntries(this.networks.map((n) => [n, { IPAddress: "172.20.0.2" }])),
      },
    } as never;
  }
  async networkExists(name: string) {
    return this.exists === true ? true : this.exists;
  }
  async connectToNetwork(name: string, id: string) {
    this.connected.push(name);
    this.networks.push(name);
    return true;
  }
  async disconnectFromNetwork(name: string, id: string) {
    this.disconnected.push(name);
    this.networks = this.networks.filter((n) => n !== name);
    return true;
  }
  async networkContainerIds() {
    return this.legacyMembers;
  }
  async listManagedServers() {
    return this.managedServers.map((id) => ({ id, serverId: id, running: true, status: "Up" }));
  }
}

const make = (docker: FakeDocker) => new GameEndpointService(docker as never);

beforeEach(() => {
  selfId = "manager-id";
  process.env.SECRETS_KEY = "a".repeat(64);
  process.env.JWT_SECRET = "b".repeat(32);
  process.env.DOCKER_HOST = "unix:///var/run/docker.sock";
  process.env.AUTO_CREATE_NETWORK = "true";
  delete process.env.SHARED_NETWORK;
  resetEnvCache();
});

describe("ensureManagerNetworks", () => {
  it("attaches the manager to the shared bridge, keeping its existing networks", async () => {
    const docker = new FakeDocker();
    expect(await make(docker).ensureManagerNetworks()).toBe(true);
    expect(docker.connected).toEqual(["palisade-net"]);
    // The macvlan case this exists for: br0 (and its static LAN IP) is untouched.
    expect(docker.networks).toContain("br0");
  });

  it("does nothing when the network doesn't exist yet", async () => {
    // A first server start creates it and calls back in; nothing to join before that.
    const docker = new FakeDocker();
    docker.exists = false;
    expect(await make(docker).ensureManagerNetworks()).toBe(false);
    expect(docker.connected).toEqual([]);
  });

  it("stands down entirely when AUTO_CREATE_NETWORK is off", async () => {
    process.env.AUTO_CREATE_NETWORK = "false";
    resetEnvCache();
    const docker = new FakeDocker();
    docker.networks = ["br0", "ark-net"];
    await make(docker).ensureManagerNetworks();
    expect(docker.connected).toEqual([]);
    expect(docker.disconnected).toEqual([]);
  });

  it("leaves a host-networked manager alone", async () => {
    const docker = new FakeDocker();
    docker.networks = ["host"];
    expect(await make(docker).ensureManagerNetworks()).toBe(false);
    expect(docker.connected).toEqual([]);
  });

  it("honours SHARED_NETWORK", async () => {
    process.env.SHARED_NETWORK = "my-net";
    resetEnvCache();
    const docker = new FakeDocker();
    await make(docker).ensureManagerNetworks();
    expect(docker.connected).toEqual(["my-net"]);
  });
});

describe("retiring the legacy network", () => {
  /** A mid-migration manager: on its LAN network and both bridges. */
  const migrating = () => {
    const docker = new FakeDocker();
    docker.networks = ["br0", "ark-net", "palisade-net"];
    return docker;
  };

  it("drops ark-net once no server is left on it", async () => {
    const docker = migrating();
    docker.legacyMembers = ["manager-id"];
    await make(docker).ensureManagerNetworks();
    expect(docker.disconnected).toEqual(["ark-net"]);
    expect(docker.networks).toEqual(["br0", "palisade-net"]);
  });

  it("keeps ark-net while a server still runs on it", async () => {
    const docker = migrating();
    docker.legacyMembers = ["manager-id", "server-1"];
    docker.managedServers = ["server-1"];
    await make(docker).ensureManagerNetworks();
    expect(docker.disconnected).toEqual([]);
  });

  it("keeps ark-net when a container that isn't ours is on it", async () => {
    // The documented socket-proxy setup put one there.
    const docker = migrating();
    docker.legacyMembers = ["manager-id", "some-other-container"];
    await make(docker).ensureManagerNetworks();
    expect(docker.disconnected).toEqual([]);
  });

  it("keeps ark-net whenever Docker is reached through a proxy", async () => {
    // Disconnecting could be the last thing this manager ever does.
    process.env.DOCKER_HOST = "tcp://socket-proxy:2375";
    resetEnvCache();
    const docker = migrating();
    await make(docker).ensureManagerNetworks();
    expect(docker.disconnected).toEqual([]);
  });

  it("keeps ark-net when Docker won't say who else is on it", async () => {
    const docker = migrating();
    docker.legacyMembers = null; // locked-down socket-proxy, or the network is gone
    await make(docker).ensureManagerNetworks();
    expect(docker.disconnected).toEqual([]);
  });

  it("joins the new network before leaving the old one, never both at once", async () => {
    // Starting state is the one every pre-1.11 install boots into.
    const docker = new FakeDocker();
    docker.networks = ["br0", "ark-net"];
    await make(docker).ensureManagerNetworks();
    expect(docker.connected).toEqual(["palisade-net"]);
    expect(docker.disconnected).toEqual(["ark-net"]);
    expect(docker.networks).toEqual(["br0", "palisade-net"]);
  });

  it("does not strand itself when the new network can't be joined", async () => {
    const docker = new FakeDocker();
    docker.networks = ["br0", "ark-net"];
    docker.exists = false; // palisade-net not created yet
    await make(docker).ensureManagerNetworks();
    expect(docker.disconnected).toEqual([]);
    expect(docker.networks).toContain("ark-net");
  });

  it("does nothing at all when it cannot identify its own container", async () => {
    selfId = null;
    const docker = migrating();
    await make(docker).ensureManagerNetworks();
    expect(docker.disconnected).toEqual([]);
  });
});

describe("migrationNote", () => {
  it("reports servers still to move", async () => {
    const docker = new FakeDocker();
    docker.networks = ["br0", "ark-net", "palisade-net"];
    docker.legacyMembers = ["manager-id", "server-1", "server-2"];
    docker.managedServers = ["server-1", "server-2"];
    expect(await make(docker).migrationNote()).toContain("2 servers");
  });

  it("says nothing on an install that was never on the legacy network", async () => {
    const docker = new FakeDocker();
    docker.networks = ["br0", "palisade-net"];
    docker.legacyMembers = null;
    expect(await make(docker).migrationNote()).toBeNull();
  });
});
