-- Per-user server/cluster access (GH #73). Existing users get restricted=false,
-- so nothing changes on upgrade until an admin restricts someone. Grants cascade
-- away with the user, server, or cluster they point at.
ALTER TABLE "User" ADD COLUMN "restricted" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "UserServerAccess" (
    "userId" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,

    PRIMARY KEY ("userId", "serverId"),
    CONSTRAINT "UserServerAccess_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "UserServerAccess_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "UserServerAccess_serverId_idx" ON "UserServerAccess"("serverId");

CREATE TABLE "UserClusterAccess" (
    "userId" TEXT NOT NULL,
    "clusterId" TEXT NOT NULL,

    PRIMARY KEY ("userId", "clusterId"),
    CONSTRAINT "UserClusterAccess_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "UserClusterAccess_clusterId_fkey" FOREIGN KEY ("clusterId") REFERENCES "Cluster" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "UserClusterAccess_clusterId_idx" ON "UserClusterAccess"("clusterId");
