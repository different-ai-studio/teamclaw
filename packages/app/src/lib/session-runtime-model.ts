import { getBackend } from '@/lib/backend'
import { setModel } from '@/lib/teamclaw-rpc'
import {
  resolveRuntimeIdForAgent,
  resolveSetModelId,
} from '@/lib/runtime-state-resolve'
import { useRuntimeStateStore } from '@/stores/runtime-state-store'
import { sessionFlowError, sessionFlowLog } from '@/lib/session-flow-log'

export interface ApplySessionRuntimeModelArgs {
  sessionId: string | null
  agentActorIds: string[]
  modelId: string
}

export async function applySessionRuntimeModel(args: ApplySessionRuntimeModelArgs): Promise<void> {
  sessionFlowLog('runtime_model.apply.begin', {
    sessionId: args.sessionId,
    requestedAgentActorIds: args.agentActorIds,
    requestedAgentCount: args.agentActorIds.length,
    modelId: args.modelId,
  })

  if (!args.sessionId || !args.modelId) {
    sessionFlowLog('runtime_model.apply.skipped_missing_input', {
      hasSessionId: !!args.sessionId,
      hasModelId: !!args.modelId,
      requestedAgentCount: args.agentActorIds.length,
    }, 'warn')
    return
  }

  if (args.agentActorIds.length > 0) {
    sessionFlowLog('runtime_model.query.filter_agents', {
      sessionId: args.sessionId,
      agentActorIds: args.agentActorIds,
    })
  } else {
    sessionFlowLog('runtime_model.query.all_session_agents', {
      sessionId: args.sessionId,
    })
  }

  let runtimeRows: Array<{ agent_id: string | null; runtime_id: string | null }>
  try {
    runtimeRows = await getBackend().runtime.listRuntimeTargetsForSession(args.sessionId, args.agentActorIds)
  } catch (error) {
    sessionFlowError('runtime_model.query.failed', error, {
      sessionId: args.sessionId,
      modelId: args.modelId,
      agentActorIds: args.agentActorIds,
    })
    throw new Error(`Failed to load agent runtimes: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }

  const validRuntimeRows = runtimeRows.filter(
    (row): row is { agent_id: string; runtime_id: string } => !!row.agent_id && !!row.runtime_id,
  )

  sessionFlowLog('runtime_model.query.ok', {
    sessionId: args.sessionId,
    modelId: args.modelId,
    rowCount: runtimeRows.length,
    validRowCount: validRuntimeRows.length,
    rows: runtimeRows.map((row) => ({
      agentId: row.agent_id,
      runtimeId: row.runtime_id,
      valid: !!row.agent_id && !!row.runtime_id,
    })),
  })

  const byRuntimeId = useRuntimeStateStore.getState().byRuntimeId
  const sessionRuntimeIds = new Set(
    validRuntimeRows.map((row) => row.runtime_id).filter((id): id is string => !!id),
  )

  await Promise.all(
    validRuntimeRows.map(async (row) => {
      const runtimeId =
        resolveRuntimeIdForAgent(row.agent_id, byRuntimeId, row.runtime_id, sessionRuntimeIds) ??
        row.runtime_id
      const modelId = resolveSetModelId(row.agent_id, args.modelId, byRuntimeId)
      sessionFlowLog('runtime_model.set_model.begin', {
        sessionId: args.sessionId,
        targetActorId: row.agent_id,
        runtimeId,
        dbRuntimeId: row.runtime_id,
        modelId,
      })
      try {
        const result = await setModel({
          targetActorId: row.agent_id,
          runtimeId,
          modelId,
        })
        sessionFlowLog('runtime_model.set_model.ok', {
          sessionId: args.sessionId,
          targetActorId: row.agent_id,
          runtimeId,
          modelId,
          result,
        })
      } catch (error) {
        sessionFlowError('runtime_model.set_model.failed', error, {
          sessionId: args.sessionId,
          targetActorId: row.agent_id,
          runtimeId,
          modelId,
        })
        throw error
      }
    }),
  )

  sessionFlowLog('runtime_model.apply.done', {
    sessionId: args.sessionId,
    modelId: args.modelId,
    appliedRuntimeCount: validRuntimeRows.length,
  })
}
