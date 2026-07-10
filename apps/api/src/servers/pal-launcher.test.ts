import { describe, it, expect, beforeAll } from "vitest";
import { patchPalServerLauncher } from "./runtime-spec";

beforeAll(() => {
  process.env.SECRETS_KEY = "a".repeat(64);
  process.env.JWT_SECRET = "test-jwt-secret-1234";
});

/**
 * Verbatim tail of Steam's PalServer.sh (captured from a real Palworld install).
 * UE4SS must be preloaded HERE, not as a container-wide LD_PRELOAD: preloading it
 * into bash/steamcmd segfaults them (verified live — `bash -c echo` exits 139).
 */
const REAL = `#!/bin/sh
UE_TRUE_SCRIPT_NAME=$(echo \\"$0\\" | xargs readlink -f)
UE_PROJECT_ROOT=$(dirname "$UE_TRUE_SCRIPT_NAME")
chmod +x "$UE_PROJECT_ROOT/Pal/Binaries/Linux/PalServer-Linux-Shipping"
"$UE_PROJECT_ROOT/Pal/Binaries/Linux/PalServer-Linux-Shipping" Pal "$@"
`;

const PRELOAD = "Pal/Binaries/Linux/libUE4SS.so";
const PRELOADED_LINE = `LD_PRELOAD="$UE_PROJECT_ROOT/Pal/Binaries/Linux/libUE4SS.so" "$UE_PROJECT_ROOT/Pal/Binaries/Linux/PalServer-Linux-Shipping" Pal "$@"`;

describe("patchPalServerLauncher", () => {
  it("prefixes the game exec line only, leaving the rest of the script intact", () => {
    const out = patchPalServerLauncher(REAL, PRELOAD);
    expect(out).toContain(PRELOADED_LINE);
    expect(out).toContain('chmod +x "$UE_PROJECT_ROOT/Pal/Binaries/Linux/PalServer-Linux-Shipping"');
    expect(out.startsWith("#!/bin/sh")).toBe(true);
    // Exactly one preload — the chmod line must not be touched.
    expect(out.match(/LD_PRELOAD=/g)).toHaveLength(1);
  });

  it("is idempotent — re-applying on every start doesn't stack preloads", () => {
    const once = patchPalServerLauncher(REAL, PRELOAD);
    const twice = patchPalServerLauncher(once, PRELOAD);
    expect(twice).toBe(once);
  });

  it("removes the preload when the framework is disabled", () => {
    const on = patchPalServerLauncher(REAL, PRELOAD);
    const off = patchPalServerLauncher(on, null);
    expect(off).toBe(REAL);
    expect(off).not.toContain("LD_PRELOAD");
  });

  it("swaps a previously-set custom preload rather than duplicating it", () => {
    const custom = patchPalServerLauncher(REAL, "Pal/Binaries/Linux/other.so");
    const swapped = patchPalServerLauncher(custom, PRELOAD);
    expect(swapped.match(/LD_PRELOAD=/g)).toHaveLength(1);
    expect(swapped).toContain(PRELOADED_LINE);
    expect(swapped).not.toContain("other.so");
  });

  it("leaves an unrecognized launcher untouched instead of bricking the server", () => {
    const weird = "#!/bin/sh\nexec /some/other/binary --serve\n";
    expect(patchPalServerLauncher(weird, PRELOAD)).toBe(weird);
  });
});
