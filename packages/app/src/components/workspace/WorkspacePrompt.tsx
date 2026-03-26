import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { FolderOpen, FolderPlus, Globe } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
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

  const handleCreateWorkspace = async () => {
    if (!isTauri()) return

    try {
      const [{ save }, { mkdir }, { documentDir }] = await Promise.all([
        import("@tauri-apps/plugin-dialog"),
        import("@tauri-apps/plugin-fs"),
        import("@tauri-apps/api/path"),
      ])

      const documents = await documentDir()
      const selected = await save({
        title: t('workspace.createWorkspace', 'Create Workspace'),
        defaultPath: `${documents.replace(/\/$/, '')}/${t('workspace.newWorkspaceName', 'New Workspace')}`,
      })

      if (!selected || typeof selected !== 'string') return

      await mkdir(selected, { recursive: true })
      await setWorkspace(selected)
    } catch (error) {
      console.error('Failed to create workspace:', error)
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
    <>
      <div className="flex h-full flex-col items-center justify-center gap-6 p-8">
        <div className="flex flex-col items-center gap-4 text-center">
          <div className="rounded-full bg-muted p-4">
            <FolderOpen className="h-12 w-12 text-muted-foreground" />
          </div>
          <div className="space-y-2">
            <h2 className="text-xl font-semibold">{t('workspace.selectWorkspace', 'Select Workspace')}</h2>
            <p className="max-w-md text-sm text-muted-foreground">
              {t(
                'workspace.startupPromptBody',
                'Please choose an existing workspace or create a new one before continuing.',
              )}
            </p>
          </div>
        </div>
      </div>

      <Dialog open>
        <DialogContent
          showCloseButton={false}
          className="sm:max-w-md"
          onPointerDownOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle>
              {t('workspace.startupPromptTitle', 'Choose a workspace to get started')}
            </DialogTitle>
            <DialogDescription>
              {t(
                'workspace.startupPromptBody',
                'Please choose an existing workspace or create a new one before continuing.',
              )}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3 sm:grid-cols-2">
            <Button
              size="lg"
              onClick={handleSelectFolder}
              disabled={isLoadingWorkspace}
              className="h-auto min-h-24 flex-col items-start gap-2 px-4 py-4 text-left"
            >
              <span className="flex items-center gap-2">
                <FolderOpen className="h-4 w-4" />
                {t('workspace.selectFolder', 'Select Folder')}
              </span>
              <span className="text-xs font-normal opacity-80">
                {t('workspace.selectExistingDesc', 'Open an existing project or directory.')}
              </span>
            </Button>

            <Button
              size="lg"
              variant="outline"
              onClick={handleCreateWorkspace}
              disabled={isLoadingWorkspace}
              className="h-auto min-h-24 flex-col items-start gap-2 px-4 py-4 text-left"
            >
              <span className="flex items-center gap-2">
                <FolderPlus className="h-4 w-4" />
                {t('workspace.createWorkspace', 'Create Workspace')}
              </span>
              <span className="text-xs font-normal text-muted-foreground">
                {t('workspace.createWorkspaceDesc', 'Pick a path and create a new empty workspace.')}
              </span>
            </Button>
          </div>

          <DialogFooter className="justify-start sm:justify-start">
            <p className="text-xs text-muted-foreground">
              {t(
                'workspace.startupPromptTip',
                'If you already used TeamClaw before, the last available workspace will be opened automatically next time.',
              )}
            </p>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
