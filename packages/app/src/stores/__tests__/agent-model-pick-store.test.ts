import { beforeEach, describe, expect, it } from "vitest";
import {
  DRAFT_SESSION_PICK_KEY,
  useAgentModelPickStore,
} from "@/stores/agent-model-pick-store";

const AGENT = "agent-1";
const OTHER_AGENT = "agent-2";
const SESSION = "session-abc";

describe("agent model pick store — draft scope", () => {
  beforeEach(() => {
    useAgentModelPickStore.setState({ bySessionAgent: {} });
  });

  it("stores a pick made before the session exists", () => {
    const store = useAgentModelPickStore.getState();
    store.setPick(DRAFT_SESSION_PICK_KEY, AGENT, "anthropic/haiku");
    expect(
      useAgentModelPickStore.getState().getPick(DRAFT_SESSION_PICK_KEY, AGENT),
    ).toBe("anthropic/haiku");
  });

  it("promotes draft picks onto the created session and clears the draft", () => {
    const store = useAgentModelPickStore.getState();
    store.setPick(DRAFT_SESSION_PICK_KEY, AGENT, "anthropic/haiku");
    store.setPick(DRAFT_SESSION_PICK_KEY, OTHER_AGENT, "anthropic/opus");

    useAgentModelPickStore.getState().promoteDraftPicks(SESSION);

    const after = useAgentModelPickStore.getState();
    expect(after.getPick(SESSION, AGENT)).toBe("anthropic/haiku");
    expect(after.getPick(SESSION, OTHER_AGENT)).toBe("anthropic/opus");
    expect(after.getPick(DRAFT_SESSION_PICK_KEY, AGENT)).toBeUndefined();
    expect(after.getPick(DRAFT_SESSION_PICK_KEY, OTHER_AGENT)).toBeUndefined();
  });

  it("does not let a stale draft override a pick already made on the session", () => {
    const store = useAgentModelPickStore.getState();
    store.setPick(SESSION, AGENT, "anthropic/opus");
    store.setPick(DRAFT_SESSION_PICK_KEY, AGENT, "anthropic/haiku");

    useAgentModelPickStore.getState().promoteDraftPicks(SESSION);

    const after = useAgentModelPickStore.getState();
    expect(after.getPick(SESSION, AGENT)).toBe("anthropic/opus");
    expect(after.getPick(DRAFT_SESSION_PICK_KEY, AGENT)).toBeUndefined();
  });

  it("is a no-op with no draft picks pending", () => {
    const store = useAgentModelPickStore.getState();
    store.setPick(SESSION, AGENT, "anthropic/opus");
    const before = useAgentModelPickStore.getState().bySessionAgent;

    useAgentModelPickStore.getState().promoteDraftPicks(SESSION);

    expect(useAgentModelPickStore.getState().bySessionAgent).toBe(before);
  });

  it("refuses to promote onto an empty or draft target", () => {
    const store = useAgentModelPickStore.getState();
    store.setPick(DRAFT_SESSION_PICK_KEY, AGENT, "anthropic/haiku");

    useAgentModelPickStore.getState().promoteDraftPicks("  ");
    useAgentModelPickStore.getState().promoteDraftPicks(DRAFT_SESSION_PICK_KEY);

    expect(
      useAgentModelPickStore.getState().getPick(DRAFT_SESSION_PICK_KEY, AGENT),
    ).toBe("anthropic/haiku");
  });
});
