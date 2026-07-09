import { describe, it, expect, beforeAll } from "vitest";
import { Game, type ServerConfigValues } from "@ark/shared";
import { ASA_CATALOG } from "../catalog/asa.catalog";

beforeAll(() => {
  process.env.SECRETS_KEY = "a".repeat(64);
  process.env.JWT_SECRET = "test-jwt-secret-1234";
  process.env.DATA_DIR = "/data";
});

async function buildAsa(config: ServerConfigValues, cluster: { clusterId: string } | null = null) {
  const { buildContainerSpec } = await import("./runtime-spec");
  return buildContainerSpec({
    serverId: "srv1",
    game: Game.ASA,
    map: "TheIsland_WP",
    sessionName: "My Server",
    ports: { game: 7777, rawSocket: 7778, query: 7779, rcon: 27020 },
    maxPlayers: 50,
    adminPassword: "secret",
    serverPassword: "pw",
    modIds: [111, 222],
    cluster,
    config,
    catalog: ASA_CATALOG,
  });
}

const envOf = (spec: { Env?: string[] }) => spec.Env ?? [];

describe("buildContainerSpec (POK / ASA)", () => {
  it("routes a set MOTD through POK env vars (POK strips the INI section)", async () => {
    const spec = await buildAsa({
      values: { MessageOfTheDay: { message: "Welcome to the server", duration: 45 } },
    });
    const env = envOf(spec);
    expect(env).toContain("ENABLE_MOTD=TRUE");
    expect(env).toContain("MOTD=Welcome to the server");
    expect(env).toContain("MOTD_DURATION=45");
  });

  it("disables MOTD when unset or blank", async () => {
    const env = envOf(await buildAsa({ values: { MessageOfTheDay: { message: "  ", duration: 30 } } }));
    expect(env).toContain("ENABLE_MOTD=FALSE");
    expect(env.some((e) => e.startsWith("MOTD="))).toBe(false);
  });

  it("passes core POK contract vars (ports, mods, RCON, players)", async () => {
    const env = envOf(await buildAsa({ values: {} }));
    expect(env).toContain("ASA_PORT=7777");
    expect(env).toContain("RCON_PORT=27020");
    expect(env).toContain("RCON_ENABLED=TRUE");
    expect(env).toContain("MAX_PLAYERS=50");
    expect(env).toContain("MOD_IDS=111,222");
    expect(env).toContain("MAP_NAME=TheIsland_WP");
  });

  it("sources SERVER_PASSWORD from the plain-text catalog value, else the legacy field", async () => {
    // the visible/editable config value wins...
    expect(envOf(await buildAsa({ values: { ServerPassword: "hunter2" } }))).toContain(
      "SERVER_PASSWORD=hunter2",
    );
    // ...and falls back to the legacy encrypted field ("pw") when it's unset
    expect(envOf(await buildAsa({ values: {} }))).toContain("SERVER_PASSWORD=pw");
  });

  it("mounts a shared cluster dir + sets -ClusterDirOverride when clustered", async () => {
    const spec = await buildAsa({ values: {} }, { clusterId: "cluster-a" });
    const env = envOf(spec);
    expect(env).toContain("CLUSTER_ID=cluster-a"); // POK turns this into -clusterid
    const custom = env.find((e) => e.startsWith("CUSTOM_SERVER_ARGS="));
    expect(custom).toContain("-ClusterDirOverride=/home/pok/clustershared");
    const binds = spec.HostConfig?.Binds ?? [];
    expect(binds.some((b) => b.includes("/clusters/cluster-a:/home/pok/clustershared"))).toBe(true);
  });

  it("omits the cluster dir + override for a standalone server", async () => {
    const spec = await buildAsa({ values: {} });
    const custom = envOf(spec).find((e) => e.startsWith("CUSTOM_SERVER_ARGS=")) ?? "";
    expect(custom).not.toContain("ClusterDirOverride");
    expect((spec.HostConfig?.Binds ?? []).some((b) => b.includes("clustershared"))).toBe(false);
  });
});

async function buildAse(config: ServerConfigValues, cluster: { clusterId: string } | null = null) {
  const { buildContainerSpec } = await import("./runtime-spec");
  const { ASE_CATALOG } = await import("../catalog/ase.catalog");
  return buildContainerSpec({
    serverId: "srv1",
    game: Game.ASE,
    map: "TheIsland",
    sessionName: "My ASE Server",
    ports: { game: 7777, rawSocket: 7778, query: 27015, rcon: 27020 },
    maxPlayers: 40,
    adminPassword: "secret",
    serverPassword: "pw",
    modIds: [731604991],
    cluster,
    config,
    catalog: ASE_CATALOG,
  });
}

describe("buildContainerSpec (hermsi / ASE)", () => {
  it("maps the server config to hermsi's env contract", async () => {
    const spec = await buildAse({ values: {} });
    const env = envOf(spec);
    expect(spec.Image).toBe("hermsi/ark-server:latest");
    expect(env).toContain("SERVER_MAP=TheIsland");
    expect(env).toContain("SESSION_NAME=My ASE Server");
    expect(env).toContain("ADMIN_PASSWORD=secret");
    expect(env).toContain("MAX_PLAYERS=40");
    expect(env).toContain("GAME_MOD_IDS=731604991");
    expect(env).toContain("GAME_CLIENT_PORT=7777");
    expect(env).toContain("RCON_PORT=27020");
    expect(env).toContain("SERVER_LIST_PORT=27015");
    expect(env).toContain("UPDATE_ON_START=true");
    // hermsi installs game files into /app; INIs live under /app/server/...
    expect((spec.HostConfig?.Binds ?? []).some((b) => b.endsWith(":/app"))).toBe(true);
  });

  it("disables BattlEye via DISABLE_BATTLEYE when the flag is set", async () => {
    const off = envOf(await buildAse({ values: { DisableBattlEye: true } }));
    expect(off).toContain("DISABLE_BATTLEYE=true");
    const on = envOf(await buildAse({ values: {} }));
    expect(on).toContain("DISABLE_BATTLEYE=false");
  });

  it("passes cluster args via Cmd + mounts the shared dir when clustered", async () => {
    const spec = await buildAse({ values: {} }, { clusterId: "cl-7" });
    expect(spec.Cmd).toContain("--arkopt,-clusterid=cl-7");
    expect(spec.Cmd).toContain("--arkopt,-ClusterDirOverride=/clustershared");
    expect((spec.HostConfig?.Binds ?? []).some((b) => b.endsWith(":/clustershared"))).toBe(true);
  });

  it("has no Cmd for a standalone ASE server", async () => {
    const spec = await buildAse({ values: {} });
    expect(spec.Cmd).toBeUndefined();
  });
});

async function buildConan(config: ServerConfigValues) {
  const { buildContainerSpec } = await import("./runtime-spec");
  const { CONAN_CATALOG } = await import("../catalog/conan.catalog");
  return buildContainerSpec({
    serverId: "srv1",
    game: Game.CONAN,
    map: "ConanSandbox",
    sessionName: "My Conan Server",
    ports: { game: 7777, rawSocket: 7778, query: 27015, rcon: 25575 },
    maxPlayers: 40,
    adminPassword: "secret",
    serverPassword: "pw",
    modIds: [111, 222],
    cluster: null,
    config,
    catalog: CONAN_CATALOG,
  });
}

describe("buildContainerSpec (Conan)", () => {
  it("uses the Conan image and the core env contract", async () => {
    const spec = await buildConan({ values: {} });
    expect(spec.Image).toBe("acekorneya/conan_enhanced_server:latest");
    const env = envOf(spec);
    expect(env).toContain("SERVER_NAME=My Conan Server");
    expect(env).toContain("ADMIN_PASSWORD=secret");
    expect(env).toContain("RCON_PASSWORD=secret"); // RCON authenticates with the admin password
    expect(env).toContain("RCON_PORT=25575");
    expect(env).toContain("SERVER_PORT=7777");
    expect(env).toContain("QUERY_PORT=27015");
    expect(env).toContain("MAX_PLAYERS=40");
    expect(env).toContain("MOD_IDS=111,222");
    expect(env).toContain("AUTO_UPDATE=false"); // manager owns updates
  });

  it("passes catalog settings through as env vars (bools as true/false)", async () => {
    const env = envOf(await buildConan({ values: { PVP_ENABLED: false, XP_RATE_MULTIPLIER: 2 } }));
    expect(env).toContain("PVP_ENABLED=false");
    expect(env).toContain("XP_RATE_MULTIPLIER=2");
  });
});

async function buildMinecraft(
  config: ServerConfigValues,
  ramLimitMb: number | null = null,
  curseForgeApiKey: string | null = null,
) {
  const { buildContainerSpec } = await import("./runtime-spec");
  const { MINECRAFT_CATALOG } = await import("../catalog/minecraft.catalog");
  return buildContainerSpec({
    serverId: "srv1",
    game: Game.MINECRAFT,
    map: "minecraft:flat",
    sessionName: "My MC Server",
    ports: { game: 25565, rawSocket: 25566, query: 25565, rcon: 25575 },
    maxPlayers: 20,
    adminPassword: "secret",
    serverPassword: "pw",
    modIds: [],
    cluster: null,
    config,
    catalog: MINECRAFT_CATALOG,
    ramLimitMb,
    curseForgeApiKey,
  });
}

describe("buildContainerSpec (Minecraft / itzg)", () => {
  it("uses the itzg image, accepts EULA, and wires RCON + the single TCP game port", async () => {
    const spec = await buildMinecraft({ values: {} });
    expect(spec.Image).toBe("itzg/minecraft-server:latest");
    const env = envOf(spec);
    expect(env).toContain("EULA=TRUE");
    expect(env).toContain("SERVER_PORT=25565");
    expect(env).toContain("ENABLE_RCON=true");
    expect(env).toContain("RCON_PORT=25575");
    expect(env).toContain("RCON_PASSWORD=secret");
    expect(env).toContain("MAX_PLAYERS=20");
    expect(env).toContain("MOTD=My MC Server");
    expect(env).toContain("LEVEL_TYPE=minecraft:flat"); // the map field carries the world type
    expect(env).toContain("LEVEL=world");
    // TCP, not UDP — both the game and RCON ports
    expect(spec.HostConfig?.PortBindings?.["25565/tcp"]).toEqual([{ HostPort: "25565" }]);
    expect(spec.HostConfig?.PortBindings?.["25575/tcp"]).toEqual([{ HostPort: "25575" }]);
    // One bind covers jar + worlds + config at /data
    expect((spec.HostConfig?.Binds ?? []).some((b) => b.endsWith(":/data"))).toBe(true);
  });

  it("sizes the JVM heap to ~80% of the RAM cap, else a 3 GB default", async () => {
    expect(envOf(await buildMinecraft({ values: {} }, 8000))).toContain("MEMORY=6400M");
    expect(envOf(await buildMinecraft({ values: {} }))).toContain("MEMORY=3072M");
  });

  it("passes catalog settings through (bools as true/false), dropping empty strings", async () => {
    const env = envOf(await buildMinecraft({ values: { DIFFICULTY: "hard", PVP: false, SEED: "" } }));
    expect(env).toContain("DIFFICULTY=hard");
    expect(env).toContain("PVP=false");
    expect(env.some((e) => e.startsWith("SEED="))).toBe(false); // empty SEED is dropped
  });

  it("switches to AUTO_CURSEFORGE for a modpack, suppressing the catalog TYPE/VERSION", async () => {
    const env = envOf(
      await buildMinecraft(
        { values: { _mcModpackSlug: "all-the-mods-10", _mcModpackFileId: 12345, TYPE: "PAPER" } },
        null,
        "cf-key-abc",
      ),
    );
    expect(env).toContain("TYPE=AUTO_CURSEFORGE");
    expect(env).toContain("CF_API_KEY=cf-key-abc");
    expect(env).toContain("CF_SLUG=all-the-mods-10");
    expect(env).toContain("CF_FILE_ID=12345");
    expect(env).not.toContain("TYPE=PAPER"); // the catalog flavour is overridden by the pack
  });

  it("ignores a modpack slug when no CurseForge key is available (stays vanilla)", async () => {
    const env = envOf(await buildMinecraft({ values: { _mcModpackSlug: "all-the-mods-10" } }, null, null));
    expect(env.some((e) => e.startsWith("CF_SLUG="))).toBe(false);
    expect(env).not.toContain("TYPE=AUTO_CURSEFORGE");
  });
});

async function buildIcarus(config: ServerConfigValues) {
  const { buildContainerSpec } = await import("./runtime-spec");
  const { ICARUS_CATALOG } = await import("../catalog/icarus.catalog");
  return buildContainerSpec({
    serverId: "srv1",
    game: Game.ICARUS,
    map: "Prospect",
    sessionName: "My Icarus Server",
    ports: { game: 17777, rawSocket: 17778, query: 27015, rcon: 0 },
    maxPlayers: 8,
    adminPassword: "secret",
    serverPassword: "pw",
    modIds: [],
    cluster: null,
    config,
    catalog: ICARUS_CATALOG,
  });
}

describe("buildContainerSpec (Icarus / mornedhels)", () => {
  it("maps the config to the image's env contract (2 UDP ports, no RCON)", async () => {
    const spec = await buildIcarus({ values: {} });
    expect(spec.Image).toBe("mornedhels/icarus-server:latest");
    const env = envOf(spec);
    expect(env).toContain("SERVER_NAME=My Icarus Server");
    expect(env).toContain("SERVER_ADMIN_PASSWORD=secret");
    expect(env).toContain("SERVER_PASSWORD=pw");
    expect(env).toContain("SERVER_MAX_PLAYERS=8");
    expect(env).toContain("SERVER_PORT=17777");
    expect(env).toContain("SERVER_QUERYPORT=27015");
    // game + query are UDP; no RCON port is published
    expect(spec.HostConfig?.PortBindings?.["17777/udp"]).toEqual([{ HostPort: "17777" }]);
    expect(spec.HostConfig?.PortBindings?.["27015/udp"]).toEqual([{ HostPort: "27015" }]);
    expect(Object.keys(spec.HostConfig?.PortBindings ?? {}).some((k) => k.endsWith("/tcp"))).toBe(false);
    // config+saves and game files bound separately
    const binds = spec.HostConfig?.Binds ?? [];
    expect(binds.some((b) => b.endsWith(":/home/icarus/drive_c/icarus"))).toBe(true);
    expect(binds.some((b) => b.endsWith(":/opt/icarus"))).toBe(true);
  });

  it("passes catalog settings through as env vars (bools as True/False)", async () => {
    const env = envOf(
      await buildIcarus({ values: { SERVER_ALLOW_NON_ADMINS_DELETE: true, SERVER_SHUTDOWN_IF_EMPTY: 120 } }),
    );
    expect(env).toContain("SERVER_ALLOW_NON_ADMINS_DELETE=True");
    expect(env).toContain("SERVER_SHUTDOWN_IF_EMPTY=120");
  });
});

async function buildBedrock(config: ServerConfigValues) {
  const { buildContainerSpec } = await import("./runtime-spec");
  const { BEDROCK_CATALOG } = await import("../catalog/bedrock.catalog");
  return buildContainerSpec({
    serverId: "srv1",
    game: Game.BEDROCK,
    map: "FLAT",
    sessionName: "My Bedrock Server",
    ports: { game: 19132, rawSocket: 19133, query: 19132, rcon: 0 },
    maxPlayers: 10,
    adminPassword: "secret",
    serverPassword: "pw",
    modIds: [],
    cluster: null,
    config,
    catalog: BEDROCK_CATALOG,
  });
}

describe("buildContainerSpec (Bedrock / itzg)", () => {
  it("uses the bedrock image, accepts EULA, and publishes both UDP ports (no RCON)", async () => {
    const spec = await buildBedrock({ values: {} });
    expect(spec.Image).toBe("itzg/minecraft-bedrock-server:latest");
    const env = envOf(spec);
    expect(env).toContain("EULA=TRUE");
    expect(env).toContain("SERVER_NAME=My Bedrock Server");
    expect(env).toContain("SERVER_PORT=19132");
    expect(env).toContain("SERVER_PORT_V6=19133");
    expect(env).toContain("MAX_PLAYERS=10");
    expect(env).toContain("LEVEL_TYPE=FLAT"); // the map field carries the world type
    expect(env).toContain("LEVEL_NAME=world");
    // IPv4 + IPv6 UDP; no TCP / RCON port
    expect(spec.HostConfig?.PortBindings?.["19132/udp"]).toEqual([{ HostPort: "19132" }]);
    expect(spec.HostConfig?.PortBindings?.["19133/udp"]).toEqual([{ HostPort: "19133" }]);
    expect(Object.keys(spec.HostConfig?.PortBindings ?? {}).some((k) => k.endsWith("/tcp"))).toBe(false);
    expect((spec.HostConfig?.Binds ?? []).some((b) => b.endsWith(":/data"))).toBe(true);
  });

  it("passes catalog settings through (bools as true/false), dropping an empty seed", async () => {
    const env = envOf(await buildBedrock({ values: { GAMEMODE: "creative", ALLOW_CHEATS: true, LEVEL_SEED: "" } }));
    expect(env).toContain("GAMEMODE=creative");
    expect(env).toContain("ALLOW_CHEATS=true");
    expect(env.some((e) => e.startsWith("LEVEL_SEED="))).toBe(false);
  });
});

async function buildValheim(config: ServerConfigValues) {
  const { buildContainerSpec } = await import("./runtime-spec");
  const { VALHEIM_CATALOG } = await import("../catalog/valheim.catalog");
  return buildContainerSpec({
    serverId: "srv1",
    game: Game.VALHEIM,
    map: "Valheim",
    sessionName: "My Valheim Server",
    ports: { game: 2456, rawSocket: 2458, query: 2457, rcon: 0 },
    maxPlayers: 10,
    adminPassword: "secret",
    serverPassword: "hunter2",
    modIds: [],
    cluster: null,
    config,
    catalog: VALHEIM_CATALOG,
  });
}

describe("buildContainerSpec (Valheim / lloesche)", () => {
  it("maps the config to the lloesche env contract (3 UDP ports, no RCON)", async () => {
    const spec = await buildValheim({ values: {} });
    expect(spec.Image).toBe("lloesche/valheim-server:latest");
    const env = envOf(spec);
    expect(env).toContain("SERVER_NAME=My Valheim Server");
    expect(env).toContain("SERVER_PASS=hunter2"); // the join password (>= 5 chars)
    expect(env).toContain("SERVER_PORT=2456");
    expect(env).toContain("WORLD_NAME=Dedicated");
    // game + query + crossplay are UDP; the only TCP port is the HTTP status
    // endpoint (game + 3) the manager reads player counts from. No RCON.
    expect(spec.HostConfig?.PortBindings?.["2456/udp"]).toEqual([{ HostPort: "2456" }]);
    expect(spec.HostConfig?.PortBindings?.["2457/udp"]).toEqual([{ HostPort: "2457" }]);
    expect(spec.HostConfig?.PortBindings?.["2459/tcp"]).toEqual([{ HostPort: "2459" }]);
    expect(env).toContain("STATUS_HTTP=true");
    expect(env).toContain("STATUS_HTTP_PORT=2459");
    // config + worlds and the game install bound separately
    const binds = spec.HostConfig?.Binds ?? [];
    expect(binds.some((b) => b.endsWith(":/config"))).toBe(true);
    expect(binds.some((b) => b.endsWith(":/opt/valheim"))).toBe(true);
  });

  it("passes catalog settings through (bools as true/false)", async () => {
    const env = envOf(await buildValheim({ values: { SERVER_PUBLIC: false, CROSSPLAY: true } }));
    expect(env).toContain("SERVER_PUBLIC=false");
    expect(env).toContain("CROSSPLAY=true");
  });

  it("compiles world modifiers into SERVER_ARGS (not bogus env vars)", async () => {
    const env = envOf(
      await buildValheim({
        values: { PRESET: "hard", MOD_combat: "veryhard", MOD_portals: "casual", KEY_nomap: true },
      }),
    );
    const args = env.find((e) => e.startsWith("SERVER_ARGS="));
    expect(args).toBeDefined();
    expect(args).toContain("-preset hard");
    expect(args).toContain("-modifier combat veryhard");
    expect(args).toContain("-modifier portals casual");
    expect(args).toContain("-setkey nomap");
    // The modifier keys must NOT leak through as their own env vars.
    expect(env.some((e) => e.startsWith("PRESET="))).toBe(false);
    expect(env.some((e) => e.startsWith("MOD_combat="))).toBe(false);
  });

  it("omits SERVER_ARGS when no modifiers are set", async () => {
    const env = envOf(await buildValheim({ values: {} }));
    expect(env.some((e) => e.startsWith("SERVER_ARGS="))).toBe(false);
  });
});

async function buildSdtd() {
  const { buildContainerSpec } = await import("./runtime-spec");
  const { SEVEN_DAYS_CATALOG } = await import("../catalog/seven-days.catalog");
  return buildContainerSpec({
    serverId: "srv1",
    game: Game.SEVEN_DAYS,
    map: "Navezgane",
    sessionName: "My 7DTD Server",
    ports: { game: 26900, rawSocket: 26901, query: 26902, rcon: 8081 },
    maxPlayers: 8,
    adminPassword: "secret",
    serverPassword: "pw",
    modIds: [],
    cluster: null,
    config: { values: {} },
    catalog: SEVEN_DAYS_CATALOG,
  });
}

describe("buildContainerSpec (7 Days to Die / vinanrra)", () => {
  it("drives LinuxGSM via env + publishes 26900 tcp/udp, 26901/26902 udp, 8081 telnet", async () => {
    const spec = await buildSdtd();
    expect(spec.Image).toBe("vinanrra/7dtd-server:latest");
    const env = envOf(spec);
    expect(env).toContain("START_MODE=1");
    expect(env).toContain("BACKUP=NO"); // manager owns backups
    expect(env).toContain("MONITOR=NO");
    const pb = spec.HostConfig?.PortBindings ?? {};
    expect(pb["26900/tcp"]).toEqual([{ HostPort: "26900" }]);
    expect(pb["26900/udp"]).toEqual([{ HostPort: "26900" }]);
    expect(pb["8081/tcp"]).toEqual([{ HostPort: "8081" }]); // telnet console
    const binds = spec.HostConfig?.Binds ?? [];
    expect(binds.some((b) => b.endsWith(":/home/sdtdserver/serverfiles"))).toBe(true);
    expect(binds.some((b) => b.endsWith(":/home/sdtdserver/.local/share/7DaysToDie"))).toBe(true);
  });
});

async function buildEnshrouded(config: ServerConfigValues) {
  const { buildContainerSpec } = await import("./runtime-spec");
  const { ENSHROUDED_CATALOG } = await import("../catalog/enshrouded.catalog");
  return buildContainerSpec({
    serverId: "srv1",
    game: Game.ENSHROUDED,
    map: "Enshrouded",
    sessionName: "My Enshrouded Server",
    ports: { game: 15636, rawSocket: 15637, query: 15637, rcon: 0 },
    maxPlayers: 8,
    adminPassword: "secret",
    serverPassword: "hunter2",
    modIds: [],
    cluster: null,
    config,
    catalog: ENSHROUDED_CATALOG,
  });
}

describe("buildContainerSpec (Enshrouded / mornedhels)", () => {
  it("maps to the mornedhels env contract (2 UDP ports, no RCON, PUID)", async () => {
    const spec = await buildEnshrouded({ values: {} });
    expect(spec.Image).toBe("mornedhels/enshrouded-server:latest");
    const env = envOf(spec);
    expect(env).toContain("SERVER_NAME=My Enshrouded Server");
    expect(env).toContain("SERVER_SLOT_COUNT=8");
    expect(env).toContain("SERVER_QUERYPORT=15637");
    expect(env).toContain("GAME_BRANCH=public");
    // game + query are UDP; no RCON/TCP
    expect(spec.HostConfig?.PortBindings?.["15636/udp"]).toEqual([{ HostPort: "15636" }]);
    expect(spec.HostConfig?.PortBindings?.["15637/udp"]).toEqual([{ HostPort: "15637" }]);
    expect(Object.keys(spec.HostConfig?.PortBindings ?? {}).some((k) => k.endsWith("/tcp"))).toBe(false);
    // the game install + savegame bound at /opt/enshrouded
    const binds = spec.HostConfig?.Binds ?? [];
    expect(binds.some((b) => b.endsWith(":/opt/enshrouded"))).toBe(true);
  });

  it("derives three role passwords from the join password (unique, suffixed)", async () => {
    const env = envOf(await buildEnshrouded({ values: {} }));
    // Guest = plain join password; Admin/Friend suffixed so all three are unique.
    expect(env).toContain("SERVER_ROLE_2_NAME=Guest");
    expect(env).toContain("SERVER_ROLE_2_PASSWORD=hunter2");
    expect(env).toContain("SERVER_ROLE_0_NAME=Admin");
    expect(env).toContain("SERVER_ROLE_0_PASSWORD=hunter2-admin");
    expect(env).toContain("SERVER_ROLE_1_PASSWORD=hunter2-friend");
    expect(env).toContain("SERVER_ROLE_0_CAN_KICK_BAN=true");
    expect(env).toContain("SERVER_ROLE_2_CAN_KICK_BAN=false");
  });

  it("caps SERVER_SLOT_COUNT at Enshrouded's max of 16", async () => {
    const { buildContainerSpec } = await import("./runtime-spec");
    const { ENSHROUDED_CATALOG } = await import("../catalog/enshrouded.catalog");
    const spec = buildContainerSpec({
      serverId: "srv1",
      game: Game.ENSHROUDED,
      map: "Enshrouded",
      sessionName: "Big",
      ports: { game: 15636, rawSocket: 15637, query: 15637, rcon: 0 },
      maxPlayers: 64,
      adminPassword: "secret",
      serverPassword: "hunter2",
      modIds: [],
      cluster: null,
      config: { values: {} },
      catalog: ENSHROUDED_CATALOG,
    });
    expect(envOf(spec)).toContain("SERVER_SLOT_COUNT=16");
  });

  it("passes catalog chat settings through (bools as true/false)", async () => {
    const env = envOf(
      await buildEnshrouded({ values: { SERVER_ENABLE_TEXT_CHAT: true, SERVER_VOICE_CHAT_MODE: "Global" } }),
    );
    expect(env).toContain("SERVER_ENABLE_TEXT_CHAT=true");
    expect(env).toContain("SERVER_VOICE_CHAT_MODE=Global");
  });

  it("converts SERVER_GS duration knobs from minutes to nanoseconds", async () => {
    const env = envOf(
      await buildEnshrouded({
        values: { SERVER_GS_DAY_TIME_DURATION: 30, SERVER_GS_ENEMY_DAMAGE_FACTOR: 1.5 },
      }),
    );
    expect(env).toContain("SERVER_GS_DAY_TIME_DURATION=1800000000000"); // 30 min * 60e9
    expect(env).toContain("SERVER_GS_ENEMY_DAMAGE_FACTOR=1.5"); // factors pass through as-is
  });
});

async function buildZomboid(config: ServerConfigValues, extra: { modIds?: number[]; pzModNames?: string[] } = {}) {
  const { buildContainerSpec } = await import("./runtime-spec");
  const { ZOMBOID_CATALOG } = await import("../catalog/zomboid.catalog");
  return buildContainerSpec({
    serverId: "srv1",
    game: Game.ZOMBOID,
    map: "Muldraugh, KY",
    sessionName: "Knox County",
    ports: { game: 16261, rawSocket: 16262, query: 16261, rcon: 27015 },
    maxPlayers: 16,
    adminPassword: "adminpw",
    serverPassword: "hunter2",
    modIds: extra.modIds ?? [],
    pzModNames: extra.pzModNames,
    cluster: null,
    config,
    catalog: ZOMBOID_CATALOG,
  });
}

describe("buildContainerSpec (Project Zomboid / danixu86)", () => {
  it("maps to the danixu86 env contract (game/direct/steam UDP + RCON tcp)", async () => {
    const spec = await buildZomboid({ values: {} });
    expect(spec.Image).toBe("danixu86/project-zomboid-dedicated-server:latest");
    const env = envOf(spec);
    expect(env).toContain("ADMINUSERNAME=admin");
    expect(env).toContain("ADMINPASSWORD=adminpw");
    expect(env).toContain("RCONPASSWORD=adminpw");
    expect(env).toContain("PASSWORD=hunter2");
    expect(env).toContain("DISPLAYNAME=Knox County");
    expect(env).toContain("SERVERNAME=servertest"); // fixed — no spaces allowed
    expect(env).toContain("PORT=16261");
    expect(env).toContain("UDPPORT=16262");
    expect(env).toContain("STEAMPORT1=8766");
    expect(env).toContain("STEAMPORT2=8767");
    for (const p of ["16261/udp", "16262/udp", "8766/udp", "8767/udp"]) {
      expect(spec.HostConfig?.PortBindings?.[p]).toEqual([{ HostPort: p.split("/")[0] }]);
    }
    expect(spec.HostConfig?.PortBindings?.["27015/tcp"]).toEqual([{ HostPort: "27015" }]);
    const binds = spec.HostConfig?.Binds ?? [];
    expect(binds.some((b) => b.endsWith(":/home/steam/Zomboid"))).toBe(true);
  });

  it("emits WORKSHOP_IDS + MOD_IDS semicolon-separated (empty clears)", async () => {
    const env = envOf(
      await buildZomboid({ values: {} }, { modIds: [111, 222], pzModNames: ["ModA", "ModB"] }),
    );
    expect(env).toContain("WORKSHOP_IDS=111;222");
    expect(env).toContain("MOD_IDS=ModA;ModB");
    const empty = envOf(await buildZomboid({ values: {} }));
    expect(empty).toContain("WORKSHOP_IDS=");
    expect(empty).toContain("MOD_IDS=");
  });

  it("passes catalog settings through (bools as true/false)", async () => {
    const env = envOf(
      await buildZomboid({ values: { PUBLIC: true, SERVERPRESET: "Builder", MEMORY: "6g" } }),
    );
    expect(env).toContain("PUBLIC=true");
    expect(env).toContain("SERVERPRESET=Builder");
    expect(env).toContain("MEMORY=6g");
    expect(env).toContain("STEAMVAC=true"); // catalog default
  });
});

describe("parsePzModIds", () => {
  it("parses 'Mod ID:' lines from a Workshop description (deduped, in order)", async () => {
    const { parsePzModIds } = await import("../mods/mods.service");
    const desc = "Great mod.\nWorkshop ID: 2392709985\nMod ID: BetterSorting\nMod ID: BetterSorting\nmod id: SecondModule\n";
    expect(parsePzModIds(desc)).toEqual(["BetterSorting", "SecondModule"]);
  });
  it("returns empty when the description has no Mod ID line", async () => {
    const { parsePzModIds } = await import("../mods/mods.service");
    expect(parsePzModIds("just a description")).toEqual([]);
  });
});

describe("renderSdtdServerXml", () => {
  it("renders first-class fields + telnet + catalog props, escaping values", async () => {
    const { renderSdtdServerXml } = await import("./runtime-spec");
    const { SEVEN_DAYS_CATALOG } = await import("../catalog/seven-days.catalog");
    const xml = renderSdtdServerXml({
      sessionName: 'Bob & "Friends"',
      serverPassword: "joinpw",
      adminPassword: "telnetpw",
      maxPlayers: 8,
      map: "Navezgane",
      gamePort: 26900,
      telnetPort: 8081,
      catalog: SEVEN_DAYS_CATALOG,
      config: { values: { GameDifficulty: 4 } },
    });
    expect(xml).toContain('<property name="ServerName" value="Bob &amp; &quot;Friends&quot;"/>');
    expect(xml).toContain('<property name="ServerPassword" value="joinpw"/>');
    expect(xml).toContain('<property name="ServerPort" value="26900"/>');
    expect(xml).toContain('<property name="GameWorld" value="Navezgane"/>');
    expect(xml).toContain('<property name="TelnetEnabled" value="true"/>');
    expect(xml).toContain('<property name="TelnetPort" value="8081"/>');
    expect(xml).toContain('<property name="TelnetPassword" value="telnetpw"/>');
    expect(xml).toContain('<property name="GameDifficulty" value="4"/>'); // catalog override
    expect(xml).toContain('<property name="XPMultiplier" value="100"/>'); // catalog default
  });
});
