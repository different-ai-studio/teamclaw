import { create } from '@bufbuild/protobuf'
import { ModelInfoSchema, RuntimeInfoSchema, type ModelInfo } from '@/lib/proto/amux_pb'
import {
  encodeWorkspaceId,
  getDaemonModelCatalog,
  type DaemonBackendCatalog,
  type DaemonModelCatalog,
} from '@/lib/daemon-local-client'
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
    // The group id is the daemon's *wire* name for the type
    // (`runtime_resolution::agent_type_name`), which is "claude-code" — not the
    // `AgentLaunchConfig.backend_type` spelling ("claude"). Both are accepted
    // server-side, so match on the wire name here.
    case 'claude-code':
    case 'claude':
    case 'claude_code':
      return 'claude-code'
    default:
      return null
  }
}

/**
 * What the loopback catalog says about this device, as three *distinct*
 * answers.
 *
 * Collapsing "the daemon never answered" and "the daemon answered, and it has
 * nothing" into one `null` is what made a fresh install indistinguishable from
 * a slow one: both looked like "not yet", so the pill sat at 连接中 until the
 * timeout and then claimed offline — for a daemon that was up the whole time
 * and simply had no provider configured. `empty` is a *terminal* answer and
 * callers are expected to surface it as "needs configuring", not "wait".
 */
export type LocalDaemonCatalogOutcome =
  | { status: 'models'; backend: string; models: ModelInfo[]; recentModels: string[] }
  /** The daemon answered and serves no models for this backend. First install. */
  | { status: 'empty'; backend: string }
  /** No answer, or an ambiguous multi-group reply — claim nothing. */
  | { status: 'unknown' }

/**
 * Resolve the backend group this device's catalog is about.
 *
 * Single-agent mode: the daemon serves exactly one group. Prefer the one
 * matching `backendType` when the caller has an opinion, then the daemon's own
 * automation default, then the sole group — mismatching on a stale client-side
 * backend name would mean discarding the only catalog on offer.
 *
 * Returns `null` when several groups are offered and none matches: that is
 * ambiguity, not emptiness, and must not be reported as "nothing configured".
 */
function resolveCatalogGroup(
  catalog: DaemonModelCatalog,
  backendType: string | null | undefined,
): DaemonBackendCatalog | null {
  const soleGroup = catalog.backends.length === 1 ? catalog.backends[0] : null

  const wanted = catalogBackendId(backendType)
  if (wanted) {
    // The caller named a backend and expects models for *that* one. Accept the
    // sole group when the name misses — a stale client-side backend name must
    // not throw away the only catalog on offer — but never pick among several.
    return catalog.backends.find((b) => b.backend === wanted) ?? soleGroup
  }

  // No opinion from the caller ("just tell me what this device runs"): the
  // daemon's own automation default is that answer.
  const automationDefault = catalog.automation_default_backend?.trim()
  const byDefault = automationDefault
    ? catalog.backends.find((b) => b.backend === automationDefault)
    : undefined
  return byDefault ?? soleGroup
}

/**
 * Fetch the local daemon's catalog for `workspacePath`, keeping "unreachable"
 * and "genuinely empty" apart. `backendType` is optional — omit it to take the
 * daemon's own default group, which is what a caller that just wants "this
 * device's models" should do.
 */
export async function fetchLocalDaemonCatalog(
  workspacePath: string,
  backendType?: string | null,
): Promise<LocalDaemonCatalogOutcome> {
  const path = workspacePath.trim()
  if (!path) return { status: 'unknown' }

  const catalog = await getDaemonModelCatalog(encodeWorkspaceId(path))
  if (!catalog) return { status: 'unknown' }

  const group = resolveCatalogGroup(catalog, backendType)
  if (!group) return { status: 'unknown' }
  if (group.models.length === 0) return { status: 'empty', backend: group.backend }

  return {
    status: 'models',
    backend: group.backend,
    models: group.models.map((m) =>
      create(ModelInfoSchema, {
        id: m.ref,
        displayName: m.display_name || m.ref,
        // `BackendCatalog.backend` describes the runner (Pi, Cursor, etc.),
        // not the model provider. Grouping every Pi model under "pi" loses
        // the provider hierarchy that Pi already supplies in its stable
        // `<provider>/<model>` reference.
        providerName: m.ref.split('/', 1)[0] || group.backend,
      }),
    ),
    recentModels: (group.recent_models ?? []).filter((id) => !!id?.trim()),
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
  const outcome = await fetchLocalDaemonCatalog(workspacePath, backendType)
  return outcome.status === 'models' ? outcome.models : null
}

/**
 * First MRU entry the live catalog still offers, mirroring the daemon's
 * `model_mru::first_available`. Empty string when nothing matches.
 */
export function firstAvailableRecentModel(
  recentModels: string[] | undefined,
  available: readonly { id?: string }[],
): string {
  if (!recentModels?.length || available.length === 0) return ''
  const offered = new Set(available.map((m) => m.id?.trim()).filter(Boolean))
  return recentModels.map((id) => id?.trim()).find((id) => !!id && offered.has(id)) ?? ''
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
  /**
   * Device MRU, newest first. Seeds `currentModel` when the entry has none, so
   * the pill shows the model this device last used instead of falling through
   * to `availableModels[0]`. Ignored when the retain already named a model.
   */
  recentModels?: string[]
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
    // Same rule the daemon applies to its own MRU (`model_mru::first_available`):
    // a remembered model the catalog no longer offers falls through rather than
    // being shown as current.
    currentModel:
      entry.info.currentModel?.trim() ||
      firstAvailableRecentModel(args.recentModels, args.models) ||
      '',
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
      const outcome = await fetchLocalDaemonCatalog(args.workspacePath, args.backendType)
      if (outcome.status !== 'models') return
      const { models, recentModels } = outcome
      const merged = mergeLocalDaemonModels({
        daemonActorId: args.daemonActorId,
        runtimeId: args.runtimeId,
        models,
        recentModels,
      })
      sessionFlowLog('runtime_start.http_catalog.seeded', {
        sessionId: args.sessionId,
        agentActorId: args.daemonActorId,
        runtimeId: args.runtimeId,
        backendType: args.backendType ?? null,
        modelCount: models.length,
        recentModelCount: recentModels.length,
        // false = an MQTT retain with models beat us to it, which is fine.
        merged,
      })
    } catch (error) {
      // A cache warm-up must never break session start.
      console.warn('[local-daemon-model-catalog] seed failed', error)
    }
  })()
}
