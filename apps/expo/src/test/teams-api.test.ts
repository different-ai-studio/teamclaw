import { describe, expect, it, vi } from "vitest";
import { createTeamsApi } from "../features/teams/teams-api";

const BASE = "https://api.example.com";

function jsonResponse(body: unknown, init?: { status?: number }): Response {
  return new Response(body === undefined ? "" : JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });
}

function noContent(): Response {
  return new Response(null, { status: 204 });
}

function makeApi(fetchImpl: typeof fetch) {
  return createTeamsApi({
    baseUrl: BASE,
    getAccessToken: async () => "token-123",
    fetchImpl,
  });
}

function lastCall(fetchImpl: ReturnType<typeof vi.fn>) {
  const [url, init] = fetchImpl.mock.calls[fetchImpl.mock.calls.length - 1];
  return { url: url as string, init: init as RequestInit };
}

describe("createTeamsApi", () => {
  it("lists memberships from /v1/me/bootstrap", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        memberActorId: "actor-1",
        teams: [
          { id: "team-1", name: "Alpha", slug: "alpha", role: "owner" },
          { id: "team-2", name: null, slug: null, role: null },
        ],
        memberActorIdByTeam: { "team-1": "actor-1", "team-2": "actor-2" },
      }),
    );
    const api = makeApi(fetchImpl);

    const { memberships, memberActorIdByTeam } = await api.listMemberships();

    expect(memberships).toEqual([
      { teamId: "team-1", name: "Alpha", slug: "alpha", role: "owner" },
      { teamId: "team-2", name: "Unnamed team", slug: "", role: "member" },
    ]);
    expect(memberActorIdByTeam).toEqual({ "team-1": "actor-1", "team-2": "actor-2" });
    const { url, init } = lastCall(fetchImpl);
    expect(url).toBe(`${BASE}/v1/me/bootstrap`);
    expect(init.method).toBe("GET");
    expect(new Headers(init.headers ?? {}).get("Authorization")).toBe("Bearer token-123");
  });

  it("renames a team via PATCH", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(noContent());
    const api = makeApi(fetchImpl);

    await api.renameTeam("team-1", "Beta");

    const { url, init } = lastCall(fetchImpl);
    expect(url).toBe(`${BASE}/v1/teams/team-1`);
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ name: "Beta" });
  });

  it("leaves a team via DELETE on the member row", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(noContent());
    const api = makeApi(fetchImpl);

    await api.leaveTeam("team-1", "actor-1");

    const { url, init } = lastCall(fetchImpl);
    expect(url).toBe(`${BASE}/v1/teams/team-1/members/actor-1`);
    expect(init.method).toBe("DELETE");
  });
});
