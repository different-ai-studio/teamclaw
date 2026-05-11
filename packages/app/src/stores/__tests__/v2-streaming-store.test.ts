import { describe, it, expect, beforeEach } from "vitest";
import { useV2StreamingStore, selectStreamsForSession } from "../v2-streaming-store";

beforeEach(() => {
  // Reset to a clean state
  useV2StreamingStore.setState({ byKey: {} });
});

describe("v2-streaming-store", () => {
  it("appendOutput accumulates deltas for the same actor", () => {
    useV2StreamingStore.getState().appendOutput("s1", "a1", "Hello ");
    useV2StreamingStore.getState().appendOutput("s1", "a1", "world");
    const streams = selectStreamsForSession(useV2StreamingStore.getState(), "s1");
    expect(streams).toHaveLength(1);
    expect(streams[0].outputText).toBe("Hello world");
  });

  it("appendThinking is separate from output", () => {
    useV2StreamingStore.getState().appendThinking("s1", "a1", "let me think");
    useV2StreamingStore.getState().appendOutput("s1", "a1", "answer");
    const streams = selectStreamsForSession(useV2StreamingStore.getState(), "s1");
    expect(streams[0].thinkingText).toBe("let me think");
    expect(streams[0].outputText).toBe("answer");
  });

  it("clearActor removes only that actor", () => {
    useV2StreamingStore.getState().appendOutput("s1", "a1", "x");
    useV2StreamingStore.getState().appendOutput("s1", "a2", "y");
    useV2StreamingStore.getState().clearActor("s1", "a1");
    const streams = selectStreamsForSession(useV2StreamingStore.getState(), "s1");
    expect(streams).toHaveLength(1);
    expect(streams[0].actorId).toBe("a2");
  });

  it("clearSession removes all entries for that session only", () => {
    useV2StreamingStore.getState().appendOutput("s1", "a1", "x");
    useV2StreamingStore.getState().appendOutput("s2", "a1", "y");
    useV2StreamingStore.getState().clearSession("s1");
    const all = useV2StreamingStore.getState().byKey;
    expect(Object.keys(all)).toHaveLength(1);
    expect(all["s2::a1"]).toBeDefined();
  });

  it("selectStreamsForSession ignores other sessions", () => {
    useV2StreamingStore.getState().appendOutput("s1", "a1", "x");
    useV2StreamingStore.getState().appendOutput("s2", "a1", "y");
    expect(selectStreamsForSession(useV2StreamingStore.getState(), "s1")).toHaveLength(1);
    expect(selectStreamsForSession(useV2StreamingStore.getState(), "s2")).toHaveLength(1);
  });
});
