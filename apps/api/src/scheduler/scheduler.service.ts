import { Injectable, Logger, OnModuleInit, BadRequestException } from "@nestjs/common";
import * as cron from "node-cron";
import { EventType, ServerState, Game } from "@ark/shared";
import { PrismaService } from "../prisma/prisma.service";
import { EventsService } from "../events/events.service";
import { ServersService } from "../servers/servers.service";
import { RconService } from "../rcon/rcon.service";
import { InstallerService } from "../installer/installer.service";
import { BackupsService } from "../backups/backups.service";
import { ManagerSettingsService } from "../manager-settings/manager-settings.service";
import { PlayersService } from "../players/players.service";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ONE_SHOT_POLL_MS = 60_000;
// A one-time schedule still fires if the manager was briefly down at its moment,
// but only within this window — beyond it, it's stale and marked missed.
const ONE_SHOT_GRACE_MS = 60 * 60_000;

@Injectable()
export class SchedulerService implements OnModuleInit {
  private readonly logger = new Logger(SchedulerService.name);
  private readonly tasks = new Map<string, cron.ScheduledTask>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsService,
    private readonly servers: ServersService,
    private readonly rcon: RconService,
    private readonly installer: InstallerService,
    private readonly backups: BackupsService,
    private readonly settings: ManagerSettingsService,
    private readonly players: PlayersService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.registerAll();
    // One-time schedules can't be expressed as cron; a poll fires them (and catches
    // up any whose moment passed while the manager was briefly down).
    setInterval(() => void this.fireDueOneShots(), ONE_SHOT_POLL_MS).unref?.();
    void this.fireDueOneShots();
  }

  /** (Re)register all enabled RECURRING schedules using the in-app timezone. Called
   *  on boot and whenever the timezone setting changes. One-time (runAt) schedules
   *  are driven by the poll, not cron, so they're excluded here. */
  async registerAll(): Promise<void> {
    for (const id of [...this.tasks.keys()]) this.unregister(id);
    const tz = await this.settings.getTimezone();
    const enabled = await this.prisma.schedule.findMany({ where: { enabled: true, runAt: null } });
    for (const s of enabled) this.register(s.id, s.cron, tz);
    this.logger.log(`Registered ${enabled.length} recurring schedule(s) (tz ${tz})`);
  }

  /** Fire any one-time schedules whose moment has arrived (within the grace window),
   *  then disable them so they never run again. */
  private oneShotBusy = false;
  private async fireDueOneShots(): Promise<void> {
    if (this.oneShotBusy) return;
    this.oneShotBusy = true;
    try {
      const now = new Date();
      const due = await this.prisma.schedule.findMany({
        where: { enabled: true, lastRunAt: null, runAt: { not: null, lte: now } },
      });
      for (const s of due) {
        const runAt = s.runAt as Date;
        if (now.getTime() - runAt.getTime() > ONE_SHOT_GRACE_MS) {
          await this.prisma.schedule
            .update({ where: { id: s.id }, data: { enabled: false } })
            .catch(() => undefined);
          await this.events.emit({
            type: EventType.Warning,
            message: `One-time schedule "${s.name}" was missed — the manager wasn't running at ${runAt.toLocaleString()}.`,
            serverId: s.serverId,
          });
          continue;
        }
        // fire() stamps lastRunAt up front (so the next poll skips it), runs the
        // action, then we disable it so a one-shot is truly one-time.
        void this.fire(s.id).finally(() =>
          this.prisma.schedule
            .update({ where: { id: s.id }, data: { enabled: false } })
            .catch(() => undefined),
        );
      }
    } finally {
      this.oneShotBusy = false;
    }
  }

  /** Register one schedule using the currently-configured timezone. */
  async registerWithTimezone(scheduleId: string, expr: string): Promise<void> {
    this.register(scheduleId, expr, await this.settings.getTimezone());
  }

  register(scheduleId: string, expr: string, timezone: string): void {
    if (!cron.validate(expr)) throw new BadRequestException(`Invalid cron: ${expr}`);
    this.unregister(scheduleId);
    const task = cron.schedule(expr, () => void this.fire(scheduleId), { timezone });
    this.tasks.set(scheduleId, task);
  }

  unregister(scheduleId: string): void {
    const t = this.tasks.get(scheduleId);
    if (t) {
      t.stop();
      this.tasks.delete(scheduleId);
    }
  }

  /** Execute a schedule's action with warnings + pre-action snapshot. */
  private async fire(scheduleId: string): Promise<void> {
    const sched = await this.prisma.schedule.findUnique({ where: { id: scheduleId } });
    if (!sched || !sched.enabled) return;
    await this.prisma.schedule.update({
      where: { id: scheduleId },
      data: { lastRunAt: new Date() },
    });
    await this.events.emit({
      type: EventType.ScheduleFired,
      message: `Schedule "${sched.name}" fired (${sched.action})`,
      serverId: sched.serverId,
    });

    const disruptive = ["restart", "update", "stop"].includes(sched.action);
    try {
      if (disruptive && sched.skipIfPlayersOnline) {
        // Don't interrupt a live session: skip this firing when anyone is online.
        // Recurring schedules just try again next time; a one-shot is consumed.
        const players = await this.players.count(sched.serverId).catch(() => null);
        if ((players?.online ?? 0) > 0) {
          await this.events.emit({
            type: EventType.ScheduleFired,
            message: `Schedule "${sched.name}" skipped — ${players!.online} player${players!.online === 1 ? "" : "s"} online`,
            serverId: sched.serverId,
          });
          return;
        }
      }
      if (disruptive) {
        await this.warnCountdown(sched.serverId, sched.warnMinutes);
        await this.backups.create(sched.serverId, `pre-${sched.action}`).catch(() => undefined);
      }
      switch (sched.action) {
        case "restart":
          await this.servers.restart(sched.serverId);
          break;
        case "stop":
          await this.servers.stop(sched.serverId);
          break;
        case "start":
          await this.servers.start(sched.serverId);
          break;
        case "backup":
          await this.backups.create(sched.serverId, "scheduled").catch(() => undefined);
          break;
        case "update": {
          const server = await this.prisma.server.findUnique({ where: { id: sched.serverId } });
          if (!server) break;
          // Only bring it back up if it was up — don't start a server the admin
          // had deliberately stopped.
          const wasUp = [ServerState.Running, ServerState.Starting].includes(
            server.state as ServerState,
          );
          await this.servers.stop(sched.serverId).catch(() => undefined);
          await this.installer.install(server.game as Game, { serverId: sched.serverId });
          if (wasUp) await this.servers.start(sched.serverId);
          break;
        }
      }
    } catch (err) {
      await this.events.emit({
        type: EventType.Error,
        message: `Schedule "${sched.name}" failed: ${(err as Error).message}`,
        serverId: sched.serverId,
      });
    }
  }

  /** Broadcast a shrinking countdown to players before a disruptive action. */
  private async warnCountdown(serverId: string, minutes: number): Promise<void> {
    for (let m = minutes; m > 0; m--) {
      await this.rcon
        .broadcast(serverId, `Server action in ${m} minute${m === 1 ? "" : "s"}...`)
        .catch(() => undefined);
      await sleep(60_000);
    }
  }
}
