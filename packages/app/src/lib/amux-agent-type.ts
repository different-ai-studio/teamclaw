import { AgentType } from "@/lib/proto/amux_pb"
import type { AmuxAgentType } from "@/lib/amuxd-models"

export function amuxAgentTypeFromBackend(
  backendType: string | null | undefined,
): AmuxAgentType | null {
  switch (backendType) {
    case "opencode":
      return "opencode"
    case "codex":
      return "codex"
    case "pi":
      return "pi"
    case "claude-code":
    case "claude":
    case "claude_code":
      return "claude-code"
    default:
      return null
  }
}

export function resolveAmuxAgentType(
  backendType: string | null | undefined,
  agentKind?: string | null,
): AgentType {
  switch (backendType) {
    case "opencode":
      return AgentType.OPENCODE
    case "codex":
      return AgentType.CODEX
    case "pi":
      return AgentType.PI
    case "claude-code":
    case "claude":
    case "claude_code":
      return AgentType.CLAUDE_CODE
  }

  switch (agentKind) {
    case "daemon":
    case "amuxd":
    case "opencode":
      return AgentType.OPENCODE
    case "codex":
      return AgentType.CODEX
  }

  // Single-agent mode: unknown agent-type strings default to opencode.
  return AgentType.OPENCODE
}
