import type {
  ActorDirectorySyncRow,
  IdeaSyncRow,
  SessionParticipantSyncRow,
  SyncBackend,
} from "../types";
import type { CloudApiClient } from "./http";

function buildQuery(params: Record<string, string | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== null && v !== undefined && v !== "") search.set(k, v);
  }
  return search.toString();
}

export function createSyncModule(client: CloudApiClient): SyncBackend {
  return {
    async listActorDirectoryForSync(teamId, updatedAfter) {
      const qs = buildQuery({ teamId, since: updatedAfter ?? null });
      const out = await client.get<{ items: ActorDirectorySyncRow[] }>(`/v1/sync/actor-directory?${qs}`);
      return out.items;
    },
    async listIdeasForSync(teamId, updatedAfter) {
      const qs = buildQuery({ teamId, since: updatedAfter ?? null });
      const out = await client.get<{ items: IdeaSyncRow[] }>(`/v1/sync/ideas?${qs}`);
      return out.items;
    },
    async listSessionParticipantsForSync(sessionId, updatedAfter) {
      const qs = buildQuery({ sessionId, since: updatedAfter ?? null });
      const out = await client.get<{ items: SessionParticipantSyncRow[] }>(
        `/v1/sync/session-participants?${qs}`,
      );
      return out.items;
    },
  };
}
