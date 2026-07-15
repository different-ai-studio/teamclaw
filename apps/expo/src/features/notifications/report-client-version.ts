import type { CloudApiClient } from "../../lib/cloud-api/client";

export async function reportExpoClientVersion(
  client: Pick<CloudApiClient, "post">,
  teamId: string,
  args: { version: string; deviceId: string },
): Promise<void> {
  try {
    await client.post(`/v1/teams/${teamId}/client-version`, {
      clientType: "expo",
      version: args.version,
      deviceId: args.deviceId,
      build: null,
    });
  } catch {
    // ops telemetry only
  }
}
