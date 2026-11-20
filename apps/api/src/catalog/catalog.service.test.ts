import { describe, it, expect } from "vitest";
import { Game } from "@ark/shared";
import { CatalogService } from "./catalog.service";

describe("CatalogService.renderInis", () => {
  const catalog = new CatalogService();

  it("gives ASE's GameUserSettings.ini the settings version ARK needs to keep it (GH #182)", () => {
    const { gameUserSettings } = catalog.renderInis(Game.ASE, { values: { XPMultiplier: 2 } });
    expect(gameUserSettings).toMatch(/^\[\/Script\/ShooterGame\.ShooterGameUserSettings\]\nVersion=5\n/);
    expect(gameUserSettings).toContain("[ServerSettings]");
    expect(gameUserSettings).toContain("XPMultiplier=2");
  });

  it("leaves ASA's GameUserSettings.ini without it", () => {
    const { gameUserSettings } = catalog.renderInis(Game.ASA, { values: {} });
    expect(gameUserSettings).not.toContain("ShooterGameUserSettings");
  });
});
