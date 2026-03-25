import { create } from 'zustand'
import { isTauri } from '@/lib/utils'
import { loadFromStorage, saveToStorage } from '@/lib/storage'
import { appShortName } from '@/lib/build-config'

export interface DependencyInfo {
  name: string
  installed: boolean
  version: string | null
  required: boolean
  description: string
  install_commands: {
    macos: string
    windows: string
    linux: string
  }
  affected_features: string[]
  /** Install priority — lower numbers install first (e.g., Homebrew = 0, others = 1) */
  priority: number
}

export interface InstallResult {
  success: boolean
  error?: string
}

/** Event payload from Tauri dep-install-progress */
interface DepInstallProgressEvent {
  name: string
  status: 'started' | 'installing' | 'done' | 'failed'
  outputLine?: string | null
  error?: string | null
}

// ─── Persistent setup status ─────────────────────────────────────────────────

const DEPS_SETUP_KEY = `${appShortName}-deps-setup-status`
/** Re-check interval: 24 hours */
const RECHECK_TTL_MS = 24 * 60 * 60 * 1000

interface DepsSetupStatus {
  /** Whether user has completed or skipped the setup guide */
  setupCompleted: boolean
  /** Timestamp of last dependency check */
  lastCheckAt: number
  /** Snapshot of last check: dep name → installed */
  lastCheckResults: Record<string, boolean>
}

function loadSetupStatus(): DepsSetupStatus | null {
  return loadFromStorage<DepsSetupStatus | null>(DEPS_SETUP_KEY, null)
}

function saveSetupStatus(status: DepsSetupStatus): void {
  saveToStorage(DEPS_SETUP_KEY, status)
}

/** Mark setup as completed (called when user skips or finishes install). */
export function markSetupCompleted(): void {
  const existing = loadSetupStatus()
  saveSetupStatus({
    setupCompleted: true,
    lastCheckAt: existing?.lastCheckAt ?? Date.now(),
    lastCheckResults: existing?.lastCheckResults ?? {},
  })
}

/**
 * Determine whether the setup guide should be shown.
 * Returns:
 *  - 'show'        — first launch or required deps missing
 *  - 'skip'        — user already completed setup and cache is fresh
 *  - 'silent-check' — cache is stale, re-check silently in background
 */
export function getSetupDecision(): 'show' | 'skip' | 'silent-check' {
  // Debug mode: always show
  if (isDebugForceSetup()) return 'show'

  const status = loadSetupStatus()

  // Never completed setup → always show (will be gated by actual check result)
  if (!status || !status.setupCompleted) return 'show'

  const age = Date.now() - status.lastCheckAt

  // Setup completed and cache is fresh → skip
  if (age < RECHECK_TTL_MS) return 'skip'

  // Setup completed but cache is stale → re-check silently
  return 'silent-check'
}

// ─── Store ───────────────────────────────────────────────────────────────────

interface DepsState {
  dependencies: DependencyInfo[]
  checked: boolean
  loading: boolean

  /** Install state */
  installing: boolean
  currentInstalling: string | null
  installQueue: string[]
  installResults: Record<string, InstallResult>
  installOutput: Record<string, string[]>

  /** Check all dependencies via Tauri command */
  checkDependencies: () => Promise<DependencyInfo[]>

  /** Get a specific dependency by name */
  getDep: (name: string) => DependencyInfo | undefined

  /** Check if a specific dependency is installed */
  isInstalled: (name: string) => boolean

  /** Install dependencies serially in priority order */
  installDependencies: (names: string[]) => Promise<void>

  /** Reset install state for retry */
  resetInstallState: () => void
}


/**
 * Debug: set localStorage.setItem(`${appShortName}-debug-force-setup`, '1') to force
 * SetupGuide to show in browser dev mode with mock dependency data.
 * Remove the key to disable: localStorage.removeItem(`${appShortName}-debug-force-setup`)
 */
const isDebugForceSetup = () => {
  try {
    return localStorage.getItem(`${appShortName}-debug-force-setup`) === '1'
  } catch {
    return false
  }
}

/** Mock dependencies for browser dev mode testing */
function getMockDependencies(): DependencyInfo[] {
  return [
    { name: 'brew', installed: false, version: null, required: false, description: 'Package manager - needed to install other tools on macOS', install_commands: { macos: '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"', windows: '', linux: '' }, affected_features: ['Package Management'], priority: 0 },
    { name: 'git', installed: true, version: '2.43.0', required: false, description: 'Version control - needed for team Git sync', install_commands: { macos: 'xcode-select --install', windows: 'winget install Git.Git', linux: 'sudo apt install -y git' }, affected_features: ['Team Git Sync', 'Version Control'], priority: 1 },
    { name: 'gh', installed: false, version: null, required: false, description: 'GitHub CLI - needed for spec-plan, spec-pr, and issue management', install_commands: { macos: 'brew install gh', windows: 'winget install GitHub.cli', linux: 'sudo apt install -y gh' }, affected_features: ['spec-plan', 'spec-pr', 'GitHub Issues'], priority: 1 },
    { name: 'node', installed: true, version: '22.1.0', required: false, description: 'Node.js runtime - needed to run some MCP servers (via npx)', install_commands: { macos: 'brew install node', windows: 'winget install OpenJS.NodeJS', linux: 'sudo apt install -y nodejs' }, affected_features: ['MCP Servers (npx-based)'], priority: 1 },
    { name: 'python3', installed: false, version: null, required: false, description: 'Python runtime - needed for uvx-based MCP servers and data analysis', install_commands: { macos: 'brew install python3', windows: 'winget install Python.Python.3', linux: 'sudo apt install -y python3' }, affected_features: ['MCP Servers (uvx-based)', 'Data Analysis'], priority: 1 },
    { name: 'gog', installed: false, version: null, required: false, description: 'Google Workspace CLI - Gmail, Calendar, Drive, Sheets, Docs access', install_commands: { macos: 'brew install steipete/tap/gogcli', windows: '', linux: '' }, affected_features: ['Gmail', 'Google Calendar', 'Google Drive', 'Google Sheets'], priority: 1 },
  ]
}

export const useDepsStore = create<DepsState>((set, get) => ({
  dependencies: [],
  checked: false,
  loading: false,

  // Install state
  installing: false,
  currentInstalling: null,
  installQueue: [],
  installResults: {},
  installOutput: {},

  checkDependencies: async () => {
    if (!isTauri()) {
      // Debug mode: return mock data so SetupGuide can be tested in browser
      if (isDebugForceSetup()) {
        const mock = getMockDependencies()
        set({ dependencies: mock, checked: true, loading: false })
        return mock
      }
      set({ checked: true, loading: false })
      return []
    }

    set({ loading: true })
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const result = await invoke<DependencyInfo[]>('check_dependencies')
      set({ dependencies: result, checked: true, loading: false })

      // Persist check results to localStorage (preserves setupCompleted flag)
      const existing = loadSetupStatus()
      const snapshot: Record<string, boolean> = {}
      for (const dep of result) {
        snapshot[dep.name] = dep.installed
      }
      saveSetupStatus({
        setupCompleted: existing?.setupCompleted ?? false,
        lastCheckAt: Date.now(),
        lastCheckResults: snapshot,
      })

      return result
    } catch (err) {
      console.error('[DepsStore] Failed to check dependencies:', err)
      set({ checked: true, loading: false })
      return get().dependencies
    }
  },

  getDep: (name: string) => {
    return get().dependencies.find((d) => d.name === name)
  },

  isInstalled: (name: string) => {
    const dep = get().dependencies.find((d) => d.name === name)
    return dep?.installed ?? true // Default to true if not checked yet
  },

  installDependencies: async (names: string[]) => {
    if (!isTauri() || names.length === 0) return

    const { invoke } = await import('@tauri-apps/api/core')
    const { listen } = await import('@tauri-apps/api/event')

    // Sort names by priority using current dependency data
    const deps = get().dependencies
    const sorted = [...names].sort((a, b) => {
      const depA = deps.find((d) => d.name === a)
      const depB = deps.find((d) => d.name === b)
      return (depA?.priority ?? 1) - (depB?.priority ?? 1)
    })

    // Reset install state
    const initialOutput: Record<string, string[]> = {}
    const initialResults: Record<string, InstallResult> = {}
    for (const name of sorted) {
      initialOutput[name] = []
      initialResults[name] = { success: false }
    }

    set({
      installing: true,
      installQueue: sorted,
      installResults: initialResults,
      installOutput: initialOutput,
      currentInstalling: null,
    })

    // Listen for progress events
    const unlisten = await listen<DepInstallProgressEvent>('dep-install-progress', (event) => {
      const { name, status, outputLine, error } = event.payload
      const state = get()

      if (status === 'started') {
        set({ currentInstalling: name })
      } else if (status === 'installing' && outputLine) {
        const currentOutput = state.installOutput[name] || []
        set({
          installOutput: {
            ...state.installOutput,
            [name]: [...currentOutput, outputLine],
          },
        })
      } else if (status === 'done') {
        set({
          installResults: {
            ...state.installResults,
            [name]: { success: true },
          },
        })
      } else if (status === 'failed') {
        set({
          installResults: {
            ...state.installResults,
            [name]: { success: false, error: error ?? 'Installation failed' },
          },
        })
      }
    })

    // Install each dependency serially
    try {
      for (const name of sorted) {
        try {
          await invoke<boolean>('install_dependency', { name })
        } catch (err) {
          console.error(`[DepsStore] Failed to install ${name}:`, err)
          const state = get()
          set({
            installResults: {
              ...state.installResults,
              [name]: { success: false, error: String(err) },
            },
          })
        }
      }
    } finally {
      unlisten()
      set({ installing: false, currentInstalling: null })
    }
  },

  resetInstallState: () => {
    set({
      installing: false,
      currentInstalling: null,
      installQueue: [],
      installResults: {},
      installOutput: {},
    })
  },
}))
