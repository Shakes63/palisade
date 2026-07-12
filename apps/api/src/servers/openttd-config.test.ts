import { describe, it, expect, beforeAll } from "vitest";
import { Game } from "@ark/shared";
import { OPENTTD_CATALOG } from "../catalog/openttd.catalog";

beforeAll(() => {
  process.env.SECRETS_KEY = "a".repeat(64);
  process.env.JWT_SECRET = "test-jwt-secret-1234";
  process.env.DATA_DIR = "/data";
});

async function render(over: Record<string, unknown> = {}) {
  const { renderOpenttdConfig } = await import("./runtime-spec");
  return renderOpenttdConfig({
    sessionName: "My TTD",
    serverPassword: "joinpw",
    adminPassword: "adminpw",
    maxPlayers: 12,
    map: "arctic",
    gamePort: 3979,
    adminPort: 3977,
    catalog: OPENTTD_CATALOG,
    config: { values: over },
  });
}

describe("renderOpenttdConfig (three-file split)", () => {
  it("puts network + catalog settings in openttd.cfg, routed to the right sections", async () => {
    const f = await render({ max_no_competitors: 4, starting_year: 1980, server_game_type: "public" });
    const cfg = f["openttd.cfg"];
    expect(cfg).toMatch(/\[network\]/);
    expect(cfg).toMatch(/server_port = 3979/);
    expect(cfg).toMatch(/server_admin_port = 3977/);
    expect(cfg).toMatch(/max_clients = 12/);
    expect(cfg).toMatch(/server_game_type = public/);
    // game_creation section: landscape (map) + starting_year
    expect(cfg).toMatch(/\[game_creation\]/);
    expect(cfg).toMatch(/landscape = arctic/);
    expect(cfg).toMatch(/starting_year = 1980/);
    // difficulty section: AI competitors
    expect(cfg).toMatch(/\[difficulty\]/);
    expect(cfg).toMatch(/max_no_competitors = 4/);
  });

  it("keeps the server name in private.cfg and passwords in secrets.cfg", async () => {
    const f = await render();
    expect(f["private.cfg"]).toMatch(/\[network\]\nserver_name = My TTD/);
    expect(f["secrets.cfg"]).toContain("server_password = joinpw");
    expect(f["secrets.cfg"]).toContain("rcon_password = adminpw");
    expect(f["secrets.cfg"]).toContain("admin_password = adminpw");
    // secrets never leak into the public config
    expect(f["openttd.cfg"]).not.toContain("adminpw");
    expect(f["openttd.cfg"]).not.toContain("joinpw");
  });

  it("emits catalog defaults when no overrides are given", async () => {
    const f = await render();
    expect(f["openttd.cfg"]).toMatch(/max_companies = 15/); // catalog default
    expect(f["openttd.cfg"]).toMatch(/map_x = 8/);
    expect(f["openttd.cfg"]).toMatch(/max_no_competitors = 0/);
  });

  it("strips newlines from free-text values (config-corruption guard)", async () => {
    const { renderOpenttdConfig } = await import("./runtime-spec");
    const f = renderOpenttdConfig({
      sessionName: "Evil\nserver_admin_password = pwned",
      serverPassword: "",
      adminPassword: "",
      maxPlayers: 8,
      map: "temperate",
      gamePort: 3979,
      adminPort: 3977,
      catalog: OPENTTD_CATALOG,
      config: { values: {} },
    });
    // The injected "server_admin_password = pwned" must NOT become its own config line —
    // it stays space-joined onto the server_name value, so it's just part of the name.
    const lines = f["private.cfg"].split("\n");
    expect(lines.some((l) => l.trim().startsWith("server_admin_password"))).toBe(false);
    expect(lines.filter((l) => l.startsWith("server_name")).length).toBe(1);
  });
});

describe("OPENTTD_CATALOG", () => {
  it("every setting routes into a known openttd.cfg section via emitAs", async () => {
    const sections = new Set(["network", "game_creation", "difficulty"]);
    for (const def of OPENTTD_CATALOG.settings) {
      if (def.noEmit) continue; // e.g. GAME_VERSION rides the env, not openttd.cfg
      const section = (def.emitAs ?? "").split(".")[0] ?? "";
      expect(sections.has(section), `${def.key} → ${def.emitAs}`).toBe(true);
    }
    expect(OPENTTD_CATALOG.game).toBe(Game.OPENTTD);
  });
});
