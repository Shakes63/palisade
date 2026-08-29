"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Archive, DatabaseBackup, Download, RotateCcw, Trash2, Upload, Loader2 } from "lucide-react";
import { apiDelete, apiDownload, apiGet, apiPatch, apiPost, apiUpload } from "@/lib/api";
import type { ServerSummary } from "@ark/shared";

/** Matches the API's own bound and the built-in default when a server sets none. */
const KEEP_MAX = 500;
const KEEP_DEFAULT = 10;

interface Snapshot {
  id: string;
  reason: string;
  path: string;
  createdAt: string;
}

export function BackupsTab({
  serverId,
  server,
  onChanged,
}: {
  serverId: string;
  server: ServerSummary;
  onChanged: () => void;
}) {
  const [backups, setBackups] = useState<Snapshot[]>([]);
  // "" means "use the default" — retention is per-server (the global setting now
  // governs Palisade's own database backups).
  const [keep, setKeep] = useState<string>(server.backupKeep == null ? "" : String(server.backupKeep));
  const [savingKeep, setSavingKeep] = useState(false);
  const [keepSaved, setKeepSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const uploadInput = useRef<HTMLInputElement>(null);

  const refresh = useCallback(() => {
    apiGet<Snapshot[]>(`/servers/${serverId}/backups`).then(setBackups).catch(() => undefined);
  }, [serverId]);
  useEffect(() => refresh(), [refresh]);
  useEffect(() => setKeep(server.backupKeep == null ? "" : String(server.backupKeep)), [server.backupKeep]);

  const keepDirty = (server.backupKeep == null ? "" : String(server.backupKeep)) !== keep.trim();
  const keepValid =
    keep.trim() === "" || (Number.isInteger(Number(keep)) && Number(keep) >= 1 && Number(keep) <= KEEP_MAX);

  const saveKeep = async () => {
    setSavingKeep(true);
    try {
      await apiPatch(`/servers/${serverId}`, { backupKeep: keep.trim() === "" ? null : Number(keep) });
      setKeepSaved(true);
      setTimeout(() => setKeepSaved(false), 1500);
      onChanged();
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setSavingKeep(false);
    }
  };

  const create = async () => {
    setBusy(true);
    try {
      await apiPost(`/servers/${serverId}/backups`);
      refresh();
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const restore = async (id: string) => {
    if (!confirm("Restore this backup? The server must be stopped; current saves are snapshotted first.")) return;
    await apiPost(`/servers/${serverId}/backups/${id}/restore`).catch((e) => alert(e.message));
  };

  const remove = async (id: string) => {
    await apiDelete(`/backups/${id}`).catch(() => undefined);
    refresh();
  };

  const download = async (b: Snapshot) => {
    setDownloading(b.id);
    try {
      await apiDownload(`/servers/${serverId}/backups/${b.id}/download`, `backup-${b.id}.tar.gz`);
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setDownloading(null);
    }
  };

  const upload = async (f: File) => {
    if (
      !confirm(
        "Import this saves archive? The server must be stopped. Current saves are replaced (a pre-import snapshot is taken first).",
      )
    )
      return;
    setUploading(true);
    try {
      await apiUpload(`/servers/${serverId}/backups/upload`, f);
      refresh();
      alert("Saves imported. Start the server to load them.");
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-slate-400">
          Backups copy the saved world. Scheduled and disruptive actions snapshot
          automatically; backups you take here are kept until you delete them.
        </p>
        <div className="flex gap-2">
          <button className="btn-secondary" onClick={() => uploadInput.current?.click()} disabled={uploading}>
            {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}{" "}
            {uploading ? "Importing…" : "Import saves"}
          </button>
          <input
            ref={uploadInput}
            type="file"
            accept=".tar.gz,.tgz,application/gzip"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void upload(f);
              e.target.value = "";
            }}
          />
          <button className="btn-primary" onClick={create} disabled={busy}>
            <DatabaseBackup className="h-4 w-4" /> {busy ? "Backing up…" : "Back up now"}
          </button>
        </div>
      </div>

      {/* Retention is per-server: save sizes and how much history is worth keeping
          differ wildly between games. The global setting covers Palisade's own
          database backups instead. */}
      <div className="card flex flex-wrap items-center gap-3">
        <label className="text-sm text-slate-300" htmlFor="backup-keep">
          Keep last
        </label>
        <input
          id="backup-keep"
          type="number"
          min={1}
          max={KEEP_MAX}
          placeholder={`${KEEP_DEFAULT}`}
          className={`input w-24 ${keepValid ? "" : "border-rose-500/60"}`}
          value={keep}
          onChange={(e) => setKeep(e.target.value)}
        />
        <span className="text-sm text-slate-300">automatic backups for this server</span>
        {keepDirty && (
          <button className="btn-primary text-xs" disabled={!keepValid || savingKeep} onClick={() => void saveKeep()}>
            {savingKeep ? "Saving…" : "Save"}
          </button>
        )}
        {keepSaved && <span className="text-xs text-emerald-400">Saved</span>}
        <p className="w-full text-[11px] leading-snug text-slate-500">
          Leave blank for the default ({KEEP_DEFAULT}). Anything from 1 to {KEEP_MAX} works. Only
          automatic backups are counted and rotated — the ones you take with{" "}
          <span className="text-slate-400">Back up now</span> are never removed by retention.
        </p>
      </div>

      {backups.length === 0 ? (
        <div className="card text-slate-400">
          No backups yet. You can also import a saves archive (.tar.gz, as produced by Download) onto a
          stopped server.
        </div>
      ) : (
        <div className="space-y-2">
          {backups.map((b) => (
            <div key={b.id} className="card flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Archive className="h-5 w-5 text-ark-accent2" />
                <div>
                  <div className="font-medium">{new Date(b.createdAt).toLocaleString()}</div>
                  <div className="flex items-center gap-1.5 text-xs text-slate-500">
                    {b.reason}
                    {b.reason === "manual" && (
                      <span
                        className="rounded bg-slate-700/60 px-1.5 py-0.5 text-[10px] text-slate-300"
                        title="Backups you take yourself are never removed by retention — delete this one when you no longer want it."
                      >
                        kept
                      </span>
                    )}
                  </div>
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  className="btn-secondary px-2"
                  title="Download this backup (tar.gz)"
                  onClick={() => download(b)}
                  disabled={downloading === b.id}
                >
                  {downloading === b.id ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Download className="h-4 w-4" />
                  )}
                </button>
                <button className="btn-secondary" onClick={() => restore(b.id)}>
                  <RotateCcw className="h-4 w-4" /> Restore
                </button>
                <button className="btn-danger px-2" onClick={() => remove(b.id)}>
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
