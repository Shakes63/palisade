import { Game, type SettingsCatalog, type SettingDef } from "@ark/shared";
import { COMMON_SETTINGS, flag } from "./common-settings";
import { applyHelp } from "./setting-help";

/**
 * ASE settings catalog = shared settings + ASE-specific extras + launch flags.
 * ASE writes config under the LinuxServer platform dir and uses Steam Workshop
 * mods; raw passthrough covers anything not listed.
 */
// ASE-specific extras (most rules now live in the shared common list).
const aseExtras: SettingDef[] = [];

const flags: SettingDef[] = [
  flag("DisableBattlEye", "Disable BattlEye anti-cheat", "NoBattlEye"),
  flag("ForceAllowCaveFlyers", "Allow flyers in caves", "ForceAllowCaveFlyers", { advanced: true, category: "Tamed creatures" }),
];

export const ASE_CATALOG: SettingsCatalog = {
  game: Game.ASE,
  version: "2026.06",
  settings: applyHelp([...COMMON_SETTINGS, ...aseExtras, ...flags]),
};
