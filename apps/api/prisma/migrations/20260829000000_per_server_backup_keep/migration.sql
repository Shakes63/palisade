-- Per-server backup retention. Null = the built-in default.
ALTER TABLE "Server" ADD COLUMN "backupKeep" INTEGER;

-- Carry the old GLOBAL retention onto every existing server so nobody's effective
-- retention changes on upgrade. The global "backup_keep" setting is repurposed to
-- Palisade's own database backups, and is no longer read for game servers.
UPDATE "Server"
SET "backupKeep" = (
  SELECT CAST("value" AS INTEGER) FROM "ManagerSetting" WHERE "key" = 'backup_keep'
)
WHERE EXISTS (
  SELECT 1 FROM "ManagerSetting"
  WHERE "key" = 'backup_keep' AND CAST("value" AS INTEGER) >= 1
);
