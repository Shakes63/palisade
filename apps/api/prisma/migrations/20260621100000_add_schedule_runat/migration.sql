-- One-time schedules: an absolute instant to fire once. NULL = recurring (cron).
ALTER TABLE "Schedule" ADD COLUMN "runAt" DATETIME;
