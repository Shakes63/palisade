-- Debounces the player-count condition: a firing only counts it as met once it has
-- held for this many minutes. 0 for every existing schedule keeps today's behaviour.
ALTER TABLE "Schedule" ADD COLUMN "conditionHeldMinutes" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "GlobalSchedule" ADD COLUMN "conditionHeldMinutes" INTEGER NOT NULL DEFAULT 0;

-- The held window must start after the current run began. A server already running
-- at upgrade has no recorded start, so its run is counted from now.
ALTER TABLE "Server" ADD COLUMN "runningSince" DATETIME;
UPDATE "Server" SET "runningSince" = CURRENT_TIMESTAMP WHERE "state" = 'Running';
