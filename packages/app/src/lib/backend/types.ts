import type { OAuthProvider } from "@/lib/auth";

export type BackendKind = "cloud_api";

export interface AuthUser {
  id: string;
  email?: string | null;
  isAnonymous?: boolean;
  [key: string]: unknown;
}

export interface AuthSession {
  user: AuthUser;
  accessToken?: string | null;
  refreshToken?: string | null;
  expiresAt?: number | null;
  providerData?: unknown;
}

export interface AuthClaimResult {
  actorId: string;
  teamId: string;
  actorType: string;
  displayName: string;
  refreshToken: string | null;
}

/**
 * An invite addressed to the signed-in user's verified email or phone, which
 * they have not yet accepted or declined. Distinct from the token path: the
 * server matched this to the user's own identity, so no link is involved.
 */
export interface PendingInvite {
  inviteId: string;
  teamId: string;
  teamName: string | null;
  teamRole: string | null;
  /** The name the inviter typed for this person. */
  displayName: string | null;
  invitedByDisplayName: string | null;
  inviteEmail: string | null;
  invitePhone: string | null;
  expiresAt: string | null;
  /** Which of the user's verified contacts the invite was matched on. */
  matchedVia: "email" | "phone" | null;
}

export type Unsubscribe = () => void;

export interface AuthBackend {
  getSession(): Promise<AuthSession | null>;
  onAuthStateChange(listener: (session: AuthSession | null) => void): Unsubscribe;
  sendOtp(email: string): Promise<void>;
  verifyOtp(email: string, code: string): Promise<AuthSession | null>;
  /** Send an SMS OTP to an E.164 phone number (e.g. +8613800138000). */
  sendPhoneOtp(phone: string): Promise<void>;
  /** Verify the SMS OTP and establish a session. */
  verifyPhoneOtp(phone: string, code: string): Promise<AuthSession | null>;
  /** Verify OTP and return a discriminated union for multi-account phone login. */
  verifyPhoneOtpResult(phone: string, code: string): Promise<import("@/lib/auth/auth-client").PhoneLoginResult>;
  /** Log in as a specific user when the phone is linked to multiple accounts. */
  loginWithPhoneUser(phone: string, code: string, userId: string): Promise<AuthSession | null>;
  signInAnonymously(): Promise<AuthSession | null>;
  signInWithOAuth(provider: OAuthProvider): Promise<AuthSession | null>;
  signOut(): Promise<void>;
  claimInvite(token: string): Promise<AuthClaimResult>;
  /** Invites matched to the signed-in user's verified email/phone. */
  listPendingInvites(): Promise<PendingInvite[]>;
  acceptPendingInvite(inviteId: string): Promise<AuthClaimResult>;
  declinePendingInvite(inviteId: string): Promise<void>;
  /** Attach an email identity to the current (anonymous) user. Triggers an OTP. */
  sendUpgradePhoneOtp(phone: string): Promise<void>;
  verifyUpgradePhoneOtp(phone: string, code: string): Promise<AuthSession | null>;
  sendUpgradeEmailOtp(email: string): Promise<void>;
  /** Confirm the OTP and finalize the upgrade. */
  verifyUpgradeEmailOtp(email: string, code: string): Promise<AuthSession | null>;
  /** Install a session minted server-side (e.g. by activateTeam) from its
   *  refresh token, so the client adopts a fresh JWT (new org_id). */
  adoptSession(refreshToken: string): Promise<AuthSession | null>;
}

export interface SessionListEntry {
  id: string;
  title: string;
  team_id: string;
  last_message_at: string | null;
  last_message_preview: string | null;
  mode: "solo" | "collab" | "control";
  idea_id: string | null;
  has_unread: boolean;
  /** How the session was created: 'user' | 'cron' | 'gateway'. */
  source?: string | null;
  /** For source='cron', the cron job id that created it. */
  cron_job_id?: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface SessionSyncRow {
  id: string;
  team_id: string;
  title?: string | null;
  mode?: string | null;
  primary_agent_id?: string | null;
  idea_id?: string | null;
  summary?: string | null;
  last_message_preview?: string | null;
  last_message_at?: string | null;
  created_by_actor_id?: string | null;
  source?: string | null;
  cron_job_id?: string | null;
  created_at: string;
  updated_at: string;
  archived_at?: string | null;
}

export type SessionListCursor =
  | string
  | {
      lastMessageAt: string | null;
      createdAt: string | null;
      id: string;
    };

export interface SessionListPage {
  rows: SessionListEntry[];
  nextCursor?: SessionListCursor | null;
}

export interface SessionCreateInput {
  id: string;
  teamId: string;
  createdByActorId: string;
  title: string;
  additionalActorIds: string[];
  ideaId?: string | null;
  appId?: string;
}

export interface SessionParticipant {
  session_id: string;
  actor_id: string;
  role?: string | null;
}

export interface SessionDisplayRow {
  id: string;
  title: string | null;
}

export interface SessionDetailRow {
  id: string;
  team_id: string;
  title: string;
  mode: string;
  idea_id: string | null;
  primary_agent_id: string | null;
  created_by_actor_id: string | null;
  summary: string | null;
  last_message_at: string | null;
  last_message_preview: string | null;
  acp_session_id: string | null;
  binding: string | null;
  source?: string | null;
  cron_job_id?: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface SessionsBackend {
  listCurrentActorSessions(args: { limit: number; cursor: SessionListCursor | null }): Promise<SessionListPage>;
  markCurrentActorSessionViewed(sessionId: string, lastReadMessageId?: string | null): Promise<void>;
  createSessionShell(input: SessionCreateInput): Promise<{ sessionId: string }>;
  addParticipants(sessionId: string, actorIds: string[]): Promise<void>;
  updateSessionTitle(sessionId: string, title: string): Promise<void>;
  archiveSession(sessionId: string, archivedAt: string): Promise<void>;
  getSessionParticipants(sessionId: string): Promise<SessionParticipant[]>;
  getSession(sessionId: string): Promise<SessionDetailRow | null>;
  joinSession(sessionId: string): Promise<SessionDetailRow>;
  getSessionTeamId(sessionId: string): Promise<string | null>;
  listSessionsForTeamSince(teamId: string, updatedAfter: string): Promise<SessionSyncRow[]>;
  listSessionDisplayRows(teamId: string, sessionIds: string[]): Promise<SessionDisplayRow[]>;
}

export interface OutgoingMessageInput {
  id?: string;
  teamId: string;
  sessionId: string;
  senderActorId: string;
  content: string;
  kind?: string;
  metadata?: Record<string, unknown> | null;
  turnId?: string | null;
  replyToMessageId?: string | null;
  attachments?: AttachmentRef[];
  createdAt?: string;
  model?: string | null;
  mentionActorIds?: string[];
}

export interface MessageHistoryRow {
  id: string;
  team_id: string;
  session_id: string;
  turn_id: string | null;
  sender_actor_id: string | null;
  reply_to_message_id: string | null;
  kind: string;
  content: string;
  metadata: Record<string, unknown> | null;
  model?: string | null;
  mentions?: string[] | null;
  parts?: unknown[] | null;
  attachments?: AttachmentRef[] | null;
  created_at: string;
  updated_at: string | null;
}

export interface MessageSyncRow {
  id: string;
  team_id: string;
  session_id: string;
  turn_id?: string | null;
  sender_actor_id?: string | null;
  reply_to_message_id?: string | null;
  kind: string;
  content: string;
  metadata?: unknown | null;
  model?: string | null;
  created_at: string;
  updated_at: string;
}

export interface MessagesBackend {
  insertOutgoingMessage(input: OutgoingMessageInput): Promise<MessageHistoryRow>;
  listMessages(sessionId: string): Promise<MessageHistoryRow[]>;
  updateMessageContent(messageId: string, content: string): Promise<void>;
  listMessagesForSessionSince(sessionId: string, updatedAfter?: string | null): Promise<MessageSyncRow[]>;
}

export interface AgentRuntimeHintRow {
  id: string;
  agent_id: string;
  workspace_id: string | null;
  backend_type: string | null;
  runtime_id: string | null;
  session_id: string | null;
  status: string | null;
  current_model: string | null;
  updated_at: string | null;
}

export interface AgentDefaultRow {
  id: string;
  agent_types: string[] | null;
  default_agent_type: string | null;
}

export interface SessionRuntimeModelRow {
  runtime_id: string | null;
  backend_type: string | null;
  current_model: string | null;
}

export interface RuntimeTargetRow {
  agent_id: string | null;
  runtime_id: string | null;
}

export interface DaemonRuntimeBackendRow {
  id: string;
  runtime_id: string | null;
  team_id: string;
  agent_id: string;
  session_id: string | null;
  workspace_id: string | null;
  backend_type: string;
  backend_session_id: string | null;
  status: string;
  current_model: string | null;
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RuntimeBackend {
  listLatestAgentRuntimeHints(teamId: string, agentActorIds: string[]): Promise<AgentRuntimeHintRow[]>;
  fetchLatestRuntimeForSession(agentActorId: string, sessionId: string): Promise<DaemonRuntimeBackendRow | null>;
  listAgentDefaults(agentActorIds: string[]): Promise<AgentDefaultRow[]>;
  updateRuntimeModel(runtimeId: string, model: string): Promise<void>;
  listSessionRuntimeModels(sessionId: string): Promise<SessionRuntimeModelRow[]>;
  listRuntimeTargetsForSession(sessionId: string, agentActorIds: string[]): Promise<RuntimeTargetRow[]>;
  listDaemonRuntimes(teamId: string): Promise<DaemonRuntimeBackendRow[]>;
}

export interface AttachmentUploadInput {
  file: File;
  teamId: string;
  sessionId: string;
}

export interface AttachmentRef {
  attachmentId: string;
  fileName: string;
  signedUrl: string;
  mimeType: string;
  size: number;
}

export interface AttachmentsBackend {
  uploadAttachment(input: AttachmentUploadInput): Promise<AttachmentRef>;
}

export interface DirectoryMemberActor {
  id: string;
  team_id?: string;
}

export interface CurrentTeamMemberSummary {
  id: string;
  displayName: string;
  role: string | null;
  joinedAt: string | null;
}

export interface DirectoryBackend {
  resolveCurrentMemberActor(teamId: string, userId: string): Promise<DirectoryMemberActor | null>;
  resolveFirstMemberActorForUser(userId: string): Promise<DirectoryMemberActor | null>;
  getCurrentTeamMember(teamId: string, userId: string): Promise<CurrentTeamMemberSummary | null>;
}

export interface TeamSummary {
  id: string;
  name: string;
  slug?: string | null;
  created_at?: string | null;
}

export interface MembershipTeam {
  id: string;
  name: string;
  slug?: string | null;
  orgId?: string | null;
  orgName?: string | null;
}

export interface TeamInviteResult {
  token: string;
  inviteUrl?: string | null;
  deeplink?: string | null;
  expiresAt?: string | null;
  actorId?: string | null;
}

type TeamInviteBaseInput = {
  teamId: string;
  displayName?: string | null;
  ttlSeconds?: number | null;
  targetActorId?: string | null;
};

/**
 * Optional invitee contact, member invites only. When supplied, the invitee can
 * discover and accept the invite after signing in (`listPendingInvites`) instead
 * of needing the token delivered out-of-band. Agent invites are claimed by a
 * daemon that provisions its own identity, so there is nobody to match.
 */
type TeamInviteContactInput = {
  inviteEmail?: string | null;
  invitePhone?: string | null;
};

export type TeamInviteInput =
  | (TeamInviteBaseInput & TeamInviteContactInput & {
      kind: "member";
      actorType?: "member";
      teamRole: "owner" | "admin" | "member";
      agentKind?: null;
    })
  | (TeamInviteBaseInput & TeamInviteContactInput & {
      actorType: "member";
      kind?: "member";
      teamRole: "owner" | "admin" | "member";
      agentKind?: null;
    })
  | (TeamInviteBaseInput & {
      kind: "agent";
      actorType?: "agent";
      agentKind: string;
      teamRole?: null;
    })
  | (TeamInviteBaseInput & {
      actorType: "agent";
      kind?: "agent";
      agentKind: string;
      teamRole?: null;
    });

export type LiteLlmUsageRange = "day" | "week" | "month" | "year";

export interface LiteLlmUsageSummary {
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  totalSpend: number;
  requestCount: number;
}

/**
 * Usage rolled up to the human accountable for it, not to the key that spent it.
 * Tokens are burned by daemons; the server resolves each agent actor through its
 * owner, so one row can merge a person's own key with every daemon they own.
 */
export interface LiteLlmMemberUsage {
  /** Owning human actor id; null = the unattributed bucket. */
  actorId: string | null;
  /** null when unattributed — render a localized label, never a raw id. */
  displayName: string | null;
  tokens: number;
  spend: number;
  requests: number;
}

export interface LiteLlmModelUsage {
  model: string;
  tokens: number;
  spend: number;
  requests: number;
}

export interface LiteLlmUsage {
  litellmTeamId: string;
  range: LiteLlmUsageRange;
  startDate: string;
  endDate: string;
  startUtc?: string;
  endUtc?: string;
  maxBudget: number | null;
  summary: LiteLlmUsageSummary;
  members: LiteLlmMemberUsage[];
  byModel: LiteLlmModelUsage[];
}

export interface TeamsBackend {
  listCurrentUserTeams(args?: { limit?: number }): Promise<TeamSummary[]>;
  getTeam(teamId: string): Promise<TeamSummary | null>;
  createTeam(input: { name?: string | null; slug?: string | null; displayName?: string | null }): Promise<TeamSummary>;
  renameTeam(teamId: string, name: string): Promise<TeamSummary>;
  /**
   * Graduate the caller out of the shared DEFAULT_ORG into their own org:
   * create the org (name + contact), reparent + rename their default-org team.
   * See docs/specs/2026-06-17-teamclaw-phone-login-and-tenancy.md §8.
   */
  upgradeAccount(input: { teamId: string; orgName: string; contact?: string | null }): Promise<{ orgId: string; teamId: string; teamName: string }>;
  createTeamInvite(input: TeamInviteInput): Promise<TeamInviteResult>;
  removeTeamActor(teamId: string, actorId: string): Promise<void>;
  listAllMyTeams(): Promise<MembershipTeam[]>;
  activateTeam(teamId: string): Promise<{ actorId: string | null; teamId: string; refreshToken: string }>;
  getLiteLlmUsage(teamId: string, opts?: { range?: LiteLlmUsageRange; date?: string }): Promise<LiteLlmUsage>;
}

export interface IdeaRow {
  id: string;
  team_id: string;
  title: string;
  body?: string | null;
  description?: string | null;
  workspace_id?: string | null;
  status?: string | null;
  created_by_actor_id?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  archived_at?: string | null;
  archived?: boolean | null;
  sort_order?: number | null;
}

export interface IdeaActivityRow {
  id: string;
  actor_id: string;
  activity_type: string;
  content?: string | null;
  created_at: string;
}

export interface IdeaActorSummary {
  id: string;
  display_name: string | null;
  actor_type?: string | null;
}

export interface IdeaDetailRow extends IdeaRow {
  description?: string | null;
  workspace_id?: string | null;
  activities?: IdeaActivityRow[];
  actors?: IdeaActorSummary[];
}

export type IdeaSortOrderUpdateInput = {
  ideaId: string;
  sortOrder: number | null;
  title?: never;
  body?: never;
  description?: never;
  status?: never;
  workspaceId?: never;
};

export type IdeaFullUpdateInput = {
  ideaId: string;
  title: string;
  body?: string | null;
  description?: string | null;
  status: string | null;
  workspaceId: string | null;
  sortOrder?: never;
};

export interface IdeasBackend {
  listIdeas(teamId: string): Promise<IdeaRow[]>;
  getIdeaDetail(ideaId: string): Promise<IdeaDetailRow | null>;
  createIdea(input: { teamId: string; title: string; body?: string | null; workspaceId?: string | null }): Promise<IdeaRow>;
  updateIdea(input: IdeaSortOrderUpdateInput | IdeaFullUpdateInput): Promise<void>;
  archiveIdea(ideaId: string): Promise<void>;
  createIdeaActivity(input: {
    ideaId: string;
    actorId?: string | null;
    eventType?: string;
    activityType?: string;
    content?: string | null;
    metadata?: Record<string, unknown> | null;
  }): Promise<void>;
}

// Latest reported version of each client (device) backing an actor. Only carried
// on the single-actor detail fetch (GET /v1/actors/:id), never on the directory
// list — used by the actor profile dialog for ops/support debugging.
export interface ClientVersionEntry {
  clientType: string;
  version: string;
  deviceId: string;
  build: string | null;
  lastReportedAt: string;
}

export interface ActorDirectoryEntry {
  id: string;
  team_id: string;
  display_name: string | null;
  actor_type: string | null;
  avatar_url?: string | null;
  user_id?: string | null;
  last_active_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  member_status?: string | null;
  agent_status?: string | null;
  team_role?: string | null;
  agent_types?: string[] | null;
  default_agent_type?: string | null;
  default_workspace_id?: string | null;
  visibility?: string | null;
  // Member contact — null for agents/external and anonymous members.
  email?: string | null;
  phone?: string | null;
  // Per-device client versions — only populated by the single-actor detail fetch.
  client_versions?: ClientVersionEntry[] | null;
}

export interface ConnectedAgentRow extends ActorDirectoryEntry {
  agent_id?: string | null;
  agent_types?: string[] | null;
  default_agent_type?: string | null;
  permission_level?: string | null;
  visibility?: string | null;
  is_owner?: boolean | null;
}

export interface AgentAccessBackendRow {
  id: string;
  agentId: string;
  memberId: string;
  memberName: string;
  permissionLevel: "view" | "prompt" | "admin";
  grantedByMemberId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TeamMemberOptionBackendRow {
  id: string;
  displayName: string;
  role: string | null;
}

export interface ActorsBackend {
  listActorDirectory(teamId: string): Promise<ActorDirectoryEntry[]>;
  listActorDirectoryByIds(actorIds: string[]): Promise<ActorDirectoryEntry[]>;
  getActorDirectoryEntry(actorId: string): Promise<ActorDirectoryEntry | null>;
  getDaemonAgentDirectoryEntry(teamId: string, agentId: string): Promise<ActorDirectoryEntry | null>;
  listConnectedAgents(teamId: string): Promise<ConnectedAgentRow[]>;
  updateOwnedAgentProfile(input: {
    agentId: string;
    displayName?: string | null;
    visibility?: string | null;
  }): Promise<void>;
  /** Rename / re-avatar the calling user's own member actor. The server resolves
   * the actor from the bearer token; `actorId` must be the caller's own actor. */
  updateCurrentActorProfile(input: {
    actorId: string;
    displayName: string;
    avatarUrl?: string | null;
  }): Promise<ActorDirectoryEntry>;
  updateAgentDefaults(input: {
    agentId: string;
    agentTypes?: string[] | null;
    agentKind?: string | null;
    defaultAgentType?: string | null;
    defaultWorkspaceId?: string | null;
  }): Promise<void>;
  listAgentAccess(agentId: string): Promise<AgentAccessBackendRow[]>;
  listTeamMembersForAccess(teamId: string): Promise<TeamMemberOptionBackendRow[]>;
  upsertAgentAccess(input: {
    agentId: string;
    memberId: string;
    permissionLevel: "view" | "prompt" | "admin";
    grantedByMemberId: string | null;
  }): Promise<void>;
  removeAgentAccess(accessId: string): Promise<void>;
  makeAgentPersonal(agentActorId: string): Promise<void>;
  /** Returns the calling member's default agent id for a team (null if unset). */
  getMemberDefaultAgent(teamId: string): Promise<string | null>;
  /** Sets (agentId) or clears (null) the calling member's default agent. Returns the new value. */
  setMemberDefaultAgent(teamId: string, agentId: string | null): Promise<string | null>;
  /** Returns the team-wide default agent id (null if unset). Requires owner/admin. */
  getTeamDefaultAgent(teamId: string): Promise<string | null>;
  /** Sets (agentId) or clears (null) the team-wide default agent. Returns the new value. Requires owner/admin. */
  setTeamDefaultAgent(teamId: string, agentId: string | null): Promise<string | null>;
  /** Returns the effective default agent for the calling member (member override → team default → null). */
  getEffectiveDefaultAgent(teamId: string): Promise<string | null>;
}

export interface SessionMemberCandidate extends ActorDirectoryEntry {
  is_present: boolean;
}

export interface SessionMembersBackend {
  listParticipants(sessionId: string): Promise<ActorDirectoryEntry[]>;
  listSessionIdsForActor(actorId: string): Promise<string[]>;
  listCandidateActors(teamId: string, presentActorIds: string[]): Promise<SessionMemberCandidate[]>;
  addParticipant(sessionId: string, actorId: string): Promise<void>;
  removeParticipant(sessionId: string, actorId: string): Promise<void>;
}

export interface ShortcutRow {
  id: string;
  scope: string;
  label: string;
  owner_member_id?: string | null;
  team_id?: string | null;
  parent_id?: string | null;
  icon?: string | null;
  order: number;
  node_type: string;
  target: string;
  created_at?: string | null;
  updated_at?: string | null;
  sort_order?: number | null;
  visible_roles?: string[] | null;
}

export interface ShortcutCreateArgs {
  p_scope: string;
  p_label: string;
  p_node_type: string;
  p_team_id?: string | null;
  p_parent_id?: string | null;
  p_icon?: string | null;
  p_order?: number;
  p_target?: string;
}

export interface ShortcutTeamRoleRow {
  id: string;
  team_id: string;
  code: string;
  name: string;
}

export interface ShortcutRoleBindingRow {
  resource_id: string;
  permission_roles: Array<{ role_id: string }>;
}

export interface ShortcutsBackend {
  listShortcuts(scope: string, teamId?: string): Promise<ShortcutRow[]>;
  createShortcut(input: ShortcutCreateArgs): Promise<{ id: string }>;
  updateShortcut(id: string, patch: Record<string, unknown>): Promise<void>;
  deleteShortcut(id: string): Promise<void>;
  batchMove(input: { ids?: string[]; targetScope?: string; moves?: Record<string, unknown>[]; [key: string]: unknown }): Promise<unknown>;
  setVisibleRoles(input: { shortcutId?: string; roleIds?: string[]; roles?: string[]; [key: string]: unknown }): Promise<void>;
  listTeamRoles(teamId: string): Promise<ShortcutTeamRoleRow[]>;
  listShortcutRoleBindings(teamId: string): Promise<ShortcutRoleBindingRow[]>;
}

export interface NotificationPrefs {
  user_id?: string;
  enabled: boolean;
  dnd_start_min?: number | null;
  dnd_end_min?: number | null;
  dnd_tz?: string | null;
  updated_at?: string | null;
}

export interface NotificationsBackend {
  loadPreferences(userId: string): Promise<NotificationPrefs | null>;
  savePreferences(input: NotificationPrefs): Promise<void>;
  setSessionMuted(input: { sessionId: string; userId: string; muted: boolean }): Promise<void>;
  listMutedSessionIds(userId: string): Promise<string[]>;
}

export interface TeamWorkspaceConfigRow {
  team_id: string;
  workspace_path?: string | null;
  git_url?: string | null;
  git_branch?: string | null;
  git_token?: string | null;
  ai_gateway_endpoint?: string | null;
  enabled?: boolean;
  updated_at?: string | null;
  metadata?: Record<string, unknown> | null;
}

/** A single LLM model entry ({id, name}). */
export interface TeamLlmModel {
  id: string;
  name: string;
}

/**
 * Per-team LLM config block from `GET /v1/teams/:id/workspace-config`'s `llm`
 * field. The cloud is the source of truth. `models` is the team's stored
 * (authoritative) model list; `availableModels` are gateway-listed suggestions
 * for the model picker.
 */
export interface TeamLlmConfig {
  enabled: boolean;
  baseUrl: string | null;
  models: TeamLlmModel[];
  availableModels: TeamLlmModel[];
  aiGatewayEndpoint: string | null;
}

/** Body for `PUT /v1/teams/:id/llm-config`. */
export interface TeamLlmConfigInput {
  enabled: boolean;
  baseUrl: string | null;
  models: TeamLlmModel[];
}

export interface TeamWorkspaceConfigBackend {
  load(teamId: string): Promise<TeamWorkspaceConfigRow | null>;
  save(input: TeamWorkspaceConfigRow): Promise<void>;
  /** Read the per-team LLM config block from the cloud workspace-config. */
  loadLlmConfig(teamId: string): Promise<TeamLlmConfig | null>;
  /** Persist the per-team LLM config to the cloud; returns the saved config. */
  saveLlmConfig(teamId: string, input: TeamLlmConfigInput): Promise<TeamLlmConfigInput>;
}

export interface DaemonWorkspaceBackendRow {
  id: string;
  team_id: string;
  agent_id: string | null;
  created_by_member_id: string | null;
  name: string;
  path: string | null;
  archived: boolean;
  created_at: string;
  updated_at: string;
}

export interface WorkspacesBackend {
  listWorkspacesByIds(teamId: string, workspaceIds: string[]): Promise<Array<{ id: string; name: string | null; path: string | null }>>;
  listDaemonWorkspaces(teamId: string, agentId?: string | null): Promise<DaemonWorkspaceBackendRow[]>;
  createDaemonWorkspace(input: {
    teamId: string;
    agentId: string;
    createdByMemberId: string | null;
    name: string;
    path: string;
  }): Promise<DaemonWorkspaceBackendRow>;
  updateDaemonWorkspace(input: {
    workspaceId: string;
    name: string;
    path: string;
    archived: boolean;
  }): Promise<DaemonWorkspaceBackendRow>;
}

export interface AppRow {
  id: string;
  teamId: string;
  name: string;
  slug: string;
  type: string;
  visibility: "personal" | "team";
  workspaceId: string | null;
  gitRemoteUrl: string | null;
  provisionStatus: string;
  fcStatus: string | null;
  fcEndpoint: string | null;
  createdAt: string;
  updatedAt: string;
}

/** `POST /v1/apps/:id/deploy` response — app row plus the OSS upload handle the
 *  local daemon needs to upload the build artifact. */
export interface DeployAppResult extends AppRow {
  ossObjectName: string;
  presignedPut: string;
}

export interface AppSessionRow {
  id: string;
  teamId: string;
  title: string;
  mode: string;
  lastMessageAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AppsBackend {
  listApps(teamId: string): Promise<AppRow[]>;
  createApp(input: { teamId: string; name: string; type: string; visibility: "personal" | "team" }): Promise<AppRow>;
  getApp(appId: string): Promise<AppRow | null>;
  listAppSessions(appId: string): Promise<AppSessionRow[]>;
  updateAppProvisionStatus(appId: string, provisionStatus: string): Promise<AppRow | null>;
  /** Rename an app (PATCH name). Returns null on 404. */
  renameApp(appId: string, name: string): Promise<AppRow | null>;
  /** Start FC deploy: provisions the function + returns the OSS upload handle. */
  deployApp(appId: string): Promise<DeployAppResult>;
  /** Finalize FC deploy after the artifact is uploaded: points the function at
   *  the new code and returns the row with `fcEndpoint` + `fcStatus: live`. */
  finalizeDeploy(appId: string): Promise<AppRow>;
}

export interface ActorDirectorySyncRow {
  id: string;
  team_id: string;
  actor_type: string;
  display_name: string;
  member_status?: string | null;
  agent_status?: string | null;
  last_active_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface IdeaSyncRow {
  id: string;
  team_id: string;
  workspace_id?: string | null;
  parent_idea_id?: string | null;
  title: string;
  description?: string | null;
  status?: string | null;
  created_by_actor_id?: string | null;
  archived?: boolean | number | null;
  sort_order?: number | null;
  created_at: string;
  updated_at: string;
}

export interface SessionParticipantSyncRow {
  id: string;
  session_id: string;
  actor_id: string;
  role?: string | null;
  joined_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface SyncBackend {
  listActorDirectoryForSync(teamId: string, updatedAfter?: string | null): Promise<ActorDirectorySyncRow[]>;
  listIdeasForSync(teamId: string, updatedAfter?: string | null): Promise<IdeaSyncRow[]>;
  listSessionParticipantsForSync(sessionId: string, updatedAfter?: string | null): Promise<SessionParticipantSyncRow[]>;
}

export interface TelemetryFeedbackDeleteInput {
  messageId: string;
}

export interface TelemetryBackend {
  insertFeedback(input: Record<string, unknown>): Promise<void>;
  deleteFeedback(input: TelemetryFeedbackDeleteInput): Promise<void>;
  listFeedbacks(input: { teamId: string; sessionId: string }): Promise<Array<Record<string, unknown>>>;
  listFeedbackSummary(teamId: string): Promise<Array<Record<string, unknown>>>;
  insertSessionReport(input: Record<string, unknown>): Promise<void>;
  insertSkillUsage(input: Record<string, unknown>): Promise<void>;
  listLeaderboard(teamId: string, period?: "day" | "week" | "month"): Promise<Array<Record<string, unknown>>>;
  reportClientVersion(teamId: string, payload: { clientType: string; version: string; deviceId: string; build: string | null }): Promise<void>;
}

export interface SystemBackend {
  /** Updates the caller's actor last_active_at (member or daemon agent). */
  heartbeat(): Promise<void>;
}

export interface TeamClawBackend {
  kind: BackendKind;
  auth: AuthBackend;
  directory: DirectoryBackend;
  sessions: SessionsBackend;
  apps: AppsBackend;
  messages: MessagesBackend;
  runtime: RuntimeBackend;
  attachments: AttachmentsBackend;
  teams: TeamsBackend;
  ideas: IdeasBackend;
  actors: ActorsBackend;
  sessionMembers: SessionMembersBackend;
  shortcuts: ShortcutsBackend;
  notifications: NotificationsBackend;
  teamWorkspaceConfig: TeamWorkspaceConfigBackend;
  workspaces: WorkspacesBackend;
  sync: SyncBackend;
  telemetry: TelemetryBackend;
  system: SystemBackend;
}
