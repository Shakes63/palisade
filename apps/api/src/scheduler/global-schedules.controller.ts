import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import { OmitType, PartialType } from "@nestjs/mapped-types";
import { IsArray, IsBoolean, IsInt, IsOptional, IsString, Min } from "class-validator";
import { RCON_SCHEDULE_ACTIONS, SCHEDULE_ACTIONS, type Game } from "@ark/shared";
import type { GlobalSchedule } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { SchedulerService, assertValidCron, supportsAction } from "./scheduler.service";
import { ScheduleBody, assertPayload, parseRunAt } from "./schedules.controller";
import { AccessService } from "../auth/access.service";
import { CurrentUser } from "../auth/current-user.decorator";
import type { AuthUser } from "../auth/auth-user";

class GlobalScheduleBody extends OmitType(ScheduleBody, ["serverId"] as const) {
  /** Every server, including ones added later. `serverIds` is kept but ignored. */
  @IsOptional() @IsBoolean() allServers?: boolean;
  @IsOptional() @IsArray() @IsString({ each: true }) serverIds?: string[];
  @IsOptional() @IsInt() @Min(0) staggerMinutes?: number;
}

export class GlobalSchedulePatchBody extends PartialType(GlobalScheduleBody) {}

type WithServers = GlobalSchedule & { servers: { id: string }[] };

const withServers = { servers: { select: { id: true } } } as const;

const view = ({ servers, ...row }: WithServers) => ({ ...row, serverIds: servers.map((s) => s.id) });

/** Schedules that fire on several servers at once (GH #157). They reach servers a
 *  restricted user may not see, so only unrestricted users manage them. */
@Controller("global-schedules")
export class GlobalSchedulesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scheduler: SchedulerService,
    private readonly access: AccessService,
  ) {}

  /** With serverId, the global schedules that run on that server, for its own
   *  Schedules tab; without, every global schedule. */
  @Get()
  async list(@CurrentUser() user: AuthUser, @Query("serverId") serverId?: string) {
    if (!serverId) {
      this.assertUnrestricted(user);
      const rows = await this.prisma.globalSchedule.findMany({ include: withServers, orderBy: { createdAt: "desc" } });
      return rows.map(view);
    }
    await this.access.assertServer(user, serverId);
    const server = await this.prisma.server.findUnique({ where: { id: serverId }, select: { game: true } });
    if (!server) throw new NotFoundException("Server not found");
    const rows = await this.prisma.globalSchedule.findMany({
      where: { OR: [{ allServers: true }, { servers: { some: { id: serverId } } }] },
      orderBy: { createdAt: "desc" },
    });
    return rows.filter((r) => supportsAction(server.game as Game, r.action));
  }

  /** Every server with the actions its game can run, for the target picker. */
  @Get("servers")
  async servers(@CurrentUser() user: AuthUser) {
    this.assertUnrestricted(user);
    const servers = await this.prisma.server.findMany({
      select: { id: true, name: true, game: true },
      orderBy: { name: "asc" },
    });
    return servers.map((s) => ({ ...s, actions: SCHEDULE_ACTIONS.filter((a) => supportsAction(s.game as Game, a)) }));
  }

  @Post()
  async create(@Body() body: GlobalScheduleBody, @CurrentUser() user: AuthUser) {
    this.assertUnrestricted(user);
    assertPayload(body.action, body.command);
    assertValidCron(body.cron);
    const allServers = body.allServers ?? false;
    const serverIds = body.serverIds ?? [];
    await this.assertTargets(allServers, serverIds);
    const created = await this.prisma.globalSchedule.create({
      data: {
        name: body.name,
        cron: body.cron,
        action: body.action,
        command: RCON_SCHEDULE_ACTIONS.has(body.action) ? body.command!.trim() : null,
        warnMinutes: body.warnMinutes ?? 10,
        enabled: body.enabled ?? true,
        minPlayersOnline: body.minPlayersOnline ?? null,
        maxPlayersOnline: body.maxPlayersOnline ?? null,
        runAt: body.runAt ? parseRunAt(body.runAt) : null,
        allServers,
        staggerMinutes: body.staggerMinutes ?? 0,
        servers: { connect: serverIds.map((id) => ({ id })) },
      },
      include: withServers,
    });
    if (created.enabled && !created.runAt) {
      await this.scheduler.registerGlobalWithTimezone(created.id, created.cron);
    }
    return view(created);
  }

  @Patch(":id")
  async update(@Param("id") id: string, @Body() body: GlobalSchedulePatchBody, @CurrentUser() user: AuthUser) {
    this.assertUnrestricted(user);
    const current = await this.prisma.globalSchedule.findUnique({ where: { id }, include: withServers });
    if (!current) throw new NotFoundException("Schedule not found");
    const action = body.action ?? current.action;
    const command = body.command !== undefined ? body.command : current.command ?? undefined;
    assertPayload(action, command);
    if (body.cron !== undefined) assertValidCron(body.cron);
    const { serverIds, runAt, ...rest } = body;
    if (body.allServers !== undefined || serverIds !== undefined) {
      await this.assertTargets(body.allServers ?? current.allServers, serverIds ?? current.servers.map((s) => s.id));
    }
    const updated = await this.prisma.globalSchedule.update({
      where: { id },
      data: {
        ...rest,
        runAt: runAt === undefined ? undefined : runAt === null ? null : parseRunAt(runAt),
        // The one-shot poll only picks unfired rows, so a re-timed one must look unfired.
        ...(runAt ? { lastRunAt: null } : {}),
        ...(body.action !== undefined || body.command !== undefined
          ? { command: RCON_SCHEDULE_ACTIONS.has(action) ? command!.trim() : null }
          : {}),
        ...(serverIds ? { servers: { set: serverIds.map((s) => ({ id: s })) } } : {}),
      },
      include: withServers,
    });
    this.scheduler.unregisterGlobal(id);
    if (updated.enabled && !updated.runAt) {
      await this.scheduler.registerGlobalWithTimezone(id, updated.cron);
    }
    return view(updated);
  }

  @Delete(":id")
  async remove(@Param("id") id: string, @CurrentUser() user: AuthUser) {
    this.assertUnrestricted(user);
    const row = await this.prisma.globalSchedule.findUnique({ where: { id }, select: { id: true } });
    if (!row) throw new NotFoundException("Schedule not found");
    this.scheduler.unregisterGlobal(id);
    await this.prisma.globalSchedule.delete({ where: { id } });
    return { ok: true };
  }

  private assertUnrestricted(user: AuthUser): void {
    if (!AccessService.unrestricted(user)) {
      throw new ForbiddenException("Global schedules reach every server, so they need an unrestricted account");
    }
  }

  private async assertTargets(allServers: boolean, serverIds: string[]): Promise<void> {
    if (allServers) return;
    if (serverIds.length === 0) throw new BadRequestException("Pick at least one server");
    const found = await this.prisma.server.count({ where: { id: { in: serverIds } } });
    if (found !== new Set(serverIds).size) throw new NotFoundException("Server not found");
  }
}
