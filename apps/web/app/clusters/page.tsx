"use client";
import { useCallback, useEffect, useState } from "react";
import { Boxes, Plus, Play, Square, Trash2, UserPlus, X } from "lucide-react";
import { mapLabel, type ServerSummary } from "@ark/shared";
import { apiDelete, apiGet, apiPost } from "@/lib/api";
import { StateBadge } from "@/components/state-badge";

interface ClusterMember {
  id: string;
  name: string;
  map: string;
  state: ServerSummary["state"];
  game: string;
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

  return (
    <div className="space-y-6">
      <h1 className="flex items-center gap-2 text-xl font-semibold">
        <Boxes className="h-5 w-5 text-ark-accent" /> Clusters
      </h1>

      <form onSubmit={create} className="card flex gap-2">
        <input
          className="input"
          placeholder="New cluster name (e.g. The Archipelago)"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button className="btn-primary">
          <Plus className="h-4 w-4" /> Create
        </button>
      </form>

      {clusters.length === 0 && <div className="card text-slate-400">No clusters yet.</div>}

      {clusters.map((c) => (
        <div key={c.id} className="card space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-lg font-medium">{c.name}</div>
              <div className="text-xs text-slate-500">
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
              <button
                className="btn-danger"
                onClick={() => apiDelete(`/clusters/${c.id}`).then(refresh)}
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          </div>

          <div className="space-y-2">
            {c.servers.length === 0 ? (
              <p className="text-sm text-slate-500">No members yet.</p>
            ) : (
              c.servers.map((m) => (
                <div
                  key={m.id}
                  className="flex items-center justify-between rounded-lg border border-ark-border bg-ark-bg px-3 py-2"
                >
                  <div className="flex items-center gap-3">
                    <StateBadge state={m.state} />
                    <span>{m.name}</span>
                    <span className="text-xs text-slate-500">
                      {m.game} · {mapLabel(m.map)}
                    </span>
                  </div>
                  <button
                    className="btn-secondary px-2"
                    title="Remove from cluster (restarts the server if it's running)"
                    onClick={() => apiDelete(`/clusters/${c.id}/members/${m.id}`).then(refresh)}
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ))
            )}
          </div>

          {(() => {
            const addable = servers.filter((s) => s.clusterId !== c.id);
            if (addable.length === 0) return null;
            return (
              <div className="flex flex-wrap items-center gap-2">
                <UserPlus className="h-4 w-4 text-slate-400" />
                <select
                  className="input max-w-xs"
                  value=""
                  onChange={(e) => {
                    if (e.target.value)
                      apiPost(`/clusters/${c.id}/members`, { serverId: e.target.value }).then(refresh);
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
