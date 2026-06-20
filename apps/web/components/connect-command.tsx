"use client";
import { useEffect, useState } from "react";
import { Copy, Check, Terminal, Lock } from "lucide-react";

/**
 * Join-over-LAN helper.
 *
 * OPEN server: a copyable `open <ip>:<gameport>` console command. The IP is the
 * host the manager is served on (manager + game containers share the box), so it
 * connects straight across the LAN — no EOS/public-IP round-trip.
 *
 * PASSWORD-PROTECTED server: ARK's console `open` command CANNOT pass a join
 * password (confirmed ARK limitation — it always rejects with "invalid server
 * password", regardless of ?Password= / ?ServerPassword= / etc.). So instead we
 * surface the password (copyable, to paste into the in-game "Password Required"
 * prompt) and point at the Unofficial-list method.
 */
export function ConnectCommand({
  gamePort,
  joinPassword,
  className = "",
}: {
  gamePort: number;
  /** Server join password, if set. Changes this from a console command to a
   *  copyable password + browser-join instructions (console can't pass it). */
  joinPassword?: string | null;
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
  // Password case copies the password (for the in-game prompt); otherwise the command.
  const copyText = joinPassword || cmd;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(copyText);
    } catch {
      // navigator.clipboard needs a secure context (https/localhost); the
      // manager is usually served over plain http on a LAN IP, so fall back.
      const ta = document.createElement("textarea");
      ta.value = copyText;
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

  const copyTag = copied ? (
    <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-ark-accent">
      <Check className="h-3.5 w-3.5" /> Copied
    </span>
  ) : (
    <span className="flex shrink-0 items-center gap-1 text-xs text-slate-400 group-hover:text-slate-200">
      <Copy className="h-3.5 w-3.5" /> Copy
    </span>
  );

  if (joinPassword) {
    return (
      <div className={className}>
        <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-slate-400">
          <Lock className="h-3.5 w-3.5" /> Join password
        </div>
        <button
          type="button"
          onClick={copy}
          title="Copy the join password to paste into ARK's Password Required prompt"
          className="group flex w-full items-center gap-2 rounded-md border border-ark-border bg-ark-bg px-2.5 py-1.5 text-left transition-colors hover:border-slate-600"
        >
          <span className="flex-1 truncate font-mono text-sm text-slate-200">{joinPassword}</span>
          {copyTag}
        </button>
        <p className="mt-1 text-[11px] leading-snug text-slate-500">
          ARK cannot pass a password through the console, so the <span className="font-mono">open</span>{" "}
          command will not work. Find the server on the Unofficial list (below) and paste this password
          when prompted.
        </p>
      </div>
    );
  }

  return (
    <div className={className}>
      <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-slate-400">
        <Terminal className="h-3.5 w-3.5" /> Join over LAN (direct)
      </div>
      <button
        type="button"
        onClick={copy}
        title="Copy, then paste into the ARK console (~ key) and press Enter to connect directly over your local network"
        className="group flex w-full items-center gap-2 rounded-md border border-ark-border bg-ark-bg px-2.5 py-1.5 text-left transition-colors hover:border-slate-600"
      >
        <span className="flex-1 truncate font-mono text-sm text-slate-200">{cmd}</span>
        {copyTag}
      </button>
      <p className="mt-1 text-[11px] leading-snug text-slate-500">
        Open the ARK console (<kbd className="rounded bg-ark-panel px-1 font-mono">~</kbd>), paste, press
        Enter.
      </p>
    </div>
  );
}
