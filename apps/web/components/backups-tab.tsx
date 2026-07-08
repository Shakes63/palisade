"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Archive, DatabaseBackup, Download, RotateCcw, Trash2, Upload, Loader2 } from "lucide-react";
import { apiDelete, apiDownload, apiGet, apiPost, apiUpload } from "@/lib/api";

interface Snapshot {
  id: string;
  reason: string;
  path: string;
  createdAt: string;
}

export function BackupsTab({ serverId }: { serverId: string }) {
  const [backups, setBackups] = useState<Snapshot[]>([]);
  const [busy, setBusy] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const uploadInput = useRef<HTMLInputElement>(null);

  const refresh = useCallback(() => {
    apiGet<Snapshot[]>(`/servers/${serverId}/backups`).then(setBackups).catch(() => undefined);
  }, [serverId]);
  useEffect(() => refresh(), [refresh]);

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
          Backups copy the saved world. The newest 10 are kept; scheduled/disruptive actions
          snapshot automatically.
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
                  <div className="text-xs text-slate-500">{b.reason}</div>
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
