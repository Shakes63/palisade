-- Add custom environment variables column (JSON array of {key, value} pairs)
ALTER TABLE "Server" ADD COLUMN "extraEnvJson" TEXT NOT NULL DEFAULT '[]';
