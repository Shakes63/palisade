import { describe, expect, it, vi } from "vitest";
import { PortForwardsService } from "./portforwards.service";
import type { RouterClient, RouterRule } from "./router";
import { MikrotikClient } from "./mikrotik.client";

/** An in-memory router: rules live in an array and every write is recorded. */
function fakeRouter(initial: RouterRule[], targetIp = "10.0.0.5", kind: RouterClient["kind"] = "unifi") {
  const rules = [...initial];
  const calls: string[] = [];
  let seq = 100;
  const client: RouterClient = {
    kind,
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
    probeWrite: async () => {
      calls.push("probeWrite");
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

  it("classifies ok / disabled / mismatched / conflict / missing, seeing through tcp+udp and range rules", async () => {
    const router = fakeRouter([
      { id: "a", name: "Palisade - x", proto: "both", ports: "2456", target: "10.0.0.5", enabled: true }, // ok via tcp_udp
      { id: "b", name: "Palisade - x", proto: "udp", ports: "2457-2460", target: "10.0.0.9", enabled: true }, // conflict via range
    ]);
    const view = await service(router).status("srv1");
    expect(view.wanIp).toBe("203.0.113.9");
    expect(view.forwards.map((f) => [f.port, f.state, f.ruleId, f.actualTarget ?? null])).toEqual([
      [2456, "ok", "a", null],
      [2457, "conflict", "b", "10.0.0.9"],
      [2458, "conflict", "b", "10.0.0.9"],
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
      [2458, "conflict", "shared"],
    ]);
  });

  it("flags a hand-made rule occupying a port as a conflict and never re-points it", async () => {
    const router = fakeRouter([
      { id: "h", name: "Plex", proto: "udp", ports: "2457", target: "10.0.0.9", enabled: true },
    ]);
    const svc = service(router);
    const view = await svc.status("srv1");
    const f = view.forwards.find((x) => x.port === 2457)!;
    expect(f).toMatchObject({ state: "conflict", actualName: "Plex", actualTarget: "10.0.0.9", actualSpec: "2457" });
    // Fix creates the genuinely-missing ports and leaves the conflict for a Replace.
    await svc.apply("srv1");
    expect(router.calls).toEqual(["create 2456/udp", "create 2458/udp", "commit"]);
    expect(router.rules.find((r) => r.id === "h")?.target).toBe("10.0.0.9");
  });

  it("replace disables the occupying rule and creates a dedicated Palisade one", async () => {
    const router = fakeRouter([
      { id: "h", name: "Plex", proto: "udp", ports: "2457", target: "10.0.0.9", enabled: true },
    ]);
    const view = await service(router).replace("srv1", 2457, "udp");
    expect(router.calls).toEqual(["setEnabled h false", "create 2457/udp", "commit"]);
    expect(router.rules.find((r) => r.id === "h")?.enabled).toBe(false);
    const f = view.forwards.find((x) => x.port === 2457);
    expect(f).toMatchObject({ state: "ok", actualTarget: undefined, actualName: undefined });
    expect(router.rules.find((r) => r.ports === "2457" && r.name.startsWith("Palisade"))!.target).toBe("10.0.0.5");
  });

  it("replace rejects a port that isn't conflicting, or isn't ours", async () => {
    const router = fakeRouter([
      { id: "ok", name: "Palisade - x", proto: "udp", ports: "2457", target: "10.0.0.5", enabled: true },
    ]);
    await expect(service(router).replace("srv1", 2457, "udp")).rejects.toThrow(/no conflicting rule/);
    await expect(service(router).replace("srv1", 9999, "udp")).rejects.toThrow(/isn't one of this server's forwards/);
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

  it("apply rejects when the router accepts a write but the forward still isn't there", async () => {
    const router = fakeRouter([
      { id: "b", name: "Palisade - x", proto: "udp", ports: "2457", target: "10.0.0.9", enabled: true },
    ]);
    router.client.create = async () => {}; // 200 OK, nothing created — a read-only key
    router.client.retarget = async () => {};
    await expect(service(router).apply("srv1")).rejects.toThrow(
      /UniFi accepted the change but 2456\/udp, 2457\/udp, 2458\/udp still aren't forwarded/,
    );
  });

  it("preview reports the creates and retargets apply would make, without writing", async () => {
    const router = fakeRouter([
      { id: "b", name: "Palisade - x", proto: "udp", ports: "2457", target: "10.0.0.9", enabled: true },
      { id: "c", name: "Palisade - x", proto: "udp", ports: "2458", target: "10.0.0.5", enabled: false },
    ]);
    const plan = await service(router).preview("srv1");
    expect(router.calls).toEqual([]); // read-only: nothing written
    expect(plan.changes).toEqual([
      {
        port: 2456,
        proto: "udp",
        label: "game",
        action: "create",
        from: null,
        to: "10.0.0.5",
        name: "Palisade - Valheim - Vikings - game",
      },
      {
        port: 2457,
        proto: "udp",
        label: "query (server browser)",
        action: "retarget",
        from: "10.0.0.9",
        to: "10.0.0.5",
        name: "Palisade - Valheim - Vikings - query (server browser)",
      },
    ]);
  });

  it("preview is empty and read-only without a configured router", async () => {
    expect(await service(null).preview("srv1")).toMatchObject({ configured: false, changes: [] });
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

  it("testConnection probes writes on pfSense and reports a probe failure", async () => {
    const router = fakeRouter([], "10.0.0.5", "pfsense");
    const ok = await service(router).testConnection();
    expect(ok.ok).toBe(true);
    expect(ok.message).toMatch(/Read and write access OK/);
    expect(router.calls).toEqual(["probeWrite"]);
    router.client.probeWrite = async () => {
      throw new Error("403 forbidden");
    };
    const bad = await service(router).testConnection();
    expect(bad.ok).toBe(false);
    expect(bad.message).toMatch(/Connected to 10.0.0.1.*cannot write rules: 403 forbidden/);
  });

  it("builds a MikroTik client from saved settings and reads it read-only", async () => {
    const saved: Record<string, string> = {
      port_forward_router: "mikrotik",
      mikrotik_host: "10.0.0.1",
      mikrotik_user: "palisade",
      mikrotik_password: "secret",
      mikrotik_target_ip: "10.0.0.5",
      mikrotik_wan_interface: "ether1",
    };
    const settings = { get: vi.fn(async (key: string) => saved[key] ?? null) };
    const svc = new PortForwardsService({ server: {} } as never, settings as never);
    let seen: { host?: string; targetIp?: string } = {};
    const describe = vi.spyOn(MikrotikClient.prototype, "describe").mockImplementation(function (
      this: MikrotikClient,
    ) {
      seen = { host: this.host, targetIp: this.targetIp };
      return Promise.resolve("2 dstnat rules (RouterOS 7.15)");
    });
    const wanIp = vi.spyOn(MikrotikClient.prototype, "wanIp").mockResolvedValue("203.0.113.9");
    try {
      const res = await svc.testConnection();
      expect(res.ok).toBe(true);
      expect(res.message).toMatch(/RouterOS 7\.15/);
      expect(res.message).toMatch(/Read access only/);
      expect(seen).toEqual({ host: "10.0.0.1", targetIp: "10.0.0.5" });
    } finally {
      describe.mockRestore();
      wanIp.mockRestore();
    }
  });

  it("treats a missing MikroTik password as unconfigured", async () => {
    const saved: Record<string, string> = {
      port_forward_router: "mikrotik",
      mikrotik_host: "10.0.0.1",
      mikrotik_user: "palisade",
      mikrotik_target_ip: "10.0.0.5",
    };
    const settings = { get: vi.fn(async (key: string) => saved[key] ?? null) };
    const svc = new PortForwardsService({ server: {} } as never, settings as never);
    const res = await svc.testConnection();
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/Fill in the MikroTik RouterOS host, user and password, and target IP/);
  });

  it("testConnection on UniFi never writes; testWriteAccess does", async () => {
    const router = fakeRouter([]);
    const res = await service(router).testConnection();
    expect(res.ok).toBe(true);
    expect(res.message).toMatch(/Read access only/);
    expect(router.calls).toEqual([]);
    const write = await service(router).testWriteAccess();
    expect(write.ok).toBe(true);
    expect(router.calls).toEqual(["probeWrite"]);
    router.client.probeWrite = async () => {
      throw new Error("returned no id");
    };
    const bad = await service(router).testWriteAccess();
    expect(bad).toEqual({ ok: false, message: "UniFi write test failed: returned no id" });
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
