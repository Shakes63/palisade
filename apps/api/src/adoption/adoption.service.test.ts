import { afterAll, afterEach, beforeAll, describe, it, expect, vi } from "vitest";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Game } from "@ark/shared";
import { AdoptionService, parseBinds } from "./adoption.service";
import { CryptoService } from "../crypto/crypto.service";
import { LocalPaths } from "../common/paths";
import { resetEnvCache } from "../config/env";
import { writeServerSnapshot, type ServerSnapshot } from "../servers/server-snapshot";

// Bind strings are "host:container[:mode]" — mode is optional and host paths
// win any ambiguity (split from the right).
describe("parseBinds", () => {
  it("maps container paths to host paths", () => {
    expect(parseBinds(["/mnt/user/appdata/valheim:/config"])).toEqual({
      "/config": "/mnt/user/appdata/valheim",
    });
  });

  it("handles mode suffixes", () => {
    expect(parseBinds(["/mnt/a:/data:rw", "/mnt/b:/world:ro"])).toEqual({
      "/data": "/mnt/a",
      "/world": "/mnt/b",
    });
  });

  it("tolerates empty/garbage input", () => {
    expect(parseBinds(undefined)).toEqual({});
    expect(parseBinds(["nonsense"])).toEqual({});
  });
});

describe("reattaching an orphaned Palisade container (GH #175)", () => {
  const ORPHAN_ID = "corphan0000000000000000001";
  const CONTAINER = "c".repeat(64);
  let dataDir: string;

  beforeAll(async () => {
    process.env.SECRETS_KEY = "a".repeat(64);
    process.env.JWT_SECRET = "test-jwt-secret-1234";
    dataDir = await mkdtemp(join(tmpdir(), "palisade-adopt-"));
    process.env.DATA_DIR = dataDir;
    resetEnvCache();
  });
  afterAll(() => rm(dataDir, { recursive: true, force: true }));
  afterEach(() => rm(LocalPaths.instanceRoot(ORPHAN_ID), { recursive: true, force: true }));

  const crypto = () => new CryptoService();
  // Ciphertext from a SECRETS_KEY this install no longer has.
  const otherKey = Object.assign(Object.create(CryptoService.prototype), {
    key: Buffer.alloc(32, 7),
  }) as CryptoService;

  function snapshot(over: Partial<ServerSnapshot> = {}): ServerSnapshot {
    return {
      version: 1,
      id: ORPHAN_ID,
      game: Game.CONAN,
      name: "Exiled Lands",
      map: "ConanSandbox",
      maxPlayers: 30,
      gamePort: 7779,
      rawSocketPort: 7780,
      queryPort: 27016,
      rconPort: 25576,
      adminPasswordEnc: crypto().encrypt("admin-secret"),
      serverPasswordEnc: crypto().encrypt("join-secret"),
      spectatorPasswordEnc: null,
      extraEnvEnc: null,
      configJson: JSON.stringify({ values: { HarvestAmountMultiplier: 3 } }),
      modIds: "[880454836]",
      artworkJson: null,
      imageTag: null,
      ramLimitMb: 8192,
      cpuLimit: null,
      backupKeep: 5,
      hostNetwork: null,
      mods: [
        {
          source: "workshop",
          remoteId: "880454836",
          name: "Pippi",
          thumbnailUrl: null,
          extra: null,
          loadOrder: 1,
          pinnedVersion: null,
          enabled: true,
        },
      ],
      ...over,
    };
  }

  function makeAdoption(
    opts: {
      known?: string[];
      running?: boolean;
      serverId?: string;
      dataDir?: string;
      binds?: string[];
      volumes?: string[];
      oldCaps?: string[];
      hostNet?: boolean;
      oldHardened?: boolean;
      specCaps?: string[];
      specHardened?: boolean;
    } = {},
  ) {
    const labels = {
      "ark.role": "server",
      "ark.serverId": opts.serverId ?? ORPHAN_ID,
      "ark.game": Game.CONAN,
    };
    const container = {
      Id: CONTAINER,
      Names: ["/conan-exiled-lands-corphan0"],
      Image: "acekorneya/conan_enhanced_server:latest",
      State: opts.running ? "running" : "exited",
      Labels: labels,
    };
    const calls: string[] = [];
    const docker = {
      listAllContainers: vi.fn(async () => [container]),
      inspect: vi.fn(async () => ({
        Name: container.Names[0],
        State: { Running: !!opts.running },
        Config: { Image: container.Image, Labels: labels },
        HostConfig: {
          NetworkMode: opts.hostNet ? "host" : "bridge",
          CapAdd: opts.oldCaps,
          SecurityOpt: opts.oldHardened === false ? [] : ["no-new-privileges:true"],
        },
        Mounts: [
          `${opts.dataDir ?? dataDir}/instances/${opts.serverId ?? ORPHAN_ID}:/data`,
          ...(opts.binds ?? []),
        ]
          .map((b) => ({ Type: "bind", Source: b.split(":")[0], Destination: b.split(":")[1] }))
          .concat(
            (opts.volumes ?? []).map((v) => {
              const [name, dest = "/x"] = v.split(":");
              return { Type: "volume", Name: name, Source: "", Destination: dest };
            }),
          ),
      })),
      stop: vi.fn(async () => {
        calls.push("stop");
      }),
      runToCompletion: vi.fn(),
    };
    const servers = {
      create: vi.fn(async (_dto: unknown, o: { id?: string }) => {
        calls.push("create");
        return { id: o.id };
      }),
      withLock: vi.fn(async (id: string, fn: () => Promise<unknown>) => {
        calls.push(`lock:${id}`);
        const out = await fn();
        calls.push("unlock");
        return out;
      }),
      specForServer: vi.fn(async (id: string) => ({
        HostConfig: {
          Binds: [`${dataDir}/instances/${id}:/data`],
          CapAdd: opts.specCaps,
          SecurityOpt: opts.specHardened === false ? [] : ["no-new-privileges:true"],
        },
      })),
    };
    const prisma = {
      server: {
        findMany: vi.fn(async () => (opts.known ?? []).map((id) => ({ id }))),
        findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
          opts.known?.includes(where.id) ? { id: where.id } : null,
        ),
        update: vi.fn(async () => ({})),
        delete: vi.fn(async () => ({})),
      },
      mod: { upsert: vi.fn(async () => ({ id: "mod-1" })) },
      modInstall: { create: vi.fn(async () => ({})) },
    };
    const events = { emit: vi.fn(async () => undefined) };
    const svc = new AdoptionService(
      docker as never,
      servers as never,
      events as never,
      prisma as never,
      crypto(),
    );
    return { svc, docker, servers, prisma, calls };
  }

  const ownDataDir = () => mkdir(LocalPaths.instanceRoot(ORPHAN_ID), { recursive: true });

  it("lists an orphan with its saved name, and skips a container whose server still exists", async () => {
    await writeServerSnapshot(ORPHAN_ID, snapshot());
    expect(await makeAdoption().svc.candidates()).toMatchObject([
      {
        game: Game.CONAN,
        orphaned: true,
        savedName: "Exiled Lands",
        savedPasswords: { admin: true, join: true },
      },
    ]);
    expect(await makeAdoption({ known: [ORPHAN_ID] }).svc.candidates()).toEqual([]);
  });

  it("leaves alone a container whose data isn't in this install, like a second Palisade's", async () => {
    const { svc, servers } = makeAdoption();
    expect(await svc.candidates()).toEqual([]);
    await expect(svc.adopt({ containerId: CONTAINER, name: "x" })).rejects.toThrow("data folder");
    expect(servers.create).not.toHaveBeenCalled();
  });

  it("leaves alone a container mounting another install's copy of the same server", async () => {
    await ownDataDir();
    const { svc, servers } = makeAdoption({ dataDir: "/mnt/cache/appdata/palisade-clone" });
    expect(await svc.candidates()).toEqual([]);
    await expect(svc.adopt({ containerId: CONTAINER, name: "x" })).rejects.toThrow("data folder");
    expect(servers.create).not.toHaveBeenCalled();
  });

  it("drops saved artwork that isn't valid JSON instead of breaking the server list", async () => {
    await writeServerSnapshot(ORPHAN_ID, snapshot({ artworkJson: "{" }));
    const { svc, prisma } = makeAdoption();
    await svc.adopt({ containerId: CONTAINER, name: "x" });
    expect(prisma.server.update).toHaveBeenCalledWith({
      where: { id: ORPHAN_ID },
      data: expect.objectContaining({ artworkJson: null }),
    });
  });

  it("leaves alone a container with data mounted from outside this install", async () => {
    await ownDataDir();
    expect(await makeAdoption({ binds: ["/mnt/user/worlds/vrising:/saves"] }).svc.candidates()).toEqual([]);
    const clustered = makeAdoption({ binds: [`${dataDir}/clusters/abc:/clustershared`] });
    expect(await clustered.svc.candidates()).toHaveLength(1);
  });

  it("won't reattach when a mount wouldn't come back where its data is", async () => {
    await ownDataDir();
    // Saves re-pointed inside the instance dir: the source is local, the mapping isn't ours.
    const moved = makeAdoption({ binds: [`${dataDir}/instances/${ORPHAN_ID}/actual-saves:/data/server`] });
    expect(await moved.svc.candidates()).toHaveLength(1);
    await expect(moved.svc.adopt({ containerId: CONTAINER, name: "x" })).rejects.toThrow("differently");
    expect(moved.prisma.server.delete).toHaveBeenCalledWith({ where: { id: ORPHAN_ID } });

    const named = makeAdoption({ volumes: ["my-saves"] });
    await expect(named.svc.adopt({ containerId: CONTAINER, name: "x" })).rejects.toThrow("differently");

    // An image's anonymous volume over a bound path is where the saves would be hiding.
    const shadowing = makeAdoption({ volumes: [`${"a".repeat(64)}:/data/server/Saved`] });
    await expect(shadowing.svc.adopt({ containerId: CONTAINER, name: "x" })).rejects.toThrow("differently");

    const anonymous = makeAdoption({ volumes: ["a".repeat(64)] });
    await expect(anonymous.svc.adopt({ containerId: CONTAINER, name: "x" })).resolves.toMatchObject({
      serverId: ORPHAN_ID,
    });
  });

  it("matches its own instance dir however the bind path was spelled", async () => {
    await ownDataDir();
    expect(await makeAdoption({ dataDir: `${dataDir}/` }).svc.candidates()).toHaveLength(1);
  });

  it("keeps a bridged container off the host network whatever the snapshot says", async () => {
    for (const saved of [true, null]) {
      await writeServerSnapshot(ORPHAN_ID, snapshot({ hostNetwork: saved }));
      const { svc, prisma } = makeAdoption();
      await svc.adopt({ containerId: CONTAINER, name: "x" });
      expect(prisma.server.update).toHaveBeenLastCalledWith({
        where: { id: ORPHAN_ID },
        data: { hostNetwork: false },
      });
    }

    await writeServerSnapshot(ORPHAN_ID, snapshot({ hostNetwork: true }));
    const onHost = makeAdoption({ hostNet: true });
    await onHost.svc.adopt({ containerId: CONTAINER, name: "x" });
    expect(onHost.prisma.server.update).toHaveBeenCalledTimes(1);
    expect(onHost.prisma.server.update).toHaveBeenCalledWith({
      where: { id: ORPHAN_ID },
      data: expect.objectContaining({ hostNetwork: true }),
    });
  });

  it("won't let saved settings give the container access the old one didn't have", async () => {
    await writeServerSnapshot(ORPHAN_ID, snapshot());
    const addsCap = makeAdoption({ specCaps: ["NET_RAW"] });
    await expect(addsCap.svc.adopt({ containerId: CONTAINER, name: "x" })).rejects.toThrow("more access");
    expect(addsCap.prisma.server.delete).toHaveBeenCalledWith({ where: { id: ORPHAN_ID } });

    const dropsHardening = makeAdoption({ specHardened: false });
    await expect(dropsHardening.svc.adopt({ containerId: CONTAINER, name: "x" })).rejects.toThrow(
      "more access",
    );

    // Palworld with auto-pause on really runs with NET_RAW and without no-new-privileges.
    const autoPause = makeAdoption({
      oldCaps: ["NET_RAW"],
      oldHardened: false,
      specCaps: ["NET_RAW"],
      specHardened: false,
    });
    await expect(autoPause.svc.adopt({ containerId: CONTAINER, name: "x" })).resolves.toMatchObject({
      serverId: ORPHAN_ID,
    });
  });

  it("falls back to default settings when the snapshot is malformed", async () => {
    await writeServerSnapshot(ORPHAN_ID, snapshot({ name: 123 as never }));
    expect((await makeAdoption().svc.candidates())[0]).not.toHaveProperty("savedName");

    await writeServerSnapshot(ORPHAN_ID, snapshot({ configJson: "{" }));
    const { svc, servers } = makeAdoption();
    expect((await svc.candidates())[0]).not.toHaveProperty("savedName");
    await svc.adopt({ containerId: CONTAINER, name: "x" });
    expect(servers.create).toHaveBeenCalledWith(
      expect.not.objectContaining({ config: expect.anything() }),
      { id: ORPHAN_ID },
    );
  });

  it("leaves alone a label that isn't a Palisade id", async () => {
    await ownDataDir();
    // instances/.. is the data dir itself, which exists, so only the id check stops it.
    const { svc, servers } = makeAdoption({ serverId: ".." });
    expect(await svc.candidates()).toEqual([]);
    await expect(svc.adopt({ containerId: CONTAINER, name: "x" })).rejects.toThrow("data folder");
    expect(servers.create).not.toHaveBeenCalled();
  });

  it("reattaches under the old id with the saved settings, passwords, ports, and mods", async () => {
    await writeServerSnapshot(ORPHAN_ID, snapshot());
    const { svc, servers, prisma, docker, calls } = makeAdoption({ running: true });
    const res = await svc.adopt({ containerId: CONTAINER, name: "Exiled Lands" });

    expect(res.serverId).toBe(ORPHAN_ID);
    expect(servers.create).toHaveBeenCalledWith(
      expect.objectContaining({
        game: Game.CONAN,
        map: "ConanSandbox",
        maxPlayers: 30,
        adminPassword: "admin-secret",
        serverPassword: "join-secret",
        config: { values: { HarvestAmountMultiplier: 3 } },
        modIds: [880454836],
        ramLimitMb: 8192,
      }),
      { id: ORPHAN_ID },
    );
    expect(prisma.server.update).toHaveBeenCalledWith({
      where: { id: ORPHAN_ID },
      data: expect.objectContaining({ gamePort: 7779, queryPort: 27016, backupKeep: 5 }),
    });
    expect(prisma.modInstall.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ serverId: ORPHAN_ID, modId: "mod-1", loadOrder: 1 }),
    });
    expect(calls).toEqual([`lock:${ORPHAN_ID}`, "create", "stop", "unlock"]);
    expect(docker.runToCompletion).not.toHaveBeenCalled();
  });

  it("prefers a typed password, and drops saved secrets SECRETS_KEY can no longer open", async () => {
    await writeServerSnapshot(ORPHAN_ID, snapshot({ serverPasswordEnc: otherKey.encrypt("join-secret") }));
    const { svc, servers } = makeAdoption();
    expect((await svc.candidates())[0]!.savedPasswords).toEqual({ admin: true, join: false });

    await svc.adopt({ containerId: CONTAINER, name: "Exiled Lands", adminPassword: "typed" });
    const dto = servers.create.mock.calls[0]![0] as { adminPassword?: string; serverPassword?: string };
    expect(dto.adminPassword).toBe("typed");
    expect(dto.serverPassword).toBeUndefined();
  });

  it("ignores a snapshot written for a different server", async () => {
    await writeServerSnapshot(ORPHAN_ID, snapshot({ id: "csomeoneelse000000000000001" }));
    const { svc, servers, prisma } = makeAdoption();
    expect((await svc.candidates())[0]).not.toHaveProperty("savedName");
    await svc.adopt({ containerId: CONTAINER, name: "Back again" });
    expect(servers.create).toHaveBeenCalledWith(
      expect.not.objectContaining({ config: expect.anything() }),
      { id: ORPHAN_ID },
    );
    expect(prisma.server.update).toHaveBeenCalledTimes(1);
    expect(prisma.server.update).toHaveBeenCalledWith({ where: { id: ORPHAN_ID }, data: { hostNetwork: false } });
  });

  it("reattaches with default settings when the orphan has no snapshot", async () => {
    await ownDataDir();
    const { svc, servers, prisma } = makeAdoption();
    await svc.adopt({ containerId: CONTAINER, name: "Back again" });
    expect(servers.create).toHaveBeenCalledWith(
      expect.not.objectContaining({ config: expect.anything() }),
      { id: ORPHAN_ID },
    );
    expect(prisma.server.update).toHaveBeenCalledTimes(1);
    expect(prisma.server.update).toHaveBeenCalledWith({ where: { id: ORPHAN_ID }, data: { hostNetwork: false } });
  });

  it("leaves a running orphan running when create() rejects it", async () => {
    await ownDataDir();
    const { svc, servers, docker } = makeAdoption({ running: true });
    servers.create.mockRejectedValueOnce(new Error("Admin password is required"));
    await expect(svc.adopt({ containerId: CONTAINER, name: "x" })).rejects.toThrow("required");
    expect(docker.stop).not.toHaveBeenCalled();
  });

  it("drops the row when create() commits it and then fails", async () => {
    await ownDataDir();
    const { svc, servers, prisma } = makeAdoption();
    servers.create.mockImplementationOnce(async () => {
      throw new Error("event log write failed");
    });
    await expect(svc.adopt({ containerId: CONTAINER, name: "x" })).rejects.toThrow("event log");
    expect(prisma.server.delete).toHaveBeenCalledWith({ where: { id: ORPHAN_ID } });
  });

  it("won't touch a row another reattach created while it waited for the lock", async () => {
    await ownDataDir();
    const { svc, servers, prisma } = makeAdoption();
    prisma.server.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: ORPHAN_ID });
    await expect(svc.adopt({ containerId: CONTAINER, name: "x" })).rejects.toThrow("already managed");
    expect(servers.create).not.toHaveBeenCalled();
    expect(prisma.server.delete).not.toHaveBeenCalled();
  });

  it("drops the row, not the files, when the restore fails part-way", async () => {
    await writeServerSnapshot(ORPHAN_ID, snapshot());
    const { svc, prisma } = makeAdoption();
    prisma.mod.upsert.mockRejectedValueOnce(new Error("db gone"));
    await expect(svc.adopt({ containerId: CONTAINER, name: "x" })).rejects.toThrow("db gone");
    expect(prisma.server.delete).toHaveBeenCalledWith({ where: { id: ORPHAN_ID } });
    expect((await readdir(LocalPaths.instanceRoot(ORPHAN_ID))).length).toBeGreaterThan(0);
  });

  it("refuses a container whose server is still in the database", async () => {
    await ownDataDir();
    const { svc, servers } = makeAdoption({ known: [ORPHAN_ID] });
    await expect(svc.adopt({ containerId: CONTAINER, name: "x" })).rejects.toThrow("already managed");
    expect(servers.create).not.toHaveBeenCalled();
  });
});
