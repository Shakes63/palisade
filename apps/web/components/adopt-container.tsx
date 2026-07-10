"use client";
import { useEffect, useState } from "react";
import { Import, Loader2 } from "lucide-react";
import { GAME_LABELS, type Game } from "@ark/shared";
import { apiGet, apiPost } from "@/lib/api";

interface Candidate {
  containerId: string;
  containerName: string;
  image: string;
  game: Game;
  running: boolean;
}

/**
 * Adopt game containers created outside Palisade (e.g. an itzg Minecraft the
 * user already ran from CA). Adoption creates a proper Palisade server and
 * copies the container's world/config data in; the original is stopped and
 * left in place until the user removes it.
 */
export function AdoptContainerPanel({ onDone }: { onDone: () => void }) {
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [selected, setSelected] = useState<Candidate | null>(null);
  const [name, setName] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [serverPassword, setServerPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    apiGet<Candidate[]>("/adoption/candidates")
      .then(setCandidates)
      .catch((e) => setErr((e as Error).message));
  }, []);

  const adopt = async () => {
    if (!selected) return;
    setBusy(true);
    setErr(null);
    try {
      await apiPost("/adoption", {
        containerId: selected.containerId,
        name: name || selected.containerName,
        adminPassword: adminPassword || undefined,
        serverPassword: serverPassword || undefined,
      });
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card space-y-4">
      <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-ark-accent2">
        <Import className="h-4 w-4" /> Adopt an existing container
      </h2>
      <p className="text-xs text-slate-500">
        Containers on this host running a game image Palisade knows, but not managed by it. Adopting
        stops the container, creates a Palisade server, and copies its world/config data in. The
        original container is left (stopped) so nothing is lost — remove it yourself once the
        adopted server runs the way you expect. It may need a minute for large worlds.
      </p>

      {candidates === null && !err && <p className="text-sm text-slate-400">Scanning containers…</p>}
      {candidates?.length === 0 && (
        <p className="text-sm text-slate-400">No adoptable containers found.</p>
      )}

      {candidates?.map((c) => (
        <label
          key={c.containerId}
          className={`flex cursor-pointer items-center gap-3 rounded-lg border p-3 text-sm ${
            selected?.containerId === c.containerId ? "border-ark-accent" : "border-slate-700/60"
          }`}
        >
          <input
            type="radio"
            name="adopt-candidate"
            checked={selected?.containerId === c.containerId}
            onChange={() => {
              setSelected(c);
              setName(c.containerName);
            }}
          />
          <span className="font-medium text-slate-100">{c.containerName}</span>
          <span className="text-xs text-slate-400">{GAME_LABELS[c.game]}</span>
          <span className="ml-auto truncate text-xs text-slate-500">{c.image}</span>
          {c.running && (
            <span className="rounded bg-amber-900/50 px-1.5 py-0.5 text-[10px] uppercase text-amber-300">
              running — will be stopped
            </span>
          )}
        </label>
      ))}

      {selected && (
        <div className="grid gap-3 sm:grid-cols-3">
          <input className="input" placeholder="Server name" value={name} onChange={(e) => setName(e.target.value)} />
          <input
            type="password"
            className="input"
            placeholder="Admin/RCON password (recommended)"
            value={adminPassword}
            onChange={(e) => setAdminPassword(e.target.value)}
          />
          <input
            type="password"
            className="input"
            placeholder="Join password (optional)"
            value={serverPassword}
            onChange={(e) => setServerPassword(e.target.value)}
          />
        </div>
      )}
      {selected && (
        <p className="text-xs text-slate-500">
          Settings (passwords, map, players) come from what you configure in Palisade — the world
          data is what gets carried over.
        </p>
      )}

      {err && <p className="text-sm text-rose-300">{err}</p>}
      <button type="button" className="btn-primary" onClick={adopt} disabled={!selected || busy}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Import className="h-4 w-4" />}
        {busy ? "Adopting… (copying data)" : "Adopt container"}
      </button>
    </div>
  );
}
