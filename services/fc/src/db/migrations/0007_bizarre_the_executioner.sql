DROP INDEX IF EXISTS "agents_device_id_idx";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN IF EXISTS "device_id";