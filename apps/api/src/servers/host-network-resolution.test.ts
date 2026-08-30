import { describe, it, expect, beforeEach } from "vitest";
import { resetEnvCache } from "../config/env";
import { buildContainerSpec } from "./runtime-spec";
import { Game } from "@ark/shared";
import { SettingsCatalog } from "@ark/shared";

/**
 * GAME_HOST_NETWORK and PUBLIC_BASE_URL became settings, so three sources can now
 * decide them: the server's own column, the manager-wide setting, and the env var.
 * The caller resolves the first two into the spec input; these lock down the last
 * step, because getting it wrong silently creates containers on the wrong network —
 * which is exactly the class of problem #21 and #31 were.
 */
const base = {
  serverId: "srv1",
  game: Game.VALHEIM,
  map: "Dedicated",
  sessionName: "Test",
  ports: { game: 2456, query: 2457, rcon: 2458 },
  maxPlayers: 10,
  adminPassword: "changeme",
  modIds: [],
  config: { values: {} },
  catalog: { settings: [] } as unknown as SettingsCatalog,
} as unknown as Parameters<typeof buildContainerSpec>[0];

const networkOf = (spec: { HostConfig?: { NetworkMode?: string } }) =>
  spec.HostConfig?.NetworkMode ?? "bridge";

beforeEach(() => {
  process.env.SECRETS_KEY = "a".repeat(64);
  process.env.JWT_SECRET = "b".repeat(32);
  process.env.GAME_HOST_NETWORK = "false";
  process.env.PUBLIC_BASE_URL = "http://from-env:8970";
  resetEnvCache();
});

describe("host networking resolution", () => {
  it("falls back to the env var when nothing is set above it", () => {
    expect(networkOf(buildContainerSpec({ ...base, hostNetwork: null }))).not.toBe("host");
    process.env.GAME_HOST_NETWORK = "true";
    resetEnvCache();
    expect(networkOf(buildContainerSpec({ ...base, hostNetwork: null }))).toBe("host");
  });

  it("lets a resolved true override an env var that says false", () => {
    expect(networkOf(buildContainerSpec({ ...base, hostNetwork: true }))).toBe("host");
  });

  it("lets a resolved false override an env var that says true", () => {
    // The direction that matters most: a per-server opt-out has to beat a global on.
    process.env.GAME_HOST_NETWORK = "true";
    resetEnvCache();
    expect(networkOf(buildContainerSpec({ ...base, hostNetwork: false }))).not.toBe("host");
  });

  it("puts bridged containers on the shared network and host ones on neither", () => {
    const bridged = buildContainerSpec({ ...base, hostNetwork: false });
    expect(Object.keys(bridged.NetworkingConfig?.EndpointsConfig ?? {})).toEqual(["palisade-net"]);
    const hosted = buildContainerSpec({ ...base, hostNetwork: true });
    expect(hosted.NetworkingConfig).toBeUndefined();
  });
});

describe("base URL resolution", () => {
  const webui = (spec: { Labels?: Record<string, string> }) =>
    spec.Labels?.["net.unraid.docker.webui"] ?? "";

  it("uses the env var when the setting is unset", () => {
    expect(webui(buildContainerSpec({ ...base, baseUrl: null }))).toContain("http://from-env:8970");
  });

  it("prefers a configured base URL", () => {
    expect(webui(buildContainerSpec({ ...base, baseUrl: "http://from-settings:9000" }))).toContain(
      "http://from-settings:9000",
    );
  });

  it("treats a blank setting as unset rather than as an empty URL", () => {
    // Unraid and the settings form both hand back "" for a cleared field.
    expect(webui(buildContainerSpec({ ...base, baseUrl: "" }))).toContain("http://from-env:8970");
  });
});
