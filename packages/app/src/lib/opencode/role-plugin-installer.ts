import pluginTemplateSource from "./templates/role-skill-plugin.ts.txt?raw"

export interface EnsureRolePluginResult {
  status: "installed" | "updated" | "unchanged" | "conflict" | "failed"
  path: string
  reason?: string
}

const MANAGED_PLUGIN_MARKER = "managed-plugin: role-skill-plugin"
const PLUGIN_TARGET_RELATIVE_PATH = ".opencode/plugins/role-skill.ts"
const ROLE_ROOT_RELATIVE_PATH = ".opencode/roles"
const ROLE_CONFIG_RELATIVE_PATH = ".opencode/roles/config.json"
const ROLE_CONFIG_SAMPLE = `${JSON.stringify(
  {
    paths: []
  },
  null,
  2,
)}\n`

export function getBundledRoleSkillPluginSource(): string {
  return pluginTemplateSource
}

export function parseManagedPluginVersion(content: string): number | null {
  if (!content.includes(MANAGED_PLUGIN_MARKER)) return null
  const match = content.match(/^[ \t]*\/\/[ \t]*version:[ \t]*(\d+)\s*$/m)
  return match ? Number(match[1]) : null
}

export async function ensureRoleSkillPlugin(workspacePath: string): Promise<EnsureRolePluginResult> {
  const targetPath = `${workspacePath}/${PLUGIN_TARGET_RELATIVE_PATH}`
  const roleRootPath = `${workspacePath}/${ROLE_ROOT_RELATIVE_PATH}`
  const roleConfigPath = `${workspacePath}/${ROLE_CONFIG_RELATIVE_PATH}`

  try {
    const { exists, mkdir, readTextFile, writeTextFile } = await import("@tauri-apps/plugin-fs")
    const targetDir = targetPath.slice(0, targetPath.lastIndexOf("/"))
    const bundledSource = getBundledRoleSkillPluginSource()
    const bundledVersion = parseManagedPluginVersion(bundledSource)

    if (!(await exists(targetDir))) {
      await mkdir(targetDir, { recursive: true })
    }
    if (!(await exists(roleRootPath))) {
      await mkdir(roleRootPath, { recursive: true })
    }
    if (!(await exists(roleConfigPath))) {
      await writeTextFile(roleConfigPath, ROLE_CONFIG_SAMPLE)
    }

    if (!(await exists(targetPath))) {
      await writeTextFile(targetPath, bundledSource)
      const result = { status: "installed", path: targetPath } as const
      console.log("[RolePluginInstaller] Installed managed role plugin:", result)
      return result
    }

    const existingContent = await readTextFile(targetPath)
    const existingVersion = parseManagedPluginVersion(existingContent)
    if (existingVersion === null) {
      const result = {
        status: "conflict",
        path: targetPath,
        reason: "Existing plugin file is not managed by the bundled installer",
      } as const
      console.warn("[RolePluginInstaller] Plugin conflict:", result)
      return result
    }

    if (bundledVersion !== null && existingVersion < bundledVersion) {
      await writeTextFile(targetPath, bundledSource)
      const result = { status: "updated", path: targetPath } as const
      console.log("[RolePluginInstaller] Updated managed role plugin:", {
        ...result,
        previousVersion: existingVersion,
        nextVersion: bundledVersion,
      })
      return result
    }

    const result = { status: "unchanged", path: targetPath } as const
    console.log("[RolePluginInstaller] Managed role plugin already current:", {
      ...result,
      version: existingVersion,
    })
    return result
  } catch (error) {
    const result = {
      status: "failed",
      path: targetPath,
      reason: error instanceof Error ? error.message : String(error),
    } as const
    console.error("[RolePluginInstaller] Failed to ensure managed role plugin:", result)
    return result
  }
}
