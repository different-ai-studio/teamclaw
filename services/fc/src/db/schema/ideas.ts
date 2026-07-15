import { pgTable, uuid, text, timestamp, boolean, integer, jsonb, unique } from "drizzle-orm/pg-core";
import { teams } from "./teams.js";
import { actors } from "./teams.js";

export const ideas = pgTable("ideas", {
  id: uuid("id").primaryKey().defaultRandom(),
  teamId: uuid("team_id").notNull().references(() => teams.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id"),
  parentIdeaId: uuid("parent_idea_id"),
  createdByActorId: uuid("created_by_actor_id").notNull().references(() => actors.id, { onDelete: "restrict" }),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  status: text("status").notNull(),
  archived: boolean("archived").notNull().default(false),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const ideaActivities = pgTable("idea_activities", {
  id: uuid("id").primaryKey().defaultRandom(),
  teamId: uuid("team_id").notNull().references(() => teams.id, { onDelete: "cascade" }),
  ideaId: uuid("idea_id").notNull().references(() => ideas.id, { onDelete: "cascade" }),
  actorId: uuid("actor_id").notNull().references(() => actors.id, { onDelete: "restrict" }),
  activityType: text("activity_type").notNull(),
  content: text("content").notNull().default(""),
  metadata: jsonb("metadata").notNull().default({}),
  attachmentUrls: text("attachment_urls").array().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
