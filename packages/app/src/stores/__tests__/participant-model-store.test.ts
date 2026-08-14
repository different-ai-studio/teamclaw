import { describe, it, expect, beforeEach } from "vitest";
import {
  useParticipantModelStore,
  participantModel,
  resetParticipantModelsForTests,
} from "@/stores/participant-model-store";

beforeEach(() => {
  resetParticipantModelsForTests();
});

describe("participant model cache", () => {
  it("caches by (session, actor)", () => {
    useParticipantModelStore.getState().setForSession("s1", [
      { actorId: "a1", model: "anthropic/claude-sonnet-4-6" },
      { actorId: "a2", model: "openai/gpt-5" },
    ]);
    expect(participantModel("s1", "a1")).toBe("anthropic/claude-sonnet-4-6");
    expect(participantModel("s1", "a2")).toBe("openai/gpt-5");
    // Different session, same actor: not the same answer.
    expect(participantModel("s2", "a1")).toBe("");
  });

  it("skips rows with no model rather than caching an empty answer", () => {
    // Member participants have NULL here — not applicable, not missing. Caching
    // '' for them would be indistinguishable from "we looked and found none".
    useParticipantModelStore.getState().setForSession("s1", [
      { actorId: "member-1", model: "" },
      { actorId: "agent-1", model: "a/1" },
    ]);
    expect(participantModel("s1", "member-1")).toBe("");
    expect(participantModel("s1", "agent-1")).toBe("a/1");
  });

  it("marks the session loaded so repeat fetches are skipped", () => {
    useParticipantModelStore.getState().setForSession("s1", []);
    expect(useParticipantModelStore.getState().loaded["s1"]).toBe(true);
  });

  it("returns empty for blank ids instead of building a junk key", () => {
    useParticipantModelStore.getState().setForSession("s1", [
      { actorId: "a1", model: "a/1" },
    ]);
    expect(participantModel("", "a1")).toBe("");
    expect(participantModel("s1", "")).toBe("");
    expect(participantModel(null, undefined)).toBe("");
  });
});
