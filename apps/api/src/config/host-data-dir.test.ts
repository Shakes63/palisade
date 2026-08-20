import { describe, it, expect } from "vitest";
import { samePath, hostDataDirAction, mismatchMessage } from "./ensure-host-data-dir";

// GH #29: a HOST_DATA_DIR that disagrees with the real /data mount silently puts every
// game server's files somewhere the user never configured. The comparison that decides
// whether to warn must not fire on cosmetic differences.
describe("samePath", () => {
  it("treats a trailing slash as the same path", () => {
    expect(samePath("/mnt/cache/appdata/palisade", "/mnt/cache/appdata/palisade/")).toBe(true);
    expect(samePath("/mnt/cache/appdata/palisade//", "/mnt/cache/appdata/palisade")).toBe(true);
  });

  it("flags the actual #29 case: a stale default vs the configured App data", () => {
    expect(samePath("/mnt/cache/appdata/ark-manager", "/mnt/games_nvme/palisade")).toBe(false);
  });

  it("does not confuse a path with a longer one sharing its prefix", () => {
    expect(samePath("/mnt/cache/appdata", "/mnt/cache/appdata2")).toBe(false);
  });

  it("is case-sensitive, as Linux paths are", () => {
    expect(samePath("/mnt/Cache", "/mnt/cache")).toBe(false);
  });
});

describe("hostDataDirAction", () => {
  it("adopts the detected mount when nothing is configured (the normal path)", () => {
    expect(hostDataDirAction(undefined, "/mnt/games_nvme/palisade")).toEqual({
      kind: "adopt",
      value: "/mnt/games_nvme/palisade",
    });
    expect(hostDataDirAction("", "/mnt/x")).toMatchObject({ kind: "adopt" });
  });

  it("stays quiet when the configured value agrees", () => {
    expect(hostDataDirAction("/mnt/x", "/mnt/x/")).toEqual({ kind: "ok" });
  });

  it("reports the #29 mismatch without overriding the explicit value", () => {
    // Explicit still wins — we warn rather than silently relocating someone's data.
    expect(hostDataDirAction("/mnt/cache/appdata/ark-manager", "/mnt/games_nvme/palisade")).toEqual({
      kind: "mismatch",
      configured: "/mnt/cache/appdata/ark-manager",
      detected: "/mnt/games_nvme/palisade",
    });
  });
});

describe("mismatchMessage", () => {
  it("names both paths and how to fix it", () => {
    const msg = mismatchMessage("/mnt/cache/appdata/ark-manager", "/mnt/games_nvme/palisade");
    expect(msg).toContain("/mnt/cache/appdata/ark-manager");
    expect(msg).toContain("/mnt/games_nvme/palisade");
    expect(msg).toContain("Clear HOST_DATA_DIR");
  });
});
