import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { isPalisadeRule, isRouterHost, isTargetIp, portSpecCovers, protoCovers, ruleName } from "./router";
import { UpdateSettingsBody } from "../manager-settings/manager-settings.controller";
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

describe("ruleName / isPalisadeRule", () => {
  it("formats Source - Game - Server - port and caps at UniFi's 128-char limit", () => {
    expect(ruleName("Minecraft (Bedrock)", "test", "game (IPv4)")).toBe("Palisade - Minecraft (Bedrock) - test - game (IPv4)");
    expect(ruleName("Valheim", "x".repeat(200), "game")).toHaveLength(128);
  });

  it("recognises current and legacy Palisade rule names only", () => {
    const rule = { id: "1", proto: "udp" as const, ports: "1", target: "", enabled: true };
    expect(isPalisadeRule({ ...rule, name: "Palisade - Valheim - a - game" })).toBe(true);
    expect(isPalisadeRule({ ...rule, name: "ASM a — game" })).toBe(true);
    expect(isPalisadeRule({ ...rule, name: "Shooter Alarm" })).toBe(false);
    expect(isPalisadeRule({ ...rule, name: "" })).toBe(false);
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
    ).toEqual({
      id: "6aa2ba4a552cb06f99021735",
      name: "",
      proto: "both",
      ports: "27015",
      target: "10.0.0.5",
      enabled: true,
    });
  });

  it("treats a missing enabled flag as enabled and a missing target as empty", () => {
    expect(normalizeUnifiRule({ _id: "x", proto: "udp", dst_port: "1" })).toMatchObject({
      enabled: true,
      target: "",
      proto: "udp",
    });
  });
});

describe("isRouterHost", () => {
  it.each(["192.168.1.1", "pfsense", "pfsense.lan", "fd00::1", "", "  10.0.0.1  "])("pfSense accepts %j", (h) => {
    expect(isRouterHost(h, "pfsense")).toBe(true);
  });

  it.each(["not a host!!", "https://192.168.1.1", "192.168.1.1:443", "192.168.1.999", "foo_bar"])(
    "pfSense rejects %j (its client takes a bare host)",
    (h) => expect(isRouterHost(h, "pfsense")).toBe(false),
  );

  it.each(["192.168.1.1", "192.168.1.1:8443", "https://unifi.example.com/", "http://unifi:8443", "https://[fd00::1]:8443"])(
    "UniFi accepts %j",
    (h) => expect(isRouterHost(h, "unifi")).toBe(true),
  );

  it.each(["not a host!!", "ftp://unifi", "https://unifi/network", "https://user:pw@unifi", "unifi?x=1"])(
    "UniFi rejects %j",
    (h) => expect(isRouterHost(h, "unifi")).toBe(false),
  );

  it("is enforced on the settings body", () => {
    const errors = (body: object) => validateSync(plainToInstance(UpdateSettingsBody, body)).map((e) => e.property);
    expect(errors({ unifiHost: "not a host!!", pfsenseHost: "https://pfsense" })).toEqual(["pfsenseHost", "unifiHost"]);
    expect(errors({ unifiHost: "https://unifi:8443", pfsenseHost: "" })).toEqual([]);
  });
});

describe("isTargetIp", () => {
  it.each(["192.168.1.50", " 10.0.0.2 ", ""])("accepts %j", (v) => expect(isTargetIp(v)).toBe(true));

  it.each(["not an ip", "192.168.1.999", "192.168.1", "fd00::1", "server.lan", "192.168.1.50:80"])(
    "rejects %j",
    (v) => expect(isTargetIp(v)).toBe(false),
  );

  it("is enforced on the settings body", () => {
    const errors = (body: object) => validateSync(plainToInstance(UpdateSettingsBody, body)).map((e) => e.property);
    expect(errors({ pfsenseTargetIp: "nope", unifiTargetIp: "10.0.0.300" })).toEqual(["pfsenseTargetIp", "unifiTargetIp"]);
    expect(errors({ pfsenseTargetIp: "192.168.1.50", unifiTargetIp: "" })).toEqual([]);
  });
});
