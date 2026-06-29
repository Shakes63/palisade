import { describe, it, expect } from "vitest";
import { READY_RE } from "./servers.service";

// READY_RE flips a server to Running. ASA only becomes joinable at the
// "advertising for join" line — the earlier "has successfully started!" /
// "Full Startup:" markers fire ~30s before that and must NOT count as ready.
describe("READY_RE startup marker", () => {
  const REAL_ASA =
    "[2026.06.19-23.14.24:284][237]Server has completed startup and is now advertising for join. (10.19GB Mem)";
  const WAITING =
    "[INFO] Waiting for startup completion markers: 'Full Startup:' or 'Server has completed startup and is now advertising for join'";

  it("matches the real ASA 'advertising for join' completion line", () => {
    expect(READY_RE.test(REAL_ASA)).toBe(true);
  });

  it("does NOT flip on the early 'has successfully started!' line", () => {
    expect(READY_RE.test('[2026.06.20-21.18.11:312][ 12]Server: "E2E Test" has successfully started!')).toBe(
      false,
    );
  });

  it("does NOT flip on the early 'Full Startup:' line", () => {
    expect(READY_RE.test("[ 12]Full Startup: 112.34 seconds")).toBe(false);
  });

  it("does NOT match POK's 'Waiting for startup completion markers' line", () => {
    expect(READY_RE.test(WAITING)).toBe(false);
  });

  it("matches the hermsi/ASE 'server is up' line", () => {
    expect(READY_RE.test("[arkmanager] server is up")).toBe(true);
  });

  // Conan (acekorneya): the "Startup report" line fires once when startup
  // completes; the earlier RCON-ready / engine-init lines (~30s sooner) must not.
  const REAL_CONAN =
    "[2026.06.21-21.55.53:143][  0]LogServerStats: Startup report. StartupTime=36 Name=Krusty the Barbarian Map=ConanSandbox QueryPort=7779 Type=1 Region=1 MaxPlayers=70";

  it("matches the real Conan 'Startup report' completion line", () => {
    expect(READY_RE.test(REAL_CONAN)).toBe(true);
  });

  it("does NOT flip on Conan's earlier RCON-ready / engine-init lines", () => {
    expect(
      READY_RE.test("[  0]LogRcon: Display: Rcon is ready for client connections on 0.0.0.0:7780!"),
    ).toBe(false);
    expect(
      READY_RE.test("[  0]LogInit: Display: Engine is initialized. Leaving FEngineLoop::Init()"),
    ).toBe(false);
  });

  it("matches the real Palworld 'Running ... dedicated server' line", () => {
    expect(READY_RE.test("Running Palworld dedicated server on :7777")).toBe(true);
  });

  it("on a multi-line blob, is ready only once the advertising line appears", () => {
    const earlyBlob = `${WAITING}\nServer has successfully started!\nFull Startup: 112.34 seconds`;
    expect(READY_RE.test(earlyBlob)).toBe(false);
    expect(READY_RE.test(`${earlyBlob}\n${REAL_ASA}`)).toBe(true);
  });
});
