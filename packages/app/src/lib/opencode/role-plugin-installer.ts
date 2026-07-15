export interface EnsureRolePluginResult {
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
const ROLE_PLUGIN_PACKAGE = "opencode-roles"
const OPENCODE_CONFIG_SCHEMA = "https://opencode.ai/config.json"
const ROLE_ROOT_RELATIVE_PATH = ".opencode/roles"
const ROLE_CONFIG_RELATIVE_PATH = ".opencode/roles/config.json"
const ROLE_CONFIG_SAMPLE = `${JSON.stringify(
  {
    paths: [],
    _example: {
      paths: ["<relative-role-root>", "<absolute-or-home-role-root>"],
    },
  },
  null,
  2,
)}\n`

function normalizePluginList(value: unknown): string[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value)) return null
  if (!value.every((entry) => typeof entry === "string")) return null
  return [...value]
}

export async function ensureRoleSkillPlugin(workspacePath: string): Promise<EnsureRolePluginResult> {
  const configPath = `${workspacePath}/${OPENCODE_CONFIG_RELATIVE_PATH}`
  const roleRootPath = `${workspacePath}/${ROLE_ROOT_RELATIVE_PATH}`
  const roleConfigPath = `${workspacePath}/${ROLE_CONFIG_RELATIVE_PATH}`

  try {
    const { exists, mkdir, readTextFile, writeTextFile } = await import("@tauri-apps/plugin-fs")

    if (!(await exists(roleRootPath))) {
      await mkdir(roleRootPath, { recursive: true })
    }
    if (!(await exists(roleConfigPath))) {
      await writeTextFile(roleConfigPath, ROLE_CONFIG_SAMPLE)
    }

    if (!(await exists(configPath))) {
      const config: OpenCodePluginConfig = {
        $schema: OPENCODE_CONFIG_SCHEMA,
        plugin: [ROLE_PLUGIN_PACKAGE],
      }
      await writeTextFile(configPath, `${JSON.stringify(config, null, 2)}\n`)
      const result = { status: "installed", path: configPath } as const
      console.log("[RolePluginInstaller] Added role plugin to new opencode.json:", result)
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
      console.warn("[RolePluginInstaller] Plugin config conflict:", result)
      return result
    }

    let changed = false
    if (parsedConfig.$schema !== OPENCODE_CONFIG_SCHEMA) {
      parsedConfig.$schema = OPENCODE_CONFIG_SCHEMA
      changed = true
    }

    if (!pluginList.includes(ROLE_PLUGIN_PACKAGE)) {
      pluginList.push(ROLE_PLUGIN_PACKAGE)
      parsedConfig.plugin = pluginList
      changed = true
    }

    if (changed) {
      await writeTextFile(configPath, `${JSON.stringify(parsedConfig, null, 2)}\n`)
      const result = { status: "updated", path: configPath } as const
      console.log("[RolePluginInstaller] Updated opencode.json plugin list:", result)
      return result
    }

    const result = { status: "unchanged", path: configPath } as const
    console.log("[RolePluginInstaller] Role plugin already present in opencode.json:", result)
    return result
  } catch (error) {
    const result = {
      status: "failed",
      path: configPath,
      reason: error instanceof Error ? error.message : String(error),
    } as const
    console.error("[RolePluginInstaller] Failed to ensure role plugin config:", result)
    return result
  }
}
