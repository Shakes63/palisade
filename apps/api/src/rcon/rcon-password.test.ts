import { describe, it, expect, vi, beforeEach } from "vitest";

// RCON must authenticate with the password the RUNNING container was created
// with. Changing a server's admin password without restarting it left the
// manager dialling a password the game server had never heard of (GH #68).

const dialled: string[] = [];

vi.mock("./source-rcon", () => ({
  SourceRcon: class {
    constructor(opts: { password: string }) {
      dialled.push(opts.password);
    }
    connect = async () => undefined;
    send = async () => "";
    end = async () => undefined;
    on = () => undefined;
  },
}));

import { RconService } from "./rcon.service";

function connect(row: Record<string, unknown>) {
  const prisma = { server: { findUnique: vi.fn(async () => row) } };
  const crypto = { decrypt: (s: string) => s.replace(/^enc\(/, "").replace(/\)$/, "") };
  const endpoints = { resolve: async () => ({ host: "zomboid", port: 27015 }) };
  const svc = new RconService(
    prisma as never,
    crypto as never,
    {} as never,
    {} as never,
    {} as never,
    endpoints as never,
  );
  return (svc as unknown as { connect: (id: string) => Promise<unknown> }).connect("s1");
}

const base = { id: "s1", name: "pztest", game: "ZOMBOID" };

describe("RCON password selection", () => {
  beforeEach(() => void (dialled.length = 0));

  it("uses the password the running container was launched with", async () => {
    await connect({ ...base, adminPasswordEnc: "enc(new)", launchAdminPasswordEnc: "enc(old)" });
    expect(dialled).toEqual(["old"]);
  });

  it("falls back to the current password when nothing was recorded", async () => {
    await connect({ ...base, adminPasswordEnc: "enc(only)", launchAdminPasswordEnc: null });
    expect(dialled).toEqual(["only"]);
  });
});
