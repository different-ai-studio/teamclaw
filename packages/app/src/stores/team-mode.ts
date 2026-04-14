import { create } from 'zustand'
import {
  addCustomProviderToConfig,
  getCustomProviderConfig,
  removeCustomProviderFromConfig,
} from '@/lib/opencode/config'
import { useProviderStore } from './provider'
import { isTauri } from '@/lib/utils'
import { appShortName, buildConfig, type TeamModelOption } from '@/lib/build-config'


const TEAM_PROVIDER_ID = 'team'

export interface TeamModelConfig {
  baseUrl: string
  model: string
  modelName: string
}

interface TeamModeState {
  teamMode: boolean
  teamModeType: string | null // "p2p" | "oss" | "webdav" | "git" — from teamclaw.json
  teamModelConfig: TeamModelConfig | null
  teamModelOptions: TeamModelOption[] // available model choices from build config
  _appliedConfigKey: string | null // fingerprint of last applied config to avoid redundant apply
  devUnlocked: boolean // hidden dev mode: unlocks model selector & hidden dirs in team mode
  myRole: 'owner' | 'editor' | 'viewer' | null
  p2pConnected: boolean
  p2pConfigured: boolean
  p2pFileSyncStatusMap: Record<string, 'synced' | 'modified' | 'new'>
  /** True while a Git team sync is in progress (for file tree loading indicator) */
  teamGitSyncing: boolean

  loadTeamConfig: (workspacePath: string) => Promise<void>
  applyTeamModelToOpenCode: (workspacePath: string, force?: boolean) => Promise<void>
  switchTeamModel: (modelId: string, workspacePath: string) => Promise<void>
  clearTeamMode: (workspacePath?: string) => Promise<void>
  setDevUnlocked: (unlocked: boolean) => void
  loadP2pFileSyncStatus: () => Promise<void>
}

interface TeamStatusLlm extends TeamModelConfig {
  models?: Array<{ id: string; name: string }>
}

interface TeamStatusResponse {
  active: boolean
  mode: string | null
  llm: TeamStatusLlm | null
}

async function fetchTeamStatus(): Promise<TeamStatusResponse | null> {
  if (!isTauri()) return null
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    return await invoke<TeamStatusResponse>('get_team_status')
  } catch (err) {
    console.warn('[TeamMode] Failed to read team status:', err)
    return null
  }
}


export const useTeamModeStore = create<TeamModeState>((set, get) => ({
  teamMode: false,
  teamModeType: null,
  teamModelConfig: null,
  teamModelOptions: buildConfig.team.llm.models ?? [],
  _appliedConfigKey: null,
  devUnlocked: false,
  myRole: null,
  p2pConnected: false,
  p2pConfigured: false,
  teamGitSyncing: false,
  p2pFileSyncStatusMap: {},

  loadTeamConfig: async (_workspacePath: string) => {
    // teamMode = p2p.enabled || ossConfigured
    const status = await fetchTeamStatus()
    // Check OSS config directly from backend to avoid stale store state on workspace switch
    let ossConfigured = false
    if (isTauri()) {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        const ossConfig = await invoke<{ enabled?: boolean } | null>('oss_get_team_config', { workspacePath: _workspacePath })
        ossConfigured = !!ossConfig?.enabled
      } catch { /* ignore */ }
    }
    const p2pActive = !!status?.active
    const isTeamMode = p2pActive || ossConfigured

    if (isTeamMode) {
      set({ teamMode: true, teamModeType: status?.mode ?? (ossConfigured ? 'oss' : null) })
      if (status?.llm) {
        // Use models from team config (stored in teamclaw.json), fallback to build config
        const teamModels = status.llm.models && status.llm.models.length > 0
          ? status.llm.models
          : (buildConfig.team.llm.models ?? [])
        // Restore previously selected team model if available
        let selectedModel = status.llm.model
        let selectedModelName = status.llm.modelName || status.llm.model
        if (teamModels.length > 0) {
          try {
            const savedModelId = localStorage.getItem(`${appShortName}-team-model`)
            const match = savedModelId ? teamModels.find((m) => m.id === savedModelId) : null
            if (match) {
              selectedModel = match.id
              selectedModelName = match.name
            }
          } catch { /* ignore */ }
        }
        const config: TeamModelConfig = {
          baseUrl: status.llm.baseUrl,
          model: selectedModel,
          modelName: selectedModelName,
        }
        set({ teamModelConfig: config, teamModelOptions: teamModels })
      } else {
        set({ teamModelConfig: null })
      }
    } else {
      set({ teamMode: false, teamModeType: null, teamModelConfig: null })
    }
    // Load user's role and P2P connection status (non-critical)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const role = await invoke<string | null>('unified_team_get_my_role')
      set({ myRole: role as any })
      const syncStatus = await invoke<{ connected?: boolean; namespaceId?: string | null }>('p2p_sync_status').catch(() => null)
      set({ p2pConnected: syncStatus?.connected ?? false, p2pConfigured: !!syncStatus?.namespaceId })
      if (syncStatus?.connected) {
        get().loadP2pFileSyncStatus()
      }
    } catch {
      // Non-critical, role can be loaded later
    }
  },

  applyTeamModelToOpenCode: async (workspacePath: string, force?: boolean) => {
    const { teamModelConfig, _appliedConfigKey } = get()
    if (!teamModelConfig) return

    const configKey = `${teamModelConfig.baseUrl}|${teamModelConfig.model}`
    if (!force && configKey === _appliedConfigKey) return
    set({ _appliedConfigKey: configKey })

    try {
      const providerStore = useProviderStore.getState()
      const currentModel = providerStore.currentModelKey
      if (currentModel && !currentModel.startsWith('team/')) {
        try {
          localStorage.setItem(`${appShortName}-pre-team-model`, currentModel)
        } catch { /* ignore */ }
      }

      // Build model configs — use models from team config (state), fallback to build config
      const teamModels = get().teamModelOptions.length > 0 ? get().teamModelOptions : buildConfig.team.llm.models
      const modelConfigs: any[] = teamModels && teamModels.length > 0
        ? teamModels.map((m) => {
            const mc: any = {
              modelId: m.id,
              modelName: m.name,
              limit: { context: 256000, output: 16000 },
            }
            if (buildConfig.team.llm.supportsVision) {
              mc.modalities = { input: ['text', 'image'], output: ['text'] }
            }
            return mc
          })
        : [{
            modelId: teamModelConfig.model,
            modelName: teamModelConfig.modelName,
            limit: { context: 256000, output: 16000 },
            ...(buildConfig.team.llm.supportsVision
              ? { modalities: { input: ['text', 'image'], output: ['text'] } }
              : {}),
          }]

      // Check if the provider config already exists in opencode.json with matching values.
      // If so, skip the disruptive restart — the sidecar already loaded the correct config.
      const existingConfig = await getCustomProviderConfig(workspacePath, TEAM_PROVIDER_ID)
      const expectedModelIds = modelConfigs.map((m) => m.modelId).sort()
      const existingModelIds = existingConfig?.models.map((m) => m.modelId).sort() ?? []
      const configAlreadyMatches = existingConfig
        && existingConfig.baseURL === teamModelConfig.baseUrl
        && JSON.stringify(expectedModelIds) === JSON.stringify(existingModelIds)

      if (!configAlreadyMatches) {
        await addCustomProviderToConfig(workspacePath, {
          name: 'Team',
          baseURL: teamModelConfig.baseUrl,
          apiKey: '${tc_api_key}',
          models: modelConfigs,
        })

        // Restart OpenCode to pick up new provider config
        if (isTauri()) {
          const { invoke } = await import('@tauri-apps/api/core')
          const { initOpenCodeClient } = await import('@/lib/opencode/sdk-client')

          await invoke('stop_opencode')
          await new Promise((r) => setTimeout(r, 500))
          const status = await invoke<{ url: string }>('start_opencode', {
            config: { workspace_path: workspacePath },
          })
          initOpenCodeClient({ baseUrl: status.url, workspacePath })

          const { useWorkspaceStore } = await import('./workspace')
          useWorkspaceStore.getState().setOpenCodeReady(true, status.url)

          await new Promise((r) => setTimeout(r, 500))
        }
      } else {
        console.log('[TeamMode] Provider config already in opencode.json, skipping restart')
      }

      await providerStore.selectModel(TEAM_PROVIDER_ID, teamModelConfig.model, teamModelConfig.modelName)
      await providerStore.refreshConfiguredProviders()

      console.log('[TeamMode] Applied team model config:', teamModelConfig)
    } catch (err) {
      console.error('[TeamMode] Failed to apply team model to OpenCode:', err)
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

    // Select the model in OpenCode (all models are already registered in the provider)
    const providerStore = useProviderStore.getState()
    await providerStore.selectModel(TEAM_PROVIDER_ID, modelId, option.name)

    // Persist selection
    try {
      localStorage.setItem(`${appShortName}-team-model`, modelId)
    } catch { /* ignore */ }

    console.log('[TeamMode] Switched team model to:', modelId)
  },

  setDevUnlocked: (unlocked: boolean) => {
    set({ devUnlocked: unlocked })
    // Refresh file tree so hidden files appear/disappear
    import('./workspace').then(({ useWorkspaceStore }) => {
      useWorkspaceStore.getState().refreshFileTree()
    })
  },

  loadP2pFileSyncStatus: async () => {
    if (!isTauri()) return
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const statuses = await invoke<Array<{ path: string; docType: string; status: 'synced' | 'modified' | 'new' }>>('p2p_get_files_sync_status')
      const map: Record<string, 'synced' | 'modified' | 'new'> = {}
      for (const s of statuses) {
        map[s.path] = s.status
      }
      set({ p2pFileSyncStatusMap: map })
    } catch (e) {
      console.debug('[team-mode] loadP2pFileSyncStatus skipped:', e)
    }
  },

  clearTeamMode: async (workspacePath?: string) => {
    // When LLM config is locked via build config, prevent exiting team mode
    if (buildConfig.team.lockLlmConfig) return

    // Set state immediately to trigger UI updates
    set({ teamMode: false, teamModeType: null, teamModelConfig: null, _appliedConfigKey: null, p2pFileSyncStatusMap: {} })

    // Remove team provider from opencode.json
    if (workspacePath) {
      try {
        await removeCustomProviderFromConfig(workspacePath, TEAM_PROVIDER_ID)

        // Restart OpenCode to apply the removal of the custom provider
        if (isTauri()) {
          const { invoke } = await import('@tauri-apps/api/core')
          const { initOpenCodeClient } = await import('@/lib/opencode/sdk-client')

          await invoke('stop_opencode')
          await new Promise((r) => setTimeout(r, 500))
          const status = await invoke<{ url: string }>('start_opencode', {
            config: { workspace_path: workspacePath },
          })
          initOpenCodeClient({ baseUrl: status.url, workspacePath })

          // Notify workspace store so SSE reconnects to the new sidecar
          const { useWorkspaceStore } = await import('./workspace')
          useWorkspaceStore.getState().setOpenCodeReady(true, status.url)

          // Wait for OpenCode to initialize
          await new Promise((r) => setTimeout(r, 500))
        }
      } catch { /* ignore */ }
    }

    // Restore previous model if available
    try {
      const preTeamModel = localStorage.getItem(`${appShortName}-pre-team-model`)
      const providerStore = useProviderStore.getState()

      // Force disconnect the team provider to remove it from the list immediately
      await providerStore.disconnectProvider(TEAM_PROVIDER_ID)

      // Wait for OpenCode to be fully ready before initializing
      if (isTauri()) {
        const { getOpenCodeClient } = await import('@/lib/opencode/sdk-client')
        let retries = 10
        while (retries > 0) {
          try {
            const client = getOpenCodeClient()
            const isReady = await client.isReady()
            if (isReady) break
          } catch {
            // Client not ready yet
          }
          await new Promise((r) => setTimeout(r, 300))
          retries--
        }
      }

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
        localStorage.removeItem(`${appShortName}-pre-team-model`)
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

// Subscribe to OSS configured state changes — teamMode = p2p.enabled || ossConfigured
import('./team-oss').then(({ useTeamOssStore }) => {
  let prevConfigured = useTeamOssStore.getState().configured
  useTeamOssStore.subscribe((state) => {
    if (state.configured !== prevConfigured) {
      prevConfigured = state.configured
      if (state.configured) {
        useTeamModeStore.setState({ teamMode: true })
      } else {
        // OSS disconnected — only clear teamMode if P2P is also not active
        const p2pActive = useTeamModeStore.getState().p2pConnected
        if (!p2pActive) {
          useTeamModeStore.setState({ teamMode: false })
        }
      }
    }
  })
})
