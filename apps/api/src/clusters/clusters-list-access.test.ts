import { describe, it, expect } from "vitest";
import { ClustersService } from "./clusters.service";

/**
 * GET /clusters for a restricted user (GH #73): a cluster shows when granted
 * directly or when any member is visible, and a partially visible cluster lists
 * only the visible members so hidden servers don't leak by name.
 */
const clusters = [
  {
    id: "c-granted",
    name: "Granted",
    servers: [
      { id: "g1", name: "G1" },
      { id: "g2", name: "G2" },
    ],
  },
  {
    id: "c-partial",
    name: "Partial",
    servers: [
      { id: "p1", name: "P1" },
      { id: "p2", name: "P2" },
    ],
  },
  { id: "c-hidden", name: "Hidden", servers: [{ id: "h1", name: "H1" }] },
  { id: "c-empty", name: "Empty", servers: [] },
];

function make() {
  const prisma = { cluster: { findMany: async () => clusters } };
  return new ClustersService(prisma as never, {} as never, {} as never);
}

describe("ClustersService.list visibility (GH #73)", () => {
  it("unrestricted callers get every cluster untouched", async () => {
    expect(await make().list()).toBe(clusters);
    expect(await make().list("all", new Set())).toBe(clusters);
    expect(await make().list(new Set(), "all")).toBe(clusters);
  });

  it("granted clusters come back whole; partial ones lose hidden members; others vanish", async () => {
    // Granted c-granted (so g1/g2 are in allowed via membership) plus p1 directly.
    const out = await make().list(new Set(["g1", "g2", "p1"]), new Set(["c-granted"]));
    expect(out.map((c) => c.id)).toEqual(["c-granted", "c-partial"]);
    expect(out[0]?.servers.map((s) => s.id)).toEqual(["g1", "g2"]);
    expect(out[1]?.servers.map((s) => s.id)).toEqual(["p1"]);
  });

  it("a restricted user with no grants sees nothing", async () => {
    expect(await make().list(new Set(), new Set())).toEqual([]);
  });

  it("a directly granted cluster is listed even with no visible members computed", async () => {
    // Defensive: grantedClusterIds and allowedServerIds are fetched separately.
    const out = await make().list(new Set(), new Set(["c-empty"]));
    expect(out.map((c) => c.id)).toEqual(["c-empty"]);
  });
});
