-- Links a user to the OIDC identity that signs in as them. NULL for every
-- existing user: they keep signing in with their password.
ALTER TABLE "User" ADD COLUMN "hasPassword" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "User" ADD COLUMN "oidcIssuer" TEXT;
ALTER TABLE "User" ADD COLUMN "oidcSubject" TEXT;
CREATE UNIQUE INDEX "User_oidcIssuer_oidcSubject_key" ON "User"("oidcIssuer", "oidcSubject");
