import { describe, expect, it, vi } from "vitest";

import { createForegroundPresenceHeartbeat } from "../features/notifications/presence-heartbeat";

describe("createForegroundPresenceHeartbeat", () => {
  it("writes a foreground lease immediately and on every interval", async () => {
    vi.useFakeTimers();
    const writeForeground = vi.fn().mockResolvedValue(undefined);
    const heartbeat = createForegroundPresenceHeartbeat({
      deviceId: "device-1",
      leaseMs: 45_000,
      intervalMs: 20_000,
      now: () => new Date("2026-05-22T08:00:00.000Z"),
      writeForeground,
    });

    heartbeat.enterForeground();
    await Promise.resolve();

    expect(writeForeground).toHaveBeenNthCalledWith(
      1,
      "device-1",
      new Date("2026-05-22T08:00:45.000Z"),
    );

    await vi.advanceTimersByTimeAsync(20_000);
    expect(writeForeground).toHaveBeenCalledTimes(2);

    heartbeat.dispose();
    vi.useRealTimers();
  });

  it("expires the lease when entering background", async () => {
    const writeForeground = vi.fn().mockResolvedValue(undefined);
    const heartbeat = createForegroundPresenceHeartbeat({
      deviceId: "device-1",
      now: () => new Date("2026-05-22T08:00:00.000Z"),
      writeForeground,
    });

    heartbeat.enterBackground();

    expect(writeForeground).toHaveBeenCalledWith(
      "device-1",
      new Date("2026-05-22T08:00:00.000Z"),
    );
  });
});
