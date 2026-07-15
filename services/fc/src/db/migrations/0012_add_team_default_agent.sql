ALTER TABLE "teams" ADD COLUMN "default_agent_id" uuid
  REFERENCES "agents"("id") ON DELETE set null;
