import { describe, expect, it, vi } from "vitest";

import { createWorkspacesApi } from "../features/workspaces/workspace-api";

function api(fetchImpl: ReturnType<typeof vi.fn>) {
  return createWorkspacesApi({
    baseUrl: "https://cloud.test",
    getAccessToken: async () => "tok",
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
}

describe("createWorkspacesApi", () => {
  it("lists workspaces by team and normalises the cloud shape", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          items: [
            { id: "w1", teamId: "t1", name: "Alpha", path: "~/a", agentId: "ag1", archived: false },
            { id: "w2", teamId: "t1", name: "Beta", path: null, agentId: null, archived: true },
          ],
          nextCursor: null,
        }),
        { status: 200 },
      ),
    );

    const rows = await api(fetchImpl).list("t1");

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://cloud.test/v1/workspaces?teamId=t1&limit=200");
    expect(init.method).toBe("GET");
    expect(init.headers.Authorization).toBe("Bearer tok");
    expect(rows).toEqual([
      { id: "w1", teamId: "t1", name: "Alpha", path: "~/a", agentId: "ag1", archived: false },
      { id: "w2", teamId: "t1", name: "Beta", path: null, agentId: null, archived: true },
    ]);
  });

  it("creates a workspace with createdByMemberId", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ id: "w3", teamId: "t1", name: "Gamma", path: null, agentId: null, archived: false }),
        { status: 200 },
      ),
    );

    const created = await api(fetchImpl).create({ teamId: "t1", name: "Gamma", createdByMemberId: "m1" });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://cloud.test/v1/workspaces");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      teamId: "t1",
      name: "Gamma",
      createdByMemberId: "m1",
      archived: false,
    });
    expect(created.id).toBe("w3");
  });

  it("PATCHes archived, path and agent binding", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const ws = api(fetchImpl);

    await ws.setArchived("w1", true);
    await ws.setPath("w1", "~/code/repo");
    await ws.bindAgent("w1", "ag9");
    await ws.bindAgent("w1", null);

    const bodies = fetchImpl.mock.calls.map(([url, init]) => ({
      url,
      method: init.method,
      body: JSON.parse(init.body),
    }));
    expect(bodies).toEqual([
      { url: "https://cloud.test/v1/workspaces/w1", method: "PATCH", body: { archived: true } },
      { url: "https://cloud.test/v1/workspaces/w1", method: "PATCH", body: { path: "~/code/repo" } },
      { url: "https://cloud.test/v1/workspaces/w1", method: "PATCH", body: { agentId: "ag9" } },
      { url: "https://cloud.test/v1/workspaces/w1", method: "PATCH", body: { agentId: null } },
    ]);
  });
});
