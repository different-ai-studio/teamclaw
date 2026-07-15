import { describe, expect, it, vi } from "vitest";

import { createConnectedAgentsStore } from "../features/actors/connected-agents-store";
import type { AgentAccessApi } from "../features/actors/agent-access-api";
import type { ConnectedAgent } from "../features/actors/connected-agent-types";

function fakeApi(agents: ConnectedAgent[]): AgentAccessApi {
  return {
    listConnectedAgents: vi.fn().mockResolvedValue(agents),
    shareAgentToTeam: vi.fn().mockResolvedValue(undefined),
    makeAgentPersonal: vi.fn().mockResolvedValue(undefined),
    listAuthorizedHumans: vi.fn().mockResolvedValue([]),
    grantAuthorizedHuman: vi.fn().mockResolvedValue(undefined),
    revokeAuthorizedHuman: vi.fn().mockResolvedValue(undefined),
    canManageAgent: vi.fn().mockResolvedValue(false),
  };
}

function fakeSubscriber() {
  const watched = new Set<string>();
  return {
    watchActor: (id: string) => { watched.add(id); },
    unwatchActor: (id: string) => { watched.delete(id); },
    watchedActors: () => new Set(watched),
    dispose: () => watched.clear(),
  };
}

describe("ConnectedAgentsStore", () => {
  it("reload populates agents and watches each agent's actor id", async () => {
    const agents: ConnectedAgent[] = [
      { agentId: "a1", displayName: "Claude", agentTypes: ["claude"],
        defaultAgentType: "claude",
        permissionLevel: "team", visibility: "team", isOwner: true,
        lastActiveAt: null },
      { agentId: "a2", displayName: "Codex", agentTypes: ["codex"],
        defaultAgentType: "codex",
        permissionLevel: "team", visibility: "team", isOwner: true,
        lastActiveAt: null },
    ];
    const sub = fakeSubscriber();
    const store = createConnectedAgentsStore({
      teamId: "t", api: fakeApi(agents), subscriber: sub,
    });
    await store.reload();
    expect(store.getState().agents.map((a) => a.agentId)).toEqual(["a1", "a2"]);
    expect(Array.from(sub.watchedActors())).toEqual(["a1", "a2"]);
  });

  it("reload diff: removes watch for dropped agent", async () => {
    const sub = fakeSubscriber();
    const initial: ConnectedAgent[] = [
      { agentId: "a1", displayName: "Claude", agentTypes: ["claude"],
        defaultAgentType: "claude",
        permissionLevel: "team", visibility: "team", isOwner: true,
        lastActiveAt: null },
    ];
    const api = fakeApi(initial);
    const store = createConnectedAgentsStore({ teamId: "t", api, subscriber: sub });
    await store.reload();
    expect(sub.watchedActors().has("a1")).toBe(true);
    (api.listConnectedAgents as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
    await store.reload();
    expect(sub.watchedActors().has("a1")).toBe(false);
  });

  it("runtime info handler updates lastActiveAt and runtimeInfoByAgentId", async () => {
    const sub = fakeSubscriber();
    const agents: ConnectedAgent[] = [
      { agentId: "a1", displayName: "Claude", agentTypes: ["claude"],
        defaultAgentType: "claude",
        permissionLevel: "team", visibility: "team", isOwner: true,
        lastActiveAt: null },
    ];
    const store = createConnectedAgentsStore({ teamId: "t", api: fakeApi(agents), subscriber: sub });
    await store.reload();
    store.handleRuntimeInfo("a1", "r1", {
      runtimeId: "r1", agentType: 1, worktree: "", branch: "",
      status: 1, startedAt: 0, currentPrompt: "", workspaceId: "",
      sessionTitle: "", toolUseCount: 0,
      availableModels: [], currentModel: "claude-sonnet-4-6",
      state: 0, stage: "", errorCode: "", errorMessage: "", failedStage: "",
      availableCommands: [],
    });
    expect(store.getState().runtimeInfoByAgentId.get("a1")?.currentModel).toBe("claude-sonnet-4-6");
    expect(store.getState().agents[0].lastActiveAt).not.toBeNull();
  });
});
