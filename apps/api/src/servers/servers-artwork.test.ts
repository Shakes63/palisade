import { describe, it, expect, vi, beforeAll } from "vitest";
import { ServersService } from "./servers.service";
import { CatalogService } from "../catalog/catalog.service";

/**
 * setArtwork merges per-kind overrides. Regression: the validated DTO instance
 * materializes every declared field, so kinds absent from the request arrive as
 * own `undefined` properties — a naive spread clobbered previously-pinned kinds
 * (picking a banner wiped the cover). Absent/undefined kinds must be ignored;
 * explicit null clears a kind; clearing the last kind stores NULL, not "{}".
 */
beforeAll(() => {
  process.env.SECRETS_KEY = "a".repeat(64);
  process.env.JWT_SECRET = "test-jwt-secret-1234";
  process.env.DATA_DIR = "/tmp/palisade-artwork-test";
});

function makeSvc(initialArtworkJson: string | null = null) {
  const row: Record<string, unknown> = {
    id: "s1",
    name: "Srv",
    game: "ASA",
    map: "TheIsland_WP",
    state: "Stopped",
    clusterId: null,
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
    artworkJson: initialArtworkJson,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  const prisma = {
    server: {
      findUnique: vi.fn(async () => row),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(row, data);
        return { ...row, cluster: null };
      }),
    },
  };
  const crypto = { decrypt: (s: string) => s };
  const docker = { imageExists: async () => false };
  const players = { cached: () => null };
  const svc = new ServersService(
    prisma as never,
    crypto as never,
    {} as never,
    {} as never,
    docker as never,
    new CatalogService(),
    {} as never,
    {} as never,
    {} as never,
    { getTimezone: async () => "UTC", get: async () => null } as never, // settings
    {} as never,
    {} as never,
    players as never,
    { addressingNote: () => null } as never, // endpoints
    {} as never,
    { getAll: async () => ({}) } as never, // artwork
  );
  return { svc, row };
}

/** A body as the ValidationPipe delivers it: EVERY declared field is an own
 *  property; the ones the client didn't send are undefined. */
const dtoBody = (set: Record<string, string | null>) => ({
  grid: undefined,
  hero: undefined,
  logo: undefined,
  icon: undefined,
  ...set,
});

describe("setArtwork", () => {
  it("picking a second kind keeps the first (the reported revert bug)", async () => {
    const { svc } = makeSvc();
    await svc.setArtwork("s1", dtoBody({ grid: "https://cdn/cover.png" }));
    const after = await svc.setArtwork("s1", dtoBody({ hero: "https://cdn/banner.png" }));
    expect(after.artwork).toEqual({ grid: "https://cdn/cover.png", hero: "https://cdn/banner.png" });
  });

  it("explicit null clears just that kind", async () => {
    const { svc } = makeSvc(JSON.stringify({ grid: "https://cdn/a.png", hero: "https://cdn/b.png" }));
    const after = await svc.setArtwork("s1", dtoBody({ grid: null }));
    expect(after.artwork).toEqual({ hero: "https://cdn/b.png" });
  });

  it("clearing the last kind stores NULL, not an empty object", async () => {
    const { svc, row } = makeSvc(JSON.stringify({ grid: "https://cdn/a.png" }));
    const after = await svc.setArtwork("s1", dtoBody({ grid: null }));
    expect(after.artwork).toBeNull();
    expect(row.artworkJson).toBeNull();
  });
});

describe("Unraid icon label", () => {
  it("assembleSpec uses the per-server icon override for net.unraid.docker.icon", async () => {
    const { svc } = makeSvc(JSON.stringify({ icon: "https://cdn/icon.png" }));
    const spec = await (svc as unknown as { specForServer(id: string): Promise<{ Labels: Record<string, string> }> }).specForServer("s1");
    expect(spec.Labels["net.unraid.docker.icon"]).toBe("https://cdn/icon.png");
  });

  it("falls back to the Steam header when no icon anywhere", async () => {
    const { svc } = makeSvc(null);
    const spec = await (svc as unknown as { specForServer(id: string): Promise<{ Labels: Record<string, string> }> }).specForServer("s1");
    expect(spec.Labels["net.unraid.docker.icon"]).toContain("steamstatic.com");
  });
});
