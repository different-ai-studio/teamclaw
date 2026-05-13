import { supabase } from '@/lib/supabase-client'
import { runtimeStart } from '@/lib/teamclaw-rpc'
import { AgentType } from '@/lib/proto/amux_pb'
import {
  upsertSessionsBatch,
  upsertSessionParticipantsBatch,
  type SessionRow,
  type SessionParticipantRow,
} from '@/lib/local-cache'
import { isTauri } from '@/lib/utils'

export interface CreateSessionShellArgs {
  teamId: string
  creatorActorId: string
  title: string
  /** Actor IDs to add as participants alongside the creator. */
  additionalActorIds: string[]
}

export interface CreateSessionShellResult {
  sessionId: string
}

/**
 * Inserts the supabase rows needed to materialise a new session and its
 * initial participants. Does NOT trigger any agent runtimeStart RPC —
 * callers fire-and-forget {@link startAgentRuntimesAsync} afterward so
 * the UI can switch into the new session immediately while runtimes
 * spawn in the background.
 */
export async function createSessionShell(
  args: CreateSessionShellArgs,
): Promise<CreateSessionShellResult> {
  const sessionId = crypto.randomUUID()
  const trimmedTitle = (args.title.split('\n')[0] || args.title).trim().slice(0, 80) || 'New chat'

  const { error: sessionErr } = await supabase
    .from('sessions')
    .insert({
      id: sessionId,
      team_id: args.teamId,
      created_by_actor_id: args.creatorActorId,
      mode: 'collab',
      title: trimmedTitle,
    })
  if (sessionErr) throw new Error(`Failed to create session: ${sessionErr.message}`)

  const participantActorIds = Array.from(new Set([args.creatorActorId, ...args.additionalActorIds]))
  if (participantActorIds.length > 0) {
    const rows = participantActorIds.map(actorId => ({ session_id: sessionId, actor_id: actorId }))
    const { error: partErr } = await supabase.from('session_participants').insert(rows)
    if (partErr) throw new Error(`Failed to add participants: ${partErr.message}`)
  }

  // Mirror into local libsql immediately so the session-list-store + Actors
  // panel see the new session without waiting for a Supabase refetch.
  if (isTauri()) {
    const now = new Date().toISOString()
    const sessionRow: SessionRow = {
      id: sessionId,
      teamId: args.teamId,
      title: trimmedTitle,
      mode: 'collab',
      primaryAgentId: null,
      ideaId: null,
      summary: null,
      lastMessagePreview: null,
      lastMessageAt: null,
      createdBy: args.creatorActorId,
      metadataJson: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      syncedAt: now,
    }
    const partRows: SessionParticipantRow[] = participantActorIds.map(actorId => ({
      id: `${sessionId}:${actorId}`,
      sessionId,
      actorId,
      joinedAt: now,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      syncedAt: now,
    }))
    try {
      await upsertSessionsBatch([sessionRow])
      if (partRows.length > 0) await upsertSessionParticipantsBatch(partRows)
    } catch (e) {
      console.warn('[session-create] local cache upsert failed (non-fatal):', e)
    }
  }

  return { sessionId }
}

export interface StartAgentRuntimesArgs {
  sessionId: string
  teamId: string
  agentActorIds: string[]
}

/**
 * Fire-and-forget RPC fanout. Looks up each agent's prior workspace from
 * agent_runtimes history, then calls runtimeStart per agent. Failures are
 * logged but don't propagate — UI has already moved on.
 *
 * The caller is expected to NOT await this — kick it off with `void`.
 * Daemon-published RuntimeInfo retains will update the runtime-state-store
 * asynchronously as the runtimes come up.
 */
export async function startAgentRuntimesAsync(args: StartAgentRuntimesArgs): Promise<void> {
  if (args.agentActorIds.length === 0) return

  const priorByAgent = new Map<string, { workspace_id: string | null }>()
  const { data: priorRows } = await supabase
    .from('agent_runtimes')
    .select('agent_id, workspace_id, updated_at')
    .in('agent_id', args.agentActorIds)
    .eq('team_id', args.teamId)
    .order('updated_at', { ascending: false })
  for (const r of priorRows ?? []) {
    if (!priorByAgent.has(r.agent_id)) {
      priorByAgent.set(r.agent_id, { workspace_id: r.workspace_id })
    }
  }

  await Promise.all(args.agentActorIds.map(async (agentActorId) => {
    const prior = priorByAgent.get(agentActorId)
    try {
      // Current amuxd convention: daemon device_id == its actor_id, so the
      // RPC topic is amux/{team}/device/{agentActorId}/rpc/req. Multi-daemon
      // teams would need a separate (actor -> deviceId) lookup.
      const result = await runtimeStart({
        targetDeviceId: agentActorId,
        workspaceId: prior?.workspace_id ?? '',
        worktree: '',
        sessionId: args.sessionId,
        agentType: AgentType.CLAUDE_CODE,
        initialPrompt: '',
      })
      if (!result.accepted) {
        console.error('[session-create] runtimeStart rejected', {
          agentActorId,
          reason: result.rejectedReason,
        })
      } else {
        console.info('[session-create] runtimeStart accepted', {
          agentActorId,
          runtimeId: result.runtimeId,
        })
      }
    } catch (e) {
      console.error('[session-create] runtimeStart threw', {
        agentActorId,
        reason: e instanceof Error ? e.message : String(e),
      })
    }
  }))
}
