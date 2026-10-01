import { Injectable, OnModuleInit } from "@nestjs/common";
import { LIVE_STATES, MAX_CONDITION_HELD_MINUTES } from "@ark/shared";
import { PrismaService } from "../prisma/prisma.service";
import { DockerService } from "../docker/docker.service";
import { PlayersService } from "../players/players.service";

/** One 30-second sample of a live server. */
export interface HistorySample {
  at: string; // ISO timestamp
  cpuPercent: number | null;
  memUsedMb: number | null;
  playersOnline: number | null;
}

const SAMPLE_MS = 30_000;
// 1 hour at 30 s, plus headroom so a schedule's longest held condition sees its whole window.
const MAX_SAMPLES = (MAX_CONDITION_HELD_MINUTES * 60_000) / SAMPLE_MS + 4;
// Wider than one sampling round (which runs serially over every live server); a longer
// silence means the server wasn't live or the manager was down.
const MAX_GAP_MS = 3 * SAMPLE_MS;

/**
 * Whether `holds` was true of the player count for the whole `minutes` up to `now`.
 * The window must lie inside the current run, so boot time and an earlier run never
 * count towards it; an unreadable count neither proves nor breaks it, so a game
 * that reports no players is judged on uptime alone.
 */
export function playerCountHeld(
  samples: HistorySample[],
  minutes: number,
  holds: (online: number) => boolean,
  runningSince: Date | null,
  now = Date.now(),
): boolean {
  const since = now - minutes * 60_000;
  if (!runningSince || runningSince.getTime() > since) return false;
  let later = now;
  for (const { at: iso, playersOnline: online } of [...samples].reverse()) {
    const at = Date.parse(iso);
    if (later - at > MAX_GAP_MS) return false;
    if (online !== null && !holds(online)) return false;
    if (at <= since) return true;
    later = at;
  }
  return false;
}

/**
 * In-memory resource/player history for live servers — enough to answer "was it
 * struggling before the crash" and "when do people actually play" with sparklines,
 * without a time-series DB. One ring buffer per server, sampled every 30 s while
 * the server is live; buffers survive stops (so a crashed server's tail is
 * visible) but not manager restarts.
 */
@Injectable()
export class HistoryService implements OnModuleInit {
  private readonly buffers = new Map<string, HistorySample[]>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly docker: DockerService,
    private readonly players: PlayersService,
  ) {}

  onModuleInit(): void {
    setInterval(() => void this.sample(), SAMPLE_MS).unref?.();
  }

  get(serverId: string): HistorySample[] {
    return this.buffers.get(serverId) ?? [];
  }

  playerCountHeld(
    serverId: string,
    minutes: number,
    holds: (online: number) => boolean,
    runningSince: Date | null,
  ): boolean {
    return playerCountHeld(this.get(serverId), minutes, holds, runningSince);
  }

  private async sample(): Promise<void> {
    const live = await this.prisma.server
      .findMany({ where: { state: { in: LIVE_STATES } } })
      .catch(() => []);
    for (const s of live) {
      const stats = s.containerId ? await this.docker.stats(s.containerId).catch(() => null) : null;
      const players = await this.players.count(s.id).catch(() => null);
      const buf = this.buffers.get(s.id) ?? [];
      buf.push({
        at: new Date().toISOString(),
        cpuPercent: stats?.cpuPercent ?? null,
        memUsedMb: stats?.memUsedMb ?? null,
        playersOnline: players?.online ?? null,
      });
      if (buf.length > MAX_SAMPLES) buf.splice(0, buf.length - MAX_SAMPLES);
      this.buffers.set(s.id, buf);
    }
  }
}
