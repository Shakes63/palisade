import { describe, it, expect, beforeEach } from "vitest";
import { NotFoundException } from "@nestjs/common";
import { ClustersService } from "./clusters.service";

/**
 * Cluster start/stop walk their members sequentially on purpose, so the request was
 * held for the sum of every launch or teardown. The web app's rewrite proxy severs a
 * connection at ~30s (measured against a live install; Next 15 exposes no timeout to
 * raise), so a cluster of any real size reported a failure for work that was running
 * fine — the same false alarm that hit start and restart.
 */
const makeService = (opts: { members: number; cluster?: boolean; onStart?: () => Promise<void> }) => {
  const started: string[] = [];
  const prisma = {
    cluster: { findUnique: async () => (opts.cluster === false ? null : { id: "c1" }) },
    server: {
      count: async () => opts.members,
      findMany: async () =>
        Array.from({ length: opts.members }, (_, i) => ({ id: `s${i}`, clusterId: "c1" })),
    },
  };
  const servers = {
    start: async (id: string) => {
      started.push(id);
      if (opts.onStart) await opts.onStart();
    },
    stop: async (id: string) => {
      started.push(`stop:${id}`);
      if (opts.onStart) await opts.onStart();
    },
  };
  const service = new ClustersService(prisma as never, {} as never, servers as never);
  return { service, started };
};

describe("startAllDetached", () => {
  it("returns the member count without waiting for any of them", async () => {
    // A launch that never finishes: the caller still gets an answer.
    const { service, started } = makeService({
      members: 3,
      onStart: () => new Promise<void>(() => {}),
    });
    expect(await service.startAllDetached("c1")).toEqual({ started: 3 });
    // Only the first is in flight — the loop is still sequential behind the scenes.
    expect(started.length).toBeLessThanOrEqual(1);
  });

  it("still 404s a cluster that does not exist", async () => {
    // Worth answering before detaching; everything else is visible on the servers list.
    const { service } = makeService({ members: 0, cluster: false });
    await expect(service.startAllDetached("nope")).rejects.toThrow(NotFoundException);
  });

  it("reports zero for an empty cluster rather than pretending", async () => {
    const { service } = makeService({ members: 0 });
    expect(await service.startAllDetached("c1")).toEqual({ started: 0 });
  });
});

describe("stopAllDetached", () => {
  it("returns the member count without waiting for the teardowns", async () => {
    const { service, started } = makeService({
      members: 2,
      onStart: () => new Promise<void>(() => {}),
    });
    expect(await service.stopAllDetached("c1")).toEqual({ stopped: 2 });
    expect(started.length).toBeLessThanOrEqual(1);
  });

  it("still 404s a cluster that does not exist", async () => {
    const { service } = makeService({ members: 0, cluster: false });
    await expect(service.stopAllDetached("nope")).rejects.toThrow(NotFoundException);
  });
});
