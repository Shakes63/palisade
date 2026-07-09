-- Per-game mod extras (JSON). Project Zomboid needs the in-game "Mod ID" names
-- (parsed from the Workshop description at install) alongside the Workshop id.
ALTER TABLE "Mod" ADD COLUMN "extra" TEXT;
