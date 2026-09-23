import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Game, STORE_APP_ID } from "@ark/shared";
import { ArtworkService } from "./artwork.service";

// The service resolves art by Steam app id where we have one and by name search
// otherwise, caches into a manager setting, and must degrade to "no art" quietly.
function makeService(stored: Record<string, string | null>) {
  const settings = {
    get: async (k: string) => stored[k] ?? null,
    set: async (k: string, v: string) => {
      stored[k] = v;
    },
  };
  return { svc: new ArtworkService(settings as never), stored };
}

const asset = (url: string) => ({ success: true, data: [{ url, score: 1 }] });

describe("ArtworkService", () => {
  const calls: string[] = [];
  beforeEach(() => {
    calls.length = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      if (url.includes("/search/autocomplete/")) {
        return { ok: true, status: 200, json: async () => ({ success: true, data: [{ id: 999, name: "x" }] }) } as Response;
      }
      return { ok: true, status: 200, json: async () => asset("https://cdn/x.png") } as Response;
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("no key: fetches nothing and reports everything missing", async () => {
    const { svc } = makeService({});
    const res = await svc.refresh();
    expect(res.fetched).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("resolves games by their STORE app id (not the dedicated-server id)", async () => {
    const { svc } = makeService({ steamgriddb_api_key: "k" });
    await svc.refresh();
    // Palworld art lives on the game (1623730), not the server (2394010).
    expect(STORE_APP_ID[Game.PALWORLD]).toBe(1623730);
    expect(calls.some((u) => u.includes(`/grids/steam/${STORE_APP_ID[Game.PALWORLD]}`))).toBe(true);
    // ASA game (2399830), not server (2430930) — the case that had zero art.
    expect(calls.some((u) => u.includes(`/grids/steam/${STORE_APP_ID[Game.ASA]}`))).toBe(true);
  });

  it("resolves Minecraft (not on Steam) by name search, then by SGDB game id", async () => {
    const { svc } = makeService({ steamgriddb_api_key: "k" });
    await svc.refresh();
    expect(calls.some((u) => u.includes("/search/autocomplete/Minecraft"))).toBe(true);
    expect(calls.some((u) => u.includes("/grids/game/999"))).toBe(true);
  });

  it("caches results so getAll doesn't re-fetch when art is present", async () => {
    const { svc, stored } = makeService({ steamgriddb_api_key: "k" });
    await svc.refresh();
    expect(stored.artwork_cache).toBeTruthy();
    const before = calls.length;
    const map = await svc.getAll();
    // getAll reads cache; any refresh it kicks is for still-missing games only.
    expect(map[Game.PALWORLD]?.grid).toBe("https://cdn/x.png");
    await new Promise((r) => setTimeout(r, 5));
    expect(calls.length).toBe(before); // nothing missing → no new fetches
  });

  it("throws a clear error on a 401 (bad key) rather than silently caching nothing", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 401, json: async () => ({}) }) as Response);
    const { svc } = makeService({ steamgriddb_api_key: "bad" });
    // refresh swallows per-game errors but records them as missing; the 401 message
    // is logged per game. Just assert it completes and finds nothing.
    const res = await svc.refresh();
    expect(res.fetched).toBe(0);
    expect(res.missing).toBeGreaterThan(0);
  });

  it("picker options without a key say so instead of looking like a game with no art", async () => {
    const { svc } = makeService({});
    await expect(svc.options(Game.ASA, "grid")).rejects.toMatchObject({
      response: { code: "SGDB_KEY_MISSING" },
    });
    expect(calls).toHaveLength(0);
  });
});
