import { create } from "zustand";
import { getBackend } from "@/lib/backend";
import {
  loadActorsByIds,
  loadSessionParticipants,
} from "@/lib/local-cache";
import { syncParticipantsForSession } from "@/lib/sync/session-participant-sync";
import { isTauri } from "@/lib/utils";

export type SessionParticipantInfo = {
  actorId: string;
  displayName: string;
  avatarUrl: string | null;
  isAgent: boolean;
};

type State = {
  participantsBySession: Record<string, SessionParticipantInfo[]>;
  loadingBySession: Record<string, boolean>;
  errorBySession: Record<string, string | null>;
  ensureParticipants: (sessionIds: string[]) => Promise<void>;
  refreshSession: (sessionId: string, teamId?: string | null) => Promise<void>;
  invalidateSessions: (sessionIds: string[]) => void;
};

async function loadParticipantInfoFromCloud(
  sessionId: string,
): Promise<SessionParticipantInfo[]> {
  const actors = await getBackend().sessionMembers.listParticipants(sessionId);
  return actors
    .filter((a) => a.actor_type === "member" || a.actor_type === "agent")
    .map((actor) => ({
      actorId: actor.id,
      displayName: actor.display_name?.trim() || actor.id,
      avatarUrl: actor.avatar_url ?? null,
      isAgent: actor.actor_type === "agent",
    }));
}

async function loadParticipantInfoFromLocalCache(
  sessionId: string,
): Promise<SessionParticipantInfo[]> {
  const parts = await loadSessionParticipants(sessionId);
  if (parts.length === 0) return [];
  const actorIds = parts.map((p) => p.actorId);
  const actors = await loadActorsByIds(actorIds);
  const byId = new Map(actors.map((a) => [a.id, a] as const));
  return parts
    .map((p) => {
      const actor = byId.get(p.actorId);
      if (!actor) return null;
      return {
        actorId: actor.id,
        displayName: actor.displayName,
        avatarUrl: actor.avatarUrl ?? null,
        isAgent: actor.actorType === "agent",
      };
    })
    .filter((p): p is SessionParticipantInfo => p !== null);
}

async function loadParticipantInfo(sessionId: string): Promise<SessionParticipantInfo[]> {
  if (!isTauri()) {
    return loadParticipantInfoFromCloud(sessionId);
  }
  return loadParticipantInfoFromLocalCache(sessionId);
}

export const useSessionParticipantStore = create<State>((set, get) => ({
  participantsBySession: {},
  loadingBySession: {},
  errorBySession: {},
  ensureParticipants: async (sessionIds) => {
    const unique = Array.from(new Set(sessionIds)).filter(Boolean);
    const missing = unique.filter(
      (sessionId) =>
        get().participantsBySession[sessionId] === undefined &&
        !get().loadingBySession[sessionId],
    );
    if (missing.length === 0) return;

    set((state) => ({
      loadingBySession: {
        ...state.loadingBySession,
        ...Object.fromEntries(missing.map((sessionId) => [sessionId, true])),
      },
      errorBySession: {
        ...state.errorBySession,
        ...Object.fromEntries(missing.map((sessionId) => [sessionId, null])),
      },
    }));

    await Promise.all(
      missing.map(async (sessionId) => {
        try {
          const participants = await loadParticipantInfo(sessionId);
          set((state) => ({
            participantsBySession: {
              ...state.participantsBySession,
              [sessionId]: participants,
            },
            loadingBySession: {
              ...state.loadingBySession,
              [sessionId]: false,
            },
          }));
        } catch (error) {
          set((state) => ({
            loadingBySession: {
              ...state.loadingBySession,
              [sessionId]: false,
            },
            errorBySession: {
              ...state.errorBySession,
              [sessionId]: error instanceof Error ? error.message : String(error),
            },
          }));
        }
      }),
    );
  },
  refreshSession: async (sessionId, teamId = null) => {
    if (teamId) {
      await syncParticipantsForSession(sessionId, teamId, { full: true });
    }
    get().invalidateSessions([sessionId]);
    await get().ensureParticipants([sessionId]);
  },
  invalidateSessions: (sessionIds) => {
    const ids = new Set(sessionIds);
    if (ids.size === 0) return;
    set((state) => {
      const participantsBySession = { ...state.participantsBySession };
      const errorBySession = { ...state.errorBySession };
      for (const sessionId of ids) {
        delete participantsBySession[sessionId];
        delete errorBySession[sessionId];
      }
      return { participantsBySession, errorBySession };
    });
  },
}));
