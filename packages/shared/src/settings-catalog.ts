import type { Game } from "./game";

/** Where a setting is serialized to when the server launches. */
export enum SettingTarget {
  /** [SectionName] in GameUserSettings.ini */
  GameUserSettings = "GameUserSettings",
  /** [SectionName] in Game.ini */
  Game = "Game",
  /** ?Key=Value appended to the map URL on the command line */
  CommandLineOption = "CommandLineOption",
  /** -Flag style command-line switch (boolean) */
  CommandLineFlag = "CommandLineFlag",
  /** -Key=Value style command-line option (e.g. -ActiveEvent=Easter) */
  CommandLineDashOption = "CommandLineDashOption",
  /** Passed to the container as an env var (e.g. Conan, whose image writes the
   *  INIs itself from env). `emitAs` is the env var name. */
  Env = "Env",
}

export type SettingValueType =
  | "bool"
  | "int"
  | "float"
  | "string"
  | "enum"
  | "multiselect" // value: string[] of selected choice values
  // structured widgets (Tier B):
  | "grid" // per-stat multiplier grid (value: Record<statKey, number>)
  | "motd" // message of the day (value: { message, duration })
  | "itemmax" // item max-stack overrides (value: ItemMaxEntry[])
  | "spawnweight" // per-creature spawn weights (value: SpawnWeightEntry[])
  | "npcreplace" // creature spawn replacements (value: NpcReplaceEntry[])
  // Tier C:
  | "levelramp" // XP curve + engram points (value: LevelRampValue)
  | "engrams" // per-engram overrides + auto-unlock (value: EngramsValue)
  | "lootcrate" // supply crate item overrides (value: LootCrateEntry[])
  | "spawncontainer" // full spawn-container overrides (value: SpawnContainerEntry[])
  | "craftcost"; // per-item crafting cost / recipe overrides (value: CraftCostEntry[])

export interface MotdValue {
  message: string;
  duration: number;
}
export interface ItemMaxEntry {
  item: string;
  max: number;
  ignoreMult: boolean;
}
export interface SpawnWeightEntry {
  tag: string; // DinoNameTag, e.g. "Bronto"
  weight: number; // SpawnWeightMultiplier (1 = default)
  limitOverride: boolean; // OverrideSpawnLimitPercentage
  limitPercent: number; // 0-100; serialized as a 0-1 fraction
}
export interface NpcReplaceEntry {
  from: string; // FromClassName (e.g. "Rex_Character_BP_C")
  to: string; // ToClassName; empty disables the spawn
}

// ── Tier C value shapes ──────────────────────────────────────────────────────
export interface RampParams {
  maxLevel: number; // 0 = off (no override)
  baseXp: number; // XP increment for the first level
  growth: number; // per-level growth factor (e.g. 1.05)
}
export interface LevelRampValue {
  player: RampParams & { engramPerLevel: number };
  dino: RampParams;
}

export interface EngramOverride {
  engram: string; // EngramClassName (e.g. "EngramEntry_Campfire_C")
  hidden: boolean;
  removePrereq: boolean;
  cost?: number; // EngramPointCost (blank = leave default)
  levelReq?: number; // EngramLevelRequirement (blank = leave default)
  autoUnlockLevel?: number; // if set, also emit an EngramEntryAutoUnlocks line
}
export interface EngramsValue {
  overrides: EngramOverride[];
  autoUnlockOnly: { engram: string; level: number }[]; // auto-unlock without an override
}

export interface LootItem {
  item: string; // ItemClassString
  minQty: number;
  maxQty: number;
  minQuality: number;
  maxQuality: number;
  blueprintChance: number; // 0-1
}
export interface LootCrateEntry {
  crate: string; // SupplyCrateClassString
  minItems: number; // how many items drop per opening (ItemSet MinNumItems)
  maxItems: number; // ItemSet MaxNumItems
  items: LootItem[]; // the pool the crate draws from
}

export interface SpawnContainerSpawn {
  creature: string; // NPC class string
  weight: number;
}
export interface SpawnContainerEntry {
  container: string; // NPCSpawnEntriesContainerClassString
  spawns: SpawnContainerSpawn[];
  limits: { creature: string; maxPct: number }[]; // maxPct 0-100
}

export interface CraftCostResource {
  resource: string; // resource item class (e.g. "PrimalItemResource_Wood"); "_C" added on serialize
  amount: number; // BaseResourceRequirement — how many of this resource the recipe needs
  exact: boolean; // bCraftingRequireExactResourceType — require this exact resource (no substitutes)
}
export interface CraftCostEntry {
  item: string; // the crafted item's class (e.g. "PrimalItem_WeaponStoneHatchet"); "_C" added on serialize
  resources: CraftCostResource[]; // the full recipe — replaces the item's default cost
}

/** Compute the XP ramp + engram-point arrays from generator params (shared so
 *  the backend serializer and the UI preview stay in lock-step). */
export function computeLevelRamp(v: LevelRampValue): {
  playerXp: number[];
  dinoXp: number[];
  engramPoints: number[];
} {
  const ramp = (p: RampParams): number[] => {
    const n = Math.max(0, Math.floor(p.maxLevel) - 1);
    const out: number[] = [];
    let total = 0;
    for (let i = 0; i < n; i++) {
      total += Math.round((p.baseXp || 1) * Math.pow(p.growth || 1, i));
      out.push(total);
    }
    return out;
  };
  const engramPoints =
    v.player.maxLevel > 0
      ? Array.from({ length: Math.floor(v.player.maxLevel) }, () =>
          Math.max(0, Math.floor(v.player.engramPerLevel) || 0),
        )
      : [];
  return { playerXp: ramp(v.player), dinoXp: ramp(v.dino), engramPoints };
}

/**
 * One entry in the settings catalog. The whole catalog is DATA — the UI renders
 * from it and the serializer writes it out, so adding a setting is a data change,
 * never a code change (PLANNING.md → Config management).
 */
export interface SettingDef {
  key: string; // unique catalog key, e.g. "XPMultiplier"
  label: string;
  category: string; // grouping in the UI, e.g. "Rates", "Rules", "Structures"
  target: SettingTarget;
  /** INI section (for GameUserSettings/Game targets), e.g. "ServerSettings". */
  section?: string;
  /** The actual key written to the ini/command line if it differs from `key`. */
  emitAs?: string;
  type: SettingValueType;
  default: boolean | number | string | object;
  /** Rows for a "grid" setting, in INI array-index order. */
  gridRows?: { key: string; label: string }[];
  min?: number;
  max?: number;
  step?: number;
  /** Multiply the stored value by this for display (and divide back on input),
   *  so the UI can show a derived figure — e.g. OverrideOfficialDifficulty is
   *  stored 1–20 but shown ×30 as the max wild creature level (30–600). */
  displayScale?: number;
  /** Short unit suffix shown after a numeric input (e.g. "level"). */
  unit?: string;
  /** Directional endpoint labels shown under a slider (e.g. "less" / "more"). */
  minLabel?: string;
  maxLabel?: string;
  options?: string[]; // for type "enum" (value === label)
  /** Labeled choices for "enum"/"multiselect" (friendly label, real value). */
  choices?: { value: string; label: string }[];
  /** For multiselect dash options: how selected values are joined (e.g. "+"). */
  joinWith?: string;
  help?: string;
  /** Which games this setting applies to (omit = all). */
  games?: Game[];
  /** Advanced settings are collapsed by default in the UI. */
  advanced?: boolean;
  /** UI/config-only: never written to any INI or command line. Used for values
   *  the manager delivers another way (e.g. ServerPassword → SERVER_PASSWORD env). */
  noEmit?: boolean;
}

export interface SettingsCatalog {
  game: Game;
  version: string;
  settings: SettingDef[];
}

/** A resolved set of values for one server: catalog values + raw passthrough. */
export interface ServerConfigValues {
  /** catalog key -> value (scalars or structured objects/arrays for Tier-B types) */
  values: Record<string, unknown>;
  /** Raw escape hatches appended verbatim so "every setting" works day one. */
  rawGameUserSettingsIni?: string;
  rawGameIni?: string;
  rawCommandLineArgs?: string;
}
