-- Usernames compare case-insensitively, so "Magnus" and "magnus" are one name: the
-- column's NOCASE collation carries into the unique index and every lookup.
--
-- A collation change rebuilds the table. An install may already hold names that differ
-- only by case, which the new index would reject, so every one after the oldest gets its
-- own id as a suffix in the copy: ids are unique, so the renamed names are too. The copy
-- runs in one transaction, so a failure leaves the old table and its indexes in place.

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
BEGIN;
CREATE TABLE "new_User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "username" TEXT NOT NULL COLLATE NOCASE,
    "passwordHash" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'admin',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "tokenVersion" INTEGER NOT NULL DEFAULT 0,
    "restricted" BOOLEAN NOT NULL DEFAULT false,
    "hasPassword" BOOLEAN NOT NULL DEFAULT true,
    "oidcIssuer" TEXT,
    "oidcSubject" TEXT
);
INSERT INTO "new_User" ("id", "username", "passwordHash", "role", "createdAt", "updatedAt", "tokenVersion", "restricted", "hasPassword", "oidcIssuer", "oidcSubject")
SELECT
    "id",
    CASE
        WHEN EXISTS (
            SELECT 1 FROM "User" AS "older"
            WHERE "older"."username" = "User"."username" COLLATE NOCASE
              AND ("older"."createdAt" < "User"."createdAt"
                   OR ("older"."createdAt" = "User"."createdAt" AND "older"."id" < "User"."id"))
        )
        THEN "username" || '_' || "id"
        ELSE "username"
    END,
    "passwordHash",
    "role",
    "createdAt",
    "updatedAt",
    "tokenVersion",
    "restricted",
    "hasPassword",
    "oidcIssuer",
    "oidcSubject"
FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");
CREATE UNIQUE INDEX "User_oidcIssuer_oidcSubject_key" ON "User"("oidcIssuer", "oidcSubject");
COMMIT;
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
