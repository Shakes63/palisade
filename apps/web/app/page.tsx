"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Plus, Play, Square, Download, Settings2, Boxes, Loader2, RotateCw,
  Cpu, MemoryStick, HardDrive, Users,
} from "lucide-react";
import {
  Game,
  ServerState,
  ASA_OFFICIAL_MAPS,
  ASE_OFFICIAL_MAPS,
  CONAN_OFFICIAL_MAPS,
  PALWORLD_OFFICIAL_MAPS,
  MINECRAFT_OFFICIAL_MAPS,
  ICARUS_OFFICIAL_MAPS,
  BEDROCK_OFFICIAL_MAPS,
  VALHEIM_OFFICIAL_MAPS,
  SEVEN_DAYS_OFFICIAL_MAPS,
  ENSHROUDED_OFFICIAL_MAPS,
  GAME_LABELS,
  MAX_PLAYERS_BY_GAME,
  DEFAULT_MAX_PLAYERS_BY_GAME,
  ADMIN_PASSWORD_META,
  JOIN_PASSWORD_META,
  mapLabel,
  type ServerSummary,
  type ServerStatsById,
  type HostStats,
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
  const [host, setHost] = useState<HostStats | null>(null);

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

  // Host disk-space check (backups + 17 GB installs eventually fill the pool) —
  // a slow signal, refreshed every 60 s.
  useEffect(() => {
    const tick = () => apiGet<HostStats>("/servers/host").then(setHost).catch(() => undefined);
    void tick();
    const id = setInterval(tick, 60_000);
    return () => clearInterval(id);
  }, []);
  const diskLow =
    host && host.diskTotalMb > 0 && (host.diskFreeMb / host.diskTotalMb < 0.1 || host.diskFreeMb < 20_480);

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
      {diskLow && host && (
        <div className="flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-950/30 px-3 py-2 text-sm text-amber-300">
          <HardDrive className="h-4 w-4 shrink-0" />
          <span>
            Low disk space: <span className="font-semibold">{(host.diskFreeMb / 1024).toFixed(1)} GB</span>{" "}
            free of {(host.diskTotalMb / 1024).toFixed(0)} GB. Prune old backups or unused game installs
            before installing more servers.
          </span>
        </div>
      )}
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
  [Game.ICARUS]: ICARUS_OFFICIAL_MAPS,
  [Game.BEDROCK]: BEDROCK_OFFICIAL_MAPS,
  [Game.VALHEIM]: VALHEIM_OFFICIAL_MAPS,
  [Game.SEVEN_DAYS]: SEVEN_DAYS_OFFICIAL_MAPS,
  [Game.ENSHROUDED]: ENSHROUDED_OFFICIAL_MAPS,
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
    maxPlayers: DEFAULT_MAX_PLAYERS_BY_GAME[Game.ASA],
    adminPassword: "",
    serverPassword: "",
  });
  const [busy, setBusy] = useState(false);

  const maxPlayersCap = MAX_PLAYERS_BY_GAME[game];
  const adminMeta = ADMIN_PASSWORD_META[game];
  const joinMeta = JOIN_PASSWORD_META[game];
  // Block submit when a required join password is missing/too short (mirrors the API).
  const joinTooShort =
    joinMeta.required && (form.serverPassword ?? "").length < (joinMeta.minLength ?? 1);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (joinTooShort) {
      alert(joinMeta.help ?? "This game requires a server password.");
      return;
    }
    // Clamp to the game's real ceiling so we never send e.g. 70 for a 20-slot game.
    const clamped = Math.max(1, Math.min(Number(form.maxPlayers) || 1, maxPlayersCap));
    setBusy(true);
    try {
      await apiPost("/servers", { ...form, game, maxPlayers: clamped });
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
              // Reset the map AND clamp the player count to the new game's default/cap.
              setForm((f) => ({
                ...f,
                map: MAPS_FOR[g][0],
                maxPlayers: DEFAULT_MAX_PLAYERS_BY_GAME[g],
              }));
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
          {game === Game.ICARUS ? (
            // Icarus has no launch map — the world is a "prospect" (map + game mode +
            // difficulty) players create in the in-game lobby. Show why, not an empty picker.
            <p className="input flex items-center text-sm text-slate-400">
              Chosen in-game (players pick the map + mode)
            </p>
          ) : (
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
          )}
        </div>
        <div>
          <label className="label">Max players</label>
          <input
            type="number"
            min={1}
            max={maxPlayersCap}
            className="input"
            value={form.maxPlayers}
            onChange={(e) => setForm((f) => ({ ...f, maxPlayers: Number(e.target.value) }))}
          />
          <p className="mt-1 text-xs text-slate-500">Max {maxPlayersCap} for {GAME_LABELS[game]}.</p>
        </div>
        {adminMeta.show && (
          <div>
            <label className="label">{adminMeta.label}</label>
            <input
              className="input"
              value={form.adminPassword}
              onChange={(e) => setForm((f) => ({ ...f, adminPassword: e.target.value }))}
            />
            {adminMeta.help && <p className="mt-1 text-xs text-slate-500">{adminMeta.help}</p>}
          </div>
        )}
        {joinMeta.show && (
          <div>
            <label className="label">{joinMeta.label}</label>
            <input
              className="input"
              placeholder={joinMeta.required ? "" : "Leave blank for an open server"}
              value={form.serverPassword}
              onChange={(e) => setForm((f) => ({ ...f, serverPassword: e.target.value }))}
            />
            {joinMeta.help && (
              <p className={`mt-1 text-xs ${joinTooShort ? "text-rose-400" : "text-slate-500"}`}>{joinMeta.help}</p>
            )}
          </div>
        )}
      </div>
      <button className="btn-primary" disabled={busy || joinTooShort}>
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
  const players = s.live && s.playersOnline != null;
  if (!cpu && !mem && !players && s.diskUsedMb == null) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
      {players && (
        <span
          className={`inline-flex items-center gap-1 ${s.playersOnline! > 0 ? "font-medium text-ark-accent" : ""}`}
          title="Players online"
        >
          <Users className="h-3 w-3" /> {s.playersOnline}
          {s.playersMax != null ? `/${s.playersMax}` : ""}
        </span>
      )}
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
