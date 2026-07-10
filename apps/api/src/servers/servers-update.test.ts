import { describe, it, expect, vi } from "vitest";
import { ServersService } from "./servers.service";

// update() must flag configDirty (→ the UI's Restart button) whenever a change is
// baked into the launch command — name (SessionName), passwords, max players, mods,
// settings — but NOT when an unchanged value is re-saved.

function makeSvc(overrides: Record<string, unknown> = {}) {
  const existing = {
    id: "s1",
    name: "Old Name",
    game: "ASA",
    map: "TheIsland_WP",
    state: "Running",
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
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
  const prisma = {
    server: {
      findUnique: vi.fn(async () => existing),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        ...existing,
        ...data,
        cluster: null,
      })),
    },
  };
  // Symmetric stand-in cipher so decrypt(encrypt(x)) === x for diffing.
  const crypto = {
    encrypt: (s: string) => `enc(${s})`,
    decrypt: (s: string) => s.replace(/^enc\(/, "").replace(/\)$/, ""),
    encryptOptional: (s?: string | null) => (s ? `enc(${s})` : null),
  };
  const events = { emit: vi.fn(async () => undefined) };
  const docker = { rename: vi.fn(async () => undefined) };
  const svc = new ServersService(
    prisma as never,
    crypto as never,
    events as never,
    {} as never,
    docker as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never, // logCapture
    {} as never, // backups
    { cached: () => null } as never, // players
    { writeInis: async () => undefined } as never, // configWriter
  );
  const dataOf = () => prisma.server.update.mock.calls[0]![0].data as Record<string, unknown>;
  return { svc, dataOf };
}

describe("update() configDirty (restart-needed) flag", () => {
  it("flags a restart when the server is renamed", async () => {
    const { svc, dataOf } = makeSvc({ name: "Old Name" });
    await svc.update("s1", { name: "New Name" } as never);
    expect(dataOf().name).toBe("New Name");
    expect(dataOf().configDirty).toBe(true);
  });

  it("flags a restart when a join password is added", async () => {
    const { svc, dataOf } = makeSvc({ serverPasswordEnc: null });
    await svc.update("s1", { serverPassword: "Church10" } as never);
    expect(dataOf().serverPasswordEnc).toBe("enc(Church10)");
    expect(dataOf().configDirty).toBe(true);
  });

  it("flags a restart when max players changes", async () => {
    const { svc, dataOf } = makeSvc({ maxPlayers: 10 });
    await svc.update("s1", { maxPlayers: 20 } as never);
    expect(dataOf().configDirty).toBe(true);
  });

  it("does NOT flag a restart when the name is unchanged", async () => {
    const { svc, dataOf } = makeSvc({ name: "Same" });
    await svc.update("s1", { name: "Same" } as never);
    expect(dataOf().configDirty).toBeUndefined();
    expect(dataOf().name).toBeUndefined();
  });

  it("does NOT flag a restart when the same join password is re-saved", async () => {
    const { svc, dataOf } = makeSvc({ serverPasswordEnc: "enc(Church10)" });
    await svc.update("s1", { serverPassword: "Church10" } as never);
    expect(dataOf().serverPasswordEnc).toBeUndefined();
    expect(dataOf().configDirty).toBeUndefined();
  });
});
