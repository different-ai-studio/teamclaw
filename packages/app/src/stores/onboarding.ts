import { create } from 'zustand'
import { appStoragePrefix } from '@/lib/build-config'
import type { DaemonLocalAgent } from '@/lib/daemon-local-client'

/**
 * How much of the setup the user wants to drive themselves (#881).
 *
 * `developer` — pick the agent runtime, see git and the rest of the dependency
 *   detail, configure models later in Settings.
 * `guided` — take the recommended runtime, skip anything optional, and get
 *   walked through connecting one model provider.
 *
 * Named for what the user is doing, not for how skilled we think they are:
 * these values reach log lines and telemetry, and "novice" is not a label to
 * attach to somebody.
 */
export type OnboardingRole = 'developer' | 'guided'

const ROLE_KEY = `${appStoragePrefix}-onboarding-role`
const DONE_KEY = `${appStoragePrefix}-onboarding-done`
/** The language step has been answered. Separate from the language itself:
 *  `${appStoragePrefix}-language` records *what* was picked, this records
 *  *that* it was asked, so a user who confirms the system default is not asked
 *  again on the next launch. */
const LANGUAGE_ACK_KEY = `${appStoragePrefix}-onboarding-language-ack`

function readStored<T extends string>(key: string, valid: readonly T[]): T | null {
  try {
    const raw = localStorage.getItem(key)
    return raw && (valid as readonly string[]).includes(raw) ? (raw as T) : null
  } catch {
    return null
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    // Private mode / disabled storage: onboarding still works for this run, it
    // just asks again next launch. Not worth failing the flow over.
  }
}

type OnboardingState = {
  /** The language step has been answered at least once. */
  languageAck: boolean
  role: OnboardingRole | null
  /** Runtime chosen on the setup step; null until the user gets there. */
  runtime: DaemonLocalAgent | null
  /** The whole first-run flow has been completed at least once. */
  completed: boolean
  markLanguageAck: () => void
  setRole: (role: OnboardingRole) => void
  setRuntime: (runtime: DaemonLocalAgent) => void
  markCompleted: () => void
  /** Test/dev helper — forget everything and run the flow again. */
  reset: () => void
}

export const useOnboardingStore = create<OnboardingState>((set) => ({
  languageAck: (() => {
    try {
      return localStorage.getItem(LANGUAGE_ACK_KEY) === '1'
    } catch {
      return false
    }
  })(),
  role: readStored<OnboardingRole>(ROLE_KEY, ['developer', 'guided']),
  runtime: null,
  completed: (() => {
    try {
      return localStorage.getItem(DONE_KEY) === '1'
    } catch {
      return false
    }
  })(),

  markLanguageAck: () => {
    write(LANGUAGE_ACK_KEY, '1')
    set({ languageAck: true })
  },

  setRole: (role) => {
    write(ROLE_KEY, role)
    set({ role })
  },

  // Deliberately not persisted: the authority for which runtime is active is
  // the daemon's own `agents.local_agent`, and mirroring it here would just
  // create a second copy to drift out of sync.
  setRuntime: (runtime) => set({ runtime }),

  markCompleted: () => {
    write(DONE_KEY, '1')
    set({ completed: true })
  },

  reset: () => {
    write(ROLE_KEY, null)
    write(DONE_KEY, null)
    write(LANGUAGE_ACK_KEY, null)
    set({ languageAck: false, role: null, runtime: null, completed: false })
  },
}))
