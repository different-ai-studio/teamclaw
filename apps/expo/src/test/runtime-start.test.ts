import { AgentType } from "@teamclaw/app/proto/amux_pb";
import { describe, expect, it } from "vitest";

import {
  resolveAgentRuntimeRestartPlan,
  resolveAgentRuntimeStartPlans,
  resolveExpoAgentType,
} from "../features/sessions/runtime-start";

describe("runtime start planning", () => {
  it("uses the agent default workspace and backend type when available", () => {
    const plans = resolveAgentRuntimeStartPlans({
      agents: [
        {
          actorId: "agent-1",
          displayName: "Claude",
          agentTypes: ["claude", "opencode"],
          defaultAgentType: "opencode",
          defaultWorkspaceId: "workspace-default",
        },
      ],
      connectedAgents: [{ agentId: "agent-1" }],
      workspaces: [
        { id: "workspace-other", path: "/tmp/other", agentId: "agent-1" },
        { id: "workspace-default", path: "/tmp/default", agentId: null },
      ],
    });

    expect(plans).toEqual([
      {
        agentActorId: "agent-1",
        targetActorId: "agent-1",
        workspaceId: "workspace-default",
        worktree: "/tmp/default",
        agentType: AgentType.OPENCODE,
      },
    ]);
  });

  it("throws when the agent has no default or owned workspace", () => {
    expect(() =>
      resolveAgentRuntimeStartPlans({
        agents: [
          {
            actorId: "agent-1",
            displayName: "Claude",
            agentTypes: ["claude"],
            defaultAgentType: null,
            defaultWorkspaceId: null,
          },
        ],
        connectedAgents: [{ agentId: "agent-1" }],
        workspaces: [{ id: "workspace-team", path: "/tmp/teammate", agentId: null }],
      }),
    ).toThrow(/No workspace bound to Claude/i);
  });

  it("falls back to an agent-owned workspace when default is unset", () => {
    const plans = resolveAgentRuntimeStartPlans({
      agents: [
        {
          actorId: "agent-1",
          displayName: "Claude",
          agentTypes: ["claude"],
          defaultAgentType: null,
          defaultWorkspaceId: null,
        },
      ],
      connectedAgents: [{ agentId: "agent-1" }],
      workspaces: [
        { id: "workspace-team", path: "/tmp/team", agentId: null },
        { id: "workspace-owned", path: "/tmp/owned", agentId: "agent-1" },
      ],
    });

    expect(plans[0]?.workspaceId).toBe("workspace-owned");
    expect(plans[0]?.worktree).toBe("/tmp/owned");
  });

  it("lets an explicit sheet selection override defaults", () => {
    const plans = resolveAgentRuntimeStartPlans({
      agents: [
        {
          actorId: "agent-1",
          displayName: "Claude",
          agentTypes: ["claude"],
          defaultAgentType: "claude",
          defaultWorkspaceId: "workspace-default",
        },
      ],
      connectedAgents: [{ agentId: "agent-1" }],
      explicitSelection: { workspaceId: "workspace-picked", agentType: "codex" },
      workspaces: [
        { id: "workspace-default", path: "/tmp/default", agentId: null },
        { id: "workspace-picked", path: "/tmp/picked", agentId: null },
      ],
    });

    expect(plans[0]).toMatchObject({
      workspaceId: "workspace-picked",
      worktree: "/tmp/picked",
      agentType: AgentType.CODEX,
    });
  });

  it("throws when an agent's daemon is not connected", () => {
    expect(() =>
      resolveAgentRuntimeStartPlans({
        agents: [
          {
            actorId: "agent-1",
            displayName: "Claude",
            agentTypes: ["claude"],
            defaultAgentType: null,
            defaultWorkspaceId: null,
          },
        ],
        connectedAgents: [],
        workspaces: [{ id: "workspace-1", path: "/tmp/repo", agentId: null }],
      }),
    ).toThrow(/daemon is offline/i);
  });

  it("maps Expo agent type names to AMUX enum values", () => {
    expect(resolveExpoAgentType("claude")).toBe(AgentType.CLAUDE_CODE);
    expect(resolveExpoAgentType("opencode")).toBe(AgentType.OPENCODE);
    expect(resolveExpoAgentType("codex")).toBe(AgentType.CODEX);
    expect(resolveExpoAgentType("unknown")).toBe(AgentType.CLAUDE_CODE);
  });

  it("builds a restart plan from the existing runtime workspace and backend", () => {
    const plan = resolveAgentRuntimeRestartPlan({
      agent: {
        actorId: "agent-1",
        displayName: "Codex",
        agentTypes: ["claude", "codex"],
        defaultAgentType: "claude",
        defaultWorkspaceId: "workspace-default",
      },
      runtime: {
        agentId: "agent-1",
        runtimeId: "rt-old",
        workspaceId: "workspace-current",
        backendType: "codex",
      },
      connectedAgents: [{ agentId: "agent-1" }],
      workspaces: [
        { id: "workspace-default", path: "/tmp/default", agentId: null },
        { id: "workspace-current", path: "/tmp/current", agentId: "agent-1" },
      ],
    });

    expect(plan).toEqual({
      agentActorId: "agent-1",
      targetActorId: "agent-1",
      runtimeIdToStop: "rt-old",
      workspaceId: "workspace-current",
      worktree: "/tmp/current",
      agentType: AgentType.CODEX,
    });
  });
});
