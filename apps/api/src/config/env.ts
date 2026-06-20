import { z } from "zod";

/**
 * Validated process environment. Fails fast on boot if something required is
 * missing/misshapen, so we never run half-configured.
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  API_PORT: z.coerce.number().int().positive().default(8787),
  PUBLIC_BASE_URL: z.string().url().default("http://localhost:3000"),

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
  // manager reaches RCON via the host gateway instead of the container name, so
  // the manager must be started with `--add-host host.docker.internal:host-gateway`.
  GAME_HOST_NETWORK: z
    .string()
    .default("false")
    .transform((v) => v === "true" || v === "1"),
});

export type AppEnv = z.infer<typeof schema>;

let cached: AppEnv | undefined;

export function loadEnv(): AppEnv {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}
