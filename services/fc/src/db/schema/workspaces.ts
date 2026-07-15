import { pgTable, uuid, text, timestamp, boolean, unique } from "drizzle-orm/pg-core";
import { teams } from "./teams.js";
import { members } from "./teams.js";

export const workspaces = pgTable("workspaces", {
  id: uuid("id").primaryKey().defaultRandom(),
  teamId: uuid("team_id").notNull().references(() => teams.id, { onDelete: "cascade" }),
  createdByMemberId: uuid("created_by_member_id").references(() => members.id, { onDelete: "set null" }),
  agentId: uuid("agent_id"),
  name: text("name").notNull(),
  path: text("path"),
  archived: boolean("archived").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  teamNameUniq: unique("workspaces_team_name_uniq").on(t.teamId, t.name),
}));
