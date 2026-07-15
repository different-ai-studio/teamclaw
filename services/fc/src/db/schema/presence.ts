import { pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";

export const clientPresence = pgTable("client_presence", {
  userId: text("user_id").notNull(),
  deviceId: text("device_id").notNull(),
  foregroundUntil: timestamp("foreground_until", { withTimezone: true }).notNull(),
}, (t) => ({
  pk: unique("client_presence_pk").on(t.userId, t.deviceId),
}));
