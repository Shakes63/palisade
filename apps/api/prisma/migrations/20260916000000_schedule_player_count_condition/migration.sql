-- Gate any scheduled action on the live player count (GH #97): a firing is skipped
-- unless the number of players online is at least "minPlayersOnline" and at most
-- "maxPlayersOnline". NULL = unbounded on that side.
--
-- This replaces "skipIfPlayersOnline", which was the same condition hardcoded to
-- "at most 0". Keeping both would leave the schedule form with two controls that
-- mean the same thing, so the flag is folded into the condition and dropped. The
-- carry-over is restricted to the actions the old flag actually gated — the guard
-- ran only for disruptive ones, so a backup/start/announce/command row with the
-- flag set fired regardless of players and must keep doing so.
--
-- Dropping a column on SQLite means rebuilding the table, so the carry-over rides
-- along in the copy.

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Schedule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "serverId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "cron" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "command" TEXT,
    "warnMinutes" INTEGER NOT NULL DEFAULT 10,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "minPlayersOnline" INTEGER,
    "maxPlayersOnline" INTEGER,
    "lastRunAt" DATETIME,
    "runAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Schedule_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Schedule" ("id", "serverId", "name", "cron", "action", "command", "warnMinutes", "enabled", "minPlayersOnline", "maxPlayersOnline", "lastRunAt", "runAt", "createdAt")
SELECT
    "id",
    "serverId",
    "name",
    "cron",
    "action",
    "command",
    "warnMinutes",
    "enabled",
    NULL,
    CASE
        WHEN "skipIfPlayersOnline"
         AND "action" IN ('restart', 'update', 'update-if-available', 'update-mods', 'stop')
        THEN 0
        ELSE NULL
    END,
    "lastRunAt",
    "runAt",
    "createdAt"
FROM "Schedule";
DROP TABLE "Schedule";
ALTER TABLE "new_Schedule" RENAME TO "Schedule";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
