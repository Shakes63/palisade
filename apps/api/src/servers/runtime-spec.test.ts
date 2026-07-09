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

async function buildVRising(config: ServerConfigValues) {
  const { buildContainerSpec } = await import("./runtime-spec");
  const { VRISING_CATALOG } = await import("../catalog/vrising.catalog");
  return buildContainerSpec({
    serverId: "srv1",
    game: Game.VRISING,
    map: "Vardoran",
    sessionName: "Castle Night",
    ports: { game: 9876, rawSocket: 9878, query: 9877, rcon: 25575 },
    maxPlayers: 10,
    adminPassword: "rconpw",
    serverPassword: "hunter2",
    modIds: [],
    cluster: null,
    config,
    catalog: VRISING_CATALOG,
  });
}

describe("buildContainerSpec (V Rising / trueosiris)", () => {
  it("maps to the trueosiris env contract (2 UDP ports + RCON tcp, CRLF entrypoint fix)", async () => {
    const spec = await buildVRising({ values: {} });
    expect(spec.Image).toBe("trueosiris/vrising:latest");
    const env = envOf(spec);
    expect(env).toContain("SERVERNAME=Castle Night");
    expect(env).toContain("GAMEPORT=9876");
    expect(env).toContain("QUERYPORT=9877");
    expect(env).toContain("HOST_SETTINGS_Password=hunter2");
    expect(env).toContain("HOST_SETTINGS_MaxConnectedUsers=10");
    expect(env).toContain("HOST_SETTINGS_Rcon__Enabled=true");
    expect(env).toContain("HOST_SETTINGS_Rcon__Password=rconpw");
    expect(env).toContain("HOST_SETTINGS_Rcon__Port=25575");
    // The image's start.sh ships with CRLF endings — the entrypoint strips them.
    expect(spec.Entrypoint?.[2]).toContain("sed -i 's/\\r//g' /start.sh");
    expect(spec.HostConfig?.PortBindings?.["9876/udp"]).toEqual([{ HostPort: "9876" }]);
    expect(spec.HostConfig?.PortBindings?.["9877/udp"]).toEqual([{ HostPort: "9877" }]);
    expect(spec.HostConfig?.PortBindings?.["25575/tcp"]).toEqual([{ HostPort: "25575" }]);
    const binds = spec.HostConfig?.Binds ?? [];
    expect(binds.some((b) => b.endsWith(":/mnt/vrising/server"))).toBe(true);
    expect(binds.some((b) => b.endsWith(":/mnt/vrising/persistentdata"))).toBe(true);
  });

  it("passes catalog settings through (bools as true/false, nested __ keys intact)", async () => {
    const env = envOf(
      await buildVRising({
        values: {
          GAME_SETTINGS_GameModeType: "PvE",
          HOST_SETTINGS_ListOnSteam: true,
          GAME_SETTINGS_UnitStatModifiers_Global__PowerModifier: 1.5,
        },
      }),
    );
    expect(env).toContain("GAME_SETTINGS_GameModeType=PvE");
    expect(env).toContain("HOST_SETTINGS_ListOnSteam=true");
    expect(env).toContain("GAME_SETTINGS_UnitStatModifiers_Global__PowerModifier=1.5");
  });

  it("caps MaxConnectedUsers at V Rising's 40", async () => {
    const { buildContainerSpec } = await import("./runtime-spec");
    const { VRISING_CATALOG } = await import("../catalog/vrising.catalog");
    const spec = buildContainerSpec({
      serverId: "srv1",
      game: Game.VRISING,
      map: "Vardoran",
      sessionName: "Big",
      ports: { game: 9876, rawSocket: 9878, query: 9877, rcon: 25575 },
      maxPlayers: 100,
      adminPassword: "rconpw",
      serverPassword: null,
      modIds: [],
      cluster: null,
      config: { values: {} },
      catalog: VRISING_CATALOG,
    });
    expect(envOf(spec)).toContain("HOST_SETTINGS_MaxConnectedUsers=40");
  });
});

describe("buildContainerSpec + renderSotfConfig (Sons of the Forest / jammsen)", () => {
  const input = {
    serverId: "srv1",
    game: Game.SOTF,
    map: "Hard",
    sessionName: "Forest Camp",
    ports: { game: 8766, rawSocket: 9700, query: 27016, rcon: 0 },
    maxPlayers: 8,
    adminPassword: "",
    serverPassword: "hunter2",
    modIds: [],
    cluster: null,
    config: { values: {} } as ServerConfigValues,
  };

  it("publishes the 3 UDP ports, no RCON, single game bind, PUID env", async () => {
    const { buildContainerSpec } = await import("./runtime-spec");
    const { SOTF_CATALOG } = await import("../catalog/sotf.catalog");
    const spec = buildContainerSpec({ ...input, catalog: SOTF_CATALOG });
    expect(spec.Image).toBe("jammsen/sons-of-the-forest-dedicated-server:latest");
    const env = envOf(spec);
    expect(env).toContain("ALWAYS_UPDATE_ON_START=true");
    expect(env).toContain("SKIP_NETWORK_ACCESSIBILITY_TEST=true");
    for (const p of ["8766/udp", "27016/udp", "9700/udp"]) {
      expect(spec.HostConfig?.PortBindings?.[p]).toEqual([{ HostPort: p.split("/")[0] }]);
    }
    expect(Object.keys(spec.HostConfig?.PortBindings ?? {}).some((k) => k.endsWith("/tcp"))).toBe(false);
    expect((spec.HostConfig?.Binds ?? []).some((b) => b.endsWith(":/sonsoftheforest"))).toBe(true);
  });

  it("renders dedicatedserver.cfg with first-class fields + nested GameSettings", async () => {
    const { renderSotfConfig } = await import("./runtime-spec");
    const { SOTF_CATALOG } = await import("../catalog/sotf.catalog");
    const cfg = JSON.parse(
      renderSotfConfig({
        sessionName: "Forest Camp",
        serverPassword: "hunter2",
        maxPlayers: 8,
        map: "Hard",
        ports: input.ports,
        catalog: SOTF_CATALOG,
        config: { values: { GS_TreeRegrowth: false, SaveInterval: 300 } },
      }),
    ) as Record<string, unknown>;
    expect(cfg.ServerName).toBe("Forest Camp");
    expect(cfg.Password).toBe("hunter2");
    expect(cfg.GameMode).toBe("Hard"); // repurposed map field
    expect(cfg.GamePort).toBe(8766);
    expect(cfg.QueryPort).toBe(27016);
    expect(cfg.BlobSyncPort).toBe(9700);
    expect(cfg.SaveMode).toBe("Continue");
    expect(cfg.SaveInterval).toBe(300);
    expect(cfg.SkipNetworkAccessibilityTest).toBe(true); // catalog default
    // GS_ keys land inside GameSettings under the game's dotted names, not top-level.
    expect((cfg.GameSettings as Record<string, unknown>)["Gameplay.TreeRegrowth"]).toBe(false);
    expect((cfg.GameSettings as Record<string, unknown>)["Structure.Damage"]).toBe(true);
    expect(cfg.GS_TreeRegrowth).toBeUndefined();
  });

  it("caps MaxPlayers at SotF's 8", async () => {
    const { renderSotfConfig } = await import("./runtime-spec");
    const { SOTF_CATALOG } = await import("../catalog/sotf.catalog");
    const cfg = JSON.parse(
      renderSotfConfig({
        sessionName: "Big",
        serverPassword: "",
        maxPlayers: 20,
        map: "Normal",
        ports: input.ports,
        catalog: SOTF_CATALOG,
        config: { values: {} },
      }),
    ) as Record<string, unknown>;
    expect(cfg.MaxPlayers).toBe(8);
  });
});

describe("buildContainerSpec (Satisfactory / wolveix)", () => {
  async function buildSatisfactory(config: ServerConfigValues) {
    const { buildContainerSpec } = await import("./runtime-spec");
    const { SATISFACTORY_CATALOG } = await import("../catalog/satisfactory.catalog");
    return buildContainerSpec({
      serverId: "srv1",
      game: Game.SATISFACTORY,
      map: "Satisfactory",
      sessionName: "Ficsit Inc",
      ports: { game: 7777, rawSocket: 8888, query: 7777, rcon: 0 },
      maxPlayers: 4,
      adminPassword: "adminpw",
      serverPassword: null,
      modIds: [],
      cluster: null,
      config,
      catalog: SATISFACTORY_CATALOG,
    });
  }

  it("maps to the wolveix env contract (7777 udp+tcp, 8888 tcp, /config bind)", async () => {
    const spec = await buildSatisfactory({ values: {} });
    expect(spec.Image).toBe("wolveix/satisfactory-server:latest");
    const env = envOf(spec);
    expect(env).toContain("MAXPLAYERS=4");
    expect(env).toContain("SERVERGAMEPORT=7777");
    expect(env).toContain("SERVERMESSAGINGPORT=8888");
    expect(spec.HostConfig?.PortBindings?.["7777/udp"]).toEqual([{ HostPort: "7777" }]);
    expect(spec.HostConfig?.PortBindings?.["7777/tcp"]).toEqual([{ HostPort: "7777" }]);
    expect(spec.HostConfig?.PortBindings?.["8888/tcp"]).toEqual([{ HostPort: "8888" }]);
    expect((spec.HostConfig?.Binds ?? []).some((b) => b.endsWith(":/config"))).toBe(true);
  });

  it("passes catalog settings through (bools as true/false)", async () => {
    const env = envOf(await buildSatisfactory({ values: { STEAMBETA: true, MAXTICKRATE: 60 } }));
    expect(env).toContain("STEAMBETA=true");
    expect(env).toContain("MAXTICKRATE=60");
    expect(env).toContain("AUTOSAVENUM=5"); // catalog default
  });
});

describe("buildContainerSpec + patchLifWorldXml (LiF:YO / ich777)", () => {
  it("drives the ich777 wrapper (app id + world 1, PUID, both binds, tcp+udp block)", async () => {
    const { buildContainerSpec } = await import("./runtime-spec");
    const { LIF_CATALOG } = await import("../catalog/lif.catalog");
    const spec = buildContainerSpec({
      serverId: "srv1",
      game: Game.LIF,
      map: "Abella",
      sessionName: "Feudal Test",
      ports: { game: 28000, rawSocket: 28001, query: 28002, rcon: 0 },
      maxPlayers: 16,
      adminPassword: "gmpw",
      serverPassword: "hunter2",
      modIds: [],
      cluster: null,
      config: { values: {} },
      catalog: LIF_CATALOG,
    });
    expect(spec.Image).toBe("ghcr.io/ich777/steamcmd:lifyo");
    const env = envOf(spec);
    expect(env).toContain("GAME_ID=320850");
    expect(env).toContain("GAME_PARAMS=-world 1");
    for (const p of [28000, 28001, 28002, 28003]) {
      expect(spec.HostConfig?.PortBindings?.[`${p}/tcp`]).toEqual([{ HostPort: String(p) }]);
      expect(spec.HostConfig?.PortBindings?.[`${p}/udp`]).toEqual([{ HostPort: String(p) }]);
    }
    const binds = spec.HostConfig?.Binds ?? [];
    expect(binds.some((b) => b.endsWith(":/serverdata/steamcmd"))).toBe(true);
    expect(binds.some((b) => b.endsWith(":/serverdata/serverfiles"))).toBe(true);
  });

  const SAMPLE = `<?xml version="1.0"?>
<config>
\t<ID>1</ID>
\t<name>My own LiF server</name> <!-- No more than 63 symbols! -->
\t<password></password>
\t<adminPassword></adminPassword>
\t<skillsStatsMult>100</skillsStatsMult>
\t<skillcap>
\t\t<group id="1" value="3000" />
\t\t<group id="2" value="400" />
\t\t<group id="3" value="800" />
\t</skillcap>
\t<dayCycle>4</dayCycle>
\t<maxPlayers>64</maxPlayers>
\t<port>28000</port>
\t<isPrivate>0</isPrivate>
</config>`;

  it("patches first-class fields + catalog tags + skillcap groups, preserving the rest", async () => {
    const { patchLifWorldXml } = await import("./runtime-spec");
    const { LIF_CATALOG } = await import("../catalog/lif.catalog");
    const out = patchLifWorldXml(SAMPLE, {
      sessionName: "Feudal & Friends",
      serverPassword: "hunter2",
      adminPassword: "gmpw",
      maxPlayers: 16,
      gamePort: 28000,
      catalog: LIF_CATALOG,
      config: { values: { LIF_SKILLCAP_COMBAT: 900, dayCycle: 8, isPrivate: true } },
    });
    expect(out).toContain("<name>Feudal &amp; Friends</name>"); // XML-escaped
    expect(out).toContain("<password>hunter2</password>");
    expect(out).toContain("<adminPassword>gmpw</adminPassword>");
    expect(out).toContain("<maxPlayers>16</maxPlayers>");
    expect(out).toContain('<group id="2" value="900" />');
    expect(out).toContain('<group id="1" value="600" />'); // catalog default applied
    expect(out).toContain("<dayCycle>8</dayCycle>");
    expect(out).toContain("<isPrivate>1</isPrivate>"); // bool -> 1/0
    expect(out).toContain("<ID>1</ID>"); // untouched
    expect(out).toContain("<!-- No more than 63 symbols! -->"); // comments preserved
  });
});

describe("buildContainerSpec + patchAtsServerConfig (ATS / ich777)", () => {
  it("drives the ich777 wrapper (app id, PUID, both binds, 2 UDP ports, no RCON)", async () => {
    const { buildContainerSpec } = await import("./runtime-spec");
    const { ATS_CATALOG } = await import("../catalog/ats.catalog");
    const spec = buildContainerSpec({
      serverId: "srv1",
      game: Game.ATS,
      map: "ATSWorld",
      sessionName: "Truck Stop",
      ports: { game: 27015, rawSocket: 27017, query: 27016, rcon: 0 },
      maxPlayers: 8,
      adminPassword: "",
      serverPassword: "hunter2",
      modIds: [],
      cluster: null,
      config: { values: {} },
      catalog: ATS_CATALOG,
    });
    expect(spec.Image).toBe("ghcr.io/ich777/steamcmd:ats");
    const env = envOf(spec);
    expect(env).toContain("GAME_ID=2239530");
    expect(spec.HostConfig?.PortBindings?.["27015/udp"]).toEqual([{ HostPort: "27015" }]);
    expect(spec.HostConfig?.PortBindings?.["27016/udp"]).toEqual([{ HostPort: "27016" }]);
    expect(Object.keys(spec.HostConfig?.PortBindings ?? {}).some((k) => k.endsWith("/tcp"))).toBe(false);
    const binds = spec.HostConfig?.Binds ?? [];
    expect(binds.some((b) => b.endsWith(":/serverdata/steamcmd"))).toBe(true);
    expect(binds.some((b) => b.endsWith(":/serverdata/serverfiles"))).toBe(true);
  });

  it("ETS2 rides the same builder with its own image/app id/port block", async () => {
    const { buildContainerSpec } = await import("./runtime-spec");
    const { ETS2_CATALOG } = await import("../catalog/ats.catalog");
    const spec = buildContainerSpec({
      serverId: "srv1",
      game: Game.ETS2,
      map: "ETS2World",
      sessionName: "Euro Convoy",
      ports: { game: 27018, rawSocket: 27020, query: 27019, rcon: 0 },
      maxPlayers: 8,
      adminPassword: "",
      serverPassword: null,
      modIds: [],
      cluster: null,
      config: { values: {} },
      catalog: ETS2_CATALOG,
    });
    expect(spec.Image).toBe("ghcr.io/ich777/steamcmd:ets2");
    expect(envOf(spec)).toContain("GAME_ID=1948160");
    expect(spec.HostConfig?.PortBindings?.["27018/udp"]).toEqual([{ HostPort: "27018" }]);
    expect(spec.HostConfig?.PortBindings?.["27019/udp"]).toEqual([{ HostPort: "27019" }]);
  });

  const SAMPLE = `SiiNunit
{
server_config : _nameless.1ad.e2c8.f150 {
 lobby_name: "Docker Server"
 description: ""
 welcome_message: ""
 password: "Docker"
 max_players: 8
 max_vehicles_total: 100
 max_ai_vehicles_player: 50
 connection_virtual_port: 100
 query_virtual_port: 101
 connection_dedicated_port: 27015
 query_dedicated_port: 27016
 server_logon_token: ""
 player_damage: true
 traffic: true
 friends_only: false
 show_server: true
 moderator_list: 0
}
}`;

  it("patches first-class fields + catalog keys, preserving the unit header + unknown keys", async () => {
    const { patchAtsServerConfig } = await import("./runtime-spec");
    const { ATS_CATALOG } = await import("../catalog/ats.catalog");
    const out = patchAtsServerConfig(SAMPLE, {
      sessionName: 'Truck "Stop"',
      serverPassword: "hunter2",
      maxPlayers: 20, // capped to 8
      gamePort: 27015,
      queryPort: 27016,
      catalog: ATS_CATALOG,
      config: { values: { player_damage: false, max_vehicles_total: 200, welcome_message: "howdy" } },
    });
    expect(out).toContain(' lobby_name: "Truck \\"Stop\\""'); // quotes escaped
    expect(out).toContain(' password: "hunter2"');
    expect(out).toContain(" max_players: 8");
    expect(out).toContain(" player_damage: false");
    expect(out).toContain(" max_vehicles_total: 200");
    expect(out).toContain(' welcome_message: "howdy"');
    expect(out).toContain(" traffic: true"); // catalog default applied
    expect(out).toContain("server_config : _nameless.1ad.e2c8.f150 {"); // unit header untouched
    expect(out).toContain(" moderator_list: 0"); // unknown key preserved
    expect(out).toContain(" connection_virtual_port: 100"); // virtual ports untouched
  });
});

describe("buildContainerSpec (Core Keeper / escaping)", () => {
  async function buildCk(config: ServerConfigValues, map = "CKNormal") {
    const { buildContainerSpec } = await import("./runtime-spec");
    const { CORE_KEEPER_CATALOG } = await import("../catalog/core-keeper.catalog");
    return buildContainerSpec({
      serverId: "srv1",
      game: Game.CORE_KEEPER,
      map,
      sessionName: "Cavern Crew",
      ports: { game: 0, rawSocket: 0, query: 0, rcon: 0 },
      maxPlayers: 8,
      adminPassword: "",
      serverPassword: null,
      modIds: [],
      cluster: null,
      config,
      catalog: CORE_KEEPER_CATALOG,
    });
  }

  it("relay mode: env-driven with NO published ports, world mode from the map field", async () => {
    const spec = await buildCk({ values: {} }, "CKHard");
    expect(spec.Image).toBe("escaping/core-keeper-dedicated:latest");
    const env = envOf(spec);
    expect(env).toContain("WORLD_NAME=Cavern Crew");
    expect(env).toContain("MAX_PLAYERS=8");
    expect(env).toContain("WORLD_MODE=1"); // CKHard
    // Relay mode — nothing bound, nothing published.
    expect(spec.HostConfig?.PortBindings).toBeUndefined();
    expect(spec.ExposedPorts).toBeUndefined();
    const binds = spec.HostConfig?.Binds ?? [];
    expect(binds.some((b) => b.endsWith(":/home/steam/core-keeper-dedicated"))).toBe(true);
    expect(binds.some((b) => b.endsWith(":/home/steam/core-keeper-data"))).toBe(true);
  });

  it("drops empty catalog values (SEASON unset = real-date seasons)", async () => {
    const env = envOf(await buildCk({ values: { SEASON: "", WORLD_SEED: "12345" } }));
    expect(env.some((e) => e.startsWith("SEASON="))).toBe(false);
    expect(env).toContain("WORLD_SEED=12345");
    const withSeason = envOf(await buildCk({ values: { SEASON: "2" } }));
    expect(withSeason).toContain("SEASON=2");
  });
});

describe("buildContainerSpec + patchTShockConfig (Terraria / ryshe)", () => {
  it("passes world-creation args through Cmd and publishes game + REST ports", async () => {
    const { buildContainerSpec } = await import("./runtime-spec");
    const { TERRARIA_CATALOG } = await import("../catalog/terraria.catalog");
    const spec = buildContainerSpec({
      serverId: "srv1",
      game: Game.TERRARIA,
      map: "TerrariaLarge",
      sessionName: "Corruption Co",
      ports: { game: 7777, rawSocket: 7779, query: 7777, rcon: 7979 },
      maxPlayers: 8,
      adminPassword: "resttoken",
      serverPassword: "hunter2",
      modIds: [],
      cluster: null,
      config: { values: { TERRARIA_DIFFICULTY: "2", TERRARIA_SEED: "worthy" } },
      catalog: TERRARIA_CATALOG,
    });
    expect(spec.Image).toBe("ryshe/terraria:latest");
    expect(envOf(spec)).toContain("WORLD_FILENAME=world.wld");
    expect(spec.Cmd).toEqual([
      "-autocreate", "3", "-worldname", "Corruption Co", "-difficulty", "2", "-seed", "worthy",
    ]);
    expect(spec.HostConfig?.PortBindings?.["7777/tcp"]).toEqual([{ HostPort: "7777" }]);
    expect(spec.HostConfig?.PortBindings?.["7979/tcp"]).toEqual([{ HostPort: "7979" }]);
    const binds = spec.HostConfig?.Binds ?? [];
    expect(binds.some((b) => b.endsWith(":/root/.local/share/Terraria/Worlds"))).toBe(true);
    expect(binds.some((b) => b.endsWith(":/tshock/ServerPlugins"))).toBe(true);
  });

  it("patchTShockConfig merges into Settings, preserving TShock's other keys", async () => {
    const { patchTShockConfig } = await import("./runtime-spec");
    const { TERRARIA_CATALOG } = await import("../catalog/terraria.catalog");
    const existing = JSON.stringify({
      Settings: { ServerName: "old", KickOnMediumcoreDeath: false, CommandSpecifier: "/" },
    });
    const out = JSON.parse(
      patchTShockConfig(existing, {
        sessionName: "Corruption Co",
        serverPassword: "hunter2",
        adminPassword: "resttoken",
        maxPlayers: 8,
        gamePort: 7777,
        restPort: 7979,
        catalog: TERRARIA_CATALOG,
        config: { values: { PvPMode: "disabled" } },
      }),
    ) as { Settings: Record<string, unknown> };
    expect(out.Settings.ServerName).toBe("Corruption Co");
    expect(out.Settings.ServerPassword).toBe("hunter2");
    expect(out.Settings.MaxSlots).toBe(8);
    expect(out.Settings.RestApiEnabled).toBe(true);
    expect(out.Settings.ApplicationRestTokens).toEqual({
      resttoken: { Username: "palisade", UserGroupName: "superadmin" },
    });
    expect(out.Settings.PvPMode).toBe("disabled");
    expect(out.Settings.SpawnProtection).toBe(true); // catalog default applied
    expect(out.Settings.KickOnMediumcoreDeath).toBe(false); // TShock's own key preserved
    expect(out.Settings.TERRARIA_DIFFICULTY).toBeUndefined(); // CLI keys stay out of the config
  });

  it("disables the REST API when no admin token is set", async () => {
    const { patchTShockConfig } = await import("./runtime-spec");
    const { TERRARIA_CATALOG } = await import("../catalog/terraria.catalog");
    const out = JSON.parse(
      patchTShockConfig(null, {
        sessionName: "NoRest",
        serverPassword: "",
        adminPassword: "",
        maxPlayers: 8,
        gamePort: 7777,
        restPort: 7979,
        catalog: TERRARIA_CATALOG,
        config: { values: {} },
      }),
    ) as { Settings: Record<string, unknown> };
    expect(out.Settings.RestApiEnabled).toBe(false);
    expect(out.Settings.ApplicationRestTokens).toEqual({});
  });
});

describe("buildContainerSpec + patchFactorioSettings (Factorio / factoriotools)", () => {
  it("maps preset/save envs, PUID, and publishes game udp + rcon tcp", async () => {
    const { buildContainerSpec } = await import("./runtime-spec");
    const { FACTORIO_CATALOG } = await import("../catalog/factorio.catalog");
    const spec = buildContainerSpec({
      serverId: "srv1",
      game: Game.FACTORIO,
      map: "rail-world",
      sessionName: "The Factory",
      ports: { game: 34197, rawSocket: 34198, query: 34197, rcon: 27015 },
      maxPlayers: 10,
      adminPassword: "rconpw",
      serverPassword: "hunter2",
      modIds: [],
      cluster: null,
      config: { values: { UPDATE_MODS_ON_START: true } },
      catalog: FACTORIO_CATALOG,
    });
    expect(spec.Image).toBe("factoriotools/factorio:stable");
    const env = envOf(spec);
    expect(env).toContain("SAVE_NAME=world");
    expect(env).toContain("GENERATE_NEW_SAVE=true");
    expect(env).toContain("PRESET=rail-world");
    expect(env).toContain("UPDATE_MODS_ON_START=true"); // env-key catalog setting
    expect(env.some((e) => e.startsWith("visibility"))).toBe(false); // JSON keys stay out of env
    expect(spec.HostConfig?.PortBindings?.["34197/udp"]).toEqual([{ HostPort: "34197" }]);
    expect(spec.HostConfig?.PortBindings?.["27015/tcp"]).toEqual([{ HostPort: "27015" }]);
    expect((spec.HostConfig?.Binds ?? []).some((b) => b.endsWith(":/factorio"))).toBe(true);
  });

  it("omits PRESET for the default map", async () => {
    const { buildContainerSpec } = await import("./runtime-spec");
    const { FACTORIO_CATALOG } = await import("../catalog/factorio.catalog");
    const spec = buildContainerSpec({
      serverId: "srv1",
      game: Game.FACTORIO,
      map: "FactorioDefault",
      sessionName: "Plain",
      ports: { game: 34197, rawSocket: 34198, query: 34197, rcon: 27015 },
      maxPlayers: 10,
      adminPassword: "",
      serverPassword: null,
      modIds: [],
      cluster: null,
      config: { values: {} },
      catalog: FACTORIO_CATALOG,
    });
    expect(envOf(spec).some((e) => e.startsWith("PRESET="))).toBe(false);
  });

  it("patchFactorioSettings merges + nests dotted visibility keys, preserving others", async () => {
    const { patchFactorioSettings } = await import("./runtime-spec");
    const { FACTORIO_CATALOG } = await import("../catalog/factorio.catalog");
    const existing = JSON.stringify({
      name: "old",
      max_upload_in_kilobytes_per_second: 0,
      visibility: { public: true, lan: false },
    });
    const out = JSON.parse(
      patchFactorioSettings(existing, {
        sessionName: "The Factory",
        serverPassword: "hunter2",
        maxPlayers: 10,
        catalog: FACTORIO_CATALOG,
        config: { values: { "visibility.public": false, autosave_interval: 5 } },
      }),
    ) as Record<string, unknown>;
    expect(out.name).toBe("The Factory");
    expect(out.game_password).toBe("hunter2");
    expect(out.max_players).toBe(10);
    expect(out.visibility).toEqual({ public: false, lan: true }); // dotted keys nested
    expect(out.autosave_interval).toBe(5);
    expect(out.max_upload_in_kilobytes_per_second).toBe(0); // untouched key preserved
    expect(out.UPDATE_MODS_ON_START).toBeUndefined(); // env keys stay out of the JSON
  });
});

describe("buildContainerSpec (Rust / didstopia)", () => {
  async function buildRust(config: ServerConfigValues, map = "RustSmall") {
    const { buildContainerSpec } = await import("./runtime-spec");
    const { RUST_CATALOG } = await import("../catalog/rust.catalog");
    return buildContainerSpec({
      serverId: "srv1",
      game: Game.RUST,
      map,
      sessionName: "Rust Bucket",
      ports: { game: 28015, rawSocket: 28082, query: 28016, rcon: 28016 },
      maxPlayers: 50,
      adminPassword: "rconpw",
      serverPassword: null,
      modIds: [],
      cluster: null,
      config,
      catalog: RUST_CATALOG,
    });
  }

  it("maps the env contract with legacy RCON + world size from the map field", async () => {
    const spec = await buildRust({ values: { RUST_OXIDE_ENABLED: true } });
    expect(spec.Image).toBe("didstopia/rust-server:latest");
    const env = envOf(spec);
    expect(env).toContain("RUST_SERVER_NAME=Rust Bucket");
    expect(env).toContain("RUST_RCON_WEB=0"); // legacy Source RCON
    expect(env).toContain("RUST_RCON_PASSWORD=rconpw");
    expect(env).toContain("RUST_SERVER_WORLDSIZE=2000"); // RustSmall
    expect(env).toContain("RUST_SERVER_MAXPLAYERS=50");
    expect(env).toContain("RUST_OXIDE_ENABLED=1"); // this image wants 1/0 booleans
    expect(env).toContain("RUST_SERVER_SEED=12345"); // catalog default
    // game + query udp, rcon + Rust+ app tcp; query and rcon share 28016
    expect(spec.HostConfig?.PortBindings?.["28015/udp"]).toEqual([{ HostPort: "28015" }]);
    expect(spec.HostConfig?.PortBindings?.["28016/udp"]).toEqual([{ HostPort: "28016" }]);
    expect(spec.HostConfig?.PortBindings?.["28016/tcp"]).toEqual([{ HostPort: "28016" }]);
    expect(spec.HostConfig?.PortBindings?.["28082/tcp"]).toEqual([{ HostPort: "28082" }]);
    expect((spec.HostConfig?.Binds ?? []).some((b) => b.endsWith(":/steamcmd/rust"))).toBe(true);
  });
});

describe("buildContainerSpec (BeamMP / rouhim)", () => {
  it("maps the env contract: AuthKey from the admin field, level path from the map field", async () => {
    const { buildContainerSpec } = await import("./runtime-spec");
    const { BEAMMP_CATALOG } = await import("../catalog/beammp.catalog");
    const spec = buildContainerSpec({
      serverId: "srv1",
      game: Game.BEAMMP,
      map: "west_coast_usa",
      sessionName: "Crash Club",
      ports: { game: 30814, rawSocket: 30815, query: 30814, rcon: 0 },
      maxPlayers: 10,
      adminPassword: "beammp-authkey-123",
      serverPassword: null,
      modIds: [],
      cluster: null,
      config: { values: { BEAMMP_MAX_CARS: 3, BEAMMP_PRIVATE: true } },
      catalog: BEAMMP_CATALOG,
    });
    expect(spec.Image).toBe("rouhim/beammp-server:latest");
    const env = envOf(spec);
    expect(env).toContain("BEAMMP_NAME=Crash Club");
    expect(env).toContain("BEAMMP_AUTH_KEY=beammp-authkey-123");
    expect(env).toContain("BEAMMP_MAP=/levels/west_coast_usa/info.json");
    expect(env).toContain("BEAMMP_MAX_PLAYERS=10");
    expect(env).toContain("BEAMMP_MAX_CARS=3");
    expect(env).toContain("BEAMMP_PRIVATE=true");
    // one port, both protocols; no rcon
    expect(spec.HostConfig?.PortBindings?.["30814/tcp"]).toEqual([{ HostPort: "30814" }]);
    expect(spec.HostConfig?.PortBindings?.["30814/udp"]).toEqual([{ HostPort: "30814" }]);
    const binds = spec.HostConfig?.Binds ?? [];
    expect(binds.some((b) => b.endsWith(":/beammp/Resources/Client"))).toBe(true);
    expect(binds.some((b) => b.endsWith(":/beammp/Resources/Server"))).toBe(true);
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
