"use client";
import { useEffect, useState } from "react";
import { Copy, Check, Terminal, Lock } from "lucide-react";
import { Game } from "@ark/shared";

/** A copyable mono value with its own copy state + clipboard fallback (the
 *  manager is usually served over plain http on a LAN IP, where
 *  navigator.clipboard is unavailable). */
function CopyRow({ value, title }: { value: string; title?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = value;
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
    <button
      type="button"
      onClick={copy}
      title={title}
      className="group flex w-full items-center gap-2 rounded-md border border-ark-border bg-ark-bg px-2.5 py-1.5 text-left transition-colors hover:border-slate-600"
    >
      <span className="flex-1 truncate font-mono text-sm text-slate-200">{value}</span>
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
  );
}

/**
 * Join helper, tailored per game (manager + game containers share the box, so the
 * address is the host the manager is served on — a straight LAN join).
 *
 * ARK (ASA/ASE): a copyable `open <ip>:<gameport>` console command. ARK's console
 * CANNOT pass a join password (confirmed limitation — it always rejects with
 * "invalid server password"), so a password-protected server instead surfaces the
 * password to paste into the in-game prompt + the Unofficial-list method.
 *
 * Conan: there's no `open` console — players use the in-game Direct Connect, which
 * (unlike ARK) takes the QUERY port and accepts the password at the prompt.
 */
export function ConnectCommand({
  game,
  gamePort,
  queryPort,
  joinPassword,
  className = "",
}: {
  game: Game;
  gamePort: number;
  /** Steam query port — Conan's Direct Connect uses this, not the game port. */
  queryPort?: number;
  /** Server join password, if set. */
  joinPassword?: string | null;
  className?: string;
}) {
  const [host, setHost] = useState("");
  // Resolve the host after mount (not during render) so SSR and the first client
  // render agree — avoids a hydration mismatch.
  useEffect(() => setHost(window.location.hostname), []);
  const hostOr = host || "<server-ip>";

  if (game === Game.CONAN) {
    return (
      <div className={className}>
        <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-slate-400">
          <Terminal className="h-3.5 w-3.5" /> Direct Connect (in-game)
        </div>
        <CopyRow value={`${hostOr}:${queryPort ?? gamePort}`} title="Paste into Conan's Direct Connect" />
        <p className="mt-1 text-[11px] leading-snug text-slate-500">
          In Conan: <span className="font-mono">Server list → Direct Connect</span>, paste this. Conan&apos;s
          Direct Connect uses the <em>query</em> port. Online, friends use your public IP with the same port,
          or just search the server browser for the name.
        </p>
        {joinPassword && (
          <div className="mt-3">
            <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-slate-400">
              <Lock className="h-3.5 w-3.5" /> Join password
            </div>
            <CopyRow value={joinPassword} title="Copy the join password" />
            <p className="mt-1 text-[11px] leading-snug text-slate-500">
              Enter this when Conan prompts for the server password.
            </p>
          </div>
        )}
      </div>
    );
  }

  if (game === Game.PALWORLD) {
    return (
      <div className={className}>
        <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-slate-400">
          <Terminal className="h-3.5 w-3.5" /> Connect by IP (in-game)
        </div>
        <CopyRow value={`${hostOr}:${gamePort}`} title="Paste into Palworld's Join with IP" />
        <p className="mt-1 text-[11px] leading-snug text-slate-500">
          In Palworld: <span className="font-mono">Join Multiplayer Game (Dedicated) → Connect with IP</span>,
          paste this. Online, friends use your public IP with the same port.
        </p>
        {joinPassword && (
          <div className="mt-3">
            <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-slate-400">
              <Lock className="h-3.5 w-3.5" /> Join password
            </div>
            <CopyRow value={joinPassword} title="Copy the join password" />
            <p className="mt-1 text-[11px] leading-snug text-slate-500">
              Enter this when Palworld prompts for the server password.
            </p>
          </div>
        )}
      </div>
    );
  }

  if (game === Game.ICARUS) {
    return (
      <div className={className}>
        <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-slate-400">
          <Terminal className="h-3.5 w-3.5" /> Join by IP (in-game)
        </div>
        <CopyRow value={`${hostOr}:${gamePort}`} title="Paste into Icarus's Join IP" />
        <p className="mt-1 text-[11px] leading-snug text-slate-500">
          In Icarus: <span className="font-mono">Play → Join IP</span>, paste this. Or find it in the in-game
          server browser by name. Online, friends use your public IP with the same port.
        </p>
        {joinPassword && (
          <div className="mt-3">
            <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-slate-400">
              <Lock className="h-3.5 w-3.5" /> Join password
            </div>
            <CopyRow value={joinPassword} title="Copy the join password" />
            <p className="mt-1 text-[11px] leading-snug text-slate-500">
              Enter this when Icarus prompts for the server password.
            </p>
          </div>
        )}
      </div>
    );
  }

  if (game === Game.SEVEN_DAYS) {
    return (
      <div className={className}>
        <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-slate-400">
          <Terminal className="h-3.5 w-3.5" /> Connect (in-game)
        </div>
        <CopyRow value={`${hostOr}:${gamePort}`} title="7 Days to Die connect address" />
        <p className="mt-1 text-[11px] leading-snug text-slate-500">
          In 7 Days to Die: <span className="font-mono">Join a Game → Connect to Server</span> (IP{" "}
          <span className="font-mono">{hostOr}</span>, port <span className="font-mono">{gamePort}</span>), or
          search the server browser by name. Online, friends use your public IP.
        </p>
        {joinPassword && (
          <div className="mt-3">
            <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-slate-400">
              <Lock className="h-3.5 w-3.5" /> Join password
            </div>
            <CopyRow value={joinPassword} title="Copy the join password" />
            <p className="mt-1 text-[11px] leading-snug text-slate-500">Enter this when it prompts.</p>
          </div>
        )}
      </div>
    );
  }

  if (game === Game.VALHEIM) {
    return (
      <div className={className}>
        <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-slate-400">
          <Terminal className="h-3.5 w-3.5" /> Join by IP (in-game)
        </div>
        <CopyRow value={`${hostOr}:${gamePort}`} title="Paste into Valheim's Join IP" />
        <p className="mt-1 text-[11px] leading-snug text-slate-500">
          In Valheim: <span className="font-mono">Start Game → (character) → Join Game → Join IP</span>, paste
          this. Or search the <span className="font-mono">Community</span> server list by name. Online, friends
          use your public IP.
        </p>
        {joinPassword && (
          <div className="mt-3">
            <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-slate-400">
              <Lock className="h-3.5 w-3.5" /> Join password
            </div>
            <CopyRow value={joinPassword} title="Copy the join password" />
            <p className="mt-1 text-[11px] leading-snug text-slate-500">
              Valheim always requires a password — enter this when it prompts.
            </p>
          </div>
        )}
      </div>
    );
  }

  if (game === Game.ENSHROUDED) {
    return (
      <div className={className}>
        <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-slate-400">
          <Terminal className="h-3.5 w-3.5" /> Join by IP (in-game)
        </div>
        <CopyRow value={`${hostOr}:${gamePort}`} title="Paste into Enshrouded's Join IP" />
        <p className="mt-1 text-[11px] leading-snug text-slate-500">
          In Enshrouded: <span className="font-mono">Play → Server List → Join IP</span>, paste this. Or search
          the server list by name. Online, friends use your public IP with the same port.
        </p>
        {joinPassword && (
          <div className="mt-3">
            <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-slate-400">
              <Lock className="h-3.5 w-3.5" /> Join password
            </div>
            <CopyRow value={joinPassword} title="Copy the join password" />
            <p className="mt-1 text-[11px] leading-snug text-slate-500">
              Enter this to join as <span className="text-slate-300">Guest</span>. For admin rights, append{" "}
              <span className="font-mono">-admin</span> to it.
            </p>
          </div>
        )}
      </div>
    );
  }

  if (game === Game.LIF) {
    return (
      <div className={className}>
        <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-slate-400">
          <Terminal className="h-3.5 w-3.5" /> Join by IP (in-game)
        </div>
        <CopyRow value={`${hostOr}:${gamePort}`} title="Server IP + port for LiF's Custom IP connect" />
        <p className="mt-1 text-[11px] leading-snug text-slate-500">
          In Life is Feudal: Your Own: <span className="font-mono">Multiplayer → server list</span> — search by
          name, or use <span className="font-mono">Connect to custom IP</span> with this address. Online,
          friends use your public IP with the same port.
        </p>
        {joinPassword && (
          <div className="mt-3">
            <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-slate-400">
              <Lock className="h-3.5 w-3.5" /> Join password
            </div>
            <CopyRow value={joinPassword} title="Copy the join password" />
            <p className="mt-1 text-[11px] leading-snug text-slate-500">
              Enter this when it prompts. (Applies from the second server start.)
            </p>
          </div>
        )}
      </div>
    );
  }

  if (game === Game.SATISFACTORY) {
    return (
      <div className={className}>
        <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-slate-400">
          <Terminal className="h-3.5 w-3.5" /> Add server (in-game)
        </div>
        <CopyRow value={`${hostOr}:${gamePort}`} title="Server address for Satisfactory's Server Manager" />
        <p className="mt-1 text-[11px] leading-snug text-slate-500">
          In Satisfactory: <span className="font-mono">Server Manager → Add Server</span> — enter this address.
          Palisade already claimed the server with your server name + admin password, so it's ready to join.
          Accept the self-signed certificate when prompted.
        </p>
        {joinPassword && (
          <div className="mt-3">
            <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-slate-400">
              <Lock className="h-3.5 w-3.5" /> Join password
            </div>
            <CopyRow value={joinPassword} title="Copy the join password" />
            <p className="mt-1 text-[11px] leading-snug text-slate-500">Enter this when it prompts.</p>
          </div>
        )}
      </div>
    );
  }

  if (game === Game.SOTF) {
    return (
      <div className={className}>
        <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-slate-400">
          <Terminal className="h-3.5 w-3.5" /> Join (in-game)
        </div>
        <CopyRow value={hostOr} title="Server address for Sons of the Forest" />
        <p className="mt-1 text-[11px] leading-snug text-slate-500">
          In Sons of the Forest: <span className="font-mono">Multiplayer → Join → Dedicated</span> — filter or
          search the server list by name. There is no direct-connect field, so the server must be reachable
          (LAN, or forwarded UDP {gamePort} online).
        </p>
        {joinPassword && (
          <div className="mt-3">
            <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-slate-400">
              <Lock className="h-3.5 w-3.5" /> Join password
            </div>
            <CopyRow value={joinPassword} title="Copy the join password" />
            <p className="mt-1 text-[11px] leading-snug text-slate-500">Enter this when it prompts.</p>
          </div>
        )}
      </div>
    );
  }

  if (game === Game.VRISING) {
    return (
      <div className={className}>
        <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-slate-400">
          <Terminal className="h-3.5 w-3.5" /> Direct connect (in-game)
        </div>
        <CopyRow value={`${hostOr}:${gamePort}`} title="Server IP + port for V Rising's Direct Connect" />
        <p className="mt-1 text-[11px] leading-snug text-slate-500">
          In V Rising: <span className="font-mono">Play → Online Play → Direct Connect</span> — paste this
          address. Or search the server list by name if listing is enabled in Settings. Online, friends use
          your public IP with the same port.
        </p>
        {joinPassword && (
          <div className="mt-3">
            <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-slate-400">
              <Lock className="h-3.5 w-3.5" /> Join password
            </div>
            <CopyRow value={joinPassword} title="Copy the join password" />
            <p className="mt-1 text-[11px] leading-snug text-slate-500">Enter this when it prompts.</p>
          </div>
        )}
      </div>
    );
  }

  if (game === Game.ZOMBOID) {
    return (
      <div className={className}>
        <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-slate-400">
          <Terminal className="h-3.5 w-3.5" /> Join by IP (in-game)
        </div>
        <CopyRow value={`${hostOr}:${gamePort}`} title="Server IP + port for Zomboid's Join screen" />
        <p className="mt-1 text-[11px] leading-snug text-slate-500">
          In Project Zomboid: <span className="font-mono">Join → Favorites</span> — enter the IP and port{" "}
          <span className="font-mono">{gamePort}</span> and save it as a favorite. Online, friends use your
          public IP with the same port.
        </p>
        {joinPassword && (
          <div className="mt-3">
            <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-slate-400">
              <Lock className="h-3.5 w-3.5" /> Join password
            </div>
            <CopyRow value={joinPassword} title="Copy the join password" />
            <p className="mt-1 text-[11px] leading-snug text-slate-500">
              Enter this in the Server password field on the Join screen.
            </p>
          </div>
        )}
      </div>
    );
  }

  if (game === Game.BEDROCK) {
    return (
      <div className={className}>
        <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-slate-400">
          <Terminal className="h-3.5 w-3.5" /> Add server (in-game)
        </div>
        <CopyRow value={hostOr} title="Server address for Bedrock's Add Server" />
        <p className="mt-1 text-[11px] leading-snug text-slate-500">
          In Minecraft Bedrock: <span className="font-mono">Play → Servers → Add Server</span> — set the address
          to this and the port to <span className="font-mono">{gamePort}</span>. Works from phones, consoles,
          and Win10/11. Online, friends use your public IP (forward UDP {gamePort}).
        </p>
      </div>
    );
  }

  if (game === Game.MINECRAFT) {
    // Our server runs on the default port (25565), so players can type just the IP.
    return (
      <div className={className}>
        <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-slate-400">
          <Terminal className="h-3.5 w-3.5" /> Add server (in-game)
        </div>
        <CopyRow value={hostOr} title="Paste into Minecraft's Add Server / Direct Connect" />
        <p className="mt-1 text-[11px] leading-snug text-slate-500">
          In Minecraft: <span className="font-mono">Multiplayer → Add Server</span> (or Direct Connect), paste
          this. It runs on the default port <span className="font-mono">25565</span>, so no port is needed.
          Online, friends use your public IP (forward TCP 25565).
        </p>
      </div>
    );
  }

  // ARK (ASA / ASE)
  if (joinPassword) {
    return (
      <div className={className}>
        <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-slate-400">
          <Lock className="h-3.5 w-3.5" /> Join password
        </div>
        <CopyRow value={joinPassword} title="Copy the join password to paste into ARK's Password Required prompt" />
        <p className="mt-1 text-[11px] leading-snug text-slate-500">
          ARK cannot pass a password through the console, so the <span className="font-mono">open</span> command
          will not work. Find the server on the Unofficial list (below) and paste this password when prompted.
        </p>
      </div>
    );
  }

  return (
    <div className={className}>
      <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-slate-400">
        <Terminal className="h-3.5 w-3.5" /> Join over LAN (direct)
      </div>
      <CopyRow
        value={`open ${hostOr}:${gamePort}`}
        title="Copy, then paste into the ARK console (~ key) and press Enter to connect directly over your local network"
      />
      <p className="mt-1 text-[11px] leading-snug text-slate-500">
        Open the ARK console (<kbd className="rounded bg-ark-panel px-1 font-mono">~</kbd>), paste, press Enter.
      </p>
    </div>
  );
}
