import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Game } from "@ark/shared";
import { ValheimModsService } from "./valheimmods.service";

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
});
