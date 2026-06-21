// Known-benign Conan / Unreal-engine log spam. This denylist powers the "Hide
// engine noise" toggle in the Logs and Console views. Every pattern here is
// emitted by Funcom's shipped game data or the headless UE server on a normal run
// and is not actionable by a server admin. RCON command/response lines and real
// failures (crashes, fatal errors, our own markers) never match these.
const NOISE_PATTERNS: RegExp[] = [
  /LogDataTable: Warning: UDataTable::FindRow/,
  /USpawnTableLibrary::SpawnNPCFromWeightedTable/,
  /ABuildingBase::AddModule_Internal - Removing placed module/,
  /ABaseSpawner::TickSpawnBase - Failed to spawn module/,
  /is in an unsafe movement move .* while in AILOD/,
  /ThrallActorClass was not loaded when trying to SpawnThrall/,
  /Very long time between ticks/,
  /LogBinkMoviePlayer: Error: UBinkMediaPlayer::Open: Failed/,
  /ItemInventory: Error: Data: Mismatch/,
  /LogNavigation: Warning: NavData RegistrationFailed/,
  /LogGameTweakSystem: Warning:/,
  /IP2(Location|Proxy) library error/,
  /LogModuleManager: Module .* failed to load/,
  /LogStreaming: Warning: LoadPackage: SkipPackage/,
  /CDO Constructor .*: Failed to find/,
  /LogUObjectGlobals: (Warning|Error): Failed to find object/,
  /LogAnalytics: Display: CommonTelem/,
  /Forced to sync load MapData table/,
  /LogInterfaceIndex: Warning: Failed to resolve interface/,
  /Failed renaming the CrashReportClient/,
  /ILocalize::AddFile\(\) failed to load/,
  /xdg-user-dir: not found/,
  /sudo: unable to resolve host/,
  /steambootstrapper_english/,
  /LogConfig: Set CVar/,
];

/** True if a log line is known-benign engine noise (safe to hide). */
export function isEngineNoise(line: string): boolean {
  return NOISE_PATTERNS.some((re) => re.test(line));
}

/** Count how many of these lines are engine noise. */
export function countNoise(lines: string[]): number {
  let n = 0;
  for (const line of lines) if (isEngineNoise(line)) n++;
  return n;
}
