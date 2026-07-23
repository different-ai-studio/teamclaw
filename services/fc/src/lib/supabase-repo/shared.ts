// Shared helpers for the Supabase repository factories (business + auth),
// extracted from supabase-repo.ts so both can import them without a cycle.
import WebSocket from "ws";

import { ApiError } from "../http-utils.js";

// FC runtime is Node 20 which lacks native WebSocket. supabase-js v2.45+ tries
// to construct a RealtimeClient at createClient() time and throws without a
// transport. We never use Realtime in FC; pass `ws` so the construction
// succeeds. The transport is only opened lazily when realtime channels are
// subscribed, which we never do.
export const REALTIME_TRANSPORT_OPTS = { transport: WebSocket };

export function requiredRow(data, operation) {
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new ApiError(502, "upstream_unavailable", `${operation} returned no row`);
  return row;
}

export function requiredString(value, operation, field) {
  if (typeof value === "string" && value.length > 0) return value;
  throw new ApiError(502, "upstream_unavailable", `${operation} returned invalid ${field}`);
}

export function requiredInteger(value, operation, field) {
  if (Number.isInteger(value)) return value;
  throw new ApiError(502, "upstream_unavailable", `${operation} returned invalid ${field}`);
}

// ── Column constants + row mappers (moved from supabase-repo.ts) ──

export const DEFAULT_ATTACHMENT_BUCKET = "attachments";
export const TEAM_COLUMNS = "id, name, slug, created_at, visibility";
export const MESSAGE_COLUMNS =
  "id, team_id, session_id, turn_id, sender_actor_id, reply_to_message_id, kind, content, metadata, model, created_at, updated_at";
export const WORKSPACE_COLUMNS =
  "id, team_id, name, path, agent_id, created_by_member_id, archived, created_at, updated_at";

// Translate the SQLSTATE codes raised by get/set_member_default_agent into the
// same ApiError statuses pg-repo returns, so both backends behave identically.
// 42501 (insufficient privilege) -> 403; 23514 (check violation) -> 409;
// 23503 (foreign-key/not-found) -> 404. Anything else propagates unchanged.
export function mapDefaultAgentError(error: any) {
  switch (error?.code) {
    case "42501":
      return new ApiError(403, "forbidden", error.message ?? "forbidden");
    case "23514":
      return new ApiError(409, "invalid_agent", error.message ?? "invalid agent");
    case "23503":
      return new ApiError(404, "not_found", error.message ?? "not found");
    default:
      return error;
  }
}


// --- Apps helpers (mirror pg-repo/apps.ts) ---

export const APP_COLUMNS =
  "id, team_id, name, slug, type, visibility, workspace_id, git_remote_url, provision_status, fc_status, fc_endpoint, fc_function_name, fc_region, created_at, updated_at";

export function slugify(name: string): string {
  return (
    String(name)
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9一-龥]+/g, "-")
      .replace(/^-+|-+$/g, "") || "app"
  );
}

export const appIso = (v: any): string | null => (v ? new Date(v).toISOString() : null);

// Exposes EXACTLY the 12 canonical app fields. Reads snake_case DB columns
// (PostgREST returns the table's native column names).
export function mapApp(r: any) {
  return {
    id: r.id,
    teamId: r.team_id,
    name: r.name,
    slug: r.slug,
    type: r.type,
    visibility: r.visibility,
    workspaceId: r.workspace_id ?? null,
    gitRemoteUrl: r.git_remote_url ?? null,
    provisionStatus: r.provision_status,
    fcStatus: r.fc_status ?? null,
    fcEndpoint: r.fc_endpoint ?? null,
    fcFunctionName: r.fc_function_name ?? null,
    fcRegion: r.fc_region ?? null,
    createdAt: appIso(r.created_at)!,
    updatedAt: appIso(r.updated_at)!,
  };
}

export const SESSION_FULL_COLUMNS =
  "id, team_id, title, mode, idea_id, primary_agent_id, created_by_actor_id, summary, last_message_preview, last_message_at, acp_session_id, binding, created_at, updated_at";

export const ACTOR_DIRECTORY_COLUMNS =
  "id, team_id, actor_type, user_id, invited_by_actor_id, display_name, avatar_url, team_role, member_status, agent_status, agent_types, default_agent_type, default_workspace_id, agent_visibility, last_active_at, created_at, updated_at, user_email, user_phone";

export function mapSessionFull(row) {
  return {
    id: row?.id,
    teamId: row?.team_id ?? null,
    title: row?.title ?? "",
    mode: row?.mode ?? "solo",
    ideaId: row?.idea_id ?? null,
    primaryAgentId: row?.primary_agent_id ?? null,
    createdByActorId: row?.created_by_actor_id ?? null,
    summary: row?.summary ?? null,
    lastMessageAt: row?.last_message_at ?? null,
    lastMessagePreview: row?.last_message_preview ?? null,
    hasUnread: false,
    acpSessionId: row?.acp_session_id ?? null,
    binding: row?.binding ?? null,
    createdAt: row?.created_at ?? null,
    updatedAt: row?.updated_at ?? null,
  };
}

export function mapDirectoryActor(row) {
  return {
    id: row?.id,
    teamId: row?.team_id ?? null,
    kind: row?.actor_type ?? null,
    displayName: row?.display_name ?? null,
    avatarUrl: row?.avatar_url ?? null,
    userId: row?.user_id ?? null,
    invitedByActorId: row?.invited_by_actor_id ?? null,
    teamRole: row?.team_role ?? null,
    memberStatus: row?.member_status ?? null,
    agentStatus: row?.agent_status ?? null,
    agentTypes: row?.agent_types ?? null,
    agentKind: null,
    defaultAgentType: row?.default_agent_type ?? null,
    defaultWorkspaceId: row?.default_workspace_id ?? null,
    visibility: row?.agent_visibility ?? null,
    lastActiveAt: row?.last_active_at ?? null,
    createdAt: row?.created_at ?? null,
    updatedAt: row?.updated_at ?? null,
    // Member contact (null for agents/external and for anonymous accounts that
    // never set an email/phone). Surfaced via the actor_directory view's
    // SECURITY DEFINER contact join — only teammates ever receive these.
    email: row?.user_email ?? null,
    phone: row?.user_phone ?? null,
  };
}

export function publishableKeyFromEnv(env = process.env) {
  return env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY || "";
}

export function outgoingMessageRow(sessionId, input) {
  const row: any = {
    id: input.id,
    team_id: input.teamId,
    session_id: sessionId,
    sender_actor_id: input.senderActorId,
    kind: input.kind ?? "text",
    content: input.content,
    // Column is `jsonb not null default '{}'`. An explicit NULL bypasses the
    // default and trips the not-null constraint, so default to {} here (mirrors
    // the pg-repo backend). iOS sends no metadata when a message has no mentions.
    metadata: input.metadata ?? {},
    model: input.model ?? null,
    turn_id: input.turnId ?? null,
    reply_to_message_id: input.replyToMessageId ?? null,
  };
  if (input.createdAt) row.created_at = input.createdAt;
  return row;
}

export function mapTeam(row) {
  return {
    id: requiredString(row?.id, "teams.mapTeam", "id"),
    name: requiredString(row?.name, "teams.mapTeam", "name"),
    slug: row?.slug ?? null,
    createdAt: row?.created_at ?? null,
    orgId: row?.oid ?? null,
    orgName: (row?.orgs as any)?.name ?? null,
    shareMode: row?.share_mode ?? null,
    shareEnabledAt: row?.share_enabled_at ?? null,
    gitRemoteUrl: row?.git_remote_url ?? null,
    gitAuthKind: row?.git_auth_kind ?? null,
    visibility: row?.visibility ?? "private",
  };
}

export function mapSession(row) {
  return {
    id: requiredString(row?.id, "sessions.mapSession", "id"),
    teamId: requiredString(row?.team_id, "sessions.mapSession", "team_id"),
    title: row?.title ?? "",
    mode: row?.mode ?? "solo",
    ideaId: row?.idea_id ?? null,
    lastMessageAt: row?.last_message_at ?? null,
    lastMessagePreview: row?.last_message_preview ?? null,
    hasUnread: row?.has_unread === true,
    createdAt: row?.created_at ?? null,
    updatedAt: row?.updated_at ?? null,
  };
}

export function mapMessage(row) {
  return {
    id: requiredString(row?.id, "messages.mapMessage", "id"),
    teamId: requiredString(row?.team_id, "messages.mapMessage", "team_id"),
    sessionId: requiredString(row?.session_id, "messages.mapMessage", "session_id"),
    turnId: row?.turn_id ?? null,
    senderActorId: row?.sender_actor_id ?? null,
    replyToMessageId: row?.reply_to_message_id ?? null,
    kind: row?.kind ?? "text",
    content: row?.content ?? "",
    metadata: row?.metadata ?? null,
    model: row?.model ?? null,
    createdAt: requiredString(row?.created_at, "messages.mapMessage", "created_at"),
    updatedAt: row?.updated_at ?? null,
  };
}

export function mapWorkspace(row) {
  const path = row?.path ?? null;
  return {
    id: requiredString(row?.id, "workspaces.mapWorkspace", "id"),
    teamId: requiredString(row?.team_id, "workspaces.mapWorkspace", "team_id"),
    name: requiredString(row?.name, "workspaces.mapWorkspace", "name"),
    path,
    slug: path,
    agentId: row?.agent_id ?? null,
    createdByMemberId: row?.created_by_member_id ?? null,
    archived: row?.archived === true,
    createdAt: row?.created_at ?? null,
    updatedAt: row?.updated_at ?? null,
  };
}

export function mapShortcut(row) {
  return mapShortcutRow(row);
}

export function mapTeamRole(row) {
  return {
    id: requiredString(row?.id, "roles.mapTeamRole", "id"),
    teamId: requiredString(row?.team_id, "roles.mapTeamRole", "team_id"),
    code: requiredString(row?.code, "roles.mapTeamRole", "code"),
    name: requiredString(row?.name, "roles.mapTeamRole", "name"),
  };
}

export function mapPermission(row) {
  return {
    resourceId: requiredString(row?.resource_id, "permissions.mapPermission", "resource_id"),
    roleIds: (row?.permission_roles ?? []).map((x) => requiredString(x?.role_id, "permissions.mapPermission", "role_id")),
  };
}

export function mapActor(row) {
  return {
    id: requiredString(row?.id, "actors.mapActor", "id"),
    teamId: requiredString(row?.team_id, "actors.mapActor", "team_id"),
    kind: row?.kind ?? "user",
    displayName: row?.display_name ?? "",
    avatarUrl: row?.avatar_url ?? null,
    metadata: row?.metadata ?? null,
  };
}

export function mapTeamMember(row) {
  return {
    actorId: requiredString(row?.actor_id, "teamMembers.mapTeamMember", "actor_id"),
    teamId: requiredString(row?.team_id, "teamMembers.mapTeamMember", "team_id"),
    role: row?.role ?? "member",
    joinedAt: row?.joined_at ?? null,
  };
}

export function mapIdeaRow(row) {
  return {
    id: requiredString(row?.id, "ideas.mapIdeaRow", "id"),
    teamId: requiredString(row?.team_id, "ideas.mapIdeaRow", "team_id"),
    title: requiredString(row?.title, "ideas.mapIdeaRow", "title"),
    description: row?.description ?? null,
    archived: row?.archived === true,
    authorActorId: row?.author_actor_id ?? null,
    actorIds: row?.actor_ids ?? [],
    // Fields the ideas table carries that clients (iOS IdeaStore) depend on.
    workspaceId: row?.workspace_id ?? null,
    status: row?.status ?? null,
    sortOrder: row?.sort_order ?? 0,
    createdByActorId: row?.created_by_actor_id ?? null,
    createdAt: row?.created_at ?? null,
    updatedAt: row?.updated_at ?? null,
  };
}

export function mapShortcutRow(row) {
  if (!row) return row;
  return {
    id: row.id,
    scope: row.scope,
    label: row.label,
    owner_member_id: row.owner_member_id ?? null,
    team_id: row.team_id ?? null,
    parent_id: row.parent_id ?? null,
    icon: row.icon ?? null,
    order: row.order ?? 0,
    node_type: row.node_type,
    target: row.target ?? "",
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
  };
}

export function mapAgentRuntimeRow(row) {
  return {
    id: requiredString(row?.id, "agentRuntimes.mapAgentRuntimeRow", "id"),
    agentActorId: requiredString(row?.agent_id, "agentRuntimes.mapAgentRuntimeRow", "agent_id"),
    sessionId: row?.session_id ?? null,
    runtimeId: row?.runtime_id ?? null,
    backendSessionId: row?.backend_session_id ?? null,
    teamId: row?.team_id ?? null,
    backendType: row?.backend_type ?? null,
    status: row?.status ?? null,
    workspaceId: row?.workspace_id ?? null,
    currentModel: row?.current_model ?? null,
    lastSeenAt: row?.last_seen_at ?? null,
    lastProcessedMessageId: row?.last_processed_message_id ?? null,
    createdAt: row?.created_at ?? null,
    updatedAt: row?.updated_at ?? null,
  };
}

export function mapIdeaActivityRow(row) {
  const kind = row?.kind ?? row?.activity_type;
  return {
    id: requiredString(row?.id, "ideas.mapIdeaActivityRow", "id"),
    ideaId: requiredString(row?.idea_id, "ideas.mapIdeaActivityRow", "idea_id"),
    kind: requiredString(kind, "ideas.mapIdeaActivityRow", "kind"),
    // Expose `activityType` alongside `kind` for clients that key on it.
    activityType: kind,
    content: row?.content ?? null,
    actorId: requiredString(row?.actor_id, "ideas.mapIdeaActivityRow", "actor_id"),
    metadata: row?.metadata ?? null,
    teamId: row?.team_id ?? null,
    attachmentUrls: row?.attachment_urls ?? [],
    createdAt: requiredString(row?.created_at, "ideas.mapIdeaActivityRow", "created_at"),
    updatedAt: row?.updated_at ?? null,
  };
}

export function mapFeedbackRow(row) {
  return {
    messageId: requiredString(row?.message_id, "feedback.mapFeedbackRow", "message_id"),
    actorId: requiredString(row?.actor_id, "feedback.mapFeedbackRow", "actor_id"),
    teamId: row?.team_id ?? null,
    sessionId: row?.session_id ?? null,
    kind: requiredString(row?.kind, "feedback.mapFeedbackRow", "kind"),
    starRating: row?.star_rating ?? null,
    skill: row?.skill ?? null,
    createdAt: row?.created_at ?? null,
  };
}

export function mapLeaderboardRow(row) {
  return {
    actorId: requiredString(row?.actor_id, "leaderboard.mapLeaderboardRow", "actor_id"),
    teamId: row?.team_id ?? null,
    displayName: row?.display_name ?? null,
    period: requiredString(row?.period, "leaderboard.mapLeaderboardRow", "period"),
    tokensUsed: Number(row?.tokens_used ?? 0),
    costUsd: Number(row?.cost_usd ?? 0),
    positiveFeedback: Number(row?.positive_feedback ?? 0),
    negativeFeedback: Number(row?.negative_feedback ?? 0),
    sessionCount: Number(row?.session_count ?? 0),
    skillUsage: row?.skill_usage ?? {},
    score: Number(row?.score ?? 0),
  };
}
