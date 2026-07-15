export type ConnectedAgent = {
  agentId: string;
  displayName: string;
  agentTypes: string[];
  defaultAgentType: string | null;
  permissionLevel: string;
  visibility: "team" | "personal";
  isOwner: boolean;
  lastActiveAt: string | null;
};

export type RuntimeAvailableCommand = {
  name: string;
  description: string;
  inputHint: string;
};

export type RuntimeInfo = {
  runtimeId: string;
  agentType: number;
  worktree: string;
  branch: string;
  status: number;
  startedAt: number;
  currentPrompt: string;
  workspaceId: string;
  sessionTitle: string;
  toolUseCount: number;
  availableModels: { id: string; displayName: string }[];
  currentModel: string;
  state: number;
  stage: string;
  errorCode: string;
  errorMessage: string;
  failedStage: string;
  availableCommands: RuntimeAvailableCommand[];
};

export type AgentAuthorizedHuman = {
  id: string;
  displayName: string;
  permissionLevel: string;
  grantedByActorId: string | null;
  lastActiveAt: string | null;
};

export function isAgentOnline(agent: Pick<ConnectedAgent, "lastActiveAt">, now = Date.now()): boolean {
  if (!agent.lastActiveAt) return false;
  const t = Date.parse(agent.lastActiveAt);
  if (!Number.isFinite(t)) return false;
  return now - t < 120_000;
}
