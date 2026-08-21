import {
  pgTable,
  uuid,
  text,
  integer,
  bigint,
  jsonb,
  timestamp,
  boolean,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// Design: docs/architecture/skills-marketplace.md

export const marketplaceSkills = pgTable(
  "marketplace_skills",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull(),
    displayName: text("display_name").notNull(),
    publisher: text("publisher").notNull(),
    summary: text("summary").notNull(),
    category: text("category").notNull(),
    whenToUse: text("when_to_use").notNull().default(""),
    whenNotToUse: text("when_not_to_use").notNull().default(""),
    requires: jsonb("requires"),
    tags: text("tags").array().notNull().default([]),
    status: text("status").notNull().default("draft"),
    latestVersion: integer("latest_version").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    slugUniq: uniqueIndex("uniq_marketplace_skills_slug").on(t.slug),
    statusCategoryIdx: index("idx_marketplace_skills_status_category").on(t.status, t.category),
  }),
);

export const marketplaceSkillVersions = pgTable(
  "marketplace_skill_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    skillId: uuid("skill_id")
      .notNull()
      .references(() => marketplaceSkills.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    contentHash: text("content_hash").notNull(),
    size: bigint("size", { mode: "number" }).notNull().default(0),
    objectPath: text("object_path").notNull(),
    changelog: text("changelog").notNull(),
    summary: text("summary").notNull(),
    whenToUse: text("when_to_use").notNull().default(""),
    whenNotToUse: text("when_not_to_use").notNull().default(""),
    requires: jsonb("requires"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    skillVersionUniq: uniqueIndex("uniq_marketplace_skill_version").on(t.skillId, t.version),
    skillVersionIdx: index("idx_marketplace_skill_versions_skill").on(t.skillId, t.version),
  }),
);
