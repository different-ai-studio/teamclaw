/**
 * Utility for reading/writing opencode.json provider configuration.
 * Used to add/remove custom OpenAI-compatible providers.
 */

// Shape of a custom provider entry in opencode.json
export interface CustomProviderConfig {
  name: string
  baseURL: string
  modelId: string
  modelName?: string
}

// Provider entry as stored in opencode.json
interface OpenCodeProviderEntry {
  npm: string
  name?: string
  options?: { baseURL?: string; [key: string]: unknown }
  models?: Record<string, { name: string }>
}

export type SkillPermission = 'allow' | 'deny' | 'ask'

export type SkillPermissionMap = Record<string, SkillPermission>

export interface ResolvedPermission {
  permission: SkillPermission
  matchedPattern: string
  isExact: boolean
}

// The relevant subset of opencode.json we work with
interface OpenCodeConfig {
  [key: string]: unknown
  provider?: Record<string, OpenCodeProviderEntry>
  permission?: {
    skill?: SkillPermissionMap
    [key: string]: unknown
  }
}

/**
 * Slugify a provider name into a valid ID.
 * e.g. "My Custom Provider" -> "my-custom-provider"
 */
export function slugifyProviderId(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Read and parse opencode.json from the workspace root.
 */
async function readOpenCodeConfig(workspacePath: string): Promise<OpenCodeConfig> {
  const { readTextFile, exists } = await import('@tauri-apps/plugin-fs')
  const configPath = `${workspacePath}/opencode.json`

  if (!(await exists(configPath))) {
    return {}
  }

  const content = await readTextFile(configPath)
  return JSON.parse(content) as OpenCodeConfig
}

/**
 * Write opencode.json back to the workspace root.
 */
async function writeOpenCodeConfig(workspacePath: string, config: OpenCodeConfig): Promise<void> {
  const { writeTextFile } = await import('@tauri-apps/plugin-fs')
  const configPath = `${workspacePath}/opencode.json`
  await writeTextFile(configPath, JSON.stringify(config, null, 2))
}

/**
 * Add a custom OpenAI-compatible provider to opencode.json.
 * Returns the generated provider ID.
 */
export async function addCustomProviderToConfig(
  workspacePath: string,
  config: CustomProviderConfig
): Promise<string> {
  const providerId = slugifyProviderId(config.name)
  const openCodeConfig = await readOpenCodeConfig(workspacePath)

  // Ensure provider section exists
  if (!openCodeConfig.provider) {
    openCodeConfig.provider = {}
  }

  openCodeConfig.provider[providerId] = {
    npm: '@ai-sdk/openai-compatible',
    name: config.name,
    options: {
      baseURL: config.baseURL,
    },
    models: {
      [config.modelId]: {
        name: config.modelName || config.modelId,
      },
    },
  }

  await writeOpenCodeConfig(workspacePath, openCodeConfig)
  return providerId
}

/**
 * Remove a custom provider from opencode.json.
 */
export async function removeCustomProviderFromConfig(
  workspacePath: string,
  providerId: string
): Promise<void> {
  const openCodeConfig = await readOpenCodeConfig(workspacePath)

  if (openCodeConfig.provider && openCodeConfig.provider[providerId]) {
    delete openCodeConfig.provider[providerId]

    // Clean up empty provider section
    if (Object.keys(openCodeConfig.provider).length === 0) {
      delete openCodeConfig.provider
    }

    await writeOpenCodeConfig(workspacePath, openCodeConfig)
  }
}

/**
 * Get the list of custom provider IDs from opencode.json.
 */
export async function getCustomProviderIds(workspacePath: string): Promise<string[]> {
  try {
    const openCodeConfig = await readOpenCodeConfig(workspacePath)
    if (!openCodeConfig.provider) return []
    return Object.keys(openCodeConfig.provider)
  } catch {
    return []
  }
}

// ─── Skill Permission Helpers ───────────────────────────────────────────────

function matchesPattern(skillName: string, pattern: string): boolean {
  if (pattern === '*') return true
  if (!pattern.includes('*')) return pattern === skillName
  const prefix = pattern.slice(0, -1)
  return skillName.startsWith(prefix)
}

/**
 * Resolve the effective permission for a skill name against a permission map.
 * Priority: exact match > prefix wildcard (longer prefix wins) > global wildcard "*"
 */
export function resolveSkillPermission(
  skillName: string,
  permissions: SkillPermissionMap
): ResolvedPermission {
  if (permissions[skillName]) {
    return { permission: permissions[skillName], matchedPattern: skillName, isExact: true }
  }

  let bestMatch: { pattern: string; prefixLen: number } | null = null
  for (const pattern of Object.keys(permissions)) {
    if (pattern === '*' || pattern === skillName) continue
    if (matchesPattern(skillName, pattern)) {
      const prefixLen = pattern.length
      if (!bestMatch || prefixLen > bestMatch.prefixLen) {
        bestMatch = { pattern, prefixLen }
      }
    }
  }

  if (bestMatch) {
    return { permission: permissions[bestMatch.pattern], matchedPattern: bestMatch.pattern, isExact: false }
  }

  if (permissions['*']) {
    return { permission: permissions['*'], matchedPattern: '*', isExact: false }
  }

  return { permission: 'allow', matchedPattern: '*', isExact: false }
}

export async function readSkillPermissions(workspacePath: string): Promise<SkillPermissionMap> {
  try {
    const config = await readOpenCodeConfig(workspacePath)
    return config.permission?.skill ?? {}
  } catch {
    return {}
  }
}

export async function writeSkillPermission(
  workspacePath: string,
  pattern: string,
  permission: SkillPermission
): Promise<void> {
  const config = await readOpenCodeConfig(workspacePath)
  if (!config.permission) config.permission = {}
  if (!config.permission.skill) config.permission.skill = {}
  config.permission.skill[pattern] = permission
  await writeOpenCodeConfig(workspacePath, config)
}

export async function removeSkillPermission(
  workspacePath: string,
  pattern: string
): Promise<void> {
  const config = await readOpenCodeConfig(workspacePath)
  if (!config.permission?.skill) return
  delete config.permission.skill[pattern]
  if (Object.keys(config.permission.skill).length === 0) {
    delete config.permission.skill
  }
  if (Object.keys(config.permission).length === 0) {
    delete config.permission
  }
  await writeOpenCodeConfig(workspacePath, config)
}
