import { describe, it, expect, beforeEach } from "vitest";
import { create as createMessage } from "@bufbuild/protobuf";
import { MessageSchema, MessageKind } from "@/lib/proto/teamclaw_pb";
import { useSessionMessageStore } from "./session-message-store";
import { useSessionSelectionStore } from "./session-selection-store";
import { useSessionStore } from "./session-store";

beforeEach(() => {
  useSessionMessageStore.setState({ messages: {}, messageRefreshTrigger: 0 });
  useSessionSelectionStore.setState({ activeSessionId: null, currentSessionId: null });
  useSessionStore.setState({ messages: {}, currentSessionId: null });
});

describe("session-store", () => {
  const fakeMessage = (id: string, content = "x") =>
    createMessage(MessageSchema, {
      messageId: id, sessionId: "s1", senderActorId: "a1",
      kind: MessageKind.TEXT, content, createdAt: BigInt(1),
    });

  it("appends messages", () => {
    useSessionStore.getState().appendMessage("s1", fakeMessage("m1"));
    expect(useSessionStore.getState().messages["s1"].length).toBe(1);
  });

  it("dedupes by messageId", () => {
    useSessionStore.getState().appendMessage("s1", fakeMessage("m1"));
    useSessionStore.getState().appendMessage("s1", fakeMessage("m1"));
    expect(useSessionMessageStore.getState().messages["s1"].length).toBe(1);
  });

  it("returns currentMessages for currentSessionId", () => {
    useSessionSelectionStore.setState({ currentSessionId: "s1", activeSessionId: "s1" });
    useSessionMessageStore.setState({ messages: { s1: [fakeMessage("m1")] } });
    expect(useSessionStore.getState().currentMessages().length).toBe(1);
  });
});
