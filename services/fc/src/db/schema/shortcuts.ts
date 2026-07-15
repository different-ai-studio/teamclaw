import { pgTable, uuid, text, timestamp, integer, unique } from "drizzle-orm/pg-core";
import { teams } from "./teams.js";
import { members } from "./teams.js";

export const teamRoles = pgTable("team_roles", {
  id: uuid("id").primaryKey().defaultRandom(),
  teamId: uuid("team_id").notNull().references(() => teams.id, { onDelete: "cascade" }),
  code: text("code").notNull(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  teamCodeUniq: unique("team_roles_team_code_uniq").on(t.teamId, t.code),
}));

export const teamMemberRoles = pgTable("team_member_roles", {
  id: uuid("id").primaryKey().defaultRandom(),
  teamId: uuid("team_id").notNull().references(() => teams.id, { onDelete: "cascade" }),
  memberId: uuid("member_id").notNull().references(() => members.id, { onDelete: "cascade" }),
  roleId: uuid("role_id").notNull().references(() => teamRoles.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  teamMemberRoleUniq: unique("team_member_roles_team_member_role_uniq").on(t.teamId, t.memberId, t.roleId),
}));

export const permissions = pgTable("permissions", {
  id: uuid("id").primaryKey().defaultRandom(),
  teamId: uuid("team_id").notNull().references(() => teams.id, { onDelete: "cascade" }),
  resourceType: text("resource_type").notNull(),
  resourceId: uuid("resource_id").notNull(),
  code: text("code").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  teamResourceUniq: unique("permissions_team_resource_uniq").on(t.teamId, t.resourceType, t.resourceId),
  teamCodeUniq: unique("permissions_team_code_uniq").on(t.teamId, t.code),
}));

export const permissionRoles = pgTable("permission_roles", {
  id: uuid("id").primaryKey().defaultRandom(),
  permissionId: uuid("permission_id").notNull().references(() => permissions.id, { onDelete: "cascade" }),
  roleId: uuid("role_id").notNull().references(() => teamRoles.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  permRoleUniq: unique("permission_roles_perm_role_uniq").on(t.permissionId, t.roleId),
}));

export const shortcuts = pgTable("shortcuts", {
  id: uuid("id").primaryKey().defaultRandom(),
  scope: text("scope").notNull(),
  ownerMemberId: uuid("owner_member_id").references(() => members.id, { onDelete: "cascade" }),
  teamId: uuid("team_id").references(() => teams.id, { onDelete: "cascade" }),
  parentId: uuid("parent_id"),
  label: text("label").notNull(),
  icon: text("icon"),
  order: integer("order").notNull().default(0),
  nodeType: text("node_type").notNull(),
  target: text("target").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
