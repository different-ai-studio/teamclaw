import { create } from 'zustand'
import {
  addCustomProviderToConfig,
  removeCustomProviderFromConfig,
} from '@/lib/opencode/config'
import { useProviderStore } from './provider'
import { isTauri } from '@/lib/utils'
import { appShortName, buildConfig, TEAM_API_KEY_STORAGE_KEY } from '@/lib/build-config'


const TEAM_PROVIDER_ID = 'team'
const TEAM_API_KEY_STORAGE = TEAM_API_KEY_STORAGE_KEY

/** Read team API key override from persistent storage (global, not per-workspace). */
export function getPersistedTeamApiKey(): string | null {
  try {
    return localStorage.getItem(TEAM_API_KEY_STORAGE) || null
  } catch {
    return null
  }
}

export interface TeamModelConfig {
  baseUrl: string
  model: string
  modelName: string
}

interface TeamModeState {
  teamMode: boolean
  teamModeType: string | null // "p2p" | "oss" | "webdav" | "git" — from teamclaw.json
  teamModelConfig: TeamModelConfig | null
  teamApiKey: string | null // user-overridden key, null = sk-tc-{nodeId[:40]} (FC add-member)
  _appliedConfigKey: string | null // fingerprint of last applied config to avoid redundant apply
  devUnlocked: boolean // hidden dev mode: unlocks model selector & hidden dirs in team mode
  myRole: 'owner' | 'editor' | 'viewer' | null
  p2pConnected: boolean
  p2pConfigured: boolean
  p2pFileSyncStatusMap: Record<string, 'synced' | 'modified' | 'new'>

  loadTeamConfig: (workspacePath: string) => Promise<void>
  applyTeamModelToOpenCode: (workspacePath: string) => Promise<void>
  setTeamApiKey: (key: string | null, workspacePath?: string) => Promise<void>
  clearTeamMode: (workspacePath?: string) => Promise<void>
  setDevUnlocked: (unlocked: boolean) => void
  loadP2pFileSyncStatus: () => Promise<void>
}

interface TeamStatusResponse {
  active: boolean
  mode: string | null
  llm: TeamModelConfig | null
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

async function getDeviceNodeId(): Promise<string> {
  if (!isTauri()) return ''
  const { invoke } = await import('@tauri-apps/api/core')
  const info = await invoke<{ nodeId: string }>('get_device_info')
  return info.nodeId
}

/** Default LiteLLM virtual key for this device; must match fc/index.mjs `/ai/add-member`. */
function defaultTeamLiteLlmApiKey(nodeId: string): string {
  if (!nodeId) return ''
  return `sk-tc-${nodeId.slice(0, 40)}`
}

export const useTeamModeStore = create<TeamModeState>((set, get) => ({
  teamMode: false,
  teamModeType: null,
  teamModelConfig: null,
  _appliedConfigKey: null,
  devUnlocked: false,
  myRole: null,
  p2pConnected: false,
  p2pConfigured: false,
  teamApiKey: getPersistedTeamApiKey(),
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
        const config: TeamModelConfig = {
          baseUrl: status.llm.baseUrl,
          model: status.llm.model,
          modelName: status.llm.modelName || status.llm.model,
        }
        set({ teamModelConfig: config })
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

  applyTeamModelToOpenCode: async (workspacePath: string) => {
    const { teamModelConfig, teamApiKey, _appliedConfigKey } = get()
    if (!teamModelConfig) return

    // Build a fingerprint of the current config to avoid redundant restarts/toasts
    const configKey = `${teamModelConfig.baseUrl}|${teamModelConfig.model}|${teamApiKey || ''}`
    if (configKey === _appliedConfigKey) return
    set({ _appliedConfigKey: configKey })

    try {
      // Save current model before overriding
      const providerStore = useProviderStore.getState()
      const currentModel = providerStore.currentModelKey
      if (currentModel && !currentModel.startsWith('team/')) {
        try {
          localStorage.setItem(`${appShortName}-pre-team-model`, currentModel)
        } catch { /* ignore */ }
      }

      // Write custom provider to opencode.json
      const modelConfig: any = {
        modelId: teamModelConfig.model,
        modelName: teamModelConfig.modelName,
        // Standard token limits for GPT-5.x models
        limit: {
          context: 256000,
          output: 16000
        }
      }

      // Add vision support if configured in build config
      if (buildConfig.team.llm.supportsVision) {
        modelConfig.modalities = {
          input: ['text', 'image'],
          output: ['text']
        }
      }

      await addCustomProviderToConfig(workspacePath, {
        name: 'Team',
        baseURL: teamModelConfig.baseUrl,
        models: [modelConfig],
      })

      // Determine API key: user override or FC default virtual key (not raw nodeId)
      const nodeId = await getDeviceNodeId()
      const apiKey = teamApiKey || defaultTeamLiteLlmApiKey(nodeId)
      if (!apiKey) {
        console.error('[TeamMode] No API key and no device NodeId available')
        return
      }

      // Restart OpenCode to pick up new provider config
      if (isTauri()) {
        const { invoke } = await import('@tauri-apps/api/core')
        const { initOpenCodeClient } = await import('@/lib/opencode/client')

        await invoke('stop_opencode')
        await new Promise((r) => setTimeout(r, 500))
        const status = await invoke<{ url: string }>('start_opencode', {
          config: { workspace_path: workspacePath },
        })
        initOpenCodeClient({ baseUrl: status.url, workspacePath })

        // Wait for OpenCode to initialize
        await new Promise((r) => setTimeout(r, 500))
      }

      // Connect provider with key
      await providerStore.connectProvider(TEAM_PROVIDER_ID, apiKey)

      // Wait for OpenCode to register the team custom provider before selecting the model.
      // PATCH /config returns 500 if the model isn't in OpenCode's provider registry yet.
      const { getOpenCodeClient } = await import('@/lib/opencode/client')
      let client: ReturnType<typeof getOpenCodeClient> | null = null
      try { client = getOpenCodeClient() } catch { /* not initialized */ }
      if (client) {
        const deadline = Date.now() + 10_000
        while (Date.now() < deadline) {
          try {
            const result = await client.getProviders()
            if (result.connected.includes(TEAM_PROVIDER_ID)) break
          } catch { /* server still initializing */ }
          await new Promise((r) => setTimeout(r, 500))
        }
      }

      await providerStore.selectModel(TEAM_PROVIDER_ID, teamModelConfig.model, teamModelConfig.modelName)
      await providerStore.refreshConfiguredProviders()

      console.log('[TeamMode] Applied team model config:', teamModelConfig)
    } catch (err) {
      console.error('[TeamMode] Failed to apply team model to OpenCode:', err)
    }
  },

  setTeamApiKey: async (key: string | null, workspacePath?: string) => {
    set({ teamApiKey: key })
    try {
      if (key) {
        localStorage.setItem(TEAM_API_KEY_STORAGE, key)
      } else {
        localStorage.removeItem(TEAM_API_KEY_STORAGE)
      }
    } catch { /* ignore */ }

    // Re-apply if in team mode
    if (get().teamMode && workspacePath) {
      const nodeId = await getDeviceNodeId()
      const apiKey = key || defaultTeamLiteLlmApiKey(nodeId)
      if (apiKey) {
        const providerStore = useProviderStore.getState()
        await providerStore.connectProvider(TEAM_PROVIDER_ID, apiKey)
      }
    }
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

    try {
      localStorage.removeItem(TEAM_API_KEY_STORAGE)
    } catch { /* ignore */ }

    // Remove team provider from opencode.json
    if (workspacePath) {
      try {
        await removeCustomProviderFromConfig(workspacePath, TEAM_PROVIDER_ID)

        // Restart OpenCode to apply the removal of the custom provider
        if (isTauri()) {
          const { invoke } = await import('@tauri-apps/api/core')
          const { initOpenCodeClient } = await import('@/lib/opencode/client')

          await invoke('stop_opencode')
          await new Promise((r) => setTimeout(r, 500))
          const status = await invoke<{ url: string }>('start_opencode', {
            config: { workspace_path: workspacePath },
          })
          initOpenCodeClient({ baseUrl: status.url, workspacePath })

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
        const { getOpenCodeClient } = await import('@/lib/opencode/client')
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
