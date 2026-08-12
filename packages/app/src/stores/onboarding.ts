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
/** The setup step has been cleared. Persisted so quitting on the model step
 *  resumes there instead of re-running dependency setup from the top. */
const SETUP_ACK_KEY = `${appStoragePrefix}-onboarding-setup-ack`

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
  /** The setup step has been cleared; the flow resumes at the model step. */
  setupAck: boolean
  role: OnboardingRole | null
  /** Runtime chosen on the setup step; null until the user gets there. */
  runtime: DaemonLocalAgent | null
  /** The whole first-run flow has been completed at least once. */
  completed: boolean
  markLanguageAck: () => void
  markSetupAck: () => void
  /** True once the user has answered anything at all. Distinguishes "mid-flow,
   *  came back" from "never started", which decide different things. */
  started: () => boolean
  setRole: (role: OnboardingRole) => void
  setRuntime: (runtime: DaemonLocalAgent) => void
  markCompleted: () => void
  /** Test/dev helper — forget everything and run the flow again. */
  reset: () => void
}

const readFlag = (key: string): boolean => {
  try {
    return localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

export const useOnboardingStore = create<OnboardingState>((set, get) => ({
  languageAck: readFlag(LANGUAGE_ACK_KEY),
  setupAck: readFlag(SETUP_ACK_KEY),
  role: readStored<OnboardingRole>(ROLE_KEY, ['developer', 'guided']),
  runtime: null,
  completed: readFlag(DONE_KEY),

  markLanguageAck: () => {
    write(LANGUAGE_ACK_KEY, '1')
    set({ languageAck: true })
  },

  markSetupAck: () => {
    write(SETUP_ACK_KEY, '1')
    set({ setupAck: true })
  },

  started: () => {
    const s = get()
    return s.languageAck || s.role !== null || s.setupAck
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
    write(SETUP_ACK_KEY, null)
    set({ languageAck: false, setupAck: false, role: null, runtime: null, completed: false })
  },
}))
