import {
  cloudApiBaseUrl,
  createCloudApiClient,
} from "../../lib/cloud-api/client";

export type TeamMembership = {
  teamId: string;
  name: string;
  slug: string;
  role: string;
};

type CreateTeamsApiOptions = {
  getAccessToken: () => Promise<string | null>;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
};

type ListedTeam = {
  id: string;
  name: string | null;
  slug: string | null;
  role: string | null;
  isMember?: boolean;
};

type ListTeamsResponse = {
  items?: ListedTeam[];
};

export function createTeamsApi(options: CreateTeamsApiOptions) {
  const client = createCloudApiClient({
    getAccessToken: options.getAccessToken,
    baseUrl: options.baseUrl ?? cloudApiBaseUrl(),
    fetchImpl: options.fetchImpl,
  });

  return {
    /**
     * The current user's team memberships, from the canonical cross-org
     * team listing. Actor IDs are deliberately team-contextual and come from
     * `POST /v1/teams/{teamId}/activate`, not this list.
     */
    async listMemberships(): Promise<{
      memberships: TeamMembership[];
    }> {
      const data = await client.get<ListTeamsResponse>("/v1/teams?scope=all");
      const memberships = (data.items ?? []).filter((team) => team.isMember !== false).map((team) => ({
        teamId: team.id,
        name: team.name ?? "Unnamed team",
        slug: team.slug ?? "",
        role: team.role ?? "member",
      }));
      return { memberships };
    },

    async renameTeam(teamId: string, name: string): Promise<void> {
      await client.patch(`/v1/teams/${encodeURIComponent(teamId)}`, { name });
    },

    /** Leave a team by removing the caller's member actor row. */
    async leaveTeam(teamId: string, actorId: string): Promise<void> {
      await client.del(
        `/v1/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(actorId)}`,
      );
    },
  };
}
