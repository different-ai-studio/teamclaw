-- Mirrors services/supabase/migrations/20260812120000_agents_device_identity.sql
-- (the columns only — the RPCs it also defines have no pg-backend counterpart;
-- pg-repo/agents.ts implements find/ensure-for-device in Drizzle instead).
--
-- src/db/schema/agents.ts has carried device_id / team_id since #895, but no
-- migration ever added them, so the pglite test database built from this
-- directory had neither column and every test that inserted an agent died with
-- `column "device_id" of relation "agents" does not exist`.
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "device_id" text;
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "team_id" uuid REFERENCES "teams"("id") ON DELETE CASCADE;
--> statement-breakpoint
-- One agent per machine per team. Partial: agents predating device-scoped
-- binding have device_id IS NULL and are not covered.
CREATE UNIQUE INDEX IF NOT EXISTS "agents_team_device_uk"
  ON "agents" ("team_id", "device_id") WHERE "device_id" IS NOT NULL;
