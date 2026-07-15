import { pgTable, uuid, text, timestamp, jsonb, unique } from "drizzle-orm/pg-core";
import { actors, members } from "./teams.js";

export const agents = pgTable("agents", {
  id: uuid("id").primaryKey().references(() => actors.id, { onDelete: "cascade" }),
  defaultWorkspaceId: uuid("default_workspace_id"),
  createdByMemberId: uuid("created_by_member_id"),
  agentKind: text("agent_kind").notNull(),
  capabilities: jsonb("capabilities").notNull().default({}),
  status: text("status").notNull(),
  visibility: text("visibility").notNull().default("personal"),
  ownerMemberId: uuid("owner_member_id").references(() => members.id, { onDelete: "set null" }),
  agentTypes: jsonb("agent_types").notNull().default([]),
  defaultAgentType: text("default_agent_type"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const agentMemberAccess = pgTable("agent_member_access", {
  id: uuid("id").primaryKey().defaultRandom(),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  memberId: uuid("member_id").notNull().references(() => members.id, { onDelete: "cascade" }),
  permissionLevel: text("permission_level").notNull(),
  grantedByMemberId: uuid("granted_by_member_id").references(() => members.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  agentMemberUniq: unique("agent_member_access_agent_member_uniq").on(t.agentId, t.memberId),
}));
