import { describe, it, expect, beforeAll } from "vitest";
import { Game, type ServerConfigValues } from "@ark/shared";
import { DRAGONWILDS_CATALOG } from "../catalog/dragonwilds.catalog";

beforeAll(() => {
  process.env.SECRETS_KEY = "a".repeat(64);
  process.env.JWT_SECRET = "test-jwt-secret-1234";
  process.env.DATA_DIR = "/data";
});

const OWNER = "00021c70c42e4b508ebad2724daaa969";

async function buildDragonwilds(values: Record<string, unknown> = {}, maxPlayers = 6) {
  const { buildContainerSpec } = await import("./runtime-spec");
  return buildContainerSpec({
    serverId: "srv1",
    game: Game.DRAGONWILDS,
    map: "Dragonwilds",
    sessionName: "Palisade Test",
    ports: { game: 7777, rawSocket: 0, query: 0, rcon: 0 },
    maxPlayers,
    adminPassword: OWNER,
    serverPassword: "testjoin",
    modIds: [],
    cluster: null,
    config: { values } as ServerConfigValues,
    catalog: DRAGONWILDS_CATALOG,
  });
}

describe("buildContainerSpec (Dragonwilds / ferment9348)", () => {
  it("maps the owner id, names, password and port into the image env with a TTY", async () => {
    const spec = await buildDragonwilds();
    expect(spec.Image).toBe("ferment9348/dragonwilds:1.1.1");
    expect(spec.Tty).toBe(true);
    const env = spec.Env ?? [];
    expect(env).toContain(`OWNER_ID=${OWNER}`);
    expect(env).toContain("SERVER_NAME=Palisade Test");
    expect(env).toContain("WORLD_NAME=MyWorld");
    expect(env).toContain("SRV_PWD=testjoin");
    expect(env).toContain("GAME_PORT=7777");
    expect(spec.HostConfig?.PortBindings?.["7777/udp"]).toEqual([{ HostPort: "7777" }]);
    expect(Object.keys(spec.HostConfig?.PortBindings ?? {})).toEqual(["7777/udp"]);
    const binds = spec.HostConfig?.Binds ?? [];
    expect(binds.some((b) => b.endsWith("/gamefiles:/serverdata/serverfiles"))).toBe(true);
    expect(binds.some((b) => b.endsWith("/steamcmd:/serverdata/steamcmd"))).toBe(true);
  });

  it("turns max players and the autosave setting into engine launch overrides", async () => {
    const spec = await buildDragonwilds({ AUTOSAVE_MINUTES: 1, WORLD_NAME: "Gielinor", GAME_PARAMS_EXTRA: "-foo" }, 9);
    const extra = (spec.Env ?? []).find((e) => e.startsWith("GAME_PARAMS_EXTRA="));
    expect(extra).toBe(
      "GAME_PARAMS_EXTRA=-ini:Game:[/Script/Engine.GameSession]:MaxPlayers=6 -ini:Engine:[ConsoleVariables]:dom.StateSaveFrequencyMins=1 -foo",
    );
    expect(spec.Env).toContain("WORLD_NAME=Gielinor");
  });
});

describe("dragonwildsInviteCode", () => {
  it("returns the last JoinCode the session wrote, or null", async () => {
    const { dragonwildsInviteCode } = await import("./servers.service");
    const log = [
      'LogNetSessionSettings: Setting ["JoinCode"] written with key[xz] value[SL8N-8DSM]',
      'LogNetSessionSettings: Setting ["ReadyToJoin"] written with key[x0] value[1]',
      'LogNetSessionSettings: Setting ["JoinCode"] written with key[xz] value[XT24-MB9H]',
    ].join("\n");
    expect(dragonwildsInviteCode(log)).toBe("XT24-MB9H");
    expect(dragonwildsInviteCode("nothing here")).toBeNull();
  });

  it("accepts only 32-hex owner ids", async () => {
    const { DRAGONWILDS_OWNER_ID_RE } = await import("./runtime-spec");
    expect(DRAGONWILDS_OWNER_ID_RE.test(OWNER)).toBe(true);
    expect(DRAGONWILDS_OWNER_ID_RE.test("PLACEHOLDER0000000000000000000000")).toBe(false);
  });
});
