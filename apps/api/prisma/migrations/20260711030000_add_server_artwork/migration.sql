-- Per-server SteamGridDB art override (GameArtwork JSON); null = use game default.
ALTER TABLE "Server" ADD COLUMN "artworkJson" TEXT;
