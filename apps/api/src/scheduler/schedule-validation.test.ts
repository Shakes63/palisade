import { describe, it, expect, vi } from "vitest";
import { BadRequestException, ValidationPipe } from "@nestjs/common";
import { SchedulerService } from "./scheduler.service";
import { SchedulesController, SchedulePatchBody } from "./schedules.controller";
import { AccessService } from "../auth/access.service";
import type { AuthUser } from "../auth/auth-user";

/**
 * PATCH /schedules/:id ran no validation at all, and a rejected edit was written
 * anyway — a row left holding an unparseable cron then killed the next boot
 * (GH #99). Three seams: the pipe now has a class to work with, the controller
 * checks before it writes, and registerAll tolerates a row that predates both.
 */

const admin: AuthUser = { sub: "u1", role: "admin", ver: 1, restricted: false };

// The same pipe main.ts installs globally, so what the handler would actually be
// handed is what's under test.
const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false });
const patchBody = (body: Record<string, unknown>) =>
  pipe.transform(body, { type: "body", metatype: SchedulePatchBody });

function makeController(row = { action: "restart", command: null as string | null }) {
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
  const ctl = new SchedulesController(
    prisma as never,
    scheduler as never,
    new AccessService(prisma as never),
  );
  return { ctl, prisma, scheduler };
}

const body = { serverId: "srv-1", name: "n", cron: "0 4 * * *", action: "restart" };

describe("schedule edit validation (GH #99)", () => {
  it("rejects an action on PATCH that POST already refused", async () => {
    await expect(patchBody({ action: "rm -rf" })).rejects.toBeInstanceOf(BadRequestException);
    await expect(patchBody({ action: "restart" })).resolves.toEqual({ action: "restart" });
  });

  it("keeps every field the handler reads and drops the rest", async () => {
    // whitelist: true strips anything undecorated, so the merge in update() would
    // silently lose fields if PartialType hadn't carried the decorators over.
    await expect(
      patchBody({
        serverId: "srv-2",
        name: "n",
        cron: "0 4 * * *",
        action: "command",
        command: "SaveWorld",
        warnMinutes: 5,
        enabled: false,
        minPlayersOnline: 2,
        maxPlayersOnline: 10,
        runAt: "2026-01-01T00:00:00.000Z",
        bogus: "dropped",
      }),
    ).resolves.toEqual({
      serverId: "srv-2",
      name: "n",
      cron: "0 4 * * *",
      action: "command",
      command: "SaveWorld",
      warnMinutes: 5,
      enabled: false,
      minPlayersOnline: 2,
      maxPlayersOnline: 10,
      runAt: "2026-01-01T00:00:00.000Z",
    });
    // An absent field stays absent: update() spreads the body into Prisma's data.
    await expect(patchBody({ enabled: true })).resolves.toEqual({ enabled: true });
  });

  it("rejects an invalid cron on PATCH without writing or unregistering anything", async () => {
    const { ctl, prisma, scheduler } = makeController();
    await expect(ctl.update("sch-1", { cron: "not a cron at all" }, admin)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.schedule.update).not.toHaveBeenCalled();
    expect(scheduler.unregister).not.toHaveBeenCalled();
  });

  it("rejects an invalid cron on POST before the row exists", async () => {
    const { ctl, prisma } = makeController();
    await expect(ctl.create({ ...body, cron: "nonsense" }, admin)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.schedule.create).not.toHaveBeenCalled();
  });

  it("turns an unparseable runAt into a 400 instead of letting Prisma 500", async () => {
    const { ctl, prisma } = makeController();
    await expect(ctl.create({ ...body, runAt: "garbage" }, admin)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(ctl.update("sch-1", { runAt: "garbage" }, admin)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.schedule.create).not.toHaveBeenCalled();
    expect(prisma.schedule.update).not.toHaveBeenCalled();
  });
});

function makeScheduler(rows: Array<{ id: string; name: string; cron: string; serverId: string }>) {
  const prisma = {
    schedule: { findMany: vi.fn(async () => rows), update: vi.fn(async () => undefined) },
  };
  const events = { emit: vi.fn(async () => undefined) };
  const settings = { getTimezone: vi.fn(async () => "UTC") };
  const svc = new SchedulerService(
    prisma as never,
    events as never,
    {} as never,
    {} as never,
    {} as never,
    settings as never,
    {} as never,
    {} as never,
    {} as never,
  );
  // tasks is private; its keys are the only way to see what actually registered.
  const tasks = (svc as unknown as { tasks: Map<string, { stop(): void }> }).tasks;
  return { svc, prisma, events, tasks };
}

const messages = (events: { emit: ReturnType<typeof vi.fn> }) =>
  events.emit.mock.calls.map((c) => (c[0] as { message: string }).message).join("\n");

describe("registerAll with a poisoned row (GH #99)", () => {
  it("skips the bad row, registers the good ones, and stays resolved", async () => {
    const { svc, prisma, events, tasks } = makeScheduler([
      { id: "good-1", name: "Nightly restart", cron: "0 4 * * *", serverId: "srv-1" },
      { id: "bad", name: "Broken", cron: "not a cron at all", serverId: "srv-1" },
      { id: "good-2", name: "Hourly save", cron: "0 * * * *", serverId: "srv-2" },
    ]);
    // registerAll is awaited by onModuleInit; a throw here exited the container.
    await expect(svc.registerAll()).resolves.toBeUndefined();
    expect([...tasks.keys()]).toEqual(["good-1", "good-2"]);
    // The row can never fire, so it's parked rather than left looking armed.
    expect(prisma.schedule.update).toHaveBeenCalledWith({
      where: { id: "bad" },
      data: { enabled: false },
    });
    expect(messages(events)).toContain('Schedule "Broken" was disabled');
    for (const id of [...tasks.keys()]) svc.unregister(id);
  });
});
