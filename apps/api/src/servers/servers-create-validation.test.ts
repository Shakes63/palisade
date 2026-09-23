import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { BadRequestException } from "@nestjs/common";
import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { DEFAULT_MAX_PLAYERS_BY_GAME, Game, MAX_PLAYERS_BY_GAME } from "@ark/shared";
import { ServersService } from "./servers.service";
import { CreateServerBody, UpdateServerBody } from "./servers.dto";

function makeSvc(opts: { existingGame?: Game; clusterMembers?: string[] } = {}) {
  const existing = {
    id: "s1",
    name: "Old Name",
    game: opts.existingGame ?? Game.ASA,
    map: "TheIsland_WP",
    state: "Stopped",
    clusterId: null,
    gamePort: 7777,
    rawSocketPort: 7778,
    queryPort: 7779,
    rconPort: 7780,
    maxPlayers: 10,
    modIds: "[]",
    adminPasswordEnc: null,
    serverPasswordEnc: null,
    spectatorPasswordEnc: null,
    configJson: JSON.stringify({ values: {} }),
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  const echo = async ({ data }: { data: Record<string, unknown> }) => ({ ...existing, ...data, cluster: null });
  const prisma = {
    server: {
      findUnique: vi.fn(async () => existing),
      findMany: vi.fn(async () => (opts.clusterMembers ?? []).map((game) => ({ game }))),
      create: vi.fn(echo),
      update: vi.fn(echo),
    },
    $transaction: async (fn: (tx: unknown) => unknown) => fn(prisma),
  };
  const crypto = {
    encrypt: (s: string) => `enc(${s})`,
    decrypt: (s: string) => s.replace(/^enc\(/, "").replace(/\)$/, ""),
    encryptOptional: (s?: string | null) => (s ? `enc(${s})` : null),
  };
  const svc = new ServersService(
    prisma as never,
    crypto as never,
    { emit: vi.fn(async () => undefined) } as never,
    {} as never,
    { rename: vi.fn(async () => undefined) } as never,
    { defaultsFor: () => ({ values: {} }) } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { cached: () => null, probeFailingSince: () => null } as never,
    { addressingNote: () => null } as never,
    { writeInis: async () => undefined } as never,
    { getAll: async () => ({}) } as never,
  );
  const created = () => prisma.server.create.mock.calls[0]![0].data as Record<string, unknown>;
  return { svc, prisma, created };
}

const base = { name: "My server", map: "x" };

describe("create() validation", () => {
  it("trims the name and rejects a blank one", async () => {
    const { svc, created } = makeSvc();
    await svc.create({ ...base, name: "  Spaced  ", game: Game.ASA } as never);
    expect(created().name).toBe("Spaced");
    await expect(svc.create({ ...base, name: "   ", game: Game.ASA } as never)).rejects.toThrow(
      BadRequestException,
    );
  });

  it.each([
    [Game.ZOMBOID, "adminPassword", 5],
    [Game.BEAMMP, "adminPassword", 10],
    [Game.DST, "adminPassword", 10],
    [Game.VALHEIM, "serverPassword", 5],
    [Game.ENSHROUDED, "serverPassword", 5],
  ] as const)("requires %s's %s of at least %i characters", async (game, field, min) => {
    const { svc } = makeSvc();
    await expect(svc.create({ ...base, game } as never)).rejects.toThrow(`at least ${min} characters`);
    await expect(svc.create({ ...base, game, [field]: "x".repeat(min - 1) } as never)).rejects.toThrow(
      BadRequestException,
    );
    await expect(svc.create({ ...base, game, [field]: "x".repeat(min) } as never)).resolves.toBeTruthy();
  });

  it("defaults max players to the game's default, not ARK's 70", async () => {
    const { svc, created } = makeSvc();
    await svc.create({ ...base, game: Game.CORE_KEEPER } as never);
    expect(created().maxPlayers).toBe(DEFAULT_MAX_PLAYERS_BY_GAME[Game.CORE_KEEPER]);
    expect(created().maxPlayers).toBeLessThanOrEqual(MAX_PLAYERS_BY_GAME[Game.CORE_KEEPER]);
  });

  it("rejects max players above the game's cap", async () => {
    const { svc } = makeSvc();
    const cap = MAX_PLAYERS_BY_GAME[Game.VALHEIM];
    await expect(
      svc.create({ ...base, game: Game.VALHEIM, serverPassword: "secret", maxPlayers: cap + 1 } as never),
    ).rejects.toThrow(`at most ${cap}`);
  });

  it("rejects a non-ARK server created straight into a cluster", async () => {
    const { svc } = makeSvc();
    await expect(svc.create({ ...base, game: Game.RUST, clusterId: "c1" } as never)).rejects.toThrow(
      "Clusters are for ARK servers",
    );
  });
});

describe("update() validation", () => {
  it("rejects max players above the game's cap", async () => {
    const { svc, prisma } = makeSvc({ existingGame: Game.ASA });
    await expect(svc.update("s1", { maxPlayers: MAX_PLAYERS_BY_GAME[Game.ASA] + 1 } as never)).rejects.toThrow(
      BadRequestException,
    );
    expect(prisma.server.update).not.toHaveBeenCalled();
  });

  it("rejects moving an ASE server into an ASA cluster", async () => {
    const { svc } = makeSvc({ existingGame: Game.ASE, clusterMembers: [Game.ASA] });
    await expect(svc.update("s1", { clusterId: "c1" } as never)).rejects.toThrow("can't transfer");
  });

  it("rejects clearing or shortening a required join password", async () => {
    const { svc, prisma } = makeSvc({ existingGame: Game.VALHEIM });
    await expect(svc.update("s1", { serverPassword: "" } as never)).rejects.toThrow("at least 5 characters");
    await expect(svc.update("s1", { config: { values: { ServerPassword: "abc" } } } as never)).rejects.toThrow(
      BadRequestException,
    );
    expect(prisma.server.update).not.toHaveBeenCalled();
    await expect(svc.update("s1", { serverPassword: "secret" } as never)).resolves.toBeTruthy();
  });

  it("rejects a required admin password that is too short, but not a blank (unchanged) one", async () => {
    const { svc } = makeSvc({ existingGame: Game.ZOMBOID });
    await expect(svc.update("s1", { adminPassword: "abc" } as never)).rejects.toThrow("at least 5 characters");
    await expect(svc.update("s1", { adminPassword: "" } as never)).resolves.toBeTruthy();
  });

  it("still lets a game without a required join password clear it", async () => {
    const { svc } = makeSvc({ existingGame: Game.ASA });
    await expect(svc.update("s1", { serverPassword: "" } as never)).resolves.toBeTruthy();
  });
});

describe("DTO name", () => {
  const errors = (cls: new () => object, body: object) =>
    validateSync(plainToInstance(cls, body)).map((e) => e.property);

  it("rejects an empty or whitespace-only name on create", () => {
    expect(errors(CreateServerBody, { name: "   ", game: Game.ASA, map: "x" })).toContain("name");
    expect(errors(CreateServerBody, { name: "ok", game: Game.ASA, map: "x" })).not.toContain("name");
  });

  it("rejects a blank rename but allows leaving the name out", () => {
    expect(errors(UpdateServerBody, { name: " " })).toContain("name");
    expect(errors(UpdateServerBody, {})).not.toContain("name");
  });
});
