import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { FakeDocker, makeRow, makeService, setupE2eEnv, startServer } from "./lifecycle-harness";
import { resetEnvCache } from "../config/env";

/**
 * GH #31: with GAME_HOST_NETWORK=false and no shared bridge, a start died on Docker's
 * raw "(HTTP code 404) no such container - network palisade-net not found" — which
 * reads like a container fault, not a missing prerequisite. Palisade now creates it,
 * and when it can't, says so in words the user can act on.
 */
beforeAll(async () => {
  await setupE2eEnv();
  process.env.GAME_HOST_NETWORK = "false"; // specs then carry a bridge EndpointsConfig
});

describe("shared-network preflight", () => {
  let docker: FakeDocker;
  beforeEach(() => {
    docker = new FakeDocker();
    process.env.AUTO_CREATE_NETWORK = "true";
    resetEnvCache(); // loadEnv memoizes; the flag is read at start time
  });

  it("creates the shared network when it is confirmed missing, and the start proceeds", async () => {
    docker.networkPresent = false;
    const row = makeRow();
    const { service } = await makeService(row, docker);
    await startServer(service, row.id);
    expect(docker.createdNetworks).toEqual(["palisade-net"]);
    expect(docker.createdSpecs.length).toBe(1);
  });

  it("does not touch Docker's networks when the shared network already exists", async () => {
    docker.networkPresent = true;
    const row = makeRow();
    const { service } = await makeService(row, docker);
    await startServer(service, row.id);
    expect(docker.createdNetworks).toEqual([]);
    expect(docker.createdSpecs.length).toBe(1);
  });

  it("starts anyway when it cannot ask (locked-down socket-proxy)", async () => {
    // The regression this guards: treating "couldn't list networks" as "missing"
    // would block every start on a working least-privilege install.
    docker.networkPresent = null;
    docker.networkCreateFails = true;
    const row = makeRow();
    const { service } = await makeService(row, docker);
    await startServer(service, row.id);
    expect(docker.createdNetworks).toEqual([]);
    expect(docker.createdSpecs.length).toBe(1);
  });

  it("fails with an actionable message when creation is refused", async () => {
    docker.networkPresent = false;
    docker.networkCreateFails = true;
    const row = makeRow();
    const { service } = await makeService(row, docker);
    await expect(startServer(service, row.id)).rejects.toThrow(/docker network create palisade-net/);
    // Nothing was created — the start stopped at the preflight, not mid-launch.
    expect(docker.createdSpecs.length).toBe(0);
  });

  it("respects AUTO_CREATE_NETWORK=false — explains instead of creating", async () => {
    process.env.AUTO_CREATE_NETWORK = "false";
    resetEnvCache();
    docker.networkPresent = false;
    const row = makeRow();
    const { service } = await makeService(row, docker);
    await expect(startServer(service, row.id)).rejects.toThrow(/does not exist/);
    expect(docker.createdNetworks).toEqual([]);
  });
});
