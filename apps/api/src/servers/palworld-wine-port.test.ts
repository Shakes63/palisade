import { describe, it, expect, beforeAll } from "vitest";
import { Game, type SettingsCatalog } from "@ark/shared";
import {
  PALWORLD_WINE_GAME_PORT,
  PALWORLD_WINE_PORTS,
  forwardSpec,
  palworldWinePortIssue,
} from "../catalog/ports";
import { buildContainerSpec } from "./runtime-spec";
import { resetEnvCache } from "../config/env";

/**
 * GH #39. The ripps818 Wine image runs PalServer.exe with no `-port=` argument and
 * offers no way to pass one, so the server always binds Palworld's default 8211 —
 * while PUBLIC_PORT only writes the port ADVERTISED to the community list. Palisade
 * allocated 8311, displayed it, and offered to forward it; the reporter forwarded a
 * port nothing was listening on. On a bridge it was worse: the published mapping
 * pointed at a dead container port, so the server was unreachable outright.
 */
beforeAll(() => {
  process.env.SECRETS_KEY = "a".repeat(64);
  process.env.JWT_SECRET = "test-jwt-secret-1234";
  process.env.DATA_DIR = "/data";
  resetEnvCache();
});

const base = {
  serverId: "srv1",
  game: Game.PALWORLD_WINE,
  map: "",
  sessionName: "Pals",
  ports: PALWORLD_WINE_PORTS,
  maxPlayers: 32,
  adminPassword: "changeme",
  modIds: [],
  config: { values: {} },
  catalog: { settings: [] } as unknown as SettingsCatalog,
} as unknown as Parameters<typeof buildContainerSpec>[0];

describe("the advertised default", () => {
  it("matches the port the image actually binds", () => {
    expect(PALWORLD_WINE_PORTS.game).toBe(PALWORLD_WINE_GAME_PORT);
    expect(PALWORLD_WINE_GAME_PORT).toBe(8211);
  });

  it("offers that port for forwarding, not a port nothing is bound to", () => {
    const spec = forwardSpec(Game.PALWORLD_WINE, PALWORLD_WINE_PORTS);
    expect(spec.map((p) => p.port)).toEqual([8211]);
  });
});

describe("bridged container mapping", () => {
  it("publishes the host port onto the container's fixed 8211", () => {
    // The bug: 8311 -> 8311 published a port nothing inside was listening on.
    const spec = buildContainerSpec({ ...base, hostNetwork: false });
    expect(spec.HostConfig?.PortBindings).toMatchObject({
      "8211/udp": [{ HostPort: "8211" }],
    });
    expect(spec.ExposedPorts).toHaveProperty("8211/udp");
  });

  it("still honours a custom host port, since Docker does the remapping", () => {
    const spec = buildContainerSpec({
      ...base,
      ports: { ...PALWORLD_WINE_PORTS, game: 9000 },
      hostNetwork: false,
    });
    // Host side is the user's choice; container side is never negotiable.
    expect(spec.HostConfig?.PortBindings).toMatchObject({
      "8211/udp": [{ HostPort: "9000" }],
    });
  });

  it("advertises the host-side port to the community list", () => {
    const spec = buildContainerSpec({
      ...base,
      ports: { ...PALWORLD_WINE_PORTS, game: 9000 },
      hostNetwork: false,
    });
    expect(spec.Env).toContain("PUBLIC_PORT=9000");
  });

  it("maps RCON straight through, which the image genuinely can move", () => {
    const spec = buildContainerSpec({ ...base, hostNetwork: false });
    expect(spec.HostConfig?.PortBindings).toMatchObject({
      "8314/tcp": [{ HostPort: "8314" }],
    });
    expect(spec.Env).toContain("RCON_PORT=8314");
  });
});

describe("palworldWinePortIssue", () => {
  it("is silent on the default, in either networking mode", () => {
    expect(palworldWinePortIssue(Game.PALWORLD_WINE, PALWORLD_WINE_PORTS, true)).toBeNull();
    expect(palworldWinePortIssue(Game.PALWORLD_WINE, PALWORLD_WINE_PORTS, false)).toBeNull();
  });

  it("allows any port on the bridge, where Docker can remap it", () => {
    const ports = { ...PALWORLD_WINE_PORTS, game: 9000 };
    expect(palworldWinePortIssue(Game.PALWORLD_WINE, ports, false)).toBeNull();
  });

  it("refuses a custom port on the host network, where nothing can remap it", () => {
    const ports = { ...PALWORLD_WINE_PORTS, game: 9000 };
    const issue = palworldWinePortIssue(Game.PALWORLD_WINE, ports, true);
    expect(issue).toContain("9000");
    expect(issue).toContain("8211");
    expect(issue).toContain("bridge");
  });

  it("says nothing about other games, including native Palworld", () => {
    const ports = { ...PALWORLD_WINE_PORTS, game: 9000 };
    expect(palworldWinePortIssue(Game.PALWORLD, ports, true)).toBeNull();
    expect(palworldWinePortIssue(Game.ASA, ports, true)).toBeNull();
  });
});
