import { Injectable, Logger, OnModuleInit, BadRequestException } from "@nestjs/common";
import * as cron from "node-cron";
import {
  describePlayerCondition,
  EventType,
  RCON_SCHEDULE_ACTIONS,
  type Game,
  ServerState,
} from "@ark/shared";
import type { Schedule } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { EventsService } from "../events/events.service";
import { ServersService } from "../servers/servers.service";
import { RCON_GAMES, RconService } from "../rcon/rcon.service";
import { BackupsService } from "../backups/backups.service";
import { ManagerSettingsService } from "../manager-settings/manager-settings.service";
import { PlayersService } from "../players/players.service";
import { UpdatesService } from "../updates/updates.service";
import { MOD_UPDATE_GAMES, ModUpdatesService } from "../modupdates/modupdates.service";
import { HistoryService } from "../servers/history.service";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ONE_SHOT_POLL_MS = 60_000;
// A one-time schedule still fires if the manager was briefly down at its moment,
// but only within this window — beyond it, it's stale and marked missed.
const ONE_SHOT_GRACE_MS = 60 * 60_000;

/** Shared with the controller so an edit is rejected BEFORE it reaches the
 *  database. A stored-but-unparseable cron used to survive its own 400 and then
 *  break the next boot (GH #99). */
export function assertValidCron(expr: string): void {
  if (!cron.validate(expr)) throw new BadRequestException(`Invalid cron: ${expr}`);
}

/** Whether a server of this game can run the action at all. */
export function supportsAction(game: Game, action: string): boolean {
  if (RCON_SCHEDULE_ACTIONS.has(action)) return RCON_GAMES.has(game);
  if (action === "update-mods") return MOD_UPDATE_GAMES.has(game);
  return true;
}

/** What one firing on one server needs; a global schedule supplies it per target. */
type Firing = Pick<
  Schedule,
  | "name"
  | "action"
  | "command"
  | "warnMinutes"
  | "minPlayersOnline"
  | "maxPlayersOnline"
  | "conditionHeldMinutes"
  | "runAt"
  | "serverId"
>;

const globalKey = (id: string) => `global:${id}`;

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
    private readonly history: HistoryService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.registerAll();
    await this.disableInterruptedOneShots();
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
    const globals = await this.prisma.globalSchedule.findMany({ where: { enabled: true, runAt: null } });
    let registered = 0;
    for (const s of [...enabled, ...globals.map((g) => ({ ...g, serverId: null }))]) {
      try {
        if (s.serverId === null) this.registerGlobal(s.id, s.cron, tz);
        else this.register(s.id, s.cron, tz);
        registered++;
      } catch {
        // This runs inside onModuleInit, so a throw here used to exit the container
        // and keep it down until someone edited SQLite by hand — one bad row took
        // every other schedule with it (GH #99). Databases written before the
        // controller started validating can still hold one, so quarantine it here.
        await this.quarantine(s);
      }
    }
    this.logger.log(`Registered ${registered} recurring schedule(s) (tz ${tz})`);
  }

  /** Park a schedule whose cron can't be parsed. Disabled rather than merely
   *  skipped: it can never fire, and leaving it "enabled" in the panel would show
   *  a schedule that looks armed and silently never runs. The event is how the
   *  operator finds out, since the edit that broke it may have been long ago. */
  private async quarantine(s: { id: string; name: string; cron: string; serverId: string | null }): Promise<void> {
    this.logger.warn(`Schedule "${s.name}" (${s.id}) disabled — invalid cron: ${s.cron}`);
    await this.disable(s);
    await this.events
      .emit({
        type: EventType.Warning,
        message: `Schedule "${s.name}" was disabled — "${s.cron}" isn't a valid cron expression.`,
        serverId: s.serverId,
      })
      .catch(() => undefined);
  }

  /** A one-shot stamped as fired but still enabled was cut off by a manager restart
   *  (completion disables it), e.g. mid-stagger. It can never fire again, so park it
   *  and say so rather than leave it looking armed. */
  private async disableInterruptedOneShots(): Promise<void> {
    const where = { enabled: true, runAt: { not: null }, lastRunAt: { not: null } };
    const rows = [
      ...(await this.prisma.schedule.findMany({ where })),
      ...(await this.prisma.globalSchedule.findMany({ where })).map((g) => ({ ...g, serverId: null })),
    ];
    for (const s of rows) {
      await this.disable(s);
      await this.events.emit({
        type: EventType.Warning,
        message: `One-time schedule "${s.name}" was interrupted by a manager restart, so it was switched off. Anything it hadn't reached yet did not run.`,
        serverId: s.serverId,
      });
    }
  }

  /** Fire any one-time schedules whose moment has arrived (within the grace window),
   *  then disable them so they never run again. */
  private oneShotBusy = false;
  private async fireDueOneShots(): Promise<void> {
    if (this.oneShotBusy) return;
    this.oneShotBusy = true;
    try {
      const now = new Date();
      const where = { enabled: true, lastRunAt: null, runAt: { not: null, lte: now } };
      const due = [
        ...(await this.prisma.schedule.findMany({ where })),
        ...(await this.prisma.globalSchedule.findMany({ where })).map((g) => ({ ...g, serverId: null })),
      ];
      for (const s of due) {
        const runAt = s.runAt as Date;
        if (now.getTime() - runAt.getTime() > ONE_SHOT_GRACE_MS) {
          await this.disable(s);
          await this.events.emit({
            type: EventType.Warning,
            message: `One-time schedule "${s.name}" was missed — the manager wasn't running at ${runAt.toLocaleString()}.`,
            serverId: s.serverId,
          });
          continue;
        }
        // fire() stamps lastRunAt up front (so the next poll skips it), runs the
        // action, then we disable it so a one-shot is truly one-time. A row re-timed
        // while it ran has a new runAt and must stay armed.
        void (s.serverId === null ? this.fireGlobal(s.id) : this.fire(s.id)).finally(() =>
          this.disable(s, runAt),
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
    this.arm(scheduleId, expr, timezone, () => this.fire(scheduleId));
  }

  unregister(scheduleId: string): void {
    const t = this.tasks.get(scheduleId);
    if (t) {
      t.stop();
      this.tasks.delete(scheduleId);
    }
  }

  async registerGlobalWithTimezone(id: string, expr: string): Promise<void> {
    this.registerGlobal(id, expr, await this.settings.getTimezone());
  }

  registerGlobal(id: string, expr: string, timezone: string): void {
    this.arm(globalKey(id), expr, timezone, () => this.fireGlobal(id));
  }

  unregisterGlobal(id: string): void {
    this.unregister(globalKey(id));
  }

  private arm(key: string, expr: string, timezone: string, run: () => Promise<void>): void {
    assertValidCron(expr);
    this.unregister(key);
    this.tasks.set(key, cron.schedule(expr, () => void run(), { timezone }));
  }

  private async disable(s: { id: string; serverId: string | null }, onlyIfRunAt?: Date): Promise<void> {
    const data = { enabled: false };
    if (onlyIfRunAt) {
      const where = { id: s.id, runAt: onlyIfRunAt };
      await (s.serverId === null
        ? this.prisma.globalSchedule.updateMany({ where, data })
        : this.prisma.schedule.updateMany({ where, data })
      ).catch(() => undefined);
      return;
    }
    await (s.serverId === null
      ? this.prisma.globalSchedule.update({ where: { id: s.id }, data })
      : this.prisma.schedule.update({ where: { id: s.id }, data })
    ).catch(() => undefined);
  }

  /** The servers a global schedule runs on right now, minus those whose game
   *  can't run its action, so an "all servers" announce skips the consoleless. */
  async globalTargets(g: { allServers: boolean; action: string; servers?: { id: string }[] }) {
    const servers = await this.prisma.server.findMany({
      where: g.allServers ? undefined : { id: { in: (g.servers ?? []).map((s) => s.id) } },
      select: { id: true, game: true },
      orderBy: { name: "asc" },
    });
    return servers.filter((s) => supportsAction(s.game as Game, g.action)).map((s) => s.id);
  }

  private async fireGlobal(id: string): Promise<void> {
    const g = await this.prisma.globalSchedule.findUnique({ where: { id }, include: { servers: { select: { id: true } } } });
    if (!g || !g.enabled) return;
    await this.prisma.globalSchedule.update({ where: { id }, data: { lastRunAt: new Date() } });
    const targets = await this.globalTargets(g);
    await Promise.all(
      targets.map(async (serverId, i) => {
        if (i > 0 && g.staggerMinutes > 0) {
          await sleep(i * g.staggerMinutes * 60_000);
          // Turning it off or re-timing it mid-stagger stops the servers still waiting.
          const still = await this.prisma.globalSchedule.findUnique({
            where: { id },
            select: { enabled: true, runAt: true },
          });
          if (!still?.enabled || still.runAt?.getTime() !== g.runAt?.getTime()) return;
        }
        await this.events.emit({
          type: EventType.ScheduleFired,
          message: `Global schedule "${g.name}" fired (${g.action})`,
          serverId,
        });
        await this.run({ ...g, serverId });
      }),
    );
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
    await this.run(sched);
  }

  private async run(sched: Firing): Promise<void> {
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

    // "announce" and "command" talk to a live server over RCON, so both need a
    // payload and something on the other end to receive it.
    if (RCON_SCHEDULE_ACTIONS.has(action)) {
      if (!sched.command?.trim()) {
        await this.events.emit({
          type: EventType.Warning,
          message: `Schedule "${sched.name}" has no ${action === "announce" ? "message" : "command"} to send`,
          serverId: sched.serverId,
        });
        return;
      }
      // Only Running, not Starting: RCON isn't up until the server is. Skipping
      // beats erroring, because rcon.exec throws when it can't connect and fire()
      // turns that into an Error event — an hourly announcement on a server that's
      // down overnight would post eight failures before breakfast. A one-time
      // schedule is consumed either way, same as the players-online guard below,
      // so say so rather than leave it looking delivered.
      const state = await this.prisma.server
        .findUnique({ where: { id: sched.serverId }, select: { state: true } })
        .catch(() => null);
      if (state?.state !== ServerState.Running) {
        await this.events.emit({
          type: sched.runAt ? EventType.Warning : EventType.ScheduleFired,
          message: `Schedule "${sched.name}" skipped — the server isn't running${
            sched.runAt ? ", and a one-time schedule doesn't run again" : ""
          }`,
          serverId: sched.serverId,
        });
        return;
      }
    }

    const disruptive = ["restart", "update", "update-mods", "stop"].includes(action);
    try {
      // The player-count condition gates EVERY action (GH #97): "announce only
      // when 10+ are on" is as much a use for it as "don't restart a busy server".
      // Recurring schedules just try again next time; a one-shot is consumed.
      const condition = describePlayerCondition(
        sched.minPlayersOnline,
        sched.maxPlayersOnline,
        sched.conditionHeldMinutes,
      );
      if (condition) {
        const holds = (online: number) =>
          (sched.minPlayersOnline === null || online >= sched.minPlayersOnline) &&
          (sched.maxPlayersOnline === null || online <= sched.maxPlayersOnline);
        const players = await this.players.count(sched.serverId).catch(() => null);
        const online = players?.online ?? null;
        // A count that can't be read never blocks the firing, same as the flag this
        // replaced: failing closed would leave a schedule permanently dead whenever
        // the query port is unreachable.
        if (online !== null && !holds(online)) {
          await this.events.emit({
            type: EventType.ScheduleFired,
            message: `Schedule "${sched.name}" skipped — ${online} player${online === 1 ? "" : "s"} online, but it only runs when ${condition}`,
            serverId: sched.serverId,
          });
          return;
        }
        // Unlike an unreadable count, missing history does block: a server that came
        // up a minute ago hasn't been empty for ten.
        if (sched.conditionHeldMinutes > 0 && !(await this.conditionHeld(sched, holds))) {
          await this.events.emit({
            type: EventType.ScheduleFired,
            message: `Schedule "${sched.name}" skipped — it only runs when ${condition}, and that hasn't held long enough yet`,
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
        case "announce":
          await this.rcon.broadcast(sched.serverId, sched.command!);
          break;
        case "command":
          await this.rcon.exec(sched.serverId, sched.command!);
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

  private async conditionHeld(sched: Firing, holds: (online: number) => boolean): Promise<boolean> {
    const server = await this.prisma.server
      .findUnique({ where: { id: sched.serverId }, select: { runningSince: true } })
      .catch(() => null);
    return this.history.playerCountHeld(
      sched.serverId,
      sched.conditionHeldMinutes,
      holds,
      server?.runningSince ?? null,
    );
  }

  /** Broadcast a shrinking countdown to players before a disruptive action. A game
   *  without a console can't be warned, so the action runs without waiting. */
  private async warnCountdown(serverId: string, minutes: number): Promise<void> {
    if (minutes <= 0) return;
    const server = await this.prisma.server.findUnique({ where: { id: serverId }, select: { game: true } });
    if (!server || !RCON_GAMES.has(server.game as Game)) return;
    for (let m = minutes; m > 0; m--) {
      await this.rcon
        .broadcast(serverId, `Server action in ${m} minute${m === 1 ? "" : "s"}...`)
        .catch(() => undefined);
      await sleep(60_000);
    }
  }
}
