/**
 * The address a PLAYER types into the game to reach this box (GH #88).
 *
 * The connect card used to assume it was whatever you had typed to reach the
 * panel. That only holds when the manager and the game servers answer on the
 * same address, which an Unraid install easily breaks: put the manager on a
 * custom/macvlan network and it gets its own LAN IP, while a host-networked
 * game server binds to the host's — so the card confidently hands out an
 * address nothing is listening on.
 *
 * Nothing in the Docker API reports the host's LAN IP to a container, so this
 * is resolved from what the operator has already told us, in descending order
 * of how sure we can be:
 *
 * 1. The explicit setting, if they set one. Always wins.
 * 2. The port-forward target IP for the router in use — the operator entered it
 *    to mean "the LAN IP the game servers bind on", which is this exact value.
 * 3. The host of PUBLIC_BASE_URL, which is at least an address they confirmed
 *    reaches this machine — unless it is a loopback address, which is what that
 *    variable defaults to and is never reachable from a player's machine.
 * 4. Null, and the UI keeps falling back to the browser's address bar.
 */
export interface ConnectHostInput {
  explicit?: string | null;
  router?: "pfsense" | "unifi" | "mikrotik";
  pfsenseTargetIp?: string | null;
  unifiTargetIp?: string | null;
  mikrotikTargetIp?: string | null;
  publicBaseUrl?: string | null;
}

export function resolveConnectHost(i: ConnectHostInput): string | null {
  const explicit = i.explicit?.trim();
  if (explicit) return explicit;

  const target = (
    i.router === "unifi" ? i.unifiTargetIp : i.router === "mikrotik" ? i.mikrotikTargetIp : i.pfsenseTargetIp
  )?.trim();
  if (target) return target;

  const base = hostOfUrl(i.publicBaseUrl);
  return base && !isLoopback(base) ? base : null;
}

/** Addresses that only mean anything on the box itself. PUBLIC_BASE_URL ships as
 *  http://localhost:3000, so an install that never set it would otherwise hand
 *  every player "localhost" — worse than the browser address the UI falls back
 *  to on its own. */
function isLoopback(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || h === "0.0.0.0" || /^127\./.test(h);
}

/** The hostname out of a base URL, tolerating a bare "10.0.0.5:8970" (which the
 *  URL parser would read as the "10.0.0.5" scheme) and anything unparseable. */
export function hostOfUrl(url: string | null | undefined): string | null {
  const raw = url?.trim();
  if (!raw) return null;
  try {
    const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
    return parsed.hostname || null;
  } catch {
    return null;
  }
}
