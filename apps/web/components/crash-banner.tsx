"use client";
import { useState } from "react";
import { AlertTriangle, ChevronDown, Copy, Check } from "lucide-react";
import { ServerState, type ServerSummary } from "@ark/shared";

/**
 * Shown at the top of a Crashed server's Overview: explains WHY the container
 * died (exit code / OOM + a log tail, or the launch error) instead of leaving a
 * bare "Crashed" badge. Invaluable when e.g. a pinned image won't boot. Renders
 * nothing unless the server is Crashed and the API captured a reason.
 */
export function CrashBanner({ server }: { server: ServerSummary }) {
  const [open, setOpen] = useState(true);
  const [copied, setCopied] = useState(false);
  if (server.state !== ServerState.Crashed || !server.crashReason) return null;

  // The reason is "<summary line>\n\n<log tail>" — split so the summary reads as
  // a headline and the (often long) tail lives in a scrollable, copyable block.
  const [summary, ...rest] = server.crashReason.split("\n");
  const detail = rest.join("\n").trim();

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(server.crashReason ?? "");
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — no-op */
    }
  };

  return (
    <div className="rounded-lg border border-rose-900/60 bg-rose-950/30 p-4">
      <div className="flex items-start gap-2.5">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-rose-400" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-rose-200">Last start failed</h3>
            {detail && (
              <button
                className="flex items-center gap-1 text-[11px] text-rose-300/80 hover:text-rose-200"
                onClick={() => setOpen((v) => !v)}
              >
                {open ? "Hide" : "Show"} log
                <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
              </button>
            )}
          </div>
          <p className="mt-1 text-sm leading-snug text-rose-100/90">{summary}</p>

          {detail && open && (
            <div className="relative mt-3">
              <button
                className="absolute right-2 top-2 flex items-center gap-1 rounded bg-slate-800/80 px-1.5 py-0.5 text-[11px] text-slate-300 hover:bg-slate-700"
                onClick={copy}
                title="Copy full reason"
              >
                {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
                {copied ? "Copied" : "Copy"}
              </button>
              <pre className="max-h-56 overflow-auto rounded-md border border-rose-900/40 bg-black/40 p-3 pr-16 font-mono text-[11px] leading-relaxed text-slate-300">
                {detail}
              </pre>
            </div>
          )}
          <p className="mt-2 text-[11px] leading-snug text-rose-300/70">
            The container the server ran in exited. Fix the underlying cause (e.g. a pinned image
            version, config, or resources), then start it again. The full log is under the Logs tab.
          </p>
        </div>
      </div>
    </div>
  );
}
