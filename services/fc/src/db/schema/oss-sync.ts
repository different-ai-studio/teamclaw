import {
  pgTable,
  uuid,
  text,
  boolean,
  bigint,
  integer,
  timestamp,
  primaryKey,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { teams } from "./teams.js";
import { actors } from "./teams.js";

// ===========================================================================
// amuxc_blobs: content-addressed blob registry, per-team isolated
// ===========================================================================
export const amuxcBlobs = pgTable(
  "amuxc_blobs",
  {
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    contentHash: text("content_hash").notNull(),
    ossKey: text("oss_key").notNull(),
    size: bigint("size", { mode: "number" }).notNull(),
    verified: boolean("verified").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.teamId, t.contentHash] }),
    verifiedCreatedIdx: index("idx_amuxc_blobs_verified_created")
      .on(t.createdAt)
      .where(sql`verified = false`),
  })
);

// ===========================================================================
// amuxc_files: current pointer per path
// ===========================================================================
export const amuxcFiles = pgTable(
  "amuxc_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    currentVersion: integer("current_version").notNull().default(0),
    contentHash: text("content_hash"),
    size: bigint("size", { mode: "number" }).notNull().default(0),
    deleted: boolean("deleted").notNull().default(false),
    changeSeq: bigint("change_seq", { mode: "number" }).notNull().default(0),
    rowVersion: integer("row_version").notNull().default(0),
    updatedBy: uuid("updated_by")
      .notNull()
      .references(() => actors.id, { onDelete: "restrict" }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pathUniq: uniqueIndex("uniq_amuxc_path").on(t.teamId, t.path),
    teamUpdatedIdx: index("idx_amuxc_files_team_updated").on(
      t.teamId,
      t.updatedAt
    ),
    teamSeqIdx: index("idx_amuxc_files_team_seq").on(t.teamId, t.changeSeq),
  })
);

// ===========================================================================
// amuxc_file_versions: append-only history
// ===========================================================================
export const amuxcFileVersions = pgTable(
  "amuxc_file_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fileId: uuid("file_id")
      .notNull()
      .references(() => amuxcFiles.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    parentVersion: integer("parent_version").notNull(),
    contentHash: text("content_hash"),
    size: bigint("size", { mode: "number" }).notNull().default(0),
    deleted: boolean("deleted").notNull().default(false),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => actors.id, { onDelete: "restrict" }),
    createdByNodeId: text("created_by_node_id"),
    message: text("message"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    fileVersionUniq: uniqueIndex("uniq_amuxc_file_version").on(
      t.fileId,
      t.version
    ),
    fileVersionIdx: index("idx_amuxc_file_versions_file").on(
      t.fileId,
      t.version
    ),
  })
);

// ===========================================================================
// amuxc_upload_sessions: prepare/complete bridge
// ===========================================================================
export const amuxcUploadSessions = pgTable(
  "amuxc_upload_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => actors.id, { onDelete: "cascade" }),
    nodeId: text("node_id"),
    path: text("path").notNull(),
    parentVersion: integer("parent_version").notNull(),
    contentHash: text("content_hash").notNull(),
    size: bigint("size", { mode: "number" }).notNull(),
    ossKey: text("oss_key").notNull(),
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    expiresIdx: index("idx_amuxc_sessions_expires").on(t.expiresAt),
    teamStatusIdx: index("idx_amuxc_sessions_team_status").on(
      t.teamId,
      t.status
    ),
  })
);

// ===========================================================================
// push_idempotency: dispatch dedup key
// ===========================================================================
export const pushIdempotency = pgTable("push_idempotency", {
  messageId: uuid("message_id").primaryKey(),
  claimedAt: timestamp("claimed_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
