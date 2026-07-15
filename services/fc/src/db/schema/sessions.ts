import { pgTable, uuid, text, timestamp, unique } from "drizzle-orm/pg-core";
import { teams } from "./teams.js";
import { actors } from "./teams.js";

export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  teamId: uuid("team_id").notNull().references(() => teams.id, { onDelete: "cascade" }),
  ideaId: uuid("idea_id"),
  createdByActorId: uuid("created_by_actor_id"),
  primaryAgentId: uuid("primary_agent_id"),
  appId: uuid("app_id"),
  mode: text("mode").notNull(),
  title: text("title").notNull(),
  summary: text("summary").notNull().default(""),
  lastMessagePreview: text("last_message_preview"),
  lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
  /** ACP / gateway integration: used by getSessionByAcp */
  acpSessionId: text("acp_session_id"),
  /** Gateway binding key (unique per team); used by ensureGatewaySession */
  binding: text("binding"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  teamBindingUniq: unique("sessions_team_binding_uniq").on(t.teamId, t.binding),
}));

export const sessionParticipants = pgTable("session_participants", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
  actorId: uuid("actor_id").notNull().references(() => actors.id, { onDelete: "cascade" }),
  role: text("role"),
  joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  sessionActorUniq: unique("session_participants_session_actor_uniq").on(t.sessionId, t.actorId),
}));

export const sessionReadMarkers = pgTable("session_read_markers", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
  actorId: uuid("actor_id").notNull().references(() => actors.id, { onDelete: "cascade" }),
  lastReadAt: timestamp("last_read_at", { withTimezone: true }).notNull().defaultNow(),
  lastReadMessageId: uuid("last_read_message_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  sessionActorUniq: unique("session_read_markers_session_actor_uniq").on(t.sessionId, t.actorId),
}));

export const sessionMutes = pgTable("session_mutes", {
  userId: text("user_id").notNull(),
  sessionId: uuid("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
  mutedAt: timestamp("muted_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pk: unique("session_mutes_pk").on(t.userId, t.sessionId),
}));
