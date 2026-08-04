import { create as createZustand } from 'zustand'
import type { ModelInfo } from '@/lib/proto/amux_pb'
import { fetchLocalDaemonCatalog } from '@/lib/local-daemon-model-catalog'

/**
 * This device's model catalog, read over loopback HTTP — the **local agent
 * only** fast path.
 *
 * # Why this exists next to `runtime-state-store`
 *
 * `runtime-state-store` projects MQTT `{actor}/state` attachments, and a retain
 * only exists once a runtime is actually up. That makes it the right source of
 * truth and the wrong thing to *wait* on: a healthy local daemon one loopback
 * hop away still left the pill at 连接中 until the retain landed, and a daemon
 * with no provider configured (first install) never produced one at all, so the
 * pill sat there until the connecting timeout and then claimed offline.
 *
 * This store answers "what can this device run, and what did it last run?"
 * without any runtime, session, or broker involved. It is deliberately:
 *
 *  - **local-only** — loopback HTTP reaches this machine's daemon and nothing
 *    else. Remote agents have no equivalent and must keep using the retain;
 *    every consumer gates on `agentId === localDaemonActorId` before reading.
 *  - **not authoritative** — the retain still wins wherever both exist. This is
 *    a display/readiness supplement, never a replacement.
 *  - **not persisted** — the daemon already persists its own last-known catalog
 *    (`config::model_catalog`) and serves it when a live probe comes back
 *    empty, so a second client-side cache would only add staleness.
 */

/**
 * - `pending`  — a fetch is in flight and we have nothing yet.
 * - `ready`    — the daemon serves models for this device.
 * - `empty`    — the daemon answered and has **no** models. Terminal: this is
 *                a fresh install with no provider configured, not a slow start.
 * - `unknown`  — no answer (daemon down / mid-restart), or an ambiguous reply.
 */
export type LocalDaemonCatalogStatus = 'pending' | 'ready' | 'empty' | 'unknown'

export type LocalDaemonCatalogEntry = {
  status: LocalDaemonCatalogStatus
  models: ModelInfo[]
  /** Device MRU, newest first — resolves "last used model" with no retain. */
  recentModels: string[]
  /** ms epoch of the last completed fetch; 0 while the first one is in flight. */
  fetchedAt: number
}

/**
 * Has the loopback probe finished having its say?
 *
 * `undefined` means no entry exists yet — indistinguishable from `'pending'`
 * for any caller deciding whether to act on the catalog, and the distinction
 * has bitten before: a guard that only checked `'pending'` sailed straight
 * through the first render (when the entry does not exist) and durably
 * persisted the wrong model.
 */
export function isSettledLocalCatalog(
  status: LocalDaemonCatalogStatus | undefined,
): boolean {
  return status === 'ready' || status === 'empty' || status === 'unknown'
}

/** A settled catalog is stable; re-reading it every render would be waste. */
const READY_REFRESH_MS = 5 * 60_000
/**
 * Retry an empty/unknown answer far sooner: on first install the user is
 * actively configuring a provider in another pane, and the pill should notice
 * without a restart.
 */
const RETRY_REFRESH_MS = 15_000

interface LocalDaemonCatalogState {
  byWorkspacePath: Record<string, LocalDaemonCatalogEntry>
  setEntry: (workspacePath: string, entry: LocalDaemonCatalogEntry) => void
  clear: () => void
}

export const useLocalDaemonCatalogStore = createZustand<LocalDaemonCatalogState>((set) => ({
  byWorkspacePath: {},
  setEntry: (workspacePath, entry) =>
    set((state) => ({
      byWorkspacePath: { ...state.byWorkspacePath, [workspacePath]: entry },
    })),
  clear: () => set({ byWorkspacePath: {} }),
}))

/** In-flight fetches, so N pills for one workspace share one request. */
const inFlight = new Map<string, Promise<void>>()

function refreshDueAt(entry: LocalDaemonCatalogEntry): number {
  return entry.fetchedAt + (entry.status === 'ready' ? READY_REFRESH_MS : RETRY_REFRESH_MS)
}

/** Whether a fetch should be started for `workspacePath` right now. */
export function shouldFetchLocalDaemonCatalog(
  entry: LocalDaemonCatalogEntry | undefined,
  now: number,
): boolean {
  if (!entry) return true
  if (entry.status === 'pending') return false
  return now >= refreshDueAt(entry)
}

/**
 * Fire-and-forget refresh of this device's catalog. Safe to call on every
 * render — it dedupes in-flight requests and respects the refresh interval.
 *
 * Callers MUST have established that the agent in question is the local daemon;
 * this reaches loopback HTTP and says nothing about any remote agent.
 */
export function ensureLocalDaemonCatalog(
  workspacePath: string,
  backendType?: string | null,
): void {
  const path = workspacePath.trim()
  if (!path) return
  if (inFlight.has(path)) return

  const store = useLocalDaemonCatalogStore.getState()
  if (!shouldFetchLocalDaemonCatalog(store.byWorkspacePath[path], Date.now())) return

  const previous = store.byWorkspacePath[path]
  // Keep whatever we already resolved visible while refreshing — a periodic
  // re-probe must never blank the picker mid-session.
  store.setEntry(path, {
    status: 'pending',
    models: previous?.models ?? [],
    recentModels: previous?.recentModels ?? [],
    fetchedAt: previous?.fetchedAt ?? 0,
  })

  const task = (async () => {
    try {
      const outcome = await fetchLocalDaemonCatalog(path, backendType)
      const settled: LocalDaemonCatalogEntry =
        outcome.status === 'models'
          ? {
              status: 'ready',
              models: outcome.models,
              recentModels: outcome.recentModels,
              fetchedAt: Date.now(),
            }
          : {
              status: outcome.status === 'empty' ? 'empty' : 'unknown',
              // An 'empty' answer is authoritative — drop any stale list so the
              // UI can honestly say "nothing configured". 'unknown' means we
              // learned nothing, so the previous list stands.
              models: outcome.status === 'empty' ? [] : (previous?.models ?? []),
              recentModels:
                outcome.status === 'empty' ? [] : (previous?.recentModels ?? []),
              fetchedAt: Date.now(),
            }
      useLocalDaemonCatalogStore.getState().setEntry(path, settled)
    } catch (error) {
      // A display fast path must never break the pill it feeds.
      console.warn('[local-daemon-catalog] fetch failed', error)
      useLocalDaemonCatalogStore.getState().setEntry(path, {
        status: 'unknown',
        models: previous?.models ?? [],
        recentModels: previous?.recentModels ?? [],
        fetchedAt: Date.now(),
      })
    } finally {
      inFlight.delete(path)
    }
  })()

  inFlight.set(path, task)
}

/** Test seam — drops cached entries and any in-flight dedupe state. */
export function resetLocalDaemonCatalogForTests(): void {
  inFlight.clear()
  useLocalDaemonCatalogStore.getState().clear()
}
