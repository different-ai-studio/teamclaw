import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { CheckCircle2, FolderOpen, FolderPlus, Globe, Sparkles } from "lucide-react"

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
      <div className="flex h-full items-center justify-center bg-[radial-gradient(circle_at_top,_rgba(59,130,246,0.12),_transparent_35%),linear-gradient(180deg,rgba(255,255,255,0.96),rgba(248,250,252,0.98))] p-6">
        <div className="w-full max-w-2xl overflow-hidden rounded-[28px] border border-border/60 bg-background/95 shadow-[0_24px_90px_rgba(15,23,42,0.16)] backdrop-blur">
          <div className="border-b border-border/50 bg-[linear-gradient(135deg,rgba(59,130,246,0.14),rgba(16,185,129,0.06))] px-8 py-8">
            <div className="flex flex-col items-center gap-4 text-center">
              <div className="rounded-2xl border border-white/60 bg-background/90 p-4 shadow-sm">
                <Globe className="h-10 w-10 text-foreground" />
              </div>
              <div className="space-y-2">
                <p className="text-xs font-medium uppercase tracking-[0.22em] text-muted-foreground">
                  TeamClaw
                </p>
                <h2 className="text-2xl font-semibold">{t('workspace.webMode', 'Web Mode')}</h2>
                <p className="mx-auto max-w-xl text-sm leading-6 text-muted-foreground">
                  {t('workspace.webModeBody', 'Running in web mode. Enter a workspace path so TeamClaw knows where to read and write project files.')}
                </p>
              </div>
            </div>
          </div>

          <div className="space-y-6 px-8 py-8">
            <div className="space-y-3">
              <label className="text-sm font-medium" htmlFor="workspace-path">
                {t('workspace.enterPath', 'Enter workspace path')}
              </label>
              <div className="flex flex-col gap-3 sm:flex-row">
                <Input
                  id="workspace-path"
                  value={customPath}
                  onChange={(e) => setCustomPath(e.target.value)}
                  placeholder={t('workspace.enterPath', 'Enter workspace path')}
                  className="h-12 flex-1 rounded-xl border-border/70 bg-background/80"
                />
                <Button
                  onClick={handleSelectFolder}
                  disabled={isLoadingWorkspace || !customPath.trim()}
                  className="h-12 rounded-xl px-6"
                >
                  {isLoadingWorkspace ? t('common.loading', 'Loading...') : t('common.confirm', 'Confirm')}
                </Button>
              </div>
            </div>

            <div className="grid gap-3 rounded-2xl border border-border/60 bg-muted/30 p-4 text-sm text-muted-foreground sm:grid-cols-2">
              <div className="flex items-start gap-3 rounded-xl bg-background/80 p-4">
                <CheckCircle2 className="mt-0.5 h-4 w-4 text-emerald-600" />
                <div>
                  <p className="font-medium text-foreground">{t('workspace.webModeTipTitle', 'Recommended')}</p>
                  <p className="mt-1 leading-5">
                    {t('workspace.webModeTipBody', 'Use an absolute path for the smoothest setup, especially when the server runs in a different environment.')}
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-3 rounded-xl bg-background/80 p-4">
                <Sparkles className="mt-0.5 h-4 w-4 text-sky-600" />
                <div>
                  <p className="font-medium text-foreground">{t('workspace.webModeAccessTitle', 'Access check')}</p>
                  <p className="mt-1 leading-5">
                    {t('workspace.webModeAccessBody', 'Make sure the OpenCode server has permission to access this directory before continuing.')}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <Dialog open>
      <DialogContent
        showCloseButton={false}
        className="overflow-hidden border-border/60 p-0 shadow-[0_28px_100px_rgba(15,23,42,0.28)] sm:max-w-3xl"
        onPointerDownOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <div className="bg-[radial-gradient(circle_at_top_left,_rgba(59,130,246,0.16),_transparent_34%),radial-gradient(circle_at_top_right,_rgba(16,185,129,0.10),_transparent_28%),linear-gradient(180deg,rgba(255,255,255,0.98),rgba(248,250,252,0.98))]">
          <div className="border-b border-border/50 px-8 py-8 sm:px-10">
            <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
              <div className="max-w-xl space-y-3">
                <div className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-background/85 px-3 py-1 text-xs font-medium text-muted-foreground shadow-sm">
                  <Sparkles className="h-3.5 w-3.5" />
                  TeamClaw
                </div>
                <DialogHeader className="text-left">
                  <DialogTitle className="text-2xl font-semibold tracking-tight">
                    {t('workspace.startupPromptTitle', 'Choose a workspace to get started')}
                  </DialogTitle>
                  <DialogDescription className="max-w-xl text-sm leading-6 text-muted-foreground">
                    {t(
                      'workspace.startupPromptBody',
                      'Please choose an existing workspace or create a new one before continuing.',
                    )}
                  </DialogDescription>
                </DialogHeader>
              </div>

              <div className="grid gap-3 rounded-2xl border border-border/60 bg-background/80 p-4 text-sm text-muted-foreground shadow-sm sm:w-[260px]">
                <div className="flex items-start gap-3">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 text-emerald-600" />
                  <div>
                    <p className="font-medium text-foreground">{t('workspace.startupFeatureFast', 'Fast resume')}</p>
                    <p className="mt-1 leading-5">
                      {t('workspace.startupFeatureFastDesc', 'If your last workspace is still available, the app will reopen it automatically next time.')}
                    </p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 text-sky-600" />
                  <div>
                    <p className="font-medium text-foreground">{t('workspace.startupFeatureSafe', 'Clear first step')}</p>
                    <p className="mt-1 leading-5">
                      {t('workspace.startupFeatureSafeDesc', 'Choose an existing folder if you already have a project, or create a clean workspace for a new one.')}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="grid gap-4 px-8 py-8 sm:grid-cols-2 sm:px-10">
            <button
              type="button"
              onClick={handleSelectFolder}
              disabled={isLoadingWorkspace}
              className="group rounded-[24px] border border-border/60 bg-background/90 p-6 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-foreground/20 hover:shadow-lg disabled:pointer-events-none disabled:opacity-60"
            >
              <div className="flex h-full flex-col gap-5">
                <div className="flex items-start justify-between gap-4">
                  <div className="rounded-2xl bg-sky-50 p-3 text-sky-700 ring-1 ring-sky-100">
                    <FolderOpen className="h-6 w-6" />
                  </div>
                  <span className="rounded-full border border-border/60 px-2.5 py-1 text-xs font-medium text-muted-foreground">
                    {t('workspace.recommended', 'Recommended')}
                  </span>
                </div>

                <div className="space-y-2">
                  <h3 className="text-lg font-semibold text-foreground">
                    {t('workspace.selectFolder', 'Select Folder')}
                  </h3>
                  <p className="text-sm leading-6 text-muted-foreground">
                    {t('workspace.selectExistingDesc', 'Open an existing project or directory.')}
                  </p>
                </div>

                <div className="mt-auto inline-flex items-center text-sm font-medium text-foreground">
                  {isLoadingWorkspace ? t('common.loading', 'Loading...') : t('workspace.openExistingAction', 'Open existing workspace')}
                </div>
              </div>
            </button>

            <button
              type="button"
              onClick={handleCreateWorkspace}
              disabled={isLoadingWorkspace}
              className="group rounded-[24px] border border-border/60 bg-[linear-gradient(180deg,rgba(248,250,252,0.98),rgba(255,255,255,0.98))] p-6 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-foreground/20 hover:shadow-lg disabled:pointer-events-none disabled:opacity-60"
            >
              <div className="flex h-full flex-col gap-5">
                <div className="flex items-start justify-between gap-4">
                  <div className="rounded-2xl bg-emerald-50 p-3 text-emerald-700 ring-1 ring-emerald-100">
                    <FolderPlus className="h-6 w-6" />
                  </div>
                  <span className="rounded-full border border-border/60 px-2.5 py-1 text-xs font-medium text-muted-foreground">
                    {t('workspace.newProjectBadge', 'New')}
                  </span>
                </div>

                <div className="space-y-2">
                  <h3 className="text-lg font-semibold text-foreground">
                    {t('workspace.createWorkspace', 'Create Workspace')}
                  </h3>
                  <p className="text-sm leading-6 text-muted-foreground">
                    {t('workspace.createWorkspaceDesc', 'Pick a path and create a new empty workspace.')}
                  </p>
                </div>

                <div className="mt-auto inline-flex items-center text-sm font-medium text-foreground">
                  {t('workspace.createWorkspaceAction', 'Choose location and create')}
                </div>
              </div>
            </button>
          </div>

          <DialogFooter className="justify-start border-t border-border/50 bg-muted/20 px-8 py-4 sm:justify-start sm:px-10">
            <p className="text-xs leading-5 text-muted-foreground">
              {t(
                'workspace.startupPromptTip',
                'If you already used TeamClaw before, the last available workspace will be opened automatically next time.',
              )}
            </p>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  )
}
