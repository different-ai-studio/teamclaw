ALTER TABLE "team_workspace_config" ADD COLUMN "llm_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "team_workspace_config" ADD COLUMN "llm_base_url" text;--> statement-breakpoint
ALTER TABLE "team_workspace_config" ADD COLUMN "llm_models" jsonb DEFAULT '[]'::jsonb NOT NULL;