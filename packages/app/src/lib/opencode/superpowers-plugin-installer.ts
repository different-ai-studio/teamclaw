export interface EnsureSuperpowersPluginResult {
  status: "installed" | "updated" | "unchanged" | "conflict" | "failed"
  path: string
  reason?: string
}

interface OpenCodePluginConfig {
  $schema?: string
  plugin?: unknown
  [key: string]: unknown
}

const OPENCODE_CONFIG_RELATIVE_PATH = "opencode.json"
const OPENCODE_CONFIG_SCHEMA = "https://opencode.ai/config.json"
const SUPERPOWERS_PLUGIN_PACKAGE = "superpowers@git+https://github.com/obra/superpowers.git"

function normalizePluginList(value: unknown): string[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value)) return null
  if (!value.every((entry) => typeof entry === "string")) return null
  return [...value]
}

function isEquivalentSuperpowersPlugin(entry: string): boolean {
  const normalized = entry
    .trim()
    .toLowerCase()
    .replace(/^git\+/, "")
    .replace(/\.git(?=([#?].*)?$)/, "")

  if (normalized === "superpowers" || normalized.startsWith("superpowers@")) {
    return true
  }

  return (
    normalized.includes("github.com/obra/superpowers") ||
    normalized.includes("github.com:obra/superpowers") ||
    normalized === "github:obra/superpowers" ||
    normalized.endsWith("@github:obra/superpowers") ||
    normalized === "obra/superpowers" ||
    normalized.endsWith("@obra/superpowers")
  )
}

export async function ensureSuperpowersPlugin(
  workspacePath: string,
): Promise<EnsureSuperpowersPluginResult> {
  const configPath = `${workspacePath}/${OPENCODE_CONFIG_RELATIVE_PATH}`

  try {
    const { exists, readTextFile, writeTextFile } = await import("@tauri-apps/plugin-fs")

    if (!(await exists(configPath))) {
      const config: OpenCodePluginConfig = {
        $schema: OPENCODE_CONFIG_SCHEMA,
        plugin: [SUPERPOWERS_PLUGIN_PACKAGE],
      }
      await writeTextFile(configPath, `${JSON.stringify(config, null, 2)}\n`)
      const result = { status: "installed", path: configPath } as const
      console.log("[SuperpowersPluginInstaller] Added superpowers plugin to new opencode.json:", result)
      return result
    }

    const existingContent = await readTextFile(configPath)
    const parsedConfig = JSON.parse(existingContent) as OpenCodePluginConfig
    const pluginList = normalizePluginList(parsedConfig.plugin)

    if (pluginList === null) {
      const result = {
        status: "conflict",
        path: configPath,
        reason: 'Existing opencode.json "plugin" field is not a string array',
      } as const
      console.warn("[SuperpowersPluginInstaller] Plugin config conflict:", result)
      return result
    }

    let changed = false
    if (parsedConfig.$schema !== OPENCODE_CONFIG_SCHEMA) {
      parsedConfig.$schema = OPENCODE_CONFIG_SCHEMA
      changed = true
    }

    if (!pluginList.some(isEquivalentSuperpowersPlugin)) {
      pluginList.push(SUPERPOWERS_PLUGIN_PACKAGE)
      parsedConfig.plugin = pluginList
      changed = true
    }

    if (changed) {
      await writeTextFile(configPath, `${JSON.stringify(parsedConfig, null, 2)}\n`)
      const result = { status: "updated", path: configPath } as const
      console.log("[SuperpowersPluginInstaller] Updated opencode.json plugin list:", result)
      return result
    }

    const result = { status: "unchanged", path: configPath } as const
    console.log("[SuperpowersPluginInstaller] Superpowers plugin already present in opencode.json:", result)
    return result
  } catch (error) {
    const result = {
      status: "failed",
      path: configPath,
      reason: error instanceof Error ? error.message : String(error),
    } as const
    console.error("[SuperpowersPluginInstaller] Failed to ensure superpowers plugin config:", result)
    return result
  }
}
