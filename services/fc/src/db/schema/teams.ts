import { pgEnum, pgTable, uuid, text, timestamp, boolean, bigint, uniqueIndex, unique, jsonb } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const teamShareMode = pgEnum("team_share_mode", ["oss", "managed_git", "custom_git"]);

export const teams = pgTable("teams", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  shareMode: teamShareMode("share_mode"),
  shareEnabledAt: timestamp("share_enabled_at", { withTimezone: true }),
  gitRemoteUrl: text("git_remote_url"),
  gitAuthKind: text("git_auth_kind"),
  gitCredentialRef: text("git_credential_ref"),
  // Team-wide default agent preference. FK to agents(id) with ON DELETE SET NULL
  // is declared in the migration SQL only (avoids a teams<->agents Drizzle import cycle).
  defaultAgentId: uuid("default_agent_id"),
  // Owning org id (betly/DEFAULT_ORG tenancy alignment). Nullable: the Postgres
  // backend has no org model yet, so first-team creation leaves this null.
  // When set to DEFAULT_ORG_ID, the team is a shared-tenant "personal" team and
  // cannot pull in members until the caller upgrades their account — mirrors the
  // supabase-repo createTeamInvite guard (upgrade_required).
  oid: uuid("oid"),
});

export const actors = pgTable("actors", {
  id: uuid("id").primaryKey().defaultRandom(),
  teamId: uuid("team_id").notNull().references(() => teams.id, { onDelete: "cascade" }),
  actorType: text("actor_type").notNull(),
  displayName: text("display_name").notNull(),
  lastActiveAt: timestamp("last_active_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  userId: text("user_id"),
  invitedByActorId: uuid("invited_by_actor_id"),
  avatarUrl: text("avatar_url"),
}, (t) => ({
  teamUserIdx: uniqueIndex("actors_team_user_idx").on(t.teamId, t.userId).where(sql`"user_id" IS NOT NULL`),
}));

export const members = pgTable("members", {
  id: uuid("id").primaryKey().references(() => actors.id, { onDelete: "cascade" }),
  status: text("status").notNull(),
  // Per-member preference: the agent this human actor wants pre-selected as their
  // default. The FK to agents(id) with ON DELETE SET NULL is declared in the
  // migration SQL (kept out of the Drizzle schema to avoid a teams<->agents
  // import cycle that drizzle-kit's resolver can't follow).
  defaultAgentId: uuid("default_agent_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const teamMembers = pgTable("team_members", {
  id: uuid("id").primaryKey().defaultRandom(),
  teamId: uuid("team_id").notNull().references(() => teams.id, { onDelete: "cascade" }),
  memberId: uuid("member_id").notNull().references(() => members.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  teamMemberUniq: uniqueIndex("team_members_team_member_uniq").on(t.teamId, t.memberId),
}));

export const teamInvites = pgTable("team_invites", {
  id: uuid("id").primaryKey().defaultRandom(),
  teamId: uuid("team_id").notNull().references(() => teams.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  kind: text("kind").notNull(),
  teamRole: text("team_role"),
  agentKind: text("agent_kind"),
  displayName: text("display_name").notNull(),
  invitedByActorId: uuid("invited_by_actor_id").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  consumedByActorId: uuid("consumed_by_actor_id"),
  targetActorId: uuid("target_actor_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const teamWorkspaceConfig = pgTable("team_workspace_config", {
  teamId: uuid("team_id").primaryKey().references(() => teams.id, { onDelete: "cascade" }),
  gitUrl: text("git_url"),
  gitBranch: text("git_branch"),
  gitToken: text("git_token"),
  aiGatewayEndpoint: text("ai_gateway_endpoint"),
  enabled: boolean("enabled").notNull().default(true),
  syncMode: text("sync_mode"),
  ossChangeSeq: bigint("oss_change_seq", { mode: "number" }).notNull().default(0),
  litellmTeamId: text("litellm_team_id"),
  llmEnabled: boolean("llm_enabled").notNull().default(false),
  llmBaseUrl: text("llm_base_url"),
  llmModels: jsonb("llm_models").$type<Array<{ id: string; name: string }>>().notNull().default([]),
  defaultWorkspaceId: uuid("default_workspace_id"),
  pinnedWorkspaceIds: jsonb("pinned_workspace_ids").$type<string[]>().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
