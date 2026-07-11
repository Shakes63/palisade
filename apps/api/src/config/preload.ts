import { ensureSecrets } from "./ensure-secrets";

/**
 * Import this FIRST in main.ts — before AppModule and anything else that can touch the
 * environment. Some modules call loadEnv() at import/decorator-evaluation time (e.g. the
 * realtime gateway's CORS option), which runs during the `require` phase, BEFORE the
 * bootstrap() body. So secret provisioning has to happen here, at module-load time, or
 * loadEnv would reject a blank install before we ever get a chance to generate the keys.
 *
 * Synchronous on purpose (no async work) so it completes fully before the next import.
 */
ensureSecrets();
