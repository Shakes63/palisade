"use client";
import { useState } from "react";
import { SlidersHorizontal, Save, Check } from "lucide-react";
import {
  Game,
  ServerState,
  MAX_PLAYERS_BY_GAME,
  ASA_OFFICIAL_MAPS,
  ASE_OFFICIAL_MAPS,
  CONAN_OFFICIAL_MAPS,
  PALWORLD_OFFICIAL_MAPS,
  MINECRAFT_OFFICIAL_MAPS,
  ICARUS_OFFICIAL_MAPS,
  BEDROCK_OFFICIAL_MAPS,
  VALHEIM_OFFICIAL_MAPS,
  SEVEN_DAYS_OFFICIAL_MAPS,
  ENSHROUDED_OFFICIAL_MAPS,
  ZOMBOID_OFFICIAL_MAPS,
  VRISING_OFFICIAL_MAPS,
  SOTF_OFFICIAL_MAPS,
  SATISFACTORY_OFFICIAL_MAPS,
  LIF_OFFICIAL_MAPS,
  ATS_OFFICIAL_MAPS,
  ETS2_OFFICIAL_MAPS,
  CORE_KEEPER_OFFICIAL_MAPS,
  TERRARIA_OFFICIAL_MAPS,
  FACTORIO_OFFICIAL_MAPS,
  RUST_OFFICIAL_MAPS,
  BEAMMP_OFFICIAL_MAPS,
  mapLabel,
  type ServerSummary,
} from "@ark/shared";
import { apiPatch } from "@/lib/api";

const MAPS_FOR: Record<Game, readonly string[]> = {
  [Game.ASA]: ASA_OFFICIAL_MAPS,
  [Game.ASE]: ASE_OFFICIAL_MAPS,
  [Game.CONAN]: CONAN_OFFICIAL_MAPS,
  [Game.PALWORLD]: PALWORLD_OFFICIAL_MAPS,
  [Game.MINECRAFT]: MINECRAFT_OFFICIAL_MAPS,
  [Game.ICARUS]: ICARUS_OFFICIAL_MAPS,
  [Game.BEDROCK]: BEDROCK_OFFICIAL_MAPS,
  [Game.VALHEIM]: VALHEIM_OFFICIAL_MAPS,
  [Game.SEVEN_DAYS]: SEVEN_DAYS_OFFICIAL_MAPS,
  [Game.ENSHROUDED]: ENSHROUDED_OFFICIAL_MAPS,
  [Game.ZOMBOID]: ZOMBOID_OFFICIAL_MAPS,
  [Game.VRISING]: VRISING_OFFICIAL_MAPS,
  [Game.SOTF]: SOTF_OFFICIAL_MAPS,
  [Game.SATISFACTORY]: SATISFACTORY_OFFICIAL_MAPS,
  [Game.LIF]: LIF_OFFICIAL_MAPS,
  [Game.ATS]: ATS_OFFICIAL_MAPS,
  [Game.ETS2]: ETS2_OFFICIAL_MAPS,
  [Game.CORE_KEEPER]: CORE_KEEPER_OFFICIAL_MAPS,
  [Game.TERRARIA]: TERRARIA_OFFICIAL_MAPS,
  [Game.FACTORIO]: FACTORIO_OFFICIAL_MAPS,
  [Game.RUST]: RUST_OFFICIAL_MAPS,
  [Game.BEAMMP]: BEAMMP_OFFICIAL_MAPS,
};

/**
 * Edit a server's basics after creation: map, max players, and RAM/CPU limits
 * (0 / blank clears a limit). All of these bake into the launch spec, so a running
 * server needs a restart to pick them up (the existing configDirty flag handles
 * surfacing that).
 */
export function GeneralCard({ server, onSaved }: { server: ServerSummary; onSaved: () => void }) {
  const [map, setMap] = useState(server.map);
  const [maxPlayers, setMaxPlayers] = useState(String(server.maxPlayers));
  const [ramLimit, setRamLimit] = useState(server.ramLimitMb ? String(server.ramLimitMb) : "");
  const [cpuLimit, setCpuLimit] = useState(server.cpuLimit ? String(server.cpuLimit) : "");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const maps = MAPS_FOR[server.game];
  const cap = MAX_PLAYERS_BY_GAME[server.game];
  // Icarus has no launch map (prospects are picked in-game); a single-map game has
  // nothing to switch to — hide the picker for both.
  const showMap = server.game !== Game.ICARUS && maps.length > 1;
  const live = server.state === ServerState.Running || server.state === ServerState.Starting;

  const dirty =
    (showMap && map !== server.map) ||
    Number(maxPlayers) !== server.maxPlayers ||
    (ramLimit === "" ? 0 : Number(ramLimit)) !== (server.ramLimitMb ?? 0) ||
    (cpuLimit === "" ? 0 : Number(cpuLimit)) !== (server.cpuLimit ?? 0);

  const save = async () => {
    setBusy(true);
    setSaved(false);
    try {
      const body: Record<string, unknown> = {};
      if (showMap && map !== server.map) body.map = map;
      const mp = Math.max(1, Math.min(Number(maxPlayers) || 1, cap));
      if (mp !== server.maxPlayers) body.maxPlayers = mp;
      const ram = ramLimit === "" ? 0 : Math.max(0, Number(ramLimit) || 0);
      if (ram !== (server.ramLimitMb ?? 0)) body.ramLimitMb = ram; // 0 clears
      const cpu = cpuLimit === "" ? 0 : Math.max(0, Number(cpuLimit) || 0);
      if (cpu !== (server.cpuLimit ?? 0)) body.cpuLimit = cpu; // 0 clears
      await apiPatch(`/servers/${server.id}`, body);
      setSaved(true);
      onSaved();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card space-y-3">
      <div className="flex items-center gap-2">
        <SlidersHorizontal className="h-4 w-4 text-ark-accent" />
        <h3 className="text-sm font-semibold uppercase tracking-wide text-ark-accent2">General</h3>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {showMap && (
          <div>
            <label className="label">Map</label>
            <select className="input" value={map} onChange={(e) => setMap(e.target.value)}>
              {/* keep an unknown/mod map selectable rather than silently swapping it */}
              {!maps.includes(map) && <option value={map}>{mapLabel(map)}</option>}
              {maps.map((m) => (
                <option key={m} value={m}>
                  {mapLabel(m)}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-slate-500">
              Each map keeps its own world save — switching back later resumes that map&apos;s world.
            </p>
          </div>
        )}
        <div>
          <label className="label">Max players</label>
          <input
            type="number"
            min={1}
            max={cap}
            className="input"
            value={maxPlayers}
            onChange={(e) => setMaxPlayers(e.target.value)}
          />
          <p className="mt-1 text-xs text-slate-500">Max {cap} for this game.</p>
        </div>
        <div>
          <label className="label">RAM limit (MB)</label>
          <input
            type="number"
            min={0}
            step={512}
            className="input"
            placeholder="Unlimited"
            value={ramLimit}
            onChange={(e) => setRamLimit(e.target.value)}
          />
          <p className="mt-1 text-xs text-slate-500">Blank or 0 = no cap. Also feeds the start RAM guard.</p>
        </div>
        <div>
          <label className="label">CPU limit (cores)</label>
          <input
            type="number"
            min={0}
            step={0.5}
            className="input"
            placeholder="Unlimited"
            value={cpuLimit}
            onChange={(e) => setCpuLimit(e.target.value)}
          />
          <p className="mt-1 text-xs text-slate-500">Blank or 0 = no cap.</p>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <button className="btn-primary" onClick={save} disabled={!dirty || busy}>
          {busy ? "Saving…" : saved ? (
            <>
              <Check className="h-4 w-4" /> Saved
            </>
          ) : (
            <>
              <Save className="h-4 w-4" /> Save
            </>
          )}
        </button>
        {live && dirty && <span className="text-xs text-amber-400">Restart the server to apply.</span>}
      </div>
    </div>
  );
}
