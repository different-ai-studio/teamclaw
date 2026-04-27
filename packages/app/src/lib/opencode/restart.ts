import { invoke } from '@tauri-apps/api/core'
import { initOpenCodeClient } from './sdk-client'
import { useWorkspaceStore } from '@/stores/workspace'
import { useTeamModeStore } from '@/stores/team-mode'

export interface RestartResult {
  url: string
}

// Stop+start the OpenCode sidecar and restore everything callers tend to forget:
// the SDK client URL, bootstrapped/ready flags, and the team LLM provider config
// (which the sidecar drops on stop, and which ChatPanel's apply-effect can't
// recover without an openCodeReady transition). Throws on failure; caller decides
// how to surface it. Set bootstrapped=false in the catch path if you need it.
export async function restartOpencode(workspacePath: string): Promise<RestartResult> {
  const { setOpenCodeBootstrapped, setOpenCodeReady } = useWorkspaceStore.getState()
  setOpenCodeBootstrapped(false)
  await invoke('stop_opencode')
  await new Promise((resolve) => setTimeout(resolve, 500))
  const status = await invoke<{ url: string }>('start_opencode', {
    config: { workspace_path: workspacePath },
  })
  initOpenCodeClient({ baseUrl: status.url, workspacePath })
  setOpenCodeBootstrapped(true, status.url)
  setOpenCodeReady(true, status.url)

  const { teamMode, applyTeamModelToOpenCode } = useTeamModeStore.getState()
  if (teamMode) {
    await applyTeamModelToOpenCode(workspacePath, true)
  }

  return { url: status.url }
}
