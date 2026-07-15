import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => {
  const store = new Map<string, string>();
  return {
    default: {
      getItem: vi.fn(async (key: string) => store.get(key) ?? null),
      setItem: vi.fn(async (key: string, value: string) => {
        store.set(key, value);
      }),
      removeItem: vi.fn(async (key: string) => {
        store.delete(key);
      }),
      _reset() {
        store.clear();
      },
    },
  };
});

import AsyncStorage from "@react-native-async-storage/async-storage";

import { createSessionsCache } from "../features/sessions/session-cache";
import type { SessionSummary } from "../features/sessions/session-types";

function summary(partial: Partial<SessionSummary>): SessionSummary {
  return {
    sessionId: "s1",
    teamId: "t1",
    title: "Session",
    summary: "",
    lastMessagePreview: "",
    lastMessageAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    createdBy: "actor-1",
    participantCount: 1,
    participantActorIds: [],
    hasUnread: false,
    ...partial,
  };
}

describe("session-cache", () => {
  beforeEach(() => {
    (AsyncStorage as unknown as { _reset: () => void })._reset();
    vi.clearAllMocks();
  });

  it("returns null for an unseen team", async () => {
    const cache = createSessionsCache();
    expect(await cache.load("team-1")).toBeNull();
  });

  it("returns null when the teamId is empty", async () => {
    const cache = createSessionsCache();
    expect(await cache.load("")).toBeNull();
  });

  it("round-trips a list of sessions", async () => {
    const cache = createSessionsCache();
    const items: SessionSummary[] = [summary({ sessionId: "a" }), summary({ sessionId: "b" })];
    await cache.save("team-1", items);
    const loaded = await cache.load("team-1");
    expect(loaded?.map((s) => s.sessionId)).toEqual(["a", "b"]);
  });

  it("clamps to the head of the list to keep writes cheap", async () => {
    const cache = createSessionsCache();
    const big: SessionSummary[] = Array.from({ length: 250 }, (_, i) =>
      summary({ sessionId: `s${i}` }),
    );
    await cache.save("team-1", big);
    const loaded = await cache.load("team-1");
    expect(loaded).toHaveLength(200);
    expect(loaded?.[0].sessionId).toBe("s0");
    expect(loaded?.[199].sessionId).toBe("s199");
  });

  it("returns null when stored payload is not a JSON array", async () => {
    await AsyncStorage.setItem("teamclaw.sessionsCache.v1.team-1", JSON.stringify({ oops: true }));
    const cache = createSessionsCache();
    expect(await cache.load("team-1")).toBeNull();
  });

  it("clear removes the cached entry", async () => {
    const cache = createSessionsCache();
    await cache.save("team-1", [summary({})]);
    await cache.clear("team-1");
    expect(await cache.load("team-1")).toBeNull();
  });

  it("save with an empty teamId is a no-op", async () => {
    const cache = createSessionsCache();
    await cache.save("", [summary({})]);
    expect(AsyncStorage.setItem).not.toHaveBeenCalled();
  });
});
