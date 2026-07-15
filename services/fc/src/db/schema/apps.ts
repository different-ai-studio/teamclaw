import { pgTable, uuid, text, timestamp, unique } from "drizzle-orm/pg-core";
import { teams } from "./teams.js";
import { actors, members } from "./teams.js";
import { workspaces } from "./workspaces.js";

export const apps = pgTable("apps", {
  id: uuid("id").primaryKey().defaultRandom(),
  teamId: uuid("team_id").notNull().references(() => teams.id, { onDelete: "cascade" }),
  createdByActorId: uuid("created_by_actor_id").notNull().references(() => actors.id, { onDelete: "restrict" }),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  type: text("type").notNull(),
  visibility: text("visibility").notNull().default("personal"),
  workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "set null" }),
  gitRemoteUrl: text("git_remote_url"),
  gitAuthKind: text("git_auth_kind"),
  provisionStatus: text("provision_status").notNull().default("pending"),
  provisionError: text("provision_error"),
  fcFunctionName: text("fc_function_name"),
  fcRegion: text("fc_region"),
  fcEndpoint: text("fc_endpoint"),
  fcStatus: text("fc_status"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  teamSlugUniq: unique("apps_team_slug_uniq").on(t.teamId, t.slug),
  workspaceUniq: unique("apps_workspace_uniq").on(t.workspaceId),
}));

export const appMemberAccess = pgTable("app_member_access", {
  id: uuid("id").primaryKey().defaultRandom(),
  appId: uuid("app_id").notNull().references(() => apps.id, { onDelete: "cascade" }),
  memberId: uuid("member_id").notNull().references(() => members.id, { onDelete: "cascade" }),
  permissionLevel: text("permission_level").notNull(),
  grantedByMemberId: uuid("granted_by_member_id").references(() => members.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  appMemberUniq: unique("app_member_access_app_member_uniq").on(t.appId, t.memberId),
}));
