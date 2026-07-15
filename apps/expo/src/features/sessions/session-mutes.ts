import { cloudApiBaseUrl, createCloudApiClient } from "../../lib/cloud-api/client";

/**
 * Per-user, per-session mute toggle via the Cloud API. FC keys mutes on the
 * bearer user; isMuted reads the muted-session list and tests membership.
 */
export type SessionMutesApi = {
  isMuted: (sessionId: string) => Promise<boolean>;
  setMuted: (sessionId: string, muted: boolean) => Promise<void>;
};

export function createSessionMutesApi(args: {
  getAccessToken: () => Promise<string | null>;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}): SessionMutesApi {
  const client = createCloudApiClient({
    baseUrl: args.baseUrl ?? cloudApiBaseUrl(),
    getAccessToken: args.getAccessToken,
    fetchImpl: args.fetchImpl,
  });
  return {
    async isMuted(sessionId) {
      if (!sessionId) return false;
      const result = await client.get<{ items: string[] }>("/v1/sessions/muted");
      return (result.items ?? []).includes(sessionId);
    },
    async setMuted(sessionId, muted) {
      if (!sessionId) return;
      const path = `/v1/sessions/${encodeURIComponent(sessionId)}/mute`;
      if (muted) {
        await client.post(path, { until: null });
      } else {
        await client.del(path);
      }
    },
  };
}
