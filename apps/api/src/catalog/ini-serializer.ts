import {
  SettingTarget,
  type SettingDef,
  type ServerConfigValues,
  type SettingsCatalog,
  type MotdValue,
  type ItemMaxEntry,
  type SpawnWeightEntry,
  type NpcReplaceEntry,
  type LevelRampValue,
  type EngramsValue,
  type LootCrateEntry,
  type SpawnContainerEntry,
  type CraftCostEntry,
  computeLevelRamp,
} from "@ark/shared";

/** Item/resource class strings need the UClass "_C" suffix in crafting costs. */
const withC = (cls: string) => (cls.endsWith("_C") ? cls : `${cls}_C`);

const n = (x: unknown, d: number) => (Number.isFinite(Number(x)) ? Number(x) : d);
const frac = (pct: unknown) => Math.max(0, Math.min(100, n(pct, 0))) / 100;

/** Format a scalar value as ARK INI expects (bools as True/False). */
export function formatIniValue(def: SettingDef, value: boolean | number | string): string {
  if (def.type === "bool") return value ? "True" : "False";
  return String(value);
}

interface Sectioned {
  [section: string]: string[]; // section -> "Key=Value" lines
}

/** Produce the INI line(s) for one setting, dispatching on its type. */
function linesFor(def: SettingDef, value: unknown): string[] {
  const base = def.emitAs ?? def.key;
  switch (def.type) {
    case "grid": {
      const v = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
      const out: string[] = [];
      (def.gridRows ?? []).forEach((row, idx) => {
        const n = Number(v[row.key]);
        // Only emit non-default entries to keep the array sparse.
        if (Number.isFinite(n) && n !== 1) out.push(`${base}[${idx}]=${n}`);
      });
      return out;
    }
    case "motd": {
      const v = (value ?? {}) as Partial<MotdValue>;
      if (!v.message) return [];
      return [`Message=${v.message}`, `Duration=${v.duration ?? 20}`];
    }
    case "itemmax": {
      const arr = Array.isArray(value) ? (value as ItemMaxEntry[]) : [];
      return arr
        .filter((e) => e && e.item && Number(e.max) > 0)
        .map(
          (e) =>
            `${base}=(ItemClassString="${e.item}",Quantity=(MaxItemQuantity=${Number(e.max)},bIgnoreMultiplier=${e.ignoreMult ? "true" : "false"}))`,
        );
    }
    case "spawnweight": {
      const arr = Array.isArray(value) ? (value as SpawnWeightEntry[]) : [];
      return arr
        .filter((e) => e && e.tag)
        .map((e) => {
          const limit = Math.max(0, Math.min(100, Number(e.limitPercent) || 0)) / 100;
          return `${base}=(DinoNameTag=${e.tag},SpawnWeightMultiplier=${Number(e.weight) || 1},OverrideSpawnLimitPercentage=${e.limitOverride ? "true" : "false"},SpawnLimitPercentage=${limit})`;
        });
    }
    case "npcreplace": {
      const arr = Array.isArray(value) ? (value as NpcReplaceEntry[]) : [];
      return arr
        .filter((e) => e && e.from)
        .map((e) => `${base}=(FromClassName="${e.from}",ToClassName="${e.to ?? ""}")`);
    }
    case "levelramp": {
      const v = value && typeof value === "object" ? (value as LevelRampValue) : null;
      if (!v?.player) return [];
      const { playerXp, dinoXp, engramPoints } = computeLevelRamp(v);
      const ramp = (xs: number[]) =>
        `LevelExperienceRampOverrides=(${xs.map((x, i) => `ExperiencePointsForLevel[${i}]=${x}`).join(",")})`;
      const out: string[] = [];
      if (playerXp.length) out.push(ramp(playerXp));
      if (dinoXp.length) out.push(ramp(dinoXp));
      for (const p of engramPoints) out.push(`OverridePlayerLevelEngramPoints=${p}`);
      return out;
    }
    case "engrams": {
      const v = value && typeof value === "object" ? (value as EngramsValue) : null;
      if (!v) return [];
      const out: string[] = [];
      for (const o of v.overrides ?? []) {
        if (!o.engram) continue;
        const parts = [`EngramClassName="${o.engram}"`, `EngramHidden=${o.hidden ? "True" : "False"}`];
        if (o.cost !== undefined && o.cost !== null && Number.isFinite(Number(o.cost)))
          parts.push(`EngramPointCost=${Number(o.cost)}`);
        if (o.levelReq !== undefined && o.levelReq !== null && Number.isFinite(Number(o.levelReq)))
          parts.push(`EngramLevelRequirement=${Number(o.levelReq)}`);
        parts.push(`RemoveEngramPreReq=${o.removePrereq ? "True" : "False"}`);
        out.push(`OverrideNamedEngramEntries=(${parts.join(",")})`);
        if (o.autoUnlockLevel !== undefined && o.autoUnlockLevel !== null && Number(o.autoUnlockLevel) >= 0)
          out.push(`EngramEntryAutoUnlocks=(EngramClassName="${o.engram}",LevelToAutoUnlock=${Number(o.autoUnlockLevel)})`);
      }
      for (const a of v.autoUnlockOnly ?? []) {
        if (!a.engram) continue;
        out.push(`EngramEntryAutoUnlocks=(EngramClassName="${a.engram}",LevelToAutoUnlock=${n(a.level, 0)})`);
      }
      return out;
    }
    case "lootcrate": {
      const arr = Array.isArray(value) ? (value as LootCrateEntry[]) : [];
      return arr
        .filter((c) => c.crate)
        .map((c) => {
          const items = (c.items ?? []).filter((it) => it.item);
          const entries = items
            .map(
              (it) =>
                `(EntryWeight=1.0,ItemClassStrings=("${it.item}"),ItemsWeights=(1.0),MinQuantity=${n(it.minQty, 1)},MaxQuantity=${n(it.maxQty, 1)},MinQuality=${n(it.minQuality, 1)},MaxQuality=${n(it.maxQuality, 1)},bForceBlueprint=false,ChanceToBeBlueprintOverride=${n(it.blueprintChance, 0)})`,
            )
            .join(",");
          const itemSet = `(MinNumItems=${n(c.minItems, 1)},MaxNumItems=${n(c.maxItems, items.length || 1)},NumItemsPower=1.0,SetWeight=1.0,ItemEntries=(${entries}))`;
          return `${base}=(SupplyCrateClassString="${c.crate}",MinItemSets=1,MaxItemSets=1,NumItemSetsPower=1.0,bSetsRandomWithoutReplacement=true,ItemSets=(${itemSet}))`;
        });
    }
    case "spawncontainer": {
      const arr = Array.isArray(value) ? (value as SpawnContainerEntry[]) : [];
      return arr
        .filter((c) => c.container)
        .map((c) => {
          const entries = (c.spawns ?? [])
            .filter((s) => s.creature)
            .map(
              (s) =>
                `(AnEntryName="${s.creature}",EntryWeight=${n(s.weight, 1)},NPCsToSpawnStrings=("${s.creature}"))`,
            )
            .join(",");
          const limits = (c.limits ?? [])
            .filter((l) => l.creature)
            .map((l) => `(NPCClassString="${l.creature}",MaxPercentageOfDesiredNumToAllow=${frac(l.maxPct)})`)
            .join(",");
          let line = `${base}=(NPCSpawnEntriesContainerClassString="${c.container}",NPCSpawnEntries=(${entries})`;
          if (limits) line += `,NPCSpawnLimits=(${limits})`;
          return line + ")";
        });
    }
    case "craftcost": {
      const arr = Array.isArray(value) ? (value as CraftCostEntry[]) : [];
      return arr
        .filter((e) => e && e.item && (e.resources ?? []).some((r) => r && r.resource))
        .map((e) => {
          const reqs = (e.resources ?? [])
            .filter((r) => r && r.resource)
            .map(
              (r) =>
                `(ResourceItemTypeString="${withC(r.resource)}",BaseResourceRequirement=${n(r.amount, 1)},bCraftingRequireExactResourceType=${r.exact ? "true" : "false"})`,
            )
            .join(",");
          return `${base}=(ItemClassString="${withC(e.item)}",BaseCraftingResourceRequirements=(${reqs}))`;
        });
    }
    default: {
      const v = (value ?? def.default) as boolean | number | string;
      return [`${base}=${formatIniValue(def, v)}`];
    }
  }
}

function buildSections(
  catalog: SettingsCatalog,
  values: Record<string, unknown>,
  target: SettingTarget,
): Sectioned {
  const out: Sectioned = {};
  for (const def of catalog.settings) {
    if (def.noEmit) continue; // delivered another way (e.g. ServerPassword → env var)
    if (def.target !== target || !def.section) continue;
    const lines = linesFor(def, values[def.key]);
    if (lines.length) (out[def.section] ??= []).push(...lines);
  }
  return out;
}

function renderIni(sections: Sectioned, rawAppend?: string): string {
  const blocks: string[] = [];
  for (const [section, lines] of Object.entries(sections)) {
    blocks.push(`[${section}]\n${lines.join("\n")}`);
  }
  let text = blocks.join("\n\n");
  if (rawAppend && rawAppend.trim()) {
    text += `\n\n; --- raw passthrough ---\n${rawAppend.trim()}\n`;
  }
  return text.endsWith("\n") ? text : text + "\n";
}

/** Serialize the GameUserSettings.ini contents for a server. */
export function serializeGameUserSettings(
  catalog: SettingsCatalog,
  config: ServerConfigValues,
): string {
  const sections = buildSections(catalog, config.values, SettingTarget.GameUserSettings);
  return renderIni(sections, config.rawGameUserSettingsIni);
}

/** Serialize the Game.ini contents for a server. */
export function serializeGameIni(catalog: SettingsCatalog, config: ServerConfigValues): string {
  const sections = buildSections(catalog, config.values, SettingTarget.Game);
  return renderIni(sections, config.rawGameIni);
}
