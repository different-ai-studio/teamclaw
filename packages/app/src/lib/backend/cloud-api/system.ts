import type { SystemBackend } from "../types";
import type { CloudApiClient } from "./http";

export function createSystemModule(client: CloudApiClient): SystemBackend {
  return {
    async heartbeat() {
      await client.post<void>("/v1/heartbeat", {});
    },
  };
}
