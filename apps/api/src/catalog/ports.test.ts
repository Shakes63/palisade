import { describe, it, expect } from "vitest";
import { Game, portRows, consolePortSpec } from "@ark/shared";
import {
  derivePorts,
  portsFor,
  nextBasePort,
  serverPortSet,
  PORT_POOL_START,
  BLOCK_STRIDE,
  VALHEIM_PORTS,
  BEDROCK_PORTS,
  MINECRAFT_PORTS,
  ZOMBOID_PORTS,
} from "./ports";

describe("ports", () => {
  it("derives a contiguous block from a base", () => {
    expect(derivePorts(7777)).toEqual({ game: 7777, rawSocket: 7778, query: 7779, rcon: 7780 });
  });

  it("starts at the pool start when nothing is allocated", () => {
    expect(nextBasePort([])).toBe(PORT_POOL_START);
  });

  it("advances by the block stride past the highest used base", () => {
    expect(nextBasePort([7777, 7787])).toBe(7787 + BLOCK_STRIDE);
  });
});

describe("serverPortSet (start-time port-conflict guard)", () => {
  it("skips unused rcon slots and adds Valheim's HTTP status port", () => {
    // Valheim: 2456-2458 UDP, rcon=0 (skipped), + 2459 status.
    expect(serverPortSet(Game.VALHEIM, VALHEIM_PORTS)).toEqual(new Set([2456, 2457, 2458, 2459]));
  });

  it("adds Zomboid's Steam comms ports and dedupes its mirrored query column", () => {
    // PZ: game 16261 (query mirrors it), direct 16262, rcon 27015, + steam 8766/8767.
    expect(serverPortSet(Game.ZOMBOID, ZOMBOID_PORTS)).toEqual(
      new Set([16261, 16262, 27015, 8766, 8767]),
    );
  });

  it("dedupes Minecraft's mirrored query column", () => {
    // Java: game 25565 (query mirrors it), raw 25566, rcon 25575.
    expect(serverPortSet(Game.MINECRAFT, MINECRAFT_PORTS)).toEqual(new Set([25565, 25566, 25575]));
  });

  it("two same-block servers clash; disjoint blocks don't", () => {
    const a = serverPortSet(Game.BEDROCK, BEDROCK_PORTS);
    const b = serverPortSet(Game.BEDROCK, BEDROCK_PORTS);
    expect([...a].filter((p) => b.has(p)).length).toBeGreaterThan(0);
    const c = serverPortSet(Game.BEDROCK, { game: 20132, rawSocket: 20133, query: 20132, rcon: 0 });
    expect([...a].filter((p) => c.has(p))).toEqual([]);
  });
});

describe("portRows (Overview)", () => {
  const rows = (game: Game) => portRows(game, portsFor(game));

  it("lists a port once with every protocol it carries", () => {
    expect(rows(Game.OPENTTD)).toEqual([{ label: "Game port", value: "3979/tcp+udp" }]);
    expect(rows(Game.BEAMMP)).toEqual([{ label: "Game port", value: "30814/tcp+udp" }]);
    expect(rows(Game.SEVEN_DAYS)[0]).toEqual({ label: "Game port", value: "26900/tcp+udp" });
  });

  it("shows Satisfactory's TCP API and reliable-messaging ports", () => {
    expect(rows(Game.SATISFACTORY)).toEqual([
      { label: "Game port", value: "7777/tcp+udp" },
      { label: "Reliable messaging port", value: "8888/tcp" },
    ]);
  });

  it("gives Palworld no query port", () => {
    expect(rows(Game.PALWORLD).map((r) => r.label)).toEqual(["Game port", "RCON port"]);
  });

  it("names the console port by what the game runs", () => {
    expect(rows(Game.SEVEN_DAYS).at(-1)).toEqual({ label: "Telnet port", value: "8081/tcp" });
    expect(rows(Game.CS2).at(-1)).toEqual({ label: "RCON port", value: "27025/tcp" });
    expect(rows(Game.VALHEIM).some((r) => r.label.includes("RCON"))).toBe(false);
  });

  it("keeps a label's detail after the word port", () => {
    expect(rows(Game.ASA)).toContainEqual({ label: "Query port (server browser)", value: "7779/udp" });
  });
});

describe("consolePortSpec", () => {
  it("marks Zomboid's image-fixed RCON port read-only and CS2's editable", () => {
    expect(consolePortSpec(Game.ZOMBOID)).toEqual({ label: "RCON port", editable: false });
    expect(consolePortSpec(Game.CS2)?.editable).toBe(true);
    expect(consolePortSpec(Game.OPENTTD)).toBeNull();
  });
});
