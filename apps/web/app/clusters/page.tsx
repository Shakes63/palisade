"use client";
import { useCallback, useEffect, useState } from "react";
import { Boxes, Plus, Play, Square, Trash2, UserPlus, X } from "lucide-react";
import { GAME_LABELS, clusterJoinError, mapLabel, type Game, type ServerSummary } from "@ark/shared";
import { apiDelete, apiGet, apiPost } from "@/lib/api";
import { StateBadge } from "@/components/state-badge";
import { useMe } from "@/lib/use-me";

interface ClusterMember {
  id: string;
  name: string;
  map: string;
  state: ServerSummary["state"];
  game: Game;
}
interface Cluster {
  id: string;
  name: string;
  clusterId: string;
  transferDir: string;
  servers: ClusterMember[];
}

export default function ClustersPage() {
  const [clusters, setClusters] = useState<Cluster[]>([]);
  const [servers, setServers] = useState<ServerSummary[]>([]);
  const [name, setName] = useState("");
  // Cluster changes touch servers a restricted user may not see, so the
  // create / add / remove / delete controls are hidden for restricted users.
  const me = useMe();
  const canEdit = !me?.restricted;

  const refresh = useCallback(() => {
    apiGet<Cluster[]>("/clusters").then(setClusters).catch(() => undefined);
    apiGet<ServerSummary[]>("/servers").then(setServers).catch(() => undefined);
  }, []);
  useEffect(() => refresh(), [refresh]);

  /**
   * Start/stop-all now return as soon as the work is queued, because holding the
   * request through every member's launch outlasts the proxy. So refresh on a few
   * delays instead of once: members flip to Starting/Stopping over the following
   * minute, and a single immediate refresh would always look like nothing happened.
   */
  const runOnCluster = async (path: string) => {
    try {
      await apiPost(path);
    } catch (e) {
      alert((e as Error).message);
      return;
    }
    refresh();
    for (const ms of [3000, 10000, 30000]) window.setTimeout(refresh, ms);
  };

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    await apiPost("/clusters", { name }).catch((err) => alert(err.message));
    setName("");
    refresh();
  };

  const clusterName = (id?: string | null) => clusters.find((cl) => cl.id === id)?.name;

  const mutate = (p: Promise<unknown>) =>
    p.catch((err) => alert((err as Error).message)).finally(refresh);

  const removeCluster = (c: Cluster) => {
    const members = c.servers.length
      ? ` Its ${c.servers.length} member server${c.servers.length === 1 ? "" : "s"} will leave the cluster. Saves are kept.`
      : "";
    if (confirm(`Delete cluster "${c.name}"?${members}`)) void mutate(apiDelete(`/clusters/${c.id}`));
  };

  return (
    <div className="space-y-6">
      <h1 className="flex items-center gap-2 text-xl font-semibold">
        <Boxes className="h-5 w-5 text-ark-accent" /> Clusters
      </h1>

      {canEdit && (
        <form onSubmit={create} className="card flex gap-2">
          <input
            className="input min-w-0"
            placeholder="New cluster name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button className="btn-primary shrink-0">
            <Plus className="h-4 w-4" /> Create
          </button>
        </form>
      )}

      {clusters.length === 0 && <div className="card text-slate-400">No clusters yet.</div>}

      {clusters.map((c) => (
        <div key={c.id} className="card space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="break-words text-lg font-medium">{c.name}</div>
              <div className="break-all text-xs text-slate-500">
                id <span className="font-mono">{c.clusterId}</span> · transfer{" "}
                <span className="font-mono">{c.transferDir}</span>
              </div>
            </div>
            <div className="flex gap-2">
              <button className="btn-primary" onClick={() => runOnCluster(`/clusters/${c.id}/start`)}>
                <Play className="h-4 w-4" /> Start all
              </button>
              <button className="btn-secondary" onClick={() => runOnCluster(`/clusters/${c.id}/stop`)}>
                <Square className="h-4 w-4" /> Stop all
              </button>
              {canEdit && (
                <button
                  className="btn-danger"
                  title="Delete cluster"
                  aria-label={`Delete cluster ${c.name}`}
                  onClick={() => removeCluster(c)}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>

          <div className="space-y-2">
            {c.servers.length === 0 ? (
              <p className="text-sm text-slate-500">No members yet.</p>
            ) : (
              c.servers.map((m) => (
                <div
                  key={m.id}
                  className="flex items-center justify-between gap-2 rounded-lg border border-ark-border bg-ark-bg px-3 py-2"
                >
                  <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                    <StateBadge state={m.state} />
                    <span className="min-w-0 break-words">{m.name}</span>
                    <span className="text-xs text-slate-500">
                      {GAME_LABELS[m.game] ?? m.game} · {mapLabel(m.map)}
                    </span>
                  </div>
                  {canEdit && (
                    <button
                      className="btn-secondary shrink-0 px-2"
                      title="Remove from cluster (restarts the server if it's running)"
                      aria-label={`Remove ${m.name} from the cluster`}
                      onClick={() => void mutate(apiDelete(`/clusters/${c.id}/members/${m.id}`))}
                    >
                      <X className="h-4 w-4" />
                    </button>
                  )}
                </div>
              ))
            )}
          </div>

          {(() => {
            if (!canEdit) return null;
            const memberGames = c.servers.map((m) => m.game);
            const addable = servers.filter(
              (s) => s.clusterId !== c.id && !clusterJoinError(s.game, memberGames),
            );
            if (addable.length === 0) return null;
            return (
              <div className="flex flex-wrap items-center gap-2">
                <UserPlus className="h-4 w-4 text-slate-400" />
                <select
                  className="input min-w-0 max-w-xs flex-1"
                  value=""
                  onChange={(e) => {
                    if (e.target.value)
                      void mutate(apiPost(`/clusters/${c.id}/members`, { serverId: e.target.value }));
                  }}
                >
                  <option value="">Add or move a server here…</option>
                  {addable.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} ({mapLabel(s.map)})
                      {s.clusterId ? ` — move from ${clusterName(s.clusterId) ?? "another cluster"}` : ""}
                    </option>
                  ))}
                </select>
                <span className="text-xs text-slate-500">
                  Running servers restart automatically to apply the change.
                </span>
              </div>
            );
          })()}
        </div>
      ))}
    </div>
  );
}
