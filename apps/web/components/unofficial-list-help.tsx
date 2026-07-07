"use client";
import { useState } from "react";
import { Check, X, Search, ChevronDown } from "lucide-react";
import { Game } from "@ark/shared";

/**
 * In-game server-browser filter guide, tailored per game. Both ARK and Conan
 * filter/hide player-hosted servers in non-obvious ways; this spells out which
 * toggles to flip so a self-hosted server shows up. The password row is
 * config-dependent (the join password is a write-only secret) — hence the
 * conditional note rather than a hard ON/OFF.
 */
export function UnofficialListHelp({
  game,
  serverName,
  mapName,
  queryPort,
  hasJoinPassword = false,
  defaultOpen = false,
  className = "",
}: {
  game: Game;
  serverName: string;
  mapName: string;
  /** Conan's Direct Connect uses the query port — surfaced as a fallback. */
  queryPort?: number;
  /** When the server has a join password, the player must enable the
   *  password-protected filter (off otherwise) to see it. */
  hasJoinPassword?: boolean;
  defaultOpen?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const conan = game === Game.CONAN;
  const palworld = game === Game.PALWORLD;
  const minecraft = game === Game.MINECRAFT;
  const icarus = game === Game.ICARUS;
  const bedrock = game === Game.BEDROCK;
  const valheim = game === Game.VALHEIM;
  const sdtd = game === Game.SEVEN_DAYS;
  const enshrouded = game === Game.ENSHROUDED;
  const passwordHint = hasJoinPassword
    ? "your server has a join password"
    : "ON only if you set a join password";

  return (
    <div className={`rounded-md border border-ark-border ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left text-xs font-medium text-slate-400 hover:text-slate-200"
      >
        <span className="flex items-center gap-1.5">
          <Search className="h-3.5 w-3.5" />
          {minecraft || bedrock
            ? "Add it to your Minecraft server list"
            : conan || palworld || icarus || valheim || sdtd || enshrouded
              ? "Find it in the in-game server browser"
              : "Find it on the in-game Unofficial list"}
        </span>
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open &&
        (sdtd ? (
          <div className="space-y-1.5 border-t border-ark-border px-2.5 py-2 text-xs">
            <p className="text-slate-400">
              In <span className="text-slate-200">Join a Game</span>:
            </p>
            <FilterRow state="on" label="Server browser — search by name, or Connect to Server by IP" />
            <FilterRow
              state={hasJoinPassword ? "on" : "off"}
              label="Password-protected servers still list"
              hint={passwordHint}
            />
            <p className="pt-1 leading-snug text-slate-400">
              Search the name <span className="font-mono text-slate-200">{serverName}</span>, or use{" "}
              <span className="text-slate-200">Connect to Server</span> with the address shown above.
            </p>
          </div>
        ) : enshrouded ? (
          <div className="space-y-1.5 border-t border-ark-border px-2.5 py-2 text-xs">
            <p className="text-slate-400">
              In <span className="text-slate-200">Play → Server List</span>:
            </p>
            <FilterRow state="on" label="Search the server list by name" />
            <FilterRow state="on" label="Enter the join password when prompted" hint="required — the server is role-protected" />
            <p className="pt-1 leading-snug text-slate-400">
              Search the name <span className="font-mono text-slate-200">{serverName}</span>, or use{" "}
              <span className="text-slate-200">Join IP</span> (the address shown above). The join password logs
              you in as <span className="text-slate-300">Guest</span>; append{" "}
              <span className="font-mono">-admin</span> for admin rights.
            </p>
          </div>
        ) : valheim ? (
          <div className="space-y-1.5 border-t border-ark-border px-2.5 py-2 text-xs">
            <p className="text-slate-400">
              In <span className="text-slate-200">Join Game → Community</span>:
            </p>
            <FilterRow state="on" label="Search the community server list by name" />
            <FilterRow state="on" label="Server is public" hint="enabled by default; turn off for friends-only" />
            <p className="pt-1 leading-snug text-slate-400">
              Search the name <span className="font-mono text-slate-200">{serverName}</span>, or use{" "}
              <span className="text-slate-200">Join IP</span> (the address shown above). Valheim always needs the
              password. It can take a minute to appear in the community list.
            </p>
          </div>
        ) : bedrock ? (
          <div className="space-y-1.5 border-t border-ark-border px-2.5 py-2 text-xs">
            <p className="text-slate-400">
              Bedrock has no public browser — add the server by IP:
            </p>
            <FilterRow state="on" label="Play → Servers → Add Server, set address + port" />
            <FilterRow
              state={hasJoinPassword ? "on" : "off"}
              label="Allow-list — add each player's gamertag"
              hint={hasJoinPassword ? "you enabled the allow-list" : "ON only if you enable the allow-list"}
            />
            <p className="pt-1 leading-snug text-slate-400">
              The server name <span className="font-mono text-slate-200">{serverName}</span> shows in your
              server list. Online, friends use your public IP (forward UDP {queryPort ?? 19132}).
            </p>
          </div>
        ) : icarus ? (
          <div className="space-y-1.5 border-t border-ark-border px-2.5 py-2 text-xs">
            <p className="text-slate-400">
              In <span className="text-slate-200">Play → Join Server</span>:
            </p>
            <FilterRow state="on" label="Search the server list by name" />
            <FilterRow
              state={hasJoinPassword ? "on" : "off"}
              label="Password-protected servers are still listed"
              hint={passwordHint}
            />
            <p className="pt-1 leading-snug text-slate-400">
              Search the name <span className="font-mono text-slate-200">{serverName}</span>, or use{" "}
              <span className="text-slate-200">Join IP</span> (the address shown above). Admin is via in-game
              chat (<span className="font-mono">/AdminLogin</span>) — Icarus has no separate console.
            </p>
          </div>
        ) : minecraft ? (
          <div className="space-y-1.5 border-t border-ark-border px-2.5 py-2 text-xs">
            <p className="text-slate-400">
              Minecraft has no public browser — players add the server by IP:
            </p>
            <FilterRow state="on" label="Multiplayer → Add Server, paste the address above" />
            <FilterRow
              state={hasJoinPassword ? "on" : "off"}
              label="Whitelist — add each player's username"
              hint={hasJoinPassword ? "you enabled the whitelist" : "ON only if you enable the whitelist"}
            />
            <p className="pt-1 leading-snug text-slate-400">
              The server name <span className="font-mono text-slate-200">{serverName}</span> shows as the MOTD
              in their list. Online, friends use your public IP (forward TCP 25565).
            </p>
          </div>
        ) : conan ? (
          <div className="space-y-1.5 border-t border-ark-border px-2.5 py-2 text-xs">
            <p className="text-slate-400">
              In <span className="text-slate-200">Online → Server List</span>, set these filters:
            </p>
            <FilterRow state="on" label="Server Type — match yours, or “All”" />
            <FilterRow state="on" label="Region — North America (your server's region)" />
            <FilterRow state={hasJoinPassword ? "on" : "off"} label="Show Password Protected" hint={passwordHint} />
            <p className="pt-1 leading-snug text-slate-400">
              Then search the name <span className="font-mono text-slate-200">{serverName}</span>. Or use{" "}
              <span className="text-slate-200">Direct Connect</span> with your server&apos;s IP
              {queryPort ? (
                <>
                  {" "}
                  on port <span className="font-mono text-slate-200">{queryPort}</span> — Conan&apos;s Direct
                  Connect uses the query port.
                </>
              ) : (
                " and query port."
              )}
            </p>
          </div>
        ) : palworld ? (
          <div className="space-y-1.5 border-t border-ark-border px-2.5 py-2 text-xs">
            <p className="text-slate-400">
              In <span className="text-slate-200">Join Multiplayer Game → Community Servers</span>:
            </p>
            <FilterRow state="on" label="Search by name (community list)" />
            <FilterRow
              state={hasJoinPassword ? "on" : "off"}
              label="Password-protected servers are still listed"
              hint={passwordHint}
            />
            <p className="pt-1 leading-snug text-slate-400">
              Search the name <span className="font-mono text-slate-200">{serverName}</span>, or use{" "}
              <span className="text-slate-200">Connect with IP</span> (the address shown above).
            </p>
          </div>
        ) : (
          <div className="space-y-1.5 border-t border-ark-border px-2.5 py-2 text-xs">
            <p className="text-slate-400">
              In <span className="text-slate-200">Join ARK → Unofficial</span>, set these filters:
            </p>
            <FilterRow state="on" label="Show Player Servers" />
            <FilterRow state="off" label="PC-Only Online Multiplayer" hint="hides crossplay servers" />
            <FilterRow state={hasJoinPassword ? "on" : "off"} label="Show Password Protected Servers" hint={passwordHint} />
            <p className="pt-1 leading-snug text-slate-400">
              Then search the name <span className="font-mono text-slate-200">{serverName}</span>
              {mapName ? (
                <>
                  {" "}
                  · map <span className="text-slate-200">{mapName}</span> or “Any”.
                </>
              ) : (
                "."
              )}
            </p>
          </div>
        ))}
    </div>
  );
}

function FilterRow({ state, label, hint }: { state: "on" | "off"; label: string; hint?: string }) {
  const on = state === "on";
  return (
    <div className="flex items-start gap-1.5">
      {on ? (
        <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ark-accent" />
      ) : (
        <X className="mt-0.5 h-3.5 w-3.5 shrink-0 text-rose-400" />
      )}
      <span className="text-slate-200">
        {label}{" "}
        <span className={on ? "font-semibold text-ark-accent" : "font-semibold text-rose-400"}>
          {on ? "ON" : "OFF"}
        </span>
        {hint && <span className="text-slate-500"> — {hint}</span>}
      </span>
    </div>
  );
}
