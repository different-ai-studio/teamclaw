import { create as createZustand } from 'zustand'
import { fromBinary, toBinary } from '@bufbuild/protobuf'
import { RuntimeInfoSchema, type RuntimeInfo } from '@/lib/proto/amux_pb'
import { mqttSubscribe, listenForEnvelopes, type IncomingEnvelope } from '@/lib/mqtt-bridge'
import { sessionFlowLog } from '@/lib/session-flow-log'

/**
 * MQTT `runtime/{spawnId}/state` retain cache.
 *
 * Storage shape:
 *  - Primary key: the topic's `{runtimeId}` segment (8-char spawn id).
 *  - Mirror key:  the topic's `{daemonActorId}` segment (agent actor UUID).
 *    Resolvers look up by agent UUID first; without the mirror they'd
 *    have to linear-scan every retain.
 *
 *  Both keys point to the SAME `RuntimeStateEntry` reference per upsert. The
 *  mirror is freshness-guarded: a stale republished retain (e.g. broker
 *  re-flushing prior retains on reconnect) will NOT overwrite a fresher entry
 *  already under the agent UUID — that was the source of the "弹回" symptom
 *  where an old spawn's `currentModel` ghost-overrode the live one.
 *
 *  This store is intentionally STATELESS about user picks. It only mirrors
 *  what the daemon publishes. The agent-model-pick-store is the source of
 *  truth for user-selected models; `selectAgentModel` (runtime-state-resolve)
 *  is the only place that reconciles the two.
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

    const agentKey = daemonActorId.trim()
    const existingMirror = agentKey && agentKey !== runtimeId ? next[agentKey] : undefined
    const shouldSetRuntime = !prevMatches || entry !== prev
    const shouldSetMirror =
      Boolean(agentKey && agentKey !== runtimeId) &&
      existingMirror !== entry &&
      (!existingMirror || existingMirror.lastUpdated <= entry.lastUpdated)

    if (!shouldSetRuntime && !shouldSetMirror) continue
    if (!changed) {
      next = { ...next }
      changed = true
    }
    if (shouldSetRuntime) next[runtimeId] = entry
    if (shouldSetMirror) next[agentKey] = entry
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

export async function initRuntimeStateStore(teamId: string): Promise<void> {
  if (initialized) {
    console.info('[runtime-state] init skipped: already initialized', { teamId })
    return
  }
  const topic = `amux/${teamId}/+/runtime/+/state`
  await mqttSubscribe(topic)
  console.info('[runtime-state] subscribed', { teamId, topic })
  unlisten = await listenForEnvelopes((env: IncomingEnvelope) => {
    const parsed = parseRuntimeStateTopic(env.topic)
    if (!parsed) return
    if (parsed.teamId !== teamId) {
      console.info('[runtime-state] ignored envelope for another team', {
        expectedTeamId: teamId,
        topic: env.topic,
        parsed,
      })
      return
    }
    let info: RuntimeInfo
    try {
      info = fromBinary(RuntimeInfoSchema, new Uint8Array(env.bytes))
    } catch (e) {
      console.warn('[runtime-state] failed to decode RuntimeInfo', e)
      return
    }
    sessionFlowLog('runtime_state.retain.received', {
      teamId: parsed.teamId,
      daemonActorId: parsed.daemonActorId,
      runtimeId: parsed.runtimeId,
      infoRuntimeId: info.runtimeId,
      agentType: info.agentType,
      currentModel: info.currentModel,
      availableModelIds: info.availableModels.map((model) => model.id),
      availableCommandNames: info.availableCommands.map((command) => command.name),
      state: info.state,
      status: info.status,
    })
    console.info('[runtime-state] retained RuntimeInfo received', {
      topic: env.topic,
      daemonActorId: parsed.daemonActorId,
      runtimeIdFromTopic: parsed.runtimeId,
      runtimeIdFromInfo: info.runtimeId,
      commandCount: info.availableCommands.length,
      commandNames: info.availableCommands.map((command) => command.name),
      currentModel: info.currentModel,
      state: info.state,
      status: info.status,
    })
    enqueueRuntimeStateUpdate({
      runtimeId: parsed.runtimeId,
      daemonActorId: parsed.daemonActorId,
      info,
    })
    void import('@/stores/acp-debug-store').then(({ useAcpDebugStore }) => {
      useAcpDebugStore.getState().append({
        topic: env.topic,
        actorId: parsed.daemonActorId,
        eventCase: 'runtime_state',
        payload: {
          runtimeId: info.runtimeId,
          agentType: info.agentType,
          state: info.state,
          status: info.status,
          currentModel: info.currentModel,
          availableModels: info.availableModels,
        },
      })
    })
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
