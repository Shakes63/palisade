"use client";
import { useEffect, useRef, useState } from "react";
import { SendHorizontal, Save, Users, RefreshCw, Filter } from "lucide-react";
import { Game, ServerState } from "@ark/shared";
import { apiGet, apiPost } from "@/lib/api";
import { useRealtime } from "@/lib/socket";
import { isEngineNoise } from "@/lib/log-noise";

const PLAYER_POLL_MS = 20_000;
const MAX_LINES = 6000;
const NOISE_PREF = "ark.hideEngineNoise";
const HISTORY_MAX = 50;

/** Per-game quick commands — one click inserts them into the input for editing. */
const QUICK_COMMANDS: Partial<Record<Game, string[]>> = {
  [Game.ASA]: ["ListPlayers", "SaveWorld", "Broadcast ", "DestroyWildDinos", "GetGameLog"],
  [Game.ASE]: ["ListPlayers", "SaveWorld", "Broadcast ", "DestroyWildDinos", "GetGameLog"],
  [Game.CONAN]: ["listplayers", "broadcast ", "listallbuildings"],
  [Game.PALWORLD]: ["ShowPlayers", "Info", "Save", "Broadcast "],
  [Game.MINECRAFT]: ["list", "say ", "time set day", "weather clear", "whitelist list", "difficulty "],
  [Game.SEVEN_DAYS]: ["listplayers", "gettime", "settime day", "saveworld", "say "],
  [Game.ZOMBOID]: ["players", 'servermsg "', "save", "showoptions", "checkModsNeedUpdate"],
};

export function RconConsole({
  serverId,
  game,
  state,
}: {
  serverId: string;
  game: Game;
  state: ServerState;
}) {
  const [lines, setLines] = useState<string[]>([]);
  const [command, setCommand] = useState("");
  const [players, setPlayers] = useState<string[]>([]);
  const [hideNoise, setHideNoise] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // ↑/↓ command history, persisted per server. histIdx -1 = editing a fresh line.
  const histKey = `ark.cmdhist.${serverId}`;
  const [history, setHistory] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState(-1);
  useEffect(() => {
    try {
      setHistory(JSON.parse(localStorage.getItem(histKey) ?? "[]") as string[]);
    } catch {
      setHistory([]);
    }
    setHistIdx(-1);
  }, [histKey]);

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
    // Record in history (dedupe consecutive repeats) before sending.
    const next = [...history.filter((h) => h !== command), command].slice(-HISTORY_MAX);
    setHistory(next);
    setHistIdx(-1);
    localStorage.setItem(histKey, JSON.stringify(next));
    try {
      await apiPost(`/servers/${serverId}/rcon`, { command });
      setCommand("");
    } catch (err) {
      append(`! ${(err as Error).message}`);
    }
  };

  /** ↑/↓ walk the history (newest first from a fresh line), like a shell. */
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (history.length === 0) return;
      const idx = histIdx === -1 ? history.length - 1 : Math.max(0, histIdx - 1);
      setHistIdx(idx);
      setCommand(history[idx] ?? "");
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (histIdx === -1) return;
      const idx = histIdx + 1;
      if (idx >= history.length) {
        setHistIdx(-1);
        setCommand("");
      } else {
        setHistIdx(idx);
        setCommand(history[idx] ?? "");
      }
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
          {/* Conan has no manual-save command — it persists continuously to its DB. */}
          {game !== Game.CONAN && (
            <button className="btn-secondary" onClick={() => apiPost(`/servers/${serverId}/rcon/save`)}>
              <Save className="h-4 w-4" /> Save world
            </button>
          )}
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
        {(QUICK_COMMANDS[game] ?? []).length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {QUICK_COMMANDS[game]!.map((c) => (
              <button
                key={c}
                type="button"
                className="rounded-full border border-ark-border bg-ark-bg px-2 py-0.5 font-mono text-xs text-slate-400 hover:border-slate-500 hover:text-slate-200"
                title={c.endsWith(" ") ? "Inserts the command — finish typing the arguments" : "Insert this command"}
                onClick={() => {
                  setCommand(c);
                  setHistIdx(-1);
                  inputRef.current?.focus();
                }}
              >
                {c.trim()}
                {c.endsWith(" ") ? "…" : ""}
              </button>
            ))}
          </div>
        )}
        <form onSubmit={send} className="flex gap-2">
          <input
            ref={inputRef}
            className="input font-mono"
            placeholder="Command… (↑/↓ for history)"
            value={command}
            onChange={(e) => {
              setCommand(e.target.value);
              setHistIdx(-1);
            }}
            onKeyDown={onKeyDown}
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
