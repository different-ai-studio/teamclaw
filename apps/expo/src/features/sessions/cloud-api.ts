import {
  cloudApiBaseUrl,
  createCloudApiClient,
  CloudApiError,
} from "../../lib/cloud-api/client";
import {
  mapMessageRecord,
  type SessionMessage,
  type SessionSummary,
} from "./session-types";

type CreateCloudSessionsApiOptions = {
  getAccessToken: () => Promise<string | null>;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
};

type SessionMode = "solo" | "collab" | "control";

type OutgoingMessageInput = {
  id: string;
  teamId: string;
  sessionId: string;
  senderActorId: string;
  content: string;
  createdAt?: string;
  metadata?: unknown | null;
  model?: string | null;
  turnId?: string | null;
  replyToMessageId?: string | null;
  attachments?: unknown[] | null;
};

type CloudSessionFull = {
  id: string;
  teamId: string;
  title: string | null;
  mode: string;
  ideaId: string | null;
  primaryAgentId: string | null;
  createdByActorId: string | null;
  summary: string | null;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  participantCount: number;
  hasUnread: boolean;
  createdAt: string | null;
  updatedAt: string | null;
};

type CloudMessage = {
  id: string;
  teamId: string;
  sessionId: string;
  turnId: string | null;
  senderActorId: string | null;
  replyToMessageId: string | null;
  kind: string;
  content: string;
  metadata: unknown | null;
  model: string | null;
  createdAt: string;
  updatedAt: string | null;
  attachments?: unknown | null;
};

type CloudAgentRuntime = {
  id: string;
  runtimeId: string | null;
  agentId: string | null;
  status: string | null;
  currentModel: string | null;
  lastSeenAt: string | null;
  backendType: string | null;
};

type RuntimeInfo = {
  dbRuntimeId: string;
  runtimeId: string;
  agentId: string | null;
  status: string;
  currentModel: string | null;
  lastSeenAt: string | null;
  backendType: string | null;
};

type SessionRuntime = {
  dbRuntimeId: string;
  runtimeId: string;
  agentId: string | null;
  workspaceId: string | null;
  backendType: string | null;
  currentModel: string | null;
  status: string;
};

function mapSession(row: CloudSessionFull): SessionSummary {
  return {
    sessionId: row.id,
    teamId: row.teamId,
    title: row.title ?? "",
    summary: row.summary ?? "",
    participantCount: row.participantCount ?? 0,
    // The team-sessions endpoint does not expose the participant actor id
    // list. The only consumer (mention resolver) treats it as advisory and
    // falls back to the full team directory, so an empty list is safe.
    participantActorIds: [],
    lastMessagePreview: row.lastMessagePreview ?? "",
    lastMessageAt: row.lastMessageAt ?? "",
    createdAt: row.createdAt ?? "",
    createdBy: row.createdByActorId ?? "",
    hasUnread: row.hasUnread ?? false,
  };
}

function mapMessage(row: CloudMessage): SessionMessage {
  // Reuse the canonical record mapper (attachment coercion + defaults) by
  // projecting the camelCase Cloud API row onto the snake_case record shape.
  return mapMessageRecord({
    id: row.id,
    team_id: row.teamId,
    session_id: row.sessionId,
    turn_id: row.turnId,
    sender_actor_id: row.senderActorId,
    reply_to_message_id: row.replyToMessageId,
    kind: row.kind,
    content: row.content,
    metadata: row.metadata,
    model: row.model,
    created_at: row.createdAt,
    attachments: row.attachments,
  });
}

export function createCloudSessionsApi(options: CreateCloudSessionsApiOptions) {
  const client = createCloudApiClient({
    getAccessToken: options.getAccessToken,
    baseUrl: options.baseUrl ?? cloudApiBaseUrl(),
    fetchImpl: options.fetchImpl,
  });

  return {
    async listSessions(teamId: string, currentActorId?: string): Promise<SessionSummary[]> {
      // currentActorId is derived server-side from the bearer; kept for
      // signature parity with the legacy Supabase implementation.
      void currentActorId;
      const response = await client.get<{ items?: CloudSessionFull[] }>(
        `/v1/teams/${encodeURIComponent(teamId)}/sessions`,
      );
      return (response.items ?? []).map(mapSession);
    },

    async listSessionsForIdea(
      teamId: string,
      ideaId: string,
      limit = 5,
    ): Promise<SessionSummary[]> {
      // The team-sessions endpoint returns rows ordered by last_message_at
      // desc and carries ideaId, so we filter client-side to mirror the prior
      // `sessions.eq(idea_id).order(last_message_at).limit(5)` query.
      const response = await client.get<{ items?: CloudSessionFull[] }>(
        `/v1/teams/${encodeURIComponent(teamId)}/sessions`,
      );
      return (response.items ?? [])
        .filter((row) => row.ideaId === ideaId)
        .slice(0, limit)
        .map(mapSession);
    },

    async getSession(teamId: string, sessionId: string): Promise<SessionSummary | null> {
      // The session lookup is keyed by id alone; teamId is retained for
      // signature parity.
      void teamId;
      try {
        const row = await client.get<CloudSessionFull>(
          `/v1/sessions/${encodeURIComponent(sessionId)}`,
        );
        return mapSession(row);
      } catch (error) {
        if (error instanceof CloudApiError && error.status === 404) return null;
        throw error;
      }
    },

    async listMessages(teamId: string, sessionId: string): Promise<SessionMessage[]> {
      void teamId;
      const response = await client.get<{ items?: CloudMessage[] }>(
        `/v1/sessions/${encodeURIComponent(sessionId)}/messages`,
      );
      return (response.items ?? []).map(mapMessage);
    },

    async insertOutgoingMessage(input: OutgoingMessageInput): Promise<void> {
      if (!input.id) {
        throw new Error("Cloud API message insert requires a stable message id.");
      }
      const body: Record<string, unknown> = {
        id: input.id,
        teamId: input.teamId,
        senderActorId: input.senderActorId,
        kind: "text",
        content: input.content,
        metadata: input.metadata ?? null,
        model: input.model ?? null,
        turnId: input.turnId ?? null,
        replyToMessageId: input.replyToMessageId ?? null,
      };
      if (input.attachments && input.attachments.length > 0) {
        body.attachments = input.attachments;
      }
      if (input.createdAt) {
        body.createdAt = input.createdAt;
      }
      await client.post(
        `/v1/sessions/${encodeURIComponent(input.sessionId)}/messages`,
        body,
        { idempotencyKey: input.id },
      );
    },

    async resolveMemberActorId(teamId: string, userId: string): Promise<string | null> {
      const params = new URLSearchParams({ teamId, userId });
      const result = await client.get<{ id?: string } | null>(
        `/v1/directory/current-member-actor?${params.toString()}`,
      );
      return result?.id ?? null;
    },

    async updateMessageContent(messageId: string, content: string): Promise<void> {
      await client.patch(`/v1/messages/${encodeURIComponent(messageId)}`, { content });
    },

    async deleteMessage(messageId: string): Promise<void> {
      await client.del(`/v1/messages/${encodeURIComponent(messageId)}`);
    },

    async setSessionArchived(sessionId: string, archivedAt: string | null): Promise<void> {
      await client.patch(`/v1/sessions/${encodeURIComponent(sessionId)}`, { archivedAt });
    },

    async createSession(input: {
      teamId: string;
      title: string;
      mode?: SessionMode;
      primaryAgentId?: string | null;
      ideaId?: string | null;
    }): Promise<string> {
      const response = await client.post<{ sessionId?: string; id?: string }>("/v1/sessions", {
        teamId: input.teamId,
        title: input.title,
        mode: input.mode ?? "collab",
        primaryAgentId: input.primaryAgentId ?? null,
        ideaId: input.ideaId ?? null,
      });
      const sessionId = response?.sessionId ?? response?.id;
      if (!sessionId || typeof sessionId !== "string") {
        throw new Error("create_session returned no session id");
      }
      return sessionId;
    },

    async markSessionRead(
      sessionId: string,
      actorId: string,
      lastMessageId: string | null,
    ): Promise<void> {
      // The current actor is derived from the bearer server-side.
      void actorId;
      await client.post(`/v1/sessions/${encodeURIComponent(sessionId)}/mark-viewed`, {
        lastReadMessageId: lastMessageId,
      });
    },

    async markSessionUnread(sessionId: string, actorId: string): Promise<void> {
      void actorId;
      await client.post(`/v1/sessions/${encodeURIComponent(sessionId)}/mark-unread`);
    },

    async addParticipants(
      sessionId: string,
      actorIds: ReadonlyArray<string>,
    ): Promise<void> {
      // FC's participants POST is single-actor + idempotent (upsert on
      // session_id,actor_id), so we loop one call per actor.
      for (const actorId of actorIds) {
        if (!actorId) continue;
        await client.post(`/v1/sessions/${encodeURIComponent(sessionId)}/participants`, {
          actorId,
        });
      }
    },

    async removeParticipant(sessionId: string, actorId: string): Promise<void> {
      await client.del(
        `/v1/sessions/${encodeURIComponent(sessionId)}/participants/${encodeURIComponent(actorId)}`,
      );
    },

    async updateRuntimeModel(runtimeId: string, model: string): Promise<void> {
      await client.patch(`/v1/runtime/${encodeURIComponent(runtimeId)}/model`, { model });
    },

    async listSessionRuntimes(sessionId: string): Promise<SessionRuntime[]> {
      type Row = {
        id: string | null;
        runtime_id: string | null;
        agent_id: string | null;
        workspace_id: string | null;
        backend_type: string | null;
        current_model: string | null;
        status: string | null;
      };
      const response = await client.get<{ items?: Row[] }>(
        `/v1/sessions/${encodeURIComponent(sessionId)}/runtime-models`,
      );
      return (response.items ?? [])
        .filter((row): row is Row & { id: string } => Boolean(row.id))
        .map((row) => ({
          dbRuntimeId: row.id,
          runtimeId: row.runtime_id ?? "",
          agentId: row.agent_id ?? null,
          workspaceId: row.workspace_id ?? null,
          backendType: row.backend_type ?? null,
          currentModel: row.current_model ?? null,
          status: row.status ?? "unknown",
        }));
    },

    async loadRuntime(sessionId: string): Promise<RuntimeInfo | null> {
      try {
        const row = await client.get<CloudAgentRuntime>(
          `/v1/agents/runtimes?sessionId=${encodeURIComponent(sessionId)}`,
        );
        return {
          dbRuntimeId: row.id,
          runtimeId: row.runtimeId ?? "",
          agentId: row.agentId ?? null,
          status: row.status ?? "unknown",
          currentModel: row.currentModel ?? null,
          lastSeenAt: row.lastSeenAt ?? null,
          backendType: row.backendType ?? null,
        };
      } catch (error) {
        if (error instanceof CloudApiError && error.status === 404) return null;
        throw error;
      }
    },
  };
}
