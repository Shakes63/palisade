import { z } from "zod";

/**
 * Validated process environment. Fails fast on boot if something required is
 * missing/misshapen, so we never run half-configured.
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  API_PORT: z.coerce.number().int().positive().default(8787),
  // Tolerant of a scheme-less value ("10.0.0.5:8970" → "http://10.0.0.5:8970") —
  // a common way to fill the Unraid field, and .url() alone would crash the boot.
  PUBLIC_BASE_URL: z.preprocess(
    (v) => (typeof v === "string" && v && !/^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? `http://${v}` : v),
    z.string().url().default("http://localhost:3000"),
  ),

  DATA_DIR: z.string().default("./data"),
  DATABASE_URL: z.string().default("file:./data/db.sqlite"),

  // The data dir as seen by the HOST Docker daemon. Bind mounts for spawned
  // game containers are resolved on the host, not inside the manager container,
  // so on Unraid this is e.g. /mnt/user/appdata/ark-manager. Defaults to DATA_DIR
  // for single-host/dev setups where the two paths coincide.
  HOST_DATA_DIR: z.string().optional(),

  // 32-byte hex key (64 chars). Required so secrets are never stored plaintext.
  SECRETS_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, "SECRETS_KEY must be 64 hex chars (32 bytes)"),
  JWT_SECRET: z.string().min(16, "JWT_SECRET must be at least 16 chars"),

  // Docker control. Defaults to the host's unix socket (mounted in); set a
  // tcp://socket-proxy:2375 here instead for least-privilege Docker access.
  DOCKER_HOST: z.string().default("unix:///var/run/docker.sock"),

  PUID: z.coerce.number().int().nonnegative().default(99),
  PGID: z.coerce.number().int().nonnegative().default(100),
  TZ: z.string().default("UTC"),

  // Run game-server containers on the host network instead of the ark-net
  // bridge. Removes the Docker NAT layer so ASA/EOS advertises the host's real
  // address (more reliable public/Unofficial listing + join). When on, the
  // manager reaches RCON via the host gateway, so it must be started with
  // `--add-host host.docker.internal:host-gateway`.
  //
  // This flag decides how containers are CREATED only. How the manager then
  // reaches them is read back off each container (common/game-endpoint.ts), so a
  // flag flipped after a container was created no longer strands RCON (GH #21).
  GAME_HOST_NETWORK: z
    .string()
    .default("false")
    .transform((v) => v === "true" || v === "1"),

  // Browsers reach the API same-origin through the Next rewrite proxy, so
  // cross-origin requests are denied by default. If you serve the web UI from a
  // different origin than the API, list the allowed origins here
  // (comma-separated, e.g. "https://panel.example.com").
  CORS_ORIGINS: z
    .string()
    .default("")
    .transform((v) =>
      v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
});

export type AppEnv = z.infer<typeof schema>;

let cached: AppEnv | undefined;

/** Drop the memoized env so the next loadEnv() re-reads process.env. Used at boot after
 *  HOST_DATA_DIR is auto-detected, since an import-time loadEnv() may have cached before. */
export function resetEnvCache(): void {
  cached = undefined;
}

export function loadEnv(): AppEnv {
  if (cached) return cached;
  // Unraid (and docker-compose) pass BLANK template fields as EMPTY STRINGS, not
  // absent vars. Zod .default()s only apply to undefined, so "" would skip them and
  // then crash stricter validators (PUBLIC_BASE_URL's .url() rejected "" and took the
  // whole boot down — GH #6). Treat empty/whitespace-only values as unset.
  const raw = Object.fromEntries(
    Object.entries(process.env).filter(([, v]) => typeof v === "string" && v.trim() !== ""),
  );
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}
