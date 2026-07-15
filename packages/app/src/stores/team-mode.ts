import { create } from 'zustand'
import { deleteDaemonProviderAuth, encodeWorkspaceId } from '@/lib/daemon-local-client'
import { TEAM_SHARED_PROVIDER_ID } from '@/lib/team-provider'
import { getBackend } from '@/lib/backend'
import { useProviderStore } from './provider'
import { useWorkspaceStore } from './workspace'
import { useTeamShareStore } from './team-share'
import { useCurrentTeamStore } from './current-team'
import { isTauri } from '@/lib/utils'
import { workspaceScopedKey } from '@/lib/storage'
import { appShortName, buildConfig, TEAM_REPO_DIR, type TeamModelOption } from '@/lib/build-config'


const TEAM_PROVIDER_ID = TEAM_SHARED_PROVIDER_ID

const TEAM_MODEL_BASE = `${appShortName}-team-model`
const PRE_TEAM_MODEL_BASE = `${appShortName}-pre-team-model`

function teamModelKey(): string {
  return workspaceScopedKey(TEAM_MODEL_BASE, useWorkspaceStore.getState().workspacePath)
}

function preTeamModelKey(): string {
  return workspaceScopedKey(PRE_TEAM_MODEL_BASE, useWorkspaceStore.getState().workspacePath)
}

// Read with workspace-scoped key first, fall back to legacy unscoped key
// for users upgrading from before workspace scoping.
function readTeamModel(): string | null {
  return localStorage.getItem(teamModelKey()) ?? localStorage.getItem(TEAM_MODEL_BASE)
}

function readPreTeamModel(): string | null {
  return localStorage.getItem(preTeamModelKey()) ?? localStorage.getItem(PRE_TEAM_MODEL_BASE)
}

/**
 * Upgrade `http://` → `https://` for remote LLM hosts.
 *
 * LiteLLM deployments behind Caddy/Nginx typically 308-redirect `http` → `https`,
 * and both fetch and the AI SDK drop the `Authorization` header across that
 * redirect — surfacing as `Authentication Error, No api key passed in.` on
 * chat-completions calls. Force https for any non-local host before we hand
 * the URL to the agent provider config.
 *
 * Local/private hosts keep `http://` (they don't redirect, and users may run
 * a dev LiteLLM without TLS).
 */
function normalizeLlmBaseUrl(url: string): string {
  if (!url.startsWith('http://')) return url
  try {
    const parsed = new URL(url)
    const host = parsed.hostname
    const isLocal =
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '0.0.0.0' ||
      host.endsWith('.local') ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    if (isLocal) return url
    parsed.protocol = 'https:'
    return parsed.toString().replace(/\/$/, '')
  } catch {
    return url
  }
}

export interface TeamModelConfig {
  baseUrl: string
  model: string
  modelName: string
}

interface TeamModeState {
  teamModelConfig: TeamModelConfig | null
  teamModelOptions: TeamModelOption[] // available model choices from build config
  _appliedConfigKey: string | null // fingerprint of last applied config to avoid redundant apply
  devUnlocked: boolean // hidden dev mode: unlocks model selector & hidden dirs in team mode
  teamGitFileSyncStatusMap: Record<string, 'modified' | 'new'>
  /** True while a Git team sync is in progress (for file tree loading indicator) */
  teamGitSyncing: boolean
  /** ISO timestamp of last successful team repo sync (read from teamclaw.json) */
  teamGitLastSyncAt: string | null

  loadTeamConfig: (workspacePath: string) => Promise<void>
  applyTeamModel: (workspacePath: string, force?: boolean) => Promise<void>
  switchTeamModel: (modelId: string, workspacePath: string) => Promise<void>
  clearTeamMode: (workspacePath?: string) => Promise<void>
  setDevUnlocked: (unlocked: boolean) => void
  loadTeamGitFileSyncStatus: (workspacePath: string) => Promise<void>
}

interface CloudTeamLlm {
  enabled: boolean
  baseUrl: string | null
  models: Array<{ id: string; name: string }>
}

/**
 * Read the per-team LLM config from the cloud (`GET /v1/teams/:id/workspace-config`
 * → `llm`). The cloud is the source of truth for the team's shared model list.
 */
async function fetchCloudTeamLlm(): Promise<CloudTeamLlm | null> {
  const teamId = useCurrentTeamStore.getState().team?.id
  if (!teamId) return null
  try {
    const llm = await getBackend().teamWorkspaceConfig.loadLlmConfig(teamId)
    if (!llm || !llm.enabled) return null
    return { enabled: llm.enabled, baseUrl: llm.baseUrl, models: llm.models ?? [] }
  } catch (err) {
    console.warn('[TeamMode] Failed to read cloud team LLM config:', err)
    return null
  }
}


export const useTeamModeStore = create<TeamModeState>((set, get) => ({
  teamModelConfig: null,
  teamModelOptions: [],
  _appliedConfigKey: null,
  devUnlocked: true,
  teamGitSyncing: false,
  teamGitLastSyncAt: null,
  teamGitFileSyncStatusMap: {},

  loadTeamConfig: async (_workspacePath: string) => {
    const cloudLlm = await fetchCloudTeamLlm()
    // Load last sync timestamp from teamclaw.json (git mode persists it via team_sync_repo)
    if (isTauri()) {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        const teamConfig = await invoke<{ lastSyncAt?: string | null } | null>('get_team_config', {
          workspacePath: _workspacePath,
        })
        set({ teamGitLastSyncAt: teamConfig?.lastSyncAt ?? null })
      } catch { /* ignore */ }
    }
    // The team share mode is owned by the cloud (`team-share` store). Git-backed
    // file-sync status only applies to managed_git / custom_git share modes.
    const shareMode = useTeamShareStore.getState().status.mode
    const isGitShareMode = shareMode === 'managed_git' || shareMode === 'custom_git'
    // We still load the LLM provider config below; it is gated on whether the
    // workspace has any team LLM config, independent of share mode.
    {
      if (isGitShareMode && _workspacePath) {
        // Fire-and-forget; errors swallowed inside action
        get().loadTeamGitFileSyncStatus(_workspacePath)
      }
      // The cloud (`GET /v1/teams/:id/workspace-config` → `llm`) is the sole
      // source of truth for the team's shared model list. The daemon materializes
      // `opencode.json`'s `provider.team` directly from the cloud too, so there is
      // no longer a `_meta/provider.json` mirror to read here.
      if (cloudLlm && cloudLlm.baseUrl && cloudLlm.models.length > 0) {
        const teamModels = cloudLlm.models
        let selected = teamModels[0]
        try {
          const savedModelId = readTeamModel()
          const match = savedModelId ? teamModels.find((m) => m.id === savedModelId) : null
          if (match) selected = match
        } catch { /* ignore */ }
        const config: TeamModelConfig = {
          baseUrl: normalizeLlmBaseUrl(cloudLlm.baseUrl),
          model: selected?.id || '',
          modelName: selected?.name || selected?.id || '',
        }
        set({ teamModelConfig: config, teamModelOptions: teamModels })
      } else {
        set({ teamModelConfig: null })
      }
    }
  },

  applyTeamModel: async (_workspacePath: string, force?: boolean) => {
    // Refresh in-memory state from the cloud (source of truth). The daemon owns
    // the on-disk `opencode.json` `provider.team`, materialized directly from the
    // same cloud config — we never read or write it from here.
    const cloudLlm = await fetchCloudTeamLlm()
    if (cloudLlm && cloudLlm.baseUrl && cloudLlm.models.length > 0) {
      const syncedModels = cloudLlm.models
      let defaultModel = syncedModels[0]
      try {
        const savedModelId = readTeamModel()
        const match = savedModelId ? syncedModels.find((m) => m.id === savedModelId) : null
        if (match) defaultModel = match
      } catch { /* ignore */ }
      set({
        teamModelConfig: {
          baseUrl: normalizeLlmBaseUrl(cloudLlm.baseUrl),
          model: defaultModel?.id || '',
          modelName: defaultModel?.name || defaultModel?.id || '',
        },
        teamModelOptions: syncedModels,
      })
    }

    const { teamModelConfig, _appliedConfigKey } = get()
    if (!teamModelConfig) return

    // The fingerprint must cover the whole option list, not just the selection:
    // an admin adding or renaming a model the member has not selected leaves
    // `baseUrl|model` identical, and without the list in the key that change
    // would be dropped here and never reach the provider store.
    const optionsKey = get()
      .teamModelOptions.map((option) => `${option.id}:${option.name}`)
      .join(',')
    const configKey = `${teamModelConfig.baseUrl}|${teamModelConfig.model}|${optionsKey}`
    if (!force && configKey === _appliedConfigKey) return
    set({ _appliedConfigKey: configKey })

    try {
      const providerStore = useProviderStore.getState()
      const currentModel = providerStore.currentModelKey
      if (currentModel && !currentModel.startsWith('team/')) {
        try {
          localStorage.setItem(preTeamModelKey(), currentModel)
        } catch { /* ignore */ }
      }

      await providerStore.selectModel(TEAM_PROVIDER_ID, teamModelConfig.model, teamModelConfig.modelName)
      await providerStore.refreshConfiguredProviders()
    } catch (err) {
      console.error('[TeamMode] Failed to apply team model:', err)
    }
  },

  switchTeamModel: async (modelId: string, _workspacePath: string) => {
    const { teamModelConfig, teamModelOptions } = get()
    if (!teamModelConfig) return
    const option = teamModelOptions.find((m) => m.id === modelId)
    if (!option) return

    const newConfig: TeamModelConfig = {
      baseUrl: teamModelConfig.baseUrl,
      model: modelId,
      modelName: option.name,
    }
    set({ teamModelConfig: newConfig })

    // Select the model in the agent runtime (all models are already registered in the provider)
    const providerStore = useProviderStore.getState()
    await providerStore.selectModel(TEAM_PROVIDER_ID, modelId, option.name)

    // Persist selection
    try {
      localStorage.setItem(teamModelKey(), modelId)
    } catch { /* ignore */ }

    console.log('[TeamMode] Switched team model to:', modelId)
  },

  setDevUnlocked: (_unlocked: boolean) => {
    set({ devUnlocked: true })
  },

  loadTeamGitFileSyncStatus: async (workspacePath: string) => {
    if (!isTauri() || !workspacePath) return
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const result = await invoke<{
        branch: string | null
        clean: boolean
        files: Array<{ path: string; status: string; staged: boolean }>
      }>('git_status', { path: `${workspacePath}/${TEAM_REPO_DIR}` })
      const map: Record<string, 'modified' | 'new'> = {}
      for (const f of result.files) {
        if (f.status === 'untracked') {
          map[f.path] = 'new'
        } else if (
          f.status === 'modified' ||
          f.status === 'added' ||
          f.status === 'deleted' ||
          f.status === 'renamed' ||
          f.status === 'copied'
        ) {
          map[f.path] = 'modified'
        }
        // 'ignored' and 'unknown' are omitted
      }
      set({ teamGitFileSyncStatusMap: map })
    } catch (e) {
      console.debug('[team-mode] loadTeamGitFileSyncStatus skipped:', e)
    }
  },

  clearTeamMode: async (workspacePath?: string) => {
    // When LLM config is locked via build config, prevent exiting team mode
    if (buildConfig.team.lockLlmConfig) return

    // Set state immediately to trigger UI updates
    set({ teamModelConfig: null, _appliedConfigKey: null, teamGitFileSyncStatusMap: {} })

    if (workspacePath) {
      try {
        await deleteDaemonProviderAuth(encodeWorkspaceId(workspacePath), TEAM_PROVIDER_ID)
      } catch { /* ignore */ }
    }

    // Restore previous model if available
    try {
      const preTeamModel = readPreTeamModel()
      const providerStore = useProviderStore.getState()

      // Force disconnect the team provider to remove it from the list immediately
      await providerStore.disconnectProvider(TEAM_PROVIDER_ID)

      // Ensure UI updates by refreshing providers and initializing
      await providerStore.initAll()

      if (preTeamModel && !preTeamModel.startsWith('team/')) {
        const parts = preTeamModel.split('/')
        if (parts.length >= 2) {
          const providerId = parts[0]
          const modelId = parts.slice(1).join('/')
          // Give it a small delay to ensure providers are loaded
          setTimeout(async () => {
            await providerStore.selectModel(providerId, modelId, modelId)
            // Force a refresh of the current model to ensure UI updates
            await providerStore.refreshCurrentModel()
          }, 500)
        }
        localStorage.removeItem(preTeamModelKey())
        localStorage.removeItem(PRE_TEAM_MODEL_BASE)
      } else {
        // If no valid previous model, try to select the first available one
        setTimeout(async () => {
          const models = useProviderStore.getState().models
          const nonTeamModels = models.filter(m => m.provider !== 'team')
          if (nonTeamModels.length > 0) {
            const firstModel = nonTeamModels[0]
            await providerStore.selectModel(firstModel.provider, firstModel.id, firstModel.name)
            await providerStore.refreshCurrentModel()
          }
        }, 500)
      }
    } catch { /* ignore */ }
  },
}))
