import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const dir = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@ark/shared": resolve(dir, "../../packages/shared/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // The *.docker.test.ts tier talks to a real Docker daemon and is run separately
    // (`pnpm test:docker`, gated on PALISADE_DOCKER_TESTS=1) so the default suite
    // stays fast and never reaches for a developer's daemon uninvited.
    exclude: ["**/node_modules/**", "src/**/*.docker.test.ts"],
  },
});
