import { describe, it, expect, vi } from "vitest";
import { BadRequestException } from "@nestjs/common";
import { Game, clusterJoinError } from "@ark/shared";
import { ClustersService } from "./clusters.service";
import { ServersService } from "../servers/servers.service";

// Only ARK launches with the shared transfer dir (runtime-spec), and ASA and ASE
// saves can't cross over, so a cluster holds one ARK game.

describe("clusterJoinError", () => {
  it("allows ARK into an empty or same-game cluster", () => {
    expect(clusterJoinError(Game.ASA, [])).toBeNull();
    expect(clusterJoinError(Game.ASE, [Game.ASE, Game.ASE])).toBeNull();
  });

  it("rejects games that have no cluster wiring", () => {
    for (const g of [Game.MINECRAFT, Game.FACTORIO, Game.CONAN, Game.PALWORLD]) {
      expect(clusterJoinError(g, [])).toMatch(/ARK/);
    }
  });

  it("rejects mixing ASA and ASE", () => {
    expect(clusterJoinError(Game.ASE, [Game.ASA])).toMatch(/can't transfer/);
    expect(clusterJoinError(Game.ASA, [Game.ASE])).toMatch(/can't transfer/);
  });
});

describe("ClustersService.addMember", () => {
  const make = (game: Game, memberGames: Game[]) => {
    const prisma = {
      cluster: { findUnique: async () => ({ id: "c1", name: "Arch" }) },
      server: {
        findUnique: async () => ({ id: "s1", name: "S", game, clusterId: null, state: "Stopped" }),
        findMany: async () => memberGames.map((g) => ({ game: g })),
        update: vi.fn(async () => undefined),
      },
    };
    // Real assertClusterFits against the same fake prisma.
    const servers = Object.create(ServersService.prototype) as ServersService;
    Object.assign(servers, { prisma });
    const service = new ClustersService(prisma as never, { emit: async () => undefined } as never, servers);
    return { service, prisma };
  };

  it("refuses a non-ARK server without touching it", async () => {
    const { service, prisma } = make(Game.MINECRAFT, []);
    await expect(service.addMember("c1", "s1")).rejects.toThrow(BadRequestException);
    expect(prisma.server.update).not.toHaveBeenCalled();
  });

  it("refuses an ASE server in an ASA cluster", async () => {
    const { service, prisma } = make(Game.ASE, [Game.ASA]);
    await expect(service.addMember("c1", "s1")).rejects.toThrow(BadRequestException);
    expect(prisma.server.update).not.toHaveBeenCalled();
  });

  it("adds an ASA server to an ASA cluster", async () => {
    const { service, prisma } = make(Game.ASA, [Game.ASA]);
    await service.addMember("c1", "s1");
    expect(prisma.server.update).toHaveBeenCalledWith({ where: { id: "s1" }, data: { clusterId: "c1" } });
  });
});
