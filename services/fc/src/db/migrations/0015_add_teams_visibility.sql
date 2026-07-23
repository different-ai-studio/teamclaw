ALTER TABLE "teams" ADD COLUMN IF NOT EXISTS "visibility" text NOT NULL DEFAULT 'private';
CREATE INDEX IF NOT EXISTS "idx_teams_default_org_public" ON "teams" ("oid") WHERE "visibility" = 'public';
