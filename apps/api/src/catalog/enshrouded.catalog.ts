import { Game, SettingTarget, type SettingsCatalog, type SettingDef } from "@ark/shared";

/**
 * Enshrouded catalog. The mornedhels/enshrouded-server image is env-driven — it
 * translates env vars into enshrouded_server.json on startup, so every setting
 * targets `Env` and the runtime spec passes it through (key = env var name).
 * First-class fields the orchestrator owns (server name, slot count, ports, and the
 * role-based join/admin passwords) are NOT here. Enshrouded has no RCON. Booleans
 * emit as true/false (the image's format). Only settings backed by env vars the
 * image actually maps are exposed — difficulty presets are managed in-game.
 */
function eset(
  key: string,
  label: string,
  category: string,
  type: SettingDef["type"],
  def: SettingDef["default"],
  extra: Partial<SettingDef> = {},
): SettingDef {
  return { key, label, category, target: SettingTarget.Env, type, default: def, emitAs: key, ...extra };
}

const settings: SettingDef[] = [
  // ── Chat & voice ───────────────────────────────────────────────────────────────
  eset("SERVER_ENABLE_VOICE_CHAT", "Enable voice chat", "Chat", "bool", false, {
    help: "Turn on in-game voice chat. Off by default.",
  }),
  eset("SERVER_VOICE_CHAT_MODE", "Voice chat mode", "Chat", "enum", "Proximity", {
    choices: [
      { value: "Proximity", label: "Proximity (nearby players)" },
      { value: "Global", label: "Global (everyone)" },
    ],
    help: "Proximity = only players near you hear you; Global = the whole server. Only applies when voice chat is enabled.",
  }),
  eset("SERVER_ENABLE_TEXT_CHAT", "Enable text chat", "Chat", "bool", false, {
    help: "Turn on the in-game text chat window. Off by default.",
  }),
];

export const ENSHROUDED_CATALOG: SettingsCatalog = { game: Game.ENSHROUDED, version: "1", settings };
