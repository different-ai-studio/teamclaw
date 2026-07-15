import { cloudApiBaseUrl, createCloudApiClient } from "../../lib/cloud-api/client";

export type PushTokenUpload = {
  /** Kept for the call site; identity is derived server-side from the bearer. */
  userId: string;
  deviceId: string;
  /** "ios" | "android" — matches the iOS PushService convention. */
  platform: string;
  /** "apns" today; "fcm" can be enabled after the FC dispatcher supports it. */
  provider: string;
  /** Native push token returned by Expo Notifications / APNs. */
  token: string;
  appVersion?: string | null;
};

export type PushTokenApi = {
  upload: (input: PushTokenUpload) => Promise<void>;
};

/** Registers the device push token via the Cloud API (POST
 * /v1/devices/push-token). FC derives user_id from the bearer token. */
export function createPushTokenApi(args: {
  getAccessToken: () => Promise<string | null>;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}): PushTokenApi {
  const client = createCloudApiClient({
    baseUrl: args.baseUrl ?? cloudApiBaseUrl(),
    getAccessToken: args.getAccessToken,
    fetchImpl: args.fetchImpl,
  });
  return {
    async upload(input) {
      await client.post("/v1/devices/push-token", {
        deviceId: input.deviceId,
        platform: input.platform,
        provider: input.provider,
        token: input.token,
        appVersion: input.appVersion ?? null,
      });
    },
  };
}
