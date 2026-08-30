-- Per-server host-networking override. Null = follow the manager-wide setting,
-- which itself falls back to the GAME_HOST_NETWORK env var, so every existing
-- server keeps the behaviour its container was created with.
ALTER TABLE "Server" ADD COLUMN "hostNetwork" BOOLEAN;
