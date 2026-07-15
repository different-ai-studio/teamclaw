import type {
  IdeaActivityRow,
  IdeaDetailRow,
  IdeaFullUpdateInput,
  IdeaRow,
  IdeaSortOrderUpdateInput,
  IdeasBackend,
} from "../types";
import type { CloudApiClient } from "./http";

type CloudIdea = {
  id: string;
  teamId: string;
  title: string;
  body?: string | null;
  description?: string | null;
  workspaceId?: string | null;
  status?: string | null;
  createdByActorId?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  archivedAt?: string | null;
  archived?: boolean | null;
  sortOrder?: number | null;
};

type CloudIdeaActivity = {
  id: string;
  actorId: string;
  activityType: string;
  content?: string | null;
  createdAt: string;
};

type CloudIdeaDetail = CloudIdea & {
  activities?: CloudIdeaActivity[];
  actors?: Array<{ id: string; displayName: string | null; actorType?: string | null }>;
};

function mapIdea(row: CloudIdea): IdeaRow {
  return {
    id: row.id,
    team_id: row.teamId,
    title: row.title,
    body: row.body ?? null,
    description: row.description ?? null,
    workspace_id: row.workspaceId ?? null,
    status: row.status ?? null,
    created_by_actor_id: row.createdByActorId ?? null,
    created_at: row.createdAt ?? null,
    updated_at: row.updatedAt ?? null,
    archived_at: row.archivedAt ?? null,
    archived: row.archived ?? null,
    sort_order: row.sortOrder ?? null,
  };
}

function mapActivity(row: CloudIdeaActivity): IdeaActivityRow {
  return {
    id: row.id,
    actor_id: row.actorId,
    activity_type: row.activityType,
    content: row.content ?? null,
    created_at: row.createdAt,
  };
}

function isSortOrderUpdate(input: IdeaSortOrderUpdateInput | IdeaFullUpdateInput): input is IdeaSortOrderUpdateInput {
  return Object.prototype.hasOwnProperty.call(input, "sortOrder");
}

export function createIdeasModule(client: CloudApiClient): IdeasBackend {
  return {
    async listIdeas(teamId) {
      const out = await client.get<{ items: CloudIdea[] }>(`/v1/ideas?teamId=${encodeURIComponent(teamId)}`);
      return out.items.map(mapIdea);
    },
    async getIdeaDetail(ideaId) {
      try {
        const row = await client.get<CloudIdeaDetail>(`/v1/ideas/${encodeURIComponent(ideaId)}`);
        return {
          ...mapIdea(row),
          activities: (row.activities ?? []).map(mapActivity),
          actors: (row.actors ?? []).map((a) => ({
            id: a.id,
            display_name: a.displayName ?? null,
            actor_type: a.actorType ?? null,
          })),
        } as IdeaDetailRow;
      } catch {
        return null;
      }
    },
    async createIdea(input) {
      return mapIdea(await client.post<CloudIdea>("/v1/ideas", {
        teamId: input.teamId,
        title: input.title,
        body: input.body ?? null,
        workspaceId: input.workspaceId ?? null,
      }));
    },
    async updateIdea(input) {
      if (isSortOrderUpdate(input)) {
        await client.patch<CloudIdea>(`/v1/ideas/${encodeURIComponent(input.ideaId)}`, { sortOrder: input.sortOrder });
      } else {
        await client.patch<CloudIdea>(`/v1/ideas/${encodeURIComponent(input.ideaId)}`, {
          title: input.title,
          body: input.body ?? null,
          description: input.description ?? null,
          status: input.status,
          workspaceId: input.workspaceId,
        });
      }
    },
    async archiveIdea(ideaId) {
      await client.post<void>(`/v1/ideas/${encodeURIComponent(ideaId)}/archive`, {});
    },
    async createIdeaActivity(input) {
      await client.post<void>(`/v1/ideas/${encodeURIComponent(input.ideaId)}/activities`, {
        actorId: input.actorId ?? null,
        activityType: input.activityType ?? input.eventType,
        content: input.content ?? null,
        metadata: input.metadata ?? {},
      });
    },
  };
}
