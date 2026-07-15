import { beforeEach, describe, expect, it, vi } from "vitest";

const subscribeMock = vi.fn();
const unsubscribeMock = vi.fn();

vi.mock("@/lib/mqtt-bridge", () => ({
  mqttSubscribe: subscribeMock,
  mqttUnsubscribe: unsubscribeMock,
}));

const {
  ensureSessionLiveSubscribed,
  ensureTeamSessionLiveSubscribed,
  hasTeamSessionLiveSubscription,
  resetSessionLiveSubscriptionState,
  resetSessionLiveSubscriptionStateForTests,
} = await import("./session-live-subscriptions");

beforeEach(() => {
  subscribeMock.mockReset();
  unsubscribeMock.mockReset();
  resetSessionLiveSubscriptionStateForTests();
});

describe("session live subscriptions", () => {
  it("subscribes to team wildcard live topic and skips overlapping session subscriptions", async () => {
    subscribeMock.mockResolvedValue(undefined);

    await ensureTeamSessionLiveSubscribed("team-1");
    await ensureSessionLiveSubscribed("team-1", "session-1");

    expect(subscribeMock).toHaveBeenCalledTimes(1);
    expect(subscribeMock).toHaveBeenCalledWith("amux/team-1/session/+/live");
  });

  it("resubscribes wildcard live topic after subscription state reset", async () => {
    subscribeMock.mockResolvedValue(undefined);

    await ensureTeamSessionLiveSubscribed("team-1");
    resetSessionLiveSubscriptionState();
    await ensureTeamSessionLiveSubscribed("team-1");

    expect(subscribeMock).toHaveBeenCalledTimes(2);
    expect(subscribeMock).toHaveBeenNthCalledWith(
      1,
      "amux/team-1/session/+/live",
    );
    expect(subscribeMock).toHaveBeenNthCalledWith(
      2,
      "amux/team-1/session/+/live",
    );
  });

  it("does not skip concrete session subscribe while wildcard subscribe is pending", async () => {
    let resolveWildcard: (() => void) | undefined;
    subscribeMock.mockImplementation((topic: string) => {
      if (topic === "amux/team-1/session/+/live") {
        return new Promise<void>((resolve) => {
          resolveWildcard = resolve;
        });
      }
      return Promise.resolve();
    });

    const wildcardPromise = ensureTeamSessionLiveSubscribed("team-1");
    await Promise.resolve();

    expect(hasTeamSessionLiveSubscription("team-1")).toBe(false);

    await ensureSessionLiveSubscribed("team-1", "session-1");

    expect(subscribeMock).toHaveBeenCalledTimes(2);
    expect(subscribeMock).toHaveBeenNthCalledWith(
      1,
      "amux/team-1/session/+/live",
    );
    expect(subscribeMock).toHaveBeenNthCalledWith(
      2,
      "amux/team-1/session/session-1/live",
    );

    resolveWildcard?.();
    await wildcardPromise;
    expect(hasTeamSessionLiveSubscription("team-1")).toBe(true);
    expect(unsubscribeMock).toHaveBeenCalledWith(
      "amux/team-1/session/session-1/live",
    );
  });

  it("unsubscribes overlapping concrete session topics when wildcard succeeds", async () => {
    subscribeMock.mockResolvedValue(undefined);
    unsubscribeMock.mockResolvedValue(undefined);

    await ensureSessionLiveSubscribed("team-1", "session-1");
    await ensureSessionLiveSubscribed("team-1", "session-2");
    await ensureTeamSessionLiveSubscribed("team-1");

    expect(unsubscribeMock).toHaveBeenCalledTimes(2);
    expect(unsubscribeMock).toHaveBeenCalledWith(
      "amux/team-1/session/session-1/live",
    );
    expect(unsubscribeMock).toHaveBeenCalledWith(
      "amux/team-1/session/session-2/live",
    );
    await ensureSessionLiveSubscribed("team-1", "session-1");
    expect(subscribeMock).toHaveBeenCalledTimes(3);
  });

  it("keeps wildcard subscription active when overlapping unsubscribe fails", async () => {
    subscribeMock.mockResolvedValue(undefined);
    unsubscribeMock.mockRejectedValue(new Error("unsubscribe failed"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await ensureSessionLiveSubscribed("team-1", "session-1");
      await ensureTeamSessionLiveSubscribed("team-1");

      expect(hasTeamSessionLiveSubscription("team-1")).toBe(true);
      await ensureSessionLiveSubscribed("team-1", "session-1");
      expect(subscribeMock).toHaveBeenCalledTimes(2);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("retries when a pending wildcard subscribe becomes stale after reset", async () => {
    let resolveWildcard: (() => void) | undefined;
    subscribeMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveWildcard = resolve;
        }),
    );
    subscribeMock.mockResolvedValue(undefined);

    const stalePromise = ensureTeamSessionLiveSubscribed("team-1");
    await Promise.resolve();
    resetSessionLiveSubscriptionState();

    resolveWildcard?.();
    await stalePromise;

    expect(subscribeMock).toHaveBeenCalledTimes(2);
    expect(hasTeamSessionLiveSubscription("team-1")).toBe(true);
  });

  it("retries when a pending concrete session subscribe becomes stale after reset", async () => {
    let resolveSession: (() => void) | undefined;
    subscribeMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveSession = resolve;
        }),
    );
    subscribeMock.mockResolvedValue(undefined);

    const stalePromise = ensureSessionLiveSubscribed("team-1", "session-1");
    await Promise.resolve();
    resetSessionLiveSubscriptionState();

    resolveSession?.();
    await stalePromise;

    expect(subscribeMock).toHaveBeenCalledTimes(2);
    expect(subscribeMock).toHaveBeenNthCalledWith(
      1,
      "amux/team-1/session/session-1/live",
    );
    expect(subscribeMock).toHaveBeenNthCalledWith(
      2,
      "amux/team-1/session/session-1/live",
    );
  });
});
