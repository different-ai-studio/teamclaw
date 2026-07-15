import { describe, expect, it, vi } from "vitest";

import { createIdeasApi } from "../features/ideas/idea-api";

function api(fetchImpl: ReturnType<typeof vi.fn>) {
  return createIdeasApi({
    baseUrl: "https://cloud.test",
    getAccessToken: async () => "tok",
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
}

function json(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200 });
}

describe("createIdeasApi", () => {
  it("listIdeas GETs the active bucket and enriches workspace names", async () => {
    const fetchImpl = vi.fn((url: string) => {
      if (url.startsWith("https://cloud.test/v1/ideas")) {
        return Promise.resolve(
          json({
            items: [
              {
                id: "i1",
                teamId: "t1",
                workspaceId: "w1",
                createdByActorId: "a1",
                title: "Ship it",
                description: "do the thing",
                status: "in_progress",
                archived: false,
                createdAt: "2026-05-01T00:00:00Z",
                updatedAt: "2026-05-02T00:00:00Z",
              },
            ],
            nextCursor: null,
          }),
        );
      }
      return Promise.resolve(json({ items: [{ id: "w1", name: "Repo" }], nextCursor: null }));
    });

    const ideas = await api(fetchImpl).listIdeas("t1");

    expect(fetchImpl.mock.calls[0][0]).toBe(
      "https://cloud.test/v1/ideas?teamId=t1&limit=200&archived=false",
    );
    expect(fetchImpl.mock.calls[1][0]).toBe("https://cloud.test/v1/workspaces?teamId=t1&limit=200");
    expect(ideas).toEqual([
      {
        ideaId: "i1",
        teamId: "t1",
        workspaceId: "w1",
        workspaceName: "Repo",
        createdByActorId: "a1",
        title: "Ship it",
        description: "do the thing",
        status: "in_progress",
        archived: false,
        createdAt: "2026-05-01T00:00:00Z",
        updatedAt: "2026-05-02T00:00:00Z",
      },
    ]);
  });

  it("listIdeas follows the cursor and fetches both buckets when includeArchived", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn((url: string) => {
      calls.push(url);
      if (url.includes("/v1/ideas") && url.includes("archived=false") && !url.includes("cursor")) {
        return Promise.resolve(json({ items: [{ id: "i1", updatedAt: "b" }], nextCursor: "CUR" }));
      }
      if (url.includes("/v1/ideas") && url.includes("cursor=CUR")) {
        return Promise.resolve(json({ items: [{ id: "i2", updatedAt: "a" }], nextCursor: null }));
      }
      if (url.includes("/v1/ideas") && url.includes("archived=true")) {
        return Promise.resolve(json({ items: [{ id: "i3", updatedAt: "c" }], nextCursor: null }));
      }
      return Promise.resolve(json({ items: [], nextCursor: null }));
    });

    const ideas = await api(fetchImpl).listIdeas("t1", { includeArchived: true });

    // active bucket paginated (2 calls) + archived bucket (1 call); no workspace fetch (no workspaceIds).
    expect(calls.filter((u) => u.includes("/v1/ideas"))).toHaveLength(3);
    // merged + sorted by updatedAt desc: i3 (c), i1 (b), i2 (a)
    expect(ideas.map((i) => i.ideaId)).toEqual(["i3", "i1", "i2"]);
  });

  it("updateStatus PATCHes the status", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    await api(fetchImpl).updateStatus("i1", "done");
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://cloud.test/v1/ideas/i1");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({ status: "done" });
  });

  it("updateContent PATCHes only provided fields", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    await api(fetchImpl).updateContent("i1", { title: "New" });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ title: "New" });
  });

  it("archive / unarchive POST the archive endpoint with the flag", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const ideas = api(fetchImpl);
    await ideas.archive("i1");
    await ideas.unarchive("i1");
    expect(fetchImpl.mock.calls[0][0]).toBe("https://cloud.test/v1/ideas/i1/archive");
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ archived: true });
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).toEqual({ archived: false });
  });
});
