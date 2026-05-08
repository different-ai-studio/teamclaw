import { describe, it, expect } from "vitest";
import type { Actor, ActorEvent } from "./types";

describe("Actor type", () => {
  it("accepts human and agent variants", () => {
    const human: Actor = {
      actorId: "u1",
      actorType: "human",
      displayName: "张三",
    };
    const agent: Actor = {
      actorId: "agent_xxx",
      actorType: "agent",
      displayName: "Claude",
      deviceId: "device_abc",
    };
    expect(human.actorType).toBe("human");
    expect(agent.deviceId).toBe("device_abc");
  });

  it("ChatMessage event carries actorId, text, mentions", () => {
    const ev: ActorEvent = {
      kind: "chat_message",
      actorId: "u1",
      timestampMs: 1000,
      text: "hi",
      mentionActorIds: ["agent_xxx"],
    };
    expect(ev.kind).toBe("chat_message");
  });
});
