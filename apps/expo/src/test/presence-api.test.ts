import { describe, expect, it, vi } from "vitest";

import { createPresenceApi } from "../features/notifications/presence-api";

describe("createPresenceApi", () => {
  it("POSTs the foreground lease to the Cloud API (user derived from bearer)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const api = createPresenceApi({
      baseUrl: "https://cloud.test",
      getAccessToken: async () => "tok",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await api.writeForeground("device-1", new Date("2026-05-22T08:00:45.000Z"));

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://cloud.test/v1/presence/foreground");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      deviceId: "device-1",
      foregroundUntil: "2026-05-22T08:00:45.000Z",
    });
  });

  it("throws when there is no access token", async () => {
    const fetchImpl = vi.fn();
    const api = createPresenceApi({
      baseUrl: "https://cloud.test",
      getAccessToken: async () => null,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(
      api.writeForeground("device-1", new Date("2026-05-22T08:00:45.000Z")),
    ).rejects.toThrow("access token");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("throws Cloud API write errors", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "rls denied" } }), { status: 403 }),
    );
    const api = createPresenceApi({
      baseUrl: "https://cloud.test",
      getAccessToken: async () => "tok",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(
      api.writeForeground("device-1", new Date("2026-05-22T08:00:45.000Z")),
    ).rejects.toThrow("rls denied");
  });
});
