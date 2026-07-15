import { pgTable, uuid, text, timestamp, boolean, smallint, unique } from "drizzle-orm/pg-core";

export const devicePushTokens = pgTable("device_push_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull(),
  deviceId: text("device_id").notNull(),
  platform: text("platform").notNull(),
  provider: text("provider").notNull(),
  token: text("token").notNull(),
  appVersion: text("app_version"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
}, (t) => ({
  userDeviceProviderUniq: unique("device_push_tokens_user_device_provider_uniq").on(t.userId, t.deviceId, t.provider),
}));

export const notificationPrefs = pgTable("notification_prefs", {
  userId: text("user_id").primaryKey(),
  enabled: boolean("enabled").notNull().default(true),
  dndStartMin: smallint("dnd_start_min"),
  dndEndMin: smallint("dnd_end_min"),
  dndTz: text("dnd_tz").notNull().default("Asia/Shanghai"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
