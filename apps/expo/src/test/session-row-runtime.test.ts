import { describe, expect, it } from "vitest";

import type { RuntimeInfo } from "../features/actors/connected-agent-types";
import {
  buildSessionRuntimeMaps,
  runtimeStatusLabel,
  runtimeWorkspaceName,
} from "../features/sessions/session-row-runtime";
import type { SessionSummary } from "../features/sessions/session-types";

function runtime(partial: Partial<RuntimeInfo>): RuntimeInfo {
  return {
    runtimeId: "rt-1",
    agentType: 0,
    worktree: "",
    branch: "",
    status: 0,
    startedAt: 0,
    currentPrompt: "",
    workspaceId: "",
    sessionTitle: "",
    toolUseCount: 0,
    availableModels: [],
    currentModel: "",
    state: 0,
    stage: "",
    errorCode: "",
    errorMessage: "",
    failedStage: "",
    availableCommands: [],
    ...partial,
  };
}

function session(partial: Partial<SessionSummary> & { sessionId: string }): SessionSummary {
  return {
    teamId: "t1",
    title: partial.sessionId,
    summary: "",
    participantCount: 0,
    participantActorIds: [],
    lastMessagePreview: "",
    lastMessageAt: "",
    createdAt: "",
    createdBy: "",
    ...partial,
  };
}

describe("runtimeStatusLabel", () => {
  it("matches the iOS AgentAttachment.statusLabel mapping", () => {
    expect([1, 2, 3, 4, 5].map(runtimeStatusLabel)).toEqual([
      "Starting",
      "Active",
      "Idle",
      "Error",
      "Stopped",
    ]);
    // 0 / undefined means "no attachment" — the row shows no status at all,
    // rather than iOS's "Unknown" (which it also suppresses at the call site).
    expect(runtimeStatusLabel(0)).toBe("");
    expect(runtimeStatusLabel(undefined)).toBe("");
  });
});

describe("runtimeWorkspaceName", () => {
  it("prefers a cached workspace display name", () => {
    const name = runtimeWorkspaceName(
      runtime({ workspaceId: "w1", worktree: "/Users/me/repo" }),
      new Map([["w1", "Main repo"]]),
    );
    expect(name).toBe("Main repo");
  });

  it("falls back to the worktree's last path segment", () => {
    expect(runtimeWorkspaceName(runtime({ worktree: "/Users/me/projects/teamclu/" }))).toBe(
      "teamclu",
    );
    expect(runtimeWorkspaceName(runtime({ worktree: "" }))).toBe("");
  });
});

describe("buildSessionRuntimeMaps", () => {
  it("attaches the runtime of the session's agent participant", () => {
    const { runtimeBySessionId, workspaceBySessionId } = buildSessionRuntimeMaps({
      sessions: [
        session({ sessionId: "s1", participantActorIds: ["human-1", "agent-1"] }),
        session({ sessionId: "s2", participantActorIds: ["human-1"] }),
      ],
      runtimeInfoByAgentId: new Map([
        ["agent-1", runtime({ status: 2, agentType: 1, worktree: "/srv/app" })],
      ]),
      agentActorIds: new Set(["agent-1"]),
    });

    expect(runtimeBySessionId.get("s1")).toEqual({
      status: 2,
      agentType: 1,
      statusLabel: "Active",
    });
    expect(workspaceBySessionId.get("s1")).toBe("app");
    // No agent participant → no runtime, so the row renders cold.
    expect(runtimeBySessionId.has("s2")).toBe(false);
  });

  it("ignores participants that are not known agents", () => {
    const { runtimeBySessionId } = buildSessionRuntimeMaps({
      sessions: [session({ sessionId: "s1", participantActorIds: ["ghost"] })],
      runtimeInfoByAgentId: new Map([["ghost", runtime({ status: 2 })]]),
      agentActorIds: new Set(),
    });
    expect(runtimeBySessionId.size).toBe(0);
  });
});
