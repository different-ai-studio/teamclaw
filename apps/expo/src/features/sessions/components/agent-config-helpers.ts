export type AgentType = "claude" | "opencode" | "codex";

/** The ordered list of agent types shown in the segmented control. */
export const AGENT_TYPE_ORDER: readonly AgentType[] = ["claude", "opencode", "codex"];

/** Returns the id of the first workspace, or an empty string if the list is empty. */
export function initialWorkspaceId(workspaces: { id: string }[]): string {
  return workspaces[0]?.id ?? "";
}

/** The Add button is only enabled when a workspace has been selected. */
export function canConfirmSelection(workspaceId: string): boolean {
  return workspaceId.length > 0;
}
