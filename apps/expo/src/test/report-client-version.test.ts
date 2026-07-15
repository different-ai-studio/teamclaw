import { describe, it, expect, vi } from "vitest";
import { reportExpoClientVersion } from "../features/notifications/report-client-version";

describe("reportExpoClientVersion", () => {
  it("POSTs clientType expo with version + deviceId", async () => {
    const post = vi.fn().mockResolvedValue({ ok: true });
    await reportExpoClientVersion({ post } as any, "team-1", { version: "0.1.0", deviceId: "exp-1" });
    expect(post).toHaveBeenCalledWith("/v1/teams/team-1/client-version", {
      clientType: "expo",
      version: "0.1.0",
      deviceId: "exp-1",
      build: null,
    });
  });

  it("swallows errors", async () => {
    const post = vi.fn().mockRejectedValue(new Error("net"));
    await expect(
      reportExpoClientVersion({ post } as any, "team-1", { version: "x", deviceId: "d" }),
    ).resolves.toBeUndefined();
  });
});
