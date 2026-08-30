import { describe, it, expect } from "vitest";
import {
  NetworkPlanInput,
  dockerViaProxy,
  legacyMigrationNote,
  legacyStillNeeded,
  shouldLeaveLegacy,
  targetNetwork,
} from "./shared-network";

// GH #31 follow-up. Unraid builds a container's WebUI link from the FIRST of its
// networks (`reset($ct['Networks'])`, sorted by name), so once Palisade attached
// itself to "ark-net" the button on a custom/macvlan install pointed at the bridge
// IP instead of the LAN one. The network is named "palisade-net" so it sorts after
// br0/bond0/eth0 — but only once the manager has actually let go of the old one,
// which is what these rules decide.

/** Migration finished: manager on both networks, nothing left behind. */
const done: NetworkPlanInput = {
  managerNetworks: ["br0", "palisade-net", "ark-net"],
  legacyServers: 0,
  otherOnLegacy: false,
  dockerViaProxy: false,
};

describe("targetNetwork", () => {
  it("defaults to the name chosen to sort after Unraid's interface networks", () => {
    expect(targetNetwork()).toBe("palisade-net");
    // The whole point of the rename: it must lose an alphabetical sort to br0 etc.
    expect(["bond0", "br0", "br0.10", "eth0"].every((n) => n < targetNetwork())).toBe(true);
  });

  it("honours an explicit SHARED_NETWORK", () => {
    expect(targetNetwork("my-net")).toBe("my-net");
  });

  it("treats a blank override as unset", () => {
    // Unraid passes empty template fields as empty strings, not absent vars (GH #6).
    expect(targetNetwork("")).toBe("palisade-net");
    expect(targetNetwork("   ")).toBe("palisade-net");
    expect(targetNetwork(null)).toBe("palisade-net");
  });
});

describe("dockerViaProxy", () => {
  it("recognises the mounted socket", () => {
    expect(dockerViaProxy("unix:///var/run/docker.sock")).toBe(false);
    expect(dockerViaProxy("UNIX:///var/run/docker.sock")).toBe(false);
  });

  it("treats anything else as a proxy we might be talking to over the old network", () => {
    expect(dockerViaProxy("tcp://socket-proxy:2375")).toBe(true);
  });
});

describe("shouldLeaveLegacy", () => {
  it("drops the old endpoint once every server has moved", () => {
    expect(shouldLeaveLegacy(done)).toBe(true);
  });

  it("keeps it while any server is still on the old network", () => {
    expect(shouldLeaveLegacy({ ...done, legacyServers: 1 })).toBe(false);
  });

  it("keeps it when a container that isn't ours is using it", () => {
    // The socket-proxy setup the README used to describe puts one there.
    expect(shouldLeaveLegacy({ ...done, otherOnLegacy: true })).toBe(false);
  });

  it("keeps it whenever Docker itself is reached over TCP", () => {
    // Disconnecting could be the last thing this manager ever does: if the proxy
    // answers on that network, it takes Docker access with it.
    expect(shouldLeaveLegacy({ ...done, dockerViaProxy: true })).toBe(false);
  });

  it("never strands the manager by leaving before it has joined the new network", () => {
    expect(shouldLeaveLegacy({ ...done, managerNetworks: ["br0", "ark-net"] })).toBe(false);
  });

  it("does nothing when the manager was never on the old network", () => {
    expect(shouldLeaveLegacy({ ...done, managerNetworks: ["br0", "palisade-net"] })).toBe(false);
  });

  it("stands down when the user pinned SHARED_NETWORK to the old name", () => {
    expect(shouldLeaveLegacy({ ...done, override: "ark-net" })).toBe(false);
  });
});

describe("legacyStillNeeded", () => {
  it("is true if there is any reason at all to keep the old network", () => {
    expect(legacyStillNeeded(done)).toBe(false);
    expect(legacyStillNeeded({ ...done, legacyServers: 2 })).toBe(true);
    expect(legacyStillNeeded({ ...done, otherOnLegacy: true })).toBe(true);
    expect(legacyStillNeeded({ ...done, dockerViaProxy: true })).toBe(true);
  });
});

describe("legacyMigrationNote", () => {
  it("tells the admin the one thing that finishes the move", () => {
    const note = legacyMigrationNote({ ...done, legacyServers: 3 });
    expect(note).toContain("3 servers");
    expect(note).toContain("Restarting");
    expect(note).toContain("palisade-net");
  });

  it("reads correctly for a single server", () => {
    const note = legacyMigrationNote({ ...done, legacyServers: 1 });
    expect(note).toContain("1 server still runs");
    expect(note).not.toContain("servers still");
  });

  it("names the blocker when the servers have moved but something else has not", () => {
    const note = legacyMigrationNote({ ...done, otherOnLegacy: true });
    expect(note).toContain("socket-proxy");
    expect(note).toContain("docker network disconnect ark-net");
  });

  it("says nothing once the manager is off the old network", () => {
    expect(legacyMigrationNote({ ...done, managerNetworks: ["br0", "palisade-net"] })).toBeNull();
  });

  it("says nothing when the old name is the configured one", () => {
    expect(legacyMigrationNote({ ...done, legacyServers: 2, override: "ark-net" })).toBeNull();
  });

  it("says nothing when there is nothing left to do", () => {
    // Manager still on both, but no servers and no blockers: shouldLeaveLegacy is
    // about to clear it, so don't put a chore in front of the user first.
    expect(legacyMigrationNote(done)).toBeNull();
  });
});
