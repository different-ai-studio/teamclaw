import { getBackend } from '@/lib/backend'
import { resolveRuntimeStateEntryForAgent } from '@/lib/runtime-state-resolve'
import type { RuntimeStateEntry } from '@/stores/runtime-state-store'
import type { ModelOption } from '@/stores/provider'
import { sessionFlowError, sessionFlowLog } from '@/lib/session-flow-log'

type RuntimeRow = {
  runtime_id: string | null
  backend_type: string | null
  current_model: string | null
}

export type SessionModelResolution = {
  provider: string
  modelId: string
  name: string
  source: 'runtimeInfo' | 'agentRuntimes'
}

function providerIdForBackendType(backendType: string | null | undefined): string | null {
  switch (backendType) {
    case 'claude-code':
    case 'claude':
    case 'claude_code':
      return 'claude-code'
    case 'opencode':
      return 'opencode'
    case 'pi':
      return 'pi'
    case 'cursor':
      return 'cursor'
    default:
      return null
  }
}

function liveRuntimeEntryForRow(
  row: RuntimeRow,
  runtimeStates: Record<string, RuntimeStateEntry>,
): RuntimeStateEntry | undefined {
  const runtimeId = row.runtime_id?.trim() ?? ''
  if (!runtimeId) return undefined
  return resolveRuntimeStateEntryForAgent(runtimeId, runtimeStates, runtimeId)
}

/**
 * Rows come back in an arbitrary order and carry no `agent_id`, so "the first
 * row that resolves" can be a dead agent's runtime — e.g. right after
 * "switch to local agent", the offline remote's row is still in the session.
 * Sort the rows whose live retain belongs to a currently-engaged agent first.
 */
function orderRowsByEngagedAgents(
  rows: RuntimeRow[],
  runtimeStates: Record<string, RuntimeStateEntry>,
  engagedAgentIds: readonly string[],
): RuntimeRow[] {
  const engaged = new Set(engagedAgentIds.map((id) => id.trim()).filter(Boolean));
  if (engaged.size === 0) return rows;

  const belongsToEngagedAgent = (row: RuntimeRow): boolean => {
    const runtimeId = row.runtime_id?.trim();
    if (!runtimeId) return false;
    const entry = runtimeStates[runtimeId];
    if (!entry) return false;
    return engaged.has(entry.daemonActorId) || engaged.has(entry.info.runtimeId);
  };

  const preferred = rows.filter(belongsToEngagedAgent);
  if (preferred.length === 0) return rows;
  return [...preferred, ...rows.filter((row) => !belongsToEngagedAgent(row))];
}

export function resolveSessionModelFromRuntimeRows(
  rows: RuntimeRow[],
  runtimeStates: Record<string, RuntimeStateEntry>,
  models: ModelOption[],
  engagedAgentIds: readonly string[] = [],
): SessionModelResolution | null {
  for (const row of orderRowsByEngagedAgents(rows, runtimeStates, engagedAgentIds)) {
    const provider = providerIdForBackendType(row.backend_type)
    if (!provider) continue

    const liveModel = liveRuntimeEntryForRow(row, runtimeStates)?.info.currentModel ?? ''
    const candidates: Array<{ modelId: string; source: SessionModelResolution['source'] }> = [
      { modelId: liveModel || '', source: 'runtimeInfo' },
      { modelId: row.current_model || '', source: 'agentRuntimes' },
    ]

    for (const candidate of candidates) {
      if (!candidate.modelId) continue
      const model = models.find((m) => m.provider === provider && m.id === candidate.modelId)
      if (model) {
        return {
          provider,
          modelId: model.id,
          name: model.name,
          source: candidate.source,
        }
      }
    }
  }

  return null
}

export async function loadSessionActiveModel(args: {
  sessionId: string
  runtimeStates: Record<string, RuntimeStateEntry>
  models: ModelOption[]
  /** Pills currently mounted — their runtimes win over other session rows. */
  engagedAgentIds?: readonly string[]
}): Promise<SessionModelResolution | null> {
  sessionFlowLog('session_model.load.begin', {
    sessionId: args.sessionId,
    modelCount: args.models.length,
    runtimeStateCount: Object.keys(args.runtimeStates).length,
  })

  let data: RuntimeRow[]
  try {
    data = await getBackend().runtime.listSessionRuntimeModels(args.sessionId)
  } catch (error) {
    sessionFlowError('session_model.load.failed', error, {
      sessionId: args.sessionId,
    })
    return null
  }

  const rows = data ?? []
  const resolved = resolveSessionModelFromRuntimeRows(
    rows,
    args.runtimeStates,
    args.models,
    args.engagedAgentIds ?? [],
  )

  sessionFlowLog('session_model.load.done', {
    sessionId: args.sessionId,
    rowCount: rows.length,
    resolved,
    rows: rows.map((row) => ({
      runtimeId: row.runtime_id,
      backendType: row.backend_type,
      currentModel: row.current_model,
      liveCurrentModel: liveRuntimeEntryForRow(row, args.runtimeStates)?.info.currentModel,
    })),
  })

  return resolved
}
