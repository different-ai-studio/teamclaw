CREATE TABLE IF NOT EXISTS "actor_client_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"client_type" text NOT NULL,
	"device_id" text NOT NULL,
	"version" text NOT NULL,
	"build" text,
	"last_reported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "actor_client_versions" ADD CONSTRAINT "actor_client_versions_actor_id_actors_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "actor_client_versions" ADD CONSTRAINT "actor_client_versions_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "actor_client_versions_actor_client_device_idx" ON "actor_client_versions" USING btree ("actor_id","client_type","device_id");