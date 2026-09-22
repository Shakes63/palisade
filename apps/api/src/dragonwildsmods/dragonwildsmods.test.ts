import { describe, it, expect } from "vitest";
import { groupModFiles } from "./dragonwildsmods.service";

describe("groupModFiles", () => {
  it("groups a pak/utoc/ucas triple as one complete mod", () => {
    expect(groupModFiles(["Better_P.ucas", "Better_P.pak", "Better_P.utoc"])).toEqual([
      { name: "Better_P", parts: ["pak", "utoc", "ucas"], complete: true },
    ]);
  });

  it("flags a lone pak as incomplete and ignores stray files", () => {
    expect(groupModFiles(["Solo_P.pak", "readme.txt"])).toEqual([
      { name: "Solo_P", parts: ["pak"], complete: false },
    ]);
  });
});
