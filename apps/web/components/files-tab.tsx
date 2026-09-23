"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Folder,
  File as FileIcon,
  Download,
  Upload,
  Trash2,
  Save,
  Loader2,
  FolderPlus,
  Pencil,
  ChevronRight,
  RefreshCw,
  X,
} from "lucide-react";
import { apiGet, apiPost, apiPut, apiDelete, apiDownload, apiUpload } from "@/lib/api";
import { fmtLocal } from "@/lib/cron";
import { confirmDialog } from "@/components/dialogs";

type Entry = { name: string; type: "dir" | "file"; size: number; modifiedAt: string };
type Listing = { path: string; entries: Entry[]; truncated: boolean };

const fmtSize = (n: number) => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
};

const joinPath = (dir: string, name: string) => (dir === "." || dir === "" ? name : `${dir}/${name}`);

/**
 * Per-server file manager over the instance directory: browse, edit text configs
 * in place, upload/download, rename/delete. Server-side sandboxed to the instance
 * root (traversal + symlink escapes rejected). Operator+ only — the API enforces it;
 * the tab is hidden for viewers.
 */
export function FilesTab({ serverId }: { serverId: string }) {
  const [dir, setDir] = useState(".");
  const [listing, setListing] = useState<Listing | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Editor state: which file is open, its buffer, and dirtiness.
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [saving, setSaving] = useState(false);
  const uploadInput = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async (path: string) => {
    setErr(null);
    try {
      setListing(await apiGet<Listing>(`/servers/${serverId}/files?path=${encodeURIComponent(path)}`));
      setDir(path);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [serverId]);

  useEffect(() => {
    void refresh(".");
  }, [refresh]);

  const openEditor = async (path: string) => {
    if (openFile !== null && path !== openFile && content !== savedContent && !(await confirmDialog({ title: "Discard unsaved changes?", confirmLabel: "Discard", danger: true })))
      return;
    setErr(null);
    setBusy(true);
    try {
      const r = await apiGet<{ content: string }>(
        `/servers/${serverId}/files/content?path=${encodeURIComponent(path)}`,
      );
      setOpenFile(path);
      setContent(r.content);
      setSavedContent(r.content);
    } catch (e) {
      setOpenFile(null);
      setErr(`${path}: ${(e as Error).message}`); // binary / too large → surfaced here, download still works
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (openFile === null) return;
    setSaving(true);
    setErr(null);
    try {
      await apiPut(`/servers/${serverId}/files/content`, { path: openFile, content });
      setSavedContent(content);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      await refresh(dir);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const crumbs = dir === "." ? [] : dir.split("/");
  const dirty = content !== savedContent;

  return (
    <div className="space-y-3">
      <p className="text-[11px] leading-snug text-slate-500">
        The server&apos;s folder — game install, saves, and configs. Edits apply on the
        next restart. Careful: this is the raw filesystem; the Settings tab is the safer way to
        change anything it covers.
      </p>
      {err && <div className="card border-rose-500/40 text-sm text-rose-300">{err}</div>}

      {/* ── Breadcrumbs + actions ─────────────────────────────────────────── */}
      <div className="card flex flex-wrap items-center gap-2 py-2">
        <button className="font-mono text-xs text-ark-accent hover:underline" onClick={() => void refresh(".")}>
          /
        </button>
        {crumbs.map((c, i) => (
          <span key={i} className="flex items-center gap-1">
            <ChevronRight className="h-3 w-3 text-slate-600" />
            <button
              className="font-mono text-xs text-ark-accent hover:underline"
              onClick={() => void refresh(crumbs.slice(0, i + 1).join("/"))}
            >
              {c}
            </button>
          </span>
        ))}
        <span className="flex-1" />
        <button className="btn-secondary whitespace-nowrap" disabled={busy} onClick={() => void refresh(dir)}>
          <RefreshCw className="h-4 w-4 shrink-0" /> Refresh
        </button>
        <button
          className="btn-secondary whitespace-nowrap"
          disabled={busy}
          onClick={() => {
            const name = prompt("New folder name:");
            if (name) void act(() => apiPost(`/servers/${serverId}/files/mkdir`, { path: joinPath(dir, name) }));
          }}
        >
          <FolderPlus className="h-4 w-4 shrink-0" /> New folder
        </button>
        <button className="btn-secondary whitespace-nowrap" disabled={busy} onClick={() => uploadInput.current?.click()}>
          {busy ? <Loader2 className="h-4 w-4 shrink-0 animate-spin" /> : <Upload className="h-4 w-4 shrink-0" />} Upload
        </button>
        <input
          ref={uploadInput}
          type="file"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void act(() => apiUpload(`/servers/${serverId}/files/upload?path=${encodeURIComponent(dir)}`, f));
            e.target.value = "";
          }}
        />
      </div>

      {/* ── Listing ───────────────────────────────────────────────────────── */}
      <div className="card p-0">
        {listing?.truncated && (
          <p className="border-b border-ark-border px-3 py-1.5 text-[11px] text-amber-400">
            Large directory — showing the first 2000 entries.
          </p>
        )}
        <table className="w-full table-fixed text-sm">
          <colgroup>
            <col />
            <col className="w-20" />
            <col className="w-0 sm:w-48" />
            <col className="w-24" />
          </colgroup>
          <tbody>
            {dir !== "." && (
              <tr className="border-b border-ark-border/40 hover:bg-slate-800/40">
                <td className="cursor-pointer px-3 py-1.5" colSpan={4}
                    onClick={() => void refresh(crumbs.slice(0, -1).join("/") || ".")}>
                  <span className="flex items-center gap-2 text-slate-400"><Folder className="h-4 w-4" /> ..</span>
                </td>
              </tr>
            )}
            {(listing?.entries ?? []).map((e) => (
              <tr key={e.name} className="border-b border-ark-border/40 hover:bg-slate-800/40">
                <td
                  className="cursor-pointer px-3 py-1.5"
                  onClick={() =>
                    e.type === "dir" ? void refresh(joinPath(dir, e.name)) : void openEditor(joinPath(dir, e.name))
                  }
                >
                  <span className="flex min-w-0 items-center gap-2">
                    {e.type === "dir" ? (
                      <Folder className="h-4 w-4 shrink-0 text-ark-accent2" />
                    ) : (
                      <FileIcon className="h-4 w-4 shrink-0 text-slate-500" />
                    )}
                    <span className="truncate font-mono text-xs" title={e.name}>{e.name}</span>
                  </span>
                </td>
                <td className="whitespace-nowrap px-2 py-1.5 text-right font-mono text-[11px] text-slate-500">
                  {e.type === "file" ? fmtSize(e.size) : ""}
                </td>
                <td className="whitespace-nowrap py-1.5 text-right font-mono text-[11px] text-slate-500 sm:px-2">
                  <span className="hidden sm:inline">{fmtLocal(e.modifiedAt)}</span>
                </td>
                <td className="px-2 py-1.5">
                  <span className="flex items-center justify-end gap-2">
                    {e.type === "file" && (
                      <button
                        className="text-slate-500 hover:text-ark-accent"
                        title="Download"
                        onClick={() =>
                          void apiDownload(
                            `/servers/${serverId}/files/download?path=${encodeURIComponent(joinPath(dir, e.name))}`,
                            e.name,
                          )
                        }
                      >
                        <Download className="h-4 w-4" />
                      </button>
                    )}
                    <button
                      className="text-slate-500 hover:text-ark-accent"
                      title="Rename"
                      onClick={() => {
                        const to = prompt(`Rename "${e.name}" to:`, e.name);
                        if (to && to !== e.name)
                          void act(() =>
                            apiPost(`/servers/${serverId}/files/rename`, {
                              from: joinPath(dir, e.name),
                              to: joinPath(dir, to),
                            }),
                          );
                      }}
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                    <button
                      className="btn-remove"
                      title="Delete"
                      onClick={async () => {
                        if (
                          await confirmDialog({
                            title: `Delete "${e.name}"${e.type === "dir" ? " and everything inside it" : ""}?`,
                            confirmLabel: "Delete",
                            danger: true,
                          })
                        )
                          void act(() =>
                            apiDelete(`/servers/${serverId}/files?path=${encodeURIComponent(joinPath(dir, e.name))}`),
                          );
                      }}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </span>
                </td>
              </tr>
            ))}
            {listing && listing.entries.length === 0 && (
              <tr>
                <td className="px-3 py-4 text-center text-sm text-slate-400" colSpan={4}>
                  {dir === "." ? "Empty — game files appear here after the first install/start." : "This folder is empty."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* ── Editor ────────────────────────────────────────────────────────── */}
      {openFile !== null && (
        <div className="card space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate font-mono text-xs text-slate-300">{openFile}{dirty ? " •" : ""}</span>
            <span className="flex items-center gap-2">
              <button className="btn-primary text-xs" disabled={saving || !dirty} onClick={() => void save()}>
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />} Save
              </button>
              <button
                className="btn-secondary text-xs"
                onClick={async () => {
                  if (!dirty || (await confirmDialog({ title: "Discard unsaved changes?", confirmLabel: "Discard", danger: true }))) setOpenFile(null);
                }}
              >
                <X className="h-3.5 w-3.5" /> Close
              </button>
            </span>
          </div>
          <textarea
            className="h-96 w-full resize-y rounded-lg border border-ark-border bg-ark-bg p-3 font-mono text-xs leading-relaxed outline-none focus:border-ark-accent2"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            spellCheck={false}
          />
          <p className="text-[11px] text-slate-500">Restart the server to apply config changes.</p>
        </div>
      )}
    </div>
  );
}
