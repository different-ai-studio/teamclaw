import { pgTable, uuid, text, timestamp, bigint, smallint, integer, numeric, uniqueIndex } from "drizzle-orm/pg-core";
import { teams } from "./teams.js";
import { actors } from "./teams.js";
import { sessions } from "./sessions.js";

export const actorMessageFeedback = pgTable("actor_message_feedback", {
  id: uuid("id").primaryKey().defaultRandom(),
  actorId: uuid("actor_id").notNull().references(() => actors.id, { onDelete: "cascade" }),
  teamId: uuid("team_id").notNull().references(() => teams.id, { onDelete: "cascade" }),
  sessionId: uuid("session_id").references(() => sessions.id, { onDelete: "set null" }),
  messageId: uuid("message_id"),
  kind: text("kind").notNull(),
  starRating: smallint("star_rating"),
  skill: text("skill"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const actorSessionReport = pgTable("actor_session_report", {
  id: uuid("id").primaryKey().defaultRandom(),
  actorId: uuid("actor_id").notNull().references(() => actors.id, { onDelete: "cascade" }),
  teamId: uuid("team_id").notNull().references(() => teams.id, { onDelete: "cascade" }),
  sessionId: uuid("session_id").references(() => sessions.id, { onDelete: "set null" }),
  tokensUsed: bigint("tokens_used", { mode: "number" }).notNull().default(0),
  costUsd: numeric("cost_usd", { precision: 12, scale: 4 }).notNull().default("0"),
  model: text("model"),
  agentKind: text("agent_kind"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
});

export const actorSkillUsage = pgTable("actor_skill_usage", {
  id: uuid("id").primaryKey().defaultRandom(),
  actorId: uuid("actor_id").notNull().references(() => actors.id, { onDelete: "cascade" }),
  teamId: uuid("team_id").notNull().references(() => teams.id, { onDelete: "cascade" }),
  sessionId: uuid("session_id").references(() => sessions.id, { onDelete: "set null" }),
  skill: text("skill").notNull(),
  count: integer("count").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const actorClientVersions = pgTable(
  "actor_client_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => actors.id, { onDelete: "cascade" }),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    clientType: text("client_type").notNull(), // tauri | ios | expo | daemon
    deviceId: text("device_id").notNull(),
    version: text("version").notNull(),
    build: text("build"),
    lastReportedAt: timestamp("last_reported_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    uniq: uniqueIndex("actor_client_versions_actor_client_device_idx").on(
      t.actorId,
      t.clientType,
      t.deviceId,
    ),
  }),
);
