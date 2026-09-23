import { describe, it, expect } from "vitest";
import { Game } from "@ark/shared";
import { ModsController } from "./mods.controller";
import type { CurseForgeService } from "./curseforge.service";
import type { SteamService } from "./steam.service";
import type { ModsService } from "./mods.service";
import type { FavoritesService } from "./favorites.service";

function controller(keys: { curseforge: boolean; steam: boolean }) {
  return new ModsController(
    {} as ModsService,
    { hasKey: async () => keys.curseforge } as unknown as CurseForgeService,
    { hasKey: async () => keys.steam } as unknown as SteamService,
    {} as FavoritesService,
  );
}

describe("ModsController.keyStatus", () => {
  it("checks the CurseForge key for ASA and Minecraft", async () => {
    const c = controller({ curseforge: true, steam: false });
    expect(await c.keyStatus(Game.ASA)).toEqual({ configured: true });
    expect(await c.keyStatus(Game.MINECRAFT)).toEqual({ configured: true });
  });

  it("checks the Steam Web key for Workshop games", async () => {
    const c = controller({ curseforge: true, steam: false });
    expect(await c.keyStatus(Game.ASE)).toEqual({ configured: false });
  });
});
