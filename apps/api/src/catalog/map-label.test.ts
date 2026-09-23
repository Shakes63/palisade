import { describe, it, expect } from "vitest";
import { mapLabel } from "@ark/shared";

describe("mapLabel", () => {
  it("uses the known label table", () => {
    expect(mapLabel("TheIsland_WP")).toBe("The Island");
  });

  it("keeps underscored ids like CS2's as players know them", () => {
    expect(mapLabel("de_dust2")).toBe("de_dust2");
    expect(mapLabel("cs_office")).toBe("cs_office");
  });

  it("capitalises and spaces out unknown names", () => {
    expect(mapLabel("temperate")).toBe("Temperate");
    expect(mapLabel("MyCoolMap_WP")).toBe("My Cool Map");
  });
});
