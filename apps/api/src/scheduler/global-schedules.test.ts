import { describe, it, expect, vi } from "vitest";
import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { ServerState } from "@ark/shared";
import { SchedulerService } from "./scheduler.service";
import { SchedulesController } from "./schedules.controller";
import { GlobalSchedulesController } from "./global-schedules.controller";
import { AccessService } from "../auth/access.service";
import type { AuthUser } from "../auth/auth-user";

/**
 * Global schedules and schedule copies (GH #157). The two ASE servers have a
 * console and srv-vh (Valheim) does not, so an announce skips srv-vh.
 */
const servers = [
  { id: "srv-ase", name: "Island", game: "ASE", state: ServerState.Running },
  { id: "srv-vh", name: "Viking", game: "VALHEIM", state: ServerState.Running },
  { id: "srv-ase2", name: "Center", game: "ASE", state: ServerState.Running },
];

const restricted: AuthUser = { sub: "u1", role: "operator", ver: 1, restricted: true };
const unrestricted: AuthUser = { sub: "u2", role: "operator", ver: 1, restricted: false };

const byId = (where?: { id?: string | { in?: string[]; not?: string } }) =>
  servers.filter((s) => {
    const id = where?.id;
    if (id === undefined) return true;
    if (typeof id === "string") return s.id === id;
    return (!id.in || id.in.includes(s.id)) && s.id !== id.not;
  });

function makeScheduler(global: Record<string, unknown>) {
  const row = () => ({
    id: "g1",
    name: "Fleet",
    cron: "0 5 * * *",
    command: null,
    warnMinutes: 0,
    enabled: true,
    minPlayersOnline: null,
    maxPlayersOnline: null,
    runAt: null,
    allServers: true,
    servers: [],
    staggerMinutes: 0,
    ...global,
  });
  const prisma = {
    schedule: { findMany: vi.fn(async () => []) },
    globalSchedule: {
      findUnique: vi.fn(async () => row()),
      findMany: vi.fn(async () => [row()]),
      update: vi.fn(async () => undefined),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    server: {
      // The real query orders by name.
      findMany: vi.fn(async ({ where }: { where?: { id?: { in: string[] } } }) =>
        byId(where).sort((a, b) => a.name.localeCompare(b.name)),
      ),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => byId(where)[0] ?? null),
    },
  };
  const events = { emit: vi.fn(async (_e: { serverId: string }) => undefined) };
  const rcon = { broadcast: vi.fn(async (_id: string, _msg: string) => "ok"), exec: vi.fn(async () => "ok") };
  const backups = { create: vi.fn(async (_id: string, _label: string) => undefined) };
  const svc = new SchedulerService(
    prisma as never,
    events as never,
    {} as never,
    rcon as never,
    backups as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const fireGlobal = (svc as unknown as { fireGlobal(id: string): Promise<void> }).fireGlobal.bind(svc);
  const pollOneShots = (svc as unknown as { fireDueOneShots(): Promise<void> }).fireDueOneShots.bind(svc);
  const parkInterrupted = (svc as unknown as { disableInterruptedOneShots(): Promise<void> })
    .disableInterruptedOneShots.bind(svc);
  return { fireGlobal, pollOneShots, parkInterrupted, prisma, events, rcon, backups };
}

describe("firing a global schedule (GH #157)", () => {
  it("runs on every server that can take the action, and skips the rest", async () => {
    const { fireGlobal, prisma, events, rcon } = makeScheduler({ action: "announce", command: "Hi" });
    await fireGlobal("g1");
    expect(rcon.broadcast.mock.calls.map((c) => c[0]).sort()).toEqual(["srv-ase", "srv-ase2"]);
    expect(prisma.globalSchedule.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "g1" }, data: { lastRunAt: expect.any(Date) } }),
    );
    // Each target's own event log records the firing.
    expect(events.emit.mock.calls.map((c) => c[0].serverId).sort()).toEqual([
      "srv-ase",
      "srv-ase2",
    ]);
  });

  it("with a picked list, runs only on those servers", async () => {
    const { fireGlobal, backups } = makeScheduler({
      action: "backup",
      allServers: false,
      servers: [{ id: "srv-vh" }, { id: "srv-ase2" }],
    });
    await fireGlobal("g1");
    expect(backups.create.mock.calls.map((c) => c[0]).sort()).toEqual(["srv-ase2", "srv-vh"]);
  });

  it("staggers servers in name order when asked", async () => {
    vi.useFakeTimers();
    try {
      const { fireGlobal, backups } = makeScheduler({
        action: "backup",
        allServers: false,
        servers: [{ id: "srv-vh" }, { id: "srv-ase2" }],
        staggerMinutes: 5,
      });
      const done = fireGlobal("g1");
      await vi.advanceTimersByTimeAsync(0);
      expect(backups.create.mock.calls.map((c) => c[0])).toEqual(["srv-ase2"]);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(backups.create.mock.calls.map((c) => c[0])).toEqual(["srv-ase2", "srv-vh"]);
      await done;
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips the servers still waiting once the schedule is turned off", async () => {
    vi.useFakeTimers();
    try {
      const global = { action: "backup", staggerMinutes: 5, enabled: true };
      const { fireGlobal, backups } = makeScheduler(global);
      const done = fireGlobal("g1");
      await vi.advanceTimersByTimeAsync(0);
      global.enabled = false;
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      await done;
      expect(backups.create.mock.calls.map((c) => c[0])).toEqual(["srv-ase2"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips the servers still waiting once a one-time schedule is re-timed", async () => {
    vi.useFakeTimers();
    try {
      const global: Record<string, unknown> = { action: "backup", staggerMinutes: 5, runAt: new Date(1_000) };
      const { fireGlobal, backups } = makeScheduler(global);
      const done = fireGlobal("g1");
      await vi.advanceTimersByTimeAsync(0);
      global.runAt = new Date(2_000);
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      await done;
      expect(backups.create.mock.calls.map((c) => c[0])).toEqual(["srv-ase2"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("after a one-time firing, disables only the run that fired, not a re-timed one", async () => {
    const runAt = new Date(Date.now() - 1_000);
    const { pollOneShots, prisma } = makeScheduler({ action: "backup", runAt, lastRunAt: null });
    await pollOneShots();
    await vi.waitFor(() => expect(prisma.globalSchedule.updateMany).toHaveBeenCalled());
    expect(prisma.globalSchedule.updateMany).toHaveBeenCalledWith({
      where: { id: "g1", runAt },
      data: { enabled: false },
    });
  });

  it("on boot, parks a one-time schedule a restart cut off and says so", async () => {
    const { parkInterrupted, prisma, events } = makeScheduler({
      action: "restart",
      runAt: new Date(1_000),
      lastRunAt: new Date(2_000),
    });
    await parkInterrupted();
    expect(prisma.globalSchedule.update).toHaveBeenCalledWith({ where: { id: "g1" }, data: { enabled: false } });
    expect(events.emit).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("interrupted by a manager restart") }),
    );
  });

  it("does nothing while disabled", async () => {
    const { fireGlobal, backups, prisma } = makeScheduler({ action: "backup", enabled: false });
    await fireGlobal("g1");
    expect(backups.create).not.toHaveBeenCalled();
    expect(prisma.globalSchedule.update).not.toHaveBeenCalled();
  });
});

const globals = [
  { id: "g-all", action: "announce", allServers: true, servers: [], createdAt: new Date(3) },
  { id: "g-vh", action: "backup", allServers: false, servers: [{ id: "srv-vh" }], createdAt: new Date(2) },
];

function makeGlobalController() {
  const prisma = {
    userServerAccess: { findMany: vi.fn(async () => [{ serverId: "srv-vh" }]) },
    userClusterAccess: { findMany: vi.fn(async () => []) },
    server: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => byId(where)[0] ?? null),
      findMany: vi.fn(async () => servers),
      count: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => byId(where).length),
    },
    globalSchedule: {
      findMany: vi.fn(async () => globals),
      create: vi.fn(async ({ data }: { data: { servers: { connect: { id: string }[] } } }) => ({
        id: "new",
        ...data,
        servers: data.servers.connect,
      })),
    },
  };
  const scheduler = { registerGlobalWithTimezone: vi.fn(async () => undefined), unregisterGlobal: vi.fn() };
  const ctl = new GlobalSchedulesController(prisma as never, scheduler as never, new AccessService(prisma as never));
  return { ctl, prisma, scheduler };
}

const globalBody = { name: "n", cron: "0 5 * * *", action: "restart" };

describe("GlobalSchedulesController (GH #157)", () => {
  it("keeps restricted users out of the fleet-wide list and writes", async () => {
    const { ctl, prisma } = makeGlobalController();
    await expect(ctl.list(restricted)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(ctl.create({ ...globalBody, allServers: true }, restricted)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.globalSchedule.create).not.toHaveBeenCalled();
  });

  it("lists, for one visible server, the global schedules its game can run", async () => {
    const { ctl } = makeGlobalController();
    // Valheim has no console, so the announce is not shown as running there.
    expect((await ctl.list(restricted, "srv-vh")).map((r) => r.id)).toEqual(["g-vh"]);
    await expect(ctl.list(restricted, "srv-ase")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("rejects an empty or unknown target list, and registers a valid one", async () => {
    const { ctl, scheduler } = makeGlobalController();
    await expect(ctl.create({ ...globalBody, serverIds: [] }, unrestricted)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(ctl.create({ ...globalBody, serverIds: ["srv-gone"] }, unrestricted)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    const created = await ctl.create({ ...globalBody, serverIds: ["srv-vh"] }, unrestricted);
    expect(created.serverIds).toEqual(["srv-vh"]);
    expect(scheduler.registerGlobalWithTimezone).toHaveBeenCalledWith("new", "0 5 * * *");
  });
});

function makeCopyController(source: Record<string, unknown>) {
  const row = {
    id: "sch-1",
    serverId: "srv-ase",
    name: "Hourly hello",
    cron: "0 * * * *",
    action: "announce",
    command: "Hello",
    warnMinutes: 0,
    enabled: true,
    minPlayersOnline: null,
    maxPlayersOnline: 3,
    runAt: null,
    ...source,
  };
  const prisma = {
    userServerAccess: { findMany: vi.fn(async () => [{ serverId: "srv-ase" }, { serverId: "srv-vh" }]) },
    userClusterAccess: { findMany: vi.fn(async () => []) },
    server: {
      findMany: vi.fn(async ({ where }: { where?: { id?: { in: string[]; not: string } } }) => byId(where)),
    },
    schedule: {
      findUnique: vi.fn(async () => row),
      findUniqueOrThrow: vi.fn(async () => row),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: `copy-${data.serverId}`, ...data })),
    },
  };
  const scheduler = { registerWithTimezone: vi.fn(async () => undefined) };
  const ctl = new SchedulesController(prisma as never, scheduler as never, new AccessService(prisma as never));
  return { ctl, prisma, scheduler };
}

describe("copying a schedule to other servers (GH #157)", () => {
  it("copies to each target that can run it, skipping the source and naming the rest", async () => {
    const { ctl, prisma, scheduler } = makeCopyController({});
    const result = await ctl.copy("sch-1", { targetIds: ["srv-ase", "srv-vh", "srv-ase2"] }, unrestricted);
    expect(result).toEqual({ copied: 1, skipped: ["Viking"] });
    expect(prisma.schedule.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ serverId: "srv-ase2", command: "Hello", maxPlayersOnline: 3 }),
    });
    expect(scheduler.registerWithTimezone).toHaveBeenCalledWith("copy-srv-ase2", "0 * * * *");
  });

  it("404s a target the caller can't see, before copying anything", async () => {
    const { ctl, prisma } = makeCopyController({});
    await expect(ctl.copy("sch-1", { targetIds: ["srv-ase2"] }, restricted)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.schedule.create).not.toHaveBeenCalled();
  });

  it("refuses a one-time schedule whose moment has passed", async () => {
    const { ctl } = makeCopyController({ runAt: new Date(Date.now() - 60_000) });
    await expect(ctl.copy("sch-1", { targetIds: ["srv-ase2"] }, unrestricted)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
