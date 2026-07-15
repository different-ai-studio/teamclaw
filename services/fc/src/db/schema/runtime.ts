import { pgTable, uuid, text, timestamp, unique } from "drizzle-orm/pg-core";
import { teams } from "./teams.js";
import { agents } from "./agents.js";
import { sessions } from "./sessions.js";

export const agentRuntimes = pgTable("agent_runtimes", {
  id: uuid("id").primaryKey().defaultRandom(),
  teamId: uuid("team_id").notNull().references(() => teams.id, { onDelete: "cascade" }),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  sessionId: uuid("session_id").references(() => sessions.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id"),
  backendType: text("backend_type").notNull(),
  backendSessionId: text("backend_session_id"),
  runtimeId: text("runtime_id"),
  status: text("status").notNull(),
  currentModel: text("current_model"),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  lastProcessedMessageId: uuid("last_processed_message_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("agent_runtimes_agent_backend_uniq").on(t.agentId, t.backendSessionId),
]);
