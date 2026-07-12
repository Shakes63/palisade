"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Save,
  Info,
  Plus,
  Trash2,
  ChevronDown,
  ChevronRight,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Gauge,
  User,
  PawPrint,
  BarChart3,
  Building2,
  Swords,
  Package,
  Network,
  Wrench,
  Sparkles,
  Clock,
  MessageSquare,
  Skull,
  Shield,
  GitBranch,
  Map as MapIcon,
  type LucideIcon,
} from "lucide-react";
import {
  computeLevelRamp,
  mapLabel,
  SETTINGS_PRESETS,
  settingActive,
  Game,
  type SettingsPreset,
  type CustomPreset,
  type SettingsCatalog,
  type SettingDef,
  type ServerConfigValues,
  type MotdValue,
  type ItemMaxEntry,
  type SpawnWeightEntry,
  type NpcReplaceEntry,
  type LevelRampValue,
  type EngramsValue,
  type EngramOverride,
  type LootCrateEntry,
  type LootItem,
  type SpawnContainerEntry,
  type CraftCostEntry,
  type CraftCostResource,
  type GameVersionsResult,
} from "@ark/shared";
import { apiGet, apiPatch, apiPost, apiDelete } from "@/lib/api";
import { ARK_ITEMS } from "@/lib/ark-items";
import { ARK_CREATURES } from "@/lib/ark-creatures";
import { ARK_ENGRAMS } from "@/lib/ark-engrams";

type Values = Record<string, unknown>;
const STRUCTURED = new Set([
  "grid",
  "motd",
  "itemmax",
  "spawnweight",
  "npcreplace",
  "levelramp",
  "engrams",
  "lootcrate",
  "spawncontainer",
  "craftcost",
]);
const numd = (x: unknown, d: number) => (Number.isFinite(Number(x)) ? Number(x) : d);
const ARK_CRATES = [
  { className: "SupplyCrate_Level03_C", name: "White Beacon (Lvl 3+)" },
  { className: "SupplyCrate_Level15_C", name: "Green Beacon (Lvl 15+)" },
  { className: "SupplyCrate_Level25_C", name: "Blue Beacon (Lvl 25+)" },
  { className: "SupplyCrate_Level35_C", name: "Purple Beacon (Lvl 35+)" },
  { className: "SupplyCrate_Level45_C", name: "Yellow Beacon (Lvl 45+)" },
  { className: "SupplyCrate_Level60_C", name: "Red Beacon (Lvl 60+)" },
  { className: "SupplyCrate_Cave_QualityTier1_C", name: "Cave Crate — Tier 1" },
  { className: "SupplyCrate_Cave_QualityTier2_C", name: "Cave Crate — Tier 2" },
  { className: "SupplyCrate_Cave_QualityTier3_C", name: "Cave Crate — Tier 3" },
];
const numBox =
  "w-16 shrink-0 rounded border border-ark-border bg-ark-bg px-1.5 py-1 text-right text-sm outline-none focus:border-ark-accent2";

/**
 * Settings are grouped into top-level tabs so a server's options aren't one endless
 * scroll. Each tab owns a set of catalog categories; the set is game-specific (ARK
 * and Conan have entirely different categories). For ARK, any category not listed
 * here falls into "Advanced" so nothing is ever hidden.
 */
type SettingGroup = { id: string; label: string; Icon: LucideIcon; cats: string[] };
const ARK_GROUPS: SettingGroup[] = [
  { id: "general", label: "General", Icon: SlidersHorizontal, cats: ["Rules", "Server", "Chat", "Difficulty", "Time & weather", "Active seasonal event", "Server language override", "Crossplay platforms"] },
  { id: "rates", label: "Rates & XP", Icon: Gauge, cats: ["Rates", "XP breakdown", "Crops & farming", "Spoiling & decay"] },
  { id: "players", label: "Players", Icon: User, cats: ["Players", "Leveling"] },
  { id: "creatures", label: "Creatures", Icon: PawPrint, cats: ["All creatures", "Wild creatures", "Tamed creatures", "Breeding", "Cryopods", "Creature spawns"] },
  { id: "stats", label: "Per-level stats", Icon: BarChart3, cats: ["Per-level stats"] },
  { id: "structures", label: "Structures", Icon: Building2, cats: ["Building", "Structure limits", "Structure decay", "Structure combat", "Platforms & saddles", "Pickup & power", "Turrets"] },
  { id: "pvp", label: "PvP & Tribes", Icon: Swords, cats: ["PvP", "Tribes"] },
  { id: "items", label: "Items & Loot", Icon: Package, cats: ["Items", "Crafting", "Loot crates", "Engrams"] },
  { id: "maps", label: "Maps", Icon: MapIcon, cats: ["Genesis", "Hexagon store", "Ragnarok", "Fjordur", "Astraeos", "Valguero", "Outposts", "Tek Bunker", "Cryo Hospital", "Bloodforge"] },
  { id: "cluster", label: "Cluster", Icon: Network, cats: ["Cross-server"] },
  { id: "advanced", label: "Advanced", Icon: Wrench, cats: ["Launch options", "Launch flags"] },
];

// Conan's catalog categories map to their own tabs (it has no maps / per-level
// stats / engrams). Every Conan category is covered here, so there's no Advanced
// catch-all (and no ARK-style raw-ini passthrough, which Conan doesn't use).
const CONAN_GROUPS: SettingGroup[] = [
  { id: "general", label: "General", Icon: SlidersHorizontal, cats: ["General", "PvP & Rules"] },
  { id: "combat", label: "Combat", Icon: Swords, cats: ["Combat"] },
  { id: "survival", label: "Survival", Icon: User, cats: ["Survival", "Death"] },
  { id: "progression", label: "Rates & XP", Icon: Gauge, cats: ["Progression", "Harvest & Crafting"] },
  { id: "world", label: "World", Icon: PawPrint, cats: ["World", "Thralls", "Avatars"] },
  { id: "building", label: "Building", Icon: Building2, cats: ["Building", "Clans"] },
  { id: "schedules", label: "Schedules", Icon: Clock, cats: ["Schedules"] },
];

// Palworld's catalog categories → their own tabs.
const PALWORLD_GROUPS: SettingGroup[] = [
  { id: "general", label: "General", Icon: SlidersHorizontal, cats: ["General", "PvP & Rules"] },
  { id: "rates", label: "Rates & World", Icon: Gauge, cats: ["Progression", "World"] },
  { id: "combat", label: "Combat & Survival", Icon: Swords, cats: ["Combat", "Survival"] },
  { id: "building", label: "Building & Items", Icon: Building2, cats: ["Building", "Items", "Guild"] },
];

// Minecraft's catalog categories → their own tabs (covers every category, so no
// catch-all is needed).
const MINECRAFT_GROUPS: SettingGroup[] = [
  { id: "server", label: "Server", Icon: SlidersHorizontal, cats: ["Server"] },
  { id: "world", label: "World", Icon: MapIcon, cats: ["World"] },
  { id: "gameplay", label: "Gameplay", Icon: Swords, cats: ["Gameplay"] },
  { id: "mobs", label: "Mobs", Icon: PawPrint, cats: ["Mobs"] },
  { id: "players", label: "Players", Icon: User, cats: ["Players"] },
];

// Icarus has a small env-driven catalog (session + permissions).
const ICARUS_GROUPS: SettingGroup[] = [
  { id: "session", label: "Session", Icon: SlidersHorizontal, cats: ["Session"] },
  { id: "permissions", label: "Permissions", Icon: User, cats: ["Permissions"] },
];

// Bedrock's env-driven catalog → its own tabs.
const BEDROCK_GROUPS: SettingGroup[] = [
  { id: "server", label: "Server", Icon: SlidersHorizontal, cats: ["Server"] },
  { id: "gameplay", label: "Gameplay", Icon: Swords, cats: ["Gameplay"] },
  { id: "world", label: "World", Icon: MapIcon, cats: ["World"] },
];

// Valheim's env-driven catalog + launch-flag world modifiers → its own tabs.
const VALHEIM_GROUPS: SettingGroup[] = [
  { id: "world", label: "World", Icon: MapIcon, cats: ["World"] },
  { id: "server", label: "Server", Icon: SlidersHorizontal, cats: ["Server"] },
  { id: "modifiers", label: "World modifiers", Icon: Swords, cats: ["World modifiers"] },
];

// 7 Days to Die (rendered into sdtdserver.xml) → its own tabs, one per config section.
const SEVEN_DAYS_GROUPS: SettingGroup[] = [
  { id: "version", label: "Version", Icon: GitBranch, cats: ["Version"] },
  { id: "world", label: "World", Icon: MapIcon, cats: ["World"] },
  { id: "difficulty", label: "Difficulty", Icon: Swords, cats: ["Difficulty"] },
  { id: "zombies", label: "Zombies", Icon: Skull, cats: ["Zombies"] },
  { id: "loot", label: "Loot", Icon: Package, cats: ["Loot"] },
  { id: "landclaim", label: "Land claim", Icon: Shield, cats: ["Land claim"] },
  { id: "players", label: "Players", Icon: User, cats: ["Players"] },
  { id: "performance", label: "Performance", Icon: Wrench, cats: ["Performance"] },
];

// Enshrouded's env-driven gameSettings (SERVER_GS_*) + chat → its own tabs.
const ENSHROUDED_GROUPS: SettingGroup[] = [
  { id: "version", label: "Version", Icon: GitBranch, cats: ["Version"] },
  { id: "difficulty", label: "Difficulty", Icon: Swords, cats: ["Difficulty"] },
  { id: "players", label: "Players", Icon: User, cats: ["Players"] },
  { id: "world", label: "World", Icon: MapIcon, cats: ["World"] },
  { id: "economy", label: "Economy", Icon: Gauge, cats: ["Economy"] },
  { id: "chat", label: "Chat", Icon: MessageSquare, cats: ["Chat"] },
];

/**
 * Map-specific categories → fragments of the server's map name they apply to.
 * A setting in one of these only shows when the managed server's map matches,
 * so e.g. Ragnarok volcano options never appear on a The Island server.
 */
const MAP_CATEGORIES: Record<string, string[]> = {
  Genesis: ["genesis", "gen2"], // Genesis-only features (missions, Tek suit)
  "Hexagon store": ["genesis", "gen2", "bobsmissions"], // Genesis 1/2 + Club ARK
  Ragnarok: ["ragnarok"],
  Fjordur: ["fjordur"],
  Astraeos: ["astraeos"],
  Valguero: ["valguero"],
  // Lost Colony DLC features
  Outposts: ["lostcolony"],
  "Tek Bunker": ["lostcolony"],
  "Cryo Hospital": ["lostcolony"],
  Bloodforge: ["lostcolony"],
};

const matchesQuery = (d: SettingDef, q: string): boolean =>
  d.label.toLowerCase().includes(q) ||
  d.key.toLowerCase().includes(q) ||
  d.category.toLowerCase().includes(q) ||
  (d.help?.toLowerCase().includes(q) ?? false);

export function SettingsForm({
  serverId,
  game,
  map,
  initial,
}: {
  serverId: string;
  game: Game;
  map: string;
  initial: ServerConfigValues;
}) {
  // Tabs + their category membership are game-specific.
  const GROUPS =
    game === Game.CONAN
      ? CONAN_GROUPS
      : game === Game.PALWORLD || game === Game.PALWORLD_WINE
        ? PALWORLD_GROUPS
        : game === Game.MINECRAFT
          ? MINECRAFT_GROUPS
          : game === Game.ICARUS
            ? ICARUS_GROUPS
            : game === Game.BEDROCK
              ? BEDROCK_GROUPS
              : game === Game.VALHEIM
                ? VALHEIM_GROUPS
                : game === Game.SEVEN_DAYS
                  ? SEVEN_DAYS_GROUPS
                  : game === Game.ENSHROUDED
                    ? ENSHROUDED_GROUPS
                    : ARK_GROUPS;
  const MAPPED_CATS = new Set(GROUPS.flatMap((g) => g.cats));

  // A map-specific category is shown only when the server's map matches it.
  const mapMatches = (cat: string): boolean => {
    const frags = MAP_CATEGORIES[cat];
    if (!frags) return true;
    const m = (map ?? "").toLowerCase();
    return frags.some((f) => m.includes(f));
  };
  const [catalog, setCatalog] = useState<SettingsCatalog | null>(null);
  const [values, setValues] = useState<Values>(initial.values ?? {});
  const [raw, setRaw] = useState({
    gus: initial.rawGameUserSettingsIni ?? "",
    game: initial.rawGameIni ?? "",
    args: initial.rawCommandLineArgs ?? "",
  });
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [activeGroup, setActiveGroup] = useState("general");
  const [query, setQuery] = useState("");
  // Provenance: which preset last set each key (+ the value it set). Declared up
  // here because the `sections` memo + counts read it; load/save effects below.
  const [presetMarks, setPresetMarks] = useState<Record<string, { preset: string; value: unknown }>>({});
  const [presetFilter, setPresetFilter] = useState(false);

  // Persist the active settings sub-tab in the URL (?section=creatures) so a
  // refresh keeps you on the same section. replaceState — no scroll/navigation.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search).get("section");
    if (p && GROUPS.some((g) => g.id === p)) setActiveGroup(p);
  }, []);
  const changeGroup = (id: string) => {
    setActiveGroup(id);
    const u = new URL(window.location.href);
    u.searchParams.set("section", id);
    window.history.replaceState(null, "", u);
  };
  const toggle = (cat: string) =>
    setCollapsed((s) => {
      const n = new Set(s);
      n.has(cat) ? n.delete(cat) : n.add(cat);
      return n;
    });

  const isOverridden = (def: SettingDef): boolean => {
    const v = values[def.key];
    if (v === undefined) return false;
    return JSON.stringify(v) !== JSON.stringify(def.default);
  };

  const resetAll = () => {
    if (!catalog) return;
    if (!confirm("Reset ALL settings on this server to their defaults? You'll still need to click Save.")) return;
    const defaults: Values = {};
    for (const d of catalog.settings) defaults[d.key] = d.default;
    setValues(defaults);
    setRaw({ gus: "", game: "", args: "" });
    setPresetMarks({});
  };

  const resetSection = (defs: SettingDef[]) => {
    setValues((v) => {
      const next = { ...v };
      for (const d of defs) next[d.key] = d.default;
      return next;
    });
    setPresetMarks((m) => {
      const next = { ...m };
      for (const d of defs) delete next[d.key];
      return next;
    });
  };

  useEffect(() => {
    apiGet<SettingsCatalog>(`/catalog/${game}`).then(setCatalog).catch(() => undefined);
  }, [game]);

  // All categories with their defs, in catalog order.
  const allByCat = useMemo(() => {
    const m = new Map<string, SettingDef[]>();
    for (const def of catalog?.settings ?? []) {
      const list = m.get(def.category) ?? [];
      list.push(def);
      m.set(def.category, list);
    }
    return m;
  }, [catalog]);

  // Effective value of any setting (current override, else its catalog default) —
  // used to evaluate cross-setting dependencies (e.g. PvE mode greys out PvP-only
  // options) against what the server would actually run with.
  const defaultByKey = useMemo(() => {
    const m: Record<string, unknown> = {};
    for (const d of catalog?.settings ?? []) m[d.key] = d.default;
    return m;
  }, [catalog]);
  const effectiveGet = (k: string) => (values[k] ?? defaultByKey[k]);

  const groupOf = (cat: string) => (MAPPED_CATS.has(cat) ? GROUPS.find((g) => g.cats.includes(cat))!.id : "advanced");

  // Changed-from-default count per tab, for the little badges.
  const changedByGroup = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of catalog?.settings ?? []) {
      if (!isOverridden(d) || !mapMatches(d.category)) continue;
      m.set(groupOf(d.category), (m.get(groupOf(d.category)) ?? 0) + 1);
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog, values, map]);

  // Sections to render: search results across everything, else the active tab.
  const sections = useMemo<[string, SettingDef[]][]>(() => {
    if (!catalog) return [];
    const q = query.trim().toLowerCase();
    if (q) {
      const out: [string, SettingDef[]][] = [];
      for (const [cat, defs] of allByCat) {
        if (!mapMatches(cat)) continue; // don't surface settings for other maps
        const matched = defs.filter((d) => matchesQuery(d, q)); // search includes advanced
        if (matched.length) out.push([cat, matched]);
      }
      return out;
    }
    if (presetFilter) {
      // Focus mode: every preset-touched setting, in place across all tabs.
      const out: [string, SettingDef[]][] = [];
      for (const [cat, defs] of allByCat) {
        if (!mapMatches(cat)) continue;
        const matched = defs.filter((d) => presetMarks[d.key] !== undefined);
        if (matched.length) out.push([cat, matched]);
      }
      return out;
    }
    const grp = GROUPS.find((g) => g.id === activeGroup) ?? GROUPS[0];
    let cats = grp.cats.filter((c) => allByCat.has(c) && mapMatches(c));
    if (grp.id === "advanced") {
      cats = [...cats, ...[...allByCat.keys()].filter((c) => !MAPPED_CATS.has(c))];
    }
    return cats
      .map((c) => [c, allByCat.get(c) ?? []] as [string, SettingDef[]])
      .filter(([, defs]) => defs.length > 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog, query, activeGroup, allByCat, map, presetFilter, presetMarks]);

  const searching = query.trim().length > 0;
  // Count of currently-visible (catalog + map-relevant) preset-set settings.
  const presetCount = useMemo(() => {
    if (!catalog) return 0;
    let n = 0;
    for (const d of catalog.settings) if (presetMarks[d.key] !== undefined && mapMatches(d.category)) n++;
    return n;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog, presetMarks, map]);

  const update = (key: string, value: unknown) => setValues((v) => ({ ...v, [key]: value }));

  // Presets (built-in + saved) merge a bundle of values over the current ones —
  // reversible via Reset / individual edits; changed badges reflect what moved.
  const presets = SETTINGS_PRESETS.filter((p) => !p.games || p.games.includes(game));

  // Load/save preset provenance per server (state declared near the top). Kept in
  // localStorage so the in-place badges + focus filter survive a refresh.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(`ark.presetMarks.${serverId}`);
      setPresetMarks(raw ? JSON.parse(raw) : {});
    } catch {
      setPresetMarks({});
    }
  }, [serverId]);
  useEffect(() => {
    try {
      localStorage.setItem(`ark.presetMarks.${serverId}`, JSON.stringify(presetMarks));
    } catch {
      /* ignore storage failures */
    }
  }, [presetMarks, serverId]);

  // Apply a preset's values and record provenance for each key it touched.
  const applyPreset = (label: string, vals: Record<string, unknown>) => {
    setValues((v) => ({ ...v, ...vals }));
    setPresetMarks((m) => {
      const next = { ...m };
      for (const [k, val] of Object.entries(vals)) next[k] = { preset: label, value: val };
      return next;
    });
  };

  // Custom presets live in the manager DB (per game): fetched here, applied like
  // built-ins, and created from whatever's currently changed from default.
  const [customPresets, setCustomPresets] = useState<CustomPreset[]>([]);
  useEffect(() => {
    apiGet<CustomPreset[]>(`/presets?game=${game}`).then(setCustomPresets).catch(() => undefined);
  }, [game]);

  const changedValues = (): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const d of catalog?.settings ?? []) if (isOverridden(d)) out[d.key] = values[d.key];
    return out;
  };
  const saveCustomPreset = async (name: string, description: string) => {
    const created = await apiPost<CustomPreset>("/presets", {
      name,
      description: description || undefined,
      game,
      values: changedValues(),
    });
    setCustomPresets((list) => [created, ...list]);
  };
  const deleteCustomPreset = async (id: string) => {
    await apiDelete(`/presets/${id}`);
    setCustomPresets((list) => list.filter((p) => p.id !== id));
  };

  const save = async () => {
    setBusy(true);
    setSaved(false);
    try {
      const config: ServerConfigValues = {
        values,
        rawGameUserSettingsIni: raw.gus || undefined,
        rawGameIni: raw.game || undefined,
        rawCommandLineArgs: raw.args || undefined,
      };
      await apiPatch(`/servers/${serverId}`, { config });
      setSaved(true);
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!catalog) return <div className="text-slate-400">Loading settings…</div>;

  const totalChanged = catalog.settings.filter(isOverridden).length;

  return (
    <div className="space-y-5">
      {game === Game.ICARUS && (
        <div className="flex items-start gap-2 rounded-md border border-ark-border bg-ark-bg px-3 py-2 text-xs text-slate-400">
          <MapIcon className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" />
          <span>
            Map + game mode aren&apos;t set here — Icarus bundles them into a{" "}
            <span className="text-slate-300">prospect</span> that players create from the in-game lobby (pick
            Olympus / Styx / Prometheus and Mission vs Open World there). These settings control the lobby +
            session behavior; the prospect then resumes across restarts.
          </span>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative min-w-[15rem] max-w-md flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
          <input
            className="input pl-8"
            placeholder="Search all settings…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="flex items-center gap-2">
          {totalChanged > 0 && <span className="text-xs text-slate-400">{totalChanged} changed</span>}
          {presetCount > 0 && (
            <button
              type="button"
              onClick={() => setPresetFilter((f) => !f)}
              title="Show only the settings a preset changed"
              className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors ${
                presetFilter
                  ? "bg-violet-500/20 text-violet-200"
                  : "bg-violet-500/10 text-violet-300 hover:bg-violet-500/20"
              }`}
            >
              <Sparkles className="h-3.5 w-3.5" /> Preset changes
              <span className="rounded-full bg-violet-500/25 px-1.5 text-[10px]">{presetCount}</span>
            </button>
          )}
          <PresetsMenu
            presets={presets}
            customPresets={customPresets}
            changedCount={totalChanged}
            onApply={applyPreset}
            onSave={saveCustomPreset}
            onDelete={deleteCustomPreset}
          />
          <button className="btn-secondary" onClick={resetAll}>
            <RotateCcw className="h-4 w-4" /> Reset all
          </button>
          <button className="btn-primary" onClick={save} disabled={busy}>
            <Save className="h-4 w-4" /> {busy ? "Saving…" : saved ? "Saved ✓" : "Save"}
          </button>
        </div>
      </div>

      {!searching && !presetFilter && (
        <div className="flex flex-wrap gap-1.5 border-b border-ark-border pb-2">
          {GROUPS.map((g) => {
            const active = g.id === activeGroup;
            const n = changedByGroup.get(g.id) ?? 0;
            return (
              <button
                key={g.id}
                type="button"
                onClick={() => changeGroup(g.id)}
                className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors ${
                  active
                    ? "bg-ark-accent/15 text-ark-accent"
                    : "text-slate-400 hover:bg-ark-border hover:text-slate-200"
                }`}
              >
                <g.Icon className="h-4 w-4 shrink-0" />
                {g.label}
                {n > 0 && (
                  <span
                    className={`rounded-full px-1.5 text-[10px] ${
                      active ? "bg-ark-accent/25 text-ark-accent" : "bg-ark-border text-slate-300"
                    }`}
                  >
                    {n}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {searching && (
        <div className="flex items-center justify-between text-sm text-slate-400">
          <span>
            {sections.reduce((a, [, d]) => a + d.length, 0)} result(s) for &ldquo;{query.trim()}&rdquo;
          </span>
          <button type="button" className="text-ark-accent hover:underline" onClick={() => setQuery("")}>
            Clear search
          </button>
        </div>
      )}

      {presetFilter && !searching && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-violet-500/30 bg-violet-500/10 px-3 py-2 text-sm text-violet-200">
          <span className="flex items-center gap-1.5">
            <Sparkles className="h-4 w-4 shrink-0" />
            Showing {sections.reduce((a, [, d]) => a + d.length, 0)} setting(s) changed by presets — in their normal sections.
          </span>
          <div className="flex items-center gap-3">
            <button
              type="button"
              className="hover:underline"
              title="Forget which settings came from presets (doesn't change any values)"
              onClick={() => setPresetMarks({})}
            >
              Clear marks
            </button>
            <button type="button" className="text-violet-300 hover:underline" onClick={() => setPresetFilter(false)}>
              Done
            </button>
          </div>
        </div>
      )}

      {sections.map(([category, defs]) => {
        const changed = defs.filter(isOverridden).length;
        const isCollapsed = !searching && collapsed.has(category);
        return (
          <div key={category} className="card">
            <div className="flex w-full items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => toggle(category)}
                className="flex flex-1 items-center gap-2 text-left"
              >
                {isCollapsed ? (
                  <ChevronRight className="h-4 w-4 shrink-0" />
                ) : (
                  <ChevronDown className="h-4 w-4 shrink-0" />
                )}
                <h3 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-ark-accent2">
                  {category}
                </h3>
              </button>
              <div className="flex items-center gap-2">
                {changed > 0 && (
                  <span className="rounded-full bg-ark-accent/15 px-2 py-0.5 text-[11px] font-medium text-ark-accent">
                    {changed} changed
                  </span>
                )}
                {changed > 0 && (
                  <button
                    type="button"
                    onClick={() => resetSection(defs)}
                    title="Reset this section to defaults"
                    className="flex items-center gap-1 rounded p-1 text-xs text-slate-400 hover:bg-ark-border hover:text-slate-200"
                  >
                    <RotateCcw className="h-3.5 w-3.5" /> Reset
                  </button>
                )}
              </div>
            </div>
            {!isCollapsed && (
              <div className="mt-3 grid gap-4 md:grid-cols-2">
                {defs.map((def) => {
                  const mk = presetMarks[def.key];
                  const cur = values[def.key] ?? def.default;
                  return (
                    <Field
                      key={def.key}
                      def={def}
                      game={game}
                      value={cur}
                      onChange={update}
                      overridden={isOverridden(def)}
                      get={effectiveGet}
                      presetMark={
                        mk
                          ? { preset: mk.preset, edited: JSON.stringify(cur) !== JSON.stringify(mk.value) }
                          : undefined
                      }
                    />
                  );
                })}
              </div>
            )}
          </div>
        );
      })}

      {sections.length === 0 && (
        <div className="card text-sm text-slate-400">
          {searching
            ? `No settings match “${query.trim()}”.`
            : presetFilter
              ? "No preset-set settings to review — apply a preset, or clear this filter."
            : activeGroup === "maps"
              ? `No map-specific settings for ${mapLabel(map)}. This tab only shows options for maps like Ragnarok, Genesis, Lost Colony, Fjordur or Astraeos.`
              : "Nothing here."}
        </div>
      )}

      {/* Raw passthrough lives under the Advanced tab. */}
      {activeGroup === "advanced" && !searching && (
        <div className="card space-y-4">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-ark-accent2">
            Raw passthrough (anything not above)
          </h3>
          <RawArea label="GameUserSettings.ini" value={raw.gus} onChange={(v) => setRaw((r) => ({ ...r, gus: v }))} />
          <RawArea label="Game.ini" value={raw.game} onChange={(v) => setRaw((r) => ({ ...r, game: v }))} />
          <div>
            <label className="label">Extra command-line args</label>
            <input className="input" value={raw.args} onChange={(e) => setRaw((r) => ({ ...r, args: e.target.value }))} />
          </div>
        </div>
      )}
    </div>
  );
}

/** Dropdown of one-click setting bundles (single-player difficulty, fast breeding…). */
function PresetsMenu({
  presets,
  customPresets,
  changedCount,
  onApply,
  onSave,
  onDelete,
}: {
  presets: SettingsPreset[];
  customPresets: CustomPreset[];
  changedCount: number;
  onApply: (label: string, values: Record<string, unknown>) => void;
  onSave: (name: string, description: string) => Promise<void>;
  onDelete: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click — the inner save form needs focus, so we can't close
  // on the trigger's blur the way a plain menu would.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const save = async () => {
    if (!name.trim() || changedCount === 0 || saving) return;
    setSaving(true);
    try {
      await onSave(name.trim(), desc.trim());
      setName("");
      setDesc("");
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="relative" ref={ref}>
      <button type="button" className="btn-secondary" onClick={() => setOpen((o) => !o)}>
        <Sparkles className="h-4 w-4" /> Presets
        <ChevronDown className="h-3.5 w-3.5" />
      </button>
      {open && (
        <div className="absolute right-0 z-40 mt-1 max-h-[70vh] w-80 overflow-auto rounded-md border border-ark-border bg-ark-panel shadow-xl">
          <div className="border-b border-ark-border px-3 py-2 text-[11px] uppercase tracking-wide text-slate-500">
            Apply a preset
          </div>
          {presets.map((p) => (
            <button
              type="button"
              key={p.id}
              className="block w-full px-3 py-2 text-left hover:bg-ark-border"
              onClick={() => {
                onApply(p.label, p.values);
                setOpen(false);
              }}
            >
              <div className="text-sm font-medium text-slate-200">{p.label}</div>
              <div className="mt-0.5 text-[11px] leading-relaxed text-slate-400">{p.description}</div>
            </button>
          ))}

          {customPresets.length > 0 && (
            <>
              <div className="border-y border-ark-border px-3 py-2 text-[11px] uppercase tracking-wide text-slate-500">
                Your presets
              </div>
              {customPresets.map((p) => (
                <div key={p.id} className="flex items-start gap-1 hover:bg-ark-border">
                  <button
                    type="button"
                    className="block flex-1 px-3 py-2 text-left"
                    onClick={() => {
                      onApply(p.name, p.values);
                      setOpen(false);
                    }}
                  >
                    <div className="text-sm font-medium text-slate-200">{p.name}</div>
                    <div className="mt-0.5 text-[11px] leading-relaxed text-slate-400">
                      {p.description || `${Object.keys(p.values).length} setting(s)`}
                    </div>
                  </button>
                  <button
                    type="button"
                    title="Delete preset"
                    className="mr-1 mt-2 rounded p-1 text-slate-500 hover:bg-ark-bg hover:text-red-400"
                    onClick={() => {
                      if (confirm(`Delete preset “${p.name}”?`)) onDelete(p.id);
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </>
          )}

          <div className="space-y-2 border-t border-ark-border p-3">
            <div className="text-[11px] uppercase tracking-wide text-slate-500">Save current as preset</div>
            {changedCount === 0 ? (
              <p className="text-[11px] leading-relaxed text-slate-500">
                Change some settings first — a preset captures everything you&apos;ve changed from default.
              </p>
            ) : (
              <>
                <p className="text-[11px] text-slate-400">Captures your {changedCount} changed setting(s).</p>
                <input
                  className="input py-1 text-sm"
                  placeholder="Preset name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
                <input
                  className="input py-1 text-sm"
                  placeholder="Description (optional)"
                  value={desc}
                  onChange={(e) => setDesc(e.target.value)}
                />
                <button
                  type="button"
                  className="btn-primary w-full justify-center py-1.5 text-sm"
                  disabled={!name.trim() || saving}
                  onClick={save}
                >
                  <Save className="h-4 w-4" /> {saving ? "Saving…" : "Save preset"}
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// Cache the version list per game across field remounts (one network trip per game).
const versionsCache = new Map<Game, GameVersionsResult>();

/**
 * Dropdown of published GAME versions fetched live from GET /games/:game/versions
 * (Minecraft/OpenTTD), so the user picks a real version instead of guessing. The
 * shipped default (LATEST / latest) is the first option; a currently-pinned value not
 * in the list stays selectable; and if the list can't load we fall back to a text box.
 */
function VersionSelectField({
  def,
  game,
  value,
  onChange,
}: {
  def: SettingDef;
  game: Game;
  value: unknown;
  onChange: (key: string, value: unknown) => void;
}) {
  const [data, setData] = useState<GameVersionsResult | null>(versionsCache.get(game) ?? null);
  const [failed, setFailed] = useState(false);
  const current = String(value ?? "");

  useEffect(() => {
    if (data) return;
    let live = true;
    apiGet<GameVersionsResult>(`/games/${game}/versions`)
      .then((r) => {
        if (!live) return;
        if (r.options.length) {
          versionsCache.set(game, r);
          setData(r);
        } else setFailed(true); // no provider / empty — degrade to text input
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [game, data]);

  // Couldn't load a list → let the user still type a version by hand.
  if (failed) {
    return <input className="input" value={current} onChange={(e) => onChange(def.key, e.target.value)} />;
  }
  if (!data) {
    return (
      <select className="input" disabled>
        <option>Loading versions…</option>
      </select>
    );
  }

  const known = new Set([data.defaultValue, ...data.options.map((o) => o.value)]);
  return (
    <select className="input" value={current} onChange={(e) => onChange(def.key, e.target.value)}>
      <option value={data.defaultValue}>{data.defaultLabel}</option>
      {/* A pinned value the registry no longer lists stays selectable. */}
      {current && !known.has(current) && <option value={current}>{current} (pinned)</option>}
      {data.options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function Field({
  def,
  game,
  value,
  onChange,
  overridden,
  get,
  presetMark,
}: {
  def: SettingDef;
  game: Game;
  value: unknown;
  onChange: (key: string, value: unknown) => void;
  overridden?: boolean;
  get?: (k: string) => unknown;
  presetMark?: { preset: string; edited: boolean };
}) {
  // A setting may be inactive because another one disables it (e.g. PvE mode
  // greys out PvP-only options, a master toggle being off greys its sub-options).
  const dep = get ? settingActive(def.key, get) : { active: true as const, reason: undefined };
  // displayScale lets a numeric field show a derived figure (e.g. difficulty ×30
  // = max wild creature level) while still storing the raw value.
  const scale = def.displayScale ?? 1;
  const stepRaw = def.step ?? (def.type === "float" ? 0.1 : 1);
  const round = (x: number, p: number) => Math.round(x * 10 ** p) / 10 ** p;
  const toShown = (v: unknown) => round(Number(v) * scale, 2);
  const toStored = (shown: number) => round(shown / scale, 3);
  const shownMin = def.min != null ? round(def.min * scale, 2) : undefined;
  const shownMax = def.max != null ? round(def.max * scale, 2) : undefined;
  const shownStep = round(stepRaw * scale, 3);
  return (
    <div className={STRUCTURED.has(def.type) ? "md:col-span-2" : undefined}>
      <FieldLabel label={def.label} help={def.help} overridden={overridden} />
      {presetMark && (
        <span
          title={
            presetMark.edited
              ? `You changed this after the "${presetMark.preset}" preset set it`
              : `Set by preset: ${presetMark.preset}`
          }
          className={`mb-1 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide ${
            presetMark.edited
              ? "bg-amber-500/15 text-amber-400/90"
              : "bg-violet-500/15 text-violet-300"
          }`}
        >
          <Sparkles className="h-2.5 w-2.5" />
          {presetMark.edited ? `preset · edited` : presetMark.preset}
        </span>
      )}
      <fieldset disabled={!dep.active} className={`min-w-0 ${dep.active ? "" : "opacity-50"}`}>
      {def.optionsSource === "game-versions" ? (
        <VersionSelectField def={def} game={game} value={value} onChange={onChange} />
      ) : def.type === "grid" ? (
        <GridField def={def} value={value} onChange={onChange} />
      ) : def.type === "motd" ? (
        <MotdField def={def} value={value} onChange={onChange} />
      ) : def.type === "itemmax" ? (
        <ItemMaxField def={def} value={value} onChange={onChange} />
      ) : def.type === "spawnweight" ? (
        <SpawnWeightField def={def} value={value} onChange={onChange} />
      ) : def.type === "npcreplace" ? (
        <NpcReplaceField def={def} value={value} onChange={onChange} />
      ) : def.type === "levelramp" ? (
        <LevelRampField def={def} value={value} onChange={onChange} />
      ) : def.type === "engrams" ? (
        <EngramsField def={def} value={value} onChange={onChange} />
      ) : def.type === "lootcrate" ? (
        <LootCrateField def={def} value={value} onChange={onChange} />
      ) : def.type === "spawncontainer" ? (
        <SpawnContainerField def={def} value={value} onChange={onChange} />
      ) : def.type === "craftcost" ? (
        <CraftCostField def={def} value={value} onChange={onChange} />
      ) : def.type === "bool" ? (
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => onChange(def.key, e.target.checked)}
          className="h-4 w-4"
        />
      ) : def.type === "enum" ? (
        <select className="input" value={String(value)} onChange={(e) => onChange(def.key, e.target.value)}>
          {(def.choices ?? (def.options ?? []).map((o) => ({ value: o, label: o }))).map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      ) : def.type === "multiselect" ? (
        <MultiSelectField def={def} value={value} onChange={onChange} />
      ) : def.type === "weekdays" ? (
        <WeekdaysField def={def} value={value} onChange={onChange} />
      ) : def.type === "time" ? (
        <input
          type="time"
          className="input w-auto"
          value={String(value ?? "")}
          onChange={(e) => onChange(def.key, e.target.value)}
        />
      ) : def.type === "string" ? (
        <input className="input" value={String(value)} onChange={(e) => onChange(def.key, e.target.value)} />
      ) : (
        <div className="flex items-end gap-3">
          <div className="flex-1">
            {(def.minLabel || def.maxLabel) && (
              <div className="mb-1 flex justify-between text-[10px] uppercase tracking-wide text-slate-500">
                <span>← {def.minLabel}</span>
                <span>{def.maxLabel} →</span>
              </div>
            )}
            <input
              type="range"
              className="h-2 w-full cursor-pointer accent-ark-accent"
              min={shownMin ?? 0}
              max={shownMax ?? 100}
              step={shownStep}
              value={toShown(value)}
              onChange={(e) => onChange(def.key, toStored(Number(e.target.value)))}
            />
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <input
              type="number"
              className={`w-20 rounded-lg border bg-ark-bg px-2 py-1.5 text-right text-sm outline-none focus:border-ark-accent2 ${
                overridden ? "border-ark-accent/70 text-ark-accent" : "border-ark-border"
              }`}
              min={shownMin}
              max={shownMax}
              step={shownStep}
              value={toShown(value)}
              onChange={(e) => onChange(def.key, toStored(Number(e.target.value)))}
            />
            {def.unit && <span className="text-xs text-slate-500">{def.unit}</span>}
          </div>
        </div>
      )}
      {(def.type === "int" || def.type === "float") && (
        <p className="mt-1 text-xs text-slate-500">
          Range {shownMin ?? 0} – {shownMax ?? "∞"}
          {def.unit ? ` ${def.unit}` : ""}
          {stepRaw ? ` · step ${shownStep}` : ""}
          {scale !== 1 ? ` · difficulty ${round(Number(value), 2)}` : ""}
        </p>
      )}
      </fieldset>
      {!dep.active && dep.reason && (
        <p className="mt-1 flex items-center gap-1 text-[11px] text-amber-400/80">
          <Info className="h-3 w-3 shrink-0" /> {dep.reason}
        </p>
      )}
    </div>
  );
}

function FieldLabel({ label, help, overridden }: { label: string; help?: string; overridden?: boolean }) {
  return (
    <div
      className={`label group relative mb-1 flex w-fit items-center gap-1.5 ${
        overridden ? "text-ark-accent" : ""
      }`}
    >
      {overridden && (
        <span
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-ark-accent"
          title="Changed from default"
        />
      )}
      <span className={help ? "cursor-help border-b border-dotted border-slate-600" : ""}>
        {label}
      </span>
      {help && <Info className="h-3 w-3 text-slate-500 group-hover:text-slate-300" />}
      {help && (
        <span
          role="tooltip"
          className="pointer-events-none absolute left-0 top-full z-30 mt-1 hidden w-64 rounded-md border border-ark-border bg-ark-panel px-3 py-2 text-xs normal-case leading-relaxed tracking-normal text-slate-200 shadow-xl group-hover:block"
        >
          {help}
        </span>
      )}
    </div>
  );
}

function RawArea({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <label className="label">{label}</label>
      <textarea
        className="input h-28 font-mono text-xs"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="[CustomSection]&#10;Key=Value"
      />
    </div>
  );
}

type WidgetProps = { def: SettingDef; value: unknown; onChange: (key: string, value: unknown) => void };

/** Compact number input that shows its valid min–max beneath the box. */
function RangeNum({
  value,
  onChange,
  min,
  max,
  step = 1,
  label,
  width = "w-16",
}: {
  value: number;
  onChange: (n: number) => void;
  min?: number;
  max?: number;
  step?: number;
  label?: string;
  width?: string;
}) {
  return (
    <label className="flex items-center gap-1 text-xs text-slate-400">
      {label}
      <span className="inline-flex flex-col items-stretch">
        <input
          type="number"
          className={`${width} shrink-0 rounded border border-ark-border bg-ark-bg px-1.5 py-1 text-right text-sm outline-none focus:border-ark-accent2`}
          min={min}
          max={max}
          step={step}
          value={numd(value, min ?? 0)}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        {(min !== undefined || max !== undefined) && (
          <span className="mt-0.5 text-center text-[9px] leading-none text-slate-600">
            {min ?? "−∞"}–{max ?? "∞"}
          </span>
        )}
      </span>
    </label>
  );
}

/** Per-stat multiplier grid (value: Record<statKey, number>, default 1 each). */
function GridField({ def, value, onChange }: WidgetProps) {
  const v = (value && typeof value === "object" ? value : {}) as Record<string, number>;
  const set = (rowKey: string, n: number) => onChange(def.key, { ...v, [rowKey]: n });
  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {(def.gridRows ?? []).map((row) => (
        <div
          key={row.key}
          className="flex items-center justify-between gap-2 rounded-lg border border-ark-border bg-ark-bg px-2.5 py-1.5"
        >
          <span className="text-xs text-slate-400">{row.label}</span>
          <RangeNum
            value={Number(v[row.key] ?? 1)}
            onChange={(n) => set(row.key, n)}
            min={0}
            max={100}
            step={0.1}
          />
        </div>
      ))}
    </div>
  );
}

/** Message of the Day: message + on-screen duration. */
function MotdField({ def, value, onChange }: WidgetProps) {
  const v = (value && typeof value === "object" ? value : { message: "", duration: 20 }) as MotdValue;
  return (
    <div className="space-y-2">
      <textarea
        className="input h-20"
        placeholder="Shown to players when they join…"
        value={v.message ?? ""}
        onChange={(e) => onChange(def.key, { ...v, message: e.target.value })}
      />
      <RangeNum
        label="Duration (seconds)"
        value={Number(v.duration ?? 20)}
        onChange={(n) => onChange(def.key, { ...v, duration: n })}
        min={1}
        max={600}
        width="w-20"
      />
    </div>
  );
}

/** Item max-stack overrides: a list of {item, max, ignoreMult}. */
function ItemMaxField({ def, value, onChange }: WidgetProps) {
  const arr = (Array.isArray(value) ? value : []) as ItemMaxEntry[];
  const set = (next: ItemMaxEntry[]) => onChange(def.key, next);
  const patch = (i: number, p: Partial<ItemMaxEntry>) =>
    set(arr.map((e, j) => (j === i ? { ...e, ...p } : e)));
  return (
    <div className="space-y-3">
      <p className="rounded-md bg-ark-bg/60 px-3 py-2 text-xs leading-relaxed text-slate-400">
        Set how many of a specific item can stack in one inventory slot. Pick an item and a stack
        size — for example stack Wood to 1000. &ldquo;Exact&rdquo; uses your number as-is; leave it
        off to multiply it by the global item stack-size multiplier.
      </p>
      {arr.map((e, i) => (
        <div key={i} className="flex flex-wrap items-center gap-3">
          <ItemPicker value={e.item ?? ""} onChange={(cls) => patch(i, { item: cls })} />
          <div className="flex items-center gap-1">
            <span className="text-xs text-slate-400">stack to</span>
            <Hint text="The most of this item that fit in a single inventory slot." />
            <RangeNum value={Number(e.max) || 0} onChange={(n) => patch(i, { max: n })} min={1} max={100000} width="w-24" />
          </div>
          <label className="flex items-center gap-1 text-xs text-slate-400">
            <input
              type="checkbox"
              checked={!!e.ignoreMult}
              onChange={(ev) => patch(i, { ignoreMult: ev.target.checked })}
            />
            exact
            <Hint text="Use this exact stack size, ignoring the global item stack-size multiplier. Off = your number is multiplied by it." />
          </label>
          <button type="button" className="btn-danger px-2" onClick={() => set(arr.filter((_, j) => j !== i))}>
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      ))}
      <button
        type="button"
        className="btn-secondary"
        onClick={() => set([...arr, { item: "", max: 100, ignoreMult: true }])}
      >
        <Plus className="h-4 w-4" /> Add item
      </button>
    </div>
  );
}

/** Checkboxes for a multiselect (value: string[] of selected choice values). */
function MultiSelectField({ def, value, onChange }: WidgetProps) {
  const arr = (Array.isArray(value) ? value : []) as string[];
  const toggle = (v: string, on: boolean) =>
    onChange(def.key, on ? [...arr, v] : arr.filter((x) => x !== v));
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-2">
      {(def.choices ?? []).map((c) => (
        <label key={c.value} className="flex items-center gap-1.5 text-sm text-slate-300">
          <input
            type="checkbox"
            checked={arr.includes(c.value)}
            onChange={(e) => toggle(c.value, e.target.checked)}
          />
          {c.label}
        </label>
      ))}
    </div>
  );
}

const WEEKDAYS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
] as const;

/** Day-of-week picker — toggle chips, stored as a comma-joined string in weekday
 *  order (e.g. "Saturday,Sunday"). Empty = every day / unrestricted. */
function WeekdaysField({ def, value, onChange }: WidgetProps) {
  const selected = new Set(
    String(value ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const toggle = (day: string) => {
    const next = new Set(selected);
    next.has(day) ? next.delete(day) : next.add(day);
    onChange(def.key, WEEKDAYS.filter((d) => next.has(d)).join(","));
  };
  return (
    <div className="flex flex-wrap gap-1.5">
      {WEEKDAYS.map((d) => {
        const on = selected.has(d);
        return (
          <button
            type="button"
            key={d}
            onClick={() => toggle(d)}
            className={`rounded-md border px-2 py-1 text-xs font-medium transition-colors ${
              on
                ? "border-ark-accent bg-ark-accent/15 text-ark-accent"
                : "border-ark-border text-slate-300 hover:border-slate-600"
            }`}
          >
            {d.slice(0, 3)}
          </button>
        );
      })}
    </div>
  );
}

/** Searchable item combobox: pick a known item or type a custom class string. */
function ItemPicker({ value, onChange }: { value: string; onChange: (className: string) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const selected = ARK_ITEMS.find((i) => i.className === value);
  const display = selected ? selected.name : value;
  const query = q.trim().toLowerCase();
  const results = (
    query
      ? ARK_ITEMS.filter(
          (i) => i.name.toLowerCase().includes(query) || i.className.toLowerCase().includes(query),
        )
      : ARK_ITEMS
  ).slice(0, 40);
  return (
    <div className="relative min-w-[14rem] flex-1">
      <input
        className="input"
        placeholder="Search item…"
        value={open ? q : display}
        onFocus={() => {
          setOpen(true);
          setQ("");
        }}
        onChange={(e) => setQ(e.target.value)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {open && (
        <div className="absolute z-40 mt-1 max-h-60 w-full overflow-auto rounded-md border border-ark-border bg-ark-panel shadow-xl">
          {results.map((i) => (
            <button
              type="button"
              key={i.className}
              className="block w-full px-3 py-1.5 text-left hover:bg-ark-border"
              onMouseDown={() => {
                onChange(i.className);
                setOpen(false);
              }}
            >
              <div className="text-sm">{i.name}</div>
              <div className="text-[10px] text-slate-500">{i.className}</div>
            </button>
          ))}
          {query && (
            <button
              type="button"
              className="block w-full border-t border-ark-border px-3 py-1.5 text-left text-sm text-slate-400 hover:bg-ark-border"
              onMouseDown={() => {
                onChange(q.trim());
                setOpen(false);
              }}
            >
              Use custom class “{q.trim()}”
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Searchable creature combobox; emits the tag or class name per `valueKey`. */
function CreaturePicker({
  value,
  valueKey,
  onChange,
  placeholder,
}: {
  value: string;
  valueKey: "tag" | "className";
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const selected = ARK_CREATURES.find((c) => c[valueKey] === value);
  const display = selected ? selected.name : value;
  const query = q.trim().toLowerCase();
  const results = (
    query
      ? ARK_CREATURES.filter(
          (c) =>
            c.name.toLowerCase().includes(query) ||
            c.tag.toLowerCase().includes(query) ||
            c.className.toLowerCase().includes(query),
        )
      : ARK_CREATURES
  ).slice(0, 40);
  return (
    <div className="relative min-w-[12rem] flex-1">
      <input
        className="input"
        placeholder={placeholder ?? "Search creature…"}
        value={open ? q : display}
        onFocus={() => {
          setOpen(true);
          setQ("");
        }}
        onChange={(e) => setQ(e.target.value)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {open && (
        <div className="absolute z-40 mt-1 max-h-60 w-full overflow-auto rounded-md border border-ark-border bg-ark-panel shadow-xl">
          {results.map((c) => (
            <button
              type="button"
              key={c.className}
              className="block w-full px-3 py-1.5 text-left hover:bg-ark-border"
              onMouseDown={() => {
                onChange(c[valueKey]);
                setOpen(false);
              }}
            >
              <div className="text-sm">{c.name}</div>
              <div className="text-[10px] text-slate-500">{c[valueKey]}</div>
            </button>
          ))}
          {query && (
            <button
              type="button"
              className="block w-full border-t border-ark-border px-3 py-1.5 text-left text-sm text-slate-400 hover:bg-ark-border"
              onMouseDown={() => {
                onChange(q.trim());
                setOpen(false);
              }}
            >
              Use custom “{q.trim()}”
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Per-creature spawn weights (value: SpawnWeightEntry[]). */
function SpawnWeightField({ def, value, onChange }: WidgetProps) {
  const arr = (Array.isArray(value) ? value : []) as SpawnWeightEntry[];
  const set = (next: SpawnWeightEntry[]) => onChange(def.key, next);
  const patch = (i: number, p: Partial<SpawnWeightEntry>) =>
    set(arr.map((e, j) => (j === i ? { ...e, ...p } : e)));
  return (
    <div className="space-y-3">
      <p className="rounded-md bg-ark-bg/60 px-3 py-2 text-xs leading-relaxed text-slate-400">
        Make specific creatures spawn more or less often. Weight is relative — a creature with weight
        5 spawns roughly 5× as often as one at weight 1. Lower it (e.g. 0.1) to make a creature rare.
        Optionally cap how much of a spawn area a creature is allowed to take over.
      </p>
      {arr.map((e, i) => (
        <div key={i} className="flex flex-wrap items-center gap-3">
          <CreaturePicker value={e.tag ?? ""} valueKey="tag" onChange={(t) => patch(i, { tag: t })} />
          <div className="flex items-center gap-1">
            <span className="text-xs text-slate-400">weight ×</span>
            <Hint text="How often this creature spawns relative to the others. 1 = normal, higher = more common, 0.1 = rare." />
            <RangeNum value={Number(e.weight) || 1} onChange={(n) => patch(i, { weight: n })} min={0} max={100} step={0.1} />
          </div>
          <label className="flex items-center gap-1 text-xs text-slate-400">
            <input
              type="checkbox"
              checked={!!e.limitOverride}
              onChange={(ev) => patch(i, { limitOverride: ev.target.checked })}
            />
            cap share
            <Hint text="Also limit the maximum share of a spawn area this creature can occupy (set the % below)." />
          </label>
          {e.limitOverride && (
            <div className="flex items-center gap-1">
              <span className="text-xs text-slate-400">max</span>
              <Hint text="The most of a single spawn region this creature can fill — e.g. 20% means at most a fifth of that area's creatures." />
              <RangeNum value={Number(e.limitPercent) || 0} onChange={(n) => patch(i, { limitPercent: n })} min={0} max={100} />
              <span className="text-xs text-slate-400">%</span>
            </div>
          )}
          <button type="button" className="btn-danger px-2" onClick={() => set(arr.filter((_, j) => j !== i))}>
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      ))}
      <button
        type="button"
        className="btn-secondary"
        onClick={() => set([...arr, { tag: "", weight: 5, limitOverride: false, limitPercent: 50 }])}
      >
        <Plus className="h-4 w-4" /> Add creature
      </button>
    </div>
  );
}

/** Creature spawn replacements (value: NpcReplaceEntry[]). Empty "to" disables. */
function NpcReplaceField({ def, value, onChange }: WidgetProps) {
  const arr = (Array.isArray(value) ? value : []) as NpcReplaceEntry[];
  const set = (next: NpcReplaceEntry[]) => onChange(def.key, next);
  const patch = (i: number, p: Partial<NpcReplaceEntry>) =>
    set(arr.map((e, j) => (j === i ? { ...e, ...p } : e)));
  return (
    <div className="space-y-3">
      <p className="rounded-md bg-ark-bg/60 px-3 py-2 text-xs leading-relaxed text-slate-400">
        Swap one creature&apos;s spawns for another everywhere on the map (e.g. replace all Rex with
        Giga), or remove a creature entirely by leaving the &ldquo;replace with&rdquo; field empty —
        handy for turning off Alphas or unwanted creatures.
      </p>
      {arr.map((e, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2">
          <CreaturePicker
            value={e.from ?? ""}
            valueKey="className"
            onChange={(c) => patch(i, { from: c })}
            placeholder="Creature to replace…"
          />
          <span className="text-xs text-slate-500">→</span>
          <CreaturePicker
            value={e.to ?? ""}
            valueKey="className"
            onChange={(c) => patch(i, { to: c })}
            placeholder="Replace with… (empty = disable)"
          />
          <Hint text="Pick a creature to replace it with, or leave empty to stop this creature from spawning at all." />
          {!e.to && <span className="text-xs italic text-amber-400">disables spawn</span>}
          <button type="button" className="btn-danger px-2" onClick={() => set(arr.filter((_, j) => j !== i))}>
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      ))}
      <button type="button" className="btn-secondary" onClick={() => set([...arr, { from: "", to: "" }])}>
        <Plus className="h-4 w-4" /> Add replacement
      </button>
    </div>
  );
}

function LabeledNum({
  label,
  value,
  onChange,
  step,
  min,
  max,
  hint,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  step?: number;
  min?: number;
  max?: number;
  hint?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 flex items-center gap-1 text-[11px] text-slate-400">
        {label}
        {(min !== undefined || max !== undefined) && (
          <span className="text-slate-600">({min ?? "−∞"}–{max ?? "∞"})</span>
        )}
        {hint && <Hint text={hint} />}
      </span>
      <input
        type="number"
        className="input"
        step={step ?? 1}
        min={min}
        max={max}
        value={numd(value, min ?? 0)}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

/** Searchable engram combobox: pick a known engram or type a custom class. */
function EngramPicker({ value, onChange }: { value: string; onChange: (className: string) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const selected = ARK_ENGRAMS.find((e) => e.className === value);
  const display = selected ? selected.name : value;
  const query = q.trim().toLowerCase();
  const results = (
    query
      ? ARK_ENGRAMS.filter(
          (e) => e.name.toLowerCase().includes(query) || e.className.toLowerCase().includes(query),
        )
      : ARK_ENGRAMS
  ).slice(0, 40);
  return (
    <div className="relative min-w-[12rem] flex-1">
      <input
        className="input"
        placeholder="Search engram…"
        value={open ? q : display}
        onFocus={() => {
          setOpen(true);
          setQ("");
        }}
        onChange={(e) => setQ(e.target.value)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {open && (
        <div className="absolute z-40 mt-1 max-h-60 w-full overflow-auto rounded-md border border-ark-border bg-ark-panel shadow-xl">
          {results.map((e) => (
            <button
              type="button"
              key={e.className}
              className="block w-full px-3 py-1.5 text-left hover:bg-ark-border"
              onMouseDown={() => {
                onChange(e.className);
                setOpen(false);
              }}
            >
              <div className="text-sm">{e.name}</div>
              <div className="text-[10px] text-slate-500">{e.className}</div>
            </button>
          ))}
          {query && (
            <button
              type="button"
              className="block w-full border-t border-ark-border px-3 py-1.5 text-left text-sm text-slate-400 hover:bg-ark-border"
              onMouseDown={() => {
                onChange(q.trim());
                setOpen(false);
              }}
            >
              Use custom class “{q.trim()}”
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Level cap + XP curve (generator-based; arrays derived via computeLevelRamp). */
function LevelRampField({ def, value, onChange }: WidgetProps) {
  const v = (value && typeof value === "object"
    ? value
    : {
        player: { maxLevel: 0, baseXp: 10, growth: 1.05, engramPerLevel: 8 },
        dino: { maxLevel: 0, baseXp: 10, growth: 1.05 },
      }) as LevelRampValue;
  const setP = (p: Partial<LevelRampValue["player"]>) =>
    onChange(def.key, { ...v, player: { ...v.player, ...p } });
  const setD = (p: Partial<LevelRampValue["dino"]>) =>
    onChange(def.key, { ...v, dino: { ...v.dino, ...p } });
  const preview = computeLevelRamp(v);
  const MAX_HINT = "The highest level that can be reached. Set to 0 to leave the game's default cap unchanged.";
  const BASE_HINT = "XP needed for the very first level-up. Every level after this costs progressively more (see growth).";
  const GROWTH_HINT = "How much harder each level gets than the one before. 1.0 = every level costs the same; 1.05 = each level needs 5% more XP; higher = a steeper grind.";
  return (
    <div className="space-y-3">
      <p className="rounded-md bg-ark-bg/60 px-3 py-2 text-xs leading-relaxed text-slate-400">
        Raise the level cap and shape the XP curve for players and dinos. The XP needed at each level
        is generated from the values below — set a max level above 0 to turn it on. The preview shows
        the resulting curve. (For exact, hand-tuned per-level XP, use the raw box at the bottom.)
      </p>
      <div className="rounded-lg border border-ark-border bg-ark-bg p-3">
        <div className="mb-2 text-xs font-semibold text-slate-300">Players</div>
        <div className="grid gap-2 sm:grid-cols-4">
          <LabeledNum label="Max level" hint={MAX_HINT} min={0} max={1000} value={v.player.maxLevel} onChange={(n) => setP({ maxLevel: n })} />
          <LabeledNum label="First-level XP" hint={BASE_HINT} min={1} max={100000} value={v.player.baseXp} onChange={(n) => setP({ baseXp: n })} />
          <LabeledNum label="Growth ×" hint={GROWTH_HINT} min={0.5} max={5} step={0.01} value={v.player.growth} onChange={(n) => setP({ growth: n })} />
          <LabeledNum label="Engram pts/level" hint="Engram points granted at each level, used to unlock recipes." min={0} max={1000} value={v.player.engramPerLevel} onChange={(n) => setP({ engramPerLevel: n })} />
        </div>
        <div className="mt-2 text-[11px] text-slate-500">
          {preview.playerXp.length
            ? `→ Players reach level ${preview.playerXp.length + 1}; total XP for the last level ≈ ${preview.playerXp[preview.playerXp.length - 1].toLocaleString()}`
            : "Set max level above 0 to enable."}
        </div>
      </div>
      <div className="rounded-lg border border-ark-border bg-ark-bg p-3">
        <div className="mb-2 text-xs font-semibold text-slate-300">Dinos</div>
        <div className="grid gap-2 sm:grid-cols-3">
          <LabeledNum label="Max level" hint={MAX_HINT} min={0} max={1000} value={v.dino.maxLevel} onChange={(n) => setD({ maxLevel: n })} />
          <LabeledNum label="First-level XP" hint={BASE_HINT} min={1} max={100000} value={v.dino.baseXp} onChange={(n) => setD({ baseXp: n })} />
          <LabeledNum label="Growth ×" hint={GROWTH_HINT} min={0.5} max={5} step={0.01} value={v.dino.growth} onChange={(n) => setD({ growth: n })} />
        </div>
        <div className="mt-2 text-[11px] text-slate-500">
          {preview.dinoXp.length ? `→ Dinos reach level ${preview.dinoXp.length + 1}` : "Set max level above 0 to enable."}
        </div>
      </div>
    </div>
  );
}

/** Per-engram overrides (hide / cost / level req / prereq / auto-unlock). */
function EngramsField({ def, value, onChange }: WidgetProps) {
  const v = (value && typeof value === "object" ? value : { overrides: [], autoUnlockOnly: [] }) as EngramsValue;
  const arr = v.overrides ?? [];
  const set = (next: EngramOverride[]) => onChange(def.key, { ...v, overrides: next, autoUnlockOnly: v.autoUnlockOnly ?? [] });
  const patch = (i: number, p: Partial<EngramOverride>) => set(arr.map((e, j) => (j === i ? { ...e, ...p } : e)));
  const numOrUndef = (s: string) => (s === "" ? undefined : Number(s));
  return (
    <div className="space-y-3">
      <p className="rounded-md bg-ark-bg/60 px-3 py-2 text-xs leading-relaxed text-slate-400">
        Customize specific engrams (the recipes players unlock as they level up). Hide one, change
        its points cost or required level, remove its prerequisites, or auto-unlock it for free at a
        level. Leave a number blank to keep that engram&apos;s default.
      </p>
      {arr.map((e, i) => (
        <div key={i} className="flex flex-wrap items-center gap-3 rounded-lg border border-ark-border bg-ark-bg p-3">
          <EngramPicker value={e.engram ?? ""} onChange={(c) => patch(i, { engram: c })} />
          <label className="flex items-center gap-1 text-xs text-slate-400">
            <input type="checkbox" checked={!!e.hidden} onChange={(ev) => patch(i, { hidden: ev.target.checked })} />
            hide
            <Hint text="Hide this engram entirely so players can't learn it." />
          </label>
          <div className="flex items-center gap-1">
            <span className="text-xs text-slate-400">points</span>
            <Hint text="Engram points it costs to learn (0–1000). Leave blank to keep the default cost." />
            <input type="number" min={0} max={1000} placeholder="def" className={numBox} value={e.cost ?? ""} onChange={(ev) => patch(i, { cost: numOrUndef(ev.target.value) })} />
          </div>
          <div className="flex items-center gap-1">
            <span className="text-xs text-slate-400">level</span>
            <Hint text="Player level required to learn it (1–999). Leave blank to keep the default." />
            <input type="number" min={1} max={999} placeholder="def" className={numBox} value={e.levelReq ?? ""} onChange={(ev) => patch(i, { levelReq: numOrUndef(ev.target.value) })} />
          </div>
          <label className="flex items-center gap-1 text-xs text-slate-400">
            <input type="checkbox" checked={!!e.removePrereq} onChange={(ev) => patch(i, { removePrereq: ev.target.checked })} />
            skip prereqs
            <Hint text="Removes the engrams normally required before this one, so it can be learned directly." />
          </label>
          <div className="flex items-center gap-1">
            <span className="text-xs text-slate-400">auto-unlock at</span>
            <Hint text="Automatically grant this engram for free when a player reaches this level. Leave blank for no auto-unlock." />
            <input type="number" min={0} max={999} placeholder="lvl" className={numBox} value={e.autoUnlockLevel ?? ""} onChange={(ev) => patch(i, { autoUnlockLevel: numOrUndef(ev.target.value) })} />
          </div>
          <button type="button" className="btn-danger px-2" onClick={() => set(arr.filter((_, j) => j !== i))}>
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      ))}
      <button type="button" className="btn-secondary" onClick={() => set([...arr, { engram: "", hidden: false, removePrereq: false }])}>
        <Plus className="h-4 w-4" /> Add engram
      </button>
    </div>
  );
}

/** Supply crate loot overrides (crate -> item set with quantity/quality/BP). */
function LootCrateField({ def, value, onChange }: WidgetProps) {
  const arr = (Array.isArray(value) ? value : []) as LootCrateEntry[];
  const set = (next: LootCrateEntry[]) => onChange(def.key, next);
  const patch = (i: number, p: Partial<LootCrateEntry>) => set(arr.map((c, j) => (j === i ? { ...c, ...p } : c)));
  return (
    <div className="space-y-3">
      <p className="rounded-md bg-ark-bg/60 px-3 py-2 text-xs leading-relaxed text-slate-400">
        Replaces what a supply crate (beacon) can contain. Pick a crate, choose how many items it
        drops each time it&apos;s opened, then build the pool of items it can pick from. Each item has
        a stack-size range, a quality range, and a chance to drop as a blueprint.
      </p>
      {arr.map((c, i) => (
        <div key={i} className="space-y-3 rounded-lg border border-ark-border bg-ark-bg p-3">
          <div className="flex flex-wrap items-center gap-3">
            <CratePicker value={c.crate ?? ""} onChange={(cls) => patch(i, { crate: cls })} />
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-slate-400">Items per drop</span>
              <Hint text="How many items from the pool below drop each time the crate is opened — a random number between these two values." />
              <RangeNum value={numd(c.minItems, 1)} onChange={(n) => patch(i, { minItems: n })} min={1} max={20} />
              <span className="text-xs text-slate-500">to</span>
              <RangeNum value={numd(c.maxItems, 3)} onChange={(n) => patch(i, { maxItems: n })} min={1} max={20} />
            </div>
            <button type="button" className="btn-danger px-2" onClick={() => set(arr.filter((_, j) => j !== i))}>
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
          <div>
            <div className="mb-1 text-[11px] uppercase tracking-wide text-slate-500">Item pool</div>
            <LootItemsEditor items={c.items ?? []} onChange={(items) => patch(i, { items })} />
          </div>
        </div>
      ))}
      <button type="button" className="btn-secondary" onClick={() => set([...arr, { crate: "", minItems: 1, maxItems: 3, items: [] }])}>
        <Plus className="h-4 w-4" /> Add crate
      </button>
    </div>
  );
}

function LootItemsEditor({ items, onChange }: { items: LootItem[]; onChange: (items: LootItem[]) => void }) {
  const patch = (i: number, p: Partial<LootItem>) => onChange(items.map((it, j) => (j === i ? { ...it, ...p } : it)));
  return (
    <div className="space-y-2 border-l border-ark-border pl-3">
      {items.map((it, i) => (
        <div key={i} className="flex flex-wrap items-center gap-3">
          <ItemPicker value={it.item ?? ""} onChange={(cls) => patch(i, { item: cls })} />
          <div className="flex items-center gap-1">
            <span className="text-xs text-slate-400">stack</span>
            <Hint text="How many of this item come in one drop (a random amount between min and max). e.g. 5–20 wood." />
            <RangeNum value={numd(it.minQty, 1)} onChange={(n) => patch(i, { minQty: n })} min={1} max={1000} />
            <span className="text-xs text-slate-500">–</span>
            <RangeNum value={numd(it.maxQty, 1)} onChange={(n) => patch(i, { maxQty: n })} min={1} max={1000} />
          </div>
          <div className="flex items-center gap-1">
            <span className="text-xs text-slate-400">quality</span>
            <Hint text="Item quality. 1 = normal. Higher = better stats. Only affects gear, weapons, armor and saddles — ignored for resources/consumables." />
            <RangeNum value={numd(it.minQuality, 1)} onChange={(n) => patch(i, { minQuality: n })} min={1} max={50} step={0.5} />
            <span className="text-xs text-slate-500">–</span>
            <RangeNum value={numd(it.maxQuality, 1)} onChange={(n) => patch(i, { maxQuality: n })} min={1} max={50} step={0.5} />
          </div>
          <div className="flex items-center gap-1">
            <span className="text-xs text-slate-400">blueprint</span>
            <Hint text="Chance this drops as a blueprint instead of the finished item. 0 = always the item, 0.5 = half the time, 1 = always a blueprint." />
            <RangeNum value={numd(it.blueprintChance, 0)} onChange={(n) => patch(i, { blueprintChance: n })} min={0} max={1} step={0.05} />
          </div>
          <button type="button" className="btn-danger px-2" onClick={() => onChange(items.filter((_, j) => j !== i))}>
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      ))}
      <button
        type="button"
        className="btn-secondary text-xs"
        onClick={() => onChange([...items, { item: "", minQty: 1, maxQty: 1, minQuality: 1, maxQuality: 1, blueprintChance: 0 }])}
      >
        <Plus className="h-3 w-3" /> Add item
      </button>
    </div>
  );
}

/** Per-item crafting cost (recipe) overrides: pick an item, set its resource cost. */
function CraftCostField({ def, value, onChange }: WidgetProps) {
  const arr = (Array.isArray(value) ? value : []) as CraftCostEntry[];
  const set = (next: CraftCostEntry[]) => onChange(def.key, next);
  const patch = (i: number, p: Partial<CraftCostEntry>) =>
    set(arr.map((c, j) => (j === i ? { ...c, ...p } : c)));
  return (
    <div className="space-y-3">
      <p className="rounded-md bg-ark-bg/60 px-3 py-2 text-xs leading-relaxed text-slate-400">
        Change what it costs to craft an item — its recipe. Pick an item, then list the resources and
        how many of each it takes to make. This fully replaces the item&apos;s normal cost, so include
        every resource it should need (e.g. make a Metal Pick cost 1 Wood + 1 Stone).
      </p>
      {arr.map((c, i) => (
        <div key={i} className="space-y-3 rounded-lg border border-ark-border bg-ark-bg p-3">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-xs text-slate-400">Crafting</span>
            <ItemPicker value={c.item ?? ""} onChange={(cls) => patch(i, { item: cls })} />
            <button type="button" className="btn-danger px-2" onClick={() => set(arr.filter((_, j) => j !== i))}>
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
          <div>
            <div className="mb-1 text-[11px] uppercase tracking-wide text-slate-500">Costs</div>
            <CraftCostResourcesEditor
              resources={c.resources ?? []}
              onChange={(resources) => patch(i, { resources })}
            />
          </div>
        </div>
      ))}
      <button type="button" className="btn-secondary" onClick={() => set([...arr, { item: "", resources: [] }])}>
        <Plus className="h-4 w-4" /> Add item
      </button>
    </div>
  );
}

function CraftCostResourcesEditor({
  resources,
  onChange,
}: {
  resources: CraftCostResource[];
  onChange: (r: CraftCostResource[]) => void;
}) {
  const patch = (i: number, p: Partial<CraftCostResource>) =>
    onChange(resources.map((r, j) => (j === i ? { ...r, ...p } : r)));
  return (
    <div className="space-y-2 border-l border-ark-border pl-3">
      {resources.map((r, i) => (
        <div key={i} className="flex flex-wrap items-center gap-3">
          <ItemPicker value={r.resource ?? ""} onChange={(cls) => patch(i, { resource: cls })} />
          <div className="flex items-center gap-1">
            <span className="text-xs text-slate-400">×</span>
            <Hint text="How many of this resource the recipe needs." />
            <RangeNum value={numd(r.amount, 1)} onChange={(n) => patch(i, { amount: n })} min={0} max={1000} step={1} />
          </div>
          <label className="flex items-center gap-1 text-xs text-slate-400">
            <input type="checkbox" checked={!!r.exact} onChange={(e) => patch(i, { exact: e.target.checked })} />
            exact
            <Hint text="Require this precise resource — no substitutes. Off lets similar resources (e.g. any wood) count toward the cost." />
          </label>
          <button type="button" className="btn-danger px-2" onClick={() => onChange(resources.filter((_, j) => j !== i))}>
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      ))}
      <button
        type="button"
        className="btn-secondary text-xs"
        onClick={() => onChange([...resources, { resource: "", amount: 1, exact: false }])}
      >
        <Plus className="h-3 w-3" /> Add resource
      </button>
    </div>
  );
}

/** Full spawn-pool overrides (container -> weighted creatures + region caps). */
function SpawnContainerField({ def, value, onChange }: WidgetProps) {
  const arr = (Array.isArray(value) ? value : []) as SpawnContainerEntry[];
  const set = (next: SpawnContainerEntry[]) => onChange(def.key, next);
  const patch = (i: number, p: Partial<SpawnContainerEntry>) => set(arr.map((c, j) => (j === i ? { ...c, ...p } : c)));
  return (
    <div className="space-y-3">
      <p className="rounded-md bg-ark-bg/60 px-3 py-2 text-xs leading-relaxed text-slate-400">
        Advanced: completely replace which creatures spawn in a specific region of the map. Most
        servers don&apos;t need this — use <span className="text-slate-300">Creature spawn rates</span>{" "}
        above to just make creatures more/less common. Use this only to rebuild a whole spawn pool.
      </p>
      {arr.map((c, i) => (
        <div key={i} className="space-y-2 rounded-lg border border-ark-border bg-ark-bg p-3">
          <div className="flex flex-wrap items-center gap-1">
            <span className="text-xs text-slate-400">Spawn region</span>
            <Hint text="The spawn-region (container) class to override, e.g. DinoSpawnEntries_TheIsland_C. These come from the map — look them up on the ARK wiki or your mod. Only creatures you list below will spawn here." />
            <input
              className="input min-w-[16rem] flex-1"
              placeholder="e.g. DinoSpawnEntries_TheIsland_C"
              value={c.container ?? ""}
              onChange={(e) => patch(i, { container: e.target.value })}
            />
            <button type="button" className="btn-danger px-2" onClick={() => set(arr.filter((_, j) => j !== i))}>
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
          <div className="flex items-center gap-1 text-[11px] uppercase tracking-wide text-slate-500">
            Creatures that spawn here
            <Hint text="The pool of creatures that can spawn in this region. Weight controls how common each is relative to the others." />
          </div>
          {(c.spawns ?? []).map((s, si) => (
            <div key={si} className="flex flex-wrap items-center gap-2">
              <CreaturePicker
                value={s.creature ?? ""}
                valueKey="className"
                onChange={(cl) => patch(i, { spawns: (c.spawns ?? []).map((x, j) => (j === si ? { ...x, creature: cl } : x)) })}
              />
              <div className="flex items-center gap-1">
                <span className="text-xs text-slate-400">weight ×</span>
                <Hint text="How common this creature is within this region, relative to the others listed." />
                <RangeNum
                  value={numd(s.weight, 1)}
                  onChange={(n) => patch(i, { spawns: (c.spawns ?? []).map((x, j) => (j === si ? { ...x, weight: n } : x)) })}
                  min={0}
                  max={100}
                  step={0.1}
                />
              </div>
              <button type="button" className="btn-danger px-2" onClick={() => patch(i, { spawns: (c.spawns ?? []).filter((_, j) => j !== si) })}>
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
          <button type="button" className="btn-secondary text-xs" onClick={() => patch(i, { spawns: [...(c.spawns ?? []), { creature: "", weight: 1 }] })}>
            <Plus className="h-3 w-3" /> Add creature
          </button>
          <div className="flex items-center gap-1 text-[11px] uppercase tracking-wide text-slate-500">
            Region caps (optional)
            <Hint text="Optionally cap the maximum share a creature can take of this region — e.g. limit Rex to 10% so they don't overrun it." />
          </div>
          {(c.limits ?? []).map((l, li) => (
            <div key={li} className="flex flex-wrap items-center gap-2">
              <CreaturePicker
                value={l.creature ?? ""}
                valueKey="className"
                onChange={(cl) => patch(i, { limits: (c.limits ?? []).map((x, j) => (j === li ? { ...x, creature: cl } : x)) })}
              />
              <div className="flex items-center gap-1">
                <span className="text-xs text-slate-400">max</span>
                <RangeNum
                  value={numd(l.maxPct, 0)}
                  onChange={(n) => patch(i, { limits: (c.limits ?? []).map((x, j) => (j === li ? { ...x, maxPct: n } : x)) })}
                  min={0}
                  max={100}
                />
                <span className="text-xs text-slate-400">%</span>
              </div>
              <button type="button" className="btn-danger px-2" onClick={() => patch(i, { limits: (c.limits ?? []).filter((_, j) => j !== li) })}>
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
          <button type="button" className="btn-secondary text-xs" onClick={() => patch(i, { limits: [...(c.limits ?? []), { creature: "", maxPct: 10 }] })}>
            <Plus className="h-3 w-3" /> Add cap
          </button>
        </div>
      ))}
      <button type="button" className="btn-secondary" onClick={() => set([...arr, { container: "", spawns: [], limits: [] }])}>
        <Plus className="h-4 w-4" /> Add spawn pool
      </button>
    </div>
  );
}

/** Searchable supply-crate combobox: pick a known crate or type a custom class. */
function CratePicker({ value, onChange }: { value: string; onChange: (className: string) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const selected = ARK_CRATES.find((c) => c.className === value);
  const display = selected ? selected.name : value;
  const query = q.trim().toLowerCase();
  const results = (
    query
      ? ARK_CRATES.filter(
          (c) => c.name.toLowerCase().includes(query) || c.className.toLowerCase().includes(query),
        )
      : ARK_CRATES
  ).slice(0, 40);
  return (
    <div className="relative min-w-[14rem] flex-1">
      <input
        className="input"
        placeholder="Search supply crate…"
        value={open ? q : display}
        onFocus={() => {
          setOpen(true);
          setQ("");
        }}
        onChange={(e) => setQ(e.target.value)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {open && (
        <div className="absolute z-40 mt-1 max-h-60 w-full overflow-auto rounded-md border border-ark-border bg-ark-panel shadow-xl">
          {results.map((c) => (
            <button
              type="button"
              key={c.className}
              className="block w-full px-3 py-1.5 text-left hover:bg-ark-border"
              onMouseDown={() => {
                onChange(c.className);
                setOpen(false);
              }}
            >
              <div className="text-sm">{c.name}</div>
              <div className="text-[10px] text-slate-500">{c.className}</div>
            </button>
          ))}
          {query && (
            <button
              type="button"
              className="block w-full border-t border-ark-border px-3 py-1.5 text-left text-sm text-slate-400 hover:bg-ark-border"
              onMouseDown={() => {
                onChange(q.trim());
                setOpen(false);
              }}
            >
              Use custom class “{q.trim()}”
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** A small hover-tooltip "?" icon for explaining an inline field. */
function Hint({ text }: { text: string }) {
  return (
    <span className="group relative inline-flex">
      <Info className="h-3 w-3 cursor-help text-slate-500 hover:text-slate-300" />
      <span className="pointer-events-none absolute left-1/2 top-full z-40 mt-1 hidden w-56 -translate-x-1/2 rounded-md border border-ark-border bg-ark-panel px-3 py-2 text-xs normal-case leading-relaxed tracking-normal text-slate-200 shadow-xl group-hover:block">
        {text}
      </span>
    </span>
  );
}
