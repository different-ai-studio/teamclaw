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

import { createSessionDetailCache } from "../features/sessions/session-detail-cache";
import type {
  SessionMessage,
  SessionSummary,
} from "../features/sessions/session-types";

function summary(partial: Partial<SessionSummary> = {}): SessionSummary {
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

function message(id: string, content = `msg-${id}`): SessionMessage {
  return {
    messageId: id,
    sessionId: "s1",
    senderActorId: "actor-1",
    teamId: "t1",
    kind: "text",
    content,
    createdAt: "2026-01-01T00:00:00.000Z",
    metadata: null,
    model: "",
    replyToMessageId: "",
    turnId: "",
  };
}

describe("session-detail cache", () => {
  beforeEach(() => {
    (AsyncStorage as unknown as { _reset: () => void })._reset();
    vi.clearAllMocks();
  });

  it("returns null for an unseen session", async () => {
    const cache = createSessionDetailCache();
    expect(await cache.load("s1")).toBeNull();
  });

  it("returns null when sessionId is empty", async () => {
    const cache = createSessionDetailCache();
    expect(await cache.load("")).toBeNull();
  });

  it("round-trips session + messages", async () => {
    const cache = createSessionDetailCache();
    const entry = { session: summary(), messages: [message("a"), message("b")] };
    await cache.save("s1", entry);
    const loaded = await cache.load("s1");
    expect(loaded?.session.sessionId).toBe("s1");
    expect(loaded?.messages.map((m) => m.messageId)).toEqual(["a", "b"]);
  });

  it("clamps to the tail of the message list", async () => {
    const cache = createSessionDetailCache();
    const big = Array.from({ length: 250 }, (_, i) => message(`m${i}`));
    await cache.save("s1", { session: summary(), messages: big });
    const loaded = await cache.load("s1");
    expect(loaded?.messages).toHaveLength(200);
    // Keep the *latest* slice — older messages can re-fetch from Supabase.
    expect(loaded?.messages[0].messageId).toBe("m50");
    expect(loaded?.messages[199].messageId).toBe("m249");
  });

  it("saveMessages updates only the messages slot", async () => {
    const cache = createSessionDetailCache();
    await cache.save("s1", { session: summary(), messages: [message("a")] });
    await cache.saveMessages("s1", [message("b"), message("c")]);
    const loaded = await cache.load("s1");
    expect(loaded?.session.sessionId).toBe("s1");
    expect(loaded?.messages.map((m) => m.messageId)).toEqual(["b", "c"]);
  });

  it("clear removes both session and messages", async () => {
    const cache = createSessionDetailCache();
    await cache.save("s1", { session: summary(), messages: [message("a")] });
    await cache.clear("s1");
    expect(await cache.load("s1")).toBeNull();
  });

  it("returns an empty list when messages payload is corrupted", async () => {
    await AsyncStorage.setItem(
      "teamclaw.sessionDetail.v1.session.s1",
      JSON.stringify(summary()),
    );
    await AsyncStorage.setItem(
      "teamclaw.sessionDetail.v1.messages.s1",
      JSON.stringify({ oops: true }),
    );
    const cache = createSessionDetailCache();
    const loaded = await cache.load("s1");
    expect(loaded?.session.sessionId).toBe("s1");
    expect(loaded?.messages).toEqual([]);
  });
});
