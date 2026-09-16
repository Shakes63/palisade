-- RCON payload for the "announce" and "command" schedule actions (GH #78).
-- NULL for every existing schedule: the other actions carry no payload.
ALTER TABLE "Schedule" ADD COLUMN "command" TEXT;
