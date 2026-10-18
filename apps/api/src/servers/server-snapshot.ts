import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LocalPaths } from "../common/paths";

/** The server's record, written on each start so adoption can rebuild it if the database is lost (GH #175). */
export const SNAPSHOT_FILE = "palisade-server.json";

export interface ServerSnapshot {
  version: 1;
  id: string;
  game: string;
  name: string;
  map: string;
  maxPlayers: number;
  gamePort: number;
  rawSocketPort: number;
  queryPort: number;
  rconPort: number;
  adminPasswordEnc: string | null;
  serverPasswordEnc: string | null;
  spectatorPasswordEnc: string | null;
  extraEnvEnc: string | null;
  configJson: string;
  modIds: string;
  artworkJson: string | null;
  imageTag: string | null;
  ramLimitMb: number | null;
  cpuLimit: number | null;
  backupKeep: number | null;
  hostNetwork: boolean | null;
  mods: Array<{
    source: string;
    remoteId: string;
    name: string;
    thumbnailUrl: string | null;
    extra: string | null;
    loadOrder: number;
    pinnedVersion: string | null;
    enabled: boolean;
  }>;
}

const MAX_SNAPSHOT_BYTES = 1024 * 1024;

function snapshotPath(serverId: string): string {
  return join(LocalPaths.instanceRoot(serverId), SNAPSHOT_FILE);
}

export async function writeServerSnapshot(serverId: string, snapshot: ServerSnapshot): Promise<void> {
  await mkdir(LocalPaths.instanceRoot(serverId), { recursive: true });
  // The game container can write here: a fresh exclusive file plus rename never follows its symlink.
  const tmp = `${snapshotPath(serverId)}.${randomBytes(6).toString("hex")}`;
  try {
    await writeFile(tmp, JSON.stringify(snapshot, null, 2), { mode: 0o600, flag: "wx" });
    await rename(tmp, snapshotPath(serverId));
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

/** The server's snapshot, or null when it has none or it isn't one we can read. */
export async function readServerSnapshot(serverId: string): Promise<ServerSnapshot | null> {
  // No symlink, FIFO or giant file the game container planted: any of those would hang or flood us.
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const handle = await open(snapshotPath(serverId), flags).catch(() => null);
  if (!handle) return null;
  try {
    if (!(await handle.stat()).isFile()) return null;
    // Bound what is read, not just the size stat reported: the file can grow in between.
    const buf = Buffer.alloc(MAX_SNAPSHOT_BYTES + 1);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    if (bytesRead > MAX_SNAPSHOT_BYTES) return null;
    const parsed = JSON.parse(buf.toString("utf8", 0, bytesRead)) as ServerSnapshot;
    return parsed?.version === 1 ? parsed : null;
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}
