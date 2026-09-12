import { describe, it, expect, vi, beforeAll } from "vitest";
import { ServersService } from "./servers.service";
import { CatalogService } from "../catalog/catalog.service";

/**
 * GET /servers and /servers/stats hand the service the caller's allowed set
 * (GH #73). The service must push the narrowing into the Prisma `where` (not
 * post-filter), return nothing for an empty set without asking the DB, and
 * leave the query unfiltered for "all".
 */
beforeAll(() => {
  process.env.SECRETS_KEY = "a".repeat(64);
  process.env.JWT_SECRET = "test-jwt-secret-1234";
  process.env.DATA_DIR = "/tmp/palisade-list-access-test";
});

const base = {
  name: "Srv",
  game: "ASA",
  map: "TheIsland_WP",
  state: "Stopped",
  clusterId: null,
  cluster: null,
  gamePort: 7777,
  rawSocketPort: 7778,
  queryPort: 7779,
  rconPort: 7780,
  installedBuildId: null,
  updateAvailable: false,
  configDirty: false,
  maxPlayers: 10,
  modIds: "[]",
  ramLimitMb: null,
  cpuLimit: null,
  adminPasswordEnc: null,
  serverPasswordEnc: null,
  spectatorPasswordEnc: null,
  configJson: JSON.stringify({ values: {} }),
  containerId: null,
  artworkJson: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};
const rows = ["s1", "s2", "s3"].map((id) => ({ ...base, id }));

function makeSvc() {
  const findMany = vi.fn(async (args?: { where?: { id?: { in: string[] } } }) => {
    const ids = args?.where?.id?.in;
    return ids ? rows.filter((r) => ids.includes(r.id)) : rows;
  });
  const prisma = { server: { findMany } };
  const docker = { imageExists: async () => false, stats: async () => null };
  const players = { cached: () => null, count: async () => null };
  const svc = new ServersService(
    prisma as never,
    { decrypt: (s: string) => s } as never,
    {} as never,
    {} as never,
    docker as never,
    new CatalogService(),
    {} as never,
    {} as never,
    {} as never,
    {
      getTimezone: async () => "UTC",
      get: async () => null,
      getGameHostNetwork: async () => null,
      getPublicBaseUrl: async () => null,
    } as never,
    {} as never,
    {} as never,
    players as never,
    { addressingNote: () => null } as never,
    {} as never,
    { getAll: async () => ({}) } as never,
  );
  return { svc, findMany };
}

describe("ServersService.list / statsAll visibility (GH #73)", () => {
  it("'all' (and the default) leaves the query unfiltered", async () => {
    const { svc, findMany } = makeSvc();
    expect((await svc.list()).map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
    expect((await svc.list("all")).map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
    for (const call of findMany.mock.calls) expect(call[0]?.where).toBeUndefined();
  });

  it("a Set narrows the Prisma where to those ids", async () => {
    const { svc, findMany } = makeSvc();
    expect((await svc.list(new Set(["s2", "ghost"]))).map((s) => s.id)).toEqual(["s2"]);
    expect(findMany.mock.calls[0]?.[0]?.where).toEqual({ id: { in: ["s2", "ghost"] } });
  });

  it("an empty Set returns [] without touching the DB", async () => {
    const { svc, findMany } = makeSvc();
    expect(await svc.list(new Set())).toEqual([]);
    expect(await svc.statsAll(new Set())).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("statsAll applies the same narrowing", async () => {
    const { svc, findMany } = makeSvc();
    expect((await svc.statsAll(new Set(["s1", "s3"]))).map((s) => s.id)).toEqual(["s1", "s3"]);
    expect(findMany.mock.calls[0]?.[0]?.where).toEqual({ id: { in: ["s1", "s3"] } });
    expect((await svc.statsAll()).map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
  });
});
