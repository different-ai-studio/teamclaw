import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createStreamingSnapshotStore } from "../features/sessions/streaming-snapshot";
import type { StreamingBuffer } from "../features/sessions/session-types";
import { createMemoryCacheDb } from "./helpers/memory-db";

function buffer(partial: Partial<StreamingBuffer> = {}): StreamingBuffer {
  return {
    messageId: "msg-1",
    model: "claude-sonnet-4-6",
    text: "partial output",
    kind: "agent_reply",
    startedAt: "2026-01-01T00:00:00Z",
    senderActorId: "agent-1",
    ...partial,
  };
}

let db: ReturnType<typeof createMemoryCacheDb>;
let store: ReturnType<typeof createStreamingSnapshotStore>;

beforeEach(() => {
  db = createMemoryCacheDb();
  store = createStreamingSnapshotStore(async () => db);
});

afterEach(() => {
  db.close();
});

describe("streaming snapshot", () => {
  it("has nothing to restore before anything is saved", async () => {
    expect((await store.load("s1")).size).toBe(0);
  });

  it("round-trips a partial buffer", async () => {
    await store.save("s1", new Map([["agent-1", buffer()]]));
    const restored = await store.load("s1");
    expect(restored.get("agent-1")).toEqual({ ...buffer(), isComplete: false });
  });

  it("restores as incomplete even if it was saved otherwise", async () => {
    // Marking it complete would suppress the daemon's real final message.
    await store.save("s1", new Map([["a", buffer({ isComplete: undefined })]]));
    expect((await store.load("s1")).get("a")?.isComplete).toBe(false);
  });

  it("saves one row per streaming agent", async () => {
    await store.save(
      "s1",
      new Map([
        ["agent-1", buffer({ text: "one" })],
        ["agent-2", buffer({ text: "two", senderActorId: "agent-2" })],
      ]),
    );
    const restored = await store.load("s1");
    expect(restored.get("agent-1")?.text).toBe("one");
    expect(restored.get("agent-2")?.text).toBe("two");
  });

  it("skips completed buffers — they are already on their way to the timeline", async () => {
    await store.save("s1", new Map([["a", buffer({ isComplete: true })]]));
    expect((await store.load("s1")).size).toBe(0);
  });

  it("skips empty buffers, which would restore as a blank bubble", async () => {
    await store.save("s1", new Map([["a", buffer({ text: "" })]]));
    expect((await store.load("s1")).size).toBe(0);
  });

  it("replaces the previous snapshot rather than accumulating partials", async () => {
    // Background → foreground → background is a normal cycle; without the
    // clear it would leave a chain of stale text behind.
    await store.save("s1", new Map([["a", buffer({ text: "first" })]]));
    await store.save("s1", new Map([["a", buffer({ text: "first and second" })]]));
    const restored = await store.load("s1");
    expect(restored.size).toBe(1);
    expect(restored.get("a")?.text).toBe("first and second");
  });

  it("drops an agent that stopped streaming between saves", async () => {
    await store.save(
      "s1",
      new Map([["a", buffer()], ["b", buffer({ senderActorId: "b" })]]),
    );
    await store.save("s1", new Map([["a", buffer()]]));
    const restored = await store.load("s1");
    expect([...restored.keys()]).toEqual(["a"]);
  });

  it("keeps sessions apart", async () => {
    await store.save("s1", new Map([["a", buffer({ text: "one" })]]));
    await store.save("s2", new Map([["a", buffer({ text: "two" })]]));
    expect((await store.load("s1")).get("a")?.text).toBe("one");
    expect((await store.load("s2")).get("a")?.text).toBe("two");
  });

  it("clears one session's snapshot and leaves the other", async () => {
    await store.save("s1", new Map([["a", buffer()]]));
    await store.save("s2", new Map([["a", buffer()]]));
    await store.clear("s1");
    expect((await store.load("s1")).size).toBe(0);
    expect((await store.load("s2")).size).toBe(1);
  });

  it("is a no-op on a blank session id", async () => {
    await store.save("", new Map([["a", buffer()]]));
    expect((await store.load("")).size).toBe(0);
  });

  it("survives a broken database instead of throwing at the caller", async () => {
    // Losing a snapshot costs a partial bubble; throwing on the way to the
    // background would be worse.
    const broken = createStreamingSnapshotStore(async () => {
      throw new Error("db unavailable");
    });
    await expect(broken.save("s1", new Map([["a", buffer()]]))).resolves.toBeUndefined();
    await expect(broken.load("s1")).resolves.toEqual(new Map());
    await expect(broken.clear("s1")).resolves.toBeUndefined();
  });
});
