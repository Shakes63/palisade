import { describe, it, expect, vi, afterEach } from "vitest";
import { Game } from "@ark/shared";
import { GameVersionsService } from "./game-versions.service";

const mojang = {
  versions: [
    { id: "26.3-snapshot-3", type: "snapshot", releaseTime: "2026-07-07T12:03:01+00:00" },
    { id: "26.2", type: "release", releaseTime: "2026-07-01T00:00:00+00:00" },
    { id: "1.21.4", type: "release", releaseTime: "2024-12-03T00:00:00+00:00" },
    { id: "b1.7", type: "old_beta", releaseTime: "2011-01-01T00:00:00+00:00" },
  ],
};
const ghReleases = [
  { tag_name: "16.0-beta1", prerelease: true, published_at: "2026-06-25T12:36:04Z" },
  { tag_name: "15.3", prerelease: false, published_at: "2026-04-04T19:56:48Z" },
];

const stub = (payload: unknown, ok = true) =>
  vi.stubGlobal("fetch", async () => ({ ok, status: ok ? 200 : 500, statusText: "", json: async () => payload }) as Response);

afterEach(() => vi.unstubAllGlobals());

describe("GameVersionsService", () => {
  it("parses the Mojang manifest: LATEST default, SNAPSHOT + releases, no old betas", async () => {
    stub(mojang);
    const r = await new GameVersionsService().list(Game.MINECRAFT);
    expect(r.defaultValue).toBe("LATEST");
    const values = r.options.map((o) => o.value);
    expect(values).toContain("SNAPSHOT");
    expect(values).toContain("26.2");
    expect(values).toContain("1.21.4");
    expect(values).toContain("26.3-snapshot-3");
    expect(values).not.toContain("b1.7"); // old_beta filtered out
    // releases carry a date in the label
    expect(r.options.find((o) => o.value === "26.2")?.label).toMatch(/2026-07-01/);
  });

  it("parses OpenTTD GitHub releases: latest default, betas flagged", async () => {
    stub(ghReleases);
    const r = await new GameVersionsService().list(Game.OPENTTD);
    expect(r.defaultValue).toBe("latest");
    expect(r.options.map((o) => o.value)).toEqual(["16.0-beta1", "15.3"]);
    expect(r.options.find((o) => o.value === "16.0-beta1")?.kind).toBe("prerelease");
    expect(r.options.find((o) => o.value === "15.3")?.label).toMatch(/15\.3 — 2026-04-04/);
  });

  it("returns an empty list for a game with no version provider", async () => {
    const r = await new GameVersionsService().list(Game.ASA);
    expect(r.options).toEqual([]);
    expect(r.defaultValue).toBe("");
  });

  it("degrades to an empty list when the upstream fetch fails", async () => {
    stub(null, false);
    const r = await new GameVersionsService().list(Game.MINECRAFT);
    expect(r.options).toEqual([]);
  });
});
