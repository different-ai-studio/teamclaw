import { describe, expect, it } from "vitest";
import { create as createMessage } from "@bufbuild/protobuf";
import { MessageKind, MessageSchema } from "@/lib/proto/teamclaw_pb";
import { buildAgentReplyMessageRow } from "@/lib/agent-turn-flush";

describe("agent-turn-flush", () => {
  it("buildAgentReplyMessageRow maps proto fields to cache row", () => {
    const reply = createMessage(MessageSchema, {
      messageId: "msg-1",
      sessionId: "s1",
      senderActorId: "agent-1",
      kind: MessageKind.AGENT_REPLY,
      content: "hello",
      turnId: "turn-1",
      model: "gpt-test",
      createdAt: BigInt(1_700_000_000),
    });
    const row = buildAgentReplyMessageRow("team-1", reply);
    expect(row.id).toBe("msg-1");
    expect(row.teamId).toBe("team-1");
    expect(row.kind).toBe("agent_reply");
    expect(row.turnId).toBe("turn-1");
    expect(row.createdAt).toBe(new Date(1_700_000_000_000).toISOString());
    expect(row.partsJson).toBeNull();
  });
});
