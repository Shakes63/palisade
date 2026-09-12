import { describe, it, expect, vi } from "vitest";
import { NotFoundException } from "@nestjs/common";
import { SchedulesController } from "./schedules.controller";
import { AccessService } from "../auth/access.service";
import type { AuthUser } from "../auth/auth-user";

/**
 * Schedules carry their server by body/query, not in the path, so the global
 * guard can't scope them (GH #73). The controller must filter the list and 404
 * any create/update/delete that touches a server the caller can't see.
 *
 * Real AccessService over a fake Prisma: "u1" is granted srv-a directly and
 * nothing through clusters.
 */
const rows = [
  { id: "sch-a", serverId: "srv-a", createdAt: new Date(2) },
  { id: "sch-b", serverId: "srv-b", createdAt: new Date(1) },
];

function make() {
  const prisma = {
    userServerAccess: { findMany: vi.fn(async () => [{ serverId: "srv-a" }]) },
    userClusterAccess: { findMany: vi.fn(async () => []) },
    server: { findMany: vi.fn(async () => []) },
    schedule: {
      findMany: vi.fn(async ({ where }: { where?: { serverId?: string } }) =>
        where?.serverId ? rows.filter((r) => r.serverId === where.serverId) : rows,
      ),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const r = rows.find((x) => x.id === where.id);
        return r ? { serverId: r.serverId } : null;
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: "new", ...data })),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({
        ...rows.find((x) => x.id === where.id),
        ...data,
      })),
      delete: vi.fn(async () => undefined),
    },
  };
  const scheduler = { registerWithTimezone: vi.fn(async () => undefined), unregister: vi.fn() };
  const access = new AccessService(prisma as never);
  const ctl = new SchedulesController(prisma as never, scheduler as never, access);
  return { ctl, prisma, scheduler };
}

const restricted: AuthUser = { sub: "u1", role: "operator", ver: 1, restricted: true };
const unrestricted: AuthUser = { sub: "u2", role: "operator", ver: 1, restricted: false };
const admin: AuthUser = { sub: "u3", role: "admin", ver: 1, restricted: true };

const body = { serverId: "srv-b", name: "n", cron: "* * * * *", action: "restart" };

describe("SchedulesController access (GH #73)", () => {
  it("list without serverId narrows to visible servers; unrestricted and admin see all", async () => {
    const { ctl } = make();
    expect((await ctl.list(restricted)).map((r) => r.id)).toEqual(["sch-a"]);
    expect((await ctl.list(unrestricted)).map((r) => r.id)).toEqual(["sch-a", "sch-b"]);
    expect((await ctl.list(admin)).map((r) => r.id)).toEqual(["sch-a", "sch-b"]);
  });

  it("list with serverId 404s on a hidden server and passes a visible one through", async () => {
    const { ctl } = make();
    await expect(ctl.list(restricted, "srv-b")).rejects.toBeInstanceOf(NotFoundException);
    expect((await ctl.list(restricted, "srv-a")).map((r) => r.id)).toEqual(["sch-a"]);
  });

  it("create checks body.serverId", async () => {
    const { ctl, prisma } = make();
    await expect(ctl.create(body, restricted)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.schedule.create).not.toHaveBeenCalled();
    await ctl.create({ ...body, serverId: "srv-a" }, restricted);
    expect(prisma.schedule.create).toHaveBeenCalledTimes(1);
  });

  it("update checks the schedule's current server, and the new one when moving", async () => {
    const { ctl, prisma } = make();
    // Hidden schedule: 404 before any write.
    await expect(ctl.update("sch-b", { name: "x" }, restricted)).rejects.toBeInstanceOf(NotFoundException);
    // Visible schedule moved onto a hidden server: also 404.
    await expect(ctl.update("sch-a", { serverId: "srv-b" }, restricted)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.schedule.update).not.toHaveBeenCalled();
    // Visible schedule, plain edit: goes through.
    await ctl.update("sch-a", { name: "x" }, restricted);
    expect(prisma.schedule.update).toHaveBeenCalledTimes(1);
  });

  it("update/delete of an unknown schedule is a 404 too", async () => {
    const { ctl } = make();
    await expect(ctl.update("nope", { name: "x" }, restricted)).rejects.toBeInstanceOf(NotFoundException);
    await expect(ctl.remove("nope", admin)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("delete checks the schedule's server and leaves the cron job registered on denial", async () => {
    const { ctl, prisma, scheduler } = make();
    await expect(ctl.remove("sch-b", restricted)).rejects.toBeInstanceOf(NotFoundException);
    expect(scheduler.unregister).not.toHaveBeenCalled();
    expect(prisma.schedule.delete).not.toHaveBeenCalled();
    await ctl.remove("sch-a", restricted);
    expect(scheduler.unregister).toHaveBeenCalledWith("sch-a");
    expect(prisma.schedule.delete).toHaveBeenCalledTimes(1);
  });
});
