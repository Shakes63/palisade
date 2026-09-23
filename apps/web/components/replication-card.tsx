"use client";
import { useEffect, useState } from "react";
import { CloudUpload, RefreshCw, Save, Send } from "lucide-react";
import { apiGet, apiPost, apiPut } from "@/lib/api";
import { toast } from "@/components/dialogs";

interface ReplicationView {
  config: {
    enabled: boolean;
    kind: "sftp" | "local";
    dir: string;
    host: string;
    port: number;
    username: string;
    hasPassword: boolean;
    hasPrivateKey: boolean;
  } | null;
  status: { lastSyncAt: string | null; lastError: string | null; lastUploaded: number };
}

/** Settings card: mirror every backup to an SFTP server or another mounted path. */
export function ReplicationCard() {
  const [enabled, setEnabled] = useState(false);
  const [kind, setKind] = useState<"sftp" | "local">("sftp");
  const [dir, setDir] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [hasPassword, setHasPassword] = useState(false);
  const [hasPrivateKey, setHasPrivateKey] = useState(false);
  const [status, setStatus] = useState<ReplicationView["status"] | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [formErr, setFormErr] = useState<string | null>(null);

  const load = () => {
    apiGet<ReplicationView>("/replication")
      .then((v) => {
        if (v.config) {
          setEnabled(v.config.enabled);
          setKind(v.config.kind);
          setDir(v.config.dir);
          setHost(v.config.host);
          setPort(String(v.config.port));
          setUsername(v.config.username);
          setHasPassword(v.config.hasPassword);
          setHasPrivateKey(v.config.hasPrivateKey);
        }
        setStatus(v.status);
      })
      .catch(() => undefined);
  };
  useEffect(load, []);

  const edited = () => {
    setSaved(false);
    setFormErr(null);
  };

  const validate = (): string | null => {
    const n = Number(port);
    if (kind === "sftp" && !(/^\d+$/.test(port.trim()) && n >= 1 && n <= 65535)) {
      return "Port must be a number from 1 to 65535.";
    }
    if (enabled && kind === "sftp" && !host.trim()) return "Enter the SFTP host, or turn replication off.";
    if (enabled && !dir.trim()) return "Enter a destination directory, or turn replication off.";
    return null;
  };

  const save = async () => {
    const invalid = validate();
    setFormErr(invalid);
    if (invalid) return;
    setBusy(true);
    setSaved(false);
    try {
      await apiPut("/replication", {
        enabled,
        kind,
        dir: dir.trim(),
        host: host.trim() || undefined,
        port: kind === "sftp" ? Number(port) : undefined,
        username: username || undefined,
        // Blank secrets keep what's stored server-side.
        password: password || undefined,
        privateKey: privateKey || undefined,
      });
      setPassword("");
      setPrivateKey("");
      setSaved(true);
      load();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  // Both buttons act on the SAVED config — save first if fields are dirty.
  const test = async () => {
    setMsg("Testing…");
    try {
      const res = await apiPost<{ ok: boolean; message: string }>("/replication/test");
      setMsg(`${res.ok ? "✓ " : "✗ "}${res.message}`);
    } catch (err) {
      setMsg((err as Error).message);
    }
  };

  const syncNow = async () => {
    setMsg("Starting sync…");
    try {
      const res = await apiPost<{ started: boolean; message?: string }>("/replication/sync");
      if (!res.started) return setMsg(`Sync skipped: ${res.message ?? "replication is off."}`);
      setMsg("Sync started — large snapshots can take a few minutes…");
      // The sync runs in the background; refresh the status line as it lands.
      window.setTimeout(load, 5000);
      window.setTimeout(load, 30000);
    } catch (err) {
      setMsg(`✗ ${(err as Error).message}`);
    }
  };

  return (
    <div className="card space-y-4">
      <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-ark-accent2">
        <CloudUpload className="h-4 w-4" /> Off-box backup replication
      </h2>
      <p className="text-xs text-slate-500">
        Mirrors every backup off this machine: world snapshots upload as .tar.gz archives and the
        manager&apos;s own DB snapshots copy as-is. Runs after each backup and hourly — if the
        destination is down, the next pass catches up. Deleted servers&apos; replicas are kept.
      </p>

      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-sm text-slate-200">
          <input type="checkbox" className="h-4 w-4" checked={enabled} onChange={(e) => { setEnabled(e.target.checked); edited(); }} />
          Enabled
        </label>
        <select className="input w-auto max-w-full" value={kind} onChange={(e) => { setKind(e.target.value as "sftp" | "local"); edited(); }}>
          <option value="sftp">SFTP (another machine)</option>
          <option value="local">Mounted path (e.g. a NAS share)</option>
        </select>
      </div>

      {kind === "sftp" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label">Host</label>
            <input className="input" placeholder="e.g. nas.local or 192.168.1.20" value={host} onChange={(e) => { setHost(e.target.value); edited(); }} />
          </div>
          <div>
            <label className="label">Port</label>
            <input className="input w-28" value={port} onChange={(e) => { setPort(e.target.value); edited(); }} />
          </div>
          <div>
            <label className="label">Username</label>
            <input className="input" value={username} onChange={(e) => { setUsername(e.target.value); edited(); }} />
          </div>
          <div>
            <label className="label">Password {hasPassword && <span className="text-green-400">(set)</span>}</label>
            <input type="password" className="input" placeholder={hasPassword ? "•••••••• (leave blank to keep)" : "Password"} value={password} onChange={(e) => { setPassword(e.target.value); edited(); }} />
          </div>
          <div className="sm:col-span-2">
            <label className="label">Private key (optional, instead of password) {hasPrivateKey && <span className="text-green-400">(set)</span>}</label>
            <textarea className="input h-20 font-mono text-xs" placeholder={hasPrivateKey ? "(leave blank to keep the stored key)" : "-----BEGIN OPENSSH PRIVATE KEY-----"} value={privateKey} onChange={(e) => { setPrivateKey(e.target.value); edited(); }} />
          </div>
        </div>
      )}

      <div>
        <label className="label">{kind === "sftp" ? "Remote directory" : "Destination path (inside the container)"}</label>
        <input className="input" placeholder={kind === "sftp" ? "e.g. /backups/palisade" : "e.g. /replica"} value={dir} onChange={(e) => { setDir(e.target.value); edited(); }} />
        {kind === "local" && (
          <p className="mt-1 text-xs text-slate-500">Add a container path mapping for it in your Docker template.</p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn-primary" onClick={save} disabled={busy}>
          <Save className="h-4 w-4" /> {busy ? "Saving…" : saved ? "Saved ✓" : "Save"}
        </button>
        <button type="button" className="btn-secondary" onClick={test}>
          <Send className="h-4 w-4" /> Test connection
        </button>
        <button type="button" className="btn-secondary" onClick={syncNow}>
          <RefreshCw className="h-4 w-4" /> Sync now
        </button>
      </div>
      {formErr && <p className="text-sm text-amber-400">{formErr}</p>}
      {msg && <p className="text-sm text-slate-400">{msg}</p>}
      {status && (status.lastSyncAt || status.lastError) && (
        <p className="text-xs text-slate-500">
          {status.lastSyncAt && <>Last sync: {new Date(status.lastSyncAt).toLocaleString()} ({status.lastUploaded} uploaded). </>}
          {status.lastError && <span className="text-amber-400">Last error: {status.lastError}</span>}
        </p>
      )}
    </div>
  );
}
