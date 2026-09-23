import { Game, SettingTarget, type SettingsCatalog, type SettingDef } from "@ark/shared";

/**
 * Project Zomboid catalog — two kinds of settings (GH #17):
 *
 *  - Env settings (zset): the handful of vars the danixu86 start script reads and
 *    patches itself (sandbox preset, Steam mode, JVM heap). Emitted into the
 *    container env by zomboidCatalogEnv.
 *  - servertest.ini settings (zini, `section: "servertest"`): the game's own server
 *    INI surface. NOT env — patchZomboidServerIni upserts them into the instance's
 *    servertest.ini before each start, and ONLY the keys the user actually set:
 *    PZ merges its own defaults into the file on boot, so untouched keys keep the
 *    game's (build-appropriate) default and in-game admin edits survive. The
 *    `default` on these entries is therefore UI-display only. Key names verified
 *    against the PZ server-settings reference.
 *
 * First-class fields the orchestrator owns (server name, slots, ports, admin +
 * join passwords, Workshop mods, map) are NOT here. SandboxVars.lua (world tuning:
 * zombies, loot, XP) is a separate Lua surface — pick it via the sandbox preset,
 * tune in-game as admin.
 */
function zset(
  key: string,
  label: string,
  category: string,
  type: SettingDef["type"],
  def: SettingDef["default"],
  extra: Partial<SettingDef> = {},
): SettingDef {
  return { key, label, category, target: SettingTarget.Env, type, default: def, emitAs: key, ...extra };
}

/** A SandboxVars.lua key (see patchZomboidSandboxVars); emitAs may be "Table.Key"
 *  for the Map / ZombieLore / ZombieConfig sub-tables. Numeric-enum values emit as
 *  Lua numbers. Defaults are UI-display only — only user-set keys are written. */
function zsand(
  key: string,
  label: string,
  category: string,
  type: SettingDef["type"],
  def: SettingDef["default"],
  extra: Partial<SettingDef> = {},
): SettingDef {
  return {
    key,
    label,
    category,
    target: SettingTarget.Env,
    section: "sandbox",
    type,
    default: def,
    emitAs: key,
    ...extra,
  };
}

/** Shared loot-rarity scale (SandboxVars loot settings). */
const LOOT_RARITY = [
  { value: "1", label: "None" },
  { value: "2", label: "Insanely rare" },
  { value: "3", label: "Extremely rare" },
  { value: "4", label: "Rare" },
  { value: "5", label: "Normal" },
  { value: "6", label: "Common" },
  { value: "7", label: "Abundant" },
];

/** A servertest.ini key (see patchZomboidServerIni). */
function zini(
  key: string,
  label: string,
  category: string,
  type: SettingDef["type"],
  def: SettingDef["default"],
  extra: Partial<SettingDef> = {},
): SettingDef {
  return {
    key,
    label,
    category,
    target: SettingTarget.Env,
    section: "servertest",
    type,
    default: def,
    emitAs: key,
    ...extra,
  };
}

const settings: SettingDef[] = [
  // ── World (env: preset) ───────────────────────────────────────────────────────
  zset("SERVERPRESET", "Sandbox preset", "World", "enum", "Apocalypse", {
    choices: [
      { value: "Apocalypse", label: "Apocalypse (default survival)" },
      { value: "Beginner", label: "Beginner" },
      { value: "Builder", label: "Builder (relaxed, base-building)" },
      { value: "FirstWeek", label: "First Week" },
      { value: "SixMonthsLater", label: "Six Months Later" },
      { value: "Survival", label: "Survival (classic)" },
      { value: "Survivor", label: "Survivor (combat-focused)" },
    ],
    help: "The sandbox ruleset the world is created with. Applies on FIRST boot only — an existing save keeps its preset unless 'Re-apply preset' is on.",
  }),
  zset("SERVERPRESETREPLACE", "Re-apply preset on start", "World", "bool", false, {
    help: "Overwrite the server's sandbox settings with the preset above on every start. Leave off to preserve custom in-game sandbox tweaks.",
  }),

  // ── World (ini) ───────────────────────────────────────────────────────────────
  zini("SpawnPoint", "Fixed spawn point", "World", "string", "0,0,0", {
    advanced: true,
    help: 'Force every new player to spawn at "x,y,z" (world coordinates). 0,0,0 uses the normal spawn-region selection.',
  }),
  zini("SpawnItems", "Starter items", "World", "string", "", {
    help: 'Comma-separated item types given to new characters, e.g. "Base.Axe,Base.Bag_BigHikingBag".',
  }),
  zini("SaveWorldEveryMinutes", "World save interval", "World", "int", 0, {
    min: 0,
    max: 120,
    unit: "min",
    help: "Save loaded map chunks this often. 0 = only save on chunk unload / shutdown.",
  }),
  zini("NoFire", "Disable fire", "World", "bool", false, {
    help: "Turn off fire spread entirely (campfires still work).",
  }),
  zini("AnnounceDeath", "Announce player deaths", "World", "bool", false, {
    help: "Broadcast a chat message when a player dies.",
  }),
  zini("AnnounceAnimalDeath", "Announce animal deaths", "World", "bool", false, {
    advanced: true,
    help: "Broadcast a chat message when a tamed animal dies (B42 animals).",
  }),
  zini("SleepAllowed", "Sleeping allowed", "World", "bool", false, {
    help: "Let players sleep in beds. Multiplayer sleep needs everyone (or a majority) sleeping.",
  }),
  zini("SleepNeeded", "Sleep needed", "World", "bool", false, {
    help: "Characters get tired and must sleep (only meaningful with sleeping allowed).",
  }),
  zini("KnockedDownAllowed", "Knockdowns allowed", "World", "bool", true, {
    advanced: true,
    help: "Allow players/zombies to be knocked to the ground in combat.",
  }),
  zini("SneakModeHideFromOtherPlayers", "Sneaking hides from players", "World", "bool", true, {
    advanced: true,
    help: "A sneaking player is hidden from other players' sight cones.",
  }),
  zini("TrashDeleteAll", "Trash cans delete items", "World", "bool", false, {
    help: "Items placed in trash cans are permanently deleted.",
  }),
  zini("RemovePlayerCorpsesOnCorpseRemoval", "Remove player corpses too", "World", "bool", false, {
    advanced: true,
    help: "When the sandbox corpse-removal timer fires, also remove player corpses.",
  }),
  zini("BloodSplatLifespanDays", "Blood splat lifespan", "World", "int", 0, {
    min: 0,
    max: 365,
    unit: "days",
    help: "Days before blood splats are cleaned up. 0 = never cleaned.",
  }),
  zini("ItemNumbersLimitPerContainer", "Max items per container", "World", "int", 0, {
    min: 0,
    max: 9000,
    advanced: true,
    help: "Cap on item stacks in a single container. 0 = unlimited.",
  }),
  zini("FastForwardMultiplier", "Fast-forward speed", "World", "float", 40, {
    min: 1,
    max: 100,
    step: 1,
    unit: "×",
    advanced: true,
    help: "Time multiplier while every player sleeps.",
  }),
  zini("UltraSpeedDoesnotAffectToAnimals", "Fast-forward skips animals", "World", "bool", false, {
    advanced: true,
    help: "Animals don't simulate at fast-forward speed (B42).",
  }),

  // ── Server & join ─────────────────────────────────────────────────────────────
  zini("Open", "Open server (no whitelist)", "Server", "bool", true, {
    help: "Anyone can join and an account is created on first login. Off = whitelist-only: only accounts you've added can join.",
  }),
  zini("DropOffWhiteListAfterDeath", "Drop whitelist on death", "Server", "bool", false, {
    advanced: true,
    help: "Remove a player's whitelist entry when their character dies (hardcore one-life servers).",
  }),
  zini("MaxAccountsPerUser", "Max accounts per user", "Server", "int", 0, {
    min: 0,
    max: 100,
    advanced: true,
    help: "Limit how many accounts a single Steam user can create. 0 = unlimited.",
  }),
  zini("AllowCoop", "Allow split-screen co-op", "Server", "bool", true, {
    advanced: true,
    help: "Let a player bring split-screen co-op players onto the server.",
  }),
  zini("PauseEmpty", "Pause when empty", "Server", "bool", true, {
    help: "Freeze world time while no players are online (recommended — stops food rot + zombie migration on an idle server).",
  }),
  zini("PublicDescription", "Server description", "Server", "string", "", {
    help: "Description shown in the public server browser. \\n for line breaks.",
  }),
  zini("ServerWelcomeMessage", "Welcome message", "Server", "string", "", {
    help: "Message shown to players in chat when they join. <RGB:1,0,0> colors and <LINE> breaks supported.",
  }),
  zini("LoginQueueEnabled", "Login queue", "Server", "bool", false, {
    advanced: true,
    help: "Queue simultaneous logins instead of letting them race.",
  }),
  zini("LoginQueueConnectTimeout", "Login queue timeout", "Server", "int", 60, {
    min: 10,
    max: 600,
    unit: "s",
    advanced: true,
  }),
  zini("DenyLoginOnOverloadedServer", "Deny login when overloaded", "Server", "bool", true, {
    advanced: true,
    help: "Refuse new logins while the server is struggling to keep up.",
  }),
  zini("PingLimit", "Ping limit", "Server", "int", 400, {
    min: 100,
    max: 2000,
    unit: "ms",
    help: "Kick players whose ping stays above this. Raise for international communities.",
  }),
  zini("DisplayUserName", "Show usernames", "Server", "bool", true, {
    help: "Show account usernames above characters.",
  }),
  zini("ShowFirstAndLastName", "Show character names", "Server", "bool", false, {
    help: "Show character first + last names instead of (or with) usernames.",
  }),
  zini("MouseOverToSeeDisplayName", "Names on mouse-over only", "Server", "bool", true, {
    advanced: true,
    help: "Players must mouse over someone to see their display name.",
  }),
  zini("HideAdminsInPlayerList", "Hide admins in player list", "Server", "bool", false, {
    advanced: true,
  }),
  zini("DisableScoreboard", "Disable scoreboard", "Server", "bool", false, {
    advanced: true,
    help: "Disable the in-game player scoreboard for non-staff (B42).",
  }),
  zini("SteamScoreboard", "Steam names on scoreboard", "Server", "enum", "true", {
    choices: [
      { value: "true", label: "Everyone" },
      { value: "admin", label: "Admins only" },
      { value: "false", label: "Nobody" },
    ],
    advanced: true,
    help: "Who can see Steam names + avatars on the scoreboard.",
  }),
  zini("ShowCoordinates", "Show coordinates", "Server", "bool", true, {
    advanced: true,
    help: "Show player coordinates in the in-game map UI.",
  }),
  zini("UPnP", "UPnP port forwarding", "Server", "bool", false, {
    advanced: true,
    help: "Ask the router to open ports automatically. Leave off — the manager publishes ports explicitly.",
  }),
  zini("AllowNonAsciiUsername", "Allow non-ASCII usernames", "Server", "bool", false, {
    advanced: true,
    help: "Allow Cyrillic and other non-ASCII characters in usernames.",
  }),

  // ── PvP ───────────────────────────────────────────────────────────────────────
  zini("PVP", "PvP enabled", "PvP", "bool", true, {
    help: "Master switch for player-vs-player damage (with the safety system below).",
  }),
  zini("SafetySystem", "Safety system", "PvP", "bool", true, {
    help: "Players toggle their own PvP flag; two consenting flagged players can fight. Off + PvP on = everyone is always fair game.",
  }),
  zini("ShowSafety", "Show safety skull", "PvP", "bool", true, {
    help: "Show the skull icon indicating a player's PvP state.",
  }),
  zini("SafetyToggleTimer", "Safety toggle time", "PvP", "int", 2, {
    min: 0,
    max: 1000,
    unit: "s",
    advanced: true,
    help: "Seconds it takes to switch your PvP flag.",
  }),
  zini("SafetyCooldownTimer", "Safety cooldown", "PvP", "int", 3, {
    min: 0,
    max: 1000,
    unit: "min",
    advanced: true,
    help: "Cooldown before the PvP flag can be switched again.",
  }),
  zini("SafetyDisconnectDelay", "Log-out combat delay", "PvP", "int", 0, {
    min: 0,
    max: 1000,
    unit: "s",
    advanced: true,
    help: "Keep the character in the world this long after a disconnect (anti combat-logging, B42).",
  }),
  zini("PVPMeleeDamageModifier", "PvP melee damage", "PvP", "float", 30, {
    min: 0,
    max: 500,
    step: 1,
    help: "Melee damage players deal to players.",
  }),
  zini("PVPFirearmDamageModifier", "PvP firearm damage", "PvP", "float", 50, {
    min: 0,
    max: 500,
    step: 1,
    help: "Firearm damage players deal to players.",
  }),
  zini("PVPMeleeWhileHitReaction", "Melee hit reaction", "PvP", "bool", false, {
    advanced: true,
    help: "Players stagger when hit in melee PvP.",
  }),
  zini("UsePhysicsHitReaction", "Physics hit reaction", "PvP", "bool", false, {
    advanced: true,
  }),
  zini("PlayerBumpPlayer", "Players can bump players", "PvP", "bool", false, {
    advanced: true,
    help: "Running into another player can stumble them.",
  }),
  zini("HidePlayersBehindYou", "Hide players behind you", "PvP", "bool", true, {
    advanced: true,
    help: "Players outside your vision cone are hidden (stealth PvP).",
  }),
  zini("MapRemotePlayerVisibility", "Players on map", "PvP", "enum", "1", {
    choices: [
      { value: "1", label: "Hidden" },
      { value: "2", label: "Friends only" },
      { value: "3", label: "Everyone" },
    ],
    advanced: true,
    help: "Which other players are visible on the in-game map.",
  }),
  zini("PlayerRespawnWithSelf", "Respawn at death spot", "PvP", "bool", false, {
    advanced: true,
    help: "Allow respawning at the coordinates where the previous character died.",
  }),
  zini("PlayerRespawnWithOther", "Respawn at friends", "PvP", "bool", false, {
    advanced: true,
    help: "Allow respawning next to another remote player.",
  }),
  zini("SpeedLimit", "Vehicle speed limit", "PvP", "float", 70, {
    min: 10,
    max: 150,
    step: 1,
    advanced: true,
    help: "Hard cap on vehicle speed (griefing mitigation).",
  }),
  zini("CarEngineAttractionModifier", "Engine noise attraction", "PvP", "float", 0.5, {
    min: 0,
    max: 10,
    step: 0.1,
    unit: "×",
    advanced: true,
    help: "How strongly running engines attract zombies.",
  }),
  zini("PVPLogToolChat", "Log PvP to chat", "PvP", "bool", true, {
    advanced: true,
    help: "PvP events are logged to admin chat.",
  }),
  zini("PVPLogToolFile", "Log PvP to file", "PvP", "bool", true, {
    advanced: true,
  }),
  zini("DisableVehicleTowing", "Disable vehicle towing", "PvP", "bool", false, {
    advanced: true,
  }),
  zini("DisableTrailerTowing", "Disable trailer towing", "PvP", "bool", false, {
    advanced: true,
  }),
  zini("DisableBurntTowing", "Disable towing burnt vehicles", "PvP", "bool", false, {
    advanced: true,
  }),

  // ── Safehouses & factions ─────────────────────────────────────────────────────
  zini("PlayerSafehouse", "Player safehouses", "Safehouse", "bool", false, {
    help: "Players can claim buildings as safehouses.",
  }),
  zini("AdminSafehouse", "Admin-only safehouses", "Safehouse", "bool", false, {
    advanced: true,
    help: "Only admins can assign safehouses.",
  }),
  zini("SafehouseAllowTrepass", "Allow trespassing", "Safehouse", "bool", true, {
    help: "Non-members may enter other players' safehouses.",
  }),
  zini("SafehouseAllowFire", "Fire affects safehouses", "Safehouse", "bool", true, {
    help: "Fire can damage safehouses.",
  }),
  zini("SafehouseAllowLoot", "Non-members can loot", "Safehouse", "bool", true),
  zini("SafehouseAllowRespawn", "Respawn in safehouse", "Safehouse", "bool", false, {
    help: "Members respawn in their safehouse after death.",
  }),
  zini("SafehouseDaySurvivedToClaim", "Days survived to claim", "Safehouse", "int", 0, {
    min: 0,
    max: 365,
    unit: "days",
    help: "In-game days a player must have survived before claiming a safehouse.",
  }),
  zini("SafeHouseRemovalTime", "Auto-release after offline", "Safehouse", "int", 144, {
    min: 0,
    max: 8760,
    unit: "hours",
    help: "Release a safehouse when its members haven't been online this long.",
  }),
  zini("SafehouseAllowNonResidential", "Non-residential claims", "Safehouse", "bool", false, {
    advanced: true,
    help: "Allow claiming non-residential buildings (stores, warehouses).",
  }),
  zini("SafehouseDisableDisguises", "No disguises inside", "Safehouse", "bool", false, {
    advanced: true,
    help: "Username disguises are dropped inside safehouses (B42).",
  }),
  zini("SafehousePreventsLootRespawn", "Block loot respawn inside", "Safehouse", "bool", true, {
    advanced: true,
    help: "Items don't respawn in buildings claimed as a safehouse.",
  }),
  zini("DisableSafehouseWhenOwnerConnected", "Unprotected while owner online", "Safehouse", "bool", false, {
    advanced: true,
    help: "Safehouse protection only applies while its owner is offline.",
  }),
  zini("MaxSafezoneSize", "Max safezone size", "Safehouse", "int", 100, {
    min: 10,
    max: 1000,
    advanced: true,
  }),
  zini("AllowDestructionBySledgehammer", "Sledgehammer destruction", "Safehouse", "bool", true, {
    help: "Players can demolish world tiles with a sledgehammer.",
  }),
  zini("SledgehammerOnlyInSafehouse", "Sledgehammer only in own safehouse", "Safehouse", "bool", false, {
    advanced: true,
    help: "Players can only destroy world objects inside their own safehouse. Needs sledgehammer destruction on.",
  }),
  zini("Faction", "Factions", "Safehouse", "bool", true, {
    help: "Players can create factions (shared chat + map markers).",
  }),
  zini("FactionDaySurvivedToCreate", "Days survived to create faction", "Safehouse", "int", 0, {
    min: 0,
    max: 365,
    unit: "days",
    advanced: true,
    help: "In-game days a player must survive before creating a faction.",
  }),
  zini("FactionPlayersRequiredForTag", "Members needed for faction tag", "Safehouse", "int", 1, {
    min: 1,
    max: 100,
    advanced: true,
    help: "Faction members needed before the owner can create a group tag.",
  }),
  zini("War", "Faction wars", "Safehouse", "bool", false, {
    advanced: true,
    help: "Enable declared faction wars, making enemy safehouses raidable (B42).",
  }),
  zini("WarStartDelay", "War start delay", "Safehouse", "int", 24, {
    min: 0,
    max: 720,
    unit: "hours",
    advanced: true,
  }),
  zini("WarDuration", "War duration", "Safehouse", "int", 48, {
    min: 1,
    max: 720,
    unit: "hours",
    advanced: true,
  }),
  zini("WarSafehouseHitPoints", "War safehouse hit points", "Safehouse", "int", 100, {
    min: 1,
    max: 10000,
    advanced: true,
    help: "Hit-point limit of a safehouse during a faction war.",
  }),

  // ── Chat & voice ──────────────────────────────────────────────────────────────
  zini("GlobalChat", "Global chat", "Chat & voice", "bool", true, {
    help: "The /all global chat channel.",
  }),
  zini("ChatStreams", "Enabled chat streams", "Chat & voice", "string", "s,r,a,w,y,sh,f,all", {
    advanced: true,
    help: "Comma list: s=say r=shout a=admin w=whisper y=yell sh=safehouse f=faction all=global.",
  }),
  zini("ChatMessageCharacterLimit", "Chat message length limit", "Chat & voice", "int", 256, {
    min: 1,
    max: 1024,
    advanced: true,
  }),
  zini("ChatMessageSlowModeTime", "Chat slow mode", "Chat & voice", "int", 0, {
    min: 0,
    max: 300,
    unit: "s",
    advanced: true,
    help: "Minimum seconds between chat messages per player. 0 = off (B42).",
  }),
  zini("BanKickGlobalSound", "Ban/kick global sound", "Chat & voice", "bool", true, {
    advanced: true,
  }),
  zini("VoiceEnable", "Voice chat", "Chat & voice", "bool", true),
  zini("Voice3D", "3D positional voice", "Chat & voice", "bool", true, {
    advanced: true,
    help: "Directional audio for voice chat.",
  }),
  zini("VoiceMinDistance", "Voice min distance", "Chat & voice", "float", 10, {
    min: 0,
    max: 100,
    step: 1,
    advanced: true,
    help: "Minimum distance in tiles over which voice chat can be heard.",
  }),
  zini("VoiceMaxDistance", "Voice max distance", "Chat & voice", "float", 100, {
    min: 10,
    max: 300,
    step: 1,
    advanced: true,
    help: "Maximum distance in tiles over which voice chat can be heard.",
  }),
  zini("BadWordPolicy", "Bad-word policy", "Chat & voice", "enum", "0", {
    choices: [
      { value: "0", label: "Off" },
      { value: "1", label: "Replace words" },
      { value: "2", label: "Block message" },
    ],
    advanced: true,
    help: "Chat filtering against the server's bad-word list (B42).",
  }),
  zini("BadWordReplacement", "Bad-word replacement", "Chat & voice", "string", "****", {
    advanced: true,
    help: "Symbol or text that replaces a filtered bad word.",
  }),
  zini("DisableRadioStaff", "No radio: staff", "Chat & voice", "bool", false, {
    advanced: true,
    help: "Hide radio transmissions from staff roles (this + the ones below control whose speech goes out over in-game radio).",
  }),
  zini("DisableRadioAdmin", "No radio: admin", "Chat & voice", "bool", true, {
    advanced: true,
    help: "Blocks radio transmissions from players with the admin access level.",
  }),
  zini("DisableRadioGM", "No radio: GM", "Chat & voice", "bool", true, {
    advanced: true,
    help: "Blocks radio transmissions from players with the GM access level.",
  }),
  zini("DisableRadioOverseer", "No radio: overseer", "Chat & voice", "bool", false, {
    advanced: true,
    help: "Blocks radio transmissions from players with the overseer access level.",
  }),
  zini("DisableRadioModerator", "No radio: moderator", "Chat & voice", "bool", false, {
    advanced: true,
    help: "Blocks radio transmissions from players with the moderator access level.",
  }),
  zini("DisableRadioInvisible", "No radio: invisible staff", "Chat & voice", "bool", true, {
    advanced: true,
    help: "Blocks radio transmissions from invisible players.",
  }),

  // ── Discord ───────────────────────────────────────────────────────────────────
  zini("DiscordEnable", "Discord bridge", "Discord", "bool", false, {
    help: "Bridge in-game chat to a Discord channel via the bot token below. (Separate from Palisade's own Discord notifications.)",
  }),
  zini("DiscordToken", "Discord bot token", "Discord", "string", "", {
    advanced: true,
    help: "Bot token for the chat bridge. Stored in the server settings and visible to panel users — use a dedicated bot with minimal permissions.",
  }),
  zini("DiscordChatChannel", "Discord chat channel", "Discord", "string", "", {
    advanced: true,
    help: "Channel name (without #) the game chat mirrors to.",
  }),
  zini("DiscordCommandChannel", "Discord command channel", "Discord", "string", "", {
    advanced: true,
  }),
  zini("DiscordLogChannel", "Discord log channel", "Discord", "string", "", {
    advanced: true,
    help: "Channel for server log events (B42).",
  }),
  zini("WebhookAddress", "Webhook address", "Discord", "string", "", {
    advanced: true,
    help: "HTTP webhook for server events (B42).",
  }),

  // ── Backups (the game's own) ──────────────────────────────────────────────────
  zini("BackupsCount", "Game backup slots", "Game backups", "int", 5, {
    min: 1,
    max: 300,
    help: "How many of PZ's own world backups to keep (separate from Palisade's backup system).",
  }),
  zini("BackupsOnStart", "Backup on start", "Game backups", "bool", true),
  zini("BackupsOnVersionChange", "Backup on version change", "Game backups", "bool", true),
  zini("BackupsPeriod", "Periodic backup interval", "Game backups", "int", 0, {
    min: 0,
    max: 1500,
    unit: "min",
    help: "0 = no periodic backups (start/version-change backups still apply).",
  }),

  // ── Anti-cheat & logs ─────────────────────────────────────────────────────────
  zini("DoLuaChecksum", "Lua checksum check", "Anti-cheat", "bool", true, {
    help: "Kick clients whose Lua scripts don't match the server's (blocks client-side script cheats; turn off only for mismatched-mod debugging).",
  }),
  zini("KickFastPlayers", "Kick speeding players", "Anti-cheat", "bool", false, {
    advanced: true,
    help: "Kick players moving impossibly fast. Can false-positive on laggy connections.",
  }),
  zini("AntiCheatProtectionType1", "Anti-cheat: type 1 (player)", "Anti-cheat", "bool", true, { advanced: true }),
  zini("AntiCheatProtectionType2", "Anti-cheat: type 2 (safety)", "Anti-cheat", "bool", true, { advanced: true }),
  zini("AntiCheatProtectionType3", "Anti-cheat: type 3 (checksum)", "Anti-cheat", "bool", true, { advanced: true }),
  zini("AntiCheatProtectionType4", "Anti-cheat: type 4 (safehouse)", "Anti-cheat", "bool", true, { advanced: true }),
  zini("AntiCheatProtectionType5", "Anti-cheat: type 5 (speed)", "Anti-cheat", "bool", true, { advanced: true }),
  zini("AntiCheatProtectionType6", "Anti-cheat: type 6 (XP)", "Anti-cheat", "bool", true, { advanced: true }),
  zini("AntiCheatProtectionType7", "Anti-cheat: type 7 (hit)", "Anti-cheat", "bool", true, { advanced: true }),
  zini("AntiCheatProtectionType8", "Anti-cheat: type 8 (noclip)", "Anti-cheat", "bool", true, { advanced: true }),
  zini(
    "ClientCommandFilter",
    "Client command log filter",
    "Anti-cheat",
    "string",
    "-vehicle.*;+vehicle.damageWindow;+vehicle.fixPart;+vehicle.installPart;+vehicle.uninstallPart",
    {
      advanced: true,
      help: "Which client commands are written to the cmd log (-exclude, +include patterns).",
    },
  ),
  zini("ClientActionLogs", "Logged client actions", "Anti-cheat", "string", "ISEnterVehicle;ISExitVehicle;ISTakeEngineParts;", {
    advanced: true,
    help: "Semicolon-separated list of actions written to the ClientActionLogs.txt server log.",
  }),
  zini("PerkLogs", "Perk logs", "Anti-cheat", "bool", true, {
    advanced: true,
    help: "Log players' perk/level changes (useful evidence against XP cheats).",
  }),
  zini("MaxPacketsPerSecond", "Max packets/second", "Anti-cheat", "int", 0, {
    min: 0,
    max: 1000,
    advanced: true,
    help: "Per-connection packet rate cap. 0 = image/game default.",
  }),
  zini("MultiplayerStatisticsPeriod", "Statistics period", "Anti-cheat", "int", 0, {
    min: 0,
    max: 3600,
    unit: "s",
    advanced: true,
    help: "How often multiplayer statistics update. 0 = statistics off.",
  }),
  zini("UsernameDisguises", "Username disguises", "Anti-cheat", "bool", false, {
    advanced: true,
    help: "Let players hide their username behind a disguise (B42 role-play servers).",
  }),
  zini("HideDisguisedUserName", "Hide disguised usernames", "Anti-cheat", "bool", false, {
    advanced: true,
  }),

  // ═══ SandboxVars.lua — world tuning (patchZomboidSandboxVars) ═════════════════
  // ── Zombies ───────────────────────────────────────────────────────────────────
  zsand("Zombies", "Zombie population", "Zombies", "enum", "4", {
    choices: [
      { value: "1", label: "Insane" },
      { value: "2", label: "Very high" },
      { value: "3", label: "High" },
      { value: "4", label: "Normal" },
      { value: "5", label: "Low" },
      { value: "6", label: "None" },
    ],
    help: "Overall zombie population preset. Fine-tune with the multipliers below.",
  }),
  zsand("ZombieLore.Speed", "Zombie speed", "Zombies", "enum", "2", {
    emitAs: "ZombieLore.Speed",
    choices: [
      { value: "1", label: "Sprinters" },
      { value: "2", label: "Fast shamblers" },
      { value: "3", label: "Shamblers" },
      { value: "4", label: "Random" },
    ],
    help: "How fast zombies move.",
  }),
  zsand("ZombieLore.Strength", "Zombie strength", "Zombies", "enum", "2", {
    emitAs: "ZombieLore.Strength",
    choices: [
      { value: "1", label: "Superhuman" },
      { value: "2", label: "Normal" },
      { value: "3", label: "Weak" },
      { value: "4", label: "Random" },
    ],
    help: "Damage zombies deal per attack.",
  }),
  zsand("ZombieLore.Toughness", "Zombie toughness", "Zombies", "enum", "2", {
    emitAs: "ZombieLore.Toughness",
    choices: [
      { value: "1", label: "Tough" },
      { value: "2", label: "Normal" },
      { value: "3", label: "Fragile" },
      { value: "4", label: "Random" },
    ],
    help: "How hard zombies are to kill.",
  }),
  zsand("ZombieLore.Transmission", "Infection transmission", "Zombies", "enum", "1", {
    emitAs: "ZombieLore.Transmission",
    choices: [
      { value: "1", label: "Blood + saliva" },
      { value: "2", label: "Saliva only" },
      { value: "3", label: "Everyone's infected" },
      { value: "4", label: "None" },
    ],
    help: "How the Knox infection spreads to players.",
  }),
  zsand("ZombieLore.Mortality", "Infection mortality", "Zombies", "enum", "5", {
    emitAs: "ZombieLore.Mortality",
    choices: [
      { value: "1", label: "Instant" },
      { value: "2", label: "0–30 seconds" },
      { value: "3", label: "0–1 minute" },
      { value: "4", label: "0–12 hours" },
      { value: "5", label: "2–3 days" },
      { value: "6", label: "1–2 weeks" },
      { value: "7", label: "Never" },
    ],
    help: "How fast an infected player dies.",
  }),
  zsand("ZombieLore.Reanimate", "Reanimation time", "Zombies", "enum", "3", {
    emitAs: "ZombieLore.Reanimate",
    advanced: true,
    choices: [
      { value: "1", label: "Instant" },
      { value: "2", label: "0–30 seconds" },
      { value: "3", label: "0–1 minute" },
      { value: "4", label: "0–12 hours" },
      { value: "5", label: "2–3 days" },
      { value: "6", label: "1–2 weeks" },
    ],
    help: "How quickly infected corpses rise as zombies.",
  }),
  zsand("ZombieLore.Cognition", "Zombie intelligence", "Zombies", "enum", "3", {
    emitAs: "ZombieLore.Cognition",
    choices: [
      { value: "1", label: "Navigate + use doors" },
      { value: "2", label: "Navigate" },
      { value: "3", label: "Basic navigation" },
      { value: "4", label: "Random" },
    ],
  }),
  zsand("ZombieLore.Memory", "Zombie memory", "Zombies", "enum", "2", {
    emitAs: "ZombieLore.Memory",
    advanced: true,
    choices: [
      { value: "1", label: "Long" },
      { value: "2", label: "Normal" },
      { value: "3", label: "Short" },
      { value: "4", label: "None" },
    ],
    help: "How long zombies remember a player after seeing or hearing them.",
  }),
  zsand("ZombieLore.Sight", "Zombie sight", "Zombies", "enum", "2", {
    emitAs: "ZombieLore.Sight",
    choices: [
      { value: "1", label: "Eagle" },
      { value: "2", label: "Normal" },
      { value: "3", label: "Poor" },
      { value: "4", label: "Random" },
    ],
    help: "Zombie vision radius.",
  }),
  zsand("ZombieLore.Hearing", "Zombie hearing", "Zombies", "enum", "2", {
    emitAs: "ZombieLore.Hearing",
    choices: [
      { value: "1", label: "Pinpoint" },
      { value: "2", label: "Normal" },
      { value: "3", label: "Poor" },
      { value: "4", label: "Random" },
    ],
    help: "Zombie hearing radius.",
  }),
  zsand("ZombieLore.ActiveOnly", "Zombie activity hours", "Zombies", "enum", "1", {
    emitAs: "ZombieLore.ActiveOnly",
    advanced: true,
    choices: [
      { value: "1", label: "Both day and night" },
      { value: "2", label: "Night only" },
      { value: "3", label: "Day only" },
    ],
    help: "When zombies are active. Inactive zombies move slower and tend not to give chase.",
  }),
  zsand("ZombieLore.ThumpOnConstruction", "Zombies attack constructions", "Zombies", "bool", true, {
    emitAs: "ZombieLore.ThumpOnConstruction",
    advanced: true,
    help: "Zombies can destroy player constructions and defences.",
  }),
  zsand("ZombieLore.ZombiesDragDown", "Zombies drag players down", "Zombies", "bool", true, {
    emitAs: "ZombieLore.ZombiesDragDown",
    advanced: true,
    help: "Several attacking zombies can drag a player down and kill them. Depends on zombie strength.",
  }),
  zsand("ZombieLore.ZombiesFenceLunge", "Zombies lunge over fences", "Zombies", "bool", true, {
    emitAs: "ZombieLore.ZombiesFenceLunge",
    advanced: true,
    help: "Zombies may lunge at a nearby player after climbing over a fence.",
  }),
  zsand("ZombieLore.TriggerHouseAlarm", "Zombies trigger house alarms", "Zombies", "bool", false, {
    emitAs: "ZombieLore.TriggerHouseAlarm",
    advanced: true,
    help: "Zombies can set off house alarms when breaking through windows and doors.",
  }),
  zsand("ZombieConfig.PopulationMultiplier", "Population multiplier", "Zombies", "float", 1.0, {
    emitAs: "ZombieConfig.PopulationMultiplier",
    min: 0,
    max: 4,
    step: 0.05,
    unit: "×",
    help: "Master zombie-count multiplier (0 = none, 4 = insane).",
  }),
  zsand("ZombieConfig.PopulationStartMultiplier", "Day-1 population", "Zombies", "float", 1.0, {
    emitAs: "ZombieConfig.PopulationStartMultiplier",
    min: 0,
    max: 4,
    step: 0.05,
    unit: "×",
    advanced: true,
    help: "Zombie population multiplier at the start of the game.",
  }),
  zsand("ZombieConfig.PopulationPeakMultiplier", "Peak population", "Zombies", "float", 1.5, {
    emitAs: "ZombieConfig.PopulationPeakMultiplier",
    min: 0,
    max: 4,
    step: 0.05,
    unit: "×",
    advanced: true,
    help: "Zombie population multiplier on the peak day.",
  }),
  zsand("ZombieConfig.PopulationPeakDay", "Peak population day", "Zombies", "int", 28, {
    emitAs: "ZombieConfig.PopulationPeakDay",
    min: 1,
    max: 365,
    unit: "days",
    advanced: true,
    help: "Day the zombie population reaches its peak.",
  }),
  zsand("ZombieConfig.RespawnHours", "Zombie respawn hours", "Zombies", "float", 72, {
    emitAs: "ZombieConfig.RespawnHours",
    min: 0,
    max: 8760,
    step: 1,
    unit: "hours",
    help: "In-game hours before zombies may respawn in a cell. 0 = never respawn.",
  }),
  zsand("ZombieConfig.RespawnUnseenHours", "Respawn unseen hours", "Zombies", "float", 16, {
    emitAs: "ZombieConfig.RespawnUnseenHours",
    min: 0,
    max: 8760,
    step: 1,
    unit: "hours",
    advanced: true,
    help: "A chunk must be unseen this long before zombies respawn in it.",
  }),
  zsand("ZombieConfig.RespawnMultiplier", "Respawn fraction", "Zombies", "float", 0.1, {
    emitAs: "ZombieConfig.RespawnMultiplier",
    min: 0,
    max: 1,
    step: 0.01,
    advanced: true,
    help: "Fraction of a cell's population that respawns each respawn tick.",
  }),
  zsand("ZombieConfig.RallyGroupSize", "Zombie group size", "Zombies", "int", 20, {
    emitAs: "ZombieConfig.RallyGroupSize",
    min: 0,
    max: 1000,
    advanced: true,
    help: "How many zombies gather into roaming groups. 0 = no grouping.",
  }),
  zsand("ZombieConfig.FollowSoundDistance", "Sound follow distance", "Zombies", "int", 100, {
    emitAs: "ZombieConfig.FollowSoundDistance",
    min: 10,
    max: 1000,
    advanced: true,
    help: "How far zombies travel toward distant sounds (tiles).",
  }),

  // ── Loot ──────────────────────────────────────────────────────────────────────
  zsand("FoodLoot", "Food", "Loot", "enum", "4", {
    choices: LOOT_RARITY,
    help: "Rarity of non-canned food.",
  }),
  zsand("CannedFoodLoot", "Canned food", "Loot", "enum", "4", { choices: LOOT_RARITY }),
  zsand("WeaponLoot", "Melee weapons", "Loot", "enum", "4", { choices: LOOT_RARITY }),
  zsand("RangedWeaponLoot", "Firearms", "Loot", "enum", "4", { choices: LOOT_RARITY }),
  zsand("AmmoLoot", "Ammo", "Loot", "enum", "4", { choices: LOOT_RARITY }),
  zsand("MedicalLoot", "Medical", "Loot", "enum", "4", { choices: LOOT_RARITY }),
  zsand("MechanicsLoot", "Mechanics / car parts", "Loot", "enum", "4", { choices: LOOT_RARITY }),
  zsand("SurvivalGearsLoot", "Survival gear", "Loot", "enum", "4", {
    choices: LOOT_RARITY,
    help: "Seeds, nails, saws, fishing rods and other tools.",
  }),
  zsand("LiteratureLoot", "Literature", "Loot", "enum", "4", { choices: LOOT_RARITY }),
  zsand("OtherLoot", "Everything else", "Loot", "enum", "4", { choices: LOOT_RARITY }),
  zsand("LootRespawn", "Loot respawn", "Loot", "enum", "1", {
    choices: [
      { value: "1", label: "Never" },
      { value: "2", label: "Every day" },
      { value: "3", label: "Every week" },
      { value: "4", label: "Every month" },
      { value: "5", label: "Every two months" },
    ],
    help: "Whether emptied containers restock over time.",
  }),
  zsand("SeenHoursPreventLootRespawn", "No respawn if seen within", "Loot", "int", 0, {
    min: 0,
    max: 8760,
    unit: "hours",
    advanced: true,
    help: "A container seen within this many in-game hours won't restock. 0 = off.",
  }),
  zsand("HoursForWorldItemRemoval", "Dropped-item cleanup", "Loot", "float", 24, {
    min: 0,
    max: 8760,
    step: 1,
    unit: "hours",
    advanced: true,
    help: "In-game hours before dropped items on the ground are cleaned up.",
  }),

  // ── World (sandbox: time / weather / events) ──────────────────────────────────
  zsand("DayLength", "Day length", "World", "enum", "3", {
    choices: [
      { value: "1", label: "15 minutes" },
      { value: "2", label: "30 minutes" },
      { value: "3", label: "1 hour" },
      { value: "4", label: "2 hours" },
      { value: "5", label: "3 hours" },
      { value: "6", label: "4 hours" },
      { value: "7", label: "5 hours" },
      { value: "8", label: "6 hours" },
      { value: "9", label: "7 hours" },
      { value: "10", label: "8 hours" },
      { value: "11", label: "9 hours" },
      { value: "12", label: "10 hours" },
      { value: "13", label: "11 hours" },
      { value: "14", label: "12 hours" },
    ],
    help: "Real-time length of one in-game day.",
  }),
  zsand("StartMonth", "Start month", "World", "int", 7, {
    min: 1,
    max: 12,
    advanced: true,
    help: "Month the world starts in (July = the classic Knox Event start).",
  }),
  zsand("TimeSinceApo", "Months since the apocalypse", "World", "int", 1, {
    min: 1,
    max: 13,
    advanced: true,
    help: "How advanced world erosion/decay is at spawn (1 = day one).",
  }),
  zsand("WaterShutModifier", "Water shutoff", "World", "int", 14, {
    unit: "days",
    min: -1,
    max: 365,
    help: "Days until tap water shuts off. -1 = instant, 2147483647 = never.",
  }),
  zsand("ElecShutModifier", "Electricity shutoff", "World", "int", 14, {
    unit: "days",
    min: -1,
    max: 365,
    help: "Days until the power grid shuts off. -1 = instant, 2147483647 = never.",
  }),
  zsand("NightDarkness", "Night darkness", "World", "enum", "3", {
    choices: [
      { value: "1", label: "Pitch black" },
      { value: "2", label: "Dark" },
      { value: "3", label: "Normal" },
      { value: "4", label: "Bright" },
    ],
    help: "Ambient light level at night.",
  }),
  zsand("Helicopter", "Helicopter event", "World", "enum", "2", {
    choices: [
      { value: "1", label: "Never" },
      { value: "2", label: "Once" },
      { value: "3", label: "Sometimes" },
      { value: "4", label: "Often" },
    ],
    help: "The heli flyover that drags hordes toward you.",
  }),
  zsand("MetaEvent", "Meta events (distant gunfire etc.)", "World", "enum", "2", {
    advanced: true,
    choices: [
      { value: "1", label: "Never" },
      { value: "2", label: "Sometimes" },
      { value: "3", label: "Often" },
    ],
    help: "How often zombie-attracting events like distant gunshots happen.",
  }),
  zsand("GeneratorSpawning", "Generator spawn rate", "World", "enum", "3", {
    advanced: true,
    choices: [
      { value: "1", label: "Extremely rare" },
      { value: "2", label: "Rare" },
      { value: "3", label: "Sometimes" },
      { value: "4", label: "Often" },
    ],
    help: "Chance of electrical generators spawning on the map.",
  }),
  zsand("GeneratorFuelConsumption", "Generator fuel use", "World", "float", 1.0, {
    min: 0,
    max: 10,
    step: 0.1,
    unit: "×",
    advanced: true,
    help: "How much fuel generators burn per in-game hour.",
  }),
  zsand("Alarm", "House alarms", "World", "enum", "4", {
    advanced: true,
    choices: [
      { value: "1", label: "Never" },
      { value: "2", label: "Extremely rare" },
      { value: "3", label: "Rare" },
      { value: "4", label: "Sometimes" },
      { value: "5", label: "Often" },
      { value: "6", label: "Very often" },
    ],
    help: "How likely breaking into a house sets off an alarm.",
  }),
  zsand("LockedHouses", "Locked houses", "World", "enum", "6", {
    advanced: true,
    choices: [
      { value: "1", label: "Never" },
      { value: "2", label: "Extremely rare" },
      { value: "3", label: "Rare" },
      { value: "4", label: "Sometimes" },
      { value: "5", label: "Often" },
      { value: "6", label: "Very often" },
    ],
    help: "How often the doors of homes and buildings are locked when discovered.",
  }),
  zsand("FireSpread", "Fire spread", "World", "bool", true, {
    help: "Whether fire spreads between tiles (sandbox side — the server INI 'Disable fire' overrides everything).",
  }),
  zsand("Map.AllowMiniMap", "Mini-map", "World", "bool", false, {
    emitAs: "Map.AllowMiniMap",
    advanced: true,
    help: "Makes a mini-map window available.",
  }),
  zsand("Map.AllowWorldMap", "World map", "World", "bool", true, {
    emitAs: "Map.AllowWorldMap",
    advanced: true,
    help: "Players can open the world map.",
  }),
  zsand("Map.MapAllKnown", "Map fully revealed", "World", "bool", false, {
    emitAs: "Map.MapAllKnown",
    advanced: true,
    help: "The world map starts completely filled in.",
  }),

  // ── Survival ──────────────────────────────────────────────────────────────────
  zsand("XpMultiplier", "XP multiplier", "Survival", "float", 1.0, {
    min: 0.1,
    max: 100,
    step: 0.1,
    unit: "×",
    help: "Multiplies the base XP gained from actions.",
  }),
  zsand("StatsDecrease", "Hunger/thirst/fatigue rate", "Survival", "enum", "3", {
    choices: [
      { value: "1", label: "Very fast" },
      { value: "2", label: "Fast" },
      { value: "3", label: "Normal" },
      { value: "4", label: "Slow" },
    ],
    help: "How fast a character's hunger, thirst and fatigue stats drain.",
  }),
  zsand("Nutrition", "Nutrition system", "Survival", "bool", true, {
    advanced: true,
    help: "Track calories/weight from food.",
  }),
  zsand("FoodRotSpeed", "Food rot speed", "Survival", "enum", "3", {
    choices: [
      { value: "1", label: "Very fast" },
      { value: "2", label: "Fast" },
      { value: "3", label: "Normal" },
      { value: "4", label: "Slow" },
      { value: "5", label: "Very slow" },
    ],
    help: "How fast food spoils, inside or outside a fridge.",
  }),
  zsand("FridgeFactor", "Fridge effectiveness", "Survival", "enum", "3", {
    advanced: true,
    choices: [
      { value: "1", label: "Very low" },
      { value: "2", label: "Low" },
      { value: "3", label: "Normal" },
      { value: "4", label: "High" },
      { value: "5", label: "Very high" },
    ],
    help: "How well fridges keep food fresh.",
  }),
  zsand("Farming", "Farming speed", "Survival", "enum", "3", {
    advanced: true,
    choices: [
      { value: "1", label: "Very fast" },
      { value: "2", label: "Fast" },
      { value: "3", label: "Normal" },
      { value: "4", label: "Slow" },
      { value: "5", label: "Very slow" },
    ],
    help: "Speed of plant growth.",
  }),
  zsand("PlantAbundance", "Wild plant abundance", "Survival", "enum", "3", {
    advanced: true,
    choices: [
      { value: "1", label: "Very poor" },
      { value: "2", label: "Poor" },
      { value: "3", label: "Normal" },
      { value: "4", label: "Abundant" },
      { value: "5", label: "Very abundant" },
    ],
    help: "Yield of plants when harvested.",
  }),
  zsand("NatureAbundance", "Nature abundance (fish/forage)", "Survival", "enum", "3", {
    advanced: true,
    choices: [
      { value: "1", label: "Very poor" },
      { value: "2", label: "Poor" },
      { value: "3", label: "Normal" },
      { value: "4", label: "Abundant" },
      { value: "5", label: "Very abundant" },
    ],
    help: "Abundance of fish and forageable items.",
  }),
  zsand("InjurySeverity", "Injury severity", "Survival", "enum", "2", {
    choices: [
      { value: "1", label: "Low" },
      { value: "2", label: "Normal" },
      { value: "3", label: "High" },
    ],
    help: "Impact injuries have on the body, and how long they take to heal.",
  }),
  zsand("BoneFracture", "Bone fractures", "Survival", "bool", true, {
    advanced: true,
    help: "Survivors can break limbs from impacts, zombie damage and falls.",
  }),
  zsand("MultiHitZombies", "Multi-hit melee", "Survival", "bool", false, {
    help: "Melee swings can hit multiple zombies (the big difficulty lever).",
  }),
  zsand("RearVulnerability", "Rear vulnerability", "Survival", "enum", "3", {
    advanced: true,
    choices: [
      { value: "1", label: "Low" },
      { value: "2", label: "Medium" },
      { value: "3", label: "High" },
    ],
    help: "Chance of being bitten when attacked from behind.",
  }),
  zsand("CharacterFreePoints", "Free trait points", "Survival", "int", 0, {
    min: -100,
    max: 100,
    advanced: true,
    help: "Extra trait points at character creation (negative = handicap).",
  }),
  zsand("StarterKit", "Starter kit", "Survival", "bool", false, {
    advanced: true,
    help: "Spawn with a small bag of basics (bat, water bottle, food, bandages).",
  }),
  zsand("HoursForCorpseRemoval", "Corpse removal after", "Survival", "float", 216, {
    min: -1,
    max: 8760,
    step: 1,
    unit: "hours",
    advanced: true,
    help: "In-game hours before zombie corpses despawn. -1 = never.",
  }),

  // ── Vehicles ──────────────────────────────────────────────────────────────────
  zsand("EnableVehicles", "Vehicles enabled", "Vehicles", "bool", true, {
    help: "Vehicles spawn on the map.",
  }),
  zsand("CarSpawnRate", "Car spawn rate", "Vehicles", "enum", "3", {
    choices: [
      { value: "1", label: "None" },
      { value: "2", label: "Very low" },
      { value: "3", label: "Low" },
      { value: "4", label: "Normal" },
      { value: "5", label: "High" },
    ],
    help: "How often vehicles are found on the map.",
  }),
  zsand("ChanceHasGas", "Chance cars have gas", "Vehicles", "enum", "1", {
    choices: [
      { value: "1", label: "Low" },
      { value: "2", label: "Normal" },
      { value: "3", label: "High" },
    ],
    help: "Chance a discovered vehicle has gas in its tank.",
  }),
  zsand("InitialGas", "Gas amount in cars", "Vehicles", "enum", "2", {
    advanced: true,
    choices: [
      { value: "1", label: "Very low" },
      { value: "2", label: "Low" },
      { value: "3", label: "Normal" },
      { value: "4", label: "High" },
      { value: "5", label: "Full" },
    ],
    help: "How full the gas tanks of discovered vehicles are.",
  }),
  zsand("FuelStationGas", "Gas station reserves", "Vehicles", "enum", "5", {
    advanced: true,
    choices: [
      { value: "1", label: "Empty" },
      { value: "2", label: "Super low" },
      { value: "3", label: "Very low" },
      { value: "4", label: "Low" },
      { value: "5", label: "Normal" },
      { value: "6", label: "High" },
      { value: "7", label: "Very high" },
      { value: "8", label: "Full" },
    ],
    help: "How full fuel station tanks start out.",
  }),
  zsand("CarGasConsumption", "Fuel consumption", "Vehicles", "float", 1.0, {
    min: 0,
    max: 100,
    step: 0.1,
    unit: "×",
    advanced: true,
    help: "How gas-hungry vehicles are.",
  }),
  zsand("CarGeneralCondition", "Car condition", "Vehicles", "enum", "2", {
    choices: [
      { value: "1", label: "Very low" },
      { value: "2", label: "Low" },
      { value: "3", label: "Normal" },
      { value: "4", label: "High" },
      { value: "5", label: "Very high" },
    ],
    help: "General condition of vehicles found on the map.",
  }),
  zsand("LockedCar", "Locked cars", "Vehicles", "enum", "3", {
    advanced: true,
    choices: [
      { value: "1", label: "Never" },
      { value: "2", label: "Extremely rare" },
      { value: "3", label: "Rare" },
      { value: "4", label: "Sometimes" },
      { value: "5", label: "Often" },
      { value: "6", label: "Very often" },
    ],
    help: "How likely cars are to be locked.",
  }),
  zsand("CarAlarm", "Car alarms", "Vehicles", "enum", "2", {
    advanced: true,
    choices: [
      { value: "1", label: "Never" },
      { value: "2", label: "Extremely rare" },
      { value: "3", label: "Rare" },
      { value: "4", label: "Sometimes" },
      { value: "5", label: "Often" },
      { value: "6", label: "Very often" },
    ],
    help: "How often discovered vehicles have active alarms.",
  }),
  zsand("TrafficJam", "Traffic jams", "Vehicles", "bool", true, {
    advanced: true,
    help: "Spawn road-blocking vehicle pile-ups.",
  }),
  zsand("PlayerDamageFromCrash", "Crash damage to players", "Vehicles", "bool", true, {
    advanced: true,
    help: "Players can be injured in car accidents.",
  }),
  zsand("SirenShutoffHours", "Siren shutoff", "Vehicles", "float", 0, {
    min: 0,
    max: 168,
    step: 1,
    unit: "hours",
    advanced: true,
    help: "Hours before a wailing car siren dies. 0 = only when the battery drains.",
  }),
  zsand("VehicleEasyUse", "Easy vehicle use", "Vehicles", "bool", false, {
    advanced: true,
    help: "No keys needed, unlimited gas, no damage.",
  }),

  // ── Network / visibility (env) ────────────────────────────────────────────────
  zset("PUBLIC", "Public server list", "Network", "bool", false, {
    help: "Advertise the server on the in-game public server browser. LAN/direct-connect players can join either way.",
  }),
  zset("STEAMVAC", "Steam VAC", "Network", "bool", true, {
    help: "Valve Anti-Cheat protection for the server.",
  }),
  zset("NOSTEAM", "Allow non-Steam clients", "Network", "bool", false, {
    help: "Run in non-Steam mode so non-Steam copies can join. Disables Workshop mod auto-download for clients.",
  }),

  // ── Performance (env) ─────────────────────────────────────────────────────────
  zset("MEMORY", "Java heap size", "Performance", "string", "4096m", {
    help: "JVM max heap (e.g. 2048m, 4096m, 8g). Raise for many players/mods; keep below the container RAM limit.",
  }),
];

export const ZOMBOID_CATALOG: SettingsCatalog = { game: Game.ZOMBOID, version: "2", settings };
