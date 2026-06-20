import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Min } from "class-validator";
import { PrismaService } from "../prisma/prisma.service";
import { SchedulerService } from "./scheduler.service";

class ScheduleBody {
  @IsString() serverId!: string;
  @IsString() name!: string;
  @IsString() cron!: string;
  @IsIn(["restart", "update", "backup", "stop", "start"]) action!: string;
  @IsOptional() @IsInt() @Min(0) warnMinutes?: number;
  @IsOptional() @IsBoolean() enabled?: boolean;
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
      },
    });
    if (created.enabled) await this.scheduler.registerWithTimezone(created.id, created.cron);
    return created;
  }

  @Patch(":id")
  async update(@Param("id") id: string, @Body() body: Partial<ScheduleBody>) {
    const updated = await this.prisma.schedule.update({ where: { id }, data: body });
    this.scheduler.unregister(id);
    if (updated.enabled) await this.scheduler.registerWithTimezone(id, updated.cron);
    return updated;
  }

  @Delete(":id")
  async remove(@Param("id") id: string) {
    this.scheduler.unregister(id);
    await this.prisma.schedule.delete({ where: { id } });
    return { ok: true };
  }
}
