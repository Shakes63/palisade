import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { resetEnvCache } from "../config/env";
import { sameContainerId } from "../common/shared-network";
import { LEGACY_NETWORK } from "../common/naming";

// The manager finds itself by hostname, which the test process doesn't have. Point
// it at the "manager" container this file creates, by the SHORT id — because that is
// what a real container's hostname is, and matching it against the FULL ids Docker
// reports elsewhere is precisely the bug this tier exists to catch.
let selfId: string | null = null;
vi.mock("../config/ensure-host-data-dir", async (orig) => ({
  ...(await orig<typeof import("../config/ensure-host-data-dir")>()),
  findSelfContainerId: async () => selfId,
}));

import { DockerService } from "./docker.service";
import { GameEndpointService } from "./game-endpoint.service";

/**
 * Against a REAL Docker daemon. Everything the fast suite fakes, this checks.
 *
 * Every fact pinned here was learned the hard way — shipped, then found on a live
 * Unraid box after 500+ unit tests had passed:
 *   - `docker network inspect` names members by their full 64-char id, while a
 *     container's hostname (how the manager knows itself) is the 12-char short one.
 *   - The API JSON-sorts a container's network map by name, whatever the attach
 *     order — which is why the shared network is called what it is.
 *   - Membership lists live endpoints only.
 * A fake that agrees with the code proves nothing about the daemon.
 *
 * Gated: PALISADE_DOCKER_TESTS=1 is consent to touch the local daemon. The suite
 * creates uniquely-named networks and containers, removes them all afterwards, and
 * will not touch a pre-existing "ark-net" — that name is hard-coded in the code
 * under test and might be somebody's real one.
 */
const enabled = process.env.PALISADE_DOCKER_TESTS === "1";
const run = randomBytes(3).toString("hex");
const nm = (s: string) => `palisade-it-${run}-${s}`;
const IMAGE = "alpine:3.20";

let docker: DockerService;
const madeContainers: string[] = [];
const madeNetworks: string[] = [];

async function network(name: string): Promise<string> {
  await docker.client.createNetwork({ Name: name, Driver: "bridge", CheckDuplicate: true });
  madeNetworks.push(name);
  return name;
}

async function container(name: string, primaryNetwork: string): Promise<string> {
  const id = await docker.createContainer({
    name,
    Image: IMAGE,
    Cmd: ["sleep", "600"],
    HostConfig: { NetworkMode: primaryNetwork, AutoRemove: false },
  });
  madeContainers.push(id);
  await docker.start(id);
  return id;
}

const networksOf = async (id: string): Promise<string[]> =>
  Object.keys((await docker.inspect(id)).NetworkSettings?.Networks ?? {});

describe.skipIf(!enabled)("against a real Docker daemon", () => {
  beforeAll(async () => {
    process.env.SECRETS_KEY = "a".repeat(64);
    process.env.JWT_SECRET = "b".repeat(32);
    process.env.DOCKER_HOST = "unix:///var/run/docker.sock";
    process.env.AUTO_CREATE_NETWORK = "true";
    resetEnvCache();
    docker = new DockerService();
    expect(await docker.ping()).toBe(true);
    await docker.pullImage(IMAGE);
  });

  afterAll(async () => {
    for (const id of madeContainers) await docker.remove(id, true).catch(() => undefined);
    for (const n of madeNetworks.reverse()) {
      await docker.client.getNetwork(n).remove().catch(() => undefined);
    }
  });

  describe("DockerService primitives", () => {
    it("reports a network as absent, then present once created, and creates idempotently", async () => {
      const name = nm("exists");
      expect(await docker.networkExists(name)).toBe(false);
      expect(await docker.createBridgeNetwork(name)).toBe(true);
      madeNetworks.push(name);
      expect(await docker.networkExists(name)).toBe(true);
      // A concurrent create that lost the race is still success.
      expect(await docker.createBridgeNetwork(name)).toBe(true);
    });

    it("attaches, sees, and detaches a live container", async () => {
      const home = await network(nm("home"));
      const extra = await network(nm("extra"));
      const id = await container(nm("c1"), home);

      expect(await docker.containerOnNetwork(extra, id)).toBe(false);
      expect(await docker.connectToNetwork(extra, id)).toBe(true);
      expect(await docker.containerOnNetwork(extra, id)).toBe(true);
      // Attaching twice is "already done", not a failure.
      expect(await docker.connectToNetwork(extra, id)).toBe(true);
      expect(await docker.disconnectFromNetwork(extra, id)).toBe(true);
      expect(await docker.containerOnNetwork(extra, id)).toBe(false);
      // And the original network was never touched.
      expect(await networksOf(id)).toEqual([home]);
    });

    it("lists network members by FULL id, which is not what a container calls itself", async () => {
      // The bug: `id !== selfId` compared this 64-char id to a 12-char hostname.
      const net = await network(nm("members"));
      const id = await container(nm("c2"), net);
      const members = await docker.networkContainerIds(net);
      expect(members).toEqual([id]);
      expect(id).toHaveLength(64);

      const hostname = (await docker.inspect(id)).Config?.Hostname;
      expect(hostname).toBe(id.slice(0, 12)); // Docker's default: hostname = short id
      expect(sameContainerId(id, hostname)).toBe(true); // the fix, against real values
      expect(members![0] === hostname).toBe(false); // the naive comparison, still wrong
    });

    it("returns null, not empty, for a network it cannot inspect", async () => {
      // Null is load-bearing: acting on it would let the manager abandon a network
      // that is still in use.
      expect(await docker.networkContainerIds(nm("never-created"))).toBeNull();
    });
  });

  describe("facts the shared-network rename depends on", () => {
    it("JSON-sorts a container's networks by name regardless of attach order", async () => {
      // Unraid builds a container's WebUI link from the FIRST network in this map.
      // "ark-net" sorted ahead of "br0" and took the link with it; "palisade-net"
      // sorts after. That only holds if Docker really does sort — so pin it.
      const primary = await network(nm("zz-primary"));
      const second = await network(nm("aa-second"));
      const id = await container(nm("c3"), primary);
      await docker.connectToNetwork(second, id);

      // Read the raw JSON the API returns, not a Map that might re-order.
      const raw = (await docker.client.getContainer(id).inspect()) as {
        NetworkSettings: { Networks: Record<string, unknown> };
      };
      const keys = Object.keys(raw.NetworkSettings.Networks);
      expect(keys).toEqual([second, primary]); // attached second, listed first
    });
  });

  describe("the migration off ark-net, end to end", () => {
    // Skipped, not failed, if the host already has an ark-net: that could be a real
    // install's network, and this test attaches and detaches things to it.
    let legacyPreexisted = false;
    let target: string;

    beforeAll(async () => {
      legacyPreexisted = (await docker.networkExists(LEGACY_NETWORK)) === true;
      target = nm("shared");
      process.env.SHARED_NETWORK = target;
      resetEnvCache();
      await network(target);
    });

    const settings = { getAutoCreateNetwork: async () => null } as never;
    const service = () => new GameEndpointService(docker, settings);

    it("joins the new network and leaves ark-net once nothing else needs it", async (ctx) => {
      if (legacyPreexisted) return ctx.skip();
      await network(LEGACY_NETWORK);
      const lan = await network(nm("lan"));
      const manager = await container(nm("manager"), lan);
      await docker.connectToNetwork(LEGACY_NETWORK, manager);
      selfId = manager.slice(0, 12); // what the manager's own hostname would be

      expect(await service().ensureManagerNetworks()).toBe(true);

      const after = await networksOf(manager);
      expect(after).toContain(target);
      expect(after).toContain(lan); // the LAN network is never touched
      expect(after).not.toContain(LEGACY_NETWORK); // retired: it was alone there
    });

    it("keeps ark-net while a container that is not ours is still on it", async (ctx) => {
      if (legacyPreexisted) return ctx.skip();
      // Fresh manager on both bridges, plus a stranger on the legacy one.
      const lan = await network(nm("lan2"));
      const manager = await container(nm("manager2"), lan);
      await docker.connectToNetwork(LEGACY_NETWORK, manager);
      await docker.connectToNetwork(target, manager);
      await container(nm("stranger"), LEGACY_NETWORK);
      selfId = manager.slice(0, 12);

      await service().ensureManagerNetworks();

      expect(await networksOf(manager)).toContain(LEGACY_NETWORK);
      // And it can name the blocker.
      expect(await service().migrationNote()).toMatch(/another container/);
    });
  });
});
