"use client";
import { useEffect, useRef, useState } from "react";
import { SendHorizontal, Save, Users, RefreshCw, Filter } from "lucide-react";
import { ServerState } from "@ark/shared";
import { apiGet, apiPost } from "@/lib/api";
import { useRealtime } from "@/lib/socket";
import { isEngineNoise } from "@/lib/log-noise";

const PLAYER_POLL_MS = 20_000;
const MAX_LINES = 6000;
const NOISE_PREF = "ark.hideEngineNoise";

export function RconConsole({ serverId, state }: { serverId: string; state: ServerState }) {
  const [lines, setLines] = useState<string[]>([]);
  const [command, setCommand] = useState("");
  const [players, setPlayers] = useState<string[]>([]);
  const [hideNoise, setHideNoise] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  // Shares the Logs tab's filter preference; RCON command/response lines never
  // match the noise patterns, so they are always shown.
  useEffect(() => setHideNoise(localStorage.getItem(NOISE_PREF) === "1"), []);
  const toggleNoise = () =>
    setHideNoise((v) => {
      localStorage.setItem(NOISE_PREF, v ? "0" : "1");
      return !v;
    });
  const visible = hideNoise ? lines.filter((l) => !isEngineNoise(l)) : lines;
  const hidden = lines.length - visible.length;

  const append = (line: string) => {
    setLines((prev) => [...prev.slice(-(MAX_LINES - 1)), line]);
    requestAnimationFrame(() => boxRef.current?.scrollTo(0, boxRef.current.scrollHeight));
  };

  // Load the captured console (log + RCON I/O of the current run) on mount — kept
  // across refreshes/tab switches, wiped on the next Start.
  useEffect(() => {
    apiGet<{ log: string }>(`/servers/${serverId}/console`)
      .then(({ log }) => setLines(log ? log.split("\n") : []))
      .catch(() => undefined);
  }, [serverId]);

  useRealtime((msg) => {
    if (msg.serverId !== serverId) return;
    if (msg.topic === "server.log") append((msg.payload as { line: string }).line);
    if (msg.topic === "rcon.output") {
      const p = msg.payload as { command: string; response: string };
      append(`> ${p.command}`);
      append(p.response);
    }
  }, serverId);

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!command.trim()) return;
    try {
      await apiPost(`/servers/${serverId}/rcon`, { command });
      setCommand("");
    } catch (err) {
      append(`! ${(err as Error).message}`);
    }
  };

  // Manual refresh (button): surfaces errors in the console.
  const refreshPlayers = async () => {
    try {
      const { players } = await apiGet<{ players: string[] }>(`/servers/${serverId}/rcon/players`);
      setPlayers(players);
    } catch (err) {
      append(`! ${(err as Error).message}`);
    }
  };

  // Auto-refresh: load on open, then poll while the server is Running and the tab
  // is visible (and re-poll the moment it's refocused). Silent — auto-poll errors
  // don't spam the console. Clears the list when the server isn't Running.
  useEffect(() => {
    if (state !== ServerState.Running) {
      setPlayers([]);
      return;
    }
    let cancelled = false;
    const tick = async () => {
      if (document.hidden) return;
      try {
        const { players } = await apiGet<{ players: string[] }>(`/servers/${serverId}/rcon/players`);
        if (!cancelled) setPlayers(players);
      } catch {
        /* silent: don't spew poll errors into the console */
      }
    };
    void tick(); // load on open
    const id = setInterval(() => void tick(), PLAYER_POLL_MS);
    const onVisible = () => {
      if (!document.hidden) void tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [serverId, state]);

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="lg:col-span-2 space-y-3">
        <div className="flex gap-2">
          <button className="btn-secondary" onClick={() => apiPost(`/servers/${serverId}/rcon/save`)}>
            <Save className="h-4 w-4" /> Save world
          </button>
          <button className="btn-secondary" onClick={refreshPlayers}>
            <RefreshCw className="h-4 w-4" /> Refresh players
          </button>
          <button
            className={`btn-secondary ${hideNoise ? "border-ark-accent text-ark-accent" : ""}`}
            onClick={toggleNoise}
            title="Hide known-benign Conan/Unreal engine log spam"
          >
            <Filter className="h-4 w-4" />
            {hideNoise ? `Engine noise hidden${hidden ? ` (${hidden})` : ""}` : "Hide engine noise"}
          </button>
        </div>
        <div
          ref={boxRef}
          className="h-80 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-ark-border bg-black/40 p-3 font-mono text-xs leading-relaxed"
        >
          {visible.length === 0 ? (
            <span className="text-slate-500">
              {lines.length === 0
                ? "Console output and live logs appear here…"
                : "Every line is engine noise — toggle the filter off to see them."}
            </span>
          ) : (
            visible.join("\n")
          )}
        </div>
        <form onSubmit={send} className="flex gap-2">
          <input
            className="input font-mono"
            placeholder="RCON command e.g. Broadcast Hello"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
          />
          <button className="btn-primary">
            <SendHorizontal className="h-4 w-4" />
          </button>
        </form>
      </div>

      <div className="card">
        <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold">
          <Users className="h-4 w-4" /> Players
          {state === ServerState.Running && (
            <span className="ml-auto text-xs font-normal text-slate-500">
              live · every {PLAYER_POLL_MS / 1000}s
            </span>
          )}
        </h3>
        {players.length === 0 ? (
          <p className="text-sm text-slate-500">
            {state === ServerState.Running ? "No players connected." : "Server isn’t running."}
          </p>
        ) : (
          <ul className="space-y-2 text-sm">
            {players.map((p, i) => {
              // ARK lists players as "N. Name, <eos-id>" — show the name, mute the id.
              const m = p.match(/^\s*\d+\.\s*(.+?),\s*([0-9a-f]{8,})\s*$/i);
              const name = m ? m[1] : p;
              const pid = m?.[2];
              return (
                <li key={i} className="flex items-center justify-between gap-2">
                  <span className="truncate font-medium">{name}</span>
                  {pid && <span className="shrink-0 font-mono text-xs text-slate-500">{pid}</span>}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
