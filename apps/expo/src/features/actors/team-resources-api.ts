import { cloudApiBaseUrl, createCloudApiClient } from "../../lib/cloud-api/client";

/**
 * Read-only view of the team-shared resources an actor detail screen reports:
 * which skills and MCP servers an actor has installed, and the team's
 * environment keys. Ported from iOS `CloudAPITeamResourceRepository`.
 *
 * Read-only on purpose. Installing is a desktop concern (it writes a local
 * lockfile alongside the server row), and MCP refuses installs on anyone else's
 * behalf outright, so a phone that could install for the agent it is looking at
 * would be lying about what it did.
 */

/**
 * The three kinds do NOT share a scope, and the difference is load-bearing for
 * any UI showing them side by side:
 *
 * - `skills` are genuinely per-actor (`team_skill_installs.actor_id`).
 * - `mcp` is per-actor to *read* and self-only to *write*.
 * - `env` has no actor dimension at all — `team_env_secrets` is keyed
 *   `(team, keyId)`, so every actor in a team reports the same number.
 */
export type TeamResourceKind = "skills" | "mcp" | "env";

/** Whether the count varies per actor. `env` does not. */
export function isActorScopedResource(kind: TeamResourceKind): boolean {
  return kind !== "env";
}

export type TeamSkill = {
  id: string;
  slug: string;
  summary: string;
  category: string;
  /** The field that lets two similar skills be told apart at a glance. */
  whenToUse: string;
  status: string;
  latestVersion: number;
  /** Whether the subject actor — not necessarily the caller — has it. */
  installed: boolean;
  installedVersion: number | null;
  /** `global` | `workspace`, or null when not installed. */
  installScope: string | null;
  hasUpdate: boolean;
};

export type TeamMcpServer = {
  id: string;
  name: string;
  /** `local` | `remote`. */
  transport: string;
  description: string | null;
  /** For `local`: the command it runs. For `remote`: null. */
  command: string | null;
  /** For `remote`: the endpoint. For `local`: null. */
  url: string | null;
  installed: boolean;
};

/**
 * A team environment variable, **name only**. The value never leaves the server
 * in the clear: it is an AES-GCM envelope this client has no key for, so a list
 * here can show which variables exist and when they changed, never what they
 * hold.
 */
export type TeamEnvSecret = {
  keyId: string;
  updatedAt: string | null;
};

export type TeamResourceCounts = {
  skills: number;
  mcp: number;
  env: number;
};

export const zeroTeamResourceCounts: TeamResourceCounts = { skills: 0, mcp: 0, env: 0 };

export function resourceCount(counts: TeamResourceCounts, kind: TeamResourceKind): number {
  return counts[kind];
}

type CloudSkill = {
  id: string;
  slug: string;
  summary?: string | null;
  category?: string | null;
  whenToUse?: string | null;
  status?: string | null;
  latestVersion?: number | null;
  installed?: boolean | null;
  installedVersion?: number | null;
  installScope?: string | null;
  hasUpdate?: boolean | null;
};

type CloudMcpServer = {
  id: string;
  name: string;
  transport?: string | null;
  description?: string | null;
  command?: string | null;
  url?: string | null;
  installed?: boolean | null;
};

type CloudEnvSecret = {
  keyId: string;
  updatedAt?: string | null;
};

function byText(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: "base" });
}

export type TeamResourcesApi = {
  /** `actorId` selects whose install state decorates each row; null means the caller. */
  listSkills: (teamId: string, actorId: string | null) => Promise<TeamSkill[]>;
  listMcpServers: (teamId: string, actorId: string | null) => Promise<TeamMcpServer[]>;
  /** Team-wide: there is no actor dimension on env secrets. */
  listEnvSecrets: (teamId: string) => Promise<TeamEnvSecret[]>;
  /**
   * The three numbers together, fetched concurrently. A failing leg yields 0
   * for that number rather than failing the whole screen — these decorate a
   * detail page that is useful without them.
   */
  counts: (teamId: string, actorId: string | null) => Promise<TeamResourceCounts>;
};

export function createTeamResourcesApi(args: {
  getAccessToken: () => Promise<string | null>;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}): TeamResourcesApi {
  const client = createCloudApiClient({
    baseUrl: args.baseUrl ?? cloudApiBaseUrl(),
    getAccessToken: args.getAccessToken,
    fetchImpl: args.fetchImpl,
  });

  function actorQuery(actorId: string | null): string {
    return actorId ? `?actorId=${encodeURIComponent(actorId)}` : "";
  }

  const api: TeamResourcesApi = {
    async listSkills(teamId, actorId) {
      if (!teamId) return [];
      const page = await client.get<{ items: CloudSkill[] }>(
        `/v1/teams/${encodeURIComponent(teamId)}/skills${actorQuery(actorId)}`,
      );
      return (page.items ?? [])
        .map((row) => ({
          id: row.id,
          slug: row.slug,
          summary: row.summary ?? "",
          category: row.category ?? "general",
          whenToUse: row.whenToUse ?? "",
          status: row.status ?? "published",
          latestVersion: row.latestVersion ?? 1,
          installed: row.installed ?? false,
          installedVersion: row.installedVersion ?? null,
          installScope: row.installScope ?? null,
          hasUpdate: row.hasUpdate ?? false,
        }))
        .sort((a, b) => byText(a.slug, b.slug));
    },

    async listMcpServers(teamId, actorId) {
      if (!teamId) return [];
      const page = await client.get<{ items: CloudMcpServer[] }>(
        `/v1/teams/${encodeURIComponent(teamId)}/mcp-servers${actorQuery(actorId)}`,
      );
      return (page.items ?? [])
        .map((row) => ({
          id: row.id,
          name: row.name,
          transport: row.transport ?? "local",
          description: row.description ?? null,
          command: row.command ?? null,
          url: row.url ?? null,
          installed: row.installed ?? false,
        }))
        .sort((a, b) => byText(a.name, b.name));
    },

    async listEnvSecrets(teamId) {
      if (!teamId) return [];
      const page = await client.get<{ items: CloudEnvSecret[] }>(
        `/v1/teams/${encodeURIComponent(teamId)}/env-secrets`,
      );
      return (page.items ?? [])
        .map((row) => ({ keyId: row.keyId, updatedAt: row.updatedAt ?? null }))
        .sort((a, b) => byText(a.keyId, b.keyId));
    },

    async counts(teamId, actorId) {
      const [skills, mcp, env] = await Promise.all([
        api.listSkills(teamId, actorId).catch(() => null),
        api.listMcpServers(teamId, actorId).catch(() => null),
        api.listEnvSecrets(teamId).catch(() => null),
      ]);
      return {
        skills: skills?.filter((row) => row.installed).length ?? 0,
        mcp: mcp?.filter((row) => row.installed).length ?? 0,
        env: env?.length ?? 0,
      };
    },
  };

  return api;
}
