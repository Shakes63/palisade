-- Store the last crash's container exit reason (exit code + log tail) for the UI.
ALTER TABLE "Server" ADD COLUMN "crashReason" TEXT;
