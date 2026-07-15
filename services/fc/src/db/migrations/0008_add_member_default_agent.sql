ALTER TABLE "members" ADD COLUMN "default_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_default_agent_id_agents_id_fk" FOREIGN KEY ("default_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
