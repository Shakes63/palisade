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
    { cached: () => null, probeFailingSince: () => null } as never, // players
    { addressingNote: () => null } as never, // endpoints
    { writeInis: async () => undefined } as never, // configWriter
    { getAll: async () => ({}) } as never, // artwork
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

// ARK's join password used to live in two places (the ServerPassword setting and the
// encrypted column), and the setting silently won over the Overview's Access card.
describe("update() join password has one home", () => {
  const legacy = (pw: string) => JSON.stringify({ values: { ServerPassword: pw, XPMultiplier: 2 } });
  const valuesOf = (json: unknown) => (JSON.parse(json as string) as { values: Record<string, unknown> }).values;

  it("an Access-card change replaces a legacy ServerPassword setting", async () => {
    const { svc, dataOf } = makeSvc({ configJson: legacy("old"), serverPasswordEnc: null });
    const summary = await svc.update("s1", { serverPassword: "new" } as never);
    expect(dataOf().serverPasswordEnc).toBe("enc(new)");
    expect(valuesOf(dataOf().configJson)).toEqual({ XPMultiplier: 2 });
    expect(summary.joinPassword).toBe("new");
    expect(dataOf().configDirty).toBe(true);
  });

  it("clearing it on the Access card also clears the legacy setting", async () => {
    const { svc, dataOf } = makeSvc({ configJson: legacy("old"), serverPasswordEnc: "enc(old)" });
    const summary = await svc.update("s1", { serverPassword: "" } as never);
    expect(dataOf().serverPasswordEnc).toBeNull();
    expect(valuesOf(dataOf().configJson)).toEqual({ XPMultiplier: 2 });
    expect(summary.joinPassword).toBeNull();
  });

  it("a Settings-tab save writes the column, not the config", async () => {
    const { svc, dataOf } = makeSvc({ serverPasswordEnc: "enc(old)" });
    const summary = await svc.update("s1", {
      config: { values: { ServerPassword: "fromSettings", XPMultiplier: 3 } },
    } as never);
    expect(dataOf().serverPasswordEnc).toBe("enc(fromSettings)");
    expect(valuesOf(dataOf().configJson)).toEqual({ XPMultiplier: 3 });
    expect(summary.joinPassword).toBe("fromSettings");
  });

  it("flags a restart when dropping a legacy value that differed from the column", async () => {
    // The runtime launched with the setting ("old"), so moving to "kept" is a change.
    const { svc, dataOf } = makeSvc({ configJson: legacy("old"), serverPasswordEnc: "enc(kept)" });
    await svc.update("s1", { serverPassword: "kept" } as never);
    expect(dataOf().serverPasswordEnc).toBeUndefined();
    expect(dataOf().configDirty).toBe(true);
  });
});

describe("update() game-port edit", () => {
  it("keeps Satisfactory's reliable-messaging port", async () => {
    const { svc, dataOf } = makeSvc({
      game: "SATISFACTORY",
      state: "Stopped",
      gamePort: 7777,
      rawSocketPort: 8888,
      queryPort: 7777,
      rconPort: 0,
    });
    await svc.update("s1", { gamePort: 7800 } as never);
    expect(dataOf()).toMatchObject({ gamePort: 7800, queryPort: 7800 });
    expect(dataOf().rawSocketPort).toBeUndefined();
  });

  it("moves Valheim's query and crossplay ports with it", async () => {
    const { svc, dataOf } = makeSvc({
      game: "VALHEIM",
      state: "Stopped",
      gamePort: 2456,
      rawSocketPort: 2458,
      queryPort: 2457,
      rconPort: 0,
    });
    await svc.update("s1", { gamePort: 3000 } as never);
    expect(dataOf()).toMatchObject({ gamePort: 3000, queryPort: 3001, rawSocketPort: 3002 });
  });
});
