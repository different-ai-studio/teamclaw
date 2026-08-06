import { invoke } from '@tauri-apps/api/core'
import { isTauri } from '@/lib/utils'

/** Ensure ~/.agents/skills exists and is registered in OpenCode + Claude skills.paths. */
export async function ensureAgentsSkillsPaths(workspacePath?: string | null): Promise<void> {
  if (!isTauri()) return
  await invoke('ensure_agents_skills_paths', {
    workspacePath: workspacePath?.trim() || null,
  })
}
