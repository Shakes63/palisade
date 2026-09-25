import { describe, it, expect } from "vitest";
import { hostOfUrl, resolveConnectHost } from "./connect-host";

describe("resolveConnectHost", () => {
  it("prefers what the operator typed", () => {
    expect(
      resolveConnectHost({
        explicit: "games.example.com",
        router: "unifi",
        unifiTargetIp: "10.0.0.5",
        publicBaseUrl: "http://10.0.0.9:8970",
      }),
    ).toBe("games.example.com");
  });

  it("falls back to the target IP of the router actually in use", () => {
    const all = { pfsenseTargetIp: "10.0.0.5", unifiTargetIp: "10.0.0.6", mikrotikTargetIp: "10.0.0.7" };
    expect(resolveConnectHost({ router: "pfsense", ...all })).toBe("10.0.0.5");
    expect(resolveConnectHost({ router: "unifi", ...all })).toBe("10.0.0.6");
    expect(resolveConnectHost({ router: "mikrotik", ...all })).toBe("10.0.0.7");
  });

  it("skips a router whose target IP was never filled in", () => {
    expect(
      resolveConnectHost({
        router: "unifi",
        unifiTargetIp: "  ",
        publicBaseUrl: "http://10.0.0.9:8970",
      }),
    ).toBe("10.0.0.9");
  });

  it("uses the base URL's host, not the whole URL", () => {
    expect(resolveConnectHost({ publicBaseUrl: "https://palisade.example.com/panel" })).toBe(
      "palisade.example.com",
    );
  });

  it("is null when nothing is configured, so the UI keeps its own fallback", () => {
    expect(resolveConnectHost({})).toBeNull();
    expect(resolveConnectHost({ explicit: "   ", publicBaseUrl: "" })).toBeNull();
  });

  it("refuses a loopback base URL — PUBLIC_BASE_URL ships as one", () => {
    // Handing a player "localhost" is worse than the browser address the UI
    // falls back to by itself, and this is the DEFAULT on an untouched install.
    expect(resolveConnectHost({ publicBaseUrl: "http://localhost:3000" })).toBeNull();
    expect(resolveConnectHost({ publicBaseUrl: "http://127.0.0.1:8970" })).toBeNull();
    expect(resolveConnectHost({ publicBaseUrl: "http://[::1]:8970" })).toBeNull();
    // A real address still wins over the browser's.
    expect(resolveConnectHost({ publicBaseUrl: "http://10.0.0.9:8970" })).toBe("10.0.0.9");
  });
});

describe("hostOfUrl", () => {
  it("reads a host out of the forms people actually paste", () => {
    expect(hostOfUrl("http://10.0.0.5:8970")).toBe("10.0.0.5");
    // No scheme: "10.0.0.5:8970" parses as a URL whose scheme is "10.0.0.5",
    // which would otherwise hand back an empty host.
    expect(hostOfUrl("10.0.0.5:8970")).toBe("10.0.0.5");
    expect(hostOfUrl("tower.local")).toBe("tower.local");
    expect(hostOfUrl("https://[2001:db8::1]:8970")).toBe("[2001:db8::1]");
  });

  it("is null for nothing, or for something that isn't a URL at all", () => {
    expect(hostOfUrl(null)).toBeNull();
    expect(hostOfUrl("")).toBeNull();
    expect(hostOfUrl("   ")).toBeNull();
    expect(hostOfUrl("http://")).toBeNull();
  });
});
