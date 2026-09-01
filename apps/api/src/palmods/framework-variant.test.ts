import { describe, it, expect } from "vitest";
import { frameworkArchiveIssue } from "./palmods.service";

/**
 * GH #48: someone reported UE4SS never loading on the Wine variant — no UE4SS.log,
 * no crash, a server that just booted vanilla. The one-click install always picks
 * the right build, but the "upload a different build" path beside it took any zip
 * and extracted it into the variant's directory without looking inside. Put the
 * native Linux build on a Wine server and libUE4SS.so lands in Win64, where nothing
 * will ever load it — and nothing says so.
 */
const WINDOWS_BUILD = ["dwmapi.dll", "UE4SS.dll", "UE4SS-settings.ini", "Mods/keybinds.lua"];
const LINUX_BUILD = ["libUE4SS.so", "UE4SS-settings.ini", "Mods/keybinds.lua"];

describe("frameworkArchiveIssue", () => {
  it("accepts the Windows build on the Wine variant", () => {
    expect(frameworkArchiveIssue(WINDOWS_BUILD, true)).toBeNull();
  });

  it("accepts the Linux build on the native variant", () => {
    expect(frameworkArchiveIssue(LINUX_BUILD, false)).toBeNull();
  });

  it("rejects the Linux build on the Wine variant, naming what went wrong", () => {
    const issue = frameworkArchiveIssue(LINUX_BUILD, true);
    expect(issue).toContain("libUE4SS.so");
    expect(issue).toContain("dwmapi.dll");
  });

  it("rejects the Windows build on the native variant", () => {
    const issue = frameworkArchiveIssue(WINDOWS_BUILD, false);
    expect(issue).toContain("dwmapi.dll");
    expect(issue).toContain("libUE4SS.so");
  });

  it("matches on the file name wherever it sits in the archive", () => {
    // Some builds nest everything under a top-level folder.
    expect(frameworkArchiveIssue(["UE4SS_v3.0.1/dwmapi.dll"], false)).not.toBeNull();
    expect(frameworkArchiveIssue(["ue4ss/binaries/libUE4SS.so"], true)).not.toBeNull();
  });

  it("ignores case, since zip entries are not normalised", () => {
    expect(frameworkArchiveIssue(["DWMAPI.DLL"], false)).not.toBeNull();
    expect(frameworkArchiveIssue(["libUE4SS.SO"], true)).not.toBeNull();
  });

  it("handles Windows-style separators in entry names", () => {
    expect(frameworkArchiveIssue(["UE4SS_v3.0.1\\dwmapi.dll"], false)).not.toBeNull();
  });

  it("stays out of the way for an archive it doesn't recognise", () => {
    // The rest of this file is permissive about unfamiliar layouts; only object when
    // the archive is definitely the other variant's.
    expect(frameworkArchiveIssue(["some-fork/loader.dll", "readme.md"], true)).toBeNull();
    expect(frameworkArchiveIssue([], true)).toBeNull();
  });

  it("says nothing when an archive carries both loaders", () => {
    // A combined/universal build is the uploader's call, not ours to refuse.
    expect(frameworkArchiveIssue([...WINDOWS_BUILD, ...LINUX_BUILD], true)).toBeNull();
    expect(frameworkArchiveIssue([...WINDOWS_BUILD, ...LINUX_BUILD], false)).toBeNull();
  });
});
