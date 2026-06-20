import { Game, type SettingsCatalog, type SettingDef } from "@ark/shared";
import { COMMON_SETTINGS, flag, gusBool, gusInt, gusFloat, gusStr, gameBool, gameFloat, dashOption } from "./common-settings";
import { applyHelp } from "./setting-help";

/**
 * ASA settings catalog = shared settings + ASA-specific extras + launch flags.
 * NOT exhaustive (ARK has hundreds of keys); the per-server raw passthrough
 * handles anything not listed, so "every setting" works day one. First-class
 * fields (map, maxPlayers, session name, passwords, RCON, ports, mods, cluster)
 * are handled by the orchestrator, not here.
 */
const asaExtras: SettingDef[] = [
  gusBool("UseAstraeosTraversalBuff", "Astraeos biome teleport", "Astraeos", { def: true, advanced: true, help: "Hold-to-teleport biome travel on Astraeos." }),
  gusStr("ValgueroMemorialEntries", "Memorial names", "Valguero", { advanced: true, help: "Names shown on the Valguero Memorial, semicolon-separated with no spaces (e.g. Name1;Name2;Name3)." }),
  gusBool("AllowCryoFridgeOnSaddle", "Allow cryofridge on saddle", "Cryopods", { advanced: true }),
  gusBool("AllowFlyingStaminaRecovery", "Flyer stamina recovery", "Tamed creatures", { advanced: true }),
  gusBool("AllowMultipleAttachedC4", "Allow multiple attached C4", "PvP", { advanced: true }),
  gameFloat("StructurePickupTimeAfterPlacement", "Structure pickup window (s)", "Pickup & power", { def: 30, max: 600, step: 5, advanced: true }),
  gameFloat("StructurePickupHoldDuration", "Structure pickup hold (s)", "Pickup & power", { def: 0.5, max: 10, step: 0.1, advanced: true }),
  gameBool("bDisableStructurePlacementCollision", "Disable placement collision", "Pickup & power", { advanced: true }),
  gusBool("AllowIntegratedSPlusStructures", "Enable integrated S+ structures", "Pickup & power", { def: true, advanced: true }),

  // ── Lost Colony DLC (only shown on LostColony_WP servers) ────────────────────
  // Outposts (dynamic missions)
  gusInt("MaxActiveOutposts", "Max active outposts", "Outposts", { advanced: true, max: 1000, help: "Cap on simultaneously active outpost missions." }),
  gusInt("MaxActiveResourceCaches", "Max active resource caches", "Outposts", { advanced: true, max: 1000, help: "Cap on active resource-cache outpost missions." }),
  gusInt("MaxActiveCityOutposts", "Max active city outposts", "Outposts", { advanced: true, max: 1000, help: "Cap on active city outpost missions." }),
  gusFloat("OutpostSigilRewardMultiplier", "Outpost sigil reward", "Outposts", { advanced: true, max: 100, help: "Scales the sigil rewards from outpost missions." }),
  // Tek Bunker
  gusBool("LimitBunkersPerTribe", "Limit Tek Bunkers per tribe", "Tek Bunker", { def: true, advanced: true, help: "Cap how many Tek Bunkers a tribe can place." }),
  gusInt("LimitBunkersPerTribeNum", "Tek Bunkers per tribe", "Tek Bunker", { def: 3, advanced: true, max: 100, help: "Max Tek Bunkers per tribe when the limit is on." }),
  gusFloat("MinDistanceBetweenBunkers", "Min distance between bunkers", "Tek Bunker", { def: 3000, advanced: true, max: 100000, step: 100, help: "Minimum spacing (Unreal units) between Tek Bunkers." }),
  gusBool("AllowBunkersInPreventionZones", "Bunkers in no-build zones", "Tek Bunker", { advanced: true, help: "Allow Tek Bunkers inside build-prevention zones." }),
  gusBool("AllowBunkerModulesAboveGround", "Bunker modules above ground", "Tek Bunker", { advanced: true }),
  gusBool("AllowBunkerModulesInPreventionZones", "Bunker modules in no-build zones", "Tek Bunker", { advanced: true }),
  gusBool("AllowRidingDinosInsideBunkers", "Ride creatures inside bunkers", "Tek Bunker", { def: true, advanced: true }),
  gusBool("AllowDinoAIInsideBunkers", "Creature AI inside bunkers", "Tek Bunker", { def: true, advanced: true }),
  gusFloat("EnemyAccessBunkerHPThreshold", "Enemy access HP threshold", "Tek Bunker", { def: 0.25, advanced: true, max: 1, step: 0.05, help: "Bunker HP fraction below which enemies can get in." }),
  gusFloat("BunkerUnderHPThresholdDmgMultiplier", "Below-threshold damage ×", "Tek Bunker", { def: 0.05, advanced: true, max: 10, step: 0.05, help: "Damage multiplier once a bunker drops below the HP threshold." }),
  // Cryo Hospital
  gusFloat("CryoHospitalHoursToRegenHP", "Hours to regen HP", "Cryo Hospital", { def: 1, advanced: true, max: 100, help: "Hours for a stored creature to regenerate health." }),
  gusFloat("CryoHospitalHoursToRegenFood", "Hours to regen food", "Cryo Hospital", { def: 24, advanced: true, max: 100 }),
  gusFloat("CryoHospitalHoursToDrainTorpor", "Hours to drain torpor", "Cryo Hospital", { def: 1, advanced: true, max: 100 }),
  gusFloat("CryoHospitalMatingCooldownReduction", "Mating cooldown reduction ×", "Cryo Hospital", { def: 2, advanced: true, max: 100 }),
  // Bloodforge
  gusFloat("BloodforgeReinforceExtraDurability", "Reinforce extra durability", "Bloodforge", { def: 0.3, advanced: true, max: 10, step: 0.05 }),
  gusFloat("BloodforgeReinforceResourceCostMultiplier", "Reinforce resource cost", "Bloodforge", { def: 3, advanced: true, max: 100 }),
  gusFloat("BloodforgeReinforceSpeedMultiplier", "Reinforce speed", "Bloodforge", { def: 0.1, advanced: true, max: 10, step: 0.05 }),

  dashOption("ServerPlatform", "Crossplay platforms", {
    type: "multiselect",
    joinWith: "+",
    choices: [
      { value: "PC", label: "PC (Steam)" },
      { value: "XSX", label: "Xbox" },
      { value: "PS5", label: "PlayStation" },
      { value: "WINGDK", label: "Windows Store / Game Pass" },
    ],
    advanced: true,
    help: "Tick which platforms can join. The server builds -ServerPlatform=... for you. Leave all unticked for the default.",
  }),
];

const flags: SettingDef[] = [
  flag("DisableBattlEye", "Disable BattlEye anti-cheat", "NoBattlEye", {
    help: "Adds -NoBattlEye. Disables anti-cheat.",
  }),
  flag("ForceRespawnDinos", "Force respawn dinos on boot", "ForceRespawnDinos", { advanced: true }),
  flag("ForceAllowCaveFlyers", "Allow flyers in caves", "ForceAllowCaveFlyers", { advanced: true, category: "Tamed creatures" }),
];

export const ASA_CATALOG: SettingsCatalog = {
  game: Game.ASA,
  version: "2026.06",
  settings: applyHelp([...COMMON_SETTINGS, ...asaExtras, ...flags]),
};
