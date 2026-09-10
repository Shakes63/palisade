import type { ForwardPort } from "../catalog/ports";

/** Which router product the port-forward integration talks to. */
export type RouterKind = "pfsense" | "unifi";
export const ROUTER_KINDS: readonly RouterKind[] = ["pfsense", "unifi"];
export const ROUTER_LABELS: Record<RouterKind, string> = { pfsense: "pfSense", unifi: "UniFi" };

/** One WAN forward as the router reports it, normalised across products. */
export interface RouterRule {
  /** The router's own id (pfSense numeric index, UniFi object id) as a string. */
  id: string;
  /** The rule's description / name on the router ("" when it has none). */
  name: string;
  /** "udp" | "tcp" | "both" (UniFi's tcp_udp). */
  proto: "udp" | "tcp" | "both";
  /** The WAN-side port spec as the router stores it: "7777", "7777,7778", "7777-7779". */
  ports: string;
  /** The LAN host the rule forwards to. */
  target: string;
  enabled: boolean;
}

/** What the port-forwards service needs from any router. Every client is
 *  constructed from already-validated settings and talks to exactly one box. */
export interface RouterClient {
  readonly kind: RouterKind;
  readonly host: string;
  readonly targetIp: string;
  /** Every WAN forward on the router. */
  list(): Promise<RouterRule[]>;
  /** The router's public address, or null when the router won't say. */
  wanIp(): Promise<string | null>;
  /** A one-line description of the box for the Settings "Test connection" button. */
  describe(): Promise<string>;
  create(f: ForwardPort, description: string): Promise<void>;
  /** Point an existing rule at this client's target IP. */
  retarget(rule: RouterRule, f: ForwardPort): Promise<void>;
  setEnabled(rule: RouterRule, enabled: boolean): Promise<void>;
  /** Delete a batch (the pfSense client orders these so ids don't shift mid-loop). */
  remove(rules: RouterRule[]): Promise<void>;
  /** Push pending changes live. pfSense needs an explicit apply; UniFi provisions on write. */
  commit(): Promise<void>;
}

/** Every rule Palisade creates is named with this prefix, which is how a later
 *  cleanup tells our rules apart from ones an admin made by hand. */
export const RULE_NAME_PREFIX = "Palisade - ";

/** Older builds named rules "ASM <server> — <port>"; still recognised as ours. */
const LEGACY_RULE_PREFIX = "ASM ";

/** "Palisade - <Game> - <server> - <port label>", capped at UniFi's 128-char
 *  name limit (pfSense descriptions have no practical limit). */
export function ruleName(gameLabel: string, serverName: string, portLabel: string): string {
  return `${RULE_NAME_PREFIX}${gameLabel} - ${serverName} - ${portLabel}`.slice(0, 128);
}

export function isPalisadeRule(rule: RouterRule): boolean {
  return rule.name.startsWith(RULE_NAME_PREFIX) || rule.name.startsWith(LEGACY_RULE_PREFIX);
}

/**
 * Whether a router's port spec covers one port. Routers store the WAN port as a
 * string that may be a single port, a comma list, or a range (pfSense uses
 * "a:b", UniFi "a-b"). Anything unparseable never matches, so a rule we don't
 * understand is left alone rather than edited.
 */
export function portSpecCovers(spec: string | number | undefined | null, port: number): boolean {
  if (spec === undefined || spec === null) return false;
  for (const part of String(spec).split(",")) {
    const p = part.trim();
    if (!p) continue;
    const range = p.match(/^(\d+)\s*[-:]\s*(\d+)$/);
    if (range) {
      const lo = Number(range[1]);
      const hi = Number(range[2]);
      if (port >= Math.min(lo, hi) && port <= Math.max(lo, hi)) return true;
      continue;
    }
    if (/^\d+$/.test(p) && Number(p) === port) return true;
  }
  return false;
}

/** A rule's protocol covers a forward's when they match or the rule is "both". */
export function protoCovers(rule: RouterRule["proto"], proto: ForwardPort["proto"]): boolean {
  return rule === "both" || rule === proto;
}
