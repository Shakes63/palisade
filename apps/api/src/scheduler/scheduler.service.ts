import { Injectable, Logger, OnModuleInit, BadRequestException } from "@nestjs/common";
import * as cron from "node-cron";
import { EventType } from "@ark/shared";
import { PrismaService } from "../prisma/prisma.service";
import { EventsService } from "../events/events.service";
import { ServersService } from "../servers/servers.service";
import { RconService } from "../rcon/rcon.service";
import { InstallerService } from "../installer/installer.service";
import { BackupsService } from "../backups/backups.service";
import { ManagerSettingsService } from "../manager-settings/manager-settings.service";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  ) {}

  async onModuleInit(): Promise<void> {
    await this.registerAll();
  }

  /** (Re)register all enabled schedules using the in-app timezone. Called on boot
   *  and whenever the timezone setting changes. */
  async registerAll(): Promise<void> {
    for (const id of [...this.tasks.keys()]) this.unregister(id);
    const tz = await this.settings.getTimezone();
    const enabled = await this.prisma.schedule.findMany({ where: { enabled: true } });
    for (const s of enabled) this.register(s.id, s.cron, tz);
    this.logger.log(`Registered ${enabled.length} schedule(s) (tz ${tz})`);
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
        case "update":
          await this.servers.stop(sched.serverId).catch(() => undefined);
          await this.installer.install(
            (await this.prisma.server.findUnique({ where: { id: sched.serverId } }))!.game as never,
            { serverId: sched.serverId },
          );
          break;
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
