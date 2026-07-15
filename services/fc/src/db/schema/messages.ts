import { pgTable, uuid, text, timestamp, jsonb, bigint } from "drizzle-orm/pg-core";
import { teams } from "./teams.js";
import { actors } from "./teams.js";
import { sessions } from "./sessions.js";

export const messages = pgTable("messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  teamId: uuid("team_id").notNull().references(() => teams.id, { onDelete: "cascade" }),
  sessionId: uuid("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
  senderActorId: uuid("sender_actor_id"),
  replyToMessageId: uuid("reply_to_message_id"),
  kind: text("kind").notNull(),
  content: text("content").notNull(),
  metadata: jsonb("metadata").notNull().default({}),
  attachments: jsonb("attachments").notNull().default([]),
  model: text("model"),
  turnId: text("turn_id"),
  sequence: bigint("sequence", { mode: "number" }).notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
