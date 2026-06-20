-- Track whether settings changed after the running container was created, so the
-- UI can offer a Restart (to apply them) instead of a disabled Start button.
ALTER TABLE "Server" ADD COLUMN "configDirty" BOOLEAN NOT NULL DEFAULT false;
