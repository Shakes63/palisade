-- GH #39: Wine Palworld servers were allocated game port 8311, but the ripps818
-- image launches PalServer.exe with no -port= argument and has no way to pass one,
-- so the server always listens on Palworld's default 8211. The panel therefore
-- displayed, advertised and offered to forward a port nothing was bound to.
--
-- Move servers still sitting on the old fictional default onto the real port. A
-- server whose port was changed by hand is left alone: that is a deliberate choice,
-- and the start-time guard now explains the constraint rather than silently
-- overwriting it.
UPDATE "Server" SET "gamePort" = 8211 WHERE "game" = 'PALWORLD_WINE' AND "gamePort" = 8311;
