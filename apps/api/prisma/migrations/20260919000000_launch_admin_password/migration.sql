-- The admin password the running container was created with, so RCON keeps
-- authenticating after a password change that hasn't been applied yet (GH #68).
-- NULL for every existing server: they fall back to the current password, which
-- is what they already dialled with, and the next start records the real value.
ALTER TABLE "Server" ADD COLUMN "launchAdminPasswordEnc" TEXT;
