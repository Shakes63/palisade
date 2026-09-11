"use client";
import { useEffect, useState } from "react";
import { Check, Pencil, Plus, Trash2, Users, X } from "lucide-react";
import { ROLES, type Role, type ServerSummary, type UserAccessDto, type UserDto } from "@ark/shared";
import { apiDelete, apiGet, apiPatch, apiPost } from "@/lib/api";

interface ClusterLite {
  id: string;
  name: string;
}

const ROLE_HINTS: Record<Role, string> = {
  viewer: "Read-only: dashboards, players, logs.",
  operator: "Day-to-day ops: start/stop, console, backups, mods, schedules.",
  admin: "Everything, including settings, users, and deletes. Admins always see every server.",
};

/** Editable access fields, shared by the add form and the per-user editor. */
interface AccessDraft {
  role: Role;
  restricted: boolean;
  serverIds: string[];
  clusterIds: string[];
}

const toggle = (list: string[], id: string, on: boolean) =>
  on ? (list.includes(id) ? list : [...list, id]) : list.filter((x) => x !== id);

/** One-line summary of what a user can see, for the list row. */
function accessLabel(u: UserDto): string | null {
  if (u.role === "admin") return null;
  if (!u.restricted) return "All servers";
  const parts: string[] = [];
  parts.push(`${u.serverIds.length} server${u.serverIds.length === 1 ? "" : "s"}`);
  parts.push(`${u.clusterIds.length} cluster${u.clusterIds.length === 1 ? "" : "s"}`);
  return parts.join(", ");
}

/**
 * Role + "restrict to selected servers" + a server picker grouped by cluster.
 * Ticking a cluster grants every current and future member, so its members
 * show ticked and disabled rather than as separate grants.
 */
function AccessFields({
  draft,
  onChange,
  servers,
  clusters,
}: {
  draft: AccessDraft;
  onChange: (next: AccessDraft) => void;
  servers: ServerSummary[];
  clusters: ClusterLite[];
}) {
  const isAdmin = draft.role === "admin";
  const restricted = draft.restricted && !isAdmin;
  const groups = [
    ...clusters.map((c) => ({ cluster: c as ClusterLite | null, servers: servers.filter((s) => s.clusterId === c.id) })),
    { cluster: null, servers: servers.filter((s) => !s.clusterId || !clusters.some((c) => c.id === s.clusterId)) },
  ].filter((g) => g.cluster || g.servers.length > 0);

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <select
          className="input"
          value={draft.role}
          onChange={(e) => onChange({ ...draft, role: e.target.value as Role })}
        >
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-2 text-sm text-slate-200">
          <input
            type="checkbox"
            className="h-4 w-4"
            checked={restricted}
            disabled={isAdmin}
            onChange={(e) => onChange({ ...draft, restricted: e.target.checked })}
          />
          Restrict to selected servers
        </label>
      </div>
      <p className="text-xs text-slate-500">{ROLE_HINTS[draft.role]}</p>

      {restricted && (
        <div className="space-y-2 rounded border border-slate-700/60 p-3">
          <p className="text-xs text-slate-500">
            Tick a cluster to grant every server in it, now and in future. The role above still
            decides what they can do on those servers.
          </p>
          {servers.length === 0 && clusters.length === 0 && (
            <p className="text-xs text-slate-500">No servers or clusters yet.</p>
          )}
          <div className="max-h-64 space-y-2 overflow-auto">
            {groups.map((g) => {
              const clusterOn = g.cluster ? draft.clusterIds.includes(g.cluster.id) : false;
              return (
                <div key={g.cluster?.id ?? "none"} className="space-y-0.5">
                  {g.cluster ? (
                    <label className="flex items-center gap-2 text-sm font-medium text-slate-200">
                      <input
                        type="checkbox"
                        className="h-4 w-4"
                        checked={clusterOn}
                        onChange={(e) =>
                          onChange({ ...draft, clusterIds: toggle(draft.clusterIds, g.cluster!.id, e.target.checked) })
                        }
                      />
                      {g.cluster.name}
                      <span className="text-xs font-normal text-slate-500">cluster</span>
                    </label>
                  ) : (
                    <div className="text-xs font-medium uppercase tracking-wide text-slate-500">Not in a cluster</div>
                  )}
                  {g.servers.length === 0 && g.cluster && (
                    <p className="pl-6 text-xs text-slate-500">No members yet.</p>
                  )}
                  {g.servers.map((s) => (
                    <label
                      key={s.id}
                      className={`flex items-center gap-2 pl-6 text-sm ${clusterOn ? "text-slate-500" : "text-slate-300"}`}
                    >
                      <input
                        type="checkbox"
                        className="h-4 w-4"
                        checked={clusterOn || draft.serverIds.includes(s.id)}
                        disabled={clusterOn}
                        onChange={(e) => onChange({ ...draft, serverIds: toggle(draft.serverIds, s.id, e.target.checked) })}
                      />
                      {s.name}
                      {clusterOn && <span className="text-xs">via cluster</span>}
                    </label>
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/** Body sent to POST/PATCH /users. Admins are never restricted. */
function toAccessBody(d: AccessDraft): UserAccessDto {
  const restricted = d.restricted && d.role !== "admin";
  return {
    role: d.role,
    restricted,
    serverIds: restricted ? d.serverIds : [],
    clusterIds: restricted ? d.clusterIds : [],
  };
}

/** Inline editor for one user's role and access. */
function UserEditor({
  user,
  servers,
  clusters,
  onSaved,
  onCancel,
}: {
  user: UserDto;
  servers: ServerSummary[];
  clusters: ClusterLite[];
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<AccessDraft>({
    role: user.role,
    restricted: user.restricted,
    serverIds: user.serverIds,
    clusterIds: user.clusterIds,
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await apiPatch(`/users/${user.id}`, toAccessBody(draft));
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 border-t border-slate-700/60 pt-3">
      <AccessFields draft={draft} onChange={setDraft} servers={servers} clusters={clusters} />
      <div className="flex items-center gap-2">
        <button type="button" className="btn-primary" onClick={save} disabled={busy}>
          <Check className="h-4 w-4" /> Save
        </button>
        <button type="button" className="btn-secondary" onClick={onCancel} disabled={busy}>
          <X className="h-4 w-4" /> Cancel
        </button>
        {err && <p className="text-sm text-amber-400">{err}</p>}
      </div>
    </div>
  );
}

const NEW_USER: AccessDraft = { role: "operator", restricted: false, serverIds: [], clusterIds: [] };

/** Settings card: manage panel accounts, their roles, and which servers they can see. */
export function UsersCard() {
  const [users, setUsers] = useState<UserDto[]>([]);
  const [servers, setServers] = useState<ServerSummary[]>([]);
  const [clusters, setClusters] = useState<ClusterLite[]>([]);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [draft, setDraft] = useState<AccessDraft>(NEW_USER);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = () => {
    apiGet<UserDto[]>("/users")
      .then(setUsers)
      .catch(() => undefined);
  };
  useEffect(() => {
    load();
    apiGet<ServerSummary[]>("/servers").then(setServers).catch(() => undefined);
    apiGet<ClusterLite[]>("/clusters").then(setClusters).catch(() => undefined);
  }, []);

  const add = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await apiPost("/users", { username, password, ...toAccessBody(draft) });
      setUsername("");
      setPassword("");
      setDraft(NEW_USER);
      load();
    } catch (err) {
      setMsg((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (u: UserDto) => {
    if (!window.confirm(`Delete user "${u.username}"? Their tokens stop working immediately.`)) return;
    try {
      await apiDelete(`/users/${u.id}`);
      load();
    } catch (err) {
      setMsg((err as Error).message);
    }
  };

  return (
    <div className="card space-y-4">
      <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-ark-accent2">
        <Users className="h-4 w-4" /> Users
      </h2>
      <p className="text-xs text-slate-500">
        Give friends their own logins. Viewers can look, operators can run servers, admins can
        change anything. A viewer or operator can also be limited to chosen servers or clusters;
        everything else is hidden from them, and they cannot create or import servers. The API
        enforces all of this server-side.
      </p>

      <ul className="space-y-1">
        {users.map((u) => {
          const access = accessLabel(u);
          return (
            <li key={u.id} className="rounded border border-slate-700/60 px-3 py-2 text-sm">
              <div className="flex items-center gap-3">
                <span className="font-medium text-slate-200">{u.username}</span>
                <span className="rounded bg-slate-700/60 px-2 py-0.5 text-xs uppercase tracking-wide text-slate-300">
                  {u.role}
                </span>
                {access && <span className="text-xs text-slate-500">{access}</span>}
                <button
                  type="button"
                  className="btn-secondary ml-auto"
                  onClick={() => setEditing(editing === u.id ? null : u.id)}
                  title="Edit role and access"
                >
                  <Pencil className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => remove(u)}
                  disabled={users.length <= 1}
                  title={users.length <= 1 ? "The last user can't be deleted" : "Delete user"}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
              {editing === u.id && (
                <div className="mt-3">
                  <UserEditor
                    user={u}
                    servers={servers}
                    clusters={clusters}
                    onSaved={() => {
                      setEditing(null);
                      load();
                    }}
                    onCancel={() => setEditing(null)}
                  />
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <div className="space-y-3 border-t border-slate-700/60 pt-4">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Add user</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <input className="input" placeholder="Username" value={username} onChange={(e) => setUsername(e.target.value)} />
          <input type="password" className="input" placeholder="Password (8+ chars)" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <AccessFields draft={draft} onChange={setDraft} servers={servers} clusters={clusters} />
        <button type="button" className="btn-secondary" onClick={add} disabled={busy || !username || password.length < 8}>
          <Plus className="h-4 w-4" /> Add user
        </button>
      </div>
      {msg && <p className="text-sm text-amber-400">{msg}</p>}
    </div>
  );
}
