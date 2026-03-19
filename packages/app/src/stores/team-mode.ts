import { create } from 'zustand'
import yaml from 'js-yaml'
import {
  addCustomProviderToConfig,
  removeCustomProviderFromConfig,
} from '@/lib/opencode/config'
import { useProviderStore } from './provider'
import { isTauri } from '@/lib/utils'
import { buildConfig } from '@/lib/build-config'


const TEAM_PROVIDER_ID = 'team'
const TEAM_API_KEY_STORAGE = 'teamclaw-team-api-key'
const TEAM_CONFIG_PATH = 'teamclaw-team/teamclaw.yaml'

export interface TeamModelConfig {
  baseUrl: string
  model: string
  modelName: string
}

interface TeamModeState {
  teamMode: boolean
  teamModelConfig: TeamModelConfig | null
  teamApiKey: string | null // user-overridden key, null = use NodeId
  _appliedConfigKey: string | null // fingerprint of last applied config to avoid redundant apply

  loadTeamConfig: (workspacePath: string) => Promise<void>
  applyTeamModelToOpenCode: (workspacePath: string) => Promise<void>
  setTeamApiKey: (key: string | null, workspacePath?: string) => Promise<void>
  clearTeamMode: (workspacePath?: string) => Promise<void>
}

async function readTeamYaml(workspacePath: string): Promise<TeamModelConfig | null> {
  if (!isTauri()) return null
  try {
    const { readTextFile, exists } = await import('@tauri-apps/plugin-fs')
    const configPath = `${workspacePath}/${TEAM_CONFIG_PATH}`
    if (!(await exists(configPath))) return null
    const content = await readTextFile(configPath)
    const doc = yaml.load(content) as Record<string, unknown> | null
    if (!doc || typeof doc !== 'object') return null
    const llm = doc.llm as Record<string, unknown> | undefined
    if (!llm || !llm.baseUrl || !llm.model) return null
    return {
      baseUrl: String(llm.baseUrl),
      model: String(llm.model),
      modelName: String(llm.modelName || llm.model),
    }
  } catch (err) {
    console.warn('[TeamMode] Failed to read team config:', err)
    return null
  }
}

async function getDeviceNodeId(): Promise<string> {
  if (!isTauri()) return ''
  const { invoke } = await import('@tauri-apps/api/core')
  const info = await invoke<{ nodeId: string }>('get_device_info')
  return info.nodeId
}

export const useTeamModeStore = create<TeamModeState>((set, get) => ({
  teamMode: false,
  teamModelConfig: null,
  _appliedConfigKey: null,
  teamApiKey: (() => {
    try {
      return localStorage.getItem(TEAM_API_KEY_STORAGE) || null
    } catch {
      return null
    }
  })(),

  loadTeamConfig: async (workspacePath: string) => {
    const config = await readTeamYaml(workspacePath)
    // Fall back to build-time config if yaml is absent but build config has LLM settings
    const effectiveConfig = config || (
      buildConfig.team.llm.baseUrl
        ? { baseUrl: buildConfig.team.llm.baseUrl, model: buildConfig.team.llm.model, modelName: buildConfig.team.llm.modelName }
        : null
    )
    if (effectiveConfig) {
      set({ teamMode: true, teamModelConfig: effectiveConfig })
    } else {
      const wasTeamMode = get().teamMode
      // Update state first so UI reacts immediately
      set({ teamMode: false, teamModelConfig: null })
      if (wasTeamMode) {
        await get().clearTeamMode(workspacePath)
      }
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
          localStorage.setItem('teamclaw-pre-team-model', currentModel)
        } catch { /* ignore */ }
      }

      // Write custom provider to opencode.json
      await addCustomProviderToConfig(workspacePath, {
        name: 'Team',
        baseURL: teamModelConfig.baseUrl,
        modelId: teamModelConfig.model,
        modelName: teamModelConfig.modelName,
      })

      // Determine API key: user override or NodeId
      const apiKey = teamApiKey || (await getDeviceNodeId())
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

      // Connect provider with key and select model
      await providerStore.connectProvider(TEAM_PROVIDER_ID, apiKey)
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
      const apiKey = key || (await getDeviceNodeId())
      if (apiKey) {
        const providerStore = useProviderStore.getState()
        await providerStore.connectProvider(TEAM_PROVIDER_ID, apiKey)
      }
    }
  },

  clearTeamMode: async (workspacePath?: string) => {
    // When LLM config is locked via build config, prevent exiting team mode
    if (buildConfig.team.lockLlmConfig) return

    // Set state immediately to trigger UI updates
    set({ teamMode: false, teamModelConfig: null, _appliedConfigKey: null })
    
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
      const preTeamModel = localStorage.getItem('teamclaw-pre-team-model')
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
        localStorage.removeItem('teamclaw-pre-team-model')
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
