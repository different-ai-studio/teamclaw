import { create } from 'zustand'
import { isTauri } from '@/lib/utils'
import { markStartup } from '@/lib/startup-perf'
import { appStoragePrefix, localAgent } from '@/lib/build-config'

// Cache the last-known "all required deps satisfied" verdict so a returning user
// (deps already installed) is never gated behind the cold `setup_list_requirements`
// probe, which spawns `amuxd doctor` and costs ~4s on first launch (macOS
// Gatekeeper). The probe still runs in the background to refresh this flag; the
// daemon-onboarding gate remains the real backstop if a dependency is missing.
const SETUP_OK_KEY = `${appStoragePrefix}-setup-ok`

/** True if a prior probe confirmed all required deps were present. Sync, cheap. */
export function setupPreviouslySatisfied(): boolean {
  try {
    return localStorage.getItem(SETUP_OK_KEY) === '1'
  } catch {
    return false
  }
}

function persistSetupSatisfied(ok: boolean): void {
  try {
    localStorage.setItem(SETUP_OK_KEY, ok ? '1' : '0')
  } catch {
    /* private mode / storage disabled — optimistic skip just won't apply */
  }
}

export type RequirementStatus = {
  id: string
  title: string
  optional: boolean
  present: boolean
  version: string | null
}

export type SetupProgress = {
  id: string
  status: 'started' | 'running' | 'done' | 'failed'
  line: string | null
  error: string | null
}

type SetupState = {
  requirements: RequirementStatus[]
  /** Install status of every selectable runtime — populated by [`listAgentRuntimes`]. */
  agentRuntimes: RequirementStatus[]
  installing: string | null
  output: Record<string, string[]>
  errors: Record<string, string>
  loaded: boolean
  /**
   * `agent` overrides which runtime the requirement list reports on. Onboarding
   * passes the user's pick (#881). Without it — the background probe that
   * refreshes the setup-ok cache — the backend counts any installed runtime as
   * satisfying, so a pi machine is not failed against the build default.
   */
  listRequirements: (agent?: string) => Promise<void>
  listAgentRuntimes: () => Promise<void>
  install: (id: string, opts?: { minDurationMs?: number }) => Promise<void>
  requiredSatisfied: () => boolean
}

/** Resolve after `ms`, used to keep a fast install's loading state visible. */
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export const useSetupStore = create<SetupState>((set, get) => ({
  requirements: [],
  agentRuntimes: [],
  installing: null,
  output: {},
  errors: {},
  loaded: false,

  // A required dep blocks continuing only when truly absent (no `version`
  // detected at all). If it's installed but outdated/upgrade-failed
  // (`present: false` with a `version`), the wizard still offers the upgrade
  // but no longer blocks entry — the user already has a working runtime.
  requiredSatisfied: () =>
    get()
      .requirements.filter((r) => !r.optional)
      .every((r) => r.present || r.version != null),

  listRequirements: async (agent?: string) => {
    if (!isTauri()) {
      set({ loaded: true })
      return
    }
    markStartup('setup-list:start')
    const { invoke } = await import('@tauri-apps/api/core')
    const requirements = await invoke<RequirementStatus[]>('setup_list_requirements', {
      localAgent: agent ?? null,
    })
    markStartup('setup-list:end')
    set({ requirements, loaded: true })
    // Refresh the optimistic-skip cache for the next launch.
    persistSetupSatisfied(get().requiredSatisfied())
  },

  listAgentRuntimes: async () => {
    if (!isTauri()) return
    const { invoke } = await import('@tauri-apps/api/core')
    set({ agentRuntimes: await invoke<RequirementStatus[]>('setup_list_agent_runtimes') })
  },

  install: async (id: string, opts?: { minDurationMs?: number }) => {
    const minDurationMs = opts?.minDurationMs ?? 0
    if (!isTauri()) {
      // Browser/dev preview: no real install, but still honor the minimum
      // duration so the loading effect (e.g. amuxd auto-install) is visible.
      if (minDurationMs > 0) {
        set((s) => ({ installing: id, errors: { ...s.errors, [id]: '' } }))
        await delay(minDurationMs)
        set((s) => ({
          installing: null,
          requirements: s.requirements.map((r) => (r.id === id ? { ...r, present: true } : r)),
        }))
      }
      return
    }
    const { invoke } = await import('@tauri-apps/api/core')
    const { listen } = await import('@tauri-apps/api/event')
    // Clear any prior error for this id so a retry starts clean.
    set((s) => ({ installing: id, errors: { ...s.errors, [id]: '' } }))
    // Listener lives only for this install and is removed in finally. The wizard
    // is modal/non-dismissible during install, so unmount-mid-install is not a
    // concern; applyProgress writes to the singleton store regardless.
    const unlisten = await listen<SetupProgress>('setup-progress', (event) => {
      applyProgress(event.payload)
    })
    try {
      // Run the real install and the minimum-duration timer concurrently so a
      // near-instant install (e.g. amuxd copy) still shows ~minDurationMs of
      // loading without padding genuinely slow installs.
      await Promise.all([
        (async () => {
          await invoke('setup_install', { id })
          // Re-probe against the runtime just installed, not the build default —
          // otherwise installing pi refreshes opencode's row and pi still reads
          // as missing.
          const probeAgent = id === 'pi' || id === 'opencode' ? id : localAgent
          const requirements = await invoke<RequirementStatus[]>('setup_list_requirements', {
            localAgent: probeAgent,
          })
          set({ requirements })
          if (id === 'pi' || id === 'opencode') await get().listAgentRuntimes()
        })(),
        minDurationMs > 0 ? delay(minDurationMs) : Promise.resolve(),
      ])
    } catch (e) {
      set((s) => ({ errors: { ...s.errors, [id]: String(e) } }))
    } finally {
      unlisten()
      set({ installing: null })
    }
  },
}))

/** Pure reducer applied to each setup-progress event (exported for tests). */
export function applyProgress(p: SetupProgress) {
  useSetupStore.setState((s) => {
    const output = { ...s.output }
    const errors = { ...s.errors }
    let requirements = s.requirements

    // 'started' is intentionally a no-op: `installing` is already set client-side
    // by install() before the backend runs.
    if (p.status === 'running' && p.line) {
      output[p.id] = [...(output[p.id] ?? []), p.line]
    }
    if (p.status === 'failed' && p.error) {
      errors[p.id] = p.error
    }
    if (p.status === 'done') {
      requirements = requirements.map((r) => (r.id === p.id ? { ...r, present: true } : r))
    }
    return { output, errors, requirements }
  })
}
