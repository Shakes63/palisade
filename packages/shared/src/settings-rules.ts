import { Game } from "./game";

// ── Presets ──────────────────────────────────────────────────────────────────
/** A named bundle of setting values the user can apply with one click. */
export interface SettingsPreset {
  id: string;
  label: string;
  description: string;
  /** catalog key -> value to apply (merged over the current values). */
  values: Record<string, unknown>;
  /** Limit to specific games (omit = all). */
  games?: Game[];
}

// All ARK presets use ARK setting keys; they're scoped to ARK below so they don't
// appear (and silently do nothing) on a Conan server.
const ARK_PRESETS: SettingsPreset[] = [
  // Faithful to ASA single player — verified against the ARK wiki's single-player
  // multiplier table and Dododex. "Use Single Player Settings" applies a FIXED rate
  // rebalance (taming ×2.5, XP ×2, egg hatch ×9–10, maturation ×35, mating ×0.15,
  // cuddle ×0.17, crops ×4, boosted tamed-dino stat gains, unlimited respecs) that
  // is IDENTICAL on Easy/Medium/Hard. Harvest is NOT boosted (stays 1×) — that's
  // why solo gathering is grindy on every difficulty. The difficulty choice changes
  // ONLY wild-creature level + loot quality. So all three share the flag + 1×
  // sliders (a clean baseline for the flag's scaling, since it multiplies the
  // slider) and differ only in level. Vanilla single player runs ≈lvl 30 (easiest)
  // → 150 (hardest); we use OverrideOfficialDifficulty (×30 = max level) so the
  // level is consistent across maps instead of map-dependent like the raw offset.
  {
    id: "sp-easy",
    label: "Single player — Easy (lvl 30)",
    description:
      "Faithful ASA single-player Easy. Turns on Use Single Player Settings — the game itself then applies the official solo rates (taming ×2.5, XP ×2, hatch ×10, maturation ×35, crops ×4, unlimited respecs), identical on every difficulty — and sets the easiest difficulty, so wild creatures top out around level 30 with basic loot. Gathering stays at vanilla 1× (single player never boosts harvest).",
    values: {
      bUseSingleplayerSettings: true,
      XPMultiplier: 1,
      TamingSpeedMultiplier: 1,
      HarvestAmountMultiplier: 1,
      MatingIntervalMultiplier: 1,
      EggHatchSpeedMultiplier: 1,
      BabyMatureSpeedMultiplier: 1,
      BabyCuddleIntervalMultiplier: 1,
      CropGrowthSpeedMultiplier: 1,
      DifficultyOffset: 1,
      OverrideOfficialDifficulty: 1,
    },
  },
  {
    id: "sp-medium",
    label: "Single player — Medium (lvl 90)",
    description:
      "Identical official single-player rates to Easy (Use Single Player Settings on, sliders at 1×), at the middle difficulty: wild creatures up to about level 90 and better loot. Gathering is still vanilla 1×.",
    values: {
      bUseSingleplayerSettings: true,
      XPMultiplier: 1,
      TamingSpeedMultiplier: 1,
      HarvestAmountMultiplier: 1,
      MatingIntervalMultiplier: 1,
      EggHatchSpeedMultiplier: 1,
      BabyMatureSpeedMultiplier: 1,
      BabyCuddleIntervalMultiplier: 1,
      CropGrowthSpeedMultiplier: 1,
      DifficultyOffset: 1,
      OverrideOfficialDifficulty: 3,
    },
  },
  {
    id: "sp-hard",
    label: "Single player — Hard (lvl 150)",
    description:
      "Identical official single-player rates to Easy (Use Single Player Settings on, sliders at 1×), at the hardest vanilla difficulty: wild creatures up to level 150 and the best loot quality. Note the grind is by design — single player never boosts harvest, so gathering stays 1×; apply the 'Bigger item stacks' preset or raise Harvest amount if you want relief without changing the challenge.",
    values: {
      bUseSingleplayerSettings: true,
      XPMultiplier: 1,
      TamingSpeedMultiplier: 1,
      HarvestAmountMultiplier: 1,
      MatingIntervalMultiplier: 1,
      EggHatchSpeedMultiplier: 1,
      BabyMatureSpeedMultiplier: 1,
      BabyCuddleIntervalMultiplier: 1,
      CropGrowthSpeedMultiplier: 1,
      DifficultyOffset: 1,
      OverrideOfficialDifficulty: 5,
    },
  },
  {
    id: "fast-breeding",
    label: "Fast breeding (full imprint)",
    description:
      "Quick mating, hatching and maturation, with the cuddle interval scaled down so you can still reach 100% imprint — speed without losing imprint quality. Tune the speeds higher once you're comfortable keeping up with cuddles.",
    values: {
      MatingIntervalMultiplier: 0.1,
      EggHatchSpeedMultiplier: 10,
      BabyMatureSpeedMultiplier: 10,
      BabyCuddleIntervalMultiplier: 0.2,
      BabyImprintAmountMultiplier: 1,
      BabyFoodConsumptionSpeedMultiplier: 1,
    },
  },
  {
    id: "boosted-pvp",
    label: "Boosted PvP server",
    description:
      "A typical community PvP feel: PvP on, faster taming/harvest/XP and breeding, and 2× stacks so raiding and resupply stay quick without trivializing progression.",
    values: {
      ServerPVE: false,
      XPMultiplier: 2,
      TamingSpeedMultiplier: 5,
      HarvestAmountMultiplier: 3,
      ResourcesRespawnPeriodMultiplier: 0.5,
      ItemStackSizeMultiplier: 2,
      MatingIntervalMultiplier: 0.3,
      EggHatchSpeedMultiplier: 8,
      BabyMatureSpeedMultiplier: 8,
      BabyCuddleIntervalMultiplier: 0.25,
    },
  },
  {
    id: "boosted-10x",
    label: "10× Boosted (all rates)",
    description:
      "Grind-free private-server rates: 10× taming and harvesting, 5× XP, big stacks, fast resource respawn, and very fast breeding. Great for small groups who want to build and fight, not farm.",
    values: {
      XPMultiplier: 5,
      TamingSpeedMultiplier: 10,
      HarvestAmountMultiplier: 10,
      ResourcesRespawnPeriodMultiplier: 0.4,
      ItemStackSizeMultiplier: 5,
      CropGrowthSpeedMultiplier: 3,
      MatingIntervalMultiplier: 0.1,
      EggHatchSpeedMultiplier: 20,
      BabyMatureSpeedMultiplier: 20,
      BabyCuddleIntervalMultiplier: 0.15,
    },
  },
  {
    id: "relaxed-pve",
    label: "Relaxed PvE (building)",
    description:
      "A chill PvE base-builder: PvE on, boosted gathering, cave building allowed, and structures/tames that don't decay while you're away — so creative builds stick around.",
    values: {
      ServerPVE: true,
      XPMultiplier: 2,
      TamingSpeedMultiplier: 5,
      HarvestAmountMultiplier: 3,
      ResourcesRespawnPeriodMultiplier: 0.5,
      AllowCaveBuildingPvE: true,
      DisableDinoDecayPvE: true,
      PvEStructureDecayPeriodMultiplier: 10,
      MatingIntervalMultiplier: 0.5,
      EggHatchSpeedMultiplier: 5,
      BabyMatureSpeedMultiplier: 5,
    },
  },
  {
    id: "hardcore",
    label: "Hardcore survival",
    description:
      "Tougher than official: slower XP and taming, leaner harvests, faster hunger/thirst/stamina drain, weaker healing, quicker spoilage and slower resource respawn. For players who want the grind to bite.",
    values: {
      XPMultiplier: 0.5,
      TamingSpeedMultiplier: 0.5,
      HarvestAmountMultiplier: 0.7,
      ResourcesRespawnPeriodMultiplier: 1.5,
      GlobalSpoilingTimeMultiplier: 0.7,
      PlayerCharacterFoodDrainMultiplier: 1.5,
      PlayerCharacterWaterDrainMultiplier: 1.5,
      PlayerCharacterStaminaDrainMultiplier: 1.5,
      PlayerCharacterHealthRecoveryMultiplier: 0.6,
      DinoCharacterFoodDrainMultiplier: 1.3,
      MatingIntervalMultiplier: 1.5,
      BabyMatureSpeedMultiplier: 0.8,
    },
  },
  {
    id: "auto-unlock-engrams",
    label: "Auto-unlock engrams by level",
    description:
      "Every engram unlocks automatically and for free the moment you reach the level it normally requires — hit level 15 and all level-15 engrams are yours, no engram points spent. (Overrides any per-engram customizations.)",
    values: {
      bAutoUnlockAllEngrams: true,
    },
  },
  {
    id: "no-ichthyornis",
    label: "Replace Ichthyornis with Dodo",
    description:
      "Swaps the item-stealing Ichthyornis (the seagull that swoops in and spoils your gear) for harmless Dodos everywhere it spawns. (Replaces the creature-replacement list — re-add any other swaps afterward.)",
    values: {
      NPCReplacements: [{ from: "Ichthyornis_Character_BP_C", to: "Dodo_Character_BP_C" }],
    },
  },
  {
    id: "bigger-stacks",
    label: "Bigger item stacks (10×)",
    description:
      "Multiplies every item's stack size by 10 — wood to 1000, metal to 3000, and far fewer trips hauling loot. Tune the multiplier under Items & Loot if 10× is too much or too little.",
    values: {
      ItemStackSizeMultiplier: 10,
    },
  },
];

// Conan Exiles presets — use Conan catalog keys (first-class env vars + raw
// ServerSettings keys). Scoped to Conan so they only show on Conan servers.
const CONAN_PRESETS: SettingsPreset[] = [
  {
    id: "conan-relaxed",
    label: "Relaxed / casual",
    description:
      "A lighter grind for casual or small-group play: double harvest and XP, half crafting cost, faster thrall conversion, slower spoilage, and longer-lasting fuel.",
    games: [Game.CONAN],
    values: {
      HARVEST_AMOUNT_MULTIPLIER: 2,
      XP_RATE_MULTIPLIER: 2,
      CRAFTING_COST_MULTIPLIER: 0.5,
      THRALL_CONVERSION_MULTIPLIER: 2,
      ITEM_SPOIL_RATE_SCALE: 0.5,
      FUEL_BURN_TIME_MULTIPLIER: 2,
    },
  },
  {
    id: "conan-hardcore",
    label: "Hardcore survival",
    description:
      "Tougher than vanilla: half harvest and XP, slower thrall conversion, faster spoilage, and a steeper stamina cost. For players who want the grind to bite.",
    games: [Game.CONAN],
    values: {
      HARVEST_AMOUNT_MULTIPLIER: 0.5,
      XP_RATE_MULTIPLIER: 0.5,
      THRALL_CONVERSION_MULTIPLIER: 0.5,
      ITEM_SPOIL_RATE_SCALE: 2,
      PLAYER_STAMINA_COST_MULTIPLIER: 1.5,
    },
  },
  {
    id: "conan-pve-building",
    label: "PvE building (no decay)",
    description:
      "A chill PvE base-builder: PvP off, buildings never decay while you're away, plus boosted harvest and XP so creative builds come together fast.",
    games: [Game.CONAN],
    values: {
      PVP_ENABLED: false,
      BUILDING_ABANDONMENT_ENABLED: false,
      HARVEST_AMOUNT_MULTIPLIER: 2,
      XP_RATE_MULTIPLIER: 2,
    },
  },
  {
    id: "conan-fast-thralls",
    label: "Fast thralls & taming",
    description:
      "Capture and tame quickly: very fast Wheel-of-Pain conversion and quicker animal-pen raising, so you spend less time waiting and more time playing.",
    games: [Game.CONAN],
    values: {
      THRALL_CONVERSION_MULTIPLIER: 5,
      AnimalPenCraftingTimeMultiplier: 0.25,
    },
  },
];

/** Built-in presets. ARK presets default to ARK games (so they're hidden on Conan);
 *  Conan presets are scoped to Conan. */
export const SETTINGS_PRESETS: SettingsPreset[] = [
  ...ARK_PRESETS.map((p) => ({ ...p, games: p.games ?? [Game.ASA, Game.ASE] })),
  ...CONAN_PRESETS,
];

// ── Dependencies (enable/disable based on other settings) ────────────────────
export interface SettingCondition {
  key: string;
  /** value === equals */
  equals?: boolean | number | string;
  /** value is truthy (e.g. a master toggle is on) */
  truthy?: boolean;
  /** value is falsy (e.g. a master toggle is off) */
  falsy?: boolean;
}
/** A setting is only active (editable) when ALL of these conditions hold. */
export interface SettingDependency {
  all: SettingCondition[];
  reason: string;
}

const pvpOnly = (extra: SettingCondition[] = []): SettingDependency => ({
  all: [{ key: "ServerPVE", equals: false }, ...extra],
  reason: "Only applies in PvP mode (PvE mode is on).",
});
const pveOnly = (extra: SettingCondition[] = []): SettingDependency => ({
  all: [{ key: "ServerPVE", equals: true }, ...extra],
  reason: "Only applies in PvE mode.",
});
const requires = (key: string, label: string): SettingDependency => ({
  all: [{ key, truthy: true }],
  reason: `Requires "${label}" to be enabled.`,
});
const offWhen = (key: string, reason: string): SettingDependency => ({
  all: [{ key, falsy: true }],
  reason,
});

// Breeding settings have no effect when breeding is disabled.
const BREEDING_KEYS = [
  "BabyMatureSpeedMultiplier",
  "EggHatchSpeedMultiplier",
  "MatingIntervalMultiplier",
  "MatingSpeedMultiplier",
  "LayEggIntervalMultiplier",
  "BabyCuddleIntervalMultiplier",
  "BabyCuddleGracePeriodMultiplier",
  "BabyCuddleLoseImprintQualitySpeedMultiplier",
  "BabyFoodConsumptionSpeedMultiplier",
  "BabyImprintAmountMultiplier",
  "BabyImprintingStatScaleMultiplier",
  "PreventMateBoost",
  "AllowAnyoneBabyImprintCuddle",
  "DisableImprintDinoBuff",
];

export const SETTING_DEPENDENCIES: Record<string, SettingDependency> = {
  // PvP-only
  EnablePVPGamma: pvpOnly(),
  AllowCaveBuildingPvP: pvpOnly(),
  PvPZoneStructureDamageMultiplier: pvpOnly(),
  AllowMultipleAttachedC4: pvpOnly(),
  bIncreasePvPRespawnInterval: pvpOnly(),
  IncreasePvPRespawnIntervalBaseAmount: pvpOnly([{ key: "bIncreasePvPRespawnInterval", truthy: true }]),
  IncreasePvPRespawnIntervalCheckPeriod: pvpOnly([{ key: "bIncreasePvPRespawnInterval", truthy: true }]),
  IncreasePvPRespawnIntervalMultiplier: pvpOnly([{ key: "bIncreasePvPRespawnInterval", truthy: true }]),
  PvPDinoDecay: pvpOnly(),
  PvPStructureDecay: pvpOnly(),

  // PvE-only
  DisablePvEGamma: pveOnly(),
  AllowCaveBuildingPvE: pveOnly(),
  PvEAllowStructuresAtSupplyDrops: pveOnly(),
  bPvEAllowTribeWar: pveOnly(),
  bPvEAllowTribeWarCancel: pveOnly([{ key: "bPvEAllowTribeWar", truthy: true }]),
  bPvEDisableFriendlyFire: pveOnly(),
  DisableDinoDecayPvE: pveOnly(),
  PvEDinoDecayPeriodMultiplier: pveOnly([{ key: "DisableDinoDecayPvE", falsy: true }]),

  // Timed PvP→PvE chain
  AutoPvEStartTimeSeconds: requires("bAutoPvETimer", "Timed PvE/PvP (auto PvE timer)"),
  AutoPvEStopTimeSeconds: requires("bAutoPvETimer", "Timed PvE/PvP (auto PvE timer)"),
  bAutoPvEUseSystemTime: requires("bAutoPvETimer", "Timed PvE/PvP (auto PvE timer)"),

  // Offline raid protection chain
  PreventOfflinePvPInterval: requires("PreventOfflinePvP", "Offline raid protection"),
  PreventOfflinePvPConnectionInvincibleInterval: requires("PreventOfflinePvP", "Offline raid protection"),

  // Cryopod nerf chain
  CryopodNerfDamageMult: requires("EnableCryopodNerf", "Enable cryopod nerf"),
  CryopodNerfDuration: requires("EnableCryopodNerf", "Enable cryopod nerf"),
  CryopodNerfIncomingDamageMultPercent: requires("EnableCryopodNerf", "Enable cryopod nerf"),

  // Turret limit chain
  LimitTurretsNum: requires("bLimitTurretsInRange", "Limit turrets in range"),
  LimitTurretsRange: requires("bLimitTurretsInRange", "Limit turrets in range"),

  // Fast-decay interval needs fast-decay enabled
  FastDecayInterval: requires("FastDecayUnsnappedCoreStructures", "Fast-decay unsnapped foundations/pillars"),

  // Hexagon store
  HexagonCostMultiplier: offWhen("bDisableHexagonStore", "The Hexagon store is disabled."),
  BaseHexagonRewardMultiplier: offWhen("bDisableHexagonStore", "The Hexagon store is disabled."),
  MaxHexagonsPerCharacter: offWhen("bDisableHexagonStore", "The Hexagon store is disabled."),

  // Lost Colony bunkers
  LimitBunkersPerTribeNum: requires("LimitBunkersPerTribe", "Limit Tek Bunkers per tribe"),

  // Taming disabled
  TamingSpeedMultiplier: offWhen("bDisableDinoTaming", "Taming is disabled."),
  PassiveTameIntervalMultiplier: offWhen("bDisableDinoTaming", "Taming is disabled."),

  // Breeding disabled → grey out all breeding settings
  ...Object.fromEntries(BREEDING_KEYS.map((k) => [k, offWhen("bDisableDinoBreeding", "Breeding is disabled.")])),
};

/** Whether a setting is active given the current (effective) values. */
export function settingActive(
  key: string,
  get: (k: string) => unknown,
): { active: boolean; reason?: string } {
  const dep = SETTING_DEPENDENCIES[key];
  if (!dep) return { active: true };
  const ok = dep.all.every((c) => {
    const v = get(c.key);
    if (c.equals !== undefined) return v === c.equals;
    if (c.truthy) return Boolean(v);
    if (c.falsy) return !v;
    return true;
  });
  return ok ? { active: true } : { active: false, reason: dep.reason };
}
