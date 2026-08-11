import { describe, expect, it } from "vitest";

import {
  agentBackendDisplayName,
  agentLifecycleState,
  agentTrailingLabel,
  canChangeAgentModel,
  lifecycleDotKind,
  lifecycleFromRuntimeStatus,
  runtimeStatusName,
  SPAWN_TIMEOUT_MS,
} from "../features/sessions/agent-runtime-state";

describe("runtimeStatusName", () => {
  it("names the Amux_AgentStatus enum values", () => {
    expect(runtimeStatusName(1)).toBe("starting");
    expect(runtimeStatusName(2)).toBe("active");
    expect(runtimeStatusName(3)).toBe("idle");
    expect(runtimeStatusName(4)).toBe("error");
    expect(runtimeStatusName(5)).toBe("stopped");
  });

  it("returns null for UNKNOWN and for an absent runtime", () => {
    expect(runtimeStatusName(0)).toBeNull();
    expect(runtimeStatusName(undefined)).toBeNull();
  });
});

describe("lifecycleFromRuntimeStatus", () => {
  it("accepts both spellings the daemon emits", () => {
    expect(lifecycleFromRuntimeStatus("starting")).toBe("spawning");
    expect(lifecycleFromRuntimeStatus("spawning")).toBe("spawning");
    expect(lifecycleFromRuntimeStatus("running")).toBe("active");
    expect(lifecycleFromRuntimeStatus("active")).toBe("active");
  });

  it("falls back to idle rather than inventing a failure", () => {
    expect(lifecycleFromRuntimeStatus(null)).toBe("idle");
    expect(lifecycleFromRuntimeStatus("nonsense")).toBe("idle");
  });
});

describe("agentLifecycleState", () => {
  const now = 1_700_000_000_000;

  it("keeps a fresh spawning row spawning", () => {
    expect(
      agentLifecycleState({
        status: "starting",
        lastSeenAtMs: now - 5_000,
        nowMs: now,
      }),
    ).toBe("spawning");
  });

  it("demotes a stale spawning row to idle", () => {
    // Claude Haiku never emits StatusChange:Active between spawn and the first
    // prompt, so `starting` sticks forever on a runtime that is fully alive.
    expect(
      agentLifecycleState({
        status: "starting",
        lastSeenAtMs: now - SPAWN_TIMEOUT_MS - 1,
        nowMs: now,
      }),
    ).toBe("idle");
  });

  it("only demotes spawning — other states are never aged out", () => {
    expect(
      agentLifecycleState({
        status: "error",
        lastSeenAtMs: now - 10 * SPAWN_TIMEOUT_MS,
        nowMs: now,
      }),
    ).toBe("error");
  });

  it("leaves spawning alone when there is no sighting to age against", () => {
    expect(
      agentLifecycleState({ status: "starting", lastSeenAtMs: null, nowMs: now }),
    ).toBe("spawning");
  });
});

describe("canChangeAgentModel", () => {
  const models = [{ id: "a" }, { id: "b" }];

  it("stays closed with no models — the menu would open blank", () => {
    expect(canChangeAgentModel({ availableModels: [], state: "idle" })).toBe(false);
  });

  it("stays closed for stopped and error — there is no live ACP to ask", () => {
    expect(canChangeAgentModel({ availableModels: models, state: "stopped" })).toBe(false);
    expect(canChangeAgentModel({ availableModels: models, state: "error" })).toBe(false);
  });

  it("opens for every live state, including spawning", () => {
    for (const state of ["ready", "idle", "active", "spawning"] as const) {
      expect(canChangeAgentModel({ availableModels: models, state })).toBe(true);
    }
  });
});

describe("agentTrailingLabel", () => {
  it("shows a known model even while spawning", () => {
    // The daemon resolves the model before reporting past `starting`, and the
    // dot already says the runtime is coming up.
    expect(
      agentTrailingLabel({ currentModel: "claude-sonnet-4-6", state: "spawning" }),
    ).toEqual({ kind: "model", text: "claude-sonnet-4-6" });
  });

  it("spins only in the genuinely-empty early window", () => {
    expect(agentTrailingLabel({ currentModel: null, state: "spawning" })).toEqual({
      kind: "spinner",
    });
    expect(agentTrailingLabel({ currentModel: "   ", state: "spawning" })).toEqual({
      kind: "spinner",
    });
  });

  it("says default when there is no model and no spawn in flight", () => {
    expect(agentTrailingLabel({ currentModel: null, state: "idle" })).toEqual({
      kind: "default",
    });
  });
});

describe("lifecycleDotKind", () => {
  it("maps to the same colours the chip bar uses", () => {
    expect(lifecycleDotKind("ready")).toBe("active");
    expect(lifecycleDotKind("idle")).toBe("active");
    expect(lifecycleDotKind("active")).toBe("working");
    expect(lifecycleDotKind("error")).toBe("error");
    expect(lifecycleDotKind("spawning")).toBe("muted");
    expect(lifecycleDotKind("stopped")).toBe("muted");
  });
});

describe("agentBackendDisplayName", () => {
  it("uses the canonical casing for the three known backends", () => {
    expect(agentBackendDisplayName("claude")).toBe("Claude");
    expect(agentBackendDisplayName("opencode")).toBe("OpenCode");
    expect(agentBackendDisplayName("codex")).toBe("Codex");
  });

  it("capitalises anything else, and stays empty when unknown", () => {
    expect(agentBackendDisplayName("pi")).toBe("Pi");
    expect(agentBackendDisplayName("")).toBe("");
    expect(agentBackendDisplayName(null)).toBe("");
  });
});
