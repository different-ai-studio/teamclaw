import type {
  SessionCreateInput,
  SessionDetailRow,
  SessionDisplayRow,
  SessionListCursor,
  SessionListPage,
  SessionParticipant,
  SessionSyncRow,
  SessionsBackend,
} from "../types";
import { CloudApiError, type CloudApiClient } from "./http";

type CloudSession = {
  id: string;
  teamId: string;
  title: string;
  mode: "solo" | "collab" | "control";
  ideaId: string | null;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  hasUnread: boolean;
  createdAt: string | null;
  updatedAt: string | null;
};

type CloudSessionDetail = CloudSession & {
  primaryAgentId?: string | null;
  createdByActorId?: string | null;
  summary?: string | null;
  acpSessionId?: string | null;
  binding?: string | null;
};

function mapSessionDetail(row: CloudSessionDetail): SessionDetailRow {
  return {
    id: row.id,
    team_id: row.teamId,
    title: row.title,
    mode: row.mode,
    idea_id: row.ideaId,
    primary_agent_id: row.primaryAgentId ?? null,
    created_by_actor_id: row.createdByActorId ?? null,
    summary: row.summary ?? null,
    last_message_at: row.lastMessageAt,
    last_message_preview: row.lastMessagePreview,
    acp_session_id: row.acpSessionId ?? null,
    binding: row.binding ?? null,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

type Page<T> = { items: T[]; nextCursor: string | null };

function mapSession(row: CloudSession) {
  return {
    id: row.id,
    title: row.title,
    team_id: row.teamId,
    last_message_at: row.lastMessageAt,
    last_message_preview: row.lastMessagePreview,
    mode: row.mode,
    idea_id: row.ideaId,
    has_unread: row.hasUnread,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

function encodeCursor(cursor: SessionListCursor): string {
  if (typeof cursor === "string") return cursor;
  return btoa(JSON.stringify(cursor))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function createSessionsModule(client: CloudApiClient): SessionsBackend {
  return {
    async listCurrentActorSessions(args: { limit: number; cursor: SessionListCursor | null }): Promise<SessionListPage> {
      const params = new URLSearchParams({ limit: String(args.limit) });
      if (args.cursor) params.set("cursor", encodeCursor(args.cursor));
      const page = await client.get<Page<CloudSession>>(`/v1/sessions?${params.toString()}`);
      return { rows: page.items.map(mapSession), nextCursor: page.nextCursor };
    },
    async markCurrentActorSessionViewed(sessionId: string, lastReadMessageId?: string | null) {
      await client.post<void>(`/v1/sessions/${encodeURIComponent(sessionId)}/mark-viewed`, { lastReadMessageId: lastReadMessageId ?? null });
    },
    async createSessionShell(input: SessionCreateInput) {
      await client.post<CloudSession>("/v1/sessions", {
        id: input.id,
        teamId: input.teamId,
        title: input.title,
        mode: "collab",
        createdByActorId: input.createdByActorId,
        ideaId: input.ideaId ?? null,
        additionalActorIds: input.additionalActorIds,
        ...(input.appId ? { appId: input.appId } : {}),
      });
      return { sessionId: input.id };
    },
    async addParticipants(sessionId, actorIds) {
      const unique = Array.from(new Set(actorIds));
      for (const actorId of unique) {
        try {
          await client.post(`/v1/sessions/${encodeURIComponent(sessionId)}/participants`, { actorId });
        } catch (e) {
          // Idempotent: ignore conflicts.
          if (e instanceof CloudApiError && (e.status === 409 || e.status === 200)) continue;
          throw e;
        }
      }
    },
    async updateSessionTitle(sessionId, title) {
      await client.patch(`/v1/sessions/${encodeURIComponent(sessionId)}`, { title });
    },
    async archiveSession(sessionId, archivedAt) {
      await client.patch(`/v1/sessions/${encodeURIComponent(sessionId)}`, { archivedAt });
    },
    async getSessionParticipants(sessionId): Promise<SessionParticipant[]> {
      const out = await client.get<{ items: Array<{ sessionId?: string; actorId: string; role?: string | null }> }>(
        `/v1/sessions/${encodeURIComponent(sessionId)}/participants`,
      );
      return out.items.map((row) => ({
        session_id: row.sessionId ?? sessionId,
        actor_id: row.actorId,
        role: row.role ?? null,
      }));
    },
    async getSession(sessionId) {
      try {
        const out = await client.get<CloudSessionDetail>(`/v1/sessions/${encodeURIComponent(sessionId)}`);
        return mapSessionDetail(out);
      } catch (e) {
        if (e instanceof CloudApiError && e.status === 404) return null;
        throw e;
      }
    },
    async joinSession(sessionId: string): Promise<SessionDetailRow> {
      const out = await client.post<CloudSessionDetail>(
        `/v1/sessions/${encodeURIComponent(sessionId)}/join`,
        {},
      );
      return mapSessionDetail(out);
    },
    async getSessionTeamId(sessionId) {
      try {
        const out = await client.get<{ teamId?: string | null }>(`/v1/sessions/${encodeURIComponent(sessionId)}`);
        return out.teamId ?? null;
      } catch (e) {
        if (e instanceof CloudApiError && e.status === 404) return null;
        throw e;
      }
    },
    async listSessionsForTeamSince(teamId, updatedAfter): Promise<SessionSyncRow[]> {
      const params = new URLSearchParams({ teamId });
      if (updatedAfter) params.set("since", updatedAfter);
      const out = await client.get<{ items: SessionSyncRow[] }>(`/v1/sync/sessions?${params.toString()}`);
      return out.items ?? [];
    },
    async listSessionDisplayRows(teamId, sessionIds): Promise<SessionDisplayRow[]> {
      if (sessionIds.length === 0) return [];
      const out = await client.post<{ items: SessionDisplayRow[] }>(`/v1/sessions/display-rows`, {
        teamId,
        sessionIds,
      });
      return out.items ?? [];
    },
  };
}
