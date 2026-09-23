import { describe, it, expect, vi } from "vitest";

vi.mock("./source-rcon", () => ({
  SourceRcon: class {
    connect = async () => {
      throw new Error("getaddrinfo EAI_AGAIN pz-test");
    };
    send = async () => "";
    end = async () => undefined;
    on = () => undefined;
  },
}));

import { RconService } from "./rcon.service";

function service(row: Record<string, unknown>) {
  const prisma = { server: { findUnique: vi.fn(async () => row) } };
  const endpoints = {
    resolve: async () => ({ host: "pz-test", port: 27015 }),
    explain: async () => null,
  };
  return new RconService(
    prisma as never,
    { decrypt: (s: string) => s } as never,
    {} as never,
    {} as never,
    {} as never,
    endpoints as never,
  );
}

const base = { id: "s1", name: "pz", game: "ZOMBOID", adminPasswordEnc: "pw" };

describe("RCON failure messages", () => {
  it("says the server isn't running instead of the raw DNS error", async () => {
    await expect(service({ ...base, state: "Stopped" }).exec("s1", "players")).rejects.toThrow(
      "The server isn't running",
    );
  });

  it("says the server is still starting", async () => {
    await expect(service({ ...base, state: "Starting" }).exec("s1", "players")).rejects.toThrow(
      "The server is still starting",
    );
  });

  it("keeps the raw cause for a running server", async () => {
    await expect(service({ ...base, state: "Running" }).exec("s1", "players")).rejects.toThrow(
      "RCON failed: getaddrinfo EAI_AGAIN pz-test",
    );
  });

  it("refuses games with no remote console", async () => {
    await expect(
      service({ ...base, game: "OPENTTD", state: "Running" }).exec("s1", "help"),
    ).rejects.toThrow("This game has no remote console");
  });
});
