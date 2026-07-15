import { cloudApiBaseUrl, createCloudApiClient } from "../../lib/cloud-api/client";

export type NotificationPrefs = {
  enabled: boolean;
  dndStartMin: number | null;
  dndEndMin: number | null;
  dndTz: string;
};

const DEFAULT_PREFS: NotificationPrefs = {
  enabled: true,
  dndStartMin: null,
  dndEndMin: null,
  dndTz: "Asia/Shanghai",
};

export type NotificationPrefsApi = {
  load: () => Promise<NotificationPrefs>;
  save: (prefs: NotificationPrefs) => Promise<void>;
};

type CloudPrefsRow = {
  enabled: boolean;
  dnd_start_min: number | null;
  dnd_end_min: number | null;
  dnd_tz: string | null;
} | null;

export function createNotificationPrefsApi(args: {
  getAccessToken: () => Promise<string | null>;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}): NotificationPrefsApi {
  const client = createCloudApiClient({
    baseUrl: args.baseUrl ?? cloudApiBaseUrl(),
    getAccessToken: args.getAccessToken,
    fetchImpl: args.fetchImpl,
  });
  return {
    async load() {
      const row = await client.get<CloudPrefsRow>("/v1/notifications/prefs");
      if (!row) return { ...DEFAULT_PREFS };
      return {
        enabled: row.enabled,
        dndStartMin: row.dnd_start_min,
        dndEndMin: row.dnd_end_min,
        dndTz: row.dnd_tz ?? DEFAULT_PREFS.dndTz,
      };
    },
    async save(prefs) {
      // FC derives user_id from the bearer token.
      await client.post("/v1/notifications/prefs", {
        enabled: prefs.enabled,
        dnd_start_min: prefs.dndStartMin,
        dnd_end_min: prefs.dndEndMin,
        dnd_tz: prefs.dndTz,
      });
    },
  };
}

export { DEFAULT_PREFS as defaultNotificationPrefs };
