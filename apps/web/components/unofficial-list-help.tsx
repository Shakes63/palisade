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
  const zomboid = game === Game.ZOMBOID;
  const vrising = game === Game.VRISING;
  const sotf = game === Game.SOTF;
  const satisfactory = game === Game.SATISFACTORY;
  const lif = game === Game.LIF;
  const ats = game === Game.ATS || game === Game.ETS2;
  const terraria = game === Game.TERRARIA;
  const factorio = game === Game.FACTORIO;
  const rust = game === Game.RUST;
  const beammp = game === Game.BEAMMP;
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
          {minecraft || bedrock || terraria
            ? "Add it to your server list"
            : satisfactory
              ? "Add it to your Server Manager"
            : conan || palworld || icarus || valheim || sdtd || enshrouded || zomboid || vrising || sotf || lif || ats || factorio || rust || beammp
              ? "Find it in the in-game server browser"
              : "Find it on the in-game Unofficial list"}
        </span>
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open &&
        (beammp ? (
          <div className="space-y-1.5 border-t border-ark-border px-2.5 py-2 text-xs">
            <p className="text-slate-400">
              In the <span className="text-slate-200">BeamMP launcher</span>:
            </p>
            <FilterRow state="on" label="Server list — search by name (only if 'Private' is off)" />
            <FilterRow state="on" label="Or Direct Connect with the address above (works when Private)" />
            <p className="pt-1 leading-snug text-slate-400">
              Players need the free <span className="text-slate-200">BeamMP launcher</span> (beammp.com) plus
              BeamNG.drive. Everyone must own any non-vanilla map/vehicle mods you drop in the client-mods
              folder — those download automatically on join.
            </p>
          </div>
        ) : rust ? (
          <div className="space-y-1.5 border-t border-ark-border px-2.5 py-2 text-xs">
            <p className="text-slate-400">
              In <span className="text-slate-200">the server browser</span>:
            </p>
            <FilterRow state="on" label="Community tab — search by name (may take minutes to list)" />
            <FilterRow state="on" label="Or press F1 → connect ip:port (console)" />
            <p className="pt-1 leading-snug text-slate-400">
              Search the name <span className="font-mono text-slate-200">{serverName}</span>, or F1-console{" "}
              <span className="font-mono text-slate-200">connect &lt;ip&gt;:{queryPort ? queryPort - 1 : 28015}</span>.
              Vanilla Rust has no join password — access control is bans/whitelist plugins.
            </p>
          </div>
        ) : factorio ? (
          <div className="space-y-1.5 border-t border-ark-border px-2.5 py-2 text-xs">
            <p className="text-slate-400">
              In <span className="text-slate-200">Multiplayer</span>:
            </p>
            <FilterRow
              state="on"
              label="Browse public games — only if public listing + factorio.com credentials are set"
              hint="off by default; use Connect to address instead"
            />
            <FilterRow state={hasJoinPassword ? "on" : "off"} label="Password prompt on join" hint={passwordHint} />
            <p className="pt-1 leading-snug text-slate-400">
              Easiest: <span className="text-slate-200">Multiplayer → Connect to address</span> with the
              address above. The save <span className="font-mono text-slate-200">{serverName}</span> generates
              on the first start with the chosen map-gen preset.
            </p>
          </div>
        ) : terraria ? (
          <div className="space-y-1.5 border-t border-ark-border px-2.5 py-2 text-xs">
            <p className="text-slate-400">
              Terraria has no public browser — players join by IP:
            </p>
            <FilterRow state="on" label="Multiplayer → Join via IP, enter the address + port above" />
            <FilterRow state={hasJoinPassword ? "on" : "off"} label="Password prompt on join" hint={passwordHint} />
            <p className="pt-1 leading-snug text-slate-400">
              The world <span className="font-mono text-slate-200">{serverName}</span> is created on the first
              start (size from the create form). Online, friends use your public IP (forward TCP{" "}
              {queryPort ?? 7777}).
            </p>
          </div>
        ) : sdtd ? (
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
        ) : ats ? (
          <div className="space-y-1.5 border-t border-ark-border px-2.5 py-2 text-xs">
            <p className="text-slate-400">
              In <span className="text-slate-200">Convoy → search sessions</span>:
            </p>
            <FilterRow state="on" label="Search the session list by name (needs 'Visible in session search' on)" />
            <FilterRow state={hasJoinPassword ? "on" : "off"} label="Password prompt on join" hint={passwordHint} />
            <p className="pt-1 leading-snug text-slate-400">
              Search the name <span className="font-mono text-slate-200">{serverName}</span>. Players need the
              SAME map DLCs as the server's world export. Name + password apply from the{" "}
              <span className="text-slate-300">second</span> start — the config file is seeded on the first boot.
            </p>
          </div>
        ) : lif ? (
          <div className="space-y-1.5 border-t border-ark-border px-2.5 py-2 text-xs">
            <p className="text-slate-400">
              In <span className="text-slate-200">Multiplayer</span>:
            </p>
            <FilterRow
              state="on"
              label="Search the server list by name (unless 'Hide from server browser' is on)"
            />
            <FilterRow state={hasJoinPassword ? "on" : "off"} label="Password prompt on join" hint={passwordHint} />
            <p className="pt-1 leading-snug text-slate-400">
              Search the name <span className="font-mono text-slate-200">{serverName}</span>, or use{" "}
              <span className="text-slate-200">Connect to custom IP</span> with the address above. Heads-up:
              the game files install on the FIRST start, so the name + passwords apply from the{" "}
              <span className="text-slate-300">second</span> start — restart once after the initial boot.
            </p>
          </div>
        ) : satisfactory ? (
          <div className="space-y-1.5 border-t border-ark-border px-2.5 py-2 text-xs">
            <p className="text-slate-400">
              Satisfactory has no public browser — add the server by address:
            </p>
            <FilterRow state="on" label="Server Manager → Add Server, enter the address above" />
            <FilterRow state="on" label="Accept the self-signed certificate prompt" />
            <p className="pt-1 leading-snug text-slate-400">
              The server appears as <span className="font-mono text-slate-200">{serverName}</span> — Palisade
              claims it with your admin password automatically, so no in-game claim step is needed. Online,
              friends use your public IP (forward UDP+TCP {queryPort ?? 7777} and TCP 8888).
            </p>
          </div>
        ) : sotf ? (
          <div className="space-y-1.5 border-t border-ark-border px-2.5 py-2 text-xs">
            <p className="text-slate-400">
              In <span className="text-slate-200">Multiplayer → Join → Dedicated</span>:
            </p>
            <FilterRow state="on" label="Search / filter the dedicated list by name" />
            <FilterRow
              state={hasJoinPassword ? "on" : "off"}
              label="Password-protected filter"
              hint={passwordHint}
            />
            <p className="pt-1 leading-snug text-slate-400">
              Search the name <span className="font-mono text-slate-200">{serverName}</span>. Sons of the
              Forest has no direct-connect field — LAN players see it automatically; online players need the
              forwarded ports. 'LAN only' in Settings hides it from the internet list.
            </p>
          </div>
        ) : vrising ? (
          <div className="space-y-1.5 border-t border-ark-border px-2.5 py-2 text-xs">
            <p className="text-slate-400">
              In <span className="text-slate-200">Play → Online Play</span>:
            </p>
            <FilterRow
              state="on"
              label="Server list — search by name (only if 'List on Steam/EOS' is enabled)"
              hint="both listing settings are off by default"
            />
            <FilterRow state={hasJoinPassword ? "on" : "off"} label="Password prompt on join" hint={passwordHint} />
            <p className="pt-1 leading-snug text-slate-400">
              Most players use <span className="text-slate-200">Direct Connect</span> with the address shown
              above. The name <span className="font-mono text-slate-200">{serverName}</span> appears in the
              list only when a listing setting is on. Note: joining a passworded server via the Steam friends
              flow is flaky — use the in-game list or Direct Connect.
            </p>
          </div>
        ) : zomboid ? (
          <div className="space-y-1.5 border-t border-ark-border px-2.5 py-2 text-xs">
            <p className="text-slate-400">
              In <span className="text-slate-200">Join</span>:
            </p>
            <FilterRow
              state="on"
              label="Internet tab — search by name (only if the server is Public)"
              hint="the Public server list setting is off by default"
            />
            <FilterRow state={hasJoinPassword ? "on" : "off"} label="Server password on the Join screen" hint={passwordHint} />
            <p className="pt-1 leading-snug text-slate-400">
              Most players skip the browser: use <span className="text-slate-200">Favorites</span> with the IP +
              port shown above. The name <span className="font-mono text-slate-200">{serverName}</span> appears on
              the Internet tab only when the Public setting is on.
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
