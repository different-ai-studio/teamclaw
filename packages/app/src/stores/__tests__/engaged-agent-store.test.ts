import { describe, expect, it } from "vitest";
import { useEngagedAgentStore } from "../engaged-agent-store";

describe("useEngagedAgentStore.addAgent", () => {
  it("replaces the engaged agent instead of appending", () => {
    const store = useEngagedAgentStore.getState();
    store.setAgents("s1", []);
    store.addAgent("s1", { id: "a-1", displayName: "MACPRO" });
    store.addAgent("s1", { id: "a-2", displayName: "Reviewer" });
    expect(useEngagedAgentStore.getState().getAgents("s1")).toEqual([
      { id: "a-2", displayName: "Reviewer" },
    ]);
  });

  it("setAgents keeps at most one agent", () => {
    const store = useEngagedAgentStore.getState();
    store.setAgents("s2", [
      { id: "a-1", displayName: "MACPRO" },
      { id: "a-2", displayName: "Reviewer" },
    ]);
    expect(useEngagedAgentStore.getState().getAgents("s2")).toEqual([
      { id: "a-1", displayName: "MACPRO" },
    ]);
  });
});
