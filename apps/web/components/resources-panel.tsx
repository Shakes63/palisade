"use client";
import { useEffect, useState } from "react";
import { Cpu, MemoryStick, HardDrive, Users } from "lucide-react";
import { ServerState, type ServerStatsDetail } from "@ark/shared";
import { apiGet } from "@/lib/api";

const POLL_MS = 4000;
const fmt = (mb: number | null | undefined) =>
  mb == null ? "—" : mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`;

/** Live CPU / memory / disk for a server, with whole-machine totals for context.
 *  Polls while Starting/Running (paused when the tab is hidden). */
export function ResourcesPanel({ serverId, state }: { serverId: string; state: ServerState }) {
  const [stats, setStats] = useState<ServerStatsDetail | null>(null);

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

  return (
    <div className="card">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-300">Resources</h3>
        {liveState && <span className="text-xs text-slate-500">live · every {POLL_MS / 1000}s</span>}
      </div>
      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
        <Metric
          icon={<Users className="h-4 w-4" />}
          label="Players online"
          value={live && stats?.playersOnline != null ? String(stats.playersOnline) : "—"}
          sub={stats?.playersMax != null ? `of ${stats.playersMax} slots` : undefined}
        />
        <Metric
          icon={<Cpu className="h-4 w-4" />}
          label="CPU (this server)"
          value={live && stats?.cpuPercent != null ? `${stats.cpuPercent}%` : "—"}
          sub={host?.cpuPercent != null ? `machine ${host.cpuPercent}%` : undefined}
        />
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
        <p className="mt-3 text-xs text-slate-500">CPU and memory show while the server is up.</p>
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
