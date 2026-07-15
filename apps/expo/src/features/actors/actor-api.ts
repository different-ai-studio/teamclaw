import { cloudApiBaseUrl, createCloudApiClient } from "../../lib/cloud-api/client";
import type { Actor, ActorType } from "./actor-types";

/**
 * Cloud-only actors provider. Mirrors the iOS CloudAPIActorRepository: the team
 * directory (GET /v1/teams/:id/actors) is the single source for actor rows.
 *
 * NOTE — the directory does NOT carry `ownerMemberId` (it lives on the agents
 * table, not the actor_directory view). Like iOS, owner-gating moves to
 * GET /v1/agents/:id/permission (see agent-access-api). Daemon routing uses the
 * agent's actor id (== actorId) directly — there is no separate device id.
 */

// FC mapDirectoryActor camelCase shape.
type CloudActor = {
  id: string;
  teamId?: string | null;
  kind?: string | null;
  displayName?: string | null;
  avatarUrl?: string | null;
  teamRole?: string | null;
  agentTypes?: string[] | null;
  agentKind?: string | null;
  defaultAgentType?: string | null;
  defaultWorkspaceId?: string | null;
  visibility?: string | null;
  lastActiveAt?: string | null;
};

export type ActorInviteResult = {
  token: string;
  deeplink: string;
  expiresAt: string;
};

function toActorType(value: string | null | undefined): ActorType {
  switch (value) {
    case "agent":
      return "agent";
    case "external":
      return "external";
    case "member":
    default:
      return "member";
  }
}

function toActor(row: CloudActor): Actor {
  const agentTypes = row.agentTypes ?? [];
  const defaultAgentType = row.defaultAgentType ?? null;
  return {
    actorId: row.id,
    teamId: row.teamId ?? "",
    actorType: toActorType(row.kind),
    displayName: row.displayName?.trim() || "Unnamed",
    role: row.teamRole ?? null,
    lastActiveAt: row.lastActiveAt ?? null,
    avatarUrl: row.avatarUrl ?? null,
    agentTypes,
    defaultAgentType,
    defaultWorkspaceId: row.defaultWorkspaceId ?? null,
    // Not exposed by the directory view — sourced on demand via agent-access.
    ownerMemberId: null,
    visibility:
      row.visibility === "personal" ? "personal" : row.visibility === "team" ? "team" : null,
    agentKind: row.agentKind ?? defaultAgentType ?? agentTypes[0] ?? null,
  };
}

function buildInviteDeeplink(token: string): string {
  return `teamclaw://invite/${token}`;
}

export type ActorsApi = {
  listActors: (teamId: string) => Promise<Actor[]>;
  listActorSessionIds: (actorId: string) => Promise<string[]>;
  removeActor: (actorId: string) => Promise<void>;
  updateAgentDefaults: (
    agentId: string,
    patch: { defaultWorkspaceId?: string | null; defaultAgentType?: string | null },
  ) => Promise<void>;
  updateCurrentActorProfile: (
    actorId: string,
    patch: { displayName: string; avatarUrl: string | null },
  ) => Promise<void>;
  createReinvite: (input: {
    teamId: string;
    actor: Actor;
    ttlSeconds?: number;
  }) => Promise<ActorInviteResult>;
  createInvite: (input: {
    teamId: string;
    kind: "member" | "agent";
    displayName: string;
    teamRole?: string | null;
    agentKind?: string | null;
    ttlSeconds?: number;
  }) => Promise<ActorInviteResult>;
};

export function createActorsApi(args: {
  getAccessToken: () => Promise<string | null>;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}): ActorsApi {
  const client = createCloudApiClient({
    baseUrl: args.baseUrl ?? cloudApiBaseUrl(),
    getAccessToken: args.getAccessToken,
    fetchImpl: args.fetchImpl,
  });

  return {
    async listActors(teamId) {
      if (!teamId) return [];
      const result = await client.get<{ items: CloudActor[] }>(
        `/v1/teams/${encodeURIComponent(teamId)}/actors?limit=500`,
      );
      return (result.items ?? []).map(toActor);
    },

    async listActorSessionIds(actorId) {
      if (!actorId) return [];
      const result = await client.get<{ items: string[] }>(
        `/v1/actors/${encodeURIComponent(actorId)}/sessions`,
      );
      return result.items ?? [];
    },

    async removeActor(actorId) {
      await client.del(`/v1/actors/${encodeURIComponent(actorId)}`);
    },

    async updateAgentDefaults(agentId, patch) {
      await client.patch(`/v1/agents/${encodeURIComponent(agentId)}/defaults`, {
        defaultWorkspaceId: patch.defaultWorkspaceId ?? null,
        defaultAgentType: patch.defaultAgentType ?? null,
        agentKind: null,
      });
    },

    async updateCurrentActorProfile(actorId, patch) {
      await client.patch(`/v1/actors/${encodeURIComponent(actorId)}/profile`, {
        displayName: patch.displayName,
        avatarUrl: patch.avatarUrl,
      });
    },

    async createReinvite({ teamId, actor, ttlSeconds = 60 * 60 * 24 * 7 }) {
      const kind = actor.actorType === "agent" ? "agent" : "member";
      const row = await client.post<{ token?: string; deeplink?: string; expiresAt?: string }>(
        `/v1/teams/${encodeURIComponent(teamId)}/invites`,
        {
          kind,
          displayName: actor.displayName,
          teamRole: kind === "member" ? actor.role ?? "member" : null,
          agentKind: kind === "agent" ? "daemon" : null,
          ttlSeconds,
          targetActorId: actor.actorId,
        },
      );
      if (!row?.token) throw new Error("Invite created but token was missing.");
      return {
        token: row.token,
        deeplink: row.deeplink || buildInviteDeeplink(row.token),
        expiresAt: row.expiresAt ?? "",
      };
    },

    async createInvite({
      teamId,
      kind,
      displayName,
      teamRole = null,
      agentKind = null,
      ttlSeconds = 60 * 60 * 24 * 7,
    }) {
      const row = await client.post<{ token?: string; deeplink?: string; expiresAt?: string }>(
        `/v1/teams/${encodeURIComponent(teamId)}/invites`,
        {
          kind,
          displayName,
          teamRole: kind === "member" ? teamRole : null,
          agentKind: kind === "agent" ? agentKind : null,
          ttlSeconds,
          targetActorId: null,
        },
      );
      if (!row?.token) throw new Error("Invite created but token was missing.");
      return {
        token: row.token,
        deeplink: row.deeplink || buildInviteDeeplink(row.token),
        expiresAt: row.expiresAt ?? "",
      };
    },
  };
}
