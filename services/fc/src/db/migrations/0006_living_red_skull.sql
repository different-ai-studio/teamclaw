CREATE TABLE IF NOT EXISTS "amuxc_blobs" (
	"team_id" uuid NOT NULL,
	"content_hash" text NOT NULL,
	"oss_key" text NOT NULL,
	"size" bigint NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "amuxc_blobs_team_id_content_hash_pk" PRIMARY KEY("team_id","content_hash")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "amuxc_file_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"file_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"parent_version" integer NOT NULL,
	"content_hash" text,
	"size" bigint DEFAULT 0 NOT NULL,
	"deleted" boolean DEFAULT false NOT NULL,
	"created_by" uuid NOT NULL,
	"created_by_node_id" text,
	"message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "amuxc_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"path" text NOT NULL,
	"current_version" integer DEFAULT 0 NOT NULL,
	"content_hash" text,
	"size" bigint DEFAULT 0 NOT NULL,
	"deleted" boolean DEFAULT false NOT NULL,
	"change_seq" bigint DEFAULT 0 NOT NULL,
	"row_version" integer DEFAULT 0 NOT NULL,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "amuxc_upload_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"node_id" text,
	"path" text NOT NULL,
	"parent_version" integer NOT NULL,
	"content_hash" text NOT NULL,
	"size" bigint NOT NULL,
	"oss_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "push_idempotency" (
	"message_id" uuid PRIMARY KEY NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "amuxc_blobs" ADD CONSTRAINT "amuxc_blobs_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "amuxc_file_versions" ADD CONSTRAINT "amuxc_file_versions_file_id_amuxc_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."amuxc_files"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "amuxc_file_versions" ADD CONSTRAINT "amuxc_file_versions_created_by_actors_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."actors"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "amuxc_files" ADD CONSTRAINT "amuxc_files_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "amuxc_files" ADD CONSTRAINT "amuxc_files_updated_by_actors_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."actors"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "amuxc_upload_sessions" ADD CONSTRAINT "amuxc_upload_sessions_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "amuxc_upload_sessions" ADD CONSTRAINT "amuxc_upload_sessions_actor_id_actors_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_amuxc_blobs_verified_created" ON "amuxc_blobs" USING btree ("created_at") WHERE verified = false;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_amuxc_file_version" ON "amuxc_file_versions" USING btree ("file_id","version");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_amuxc_file_versions_file" ON "amuxc_file_versions" USING btree ("file_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_amuxc_path" ON "amuxc_files" USING btree ("team_id","path");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_amuxc_files_team_updated" ON "amuxc_files" USING btree ("team_id","updated_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_amuxc_files_team_seq" ON "amuxc_files" USING btree ("team_id","change_seq");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_amuxc_sessions_expires" ON "amuxc_upload_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_amuxc_sessions_team_status" ON "amuxc_upload_sessions" USING btree ("team_id","status");