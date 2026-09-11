import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import { IsBoolean, IsDateString, IsIn, IsInt, IsOptional, IsString, Min } from "class-validator";
import { PrismaService } from "../prisma/prisma.service";
import { SchedulerService } from "./scheduler.service";
import { AccessService } from "../auth/access.service";
import { CurrentUser } from "../auth/current-user.decorator";
import type { AuthUser } from "../auth/auth-user";

class ScheduleBody {
  @IsString() serverId!: string;
  @IsString() name!: string;
  @IsString() cron!: string;
  @IsIn(["restart", "update", "update-if-available", "update-mods", "backup", "stop", "start"]) action!: string;
  @IsOptional() @IsInt() @Min(0) warnMinutes?: number;
  @IsOptional() @IsBoolean() enabled?: boolean;
  /** Skip disruptive actions (restart/update/stop) while players are online. */
  @IsOptional() @IsBoolean() skipIfPlayersOnline?: boolean;
  /** Set for a ONE-TIME schedule: ISO instant to fire once (cron then ignored). */
  @IsOptional() @IsDateString() runAt?: string;
}

/**
 * Schedules carry their server by body/query rather than in the path, so the
 * global ServerAccessGuard can't scope them; every handler checks the server
 * itself (GH #73).
 */
@Controller("schedules")
export class SchedulesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scheduler: SchedulerService,
    private readonly access: AccessService,
  ) {}

  @Get()
  async list(@CurrentUser() user: AuthUser, @Query("serverId") serverId?: string) {
    if (serverId) await this.access.assertServer(user, serverId);
    const rows = await this.prisma.schedule.findMany({
      where: serverId ? { serverId } : undefined,
      orderBy: { createdAt: "desc" },
    });
    if (serverId) return rows;
    return this.access.filterByServer(rows, await this.access.allowedServerIds(user));
  }

  @Post()
  async create(@Body() body: ScheduleBody, @CurrentUser() user: AuthUser) {
    await this.access.assertServer(user, body.serverId);
    const created = await this.prisma.schedule.create({
      data: {
        serverId: body.serverId,
        name: body.name,
        cron: body.cron,
        action: body.action,
        warnMinutes: body.warnMinutes ?? 10,
        enabled: body.enabled ?? true,
        skipIfPlayersOnline: body.skipIfPlayersOnline ?? false,
        runAt: body.runAt ? new Date(body.runAt) : null,
      },
    });
    // One-time schedules (runAt) are driven by the poll, not cron.
    if (created.enabled && !created.runAt) {
      await this.scheduler.registerWithTimezone(created.id, created.cron);
    }
    return created;
  }

  @Patch(":id")
  async update(
    @Param("id") id: string,
    @Body() body: Partial<ScheduleBody>,
    @CurrentUser() user: AuthUser,
  ) {
    const current = await this.owned(id, user);
    // Moving a schedule onto another server needs that server too.
    if (body.serverId && body.serverId !== current) await this.access.assertServer(user, body.serverId);
    const data = { ...body, runAt: body.runAt !== undefined ? new Date(body.runAt) : undefined };
    const updated = await this.prisma.schedule.update({ where: { id }, data });
    this.scheduler.unregister(id);
    if (updated.enabled && !updated.runAt) {
      await this.scheduler.registerWithTimezone(id, updated.cron);
    }
    return updated;
  }

  @Delete(":id")
  async remove(@Param("id") id: string, @CurrentUser() user: AuthUser) {
    await this.owned(id, user);
    this.scheduler.unregister(id);
    await this.prisma.schedule.delete({ where: { id } });
    return { ok: true };
  }

  /** The schedule's server id, after checking the caller may see that server.
   *  A missing schedule and a hidden one both 404. */
  private async owned(id: string, user: AuthUser): Promise<string> {
    const row = await this.prisma.schedule.findUnique({ where: { id }, select: { serverId: true } });
    if (!row) throw new NotFoundException("Schedule not found");
    await this.access.assertServer(user, row.serverId);
    return row.serverId;
  }
}
