import { AgentType } from "@teamclaw/app/proto/amux_pb";

export type ExpoAgentType = "claude" | "opencode" | "codex";

export type RuntimeStartAgent = {
  actorId: string;
  displayName: string;
  agentTypes: string[];
  defaultAgentType: string | null;
  defaultWorkspaceId?: string | null;
};

export type RuntimeStartConnectedAgent = {
  agentId: string;
};

export type RuntimeStartWorkspace = {
  id: string;
  path: string | null;
  agentId: string | null;
};

export type RuntimeStartSelection = {
  workspaceId: string;
  agentType: ExpoAgentType;
};

export type RuntimeStartPlan = {
  agentActorId: string;
  targetActorId: string;
  workspaceId: string;
  worktree: string;
  agentType: AgentType;
};

export type RuntimeRestartRuntime = {
  agentId: string;
  runtimeId: string | null;
  workspaceId: string | null;
  backendType: string | null;
};

export type RuntimeRestartPlan = RuntimeStartPlan & {
  runtimeIdToStop: string;
};

type ResolveRuntimeStartPlansInput = {
  agents: RuntimeStartAgent[];
  connectedAgents: RuntimeStartConnectedAgent[];
  workspaces: RuntimeStartWorkspace[];
  explicitSelection?: RuntimeStartSelection | null;
};

type ResolveRuntimeRestartPlanInput = {
  agent: RuntimeStartAgent;
  runtime: RuntimeRestartRuntime;
  connectedAgents: RuntimeStartConnectedAgent[];
  workspaces: RuntimeStartWorkspace[];
};

export function resolveExpoAgentType(
  value: string | null | undefined,
): AgentType {
  switch (value) {
    case "opencode":
      return AgentType.OPENCODE;
    case "codex":
      return AgentType.CODEX;
    case "claude-code":
    case "claude_code":
    case "claude":
    default:
      return AgentType.CLAUDE_CODE;
  }
}

function pickAgentType(
  agent: RuntimeStartAgent,
  explicitSelection?: RuntimeStartSelection | null,
): AgentType {
  if (explicitSelection) return resolveExpoAgentType(explicitSelection.agentType);

  const supported = agent.agentTypes.filter((type) =>
    type === "claude" || type === "claude-code" || type === "claude_code" ||
    type === "opencode" || type === "codex",
  );
  const preferred = agent.defaultAgentType ?? supported[0] ?? "claude";
  return resolveExpoAgentType(preferred);
}

function pickWorkspace(
  agent: RuntimeStartAgent,
  workspaces: RuntimeStartWorkspace[],
  explicitSelection?: RuntimeStartSelection | null,
): RuntimeStartWorkspace {
  if (explicitSelection) {
    const selected = workspaces.find((workspace) => workspace.id === explicitSelection.workspaceId);
    if (!selected) {
      throw new Error("Selected workspace is no longer available.");
    }
    return selected;
  }

  if (agent.defaultWorkspaceId) {
    const defaultWorkspace = workspaces.find((workspace) => workspace.id === agent.defaultWorkspaceId);
    if (defaultWorkspace) return defaultWorkspace;
  }

  const ownedWorkspace = workspaces.find((workspace) => workspace.agentId === agent.actorId);
  if (ownedWorkspace) return ownedWorkspace;

  throw new Error(
    `No workspace bound to ${agent.displayName || "agent"} — register one on the daemon first.`,
  );
}

export function resolveAgentRuntimeStartPlans({
  agents,
  connectedAgents,
  workspaces,
  explicitSelection = null,
}: ResolveRuntimeStartPlansInput): RuntimeStartPlan[] {
  const connectedByAgentId = new Map(
    connectedAgents.map((agent) => [agent.agentId, agent]),
  );

  return agents.map((agent) => {
    // An agent's routing actor id IS its actorId; it must be connected (the
    // daemon publishes presence) before we can route a runtime_start to it.
    const connected = connectedByAgentId.get(agent.actorId);
    if (!connected) {
      throw new Error(`${agent.displayName || "Agent"} daemon is offline — wait for it to reconnect.`);
    }

    const workspace = pickWorkspace(agent, workspaces, explicitSelection);
    return {
      agentActorId: agent.actorId,
      targetActorId: agent.actorId,
      workspaceId: workspace.id,
      worktree: workspace.path ?? "",
      agentType: pickAgentType(agent, explicitSelection),
    };
  });
}

export function resolveAgentRuntimeRestartPlan({
  agent,
  runtime,
  connectedAgents,
  workspaces,
}: ResolveRuntimeRestartPlanInput): RuntimeRestartPlan {
  const connected = connectedAgents.find((candidate) => candidate.agentId === agent.actorId);
  if (!connected) {
    throw new Error(`${agent.displayName || "Agent"} daemon is offline — wait for it to reconnect.`);
  }

  const runtimeWorkspaceId = runtime.workspaceId?.trim() ?? "";
  const workspace = runtimeWorkspaceId
    ? workspaces.find((candidate) => candidate.id === runtimeWorkspaceId) ??
      pickWorkspace(agent, workspaces)
    : pickWorkspace(agent, workspaces);

  return {
    agentActorId: agent.actorId,
    targetActorId: agent.actorId,
    runtimeIdToStop: runtime.runtimeId?.trim() ?? "",
    workspaceId: workspace.id,
    worktree: workspace.path ?? "",
    agentType: runtime.backendType
      ? resolveExpoAgentType(runtime.backendType)
      : pickAgentType(agent),
  };
}
