import { cloudApiBaseUrl, createCloudApiClient } from "../../lib/cloud-api/client";
import type { Idea, IdeaStatus } from "./idea-types";

/**
 * Cloud-only ideas provider. Mirrors the iOS CloudAPIIdeaRepository: the FC
 * list endpoint paginates and returns one archived bucket per call, so
 * listIdeas follows the cursor to exhaustion (both buckets when archived is
 * requested). FC ideas carry no workspace name, so — like the prior Supabase
 * join — names are enriched from GET /v1/workspaces.
 */

// FC mapIdeaRow camelCase shape (subset we consume).
type CloudIdea = {
  id: string;
  teamId?: string | null;
  workspaceId?: string | null;
  createdByActorId?: string | null;
  title?: string | null;
  description?: string | null;
  status?: string | null;
  archived?: boolean | null;
  createdAt?: string | null;
  updatedAt?: string | null;
};

function toStatus(value: string | null | undefined): IdeaStatus {
  switch (value) {
    case "in_progress":
      return "in_progress";
    case "done":
      return "done";
    default:
      return "open";
  }
}

function toIdea(row: CloudIdea, workspaceName: string | null): Idea {
  return {
    ideaId: row.id,
    teamId: row.teamId ?? "",
    workspaceId: row.workspaceId ?? null,
    workspaceName,
    createdByActorId: row.createdByActorId ?? null,
    title: row.title?.trim() || "Untitled idea",
    description: row.description ?? "",
    status: toStatus(row.status),
    archived: Boolean(row.archived),
    createdAt: row.createdAt ?? "",
    updatedAt: row.updatedAt ?? row.createdAt ?? "",
  };
}

export type IdeasApi = {
  createIdea: (input: {
    teamId: string;
    title: string;
    description?: string;
    workspaceId?: string | null;
  }) => Promise<Idea>;
  updateStatus: (ideaId: string, status: IdeaStatus) => Promise<void>;
  updateContent: (
    ideaId: string,
    patch: { title?: string; description?: string },
  ) => Promise<void>;
  archive: (ideaId: string) => Promise<void>;
  unarchive: (ideaId: string) => Promise<void>;
  listIdeas: (teamId: string, options?: { includeArchived?: boolean }) => Promise<Idea[]>;
};

export function createIdeasApi(args: {
  getAccessToken: () => Promise<string | null>;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}): IdeasApi {
  const client = createCloudApiClient({
    baseUrl: args.baseUrl ?? cloudApiBaseUrl(),
    getAccessToken: args.getAccessToken,
    fetchImpl: args.fetchImpl,
  });

  async function fetchBucket(teamId: string, archived: boolean): Promise<CloudIdea[]> {
    const rows: CloudIdea[] = [];
    let cursor: string | null = null;
    do {
      let path = `/v1/ideas?teamId=${encodeURIComponent(teamId)}&limit=200&archived=${archived}`;
      if (cursor) path += `&cursor=${encodeURIComponent(cursor)}`;
      const page = await client.get<{ items: CloudIdea[]; nextCursor: string | null }>(path);
      rows.push(...(page.items ?? []));
      cursor = page.nextCursor ?? null;
    } while (cursor);
    return rows;
  }

  return {
    async createIdea(input) {
      const body: Record<string, unknown> = {
        teamId: input.teamId,
        title: input.title,
        description: input.description ?? "",
      };
      if (input.workspaceId != null) body.workspaceId = input.workspaceId;
      const row = await client.post<CloudIdea>("/v1/ideas", body);
      return toIdea(row, null);
    },

    async updateStatus(ideaId, status) {
      await client.patch(`/v1/ideas/${encodeURIComponent(ideaId)}`, { status });
    },

    async updateContent(ideaId, patch) {
      const body: Record<string, unknown> = {};
      if (patch.title !== undefined) body.title = patch.title;
      if (patch.description !== undefined) body.description = patch.description;
      await client.patch(`/v1/ideas/${encodeURIComponent(ideaId)}`, body);
    },

    async archive(ideaId) {
      await client.post(`/v1/ideas/${encodeURIComponent(ideaId)}/archive`, { archived: true });
    },

    async unarchive(ideaId) {
      await client.post(`/v1/ideas/${encodeURIComponent(ideaId)}/archive`, { archived: false });
    },

    async listIdeas(teamId, options = {}) {
      if (!teamId) return [];
      const buckets = options.includeArchived ? [false, true] : [false];
      const rows: CloudIdea[] = [];
      for (const archived of buckets) {
        rows.push(...(await fetchBucket(teamId, archived)));
      }
      rows.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));

      const workspaceIds = Array.from(
        new Set(rows.map((r) => r.workspaceId).filter((id): id is string => Boolean(id))),
      );
      let workspaceNames = new Map<string, string>();
      if (workspaceIds.length > 0) {
        const ws = await client.get<{ items: { id: string; name: string }[] }>(
          `/v1/workspaces?teamId=${encodeURIComponent(teamId)}&limit=200`,
        );
        workspaceNames = new Map((ws.items ?? []).map((w) => [w.id, w.name?.trim() ?? ""]));
      }

      return rows.map((row) =>
        toIdea(row, row.workspaceId ? workspaceNames.get(row.workspaceId) ?? null : null),
      );
    },
  };
}
