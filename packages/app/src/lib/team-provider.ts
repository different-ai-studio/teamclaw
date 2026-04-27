import { exists, mkdir, readTextFile, remove, writeTextFile } from '@tauri-apps/plugin-fs'
import { TEAM_REPO_DIR } from '@/lib/build-config'
import type { CustomProviderConfig } from '@/lib/opencode/config'

export const TEAM_SHARED_PROVIDER_ID = 'team'

export interface TeamProviderModelEntry {
  id: string
  name: string
}

export interface TeamProviderFile {
  version: 1
  provider: {
    id: string
    name: string
    baseURL: string
    apiKey: string
    defaultModel?: string
    models: TeamProviderModelEntry[]
  }
}

export interface TeamProviderFormState {
  enabled: boolean
  baseUrl: string
  models: TeamProviderModelEntry[]
  defaultModel?: string
}

function teamProviderFilePath(workspacePath: string): string {
  return `${workspacePath}/${TEAM_REPO_DIR}/_meta/provider.json`
}

function teamProviderMetaDir(workspacePath: string): string {
  return `${workspacePath}/${TEAM_REPO_DIR}/_meta`
}

function isValidTeamProviderFile(value: unknown): value is TeamProviderFile {
  if (!value || typeof value !== 'object') return false
  const provider = (value as any).provider
  return (
    (value as any).version === 1 &&
    provider &&
    typeof provider.id === 'string' &&
    typeof provider.name === 'string' &&
    typeof provider.baseURL === 'string' &&
    typeof provider.apiKey === 'string' &&
    Array.isArray(provider.models)
  )
}

export async function loadTeamProviderFile(workspacePath: string): Promise<TeamProviderFile | null> {
  const path = teamProviderFilePath(workspacePath)
  if (!(await exists(path))) return null

  try {
    const content = await readTextFile(path)
    const parsed = JSON.parse(content) as unknown
    if (!isValidTeamProviderFile(parsed)) return null
    return parsed
  } catch {
    return null
  }
}

export async function saveTeamProviderFile(
  workspacePath: string,
  provider: CustomProviderConfig | null,
  defaultModel?: string,
): Promise<void> {
  const path = teamProviderFilePath(workspacePath)
  if (!provider) {
    if (await exists(path)) {
      await remove(path)
    }
    return
  }

  const metaDir = teamProviderMetaDir(workspacePath)
  if (!(await exists(metaDir))) {
    await mkdir(metaDir, { recursive: true })
  }

  const file: TeamProviderFile = {
    version: 1,
    provider: {
      id: TEAM_SHARED_PROVIDER_ID,
      name: provider.name,
      baseURL: provider.baseURL,
      apiKey: provider.apiKey || '${tc_api_key}',
      defaultModel,
      models: provider.models.map((model) => ({
        id: model.modelId,
        name: model.modelName || model.modelId,
      })),
    },
  }

  await writeTextFile(path, JSON.stringify(file, null, 2))
}

export async function loadTeamProviderFormState(workspacePath: string): Promise<TeamProviderFormState | null> {
  const providerFile = await loadTeamProviderFile(workspacePath)
  if (!providerFile) return null

  return {
    enabled: true,
    baseUrl: providerFile.provider.baseURL,
    models: providerFile.provider.models,
    defaultModel: providerFile.provider.defaultModel,
  }
}

export function buildTeamProviderConfig(
  enabled: boolean,
  baseUrl: string,
  models: TeamProviderModelEntry[],
): CustomProviderConfig | null {
  if (!enabled) return null
  if (!baseUrl.trim()) return null

  const normalizedModels = models
    .map((model) => ({
      modelId: model.id.trim(),
      modelName: model.name.trim() || model.id.trim(),
    }))
    .filter((model) => model.modelId)

  if (normalizedModels.length === 0) return null

  return {
    name: 'Team',
    baseURL: baseUrl.trim(),
    apiKey: '${tc_api_key}',
    models: normalizedModels,
  }
}
