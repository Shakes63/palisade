"use client";
import { useEffect, useRef, useState } from "react";
import { RefreshCw, ScrollText, Filter, Download } from "lucide-react";
import { apiGet } from "@/lib/api";
import { useRealtime } from "@/lib/socket";
import { isEngineNoise } from "@/lib/log-noise";

const MAX_LINES = 6000;
const NOISE_PREF = "ark.hideEngineNoise";

/** Full log of the current run, captured server-side — complete whether or not
 *  this tab was open, kept across refreshes/tab switches, wiped on the next Start. */
export function LogsTab({ serverId }: { serverId: string }) {
  const [lines, setLines] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [hideNoise, setHideNoise] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);

  // Remember the filter preference across refreshes/tabs.
  useEffect(() => setHideNoise(localStorage.getItem(NOISE_PREF) === "1"), []);
  const toggleNoise = () =>
    setHideNoise((v) => {
      localStorage.setItem(NOISE_PREF, v ? "0" : "1");
      return !v;
    });

  const visible = hideNoise ? lines.filter((l) => !isEngineNoise(l)) : lines;
  const hidden = lines.length - visible.length;

  const scrollToBottom = () =>
    requestAnimationFrame(() => {
      if (boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
    });

  const load = () => {
    setLoading(true);
    apiGet<{ log: string }>(`/servers/${serverId}/logs`)
      .then(({ log }) => {
        setLines(log ? log.split("\n") : []);
        scrollToBottom();
      })
      .catch(() => undefined)
      .finally(() => setLoading(false));
  };
  useEffect(load, [serverId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Save the captured log as a text file through the browser (client-side blob —
  // the lines are already in memory).
  const downloadLog = () => {
    const blob = new Blob([lines.join("\n")], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `server-${serverId.slice(-6)}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.log`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  // Append live lines; only auto-scroll when already at the bottom.
  useRealtime((msg) => {
    if (msg.serverId === serverId && msg.topic === "server.log") {
      setLines((prev) => [...prev.slice(-(MAX_LINES - 1)), (msg.payload as { line: string }).line]);
      if (atBottom.current) scrollToBottom();
    }
  }, serverId);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <button className="btn-secondary" onClick={load} disabled={loading}>
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} /> Refresh
        </button>
        <button
          className={`btn-secondary ${hideNoise ? "border-ark-accent text-ark-accent" : ""}`}
          onClick={toggleNoise}
          title="Hide known-benign Conan/Unreal engine log spam"
        >
          <Filter className="h-4 w-4" />
          {hideNoise ? `Engine noise hidden${hidden ? ` (${hidden})` : ""}` : "Hide engine noise"}
        </button>
        <button className="btn-secondary" onClick={downloadLog} disabled={lines.length === 0} title="Save the captured log as a .log file">
          <Download className="h-4 w-4" /> Download
        </button>
        <span className="flex items-center gap-1 text-xs text-slate-500">
          <ScrollText className="h-3.5 w-3.5" /> Full log of the current run — kept until the next Start.
        </span>
      </div>
      <div
        ref={boxRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        className="h-[32rem] overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-ark-border bg-black/40 p-3 font-mono text-xs leading-relaxed"
      >
        {visible.length === 0 ? (
          <span className="text-slate-500">
            {lines.length === 0
              ? "No log captured yet — start the server to capture this run."
              : "Every captured line is engine noise — toggle the filter off to see them."}
          </span>
        ) : (
          visible.join("\n")
        )}
      </div>
    </div>
  );
}
