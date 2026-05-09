import { TEAMCLAW_DIR } from '@/lib/build-config'
import type { PermissionAskedEvent } from '@/lib/opencode/sdk-types'
import { isTauri } from '@/lib/utils'

export type ProductionGuardRisk = 'production_data'

export interface ProductionGuardMatch {
  commandIncludes?: string[]
  paths?: string[]
  commandRegex?: string[]
  envIncludes?: Record<string, string>
}

export interface ProductionGuardRule {
  id: string
  label?: string
  match?: ProductionGuardMatch
  risk?: ProductionGuardRisk
  approval?: {
    mode?: 'always_ask'
    allowAlways?: boolean
  }
}

export interface ProductionGuardConfig {
  version?: 1
  enabled?: boolean
  rules?: ProductionGuardRule[]
}

export type CommandRisk =
  | { level: 'normal' }
  | {
      level: 'production_data'
      reasons: string[]
      matchedRules: string[]
      allowAlways: false
    }

export function extractPermissionCommand(event: PermissionAskedEvent): string {
  const metadata = event.metadata as Record<string, unknown> | undefined
  const metadataCommand = metadata?.command
  if (typeof metadataCommand === 'string' && metadataCommand.trim()) {
    return metadataCommand.trim()
  }

  return (event.patterns || []).join(' ').trim()
}

function includesAny(command: string, values: string[] | undefined) {
  if (!values || values.length === 0) return false
  const normalized = command.toLowerCase()
  return values.some((value) => normalized.includes(value.toLowerCase()))
}

function matchesRegex(command: string, values: string[] | undefined) {
  if (!values || values.length === 0) return false
  return values.some((value) => {
    try {
      return new RegExp(value, 'i').test(command)
    } catch {
      return false
    }
  })
}

function matchesEnv(command: string, envIncludes: Record<string, string> | undefined) {
  if (!envIncludes || Object.keys(envIncludes).length === 0) return false
  const normalized = command.toLowerCase()
  return Object.entries(envIncludes).some(([key, value]) =>
    normalized.includes(`${key.toLowerCase()}=${String(value).toLowerCase()}`),
  )
}

function matchesRule(command: string, rule: ProductionGuardRule) {
  const match = rule.match
  if (!match) return false
  return (
    includesAny(command, match.commandIncludes) ||
    includesAny(command, match.paths) ||
    matchesRegex(command, match.commandRegex) ||
    matchesEnv(command, match.envIncludes)
  )
}

export function evaluateProductionGuard(
  command: string,
  config: ProductionGuardConfig | null | undefined,
): CommandRisk {
  if (!command.trim()) return { level: 'normal' }
  if (!config || config.enabled === false) return { level: 'normal' }

  const matchedRules = (config.rules || [])
    .filter((rule) => (rule.risk || 'production_data') === 'production_data')
    .filter((rule) => matchesRule(command, rule))

  if (matchedRules.length === 0) return { level: 'normal' }

  return {
    level: 'production_data',
    reasons: matchedRules.map((rule) => rule.label || rule.id),
    matchedRules: matchedRules.map((rule) => rule.id),
    allowAlways: false,
  }
}

export async function readProductionGuardConfig(
  workspacePath: string | null | undefined,
): Promise<ProductionGuardConfig | null> {
  if (!workspacePath || !isTauri()) return null

  try {
    const { readTextFile, exists } = await import('@tauri-apps/plugin-fs')
    const configPath = `${workspacePath}/${TEAMCLAW_DIR}/production-guard.json`
    if (!(await exists(configPath))) return null
    return JSON.parse(await readTextFile(configPath)) as ProductionGuardConfig
  } catch (error) {
    console.error('[ProductionGuard] Failed to read production guard config:', error)
    return null
  }
}

export async function getProductionGuardRiskForPermission(
  event: PermissionAskedEvent,
  workspacePath: string | null | undefined,
): Promise<CommandRisk> {
  if (event.permission !== 'bash' && event.permission !== 'execute') return { level: 'normal' }
  const config = await readProductionGuardConfig(workspacePath)
  return evaluateProductionGuard(extractPermissionCommand(event), config)
}
