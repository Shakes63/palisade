import { Game, SettingTarget, type SettingsCatalog, type SettingDef } from "@ark/shared";

/**
 * Life is Feudal: Your Own catalog. The server has no env-var interface — all
 * settings live in `config/world_1.xml` inside the serverfiles bind. The file
 * ships with the game install (SteamCMD writes it on FIRST install), so the
 * manager PATCHES it in place before every start once it exists
 * (patchLifWorldXml); on the very first boot the image's own defaults apply and
 * a restart picks ours up.
 *
 * Keys here are the XML tag names, patched 1:1 — except the three LIF_SKILLCAP_*
 * keys, which land in the nested <skillcap><group id=N …> elements.
 *
 * First-class fields the orchestrator owns (name, passwords, maxPlayers, port)
 * are NOT here. No RCON; admin is the in-game GM password.
 */
function lset(
  key: string,
  label: string,
  category: string,
  type: SettingDef["type"],
  def: SettingDef["default"],
  extra: Partial<SettingDef> = {},
): SettingDef {
  return { key, label, category, target: SettingTarget.Env, type, default: def, emitAs: key, ...extra };
}

/** Catalog key → <skillcap> group id in world_1.xml. */
export const LIF_SKILLCAP_GROUPS: Record<string, number> = {
  LIF_SKILLCAP_CRAFTING: 1,
  LIF_SKILLCAP_COMBAT: 2,
  LIF_SKILLCAP_MINOR: 3,
};

const settings: SettingDef[] = [
  // ── Progression ───────────────────────────────────────────────────────────────
  lset("skillsStatsMult", "Skill/stat progression multiplier", "Progression", "float", 1, {
    min: 0.1,
    max: 100,
    step: 0.1,
    help: "1 is the vanilla MMO progression speed.",
  }),
  lset("LIF_SKILLCAP_CRAFTING", "Crafting skillcap", "Progression", "int", 600, {
    min: 200,
    max: 3000,
    help: "600 is the vanilla MMO cap.",
  }),
  lset("LIF_SKILLCAP_COMBAT", "Combat skillcap", "Progression", "int", 600, { min: 200, max: 3000 }),
  lset("LIF_SKILLCAP_MINOR", "Minor skillcap", "Progression", "int", 600, { min: 200, max: 3000 }),

  // ── World ─────────────────────────────────────────────────────────────────────
  lset("dayCycle", "Day length (real hours)", "World", "float", 4, {
    min: 0.1,
    max: 24,
    step: 0.1,
    help: "Real-life hours per in-game day; also drives crop + tree growth speed.",
  }),
  lset("terraformingSpeed", "Tunneling speed", "World", "float", 0.8, {
    min: 0.1,
    max: 5,
    step: 0.1,
    help: "Terraforming speed during tunneling only. 0.8 is vanilla.",
  }),
  lset("craftingPeriod", "Crafting tick (seconds)", "World", "int", 60, {
    min: 1,
    max: 3600,
    help: "Seconds per crafting tick (fuel burn, heating…).",
  }),
  lset("animalBFPeriod", "Breeding tick (minutes)", "World", "int", 60, { min: 1, max: 600 }),
  lset("animalsCount", "Animal spawn points", "World", "int", 50, {
    min: 0,
    max: 100,
    help: "High values load the server noticeably.",
  }),
  lset("objectDecayRate", "Unclaimed-object decay", "World", "float", 0, {
    min: 0,
    max: 10,
    step: 0.1,
    help: "Decay multiplier outside claims. 0 disables decay.",
  }),
  lset("horsesDecayTimeMinutes", "Horse decay (minutes)", "World", "int", 0, {
    min: 0,
    max: 35791,
    help: "0 disables.",
  }),
  lset("movableMaxDropHeightMeters", "Max object drop height (m)", "World", "int", 5, {
    min: 0,
    max: 1000,
  }),

  // ── Events / PvP ──────────────────────────────────────────────────────────────
  lset("randomEventChanceWalk", "Random event chance (walking)", "Events", "float", 0.03, {
    min: 0,
    max: 10,
    step: 0.01,
    help: "0 disables random events while traveling.",
  }),
  lset("randomEventChanceAbility", "Random event chance (abilities)", "Events", "float", 0.02, {
    min: 0,
    max: 10,
    step: 0.01,
  }),
  lset("homecomingDrop", "Homecoming drops inventory", "Events", "bool", true),

  // ── Visibility ────────────────────────────────────────────────────────────────
  lset("isPrivate", "Hide from server browser", "Server", "bool", false, {
    help: "Players then join by IP only.",
  }),
];

export const LIF_CATALOG: SettingsCatalog = { game: Game.LIF, version: "1", settings };
