import "dotenv/config";
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe, Logger } from "@nestjs/common";
import { AppModule } from "./app.module";
import { loadEnv } from "./config/env";
import { installProcessSafetyNet } from "./common/process-safety";

async function bootstrap() {
  // Guard against a single background error (a socket reset, a stray rejection)
  // taking the whole manager down — must be active before anything else runs.
  installProcessSafetyNet();
  const env = loadEnv();
  const app = await NestFactory.create(AppModule, { bufferLogs: false });

  app.setGlobalPrefix("api");
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }),
  );
  // LAN-first but reverse-proxy friendly: trust proxy + permissive CORS for the
  // co-located web app; tighten when exposed (PLANNING.md → Security posture).
  app.enableCors({ origin: true, credentials: true });

  await app.listen(env.API_PORT, "0.0.0.0");
  new Logger("Bootstrap").log(
    `ARK Server Manager API listening on :${env.API_PORT} (${env.NODE_ENV})`,
  );
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Fatal boot error:", err);
  process.exit(1);
});
