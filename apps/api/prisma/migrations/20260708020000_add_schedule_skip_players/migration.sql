-- Skip disruptive schedule actions (restart/update/stop) while players are online.
ALTER TABLE "Schedule" ADD COLUMN "skipIfPlayersOnline" BOOLEAN NOT NULL DEFAULT false;
