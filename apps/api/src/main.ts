import "dotenv/config";
import "reflect-metadata";
// MUST precede AppModule: provisions SECRETS_KEY/JWT_SECRET before any module's
// import-time loadEnv() (e.g. the realtime gateway's CORS option) runs.
import "./config/preload";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe, Logger } from "@nestjs/common";
import helmet from "helmet";
import { AppModule } from "./app.module";
import { loadEnv, resetEnvCache } from "./config/env";
import { ensureHostDataDir } from "./config/ensure-host-data-dir";
import { installProcessSafetyNet } from "./common/process-safety";

async function bootstrap() {
  // Guard against a single background error (a socket reset, a stray rejection)
  // taking the whole manager down — must be active before anything else runs.
  installProcessSafetyNet();
  // Auto-detect HOST_DATA_DIR from our own /data mount if unset (best-effort, async).
  // An import-time loadEnv() may have already cached the env without it, so drop the
  // cache afterwards to force a fresh read that includes the detected path.
  await ensureHostDataDir();
  resetEnvCache();
  const env = loadEnv();
  const app = await NestFactory.create(AppModule, { bufferLogs: false });

  app.setGlobalPrefix("api");
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }),
  );
  // The API serves JSON, not pages — CSP would only constrain error responses,
  // and HSTS breaks plain-HTTP LAN setups, so both stay off.
  app.use(helmet({ contentSecurityPolicy: false, strictTransportSecurity: false }));
  // Browsers reach the API same-origin via the Next rewrite proxy, so
  // cross-origin is denied unless origins are explicitly allowed via CORS_ORIGINS.
  app.enableCors({
    origin: env.CORS_ORIGINS.length > 0 ? env.CORS_ORIGINS : false,
    credentials: true,
  });

  await app.listen(env.API_PORT, "0.0.0.0");
  new Logger("Bootstrap").log(
    `Palisade API listening on :${env.API_PORT} (${env.NODE_ENV})`,
  );
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Fatal boot error:", err);
  process.exit(1);
});
