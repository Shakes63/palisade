import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { IsBoolean, IsDateString, IsIn, IsInt, IsOptional, IsString, Min } from "class-validator";
import { PrismaService } from "../prisma/prisma.service";
import { SchedulerService } from "./scheduler.service";

class ScheduleBody {
  @IsString() serverId!: string;
  @IsString() name!: string;
  @IsString() cron!: string;
  @IsIn(["restart", "update", "backup", "stop", "start"]) action!: string;
  @IsOptional() @IsInt() @Min(0) warnMinutes?: number;
  @IsOptional() @IsBoolean() enabled?: boolean;
  /** Set for a ONE-TIME schedule: ISO instant to fire once (cron then ignored). */
  @IsOptional() @IsDateString() runAt?: string;
}

@Controller("schedules")
export class SchedulesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scheduler: SchedulerService,
  ) {}

  @Get()
  list(@Query("serverId") serverId?: string) {
    return this.prisma.schedule.findMany({
      where: serverId ? { serverId } : undefined,
      orderBy: { createdAt: "desc" },
    });
  }

  @Post()
  async create(@Body() body: ScheduleBody) {
    const created = await this.prisma.schedule.create({
      data: {
        serverId: body.serverId,
        name: body.name,
        cron: body.cron,
        action: body.action,
        warnMinutes: body.warnMinutes ?? 10,
        enabled: body.enabled ?? true,
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
  async update(@Param("id") id: string, @Body() body: Partial<ScheduleBody>) {
    const data = { ...body, runAt: body.runAt !== undefined ? new Date(body.runAt) : undefined };
    const updated = await this.prisma.schedule.update({ where: { id }, data });
    this.scheduler.unregister(id);
    if (updated.enabled && !updated.runAt) {
      await this.scheduler.registerWithTimezone(id, updated.cron);
    }
    return updated;
  }

  @Delete(":id")
  async remove(@Param("id") id: string) {
    this.scheduler.unregister(id);
    await this.prisma.schedule.delete({ where: { id } });
    return { ok: true };
  }
}
