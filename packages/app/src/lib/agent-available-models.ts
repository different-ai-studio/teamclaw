import type { RuntimeInfo } from '@/lib/proto/amux_pb'

export type AgentModelOption = { id: string; displayName: string }

/** Daemon ACP `RuntimeInfo.available_models` only — no provider store or static fallback. */
export function resolveAgentAvailableModels(
  runtimeInfo: RuntimeInfo | undefined,
): AgentModelOption[] {
  if (!runtimeInfo?.availableModels.length) return []

  const seen = new Set<string>()
  return runtimeInfo.availableModels.filter((model) => {
    const id = model.id?.trim()
    if (!id || seen.has(id)) return false
    seen.add(id)
    return true
  })
}
