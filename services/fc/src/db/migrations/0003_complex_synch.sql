ALTER TABLE "team_workspace_config" ADD COLUMN "default_workspace_id" uuid;--> statement-breakpoint
ALTER TABLE "team_workspace_config" ADD COLUMN "pinned_workspace_ids" jsonb DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "acp_session_id" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "binding" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "agent_id" uuid;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_team_binding_uniq" UNIQUE("team_id","binding");