"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Plus, Play, Square, Download, Settings2, Boxes, Loader2, RotateCw,
  Cpu, MemoryStick, HardDrive,
} from "lucide-react";
import {
  Game,
  ServerState,
  ASA_OFFICIAL_MAPS,
  ASE_OFFICIAL_MAPS,
  CONAN_OFFICIAL_MAPS,
  PALWORLD_OFFICIAL_MAPS,
  MINECRAFT_OFFICIAL_MAPS,
  GAME_LABELS,
  mapLabel,
  type ServerSummary,
  type ServerStatsById,
} from "@ark/shared";
import { apiGet, apiPost } from "@/lib/api";
import { useRealtime } from "@/lib/socket";
import { StateBadge } from "@/components/state-badge";
import { UpdateBadge } from "@/components/update-badge";
import { ConnectCommand } from "@/components/connect-command";
import { UnofficialListHelp } from "@/components/unofficial-list-help";
import { useStartGuard } from "@/components/start-guard";

interface ClusterLite {
  id: string;
  name: string;
}

export default function DashboardPage() {
  const [servers, setServers] = useState<ServerSummary[]>([]);
  const [clusters, setClusters] = useState<ClusterLite[]>([]);
  const [creating, setCreating] = useState(false);
  const [pending, setPending] = useState<Record<string, "install" | "start" | "stop" | "restart">>({});
  const [stats, setStats] = useState<Record<string, ServerStatsById>>({});

  const refresh = useCallback(() => {
    apiGet<ServerSummary[]>("/servers").then(setServers).catch(() => undefined);
    apiGet<ClusterLite[]>("/clusters").then(setClusters).catch(() => undefined);
  }, []);

  const { start: guardedStart, dialog: startDialog } = useStartGuard(refresh);
  const clusterName = (id?: string | null) => clusters.find((c) => c.id === id)?.name;

  useEffect(() => refresh(), [refresh]);
  useRealtime((msg) => {
    if (msg.topic === "server.state" || msg.topic === "event") refresh();
  });

  // Live per-card resource numbers; poll while the tab is visible.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (document.hidden) return;
      try {
        const rows = await apiGet<ServerStatsById[]>("/servers/stats");
        if (!cancelled) setStats(Object.fromEntries(rows.map((r) => [r.id, r])));
      } catch {
        /* silent */
      }
    };
    void tick();
    const id = setInterval(() => void tick(), 5000);
    const onVisible = () => {
      if (!document.hidden) void tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  const act = async (id: string, action: "install" | "start" | "stop" | "restart") => {
    setPending((p) => ({ ...p, [id]: action }));
    try {
      if (action === "start") {
        // RAM-guarded: surfaces a "stop one to free RAM" dialog if it won't fit.
        const name = servers.find((s) => s.id === id)?.name ?? "this server";
        await guardedStart(id, name);
      } else {
        await apiPost(`/servers/${id}/${action}`);
        await apiGet<ServerSummary[]>("/servers").then(setServers); // await so state lands before re-enabling
      }
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setPending((p) => {
        const n = { ...p };
        delete n[id];
        return n;
      });
    }
  };

  return (
    <div className="space-y-6">
      {startDialog}
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Servers</h1>
        <button className="btn-primary" onClick={() => setCreating((v) => !v)}>
          <Plus className="h-4 w-4" /> New server
        </button>
      </div>

      {creating && <CreateServerForm onDone={() => { setCreating(false); refresh(); }} />}

      {servers.length === 0 && !creating && (
        <div className="card text-center text-slate-400">
          No servers yet. Click <span className="text-slate-200">New server</span> to create one.
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        {servers.map((s) => (
          <div key={s.id} className="card space-y-3">
            <div className="flex items-start justify-between">
              <div>
                <Link href={`/servers/${s.id}`} className="text-lg font-medium hover:underline">
                  {s.name}
                </Link>
                <div className="text-sm text-slate-400">
                  {s.game} · {mapLabel(s.map)} · :{s.ports.game}
                </div>
                <MiniStats s={stats[s.id]} />
                {s.clusterId && (
                  <Link
                    href="/clusters"
                    title="Part of a cluster — click to manage"
                    className="mt-1.5 inline-flex items-center gap-1 rounded-full bg-ark-accent2/15 px-2 py-0.5 text-xs font-medium text-ark-accent2 hover:brightness-125"
                  >
                    <Boxes className="h-3 w-3" /> {clusterName(s.clusterId) ?? "Cluster"}
                  </Link>
                )}
              </div>
              <div className="flex flex-col items-end gap-1.5">
                <StateBadge state={s.state} />
                {s.updateAvailable && <UpdateBadge />}
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                className="btn-secondary"
                disabled={
                  !!pending[s.id] ||
                  s.imageReady ||
                  !(s.state === ServerState.Stopped || s.state === ServerState.Crashed)
                }
                title={
                  s.imageReady
                    ? "Game image already downloaded — just hit Start (game files install/update automatically)"
                    : "Pre-pull the game server image (optional — Start does this too)"
                }
                onClick={() => act(s.id, "install")}
              >
                {pending[s.id] === "install" || s.state === ServerState.Installing || s.state === ServerState.Updating ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" /> Installing…
                  </>
                ) : (
                  <>
                    <Download className="h-4 w-4" /> Install
                  </>
                )}
              </button>
              {s.state === ServerState.Running && s.configDirty ? (
                <button
                  className="btn-primary"
                  disabled={!!pending[s.id]}
                  onClick={() => act(s.id, "restart")}
                  title="Settings changed since this server started — restart to apply them"
                >
                  {pending[s.id] === "restart" ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" /> Restarting…
                    </>
                  ) : (
                    <>
                      <RotateCw className="h-4 w-4" /> Restart
                    </>
                  )}
                </button>
              ) : (
                <button
                  className="btn-primary"
                  disabled={!!pending[s.id] || !(s.state === ServerState.Stopped || s.state === ServerState.Crashed)}
                  onClick={() => act(s.id, "start")}
                >
                  {pending[s.id] === "start" || s.state === ServerState.Starting ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" /> Starting…
                    </>
                  ) : (
                    <>
                      <Play className="h-4 w-4" /> Start
                    </>
                  )}
                </button>
              )}
              <button
                className="btn-secondary"
                disabled={!!pending[s.id] || !(s.state === ServerState.Running || s.state === ServerState.Starting)}
                onClick={() => act(s.id, "stop")}
              >
                {pending[s.id] === "stop" || s.state === ServerState.Stopping ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" /> Stopping…
                  </>
                ) : (
                  <>
                    <Square className="h-4 w-4" /> Stop
                  </>
                )}
              </button>
              <Link href={`/servers/${s.id}`} className="btn-secondary">
                <Settings2 className="h-4 w-4" /> Manage
              </Link>
            </div>
            <ConnectCommand
              game={s.game}
              gamePort={s.ports.game}
              queryPort={s.ports.query}
              joinPassword={s.joinPassword}
            />
            <UnofficialListHelp
              game={s.game}
              serverName={s.name}
              mapName={mapLabel(s.map)}
              queryPort={s.ports.query}
              hasJoinPassword={Boolean(s.joinPassword)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

const MAPS_FOR: Record<Game, readonly string[]> = {
  [Game.ASA]: ASA_OFFICIAL_MAPS,
  [Game.ASE]: ASE_OFFICIAL_MAPS,
  [Game.CONAN]: CONAN_OFFICIAL_MAPS,
  [Game.PALWORLD]: PALWORLD_OFFICIAL_MAPS,
  [Game.MINECRAFT]: MINECRAFT_OFFICIAL_MAPS,
};

function CreateServerForm({ onDone }: { onDone: () => void }) {
  const [game, setGame] = useState<Game>(Game.ASA);
  const maps = MAPS_FOR[game];
  const [form, setForm] = useState<{
    name: string;
    map: string;
    maxPlayers: number;
    adminPassword: string;
    serverPassword: string;
  }>({
    name: "",
    map: maps[0],
    maxPlayers: 70,
    adminPassword: "",
    serverPassword: "",
  });
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await apiPost("/servers", { ...form, game, maxPlayers: Number(form.maxPlayers) });
      onDone();
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="card space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <label className="label">Server name</label>
          <input
            className="input"
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          />
        </div>
        <div>
          <label className="label">Game</label>
          <select
            className="input"
            value={game}
            onChange={(e) => {
              const g = e.target.value as Game;
              setGame(g);
              setForm((f) => ({ ...f, map: MAPS_FOR[g][0] })); // reset map to the new game's default
            }}
          >
            {Object.values(Game).map((g) => (
              <option key={g} value={g}>
                {GAME_LABELS[g]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Map</label>
          <select
            className="input"
            value={form.map}
            onChange={(e) => setForm((f) => ({ ...f, map: e.target.value }))}
          >
            {maps.map((m) => (
              <option key={m} value={m}>
                {mapLabel(m)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Max players</label>
          <input
            type="number"
            className="input"
            value={form.maxPlayers}
            onChange={(e) => setForm((f) => ({ ...f, maxPlayers: Number(e.target.value) }))}
          />
        </div>
        <div>
          <label className="label">Admin password (enables RCON)</label>
          <input
            className="input"
            value={form.adminPassword}
            onChange={(e) => setForm((f) => ({ ...f, adminPassword: e.target.value }))}
          />
        </div>
        <div>
          <label className="label">Server password (players need it to join)</label>
          <input
            className="input"
            placeholder="Leave blank for an open server"
            value={form.serverPassword}
            onChange={(e) => setForm((f) => ({ ...f, serverPassword: e.target.value }))}
          />
        </div>
      </div>
      <button className="btn-primary" disabled={busy}>
        {busy ? "Creating…" : "Create server"}
      </button>
    </form>
  );
}

/** Compact CPU / RAM / disk chips on a server card. CPU+RAM appear only while the
 *  container is up; disk shows whenever it's been measured. */
function MiniStats({ s }: { s?: ServerStatsById }) {
  if (!s) return null;
  const u = (mb: number | null) => (mb == null ? "" : mb >= 1024 ? `${(mb / 1024).toFixed(1)}G` : `${mb}M`);
  const cpu = s.live && s.cpuPercent != null;
  const mem = s.live && s.memUsedMb != null;
  if (!cpu && !mem && s.diskUsedMb == null) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
      {cpu && (
        <span className="inline-flex items-center gap-1" title="CPU">
          <Cpu className="h-3 w-3" /> {s.cpuPercent}%
        </span>
      )}
      {mem && (
        <span className="inline-flex items-center gap-1" title="Memory used / limit">
          <MemoryStick className="h-3 w-3" /> {u(s.memUsedMb)}
          {s.memLimitMb ? ` / ${u(s.memLimitMb)}` : ""}
        </span>
      )}
      {s.diskUsedMb != null && (
        <span className="inline-flex items-center gap-1" title="Disk (saves + game files)">
          <HardDrive className="h-3 w-3" /> {u(s.diskUsedMb)}
        </span>
      )}
    </div>
  );
}
