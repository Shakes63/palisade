import { describe, it, expect, vi } from "vitest";
import { BadRequestException } from "@nestjs/common";
import { ServerState } from "@ark/shared";
import { SchedulerService } from "./scheduler.service";
import { SchedulesController } from "./schedules.controller";
import { AccessService } from "../auth/access.service";
import type { AuthUser } from "../auth/auth-user";

/**
 * Scheduled RCON announcements and console commands (GH #78). The payload lives
 * in Schedule.command; the two actions are non-disruptive, so they must not drag
 * the warning countdown or the pre-action backup along with them.
 */

const admin: AuthUser = { sub: "u1", role: "admin", ver: 1, restricted: false };

function makeScheduler(
  sched: { action: string; command: string | null; warnMinutes?: number; runAt?: Date },
  state: ServerState = ServerState.Running,
) {
  const prisma = {
    schedule: {
      findUnique: vi.fn(async () => ({
        id: "sch-1",
        serverId: "srv-1",
        name: "test",
        enabled: true,
        warnMinutes: 10,
        skipIfPlayersOnline: false,
        runAt: null,
        ...sched,
      })),
      update: vi.fn(async () => undefined),
    },
    server: { findUnique: vi.fn(async () => ({ state })) },
  };
  const events = { emit: vi.fn(async () => undefined) };
  const rcon = { broadcast: vi.fn(async () => "ok"), exec: vi.fn(async () => "ok") };
  const backups = { create: vi.fn(async () => undefined) };
  const servers = { restart: vi.fn(), stop: vi.fn(), start: vi.fn(), updateGame: vi.fn() };
  const svc = new SchedulerService(
    prisma as never,
    events as never,
    servers as never,
    rcon as never,
    backups as never,
    {} as never,
    { count: vi.fn(async () => ({ online: 0 })) } as never,
    {} as never,
    {} as never,
  );
  // fire() is private; the cron callback is the only production caller.
  const fire = (svc as unknown as { fire(id: string): Promise<void> }).fire.bind(svc);
  return { fire, prisma, events, rcon, backups, servers };
}

const messages = (events: { emit: ReturnType<typeof vi.fn> }) =>
  events.emit.mock.calls.map((c) => (c[0] as { message: string }).message).join("\n");

describe("scheduled RCON actions (GH #78)", () => {
  it("announce broadcasts the message, with no countdown or backup", async () => {
    const { fire, rcon, backups, servers } = makeScheduler({
      action: "announce",
      command: "Raid night at 8!",
    });
    await fire("sch-1");
    expect(rcon.broadcast).toHaveBeenCalledWith("srv-1", "Raid night at 8!");
    expect(rcon.exec).not.toHaveBeenCalled();
    // Non-disruptive: nothing is stopped and no pre-action snapshot is taken.
    expect(backups.create).not.toHaveBeenCalled();
    expect(servers.restart).not.toHaveBeenCalled();
  });

  it("command sends the raw console command", async () => {
    const { fire, rcon } = makeScheduler({ action: "command", command: "SaveWorld" });
    await fire("sch-1");
    expect(rcon.exec).toHaveBeenCalledWith("srv-1", "SaveWorld");
    expect(rcon.broadcast).not.toHaveBeenCalled();
  });

  it("skips quietly while the server is stopped instead of failing every firing", async () => {
    const { fire, rcon, events } = makeScheduler(
      { action: "announce", command: "hello" },
      ServerState.Stopped,
    );
    await fire("sch-1");
    expect(rcon.broadcast).not.toHaveBeenCalled();
    expect(messages(events)).toContain("skipped — the server isn't running");
  });

  it("says so when a skipped one-time schedule is spent, since it won't run again", async () => {
    const { fire, events } = makeScheduler(
      { action: "announce", command: "hello", runAt: new Date() },
      ServerState.Stopped,
    );
    await fire("sch-1");
    expect(messages(events)).toContain("a one-time schedule doesn't run again");
  });

  it("warns and sends nothing when the payload is missing", async () => {
    const { fire, rcon, events } = makeScheduler({ action: "command", command: "   " });
    await fire("sch-1");
    expect(rcon.exec).not.toHaveBeenCalled();
    expect(messages(events)).toContain("has no command to send");
  });

  it("leaves the other actions alone — a restart still warns and backs up", async () => {
    // warnMinutes 0 so the countdown doesn't sleep a real minute per step.
    const { fire, backups, servers, rcon } = makeScheduler({
      action: "restart",
      command: null,
      warnMinutes: 0,
    });
    await fire("sch-1");
    expect(servers.restart).toHaveBeenCalledWith("srv-1");
    expect(backups.create).toHaveBeenCalledWith("srv-1", "pre-restart");
    expect(rcon.exec).not.toHaveBeenCalled();
  });
});

function makeController(row: { action: string; command: string | null } = {
  action: "announce",
  command: "old message",
}) {
  const prisma = {
    userServerAccess: { findMany: vi.fn(async () => []) },
    userClusterAccess: { findMany: vi.fn(async () => []) },
    server: { findMany: vi.fn(async () => []) },
    schedule: {
      findUnique: vi.fn(async () => ({ serverId: "srv-1", ...row })),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: "new", ...data })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: "sch-1", ...data })),
    },
  };
  const scheduler = { registerWithTimezone: vi.fn(async () => undefined), unregister: vi.fn() };
  const ctl = new SchedulesController(prisma as never, scheduler as never, new AccessService(prisma as never));
  return { ctl, prisma };
}

const body = { serverId: "srv-1", name: "n", cron: "0 * * * *", action: "announce" };

/** The `data` a fake Prisma call was handed, without the index-access noise. */
const dataOf = (mock: ReturnType<typeof vi.fn>, call = 0): Record<string, unknown> =>
  (mock.mock.calls[call]![0] as { data: Record<string, unknown> }).data;

describe("schedule payload validation (GH #78)", () => {
  it("rejects an announce with nothing to say, and a command with nothing to run", async () => {
    const { ctl, prisma } = makeController();
    await expect(ctl.create(body, admin)).rejects.toBeInstanceOf(BadRequestException);
    await expect(ctl.create({ ...body, action: "command", command: "  " }, admin)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.schedule.create).not.toHaveBeenCalled();
  });

  it("stores the payload trimmed, and null for actions that carry none", async () => {
    const { ctl, prisma } = makeController();
    await ctl.create({ ...body, command: "  hello  " }, admin);
    expect(dataOf(prisma.schedule.create).command).toBe("hello");
    await ctl.create({ ...body, action: "restart", command: "ignored" }, admin);
    expect(dataOf(prisma.schedule.create, 1).command).toBeNull();
  });

  it("validates a patch against the merged row, not just the body", async () => {
    const { ctl } = makeController();
    // Blanking the message on an existing announce leaves it with nothing to send.
    await expect(ctl.update("sch-1", { command: "" }, admin)).rejects.toBeInstanceOf(BadRequestException);
    // Switching a payload-free action TO announce without supplying one, likewise.
    const { ctl: ctl2 } = makeController({ action: "restart", command: null });
    await expect(ctl2.update("sch-1", { action: "announce" }, admin)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("clears a stale payload when the action moves away from RCON", async () => {
    const { ctl, prisma } = makeController();
    await ctl.update("sch-1", { action: "restart" }, admin);
    expect(dataOf(prisma.schedule.update).command).toBeNull();
  });

  it("leaves the payload untouched on an unrelated patch", async () => {
    const { ctl, prisma } = makeController();
    await ctl.update("sch-1", { enabled: false }, admin);
    expect(dataOf(prisma.schedule.update)).not.toHaveProperty("command");
  });
});
