import { describe, it, expect } from "vitest";
import { pickServerContainer } from "./docker.service";

// Endpoint resolution (GH #21) inspects this container for its live IP, so picking a
// stopped one would resolve to no address at all.
describe("pickServerContainer", () => {
  it("prefers the running container over a stopped one carrying the same label", () => {
    // Adoption leaves the original stopped, so both can match the ark.serverId label.
    expect(
      pickServerContainer([
        { Id: "old", State: "exited" },
        { Id: "live", State: "running" },
      ]),
    ).toBe("live");
  });

  it("falls back to the only container when none is running", () => {
    // A stopped server still needs an id for non-networking callers.
    expect(pickServerContainer([{ Id: "stopped", State: "exited" }])).toBe("stopped");
  });

  it("returns null when nothing is labelled for the server", () => {
    expect(pickServerContainer([])).toBeNull();
  });
});
