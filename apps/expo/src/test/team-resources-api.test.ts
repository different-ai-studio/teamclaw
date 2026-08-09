import { describe, expect, it, vi } from "vitest";

import {
  createTeamResourcesApi,
  isActorScopedResource,
  resourceCount,
} from "../features/actors/team-resources-api";

function api(fetchImpl: ReturnType<typeof vi.fn>) {
  return createTeamResourcesApi({
    baseUrl: "https://cloud.test",
    getAccessToken: async () => "tok",
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
}

function json(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200 });
}

describe("createTeamResourcesApi", () => {
  it("listSkills scopes to the actor and sorts by slug", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      json({
        items: [
          { id: "2", slug: "zed", installed: true, installedVersion: 3, hasUpdate: true },
          { id: "1", slug: "alpha" },
        ],
      }),
    );

    const skills = await api(fetchImpl).listSkills("t1", "a1");

    expect(fetchImpl.mock.calls[0][0]).toBe("https://cloud.test/v1/teams/t1/skills?actorId=a1");
    expect(skills.map((s) => s.slug)).toEqual(["alpha", "zed"]);
    // Defaults fill in for the fields FC omits.
    expect(skills[0]).toMatchObject({
      category: "general",
      installed: false,
      installedVersion: null,
      latestVersion: 1,
      status: "published",
      hasUpdate: false,
    });
    expect(skills[1]).toMatchObject({ installed: true, installedVersion: 3, hasUpdate: true });
  });

  it("listMcpServers drops the actor query when no actor is given", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ items: [] }));
    await api(fetchImpl).listMcpServers("t1", null);
    expect(fetchImpl.mock.calls[0][0]).toBe("https://cloud.test/v1/teams/t1/mcp-servers");
  });

  it("listEnvSecrets reads the team-wide endpoint and sorts by key", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      json({ items: [{ keyId: "ZONE" }, { keyId: "API_KEY", updatedAt: "2026-05-01T00:00:00Z" }] }),
    );

    const secrets = await api(fetchImpl).listEnvSecrets("t1");

    expect(fetchImpl.mock.calls[0][0]).toBe("https://cloud.test/v1/teams/t1/env-secrets");
    expect(secrets).toEqual([
      { keyId: "API_KEY", updatedAt: "2026-05-01T00:00:00Z" },
      { keyId: "ZONE", updatedAt: null },
    ]);
  });

  it("counts only tallies installed rows, and reports 0 for a failing leg", async () => {
    const fetchImpl = vi.fn((url: string) => {
      if (url.includes("/skills")) {
        return Promise.resolve(
          json({
            items: [
              { id: "1", slug: "a", installed: true },
              { id: "2", slug: "b", installed: false },
            ],
          }),
        );
      }
      if (url.includes("/mcp-servers")) {
        return Promise.resolve(new Response("{}", { status: 500 }));
      }
      return Promise.resolve(json({ items: [{ keyId: "K1" }, { keyId: "K2" }] }));
    });

    const counts = await api(fetchImpl).counts("t1", "a1");

    expect(counts).toEqual({ skills: 1, mcp: 0, env: 2 });
    expect(resourceCount(counts, "env")).toBe(2);
  });
});

describe("isActorScopedResource", () => {
  it("marks env as team-wide and the other two as per-actor", () => {
    expect(isActorScopedResource("skills")).toBe(true);
    expect(isActorScopedResource("mcp")).toBe(true);
    expect(isActorScopedResource("env")).toBe(false);
  });
});
