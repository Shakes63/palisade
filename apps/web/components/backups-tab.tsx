"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Archive, DatabaseBackup, Download, RotateCcw, Trash2, Upload, Loader2 } from "lucide-react";
import { apiDelete, apiDownload, apiGet, apiPatch, apiPost, apiUpload } from "@/lib/api";
import type { ServerSummary } from "@ark/shared";
import { fmtLocal } from "@/lib/cron";
import { fmtBytes } from "@/lib/mod-format";
import { confirmDialog, toast } from "@/components/dialogs";

/** Matches the API's own bound and the built-in default when a server sets none. */
const KEEP_MAX = 500;
const KEEP_DEFAULT = 10;

interface Snapshot {
  id: string;
  reason: string;
  path: string;
  sizeBytes: number | null;
  createdAt: string;
}

const REASON_LABELS: Record<string, string> = {
  manual: "Manual",
  scheduled: "Scheduled",
  "pre-restart": "Before restart",
  "pre-stop": "Before stop",
  "pre-update": "Before game update",
  "pre-update-mods": "Before mod update",
  "pre-import": "Before import",
  "pre-restore": "Before restore",
};
const reasonLabel = (r: string) => REASON_LABELS[r] ?? r.charAt(0).toUpperCase() + r.slice(1).replace(/-/g, " ");

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
      toast.error(err);
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
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  const restore = async (id: string) => {
    if (
      !(await confirmDialog({
        title: "Restore this backup?",
        body: "The server must be stopped; current saves are snapshotted first.",
        confirmLabel: "Restore",
      }))
    )
      return;
    await apiPost(`/servers/${serverId}/backups/${id}/restore`).catch(toast.error);
  };

  const remove = async (b: Snapshot) => {
    if (
      !(await confirmDialog({
        title: `Delete the backup from ${fmtLocal(b.createdAt)}?`,
        body: "It can't be recovered.",
        confirmLabel: "Delete",
        danger: true,
      }))
    )
      return;
    await apiDelete(`/backups/${b.id}`).catch(toast.error);
    refresh();
  };

  const download = async (b: Snapshot) => {
    setDownloading(b.id);
    try {
      await apiDownload(`/servers/${serverId}/backups/${b.id}/download`, `backup-${b.id}.tar.gz`);
    } catch (e) {
      toast.error(e);
    } finally {
      setDownloading(null);
    }
  };

  const upload = async (f: File) => {
    if (
      !(await confirmDialog({
        title: "Import this saves archive?",
        body: "The server must be stopped. Current saves are replaced (a pre-import snapshot is taken first).",
        confirmLabel: "Import",
        danger: true,
      }))
    )
      return;
    setUploading(true);
    try {
      await apiUpload(`/servers/${serverId}/backups/upload`, f);
      refresh();
      toast.success("Saves imported. Start the server to load them.");
    } catch (e) {
      toast.error(e);
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
        <div className="card text-sm text-slate-400">
          No backups yet. You can also import a saves archive (.tar.gz, as produced by Download) onto a
          stopped server.
        </div>
      ) : (
        <div className="space-y-2">
          {backups.map((b) => (
            <div key={b.id} className="card flex flex-wrap items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3">
                <Archive className="h-5 w-5 shrink-0 text-ark-accent2" />
                <div className="min-w-0">
                  <div className="font-medium">{fmtLocal(b.createdAt)}</div>
                  <div className="flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
                    {reasonLabel(b.reason)}
                    {fmtBytes(b.sizeBytes) && <span>· {fmtBytes(b.sizeBytes)}</span>}
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
              <div className="flex shrink-0 gap-2">
                <button
                  className="btn-secondary px-2"
                  title="Download this backup (tar.gz)"
                  aria-label="Download backup"
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
                <button className="btn-remove" title="Delete this backup" aria-label="Delete backup" onClick={() => remove(b)}>
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
