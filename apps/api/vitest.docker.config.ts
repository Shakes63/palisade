import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const dir = fileURLToPath(new URL(".", import.meta.url));

/**
 * The integration tier: *.docker.test.ts, run against a REAL Docker daemon.
 *
 * The fast suite fakes Docker, and the fake is where several shipped bugs hid —
 * `docker network inspect` returning 64-char ids while the manager knew itself by
 * the 12-char hostname, the API JSON-sorting a container's network map, membership
 * that only lists live endpoints. Each was found on a real box after the unit tests
 * passed. This tier pins those facts against the daemon itself.
 *
 * Gated on PALISADE_DOCKER_TESTS=1 (each file checks) so it never runs uninvited.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@ark/shared": resolve(dir, "../../packages/shared/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.docker.test.ts"],
    // Real pulls, creates and inspects — nothing here is 5ms.
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // One file at a time: they share a daemon and clean up after themselves.
    fileParallelism: false,
  },
});
