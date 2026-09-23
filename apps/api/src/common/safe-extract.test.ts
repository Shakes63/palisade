import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractZipSafe, extractTarGzSafe, __test } from "./safe-extract";

const { isUnsafeEntry } = __test;

// Real zips (built with Python's zipfile, which — unlike the `zip` CLI — will store
// arbitrary entry names). EVIL has a `../ESCAPED.txt` entry; SAFE is a normal nested tree.
const EVIL_B64 =
  "UEsDBBQAAAAAACZy61x6zT+3BQAAAAUAAAAOAAAALi4vRVNDQVBFRC50eHRldmlsClBLAwQUAAAAAAAmcutcr11oLAUAAAAFAAAABgAAAG9rLnR4dGZpbmUKUEsBAhQDFAAAAAAAJnLrXHrNP7cFAAAABQAAAA4AAAAAAAAAAAAAAIABAAAAAC4uL0VTQ0FQRUQudHh0UEsBAhQDFAAAAAAAJnLrXK9daCwFAAAABQAAAAYAAAAAAAAAAAAAAIABMQAAAG9rLnR4dFBLBQYAAAAAAgACAHAAAABaAAAAAAA=";
// Windows-built entries (MS-DOS flagged, `\` separators) like the Jotunn zip in GH #129.
const DOS_B64 =
  "UEsDBBQAAAAAAAAANl3mLllCBwAAAAcAAAASAAAAcGx1Z2luc1xKb3R1bm4uZGxsam90dW5uClBLAQIUABQAAAAAAAAANl3mLllCBwAAAAcAAAASAAAAAAAAAAAAAACAAQAAAABwbHVnaW5zXEpvdHVubi5kbGxQSwUGAAAAAAEAAQBAAAAANwAAAAAA";
const DOS_EVIL_B64 =
  "UEsDBBQAAAAAAAAANl16zT+3BQAAAAUAAAAOAAAALi5cRVNDQVBFRC50eHRldmlsClBLAQIUABQAAAAAAAAANl16zT+3BQAAAAUAAAAOAAAAAAAAAAAAAACAAQAAAAAuLlxFU0NBUEVELnR4dFBLBQYAAAAAAQABADwAAAAxAAAAAAA=";
const SAFE_B64 =
  "UEsDBBQAAAAAACZy61z7pH4CGgAAABoAAAANAAAAbWFuaWZlc3QuanNvbnsidmVyc2lvbl9udW1iZXIiOiIxLjAuMCJ9UEsDBBQAAAAAACZy61x6em/tAwAAAAMAAAAMAAAAc3ViL2ZpbGUudHh0aGkKUEsBAhQDFAAAAAAAJnLrXPukfgIaAAAAGgAAAA0AAAAAAAAAAAAAAIABAAAAAG1hbmlmZXN0Lmpzb25QSwECFAMUAAAAAAAmcutcenpv7QMAAAADAAAADAAAAAAAAAAAAAAAgAFFAAAAc3ViL2ZpbGUudHh0UEsFBgAAAAACAAIAdQAAAHIAAAAAAA==";

describe("safe-extract: entry vetting", () => {
  it("flags absolute + traversal entry names", () => {
    for (const bad of ["../x", "a/../b", "/etc/passwd", "foo/../../bar", "C:\\win\\x", "a\\..\\b"]) {
      expect(isUnsafeEntry(bad), bad).toBe(true);
    }
  });
  it("allows normal nested names", () => {
    for (const ok of ["a.txt", "sub/dir/file.dll", "manifest.json", "..dots..txt", "a..b/c"]) {
      expect(isUnsafeEntry(ok), ok).toBe(false);
    }
  });
});

describe("extractZipSafe (real unzip)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "safe-extract-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("extracts a normal archive into the destination", async () => {
    await extractZipSafe(Buffer.from(SAFE_B64, "base64"), dir);
    const names = (await readdir(dir)).sort();
    expect(names).toContain("manifest.json");
    expect(JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"))).toMatchObject({
      version_number: "1.0.0",
    });
  });

  it("REJECTS an archive containing a ../ traversal entry (nothing extracted)", async () => {
    await expect(extractZipSafe(Buffer.from(EVIL_B64, "base64"), dir)).rejects.toThrow(/unsafe path/i);
    // vetting happens before extraction → the destination stays empty.
    expect(await readdir(dir)).toEqual([]);
  });

  it("extracts a Windows-built archive with backslash separators", async () => {
    await extractZipSafe(Buffer.from(DOS_B64, "base64"), dir);
    expect(await readFile(join(dir, "plugins", "Jotunn.dll"), "utf8")).toBe("jotunn\n");
  });

  it("REJECTS a backslash ..\\ traversal entry (nothing extracted)", async () => {
    await expect(extractZipSafe(Buffer.from(DOS_EVIL_B64, "base64"), dir)).rejects.toThrow(/unsafe path/i);
    expect(await readdir(dir)).toEqual([]);
  });

  it("strips symlinks that survive extraction (defense-in-depth)", async () => {
    // extractZipSafe strips symlinks after unzip; simulate the post-extract state by
    // planting a symlink and running the (idempotent) strip via a fresh safe extract
    // that leaves the tree, then asserting no symlinks remain.
    await symlink("/etc/passwd", join(dir, "evil-link"));
    await writeFile(join(dir, "real.txt"), "x");
    await extractZipSafe(Buffer.from(SAFE_B64, "base64"), dir); // triggers stripSymlinks(dir)
    const entries = await readdir(dir, { withFileTypes: true });
    expect(entries.some((e) => e.isSymbolicLink()), "symlink was stripped").toBe(false);
    expect(entries.some((e) => e.name === "real.txt")).toBe(true); // real files untouched
  });
});

describe("extractTarGzSafe (real tar)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "safe-extract-tar-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("rejects a corrupt/junk archive with a 400, not an unhandled error", async () => {
    // What GH #10's reporter would upload by accident: bytes that aren't a tar.gz.
    const junk = join(dir, "junk.tar.gz");
    const bytes = Buffer.alloc(1024, 7);
    bytes[0] = 0x1f; bytes[1] = 0x8b; // gzip magic, but garbage after — like a truncated upload
    await writeFile(junk, bytes);
    const { BadRequestException } = await import("@nestjs/common");
    const err = await extractTarGzSafe(junk, dir).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(String((err as Error).message)).toMatch(/not a valid \.tar\.gz/i);
  });

  it("still extracts a genuine tar.gz", async () => {
    const src = join(dir, "src");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(src, { recursive: true });
    await writeFile(join(src, "hello.txt"), "world");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    await promisify(execFile)("tar", ["czf", join(dir, "ok.tar.gz"), "-C", src, "hello.txt"]);
    const out = join(dir, "out");
    await mkdir(out, { recursive: true });
    await extractTarGzSafe(join(dir, "ok.tar.gz"), out);
    expect(await readFile(join(out, "hello.txt"), "utf8")).toBe("world");
  });
});
