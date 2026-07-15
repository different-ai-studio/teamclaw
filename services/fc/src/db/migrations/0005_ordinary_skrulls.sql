ALTER TABLE "agents" ADD COLUMN "device_id" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agents_device_id_idx" ON "agents" USING btree ("device_id");