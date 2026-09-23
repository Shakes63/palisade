import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Game } from "@ark/shared";
import { ValheimModsService, mergeIndexes, toPackages, type ThunderstoreRaw } from "./valheimmods.service";

describe("ValheimModsService.status", () => {
  let root: string;
  let svc: ValheimModsService;

  beforeEach(async () => {
    process.env.SECRETS_KEY = "a".repeat(64);
    process.env.JWT_SECRET = "test-jwt-secret-1234";
    root = await mkdtemp(join(tmpdir(), "palisade-valheimmods-"));
    process.env.DATA_DIR = root;
    const { resetEnvCache } = await import("../config/env");
    resetEnvCache();
    const prisma = { server: { findUnique: async () => ({ id: "s1", game: Game.VALHEIM }) } };
    svc = new ValheimModsService(prisma as never);
    // Seed a fresh index so status() never reaches Thunderstore.
    const pkg = { versionNumber: "2.30.3" };
    (svc as unknown as { index: unknown }).index = {
      at: Date.now(),
      byFullName: new Map([["ValheimModding-Jotunn", pkg]]),
      list: [pkg],
    };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("reads the version from a manifest.json that starts with a UTF-8 BOM", async () => {
    const dir = join(root, "instances", "s1", "config/bepinex/plugins", "ValheimModding-Jotunn");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "manifest.json"), '\uFEFF{"name":"Jotunn","version_number":"2.30.2"}');

    const { mods } = await svc.status("s1");
    expect(mods).toEqual([
      { name: "ValheimModding-Jotunn", installedVersion: "2.30.2", latestVersion: "2.30.3", updateAvailable: true },
    ]);
  });

  it("does not offer an older index version as an update", async () => {
    const dir = join(root, "instances", "s1", "config/bepinex/plugins", "ValheimModding-Jotunn");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "manifest.json"), '{"name":"Jotunn","version_number":"2.31.0"}');

    const { mods } = await svc.status("s1");
    expect(mods[0]?.updateAvailable).toBe(false);
  });
});

function raw(fullName: string, versions: string[], opts: { deprecated?: boolean; deps?: string[] } = {}): ThunderstoreRaw {
  const [owner = "", name = ""] = fullName.split("-");
  return {
    name,
    full_name: fullName,
    owner,
    is_deprecated: opts.deprecated,
    versions: versions.map((v) => ({ version_number: v, download_url: `https://dl/${fullName}-${v}.zip`, dependencies: opts.deps })),
  };
}

describe("Valheim mod index merge", () => {
  it("keeps the Thunderstore package when both sources list it live", () => {
    const merged = mergeIndexes(
      toPackages([raw("A-Mod", ["1.0.0"])], "thunderstore"),
      toPackages([raw("A-Mod", ["9.0.0"])], "hexium"),
    );
    expect(merged.get("A-Mod")).toMatchObject({ source: "thunderstore", versionNumber: "1.0.0" });
  });

  it("uses Hexium when the Thunderstore package is deprecated", () => {
    const merged = mergeIndexes(
      toPackages([raw("A-Mod", ["1.0.0"], { deprecated: true })], "thunderstore"),
      toPackages([raw("A-Mod", ["1.1.0"])], "hexium"),
    );
    expect(merged.get("A-Mod")).toMatchObject({ source: "hexium", versionNumber: "1.1.0", deprecated: false });
  });

  it("adds Hexium-only packages", () => {
    const merged = mergeIndexes(toPackages([raw("A-Mod", ["1.0.0"])], "thunderstore"), toPackages([raw("B-Mod", ["2.0.0"])], "hexium"));
    expect(merged.get("B-Mod")).toMatchObject({ source: "hexium" });
    expect(merged.size).toBe(2);
  });

  it("picks the highest version even when Hexium doesn't list it first", () => {
    const [pkg] = toPackages([raw("Mirfin-SkillLoss", ["1.0.0", "1.0.1"])], "hexium");
    expect(pkg).toMatchObject({ versionNumber: "1.0.1", downloadUrl: "https://dl/Mirfin-SkillLoss-1.0.1.zip" });
  });

  it("prefers a stable release over a newer beta, falling back to betas only", () => {
    const [stable] = toPackages([raw("A-Mod", ["2.0.0-beta.1", "1.9.0", "2.0.0-beta.2"])], "hexium");
    expect(stable?.versionNumber).toBe("1.9.0");
    const [beta] = toPackages([raw("B-Mod", ["1.0.0-beta.1", "1.0.0-beta.2"])], "hexium");
    expect(beta?.versionNumber).toBe("1.0.0-beta.2");
  });
});

describe("ValheimModsService index loading", () => {
  let svc: ValheimModsService;

  beforeEach(() => {
    svc = new ValheimModsService({} as never);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const stubIndexes = (thunderstore: ThunderstoreRaw[] | null, hexium: ThunderstoreRaw[] | null) =>
    vi.stubGlobal("fetch", async (url: string) => {
      const body = url.includes("hexium.gg") ? hexium : thunderstore;
      return body ? new Response(JSON.stringify(body)) : new Response("down", { status: 503 });
    });

  it("resolves a Hexium package's Thunderstore-only dependency", async () => {
    stubIndexes(
      [raw("ValheimModding-Jotunn", ["2.30.3"])],
      [raw("Azumatt-Mod", ["1.0.0"], { deps: ["denikson-BepInExPack_Valheim-5.4.2333", "ValheimModding-Jotunn-2.30.0"] })],
    );
    await (svc as unknown as { refreshIndex(): Promise<void> }).refreshIndex();
    const index = (svc as unknown as { index: { byFullName: Map<string, never> } }).index;
    const resolved = (svc as unknown as { resolve(p: unknown): { fullName: string; source: string }[] }).resolve(
      index.byFullName.get("Azumatt-Mod"),
    );
    expect(resolved.map((p) => [p.fullName, p.source])).toEqual([
      ["Azumatt-Mod", "hexium"],
      ["ValheimModding-Jotunn", "thunderstore"],
    ]);
  });

  it("still loads one source when the other fails", async () => {
    stubIndexes(null, [raw("B-Mod", ["2.0.0"])]);
    const { results } = await svc.search("");
    expect(results.map((r) => [r.fullName, r.source])).toEqual([["B-Mod", "hexium"]]);
  });

  it("fails only when both sources fail", async () => {
    stubIndexes(null, null);
    await expect(svc.search("")).rejects.toThrow();
  });
});

// Built with Python's zipfile: manifest + plugins/Mod.dll + patchers/Mod.Patchers.dll, then
// the next version with the patcher dropped.
const WITH_PATCHER_B64 =
  "UEsDBBQAAAAAAEuCN137pH4CGgAAABoAAAANAAAAbWFuaWZlc3QuanNvbnsidmVyc2lvbl9udW1iZXIiOiIxLjAuMCJ9UEsDBBQAAAAAAEuCN12UJ27pBgAAAAYAAAAPAAAAcGx1Z2lucy9Nb2QuZGxscGx1Z2luUEsDBBQAAAAAAEuCN10i2Ch3BwAAAAcAAAAZAAAAcGF0Y2hlcnMvTW9kLlBhdGNoZXJzLmRsbHBhdGNoZXJQSwECFAMUAAAAAABLgjdd+6R+AhoAAAAaAAAADQAAAAAAAAAAAAAAgAEAAAAAbWFuaWZlc3QuanNvblBLAQIUAxQAAAAAAEuCN12UJ27pBgAAAAYAAAAPAAAAAAAAAAAAAACAAUUAAABwbHVnaW5zL01vZC5kbGxQSwECFAMUAAAAAABLgjddItgodwcAAAAHAAAAGQAAAAAAAAAAAAAAgAF4AAAAcGF0Y2hlcnMvTW9kLlBhdGNoZXJzLmRsbFBLBQYAAAAAAwADAL8AAAC2AAAAAAA=";
const WITHOUT_PATCHER_B64 =
  "UEsDBBQAAAAAAEuCN11LjR4/GgAAABoAAAANAAAAbWFuaWZlc3QuanNvbnsidmVyc2lvbl9udW1iZXIiOiIxLjEuMCJ9UEsDBBQAAAAAAEuCN12UJ27pBgAAAAYAAAAHAAAATW9kLmRsbHBsdWdpblBLAQIUAxQAAAAAAEuCN11LjR4/GgAAABoAAAANAAAAAAAAAAAAAACAAQAAAABtYW5pZmVzdC5qc29uUEsBAhQDFAAAAAAAS4I3XZQnbukGAAAABgAAAAcAAAAAAAAAAAAAAIABRQAAAE1vZC5kbGxQSwUGAAAAAAIAAgBwAAAAcAAAAAAA";

describe("ValheimModsService install layout", () => {
  let root: string;
  let svc: ValheimModsService;
  let zip: string;

  beforeEach(async () => {
    process.env.SECRETS_KEY = "a".repeat(64);
    process.env.JWT_SECRET = "test-jwt-secret-1234";
    root = await mkdtemp(join(tmpdir(), "palisade-valheimmods-"));
    process.env.DATA_DIR = root;
    const { resetEnvCache } = await import("../config/env");
    resetEnvCache();
    const prisma = {
      server: {
        findUnique: async () => ({ id: "s1", game: Game.VALHEIM, configJson: "{}" }),
        update: async () => undefined,
      },
    };
    svc = new ValheimModsService(prisma as never);
    const [pkg] = toPackages([raw("Argus-QoL", ["1.0.0"])], "hexium");
    (svc as unknown as { index: unknown }).index = { at: Date.now(), byFullName: new Map([[pkg!.fullName, pkg]]), list: [pkg] };
    zip = WITH_PATCHER_B64;
    vi.stubGlobal("fetch", async () => new Response(Buffer.from(zip, "base64")));
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true });
  });

  const bepinex = () => join(root, "instances", "s1", "config/bepinex");

  it("moves a top-level patchers/ folder to patchers/<Owner-Mod>", async () => {
    await svc.install("s1", "Argus-QoL");
    expect(await readdir(join(bepinex(), "patchers", "Argus-QoL"))).toEqual(["Mod.Patchers.dll"]);
    expect((await readdir(join(bepinex(), "plugins", "Argus-QoL"))).sort()).toEqual(["manifest.json", "plugins"]);
  });

  it("drops a stale patcher when an update no longer ships one, and on remove", async () => {
    await svc.install("s1", "Argus-QoL");
    zip = WITHOUT_PATCHER_B64;
    await svc.install("s1", "Argus-QoL");
    expect(await readdir(join(bepinex(), "patchers"))).toEqual([]);

    zip = WITH_PATCHER_B64;
    await svc.install("s1", "Argus-QoL");
    await svc.remove("s1", "Argus-QoL");
    expect(await readdir(join(bepinex(), "patchers"))).toEqual([]);
    expect(await readdir(join(bepinex(), "plugins"))).toEqual([]);
  });
});
