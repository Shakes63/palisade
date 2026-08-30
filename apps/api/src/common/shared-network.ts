import { DEFAULT_SHARED_NETWORK, LEGACY_NETWORK } from "./naming";

/**
 * Which Docker network the manager and its game containers meet on, while the
 * pre-1.11 "ark-net" installs migrate off it.
 *
 * The rules are deliberately one-way and boring: every NEW container goes on the
 * target network, the manager holds an endpoint on both for as long as anything
 * still needs the old one, and the old endpoint is dropped only when nothing can
 * possibly be depending on it. A half-migrated install keeps working the whole
 * time, because endpoint resolution reads each container's real networking rather
 * than assuming a name (common/game-endpoint.ts).
 */
export interface NetworkPlanInput {
  /** SHARED_NETWORK override. Blank/absent means the default. */
  override?: string | null;
  /** Networks the manager container is currently attached to. */
  managerNetworks: string[];
  /** Managed game containers (any state) still attached to the legacy network. */
  legacyServers: number;
  /** A container that isn't one of ours sits on the legacy network — most likely a
   *  socket-proxy, which the docs used to tell people to put there. */
  otherOnLegacy: boolean;
  /** Docker is reached over TCP (a socket-proxy) rather than the mounted socket. */
  dockerViaProxy: boolean;
}

/** Where new game containers are attached. Fixed per install, so a start never has
 *  to guess and two servers created minutes apart always land together. */
export function targetNetwork(override?: string | null): string {
  return (override ?? "").trim() || DEFAULT_SHARED_NETWORK;
}

/**
 * Whether two Docker container ids refer to the same container.
 *
 * Docker hands back ids at different lengths depending on which API you ask:
 * `network inspect` returns the full 64-char id, while a container's own hostname —
 * which is how the manager identifies itself — is the 12-char short form. A plain
 * `===` therefore made the manager count ITSELF as a stranger on the legacy network,
 * which both raised a bogus warning and blocked the migration from ever finishing.
 */
export function sameContainerId(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const n = Math.min(a.length, b.length);
  return a.slice(0, n) === b.slice(0, n);
}

/** True when Docker is fronted by a proxy rather than the mounted unix socket. */
export function dockerViaProxy(dockerHost: string): boolean {
  return !/^unix:\/\//i.test(dockerHost.trim());
}

/**
 * Whether anything could still depend on the legacy network. Any doubt counts as
 * yes: leaving a spare endpoint attached costs nothing, while dropping one that a
 * socket-proxy was answering on would cut the manager off from Docker entirely.
 */
export function legacyStillNeeded(i: NetworkPlanInput): boolean {
  return i.legacyServers > 0 || i.otherOnLegacy || i.dockerViaProxy;
}

/**
 * Whether the manager can now drop its legacy endpoint — the step that actually
 * fixes Unraid's WebUI link, since it leaves the LAN network sorting first again
 * (see DEFAULT_SHARED_NETWORK). Never strands the manager: it only lets go of the
 * old network once it is holding the new one.
 */
export function shouldLeaveLegacy(i: NetworkPlanInput): boolean {
  if (targetNetwork(i.override) === LEGACY_NETWORK) return false;
  if (!i.managerNetworks.includes(LEGACY_NETWORK)) return false;
  if (!i.managerNetworks.includes(targetNetwork(i.override))) return false;
  return !legacyStillNeeded(i);
}

/**
 * Admin-facing progress note while both networks are in play, or null when there is
 * nothing to say. Every case here resolves itself through normal use, so the note
 * says what to do rather than what went wrong.
 */
export function legacyMigrationNote(i: NetworkPlanInput): string | null {
  const target = targetNetwork(i.override);
  if (target === LEGACY_NETWORK) return null;
  if (!i.managerNetworks.includes(LEGACY_NETWORK)) return null;

  if (i.legacyServers > 0) {
    const n = i.legacyServers;
    return (
      `${n} server${n === 1 ? "" : "s"} still run${n === 1 ? "s" : ""} on the old "${LEGACY_NETWORK}" ` +
      `Docker network. Restarting ${n === 1 ? "it" : "each of them"} moves ${n === 1 ? "it" : "them"} to ` +
      `"${target}"; nothing else is needed, and Palisade stays attached to both networks until ` +
      `${n === 1 ? "it has" : "they all have"}. On Unraid, finishing this also restores the Palisade ` +
      `container's WebUI link if you run it on a custom (br0/macvlan) network.`
    );
  }
  if (i.otherOnLegacy || i.dockerViaProxy) {
    return (
      `Every server has moved to the "${target}" Docker network, but Palisade is still attached to ` +
      `the old "${LEGACY_NETWORK}" one because another container is using it — usually a ` +
      `socket-proxy. Move that container to "${target}", then run: ` +
      `docker network disconnect ${LEGACY_NETWORK} <manager container>`
    );
  }
  return null;
}
