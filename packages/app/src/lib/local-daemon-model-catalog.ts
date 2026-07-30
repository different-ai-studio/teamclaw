import { create } from '@bufbuild/protobuf'
import { ModelInfoSchema, RuntimeInfoSchema, type ModelInfo } from '@/lib/proto/amux_pb'
import { encodeWorkspaceId, getDaemonModelCatalog } from '@/lib/daemon-local-client'
import { useRuntimeStateStore } from '@/stores/runtime-state-store'
import { sessionFlowLog } from '@/lib/session-flow-log'

/**
 * Model catalog for the **local** daemon over loopback HTTP, bypassing MQTT.
 *
 * # Why this exists
 *
 * `RuntimeInfo.available_models` only ever reached the client on the retained
 * MQTT `runtime/{id}/state` message — `RuntimeStartResult` carries no models and
 * `GET /v1/live/events` does not tee runtime state. The session pill needs a
 * non-empty catalog to leave `connecting` (see `resolveSessionAgentUiState`), so
 * on a slow broker a brand-new session sat at 连接中 for the full
 * `SESSION_AGENT_CONNECTING_TIMEOUT_MS` and then reported offline, even with a
 * perfectly healthy local daemon one loopback hop away.
 *
 * `GET /v1/workspaces/:id/model-catalog` answers the same question directly, and
 * its handler brings the backend up on demand, so it works with zero sessions
 * created. All four implemented backends (opencode / pi / cursor / claude-code)
 * resolve through it, each falling back to this device's persisted catalog when
 * a live probe comes back empty.
 *
 * This is a *supplement*, not a replacement: the MQTT retain remains the source
 * of truth and overwrites whatever we seed here as soon as it lands. Remote
 * agents are unaffected — loopback HTTP only reaches this device's daemon.
 */

/** Backend id (`ModelCatalog.backends[].backend`) for a client backend type. */
function catalogBackendId(backendType: string | null | undefined): string | null {
  switch (backendType) {
    case 'opencode':
      return 'opencode'
    case 'pi':
      return 'pi'
    case 'cursor':
      return 'cursor'
    // The daemon labels this group "claude" (`AgentLaunchConfig.backend_type`),
    // not "claude-code".
    case 'claude-code':
    case 'claude':
    case 'claude_code':
      return 'claude'
    default:
      return null
  }
}

/**
 * Fetch the local daemon's catalog for `workspacePath` and return the models for
 * `backendType`. `null` when the daemon is unreachable or serves no group for
 * that backend — callers should then simply wait for the MQTT retain.
 */
export async function fetchLocalDaemonModels(
  workspacePath: string,
  backendType: string | null | undefined,
): Promise<ModelInfo[] | null> {
  const path = workspacePath.trim()
  if (!path) return null

  const catalog = await getDaemonModelCatalog(encodeWorkspaceId(path))
  if (!catalog) return null

  // Single-agent mode: the daemon serves exactly one group. Prefer the one
  // matching this agent's backend, but accept the sole group when the client's
  // idea of the backend type is stale — mismatching here would mean discarding
  // the only catalog on offer.
  const wanted = catalogBackendId(backendType)
  const group =
    (wanted ? catalog.backends.find((b) => b.backend === wanted) : undefined) ??
    (catalog.backends.length === 1 ? catalog.backends[0] : undefined)
  if (!group || group.models.length === 0) return null

  return group.models.map((m) =>
    create(ModelInfoSchema, {
      id: m.ref,
      displayName: m.display_name || m.ref,
      providerName: group.backend,
    }),
  )
}

/**
 * Merge an HTTP-sourced catalog into the runtime-state entry for `runtimeId`.
 *
 * No-op when the entry already advertises models — a retain that already landed
 * is fresher than anything we could add, and `available_models` is what every
 * readiness check keys on.
 */
export function mergeLocalDaemonModels(args: {
  daemonActorId: string
  runtimeId: string
  models: ModelInfo[]
}): boolean {
  const daemonActorId = args.daemonActorId.trim()
  const runtimeId = args.runtimeId.trim()
  if (!daemonActorId || !runtimeId || args.models.length === 0) return false

  const store = useRuntimeStateStore.getState()
  const entry = store.byRuntimeId[runtimeId]
  if (!entry) return false
  if (entry.info.availableModels.length > 0) return false

  const info = create(RuntimeInfoSchema, {
    ...entry.info,
    availableModels: args.models,
  })
  store.upsert(runtimeId, entry.daemonActorId, info)
  if (runtimeId !== daemonActorId) {
    store.upsert(daemonActorId, entry.daemonActorId, info)
  }
  return true
}

/**
 * Fire-and-forget: resolve the local daemon's catalog over HTTP and merge it in.
 *
 * Deliberately not awaited by the caller. The handler may have to bring a
 * backend process up (pi/cursor spawn a child, opencode runs `serve.ensure()`),
 * so blocking session start on it would trade one stall for another.
 */
export function seedLocalDaemonModelsInBackground(args: {
  daemonActorId: string
  runtimeId: string
  workspacePath: string
  backendType: string | null | undefined
  sessionId?: string
}): void {
  void (async () => {
    try {
      const models = await fetchLocalDaemonModels(args.workspacePath, args.backendType)
      if (!models) return
      const merged = mergeLocalDaemonModels({
        daemonActorId: args.daemonActorId,
        runtimeId: args.runtimeId,
        models,
      })
      sessionFlowLog('runtime_start.http_catalog.seeded', {
        sessionId: args.sessionId,
        agentActorId: args.daemonActorId,
        runtimeId: args.runtimeId,
        backendType: args.backendType ?? null,
        modelCount: models.length,
        // false = an MQTT retain with models beat us to it, which is fine.
        merged,
      })
    } catch (error) {
      // A cache warm-up must never break session start.
      console.warn('[local-daemon-model-catalog] seed failed', error)
    }
  })()
}
