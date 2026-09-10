import { describe, expect, it } from "vitest";
import { portSpecCovers, protoCovers } from "./router";
import { normalizeUnifiRule, parseUnifiHost } from "./unifi.client";

describe("portSpecCovers", () => {
  it("matches a single port exactly", () => {
    expect(portSpecCovers("7777", 7777)).toBe(true);
    expect(portSpecCovers(7777, 7777)).toBe(true);
    expect(portSpecCovers("7778", 7777)).toBe(false);
    expect(portSpecCovers("77770", 7777)).toBe(false);
  });

  it("matches inside UniFi comma lists and ranges", () => {
    expect(portSpecCovers("2001,4001,7001", 4001)).toBe(true);
    expect(portSpecCovers("2001, 4001 ,7001", 7001)).toBe(true);
    expect(portSpecCovers("2001,4001,7001", 3001)).toBe(false);
    expect(portSpecCovers("7777-7779", 7778)).toBe(true);
    expect(portSpecCovers("7777-7779", 7780)).toBe(false);
  });

  it("matches inside pfSense colon ranges", () => {
    expect(portSpecCovers("7777:7779", 7779)).toBe(true);
    expect(portSpecCovers("7777:7779", 7776)).toBe(false);
  });

  it("never matches something it can't parse", () => {
    expect(portSpecCovers("", 7777)).toBe(false);
    expect(portSpecCovers(undefined, 7777)).toBe(false);
    expect(portSpecCovers("ark_ports", 7777)).toBe(false);
  });
});

describe("protoCovers", () => {
  it("treats a tcp+udp rule as covering either protocol", () => {
    expect(protoCovers("both", "udp")).toBe(true);
    expect(protoCovers("both", "tcp")).toBe(true);
    expect(protoCovers("udp", "udp")).toBe(true);
    expect(protoCovers("udp", "tcp")).toBe(false);
  });
});

describe("parseUnifiHost", () => {
  it("accepts a bare IP, host:port, and a full URL", () => {
    expect(parseUnifiHost("192.168.1.1")).toEqual({ hostname: "192.168.1.1", port: 443 });
    expect(parseUnifiHost(" 192.168.1.1:8443 ")).toEqual({ hostname: "192.168.1.1", port: 8443 });
    expect(parseUnifiHost("https://unifi.example.com/")).toEqual({ hostname: "unifi.example.com", port: 443 });
    expect(parseUnifiHost("https://unifi.example.com:8443/network")).toEqual({
      hostname: "unifi.example.com",
      port: 8443,
    });
  });
});

describe("normalizeUnifiRule", () => {
  it("maps UniFi's forward object onto the router-neutral rule", () => {
    expect(
      normalizeUnifiRule({
        _id: "6aa2ba4a552cb06f99021735",
        proto: "tcp_udp",
        dst_port: "27015",
        fwd: "10.0.0.5",
        fwd_port: "27015",
        enabled: true,
        pfwd_interface: "wan",
      }),
    ).toEqual({ id: "6aa2ba4a552cb06f99021735", proto: "both", ports: "27015", target: "10.0.0.5", enabled: true });
  });

  it("treats a missing enabled flag as enabled and a missing target as empty", () => {
    expect(normalizeUnifiRule({ _id: "x", proto: "udp", dst_port: "1" })).toMatchObject({
      enabled: true,
      target: "",
      proto: "udp",
    });
  });
});
