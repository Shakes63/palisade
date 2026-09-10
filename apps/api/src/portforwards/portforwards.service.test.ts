import { describe, expect, it, vi } from "vitest";
import { PortForwardsService } from "./portforwards.service";
import type { RouterClient, RouterRule } from "./router";

/** An in-memory router: rules live in an array and every write is recorded. */
function fakeRouter(initial: RouterRule[], targetIp = "10.0.0.5") {
  const rules = [...initial];
  const calls: string[] = [];
  let seq = 100;
  const client: RouterClient = {
    kind: "unifi",
    host: "10.0.0.1",
    targetIp,
    list: async () => rules.map((r) => ({ ...r })),
    wanIp: async () => "203.0.113.9",
    describe: async () => `${rules.length} rules`,
    create: async (f, description) => {
      calls.push(`create ${f.port}/${f.proto}`);
      rules.push({
        id: String(seq++),
        name: description,
        proto: f.proto,
        ports: String(f.port),
        target: targetIp,
        enabled: true,
      });
    },
    retarget: async (rule) => {
      calls.push(`retarget ${rule.id}`);
      rules.find((r) => r.id === rule.id)!.target = targetIp;
    },
    setEnabled: async (rule, enabled) => {
      calls.push(`setEnabled ${rule.id} ${enabled}`);
      rules.find((r) => r.id === rule.id)!.enabled = enabled;
    },
    remove: async (doomed) => {
      for (const d of doomed) {
        calls.push(`remove ${d.id}`);
        rules.splice(rules.findIndex((r) => r.id === d.id), 1);
      }
    },
    commit: async () => {
      calls.push("commit");
    },
  };
  return { client, calls, rules };
}

/** Valheim: 2456/udp game, 2457/udp query, 2458/udp crossplay. */
const valheim = {
  id: "srv1",
  name: "Vikings",
  game: "VALHEIM",
  gamePort: 2456,
  rawSocketPort: 2458,
  queryPort: 2457,
  rconPort: 0,
};

function service(router: ReturnType<typeof fakeRouter> | null, others: (typeof valheim)[] = []) {
  const prisma = { server: { findUnique: vi.fn(async () => valheim), findMany: vi.fn(async () => others) } };
  const settings = { get: vi.fn(async (key: string) => (key === "port_forward_router" ? "unifi" : null)) };
  const svc = new PortForwardsService(prisma as never, settings as never);
  // Bypass settings → client construction; the fake stands in for a real router.
  (svc as unknown as { client: () => Promise<RouterClient | null> }).client = async () => router?.client ?? null;
  return svc;
}

describe("PortForwardsService", () => {
  it("reports unconfigured without touching the router", async () => {
    const view = await service(null).status("srv1");
    expect(view.configured).toBe(false);
    expect(view.router).toBe("unifi");
    expect(view.forwards.map((f) => f.state)).toEqual(["missing", "missing", "missing"]);
  });

  it("classifies ok / disabled / mismatched / missing, seeing through tcp+udp and range rules", async () => {
    const router = fakeRouter([
      { id: "a", name: "Palisade - x", proto: "both", ports: "2456", target: "10.0.0.5", enabled: true }, // ok via tcp_udp
      { id: "b", name: "Palisade - x", proto: "udp", ports: "2457-2460", target: "10.0.0.9", enabled: true }, // mismatched via range
    ]);
    const view = await service(router).status("srv1");
    expect(view.wanIp).toBe("203.0.113.9");
    expect(view.forwards.map((f) => [f.port, f.state, f.ruleId, f.actualTarget ?? null])).toEqual([
      [2456, "ok", "a", null],
      [2457, "mismatched", "b", "10.0.0.9"],
      [2458, "mismatched", "b", "10.0.0.9"],
    ]);
  });

  it("prefers a rule already pointing at the target, then a dedicated single-port rule", async () => {
    const router = fakeRouter([
      { id: "shared", name: "Palisade - x", proto: "udp", ports: "2456,2457,2458", target: "10.0.0.9", enabled: true },
      { id: "mine", name: "Palisade - x", proto: "udp", ports: "2456", target: "10.0.0.5", enabled: false },
      { id: "single", name: "Palisade - x", proto: "udp", ports: "2457", target: "10.0.0.7", enabled: true },
    ]);
    const view = await service(router).status("srv1");
    expect(view.forwards.map((f) => [f.port, f.state, f.ruleId])).toEqual([
      [2456, "disabled", "mine"],
      [2457, "mismatched", "single"],
      [2458, "mismatched", "shared"],
    ]);
  });

  it("apply creates missing rules, re-targets mismatched ones, leaves disabled alone, commits once", async () => {
    const router = fakeRouter([
      { id: "b", name: "Palisade - x", proto: "udp", ports: "2457", target: "10.0.0.9", enabled: true },
      { id: "c", name: "Palisade - x", proto: "udp", ports: "2458", target: "10.0.0.5", enabled: false },
    ]);
    const view = await service(router).apply("srv1");
    expect(router.calls).toEqual(["create 2456/udp", "retarget b", "commit"]);
    expect(view.forwards.map((f) => f.state)).toEqual(["ok", "ok", "disabled"]);
  });

  it("apply is a no-op (no commit) when everything is already forwarded", async () => {
    const router = fakeRouter([
      { id: "a", name: "Palisade - x", proto: "udp", ports: "2456", target: "10.0.0.5", enabled: true },
      { id: "b", name: "Palisade - x", proto: "udp", ports: "2457", target: "10.0.0.5", enabled: true },
      { id: "c", name: "Palisade - x", proto: "udp", ports: "2458", target: "10.0.0.5", enabled: true },
    ]);
    await service(router).apply("srv1");
    expect(router.calls).toEqual([]);
  });

  it("setEnabled toggles the matched rule and rejects ports outside the spec", async () => {
    const router = fakeRouter([{ id: "a", name: "Palisade - x", proto: "udp", ports: "2456", target: "10.0.0.5", enabled: true }]);
    const svc = service(router);
    const view = await svc.setEnabled("srv1", 2456, "udp", false);
    expect(router.calls).toEqual(["setEnabled a false", "commit"]);
    expect(view.forwards[0]?.state).toBe("disabled");
    await expect(svc.setEnabled("srv1", 9999, "udp", true)).rejects.toThrow(/isn't one of this server's forwards/);
    await expect(svc.setEnabled("srv1", 2457, "udp", true)).rejects.toThrow(/No rule exists/);
  });

  it("remove deletes one forward, or every rule behind the server — a shared rule only once", async () => {
    const router = fakeRouter([
      { id: "a", name: "Palisade - x", proto: "udp", ports: "2456", target: "10.0.0.5", enabled: true },
      { id: "shared", name: "Palisade - x", proto: "udp", ports: "2457,2458", target: "10.0.0.5", enabled: true },
    ]);
    const svc = service(router);
    await svc.remove("srv1", 2456, "udp");
    expect(router.calls).toEqual(["remove a", "commit"]);
    router.calls.length = 0;
    await svc.remove("srv1");
    expect(router.calls).toEqual(["remove shared", "commit"]);
    expect(router.rules).toEqual([]);
    await expect(svc.remove("srv1", 2456, "udp")).rejects.toThrow(/No rule exists/);
  });

  it("names new rules Palisade - <Game> - <server> - <port label>", async () => {
    const router = fakeRouter([]);
    await service(router).apply("srv1");
    expect(router.rules.map((r) => r.name)).toEqual([
      "Palisade - Valheim - Vikings - game",
      "Palisade - Valheim - Vikings - query (server browser)",
      "Palisade - Valheim - Vikings - crossplay",
    ]);
  });

  describe("removeForServer", () => {
    it("removes the Palisade-made rules pointing at the target and commits once", async () => {
      const router = fakeRouter([
        { id: "a", name: "Palisade - Valheim - Vikings - game", proto: "udp", ports: "2456", target: "10.0.0.5", enabled: true },
        { id: "b", name: "ASM Vikings — query", proto: "udp", ports: "2457", target: "10.0.0.5", enabled: false },
        { id: "c", name: "Palisade - Valheim - Vikings - crossplay", proto: "udp", ports: "2458", target: "10.0.0.5", enabled: true },
      ]);
      expect(await service(router).removeForServer(valheim)).toBe(3);
      expect(router.calls).toEqual(["remove a", "remove b", "remove c", "commit"]);
      expect(router.rules).toEqual([]);
    });

    it("leaves hand-made rules, rules aimed elsewhere, and ports another server still needs", async () => {
      const router = fakeRouter([
        { id: "hand", name: "My own rule", proto: "udp", ports: "2456", target: "10.0.0.5", enabled: true },
        { id: "else", name: "Palisade - Valheim - Old - query", proto: "udp", ports: "2457", target: "10.0.0.9", enabled: true },
        { id: "shared", name: "Palisade - Valheim - Vikings - crossplay", proto: "udp", ports: "2458", target: "10.0.0.5", enabled: true },
      ]);
      const sibling = { ...valheim, id: "srv2", name: "Second" }; // same Valheim block → still needs 2458
      expect(await service(router, [sibling]).removeForServer(valheim)).toBe(0);
      expect(router.calls).toEqual([]);
    });

    it("is a silent no-op without a router, and swallows router errors", async () => {
      expect(await service(null).removeForServer(valheim)).toBe(0);
      const router = fakeRouter([{ id: "a", name: "Palisade - x", proto: "udp", ports: "2456", target: "10.0.0.5", enabled: true }]);
      router.client.remove = async () => {
        throw new Error("boom");
      };
      expect(await service(router).removeForServer(valheim)).toBe(0);
    });
  });
});
