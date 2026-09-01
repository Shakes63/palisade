import { Injectable, Logger, OnModuleInit, BadRequestException } from "@nestjs/common";
import * as cron from "node-cron";
import { EventType } from "@ark/shared";
import { PrismaService } from "../prisma/prisma.service";
import { EventsService } from "../events/events.service";
import { ServersService } from "../servers/servers.service";
import { RconService } from "../rcon/rcon.service";
import { BackupsService } from "../backups/backups.service";
import { ManagerSettingsService } from "../manager-settings/manager-settings.service";
import { PlayersService } from "../players/players.service";
import { UpdatesService } from "../updates/updates.service";
import { ModUpdatesService } from "../modupdates/modupdates.service";

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
    private readonly backups: BackupsService,
    private readonly settings: ManagerSettingsService,
    private readonly players: PlayersService,
    private readonly updates: UpdatesService,
    private readonly modUpdates: ModUpdatesService,
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

    // "update-if-available" is an update that first checks Steam for a newer
    // build — no players warned, no downtime, no backup churn when already
    // current. Unknown (non-Steam game / API down) falls through to updating,
    // so the schedule can never go permanently dead on a detection failure.
    let action = sched.action;
    if (action === "update-if-available") {
      const outdated = await this.updates.isOutdated(sched.serverId).catch(() => null);
      if (outdated === false) {
        await this.events.emit({
          type: EventType.ScheduleFired,
          message: `Schedule "${sched.name}" skipped — already on the latest build`,
          serverId: sched.serverId,
        });
        return;
      }
      action = "update";
    }

    // "update-mods" only disrupts if there's actually something to update — check
    // first so a nightly schedule doesn't warn players + snapshot + restart for
    // nothing. A source hiccup (null) falls through to updating, so the schedule
    // can't go permanently dead on a detection failure.
    if (action === "update-mods") {
      const pending = await this.modUpdates.status(sched.serverId).catch(() => null);
      if (pending && pending.count === 0) {
        await this.events.emit({
          type: EventType.ScheduleFired,
          message: `Schedule "${sched.name}" skipped — mods already up to date`,
          serverId: sched.serverId,
        });
        return;
      }
    }

    const disruptive = ["restart", "update", "update-mods", "stop"].includes(action);
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
        await this.backups.create(sched.serverId, `pre-${action}`).catch(() => undefined);
      }
      switch (action) {
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
          // The same path as the UI's "Update game" button. It arms the one-shot
          // update flag for the images whose updater the manager disables, restarts
          // only if the server was up, and leaves a stopped server to update on its
          // next start, so a scheduled update and a clicked one can't drift apart.
          // Replaces a stop → installGame → start dance that ran a whole install job
          // to achieve what the one-shot flag does on its own.
          await this.servers.updateGame(sched.serverId);
          break;
        case "update-mods": {
          // Apply pending mod updates (files/config on disk), then restart to load
          // them if the server was up. updateAll owns the was-it-running decision.
          const result = await this.modUpdates.updateAll(sched.serverId);
          if (result.restartNeeded) await this.servers.restart(sched.serverId);
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
