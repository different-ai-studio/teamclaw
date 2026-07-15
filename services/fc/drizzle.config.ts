import type { Config } from "drizzle-kit";

export default {
  schema: ["./src/db/schema/teams.ts", "./src/db/schema/auth.ts", "./src/db/schema/sessions.ts", "./src/db/schema/messages.ts", "./src/db/schema/workspaces.ts", "./src/db/schema/shortcuts.ts", "./src/db/schema/ideas.ts", "./src/db/schema/agents.ts", "./src/db/schema/runtime.ts", "./src/db/schema/notifications.ts", "./src/db/schema/presence.ts", "./src/db/schema/telemetry.ts", "./src/db/schema/oss-sync.ts", "./src/db/schema/apps.ts"],
  out: "./src/db/migrations",
  dialect: "postgresql",
} satisfies Config;
