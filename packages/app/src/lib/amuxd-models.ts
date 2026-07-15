// Static available-models list ported from amuxd
// (`amux/daemon/src/runtime/models.rs:available_models_for`).
//
// Phase 1: amuxd is not installed locally, so we ship the same static list
// the daemon would return. Phase 2's daemon installer + ACP `start_agent`
// will replace this with live `RuntimeInfo.available_models` per running
// runtime, exposed via MQTT topic / Tauri RPC.

export type AmuxAgentType = "claude-code" | "opencode" | "codex";

export interface AmuxModelInfo {
  id: string;
  displayName: string;
}

export function availableModelsFor(agentType: AmuxAgentType): AmuxModelInfo[] {
  switch (agentType) {
    case "claude-code":
      return [
        { id: "claude-haiku-4-5", displayName: "Claude Haiku 4.5" },
        { id: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6" },
        { id: "claude-opus-4-7", displayName: "Claude Opus 4.7" },
      ];
    case "opencode":
    case "codex":
    default:
      return [];
  }
}

export const AMUXD_AGENT_TYPES: AmuxAgentType[] = ["claude-code", "opencode", "codex"];

/** Flat list across all agent types — for the chat input model picker. */
export function allAmuxdModels(): Array<{ provider: AmuxAgentType; id: string; displayName: string }> {
  return AMUXD_AGENT_TYPES.flatMap((agentType) =>
    availableModelsFor(agentType).map((m) => ({ provider: agentType, id: m.id, displayName: m.displayName })),
  );
}
