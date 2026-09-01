import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { Game, STEAM_APP_ID } from "@ark/shared";
import { parseAcfBuildId, pickPublicBuildId, findManifest, UpdatesService } from "./updates.service";

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
