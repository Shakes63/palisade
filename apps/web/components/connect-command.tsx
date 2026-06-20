"use client";
import { useEffect, useState } from "react";
import { Copy, Check, Terminal } from "lucide-react";

/**
 * Copyable ARK direct-connect command for joining a server over the LAN.
 *
 * The IP is taken from the host the manager is served on
 * (window.location.hostname): the manager and the game containers run on the
 * same box, so that host is the server's local address. Pasting
 * `open <ip>:<gameport>` into the ARK console (Tab) connects straight across
 * the LAN — bypassing EOS/the public IP, so there's no NAT-reflection
 * round-trip and the lowest possible latency for same-network play.
 */
export function ConnectCommand({
  gamePort,
  className = "",
}: {
  gamePort: number;
  className?: string;
}) {
  const [host, setHost] = useState("");
  const [copied, setCopied] = useState(false);

  // Resolve the host after mount (not during render) so SSR and the first
  // client render agree — avoids a hydration mismatch.
  useEffect(() => {
    setHost(window.location.hostname);
  }, []);

  const cmd = `open ${host || "<server-ip>"}:${gamePort}`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(cmd);
    } catch {
      // navigator.clipboard needs a secure context (https/localhost); the
      // manager is usually served over plain http on a LAN IP, so fall back.
      const ta = document.createElement("textarea");
      ta.value = cmd;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      try {
        document.execCommand("copy");
      } catch {
        /* ignore — the text is still selectable for a manual copy */
      }
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className={className}>
      <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-slate-400">
        <Terminal className="h-3.5 w-3.5" /> Join over LAN (direct)
      </div>
      <button
        type="button"
        onClick={copy}
        title="Copy, then paste into the ARK console (Tab) and press Enter to connect directly over your local network"
        className="group flex w-full items-center gap-2 rounded-md border border-ark-border bg-ark-bg px-2.5 py-1.5 text-left transition-colors hover:border-slate-600"
      >
        <span className="flex-1 truncate font-mono text-sm text-slate-200">{cmd}</span>
        {copied ? (
          <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-ark-accent">
            <Check className="h-3.5 w-3.5" /> Copied
          </span>
        ) : (
          <span className="flex shrink-0 items-center gap-1 text-xs text-slate-400 group-hover:text-slate-200">
            <Copy className="h-3.5 w-3.5" /> Copy
          </span>
        )}
      </button>
      <p className="mt-1 text-[11px] leading-snug text-slate-500">
        Open the ARK console (<kbd className="rounded bg-ark-panel px-1 font-mono">Tab</kbd>), paste, press
        Enter.
      </p>
    </div>
  );
}
