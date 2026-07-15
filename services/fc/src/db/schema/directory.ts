import { pgView, uuid, text, timestamp } from "drizzle-orm/pg-core";

// actor_directory is a Postgres VIEW joining actors + members + team_members + agents.
// The DDL is hand-written into the migration (drizzle-kit does not emit VIEW DDL).
// The view is CALLER-INDEPENDENT: it exposes all actors (members + agents of all
// visibilities). Per-caller agent-visibility filtering happens in the repo query layer.
export const actorDirectory = pgView("actor_directory", {
  id: uuid("id"),
  teamId: uuid("team_id"),
  actorType: text("actor_type"),
  userId: text("user_id"),
  invitedByActorId: uuid("invited_by_actor_id"),
  displayName: text("display_name"),
  avatarUrl: text("avatar_url"),
  lastActiveAt: timestamp("last_active_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }),
  memberStatus: text("member_status"),
  teamRole: text("team_role"),
  agentTypes: text("agent_types"),
  defaultAgentType: text("default_agent_type"),
  defaultWorkspaceId: uuid("default_workspace_id"),
  agentVisibility: text("agent_visibility"),
  agentStatus: text("agent_status"),
  ownerMemberId: uuid("owner_member_id"),
}).existing();
