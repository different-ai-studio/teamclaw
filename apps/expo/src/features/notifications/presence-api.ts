import { cloudApiBaseUrl, createCloudApiClient } from "../../lib/cloud-api/client";

export type PresenceApi = {
  writeForeground: (deviceId: string, until: Date) => Promise<void>;
};

/** Writes foreground presence via the Cloud API (POST /v1/presence/foreground).
 * FC derives user_id from the bearer token. */
export function createPresenceApi(args: {
  getAccessToken: () => Promise<string | null>;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}): PresenceApi {
  const client = createCloudApiClient({
    baseUrl: args.baseUrl ?? cloudApiBaseUrl(),
    getAccessToken: args.getAccessToken,
    fetchImpl: args.fetchImpl,
  });
  return {
    async writeForeground(deviceId, until) {
      await client.post("/v1/presence/foreground", {
        deviceId,
        foregroundUntil: until.toISOString(),
      });
    },
  };
}
