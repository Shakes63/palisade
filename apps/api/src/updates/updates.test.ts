import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { EventType, Game, ServerState, STEAM_APP_ID } from "@ark/shared";
import { parseAcfBuildId, pickPublicBuildId, findManifest, UpdatesService } from "./updates.service";
import { resetEnvCache } from "../config/env";

vi.mock("./registry-digest", async (orig) => ({
  ...(await orig<typeof import("./registry-digest")>()),
  remoteImageDigest: async () => "sha256:new",
}));

describe("parseAcfBuildId", () => {
  it("extracts the build id from a SteamCMD appmanifest", () => {
    const acf = [
      '"AppState"',
      "{",
      '\t"appid"\t\t"2430930"',
      '\t"Universe"\t\t"1"',
      '\t"buildid"\t\t"17284560"',
      '\t"name"\t\t"ARK Survival Ascended Dedicated Server"',
      "}",
    ].join("\n");
    expect(parseAcfBuildId(acf)).toBe(17284560);
  });

  it("returns null when there is no buildid", () => {
    expect(parseAcfBuildId('"AppState" {\n"appid" "2430930"\n}')).toBeNull();
    expect(parseAcfBuildId("")).toBeNull();
  });
});

describe("pickPublicBuildId", () => {
  it("reads data.<appid>.depots.branches.public.buildid", () => {
    const json = {
      data: { "2430930": { depots: { branches: { public: { buildid: "17284560" } } } } },
    };
    expect(pickPublicBuildId(json, 2430930)).toBe(17284560);
  });

  it("returns null for missing or malformed shapes", () => {
    expect(pickPublicBuildId({}, 2430930)).toBeNull();
    expect(pickPublicBuildId({ data: {} }, 2430930)).toBeNull();
    expect(pickPublicBuildId({ data: { "2430930": {} } }, 2430930)).toBeNull();
    expect(pickPublicBuildId(null, 2430930)).toBeNull();
  });
});

describe("findManifest", () => {
  // Every manifest nesting OBSERVED on live installs (GH #16 + tower):
  // ASA also writes a root-level copy; Icarus is two levels deep.
  const LAYOUTS: [string, string][] = [
    ["ASA (root copy)", "appmanifest_2430930.acf"],
    ["ASA/Palworld-Wine", "steamapps/appmanifest_2394010.acf"],
    ["Conan", "server/steamapps/appmanifest_443030.acf"],
    ["Valheim/Zomboid/VRising/7DTD", "serverfiles/steamapps/appmanifest_896660.acf"],
    ["SotF", "game/steamapps/appmanifest_2465200.acf"],
    ["Icarus", "gamefiles/server/steamapps/appmanifest_2089300.acf"],
  ];

  let base: string;
  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), "palisade-manifest-"));
  });
  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  for (const [label, rel] of LAYOUTS) {
    it(`finds the ${label} layout: ${rel}`, async () => {
      const root = join(base, label.replace(/[^a-z]/gi, "_"));
      const full = join(root, rel);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, '"AppState" { "buildid" "123" }');
      // Noise: sibling dirs that must be probed past, not tripped over.
      await mkdir(join(root, "logs"), { recursive: true });
      await mkdir(join(root, "config", "sub"), { recursive: true });
      expect(await findManifest(root, rel.split("/").pop()!)).toBe(full);
    });
  }

  it("returns null when the manifest is absent or the root doesn't exist", async () => {
    const root = join(base, "empty");
    await mkdir(join(root, "serverfiles"), { recursive: true });
    expect(await findManifest(root, "appmanifest_1.acf")).toBeNull();
    expect(await findManifest(join(base, "no-such-dir"), "appmanifest_1.acf")).toBeNull();
  });

  it("does not descend beyond maxDepth (never walks the game tree)", async () => {
    const root = join(base, "deep");
    const tooDeep = join(root, "a", "b", "c", "steamapps", "appmanifest_9.acf");
    await mkdir(dirname(tooDeep), { recursive: true });
    await writeFile(tooDeep, '"buildid" "9"');
    expect(await findManifest(root, "appmanifest_9.acf")).toBeNull(); // depth 3 > default 2
    expect(await findManifest(root, "appmanifest_9.acf", 3)).toBe(tooDeep);
  });
});

// What the Version & updates card reads: the build on disk vs the newest published
// one, and how an update reaches this game. The two halves must fail INDEPENDENTLY —
// an unreachable build API has to read "unknown", never "up to date".
describe("buildStatus", () => {
  let tmp: string;

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), "ark-builds-"));
    process.env.DATA_DIR = tmp;
    process.env.SECRETS_KEY = "a".repeat(64);
    process.env.JWT_SECRET = "test-jwt-secret-1234";
  });

  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  function makeSvc(game: Game, latest: number | null) {
    const prisma = { server: { findUnique: async () => ({ id: "s1", game, updateAvailable: false }) } };
    vi.stubGlobal("fetch", async () => ({
      ok: latest !== null,
      json: async () => ({
        data: { [String(STEAM_APP_ID[game])]: { depots: { branches: { public: { buildid: String(latest) } } } } },
      }),
    }));
    return new UpdatesService(
      prisma as never,
      { emit: async () => undefined } as never,
      // buildStatus touches neither Docker nor the registry — the baked-image
      // path is what needs those (see checkBakedImage).
      {} as never,
      {} as never,
    );
  }

  const manifest = (buildId: number) => `"AppState"\n{\n\t"buildid"\t\t"${buildId}"\n}`;

  it("finds a manifest under steamapps/ and flags the server as outdated", async () => {
    const dir = join(tmp, "instances", "s1", "steamapps");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `appmanifest_${STEAM_APP_ID[Game.PALWORLD_WINE]}.acf`), manifest(24370498));

    const svc = makeSvc(Game.PALWORLD_WINE, 24575149);
    const status = await svc.buildStatus("s1");

    expect(status.installed).toBe("24370498");
    expect(status.latest).toBe("24575149");
    expect(status.outdated).toBe(true);
    expect(status.mode).toBe("on-request");
  });

  it("reports outdated as null (not 'up to date') when the build API is unreachable", async () => {
    const svc = makeSvc(Game.PALWORLD_WINE, null);
    const status = await svc.buildStatus("s1");

    expect(status.installed).toBe("24370498");
    expect(status.latest).toBeNull();
    expect(status.outdated).toBeNull();
  });

  it("skips the build comparison for games whose files ship in the image", async () => {
    const svc = makeSvc(Game.FACTORIO, 1);
    const status = await svc.buildStatus("s1");

    expect(status.appId).toBeNull();
    expect(status.outdated).toBeNull();
    expect(status.mode).toBe("image");
  });
});

// GH #164: the badge reads the stored flag, so a server that just updated must clear
// it when it comes up rather than at the next 3-hourly poll.
describe("refresh on reaching Running", () => {
  let tmp: string;

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), "ark-refresh-"));
    process.env.DATA_DIR = tmp;
    process.env.SECRETS_KEY = "a".repeat(64);
    process.env.JWT_SECRET = "test-jwt-secret-1234";
    resetEnvCache();
    const dir = join(tmp, "instances", "conan1", "server", "steamapps");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `appmanifest_${STEAM_APP_ID[Game.CONAN]}.acf`), '"AppState"\n{\n\t"buildid"\t\t"25639945"\n}');
  });

  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  function setup(latest: number) {
    const row = { id: "conan1", name: "Conan", game: Game.CONAN, installedBuildId: "24269196", updateAvailable: true };
    const prisma = {
      server: {
        findMany: async () => [{ ...row }],
        findUnique: async () => ({ ...row }),
        update: vi.fn(async ({ data }: { data: object }) => Object.assign(row, data)),
      },
    };
    const emitted: { type: EventType; message: string }[] = [];
    let listener: ((e: unknown) => void) | undefined;
    const events = {
      emit: async (e: { type: EventType; message: string }) => void emitted.push(e),
      onEvent: (l: (e: unknown) => void) => (listener = l),
    };
    vi.stubGlobal("fetch", async () => ({
      ok: true,
      json: async () => ({ data: { "443030": { depots: { branches: { public: { buildid: String(latest) } } } } } }),
    }));
    const svc = new UpdatesService(prisma as never, events as never, {} as never, {} as never);
    return { svc, row, prisma, emitted, fire: (e: unknown) => listener?.(e) };
  }

  it("clears a stale flag once the updated server is Running", async () => {
    vi.useFakeTimers();
    const { svc, row, emitted, fire } = setup(25639945);
    svc.onModuleInit();
    vi.useRealTimers();
    fire({ type: EventType.StateTransition, serverId: "conan1", data: { from: "Starting", to: ServerState.Running } });
    await vi.waitFor(() => expect(row.updateAvailable).toBe(false));

    expect(row.installedBuildId).toBe("25639945");
    expect(emitted).toEqual([expect.objectContaining({ type: EventType.InstallFinished })]);
  });

  it("ignores transitions to anything but Running, and reconcile adoptions", async () => {
    vi.useFakeTimers();
    const { svc, prisma, fire } = setup(25639945);
    svc.onModuleInit();
    vi.useRealTimers();
    fire({ type: EventType.StateTransition, serverId: "conan1", data: { from: "Stopped", to: ServerState.Starting } });
    fire({
      type: EventType.StateTransition,
      serverId: "conan1",
      data: { from: "Stopped", to: ServerState.Running, reconcile: true },
    });
    await new Promise((r) => setTimeout(r, 20));

    expect(prisma.server.update).not.toHaveBeenCalled();
  });

  it("notifies once when two checks overlap on the same flip", async () => {
    const { svc, emitted } = setup(25639945);
    await Promise.all([svc.refresh("conan1"), svc.refresh("conan1")]);

    expect(emitted.filter((e) => e.type === EventType.InstallFinished)).toHaveLength(1);
  });

  it("runs overlapping checks of one server in turn, each on a fresh read", async () => {
    const { svc, prisma } = setup(25639945);
    const log: string[] = [];
    const { findUnique, update } = prisma.server;
    prisma.server.findUnique = async () => (log.push("read"), findUnique());
    prisma.server.update = vi.fn(async (args) => (log.push("write"), update(args)));
    await Promise.all([svc.refresh("conan1"), svc.checkAll()]);

    expect(log.filter((x) => x === "write")).toHaveLength(1);
    expect(log.lastIndexOf("read")).toBeGreaterThan(log.indexOf("write"));
  });

  // Image-baked servers sharing a tag: a sibling's pull moves the local tag while this
  // container may still run the old image, so only its own start may say "up to date".
  function bakedSetup(containerDigest: string) {
    const row = {
      id: "pz1",
      name: "Zomboid",
      game: Game.ZOMBOID,
      imageTag: null,
      containerId: "c1",
      installedBuildId: "sha256:old",
      updateAvailable: true,
    };
    const fresh = () => ({ ...row });
    const emitted: { type: EventType }[] = [];
    const prisma = {
      server: {
        findMany: async () => [fresh()],
        findUnique: async () => fresh(),
        update: async ({ data }: { data: object }) => Object.assign(row, data),
      },
    };
    const docker = {
      inspect: async () => ({ Image: "sha256:running" }),
      imageDigest: async (image: string) => (image === "sha256:running" ? containerDigest : "sha256:new"),
    };
    const svc = new UpdatesService(
      prisma as never,
      { emit: async (e: { type: EventType }) => void emitted.push(e), onEvent: () => undefined } as never,
      docker as never,
      {} as never,
    );
    return { svc, row, emitted };
  }

  it("announces an image-baked server as current only after its own start", async () => {
    const { svc, row, emitted } = bakedSetup("sha256:new");
    await svc.checkAll();
    expect(row.updateAvailable).toBe(false);
    expect(emitted).toEqual([]);

    row.updateAvailable = true;
    await svc.refresh("pz1");
    expect(emitted).toEqual([expect.objectContaining({ type: EventType.InstallFinished })]);
  });

  it("keeps the flag after a start that booted an older cached image", async () => {
    const { svc, row, emitted } = bakedSetup("sha256:old");
    await svc.refresh("pz1");

    expect(row.updateAvailable).toBe(true);
    expect(emitted).toEqual([]);
  });
});
