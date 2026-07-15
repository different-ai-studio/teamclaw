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

type BootstrapTeam = {
  id: string;
  name: string | null;
  slug: string | null;
  role: string | null;
};

type BootstrapResponse = {
  memberActorId: string | null;
  teams?: BootstrapTeam[];
  memberActorIdByTeam?: Record<string, string>;
};

export function createTeamsApi(options: CreateTeamsApiOptions) {
  const client = createCloudApiClient({
    getAccessToken: options.getAccessToken,
    baseUrl: options.baseUrl ?? cloudApiBaseUrl(),
    fetchImpl: options.fetchImpl,
  });

  return {
    /**
     * The current user's team memberships. Sourced from /v1/me/bootstrap,
     * which resolves the caller's member actor across teams (mirrors the old
     * `team_members join teams` query, server-side and RLS-scoped).
     */
    async listMemberships(): Promise<{
      memberships: TeamMembership[];
      memberActorIdByTeam: Record<string, string>;
    }> {
      const data = await client.get<BootstrapResponse>("/v1/me/bootstrap");
      const memberships = (data.teams ?? []).map((team) => ({
        teamId: team.id,
        name: team.name ?? "Unnamed team",
        slug: team.slug ?? "",
        role: team.role ?? "member",
      }));
      return {
        memberships,
        memberActorIdByTeam: data.memberActorIdByTeam ?? {},
      };
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
