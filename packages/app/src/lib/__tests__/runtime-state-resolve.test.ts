import { beforeEach, describe, expect, it } from "vitest";
import { AgentType, RuntimeLifecycle } from "@/lib/proto/amux_pb";
import type { RuntimeStateEntry } from "@/stores/runtime-state-store";
import {
  agentModelDisplayLabel,
  agentModelIdsMatch,
  backendTypeFromRuntimeEntry,
  normalizeAgentModelId,
  resolveCommandRuntimeId,
  resolvePermissionCommandTarget,
  resolveRuntimeIdForAgent,
  resolveRuntimeStateEntryForAgent,
  resolveSetModelId,
  selectAgentModel,
} from "@/lib/runtime-state-resolve";
import { useAgentModelPickStore } from "@/stores/agent-model-pick-store";

function entry(
  agentId: string,
  runtimeId: string,
  models: Array<{ id: string; displayName: string }> = [],
  state: RuntimeLifecycle = RuntimeLifecycle.ACTIVE,
): RuntimeStateEntry {
  return {
    daemonActorId: agentId,
    lastUpdated: Date.now(),
    info: {
      runtimeId,
      agentType: AgentType.OPENCODE,
      availableModels: models,
      currentModel: "",
      state,
    } as RuntimeStateEntry["info"],
  };
}

beforeEach(() => {
  useAgentModelPickStore.setState({ bySessionAgent: {} });
});

describe("resolveRuntimeStateEntryForAgent", () => {
  it("finds retain by daemon device id when DB runtime id differs", () => {
    const byRuntimeId = {
      "agent-mac": entry("agent-mac", "agent-mac", [{ id: "m-1", displayName: "Model 1" }]),
    };
    const resolved = resolveRuntimeStateEntryForAgent("agent-mac", byRuntimeId, "uuid-from-db");
    expect(resolved?.info.availableModels).toHaveLength(1);
    expect(resolveRuntimeIdForAgent("agent-mac", byRuntimeId, "uuid-from-db")).toBe("agent-mac");
  });

  it("prefers the newest retain when agent uuid and spawn id keys both exist", () => {
    const agentUuid = "b3cbc44e-0000-4000-8000-000000000001";
    const spawnId = "b8b6b82a";
    const stale = entry(agentUuid, spawnId, [{ id: "big-pickle", displayName: "Big Pickle" }]);
    stale.info.currentModel = "big-pickle";
    stale.lastUpdated = 1;
    const fresh = entry(agentUuid, spawnId, [
      { id: "big-pickle", displayName: "Big Pickle" },
      { id: "mimo-v2.5-free", displayName: "Mimo" },
    ]);
    fresh.info.currentModel = "mimo-v2.5-free";
    fresh.lastUpdated = 2;
    const byRuntimeId = {
      [agentUuid]: stale,
      [spawnId]: fresh,
    };
    expect(resolveRuntimeStateEntryForAgent(agentUuid, byRuntimeId)?.info.currentModel).toBe(
      "mimo-v2.5-free",
    );
  });

  it("ignores stale DB runtime id key that does not match the agent", () => {
    const agentUuid = "b3cbc44e-0000-4000-8000-000000000001";
    const spawnId = "b8b6b82a";
    const live = entry(agentUuid, spawnId);
    const byRuntimeId = {
      [agentUuid]: live,
      "stale-db-uuid": entry("other-agent", "other-rt"),
    };
    expect(resolveRuntimeStateEntryForAgent(agentUuid, byRuntimeId, "stale-db-uuid")).toBe(live);
    expect(resolveRuntimeIdForAgent(agentUuid, byRuntimeId, "stale-db-uuid")).toBe(spawnId);
  });

  it("prefers proto runtime_id over MQTT store key when both index the same retain", () => {
    const agentUuid = "b3cbc44e-0000-4000-8000-000000000001";
    const spawnId = "b8b6b82a";
    const shared = entry(agentUuid, spawnId, [{ id: "opencode/big-pickle", displayName: "Big Pickle" }]);
    const byRuntimeId = {
      [agentUuid]: shared,
      [spawnId]: shared,
    };
    expect(resolveRuntimeIdForAgent(agentUuid, byRuntimeId)).toBe(spawnId);
  });

  it("falls back to DB runtime id when no retain exists yet", () => {
    expect(resolveRuntimeIdForAgent("a-1", {}, "rt-from-db")).toBe("rt-from-db");
  });

  it("derives backend type from runtime agent type", () => {
    expect(backendTypeFromRuntimeEntry(entry("a", "a"), null)).toBe("opencode");
  });
});

describe("agentModelIdsMatch", () => {
  it("treats prefixed and short ids as the same model", () => {
    const available = [{ id: "big-pickle", displayName: "Big Pickle" }];
    expect(agentModelIdsMatch("opencode/big-pickle", "big-pickle", available)).toBe(true);
  });
});

describe("agentModelDisplayLabel", () => {
  it("prefers exact id row over earlier fuzzy alias in the list", () => {
    const available = [
      { id: "alibaba-cn/qwen3-coder-plus", displayName: "Alibaba (China)/QwQ Plus" },
      { id: "opencode/mimo-v2.5-free (medium)", displayName: "OpenCode Zen/MiMo V2.5 Free (medium)" },
    ];
    expect(agentModelDisplayLabel("opencode/mimo-v2.5-free (medium)", available)).toBe(
      "OpenCode Zen/MiMo V2.5 Free (medium)",
    );
  });
});

describe("selectAgentModel — canonical model resolver", () => {
  const agentUuid = "agent-mac";
  const sessionId = "session-1";
  const available = [
    { id: "big-pickle", displayName: "Big Pickle" },
    { id: "mimo-v2.5-free", displayName: "Mimo" },
  ];
  const byRuntimeId = {
    [agentUuid]: {
      ...entry(agentUuid, "rt-1", available),
      info: { ...entry(agentUuid, "rt-1", available).info, currentModel: "big-pickle" },
    },
  };

  it("pick always wins over MQTT retain — regression test for 弹回去 bug", () => {
    useAgentModelPickStore.getState().setPick(sessionId, agentUuid, "mimo-v2.5-free");
    const res = selectAgentModel({ sessionId, agentId: agentUuid, available, byRuntimeId });
    expect(res.source).toBe("pick");
    expect(res.modelId).toBe("mimo-v2.5-free");
  });

  it("falls back to retain when there is no user pick", () => {
    const res = selectAgentModel({ sessionId, agentId: agentUuid, available, byRuntimeId });
    expect(res.source).toBe("retain");
    expect(res.modelId).toBe("big-pickle");
  });

  it("falls back to provider/model key when neither pick nor retain available", () => {
    const empty = { ...byRuntimeId, [agentUuid]: { ...byRuntimeId[agentUuid], info: { ...byRuntimeId[agentUuid].info, currentModel: "" } } };
    const res = selectAgentModel({
      sessionId,
      agentId: agentUuid,
      available,
      byRuntimeId: empty,
      providerFallback: "openai/gpt-4o",
    });
    expect(res.source).toBe("fallback");
    expect(res.modelId).toBe("openai/gpt-4o");
  });

  it("falls back to provider fallback when neither pick nor retain available", () => {
    const empty = { ...byRuntimeId, [agentUuid]: { ...byRuntimeId[agentUuid], info: { ...byRuntimeId[agentUuid].info, currentModel: "" } } };
    const res = selectAgentModel({
      sessionId,
      agentId: agentUuid,
      available,
      byRuntimeId: empty,
      providerFallback: "mimo-v2.5-free",
    });
    expect(res.source).toBe("fallback");
    expect(res.modelId).toBe("mimo-v2.5-free");
  });

  it("returns none when nothing can be resolved", () => {
    const res = selectAgentModel({
      sessionId: null,
      agentId: agentUuid,
      available: [],
      byRuntimeId: {},
    });
    expect(res.source).toBe("none");
    expect(res.modelId).toBe("");
  });

  it("canonicalizes short pick to advertised prefixed id", () => {
    useAgentModelPickStore.getState().setPick(sessionId, agentUuid, "mimo-v2.5-free");
    const prefixed = [{ id: "opencode/mimo-v2.5-free", displayName: "Mimo" }];
    const prefixByRuntime = {
      [agentUuid]: {
        ...entry(agentUuid, "rt-1", prefixed),
        info: { ...entry(agentUuid, "rt-1", prefixed).info, currentModel: "" },
      },
    };
    const res = selectAgentModel({
      sessionId,
      agentId: agentUuid,
      available: prefixed,
      byRuntimeId: prefixByRuntime,
    });
    expect(res.source).toBe("pick");
    expect(res.modelId).toBe("opencode/mimo-v2.5-free");
  });

  it("ignores empty session id when reading pick", () => {
    useAgentModelPickStore.getState().setPick(sessionId, agentUuid, "mimo-v2.5-free");
    const res = selectAgentModel({
      sessionId: "",
      agentId: agentUuid,
      available,
      byRuntimeId,
    });
    expect(res.source).toBe("retain");
    expect(res.modelId).toBe("big-pickle");
  });
});

describe("resolveSetModelId", () => {
  it("uses short id when retain advertises short ids", () => {
    const byRuntimeId = {
      "agent-mac": entry("agent-mac", "rt-1", [
        { id: "big-pickle", displayName: "Big Pickle" },
      ]),
    };
    expect(resolveSetModelId("agent-mac", "opencode/big-pickle", byRuntimeId)).toBe(
      "big-pickle",
    );
  });
});

describe("resolvePermissionCommandTarget", () => {
  it("prefers session runtime row over fresher stale retain", () => {
    const byRuntimeId = {
      "stale-spawn": {
        ...entry("agent-a", "stale-spawn", [], RuntimeLifecycle.STOPPED),
        lastUpdated: Date.now() + 10_000,
      },
      "live-spawn": entry("agent-a", "live-spawn"),
    };
    const target = resolvePermissionCommandTarget({
      agentActorId: "agent-a",
      sessionRuntimeRows: [{ agent_id: "agent-a", runtime_id: "live-spawn" }],
      byRuntimeId,
    });
    expect(target).toEqual({ actorId: "agent-a", runtimeId: "live-spawn" });
  });

  it("prefers live MQTT retain when it is registered for the session and DB row is stale", () => {
    const byRuntimeId = {
      "live-spawn": entry("agent-a", "live-spawn"),
    };
    const target = resolvePermissionCommandTarget({
      agentActorId: "agent-a",
      sessionRuntimeRows: [
        { agent_id: "agent-a", runtime_id: "stale-spawn" },
        { agent_id: "agent-a", runtime_id: "live-spawn" },
      ],
      byRuntimeId,
    });
    expect(target).toEqual({ actorId: "agent-a", runtimeId: "live-spawn" });
  });

  it("does not follow MQTT retain from another session when DB row disagrees", () => {
    const byRuntimeId = {
      "other-session-spawn": entry("agent-a", "other-session-spawn"),
    };
    const target = resolvePermissionCommandTarget({
      agentActorId: "agent-a",
      sessionRuntimeRows: [{ agent_id: "agent-a", runtime_id: "session-spawn" }],
      byRuntimeId,
    });
    expect(target).toEqual({ actorId: "agent-a", runtimeId: "session-spawn" });
  });

  it("does not follow MQTT retain from another session when agent has no DB row", () => {
    const byRuntimeId = {
      "other-session-spawn": entry("agent-a", "other-session-spawn"),
    };
    const target = resolvePermissionCommandTarget({
      agentActorId: "agent-a",
      sessionRuntimeRows: [{ agent_id: "agent-b", runtime_id: "agent-b-spawn" }],
      byRuntimeId,
    });
    expect(target).toBeNull();
  });

  it("prefers live MQTT when API returns stale dead runtime_id only", () => {
    const byRuntimeId = {
      "rt-stale": entry("agent-a", "rt-stale", [], RuntimeLifecycle.STOPPED),
      "rt-live": entry("agent-a", "rt-live"),
    };
    const target = resolvePermissionCommandTarget({
      agentActorId: "agent-a",
      sessionRuntimeRows: [{ agent_id: "agent-a", runtime_id: "rt-stale" }],
      byRuntimeId,
    });
    expect(target).toEqual({ actorId: "agent-a", runtimeId: "rt-live" });
  });
});

describe("resolveCommandRuntimeId", () => {
  it("prefers live MQTT retain when DB hint is dead on MQTT", () => {
    const byRuntimeId = {
      "rt-stale": entry("agent-a", "rt-stale", [], RuntimeLifecycle.STOPPED),
      "rt-live": entry("agent-a", "rt-live"),
    };
    expect(
      resolveCommandRuntimeId({
        agentId: "agent-a",
        dbRuntimeId: "rt-stale",
        byRuntimeId,
        sessionRuntimeIds: new Set(["rt-stale"]),
      }),
    ).toBe("rt-live");
  });

  it("returns undefined when DB hint and all MQTT retains are dead", () => {
    const byRuntimeId = {
      "rt-db": entry("agent-a", "rt-db", [], RuntimeLifecycle.STOPPED),
    };
    expect(
      resolveCommandRuntimeId({
        agentId: "agent-a",
        dbRuntimeId: "rt-db",
        byRuntimeId,
      }),
    ).toBeUndefined();
  });

  it("prefers a newer live spawn over a stale db hint when no session scope", () => {
    const now = Date.now();
    const byRuntimeId = {
      "rt-stale": { ...entry("agent-a", "rt-stale"), lastUpdated: now - 1000 },
      "rt-live": { ...entry("agent-a", "rt-live"), lastUpdated: now },
      "agent-a": { ...entry("agent-a", "rt-stale"), lastUpdated: now - 1000 },
    };
    expect(
      resolveCommandRuntimeId({
        agentId: "agent-a",
        dbRuntimeId: "rt-stale",
        byRuntimeId,
      }),
    ).toBe("rt-live");
  });
});

describe("normalizeAgentModelId", () => {
  it("maps short picker ids to advertised ACP model ids", () => {
    const byRuntimeId = {
      "agent-mac": entry("agent-mac", "agent-mac", [
        { id: "opencode/mimo-v2.5-free", displayName: "Mimo" },
      ]),
    };
    expect(normalizeAgentModelId("agent-mac", "mimo-v2.5-free", byRuntimeId)).toBe(
      "opencode/mimo-v2.5-free",
    );
  });
});
