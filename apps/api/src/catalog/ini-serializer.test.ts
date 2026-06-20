import { describe, it, expect } from "vitest";
import { Game, type ServerConfigValues } from "@ark/shared";
import { serializeGameUserSettings, serializeGameIni } from "./ini-serializer";
import { ASA_CATALOG } from "./asa.catalog";

describe("ini serializer", () => {
  it("writes ServerSettings with bools as True/False and overrides applied", () => {
    const config: ServerConfigValues = {
      values: { ServerPVE: true, XPMultiplier: 2.5 },
    };
    const ini = serializeGameUserSettings(ASA_CATALOG, config);
    expect(ini).toContain("[ServerSettings]");
    expect(ini).toContain("ServerPVE=True");
    expect(ini).toContain("XPMultiplier=2.5");
  });

  it("never writes a noEmit setting (ServerPassword) into the INI", () => {
    const ini = serializeGameUserSettings(ASA_CATALOG, {
      values: { ServerPassword: "hunter2", ServerPVE: true },
    });
    expect(ini).not.toContain("ServerPassword"); // delivered via the env var instead
    expect(ini).toContain("ServerPVE=True"); // sanity: normal settings still emit
  });

  it("routes breeding settings into Game.ini under the game mode section", () => {
    const config: ServerConfigValues = { values: { MatingIntervalMultiplier: 0.5 } };
    const ini = serializeGameIni(ASA_CATALOG, config);
    expect(ini).toContain("[/script/shootergame.shootergamemode]");
    expect(ini).toContain("MatingIntervalMultiplier=0.5");
  });

  it("serializes a per-level stat grid to indexed array lines (non-default only)", () => {
    const config: ServerConfigValues = {
      values: { PerLevelStatsMultiplier_Player: { Health: 2, Weight: 3 } },
    };
    const ini = serializeGameIni(ASA_CATALOG, config);
    expect(ini).toContain("PerLevelStatsMultiplier_Player[0]=2"); // Health = index 0
    expect(ini).toContain("PerLevelStatsMultiplier_Player[7]=3"); // Weight = index 7
  });

  it("serializes Message of the Day into its own section", () => {
    const config: ServerConfigValues = {
      values: { MessageOfTheDay: { message: "Welcome!", duration: 30 } },
    };
    const ini = serializeGameUserSettings(ASA_CATALOG, config);
    expect(ini).toContain("[MessageOfTheDay]");
    expect(ini).toContain("Message=Welcome!");
    expect(ini).toContain("Duration=30");
  });

  it("serializes item max-stack overrides in ARK tuple format", () => {
    const config: ServerConfigValues = {
      values: {
        ConfigOverrideItemMaxQuantity: [
          { item: "PrimalItemResource_Wood", max: 1000, ignoreMult: true },
        ],
      },
    };
    const ini = serializeGameIni(ASA_CATALOG, config);
    expect(ini).toContain(
      'ConfigOverrideItemMaxQuantity=(ItemClassString="PrimalItemResource_Wood",Quantity=(MaxItemQuantity=1000,bIgnoreMultiplier=true))',
    );
  });

  it("serializes item crafting-cost overrides, adding the _C suffix to classes", () => {
    const config: ServerConfigValues = {
      values: {
        ConfigOverrideItemCraftingCosts: [
          {
            item: "PrimalItem_WeaponStoneHatchet",
            resources: [
              { resource: "PrimalItemResource_Stone", amount: 2, exact: false },
              { resource: "PrimalItemResource_Wood_C", amount: 1, exact: true },
            ],
          },
        ],
      },
    };
    const ini = serializeGameIni(ASA_CATALOG, config);
    expect(ini).toContain(
      'ConfigOverrideItemCraftingCosts=(ItemClassString="PrimalItem_WeaponStoneHatchet_C",BaseCraftingResourceRequirements=(' +
        '(ResourceItemTypeString="PrimalItemResource_Stone_C",BaseResourceRequirement=2,bCraftingRequireExactResourceType=false),' +
        '(ResourceItemTypeString="PrimalItemResource_Wood_C",BaseResourceRequirement=1,bCraftingRequireExactResourceType=true)))',
    );
  });

  it("writes Ragnarok map settings under their own [Ragnarok] section", () => {
    const ini = serializeGameUserSettings(ASA_CATALOG, {
      values: { EnableVolcano: false, VolcanoIntensity: 0.5, UnicornSpawnInterval: 48 },
    });
    expect(ini).toContain("[Ragnarok]");
    expect(ini).toContain("EnableVolcano=False");
    expect(ini).toContain("VolcanoIntensity=0.5");
    expect(ini).toContain("UnicornSpawnInterval=48");
  });

  it("routes newly-added settings to the correct INI file/section", () => {
    const config: ServerConfigValues = {
      values: {
        // GameUserSettings [ServerSettings]
        EnableCryopodNerf: true,
        MaxTributeDinos: 40,
        // Game.ini [shootergamemode]
        BabyFoodConsumptionSpeedMultiplier: 0.5,
        LimitTurretsNum: 200,
        // moved from GUS -> Game.ini (was previously mis-filed + wrong default)
        DinoHarvestingDamageMultiplier: 5,
      },
    };
    const gus = serializeGameUserSettings(ASA_CATALOG, config);
    const game = serializeGameIni(ASA_CATALOG, config);
    expect(gus).toContain("EnableCryopodNerf=True");
    expect(gus).toContain("MaxTributeDinos=40");
    expect(game).toContain("BabyFoodConsumptionSpeedMultiplier=0.5");
    expect(game).toContain("LimitTurretsNum=200");
    // DinoHarvestingDamageMultiplier must now be in Game.ini, not GameUserSettings.
    expect(game).toContain("DinoHarvestingDamageMultiplier=5");
    expect(gus).not.toContain("DinoHarvestingDamageMultiplier");
  });

  it("skips crafting-cost entries with no item or no resources", () => {
    const config: ServerConfigValues = {
      values: {
        ConfigOverrideItemCraftingCosts: [
          { item: "", resources: [{ resource: "PrimalItemResource_Wood", amount: 1, exact: false }] },
          { item: "PrimalItem_WeaponStoneHatchet", resources: [] },
        ],
      },
    };
    const ini = serializeGameIni(ASA_CATALOG, config);
    expect(ini).not.toContain("ConfigOverrideItemCraftingCosts");
  });

  it("serializes per-creature spawn weights with the region cap as a 0-1 fraction", () => {
    const config: ServerConfigValues = {
      values: {
        DinoSpawnWeightMultipliers: [
          { tag: "Bronto", weight: 10, limitOverride: true, limitPercent: 50 },
        ],
      },
    };
    const ini = serializeGameIni(ASA_CATALOG, config);
    expect(ini).toContain(
      "DinoSpawnWeightMultipliers=(DinoNameTag=Bronto,SpawnWeightMultiplier=10,OverrideSpawnLimitPercentage=true,SpawnLimitPercentage=0.5)",
    );
  });

  it("serializes NPC replacements, with empty target disabling a spawn", () => {
    const config: ServerConfigValues = {
      values: {
        NPCReplacements: [
          { from: "Rex_Character_BP_C", to: "Gigant_Character_BP_C" },
          { from: "Spino_Character_BP_C", to: "" },
        ],
      },
    };
    const ini = serializeGameIni(ASA_CATALOG, config);
    expect(ini).toContain(
      'NPCReplacements=(FromClassName="Rex_Character_BP_C",ToClassName="Gigant_Character_BP_C")',
    );
    expect(ini).toContain('NPCReplacements=(FromClassName="Spino_Character_BP_C",ToClassName="")');
  });

  it("serializes the level ramp (player+dino XP lines + engram points)", () => {
    const config: ServerConfigValues = {
      values: {
        LevelRamp: {
          player: { maxLevel: 4, baseXp: 10, growth: 1, engramPerLevel: 5 },
          dino: { maxLevel: 3, baseXp: 10, growth: 1 },
        },
      },
    };
    const ini = serializeGameIni(ASA_CATALOG, config);
    expect(ini).toContain(
      "LevelExperienceRampOverrides=(ExperiencePointsForLevel[0]=10,ExperiencePointsForLevel[1]=20,ExperiencePointsForLevel[2]=30)",
    );
    expect((ini.match(/OverridePlayerLevelEngramPoints=5/g) ?? []).length).toBe(4);
  });

  it("serializes engram overrides + auto-unlock", () => {
    const config: ServerConfigValues = {
      values: {
        Engrams: {
          overrides: [
            { engram: "EngramEntry_Campfire_C", hidden: true, removePrereq: true, cost: 5, levelReq: 2, autoUnlockLevel: 3 },
          ],
          autoUnlockOnly: [],
        },
      },
    };
    const ini = serializeGameIni(ASA_CATALOG, config);
    expect(ini).toContain(
      'OverrideNamedEngramEntries=(EngramClassName="EngramEntry_Campfire_C",EngramHidden=True,EngramPointCost=5,EngramLevelRequirement=2,RemoveEngramPreReq=True)',
    );
    expect(ini).toContain(
      'EngramEntryAutoUnlocks=(EngramClassName="EngramEntry_Campfire_C",LevelToAutoUnlock=3)',
    );
  });

  it("serializes a supply crate override", () => {
    const config: ServerConfigValues = {
      values: {
        SupplyCrateOverrides: [
          {
            crate: "SupplyCrate_Level35_C",
            minItems: 1,
            maxItems: 2,
            items: [
              { item: "PrimalItemResource_Element", minQty: 1, maxQty: 5, minQuality: 1, maxQuality: 1, blueprintChance: 0 },
            ],
          },
        ],
      },
    };
    const ini = serializeGameIni(ASA_CATALOG, config);
    expect(ini).toContain(
      'ConfigOverrideSupplyCrateItems=(SupplyCrateClassString="SupplyCrate_Level35_C",MinItemSets=1,MaxItemSets=1',
    );
    expect(ini).toContain("MinNumItems=1,MaxNumItems=2");
    expect(ini).toContain('ItemClassStrings=("PrimalItemResource_Element")');
    expect(ini).toContain("MinQuantity=1,MaxQuantity=5");
  });

  it("serializes a spawn container override with a region cap", () => {
    const config: ServerConfigValues = {
      values: {
        SpawnContainerOverrides: [
          {
            container: "DinoSpawnEntries_TheIsland_C",
            spawns: [{ creature: "Rex_Character_BP_C", weight: 1 }],
            limits: [{ creature: "Rex_Character_BP_C", maxPct: 10 }],
          },
        ],
      },
    };
    const ini = serializeGameIni(ASA_CATALOG, config);
    expect(ini).toContain(
      'ConfigOverrideNPCSpawnEntriesContainer=(NPCSpawnEntriesContainerClassString="DinoSpawnEntries_TheIsland_C"',
    );
    expect(ini).toContain('NPCsToSpawnStrings=("Rex_Character_BP_C")');
    expect(ini).toContain("MaxPercentageOfDesiredNumToAllow=0.1");
  });

  it("appends raw passthrough so unknown settings still get written", () => {
    const config: ServerConfigValues = {
      values: {},
      rawGameUserSettingsIni: "[CustomSection]\nCustomKey=123",
    };
    const ini = serializeGameUserSettings(ASA_CATALOG, config);
    expect(ini).toContain("raw passthrough");
    expect(ini).toContain("CustomKey=123");
  });
});
