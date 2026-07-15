import { describe, expect, it, vi } from "vitest";

import { createActorsApi } from "../features/actors/actor-api";

function api(fetchImpl: ReturnType<typeof vi.fn>) {
  return createActorsApi({
    baseUrl: "https://cloud.test",
    getAccessToken: async () => "tok",
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
}

describe("createActorsApi", () => {
  it("listActors GETs the team directory and maps the cloud shape", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          items: [
            {
              id: "agent-1",
              teamId: "team-1",
              kind: "agent",
              displayName: "Claude",
              avatarUrl: null,
              teamRole: null,
              agentTypes: ["claude"],
              agentKind: "claude",
              defaultAgentType: "claude",
              defaultWorkspaceId: "ws-1",
              visibility: "team",
              lastActiveAt: "2026-05-20T10:00:00.000Z",
            },
          ],
          nextCursor: null,
        }),
        { status: 200 },
      ),
    );

    const rows = await api(fetchImpl).listActors("team-1");

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://cloud.test/v1/teams/team-1/actors?limit=500");
    expect(init.method).toBe("GET");
    expect(init.headers.Authorization).toBe("Bearer tok");
    // Directory drops ownerMemberId — null. Daemon routing uses the actor id.
    expect(rows[0]).toEqual({
      actorId: "agent-1",
      teamId: "team-1",
      actorType: "agent",
      displayName: "Claude",
      role: null,
      lastActiveAt: "2026-05-20T10:00:00.000Z",
      avatarUrl: null,
      agentTypes: ["claude"],
      defaultAgentType: "claude",
      defaultWorkspaceId: "ws-1",
      ownerMemberId: null,
      visibility: "team",
      agentKind: "claude",
    });
  });

  it("removeActor DELETEs the actor", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    await api(fetchImpl).removeActor("actor-1");
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://cloud.test/v1/actors/actor-1");
    expect(init.method).toBe("DELETE");
  });

  it("updateAgentDefaults PATCHes the agent defaults", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    await api(fetchImpl).updateAgentDefaults("agent-1", {
      defaultWorkspaceId: "workspace-1",
      defaultAgentType: "codex",
    });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://cloud.test/v1/agents/agent-1/defaults");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({
      defaultWorkspaceId: "workspace-1",
      defaultAgentType: "codex",
      agentKind: null,
    });
  });

  it("createReinvite POSTs to the team invites endpoint", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ token: "tok-1", expiresAt: "2026-05-29T00:00:00.000Z" }),
        { status: 200 },
      ),
    );

    await expect(
      api(fetchImpl).createReinvite({
        teamId: "team-1",
        actor: {
          actorId: "agent-1",
          teamId: "team-1",
          actorType: "agent",
          displayName: "Claude",
          role: null,
          lastActiveAt: null,
          avatarUrl: null,
          agentTypes: ["claude"],
          defaultAgentType: "claude",
          defaultWorkspaceId: "workspace-1",
          agentKind: "claude",
        },
        ttlSeconds: 60,
      }),
    ).resolves.toEqual({
      token: "tok-1",
      deeplink: "teamclaw://invite/tok-1",
      expiresAt: "2026-05-29T00:00:00.000Z",
    });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://cloud.test/v1/teams/team-1/invites");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      kind: "agent",
      displayName: "Claude",
      teamRole: null,
      agentKind: "daemon",
      ttlSeconds: 60,
      targetActorId: "agent-1",
    });
  });
});
