import { create as createZustand } from 'zustand'
import { create, fromBinary, toBinary } from '@bufbuild/protobuf'
import {
  ActorPresenceSchema,
  RuntimeInfoSchema,
  type ActorPresence,
  type RuntimeInfo,
} from '@/lib/proto/amux_pb'
import { mqttSubscribe, listenForEnvelopes, type IncomingEnvelope } from '@/lib/mqtt-bridge'
import { sessionFlowLog } from '@/lib/session-flow-log'

/**
 * In-memory projection of daemon attachment state from MQTT.
 *
 * The only MQTT source is `amux/{team}/{actor}/state` (ActorPresence). Each
 * attached session is keyed `{daemonActorId}::{sessionId}` — never a per-spawn
 * id. Local RPC seeds (`seedRuntimeStateAfterStart`) may write the same key
 * before the retain arrives.
 *
 * This store is intentionally STATELESS about user picks. It only mirrors what
 * the daemon publishes. The agent-model-pick-store is the source of truth for
 * user-selected models; `selectAgentModel` (runtime-state-resolve) reconciles.
 */

export type RuntimeStateEntry = {
  info: RuntimeInfo
  daemonActorId: string
  lastUpdated: number // ms epoch
}

type RuntimeStateUpdate = {
  runtimeId: string
  daemonActorId: string
  info: RuntimeInfo
}

interface RuntimeStateState {
  byRuntimeId: Record<string, RuntimeStateEntry>
  upsert: (runtimeId: string, daemonActorId: string, info: RuntimeInfo) => void
  upsertBatch: (updates: RuntimeStateUpdate[]) => void
  clear: () => void
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false
  for (let i = 0; i < a.byteLength; i += 1) {
    if (a[i] !== b[i]) return false
  }
  return true
}

function runtimeInfoEqual(a: RuntimeInfo, b: RuntimeInfo): boolean {
  return bytesEqual(toBinary(RuntimeInfoSchema, a), toBinary(RuntimeInfoSchema, b))
}

function applyRuntimeStateUpdates(
  current: Record<string, RuntimeStateEntry>,
  updates: RuntimeStateUpdate[],
): Record<string, RuntimeStateEntry> {
  let next = current
  let changed = false

  for (const update of updates) {
    const { runtimeId, daemonActorId, info } = update
    const receivedAt = Date.now()
    const prev = next[runtimeId]
    let merged = info
    if (
      prev &&
      prev.info.availableModels.length > 0 &&
      info.availableModels.length === 0
    ) {
      // Defensive: keep last-known model list when a partial retain (e.g.
      // status-only delta) arrives without `available_models`.
      merged = { ...info, availableModels: prev.info.availableModels }
    }

    const prevMatches =
      Boolean(prev) &&
      prev.daemonActorId === daemonActorId &&
      runtimeInfoEqual(prev!.info, merged)
    const entry: RuntimeStateEntry = prevMatches
      ? { ...prev!, lastUpdated: receivedAt }
      : { info: merged, daemonActorId, lastUpdated: receivedAt }

    const shouldSetRuntime = !prevMatches || entry !== prev
    if (!shouldSetRuntime) continue
    if (!changed) {
      next = { ...next }
      changed = true
    }
    next[runtimeId] = entry
  }

  return changed ? next : current
}

export const useRuntimeStateStore = createZustand<RuntimeStateState>((set, get) => ({
  byRuntimeId: {},
  upsert: (runtimeId, daemonActorId, info) => {
    const current = get().byRuntimeId
    const next = applyRuntimeStateUpdates(current, [{ runtimeId, daemonActorId, info }])
    if (next !== current) set({ byRuntimeId: next })
  },
  upsertBatch: (updates) => {
    if (updates.length === 0) return
    const current = get().byRuntimeId
    const next = applyRuntimeStateUpdates(current, updates)
    if (next !== current) set({ byRuntimeId: next })
  },
  clear: () => set({ byRuntimeId: {} }),
}))

export function parseRuntimeStateTopic(
  topic: string
): { teamId: string; daemonActorId: string; runtimeId: string } | null {
  const parts = topic.split('/')
  if (parts.length !== 6) return null
  if (parts[0] !== 'amux') return null
  if (parts[3] !== 'runtime') return null
  if (parts[5] !== 'state') return null
  return { teamId: parts[1], daemonActorId: parts[2], runtimeId: parts[4] }
}

/** `amux/{team}/{actor}/state` — the one retained topic per actor. */
export function parseActorStateTopic(
  topic: string
): { teamId: string; actorId: string } | null {
  const parts = topic.split('/')
  if (parts.length !== 4) return null
  if (parts[0] !== 'amux') return null
  if (parts[3] !== 'state') return null
  return { teamId: parts[1], actorId: parts[2] }
}

let unlisten: (() => void) | null = null
let initialized = false
let queuedRuntimeStateUpdates: RuntimeStateUpdate[] = []
let runtimeStateFlushScheduled = false

function flushQueuedRuntimeStateUpdates(): void {
  runtimeStateFlushScheduled = false
  const updates = queuedRuntimeStateUpdates
  queuedRuntimeStateUpdates = []
  useRuntimeStateStore.getState().upsertBatch(updates)
}

function enqueueRuntimeStateUpdate(update: RuntimeStateUpdate): void {
  queuedRuntimeStateUpdates.push(update)
  if (runtimeStateFlushScheduled) return
  runtimeStateFlushScheduled = true
  queueMicrotask(flushQueuedRuntimeStateUpdates)
}

/**
 * Project an `ActorPresence` retain into the same entry shape the per-runtime
 * retains produce, one entry per attached session.
 *
 * Keyed by `session_id`, not by a spawn id. That is the whole point: a spawn id
 * is minted per start and stale the moment it is recorded, whereas exactly one
 * attachment serves a session at a time (ADR-0004). Commands are addressed the
 * same way since the rpc/req migration, so consumers that treat this key as an
 * opaque address keep working.
 *
 * A session absent from `live_sessions` is deliberately not represented: no
 * entry means cold, which is how the UI distinguishes "answers immediately"
 * from "will spawn on send".
 */
export function projectActorPresence(
  daemonActorId: string,
  presence: ActorPresence,
): RuntimeStateUpdate[] {
  const catalogByWorktree = new Map(presence.worktrees.map((w) => [w.worktree, w]))

  return presence.liveSessions.map((live) => {
    const worktree = catalogByWorktree.get(live.worktree)
    const models = worktree
      ? worktree.modelIndices
          .map((i) => presence.catalogModels[i])
          .filter((m): m is NonNullable<typeof m> => !!m)
      : []

    const info = create(RuntimeInfoSchema, {
      runtimeId: live.sessionId,
      agentType: presence.activeAgentType,
      workspaceId: live.workspaceId,
      worktree: live.worktree,
      status: live.status,
      state: live.lifecycle,
      stage: live.stage,
      errorCode: live.errorCode,
      errorMessage: live.errorMessage,
      failedStage: live.failedStage,
      currentModel: live.currentModel || (worktree?.defaultModel ?? ''),
      availableModels: models,
      availableCommands: worktree?.availableCommands ?? [],
    })

    // Keyed by (actor, session), not by session alone. A daemon holds at most
    // one attachment per session — `coalesce_session_runtimes` enforces that —
    // but this store merges every actor's retain, and a session with agents on
    // two machines has one attachment per machine. Keying by session alone let
    // the second actor's entry evict the first.
    //
    // `info.runtimeId` stays the bare session id: that is the command address,
    // and commands are addressed by (actor, session) at the wire level too.
    return { runtimeId: `${daemonActorId}::${live.sessionId}`, daemonActorId, info }
  })
}

/** Composite key for one actor's attachment to one session. */
export function attachmentKey(daemonActorId: string, sessionId: string): string {
  return `${daemonActorId}::${sessionId}`
}

/** One actor's attachment to one session — keyed `{actorId}::{sessionId}`. */
export function resolveSessionAttachmentEntry(
  agentId: string,
  sessionId: string,
  byRuntimeId: Record<string, RuntimeStateEntry>,
): RuntimeStateEntry | undefined {
  const trimmedAgent = agentId.trim()
  const trimmedSession = sessionId.trim()
  if (!trimmedAgent || !trimmedSession) return undefined

  const attached = byRuntimeId[attachmentKey(trimmedAgent, trimmedSession)]
  if (attached?.daemonActorId === trimmedAgent) return attached
  return undefined
}

/** Every actor's attachment to `sessionId` — one per daemon serving it. */
export function attachmentsForSession(
  sessionId: string,
  byRuntimeId: Record<string, RuntimeStateEntry>,
): RuntimeStateEntry[] {
  const id = sessionId.trim()
  if (!id) return []
  return Object.entries(byRuntimeId)
    .filter(([key]) => key.endsWith(`::${id}`))
    .map(([, entry]) => entry)
}

export async function initRuntimeStateStore(teamId: string): Promise<void> {
  if (initialized) {
    console.info('[runtime-state] init skipped: already initialized', { teamId })
    return
  }
  const actorTopic = `amux/${teamId}/+/state`
  await mqttSubscribe(actorTopic)
  console.info('[runtime-state] subscribed', { teamId, topic: actorTopic })
  unlisten = await listenForEnvelopes((env: IncomingEnvelope) => {
    const actor = parseActorStateTopic(env.topic)
    if (!actor || actor.teamId !== teamId) return
    let presence: ActorPresence
    try {
      presence = fromBinary(ActorPresenceSchema, new Uint8Array(env.bytes))
    } catch (e) {
      console.warn('[runtime-state] failed to decode ActorPresence', e)
      return
    }
    const updates = projectActorPresence(actor.actorId, presence)
    sessionFlowLog('actor_state.retain.received', {
      teamId: actor.teamId,
      actorId: actor.actorId,
      online: presence.online,
      activeAgentType: presence.activeAgentType,
      backendHealth: presence.backendHealth,
      worktreeCount: presence.worktrees.length,
      catalogModelCount: presence.catalogModels.length,
      liveSessionCount: presence.liveSessions.length,
    })
    for (const update of updates) enqueueRuntimeStateUpdate(update)
  })
  initialized = true
}

export function disposeRuntimeStateStore(): void {
  unlisten?.()
  unlisten = null
  queuedRuntimeStateUpdates = []
  runtimeStateFlushScheduled = false
  useRuntimeStateStore.getState().clear()
  initialized = false
  console.info('[runtime-state] disposed')
}
