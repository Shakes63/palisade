import { describe, it, expect } from "vitest";
import { Game } from "@ark/shared";
import {
  derivePorts,
  nextBasePort,
  serverPortSet,
  PORT_POOL_START,
  BLOCK_STRIDE,
  VALHEIM_PORTS,
  BEDROCK_PORTS,
  MINECRAFT_PORTS,
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
