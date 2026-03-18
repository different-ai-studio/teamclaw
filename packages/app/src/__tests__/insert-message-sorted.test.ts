import { describe, it, expect } from "vitest";
import { insertMessageSorted } from "@/lib/insert-message-sorted";
import type { Message } from "@/stores/session";

const mkMsg = (id: string, ts: number, role: "user" | "assistant" = "user"): Message =>
  ({
    id,
    sessionId: "s1",
    role,
    content: id,
    parts: [],
    timestamp: new Date(ts),
  }) as Message;

describe("insertMessageSorted", () => {
  it("inserts at correct position by timestamp (before, middle, after)", () => {
    const messages = [
      mkMsg("a", 1000),
      mkMsg("b", 2000),
      mkMsg("c", 4000),
    ];
    const before = insertMessageSorted(messages, mkMsg("x", 500));
    expect(before.map((m) => m.id)).toEqual(["x", "a", "b", "c"]);

    const middle = insertMessageSorted(messages, mkMsg("y", 2500));
    expect(middle.map((m) => m.id)).toEqual(["a", "b", "y", "c"]);

    const after = insertMessageSorted(messages, mkMsg("z", 5000));
    expect(after.map((m) => m.id)).toEqual(["a", "b", "c", "z"]);
  });

  it("uses id as tiebreaker when timestamps equal", () => {
    const messages = [
      mkMsg("a", 1000),
      mkMsg("c", 2000),
    ];
    const inserted = insertMessageSorted(messages, mkMsg("b", 2000));
    expect(inserted.map((m) => m.id)).toEqual(["a", "b", "c"]);
  });

  it("handles empty array", () => {
    const inserted = insertMessageSorted([], mkMsg("x", 1000));
    expect(inserted).toHaveLength(1);
    expect(inserted[0].id).toBe("x");
  });

  it("handles missing timestamp (fallback to id)", () => {
    const messages = [
      mkMsg("a", 1000),
      mkMsg("c", 2000),
    ];
    const noTs = { ...mkMsg("b", 0), timestamp: undefined as unknown } as Message;
    const inserted = insertMessageSorted(messages, noTs);
    expect(inserted).toHaveLength(3);
    expect(inserted.some((m) => m.id === "b")).toBe(true);
  });

  it("prevents duplicate messages with same id (retry protection)", () => {
    const messages = [
      mkMsg("msg-1", 1000),
      mkMsg("msg-2", 2000),
    ];
    
    // Attempt to insert message with duplicate id
    const duplicate = mkMsg("msg-1", 1500);
    const result = insertMessageSorted(messages, duplicate);
    
    // Should NOT insert duplicate, return original array
    expect(result).toBe(messages);
    expect(result).toHaveLength(2);
    expect(result.filter((m) => m.id === "msg-1")).toHaveLength(1);
  });

  it("allows inserting new message with unique id", () => {
    const messages = [
      mkMsg("msg-1", 1000),
      mkMsg("msg-2", 2000),
    ];
    
    const newMsg = mkMsg("msg-3", 1500);
    const result = insertMessageSorted(messages, newMsg);
    
    // Should insert between msg-1 and msg-2
    expect(result).toHaveLength(3);
    expect(result.map((m) => m.id)).toEqual(["msg-1", "msg-3", "msg-2"]);
  });
});
