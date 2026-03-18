import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { FolderOpen, Globe } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useWorkspaceStore } from "@/stores/workspace"
import { isTauri } from '@/lib/utils'


// Default workspace for web mode
const DEFAULT_WEB_WORKSPACE = '~/opencode-test'

export function WorkspacePrompt() {
  const { t } = useTranslation()
  const setWorkspace = useWorkspaceStore(s => s.setWorkspace)
  const isLoadingWorkspace = useWorkspaceStore(s => s.isLoadingWorkspace)
  const [isWebMode, setIsWebMode] = useState(false)
  const [customPath, setCustomPath] = useState(DEFAULT_WEB_WORKSPACE)

  useEffect(() => {
    const webMode = !isTauri()
    setIsWebMode(webMode)
    
    // In web mode, automatically set the default workspace
    if (webMode) {
      // Expand ~ to actual home directory path for the server
      // The server will interpret this path
      setWorkspace(DEFAULT_WEB_WORKSPACE)
    }
  }, [setWorkspace])

  const handleSelectFolder = async () => {
    if (isWebMode) {
      // In web mode, use the custom path input
      if (customPath.trim()) {
        await setWorkspace(customPath.trim())
      }
      return
    }

    // In Tauri mode, use the native dialog
    try {
      const { open } = await import("@tauri-apps/plugin-dialog")
      const selected = await open({
        directory: true,
        multiple: false,
        title: t('workspace.selectWorkspace', 'Select Workspace'),
      })
      
      if (selected && typeof selected === 'string') {
        await setWorkspace(selected)
      }
    } catch (error) {
      console.error('Failed to select folder:', error)
    }
  }

  // In web mode, show a simpler UI with path input
  if (isWebMode) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-6 p-8">
        <div className="flex flex-col items-center gap-4 text-center">
          <div className="rounded-full bg-muted p-4">
            <Globe className="h-12 w-12 text-muted-foreground" />
          </div>
          <div className="space-y-2">
            <h2 className="text-xl font-semibold">{t('workspace.webMode', 'Web Mode')}</h2>
            <p className="max-w-md text-sm text-muted-foreground">
              Running in web mode. Enter workspace path or use the default.
            </p>
          </div>
        </div>
        
        <div className="flex w-full max-w-md gap-2">
          <Input
            value={customPath}
            onChange={(e) => setCustomPath(e.target.value)}
            placeholder={t('workspace.enterPath', 'Enter workspace path')}
            className="flex-1"
          />
          <Button
            onClick={handleSelectFolder}
            disabled={isLoadingWorkspace || !customPath.trim()}
          >
            {isLoadingWorkspace ? t('common.loading', 'Loading...') : t('common.confirm', 'Confirm')}
          </Button>
        </div>
        
        <p className="text-xs text-muted-foreground">
          Tip: Ensure OpenCode server has permission to access this directory
        </p>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 p-8">
      <div className="flex flex-col items-center gap-4 text-center">
        <div className="rounded-full bg-muted p-4">
          <FolderOpen className="h-12 w-12 text-muted-foreground" />
        </div>
        <div className="space-y-2">
          <h2 className="text-xl font-semibold">{t('workspace.selectWorkspace', 'Select Workspace')}</h2>
          <p className="max-w-md text-sm text-muted-foreground">
            Please select a workspace. The AI assistant will read/write files and execute tasks in this directory.
          </p>
        </div>
      </div>
      
      <Button
        size="lg"
        onClick={handleSelectFolder}
        disabled={isLoadingWorkspace}
        className="gap-2"
      >
        <FolderOpen className="h-4 w-4" />
        {isLoadingWorkspace ? t('common.loading', 'Loading...') : t('workspace.selectFolder', 'Select Folder')}
      </Button>
      
      <p className="text-xs text-muted-foreground">
        Tip: Select the project root or a folder containing the files you want to work with
      </p>
    </div>
  )
}
