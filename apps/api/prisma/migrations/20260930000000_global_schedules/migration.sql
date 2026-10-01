-- Schedules that fire on several servers at once (GH #157).
-- CreateTable
CREATE TABLE "GlobalSchedule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "cron" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "command" TEXT,
    "warnMinutes" INTEGER NOT NULL DEFAULT 10,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "minPlayersOnline" INTEGER,
    "maxPlayersOnline" INTEGER,
    "allServers" BOOLEAN NOT NULL DEFAULT false,
    "staggerMinutes" INTEGER NOT NULL DEFAULT 0,
    "lastRunAt" DATETIME,
    "runAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "_GlobalScheduleToServer" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,
    CONSTRAINT "_GlobalScheduleToServer_A_fkey" FOREIGN KEY ("A") REFERENCES "GlobalSchedule" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "_GlobalScheduleToServer_B_fkey" FOREIGN KEY ("B") REFERENCES "Server" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "_GlobalScheduleToServer_AB_unique" ON "_GlobalScheduleToServer"("A", "B");

-- CreateIndex
CREATE INDEX "_GlobalScheduleToServer_B_index" ON "_GlobalScheduleToServer"("B");
