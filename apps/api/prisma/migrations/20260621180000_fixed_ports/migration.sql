-- Every server now shares one fixed port block (7777/7778/7779/7780) so a single
-- set of port-forwards covers whichever server is running (only one runs at a
-- time). Move all existing servers onto the shared block.
UPDATE "Server" SET "gamePort" = 7777, "rawSocketPort" = 7778, "queryPort" = 7779, "rconPort" = 7780;

-- Per-server port allocations are no longer used.
DELETE FROM "PortAllocation";
