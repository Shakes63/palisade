import { describe, it, expect } from "vitest";
import { parseBinds } from "./adoption.service";

// Bind strings are "host:container[:mode]" — mode is optional and host paths
// win any ambiguity (split from the right).
describe("parseBinds", () => {
  it("maps container paths to host paths", () => {
    expect(parseBinds(["/mnt/user/appdata/valheim:/config"])).toEqual({
      "/config": "/mnt/user/appdata/valheim",
    });
  });

  it("handles mode suffixes", () => {
    expect(parseBinds(["/mnt/a:/data:rw", "/mnt/b:/world:ro"])).toEqual({
      "/data": "/mnt/a",
      "/world": "/mnt/b",
    });
  });

  it("tolerates empty/garbage input", () => {
    expect(parseBinds(undefined)).toEqual({});
    expect(parseBinds(["nonsense"])).toEqual({});
  });
});
