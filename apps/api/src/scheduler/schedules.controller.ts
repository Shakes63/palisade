import {
  BadRequestException,
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
import { PartialType } from "@nestjs/mapped-types";
import { IsBoolean, IsDateString, IsIn, IsInt, IsOptional, IsString, Min } from "class-validator";
import { GAME_LABELS, RCON_SCHEDULE_ACTIONS, SCHEDULE_ACTIONS, type Game } from "@ark/shared";
import { PrismaService } from "../prisma/prisma.service";
import { SchedulerService, assertValidCron } from "./scheduler.service";
import { RCON_GAMES } from "../rcon/rcon.service";
import { MOD_UPDATE_GAMES } from "../modupdates/modupdates.service";
import { AccessService } from "../auth/access.service";
import { CurrentUser } from "../auth/current-user.decorator";
import type { AuthUser } from "../auth/auth-user";

class ScheduleBody {
  @IsString() serverId!: string;
  @IsString() name!: string;
  @IsString() cron!: string;
  @IsIn([...SCHEDULE_ACTIONS]) action!: string;
  /** RCON payload: the chat message for "announce", the raw console command for
   *  "command". Required by those two actions, ignored by the rest (GH #78). */
  @IsOptional() @IsString() command?: string;
  @IsOptional() @IsInt() @Min(0) warnMinutes?: number;
  @IsOptional() @IsBoolean() enabled?: boolean;
  /** Player-count condition (GH #97): run only while the number of players online
   *  is at least/at most this. Null or absent = unbounded on that side. Applies to
   *  every action, not just the disruptive ones. */
  @IsOptional() @IsInt() @Min(0) minPlayersOnline?: number | null;
  @IsOptional() @IsInt() @Min(0) maxPlayersOnline?: number | null;
  /** Set for a ONE-TIME schedule: ISO instant to fire once (cron then ignored).
   *  Null on PATCH turns a one-time schedule back into a recurring one. */
  @IsOptional() @IsDateString() runAt?: string | null;
}

/**
 * A patch is the same fields, all optional. It has to be a real class: declaring
 * the body as `Partial<ScheduleBody>` emitted `Object` as its design:paramtype,
 * which ValidationPipe skips, so every decorator above was dead on PATCH and an
 * unknown action sailed straight into the database (GH #99).
 */
export class SchedulePatchBody extends PartialType(ScheduleBody) {}

/** `new Date("garbage")` is an Invalid Date, which Prisma only rejects at write
 *  time as a 500; parse it here so a bad instant is a plain 400. */
function parseRunAt(iso: string): Date {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) throw new BadRequestException(`Invalid runAt: ${iso}`);
  return at;
}

/** An "announce"/"command" schedule with nothing to send would fire forever and do
 *  nothing, so it's rejected at the door rather than logged every firing. */
function assertPayload(action: string | undefined, command: string | undefined): void {
  if (!action || !RCON_SCHEDULE_ACTIONS.has(action)) return;
  if (!command?.trim()) {
    throw new BadRequestException(
      action === "announce" ? "A message to announce is required" : "A command to run is required",
    );
  }
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

  /** The actions this server's game can run, so the form never offers one that
   *  fails on every firing. */
  @Get("actions")
  async actions(@CurrentUser() user: AuthUser, @Query("serverId") serverId?: string) {
    if (!serverId) throw new BadRequestException("serverId is required");
    await this.access.assertServer(user, serverId);
    const game = await this.gameOf(serverId);
    return SCHEDULE_ACTIONS.filter((a) => this.supports(game, a));
  }

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
    assertPayload(body.action, body.command);
    await this.assertSupported(body.serverId, body.action);
    // Create had the same write-then-validate ordering as update: the row landed
    // and registerWithTimezone raised the 400 afterwards.
    assertValidCron(body.cron);
    const created = await this.prisma.schedule.create({
      data: {
        serverId: body.serverId,
        name: body.name,
        cron: body.cron,
        action: body.action,
        command: RCON_SCHEDULE_ACTIONS.has(body.action) ? body.command!.trim() : null,
        warnMinutes: body.warnMinutes ?? 10,
        enabled: body.enabled ?? true,
        minPlayersOnline: body.minPlayersOnline ?? null,
        maxPlayersOnline: body.maxPlayersOnline ?? null,
        runAt: body.runAt ? parseRunAt(body.runAt) : null,
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
    @Body() body: SchedulePatchBody,
    @CurrentUser() user: AuthUser,
  ) {
    const { serverId: current, action: currentAction, command: currentCommand } = await this.owned(
      id,
      user,
    );
    // Moving a schedule onto another server needs that server too.
    if (body.serverId && body.serverId !== current) await this.access.assertServer(user, body.serverId);
    // A patch can change the action, the payload, or neither, so validate the row
    // as it will be once merged rather than what arrived in the body.
    const action = body.action ?? currentAction;
    const command = body.command !== undefined ? body.command : currentCommand ?? undefined;
    assertPayload(action, command);
    const serverId = body.serverId ?? current;
    if (action !== currentAction || serverId !== current) await this.assertSupported(serverId, action);
    // Everything that can fail is checked before the write, so a rejected edit
    // leaves the row exactly as it was (GH #99).
    if (body.cron !== undefined) assertValidCron(body.cron);
    const data = {
      ...body,
      runAt: body.runAt === undefined ? undefined : body.runAt === null ? null : parseRunAt(body.runAt),
      // The one-shot poll only picks unfired rows, so a re-timed one must look unfired.
      ...(body.runAt ? { lastRunAt: null } : {}),
      // Switching away from announce/command leaves a stale payload behind otherwise.
      ...(body.action !== undefined || body.command !== undefined
        ? { command: RCON_SCHEDULE_ACTIONS.has(action) ? command!.trim() : null }
        : {}),
    };
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

  private async gameOf(serverId: string): Promise<Game> {
    const server = await this.prisma.server.findUnique({ where: { id: serverId }, select: { game: true } });
    if (!server) throw new NotFoundException("Server not found");
    return server.game as Game;
  }

  private supports(game: Game, action: string): boolean {
    if (RCON_SCHEDULE_ACTIONS.has(action)) return RCON_GAMES.has(game);
    if (action === "update-mods") return MOD_UPDATE_GAMES.has(game);
    return true;
  }

  private async assertSupported(serverId: string, action: string): Promise<void> {
    if (!RCON_SCHEDULE_ACTIONS.has(action) && action !== "update-mods") return;
    const game = await this.gameOf(serverId);
    if (this.supports(game, action)) return;
    throw new BadRequestException(
      action === "update-mods"
        ? `${GAME_LABELS[game]} has no mod updates to schedule`
        : `${GAME_LABELS[game]} has no remote console, so it can't run "${action}" schedules`,
    );
  }

  /** The schedule's server id, action and RCON payload, after checking the caller
   *  may see that server. A missing schedule and a hidden one both 404. */
  private async owned(
    id: string,
    user: AuthUser,
  ): Promise<{ serverId: string; action: string; command: string | null }> {
    const row = await this.prisma.schedule.findUnique({
      where: { id },
      select: { serverId: true, action: true, command: true },
    });
    if (!row) throw new NotFoundException("Schedule not found");
    await this.access.assertServer(user, row.serverId);
    return row;
  }
}
