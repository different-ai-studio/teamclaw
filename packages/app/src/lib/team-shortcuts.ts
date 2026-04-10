import type { ShortcutNode } from '@/stores/shortcuts'
import { TEAM_REPO_DIR } from '@/lib/build-config'

interface TeamShortcutsFile {
  version: number
  shortcuts: ShortcutNode[]
}

const TEAM_SHORTCUTS_PATH = `${TEAM_REPO_DIR}/_meta/shortcuts.json`

export async function loadTeamShortcutsFile(workspacePath: string): Promise<ShortcutNode[] | null> {
  try {
    const { exists, readTextFile } = await import('@tauri-apps/plugin-fs')
    const filePath = `${workspacePath}/${TEAM_SHORTCUTS_PATH}`
    
    if (!(await exists(filePath))) {
      return null
    }
    
    const content = await readTextFile(filePath)
    const data = JSON.parse(content) as TeamShortcutsFile
    
    if (!data.shortcuts || !Array.isArray(data.shortcuts)) {
      return null
    }
    
    return data.shortcuts
  } catch (err) {
    console.warn('[TeamShortcuts] Failed to load team shortcuts:', err)
    return null
  }
}

export async function saveTeamShortcutsFile(workspacePath: string, shortcuts: ShortcutNode[]): Promise<boolean> {
  try {
    const { writeTextFile, exists, mkdir } = await import('@tauri-apps/plugin-fs')
    const filePath = `${workspacePath}/${TEAM_SHORTCUTS_PATH}`
    const dirPath = `${workspacePath}/${TEAM_REPO_DIR}/_meta`
    
    if (!(await exists(dirPath))) {
      await mkdir(dirPath, { recursive: true })
    }
    
    const data: TeamShortcutsFile = { version: 1, shortcuts }
    await writeTextFile(filePath, JSON.stringify(data, null, 2))
    return true
  } catch (err) {
    console.error('[TeamShortcuts] Failed to save team shortcuts:', err)
    return false
  }
}
