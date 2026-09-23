"use client";
import { useEffect, useState } from "react";
import { Activity, Cpu, MemoryStick, HardDrive, Users } from "lucide-react";
import { ServerState, type ServerStatsDetail } from "@ark/shared";
import { apiGet } from "@/lib/api";
import { Sparkline } from "@/components/sparkline";

interface HistorySample {
  at: string;
  cpuPercent: number | null;
  memUsedMb: number | null;
  playersOnline: number | null;
}

const POLL_MS = 4000;
const fmt = (mb: number | null | undefined) =>
  mb == null ? "—" : mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`;

/** Live CPU / memory / disk for a server, with whole-machine totals for context.
 *  Polls while Starting/Running (paused when the tab is hidden). */
export function ResourcesPanel({ serverId, state }: { serverId: string; state: ServerState }) {
  const [stats, setStats] = useState<ServerStatsDetail | null>(null);
  const [history, setHistory] = useState<HistorySample[]>([]);

  // History sparklines refresh at the sampler's own cadence (30 s).
  useEffect(() => {
    const tick = () =>
      apiGet<{ samples: HistorySample[] }>(`/servers/${serverId}/history`)
        .then(({ samples }) => setHistory(samples))
        .catch(() => undefined);
    void tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, [serverId]);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (document.hidden) return;
      try {
        const s = await apiGet<ServerStatsDetail>(`/servers/${serverId}/stats`);
        if (!cancelled) setStats(s);
      } catch {
        /* silent — don't surface poll errors */
      }
    };
    void tick();
    // Boot is the heaviest period, so poll while Starting as well as Running.
    const liveState = state === ServerState.Running || state === ServerState.Starting;
    const id = liveState ? setInterval(() => void tick(), POLL_MS) : null;
    const onVisible = () => {
      if (!document.hidden) void tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      if (id) clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [serverId, state]);

  const liveState = state === ServerState.Running || state === ServerState.Starting;
  const live = stats?.live ?? false; // container is up and reporting CPU/memory
  const host = stats?.host;
  const memPct =
    stats?.memUsedMb != null && stats?.memLimitMb
      ? Math.min(100, (stats.memUsedMb / stats.memLimitMb) * 100)
      : 0;
  const memHot = memPct >= 90;
  const diskFreePct = host && host.diskTotalMb ? (host.diskFreeMb / host.diskTotalMb) * 100 : 100;
  // Several minutes of CPU samples and never a player count: this game doesn't report one.
  const noPlayerCounts =
    history.filter((s) => s.cpuPercent != null).length >= 4 && history.every((s) => s.playersOnline == null);

  return (
    <div className="card">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-ark-accent" />
          <h3 className="text-sm font-semibold uppercase tracking-wide text-ark-accent2">Resources</h3>
        </div>
        {liveState && <span className="text-xs text-slate-500">live · every {POLL_MS / 1000}s</span>}
      </div>
      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <Metric
            icon={<Users className="h-4 w-4" />}
            label="Players online"
            value={live && stats?.playersOnline != null ? String(stats.playersOnline) : "—"}
            sub={stats?.playersMax != null ? `of ${stats.playersMax} slots` : undefined}
          />
          {history.length > 1 && (
            <Sparkline
              points={history.map((s) => ({ at: s.at, value: s.playersOnline }))}
              emptyLabel={noPlayerCounts ? "not available for this game" : undefined}
            />
          )}
        </div>
        <div>
          <Metric
            icon={<Cpu className="h-4 w-4" />}
            label="CPU (this server)"
            value={live && stats?.cpuPercent != null ? `${stats.cpuPercent}%` : "—"}
            sub={host?.cpuPercent != null ? `machine ${host.cpuPercent}%` : undefined}
          />
          {history.length > 1 && (
            <Sparkline
              points={history.map((s) => ({ at: s.at, value: s.cpuPercent }))}
              format={(v) => `${Math.round(v)}%`}
            />
          )}
        </div>
        <div>
          <Metric
            icon={<MemoryStick className="h-4 w-4" />}
            label="Memory (this server)"
            value={live && stats?.memUsedMb != null ? `${fmt(stats.memUsedMb)} / ${fmt(stats.memLimitMb)}` : "—"}
            sub={host ? `machine ${fmt(host.memUsedMb)} / ${fmt(host.memTotalMb)}` : undefined}
          />
          {live && stats?.memUsedMb != null && (
            <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-700/60">
              <div
                className={`h-full rounded-full ${memHot ? "bg-red-400" : "bg-ark-accent"}`}
                style={{ width: `${memPct}%` }}
              />
            </div>
          )}
          {history.length > 1 && (
            <Sparkline points={history.map((s) => ({ at: s.at, value: s.memUsedMb }))} format={fmt} />
          )}
        </div>
        <Metric
          icon={<HardDrive className="h-4 w-4" />}
          label="Disk (this server)"
          value={fmt(stats?.diskUsedMb)}
          sub={host ? `${fmt(host.diskFreeMb)} free of ${fmt(host.diskTotalMb)}` : undefined}
          subHot={diskFreePct < 10}
        />
      </div>
      {!live && (
        <p className="mt-3 text-xs text-slate-500">
          {liveState && stats === null ? "Loading live stats…" : "CPU and memory show while the server is up."}
        </p>
      )}
    </div>
  );
}

function Metric({
  icon,
  label,
  value,
  sub,
  subHot,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
  subHot?: boolean;
}) {
  return (
    <div>
      <div className="flex items-center gap-1.5 text-xs text-slate-400">
        {icon} {label}
      </div>
      <div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
      {sub && (
        <div className={`mt-0.5 text-xs tabular-nums ${subHot ? "text-red-400" : "text-slate-500"}`}>
          {sub}
        </div>
      )}
    </div>
  );
}
